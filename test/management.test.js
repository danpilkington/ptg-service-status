"use strict";
process.env.WELCOME_EMAIL_ENABLED="false";
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path"),express=require("express");
const {createFileStorage}=require("../src/storage"),{createSubscriptions}=require("../src/subscriptions"),metadata=require("../assets/service-metadata"),reviewModel=require("../src/incident-reviews"),attach=require("../src/admin-api");
test("dependency graphs validate references and cycles; public warnings preserve status and hide contacts",()=>{
    assert.throws(()=>metadata.validateServices([{id:"a",dependsOn:["a"]}]));assert.throws(()=>metadata.validateServices([{id:"a",dependsOn:["missing"]}]));assert.throws(()=>metadata.validateServices([{id:"a",dependsOn:["b"]},{id:"b",dependsOn:["a"]}]));
    metadata.validateServices([{id:"a",dependsOn:["identity"]}]);
    const services=metadata.withDependencies([{id:"a",name:"App",status:"operational",dependsOn:["b"],ownerTeam:"Apps",escalationContact:"private@example.test"},{id:"b",name:"Database",status:"operational",dependsOn:["c"]},{id:"c",name:"Network",status:"outage"}]);
    assert.equal(services[0].status,"operational");assert.equal(services[0].ownerTeam,"Apps");assert.equal(services[0].escalationContact,undefined);assert.deepEqual(services[0].dependencyRisks.map(s=>s.id),["c"]);
    const stale=metadata.withDependencies([{id:"a",status:"operational",dependsOn:["b"]},{id:"b",status:"outage",stale:true}]);assert.equal(stale[0].dependencyRisks[0].status,"unknown");
});
test("review reports validate dates and escape HTML while distinguishing elapsed incident time",()=>{
    const incident={id:"i",title:'<script>alert(1)</script>',message:"Observed issue",start:"2026-10-02T09:00:00Z",resolvedAt:"2026-10-02T09:45:00Z",phase:"resolved",serviceId:"a",updates:[]};
    const r=reviewModel.report(incident,{rootCause:"<img src=x onerror=alert(1)>"});assert.equal(r.incident.elapsedMinutes,45);const html=reviewModel.htmlReport(r);assert.ok(!html.includes("<script>"));assert.ok(!html.includes("<img"));assert.match(html,/not measured service outage time/);
    assert.equal(reviewModel.report({...incident,resolvedAt:undefined}).incident.elapsedMinutes,null);
    const input={impactSummary:"",rootCause:"",resolution:"",lessonsLearned:"",actions:[{title:"Fix",owner:"IT",completed:false,dueDate:"2026-99-99"}]};assert.equal(reviewModel.validReview(input),false);input.actions[0].dueDate="2026-02-30";assert.equal(reviewModel.validReview(input),false);input.actions[0].dueDate="2026-10-12";assert.equal(reviewModel.validReview(input),true);
});
test("subscriber administration and incident reviews enforce roles, consent, conflicts, audit and private service fields",async t=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),"ptg-management-")),file=path.join(dir,"status.json"),key="management-test-key-at-least-24-characters";
    const initial={services:[{id:"vpn",name:"VPN",status:"operational",ownerTeam:"IT",escalationContact:"private@example.test",dependsOn:[]}],incidents:[{id:"i1",title:"VPN outage",message:"Issue",serviceId:"vpn",service:"VPN",phase:"resolved",impact:"confirmed",start:"2026-10-02T09:00:00Z",resolvedAt:"2026-10-02T09:45:00Z",updates:[]}],maintenance:[]};await fs.writeFile(file,JSON.stringify(initial));
    let failMail=false;const storage=createFileStorage(file),messages=[],manager=createSubscriptions({storage,mailer:{ready:true,send:async(email,subject,content)=>{if(failMail)throw Error("Mail not accepted");messages.push({email,subject,content});}},getServices:async()=>[{id:"vpn",name:"VPN"}],env:{SUBSCRIPTION_PUBLIC_URL:"https://example.test/"},deliveryIntervalMs:0});
    const app=express();app.use(express.json());attach(app,{allowLocalUsers:true,statusFile:file,key,storage,subscriptions:manager});const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));
    t.after(async()=>{await new Promise(r=>server.close(r));const resolved=path.resolve(dir);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep+"ptg-management-"));await fs.rm(resolved,{recursive:true});});
    const base="http://127.0.0.1:"+server.address().port+"/api/admin/",send=(route,method="GET",body,token=key)=>fetch(base+route,{method,headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
    const account={username:"editor",email:"editor@example.test",password:"long-editor-test-password",firstName:"Ed",lastName:"Test",jobTitle:"Editor",role:"editor",active:true};assert.equal((await send("users","POST",account)).status,201);const login=await(await send("login","POST",{username:account.username,password:account.password},"")).json();
    for(const route of ["subscribers","incident-reviews"]){assert.equal((await send(route,"GET",undefined,"")).status,401);assert.equal((await send(route,"GET",undefined,login.token)).status,403);}
    const editorStatus=await(await send("status","GET",undefined,login.token)).json();assert.equal(editorStatus.data.services[0].escalationContact,undefined);assert.equal((await(await send("status")).json()).data.services[0].escalationContact,"private@example.test");
    await manager.request("person@example.test",["vpn"]);let list=await(await send("subscribers")).json();const id=list.items[0].id;assert.equal(list.items[0].status,"pending");assert.equal(list.items[0].pending,undefined);assert.ok(!JSON.stringify(list).includes('"hash"'));
    assert.equal((await send("subscribers/"+id+"/resume","POST",{revision:list.revision})).status,400);
    const token=new URLSearchParams(messages[0].content.match(/https:\/\/\S+/)[0].split("#")[1]).get("token");await manager.confirm(token);
    assert.equal((await send("subscribers/"+id+"/pause","POST",{revision:list.revision})).status,409);
    list=await(await send("subscribers")).json();assert.equal((await send("subscribers/"+id+"/pause","POST",{revision:list.revision})).status,200);list=await(await send("subscribers")).json();assert.equal(list.items[0].status,"paused");
    await manager.reconcile({});await manager.reconcile({incidents:[{id:"new",serviceId:"vpn",message:"Outage"}]});assert.equal(messages.length,1);
    list=await(await send("subscribers")).json();assert.equal((await send("subscribers/"+id+"/resume","POST",{revision:list.revision})).status,200);list=await(await send("subscribers")).json();assert.equal(list.items[0].status,"confirmed");
    failMail=true;await manager.reconcile({incidents:[{id:"new",serviceId:"vpn",message:"Updated outage"}]});list=await(await send("subscribers?filter=failed")).json();assert.equal(list.items.length,1);assert.equal(list.counts.failed,1);
    assert.equal((await send("subscribers/"+id+"/retry","POST",{revision:list.revision})).status,200);failMail=false;await manager.reconcile({incidents:[{id:"new",serviceId:"vpn",message:"Updated outage"}]});list=await(await send("subscribers")).json();assert.equal(list.items[0].failed,0);assert.ok(list.items[0].lastDeliveredAt);
    const r=await(await send("incident-reviews/i1")).json();assert.equal(r.incident.elapsedMinutes,45);
    const body={revision:r.revision,incidentRevision:r.incidentRevision,impactSummary:"Users could not connect",rootCause:"Network change",resolution:"Rolled back",lessonsLearned:"Test before deployment",actions:[{title:"Add validation",owner:"IT",dueDate:"2026-10-12",completed:false}]};
    assert.equal((await send("incident-reviews/i1","PUT",body,login.token)).status,403);assert.equal((await send("incident-reviews/i1","PUT",body)).status,200);assert.equal((await send("incident-reviews/i1","PUT",body)).status,409);
    const exported=await send("incident-reviews/i1?download=html");assert.equal(exported.status,200);assert.match(exported.headers.get("content-type"),/text\/html/);assert.match(await exported.text(),/Add validation/);
    const audit=JSON.parse(await storage.read("audit"));assert.ok(audit.some(a=>a.action==="subscriber.pause"));assert.ok(audit.some(a=>a.action==="incident.review_saved"));assert.ok(!JSON.stringify(audit).includes("person@example.test"));
    assert.equal((await send("subscribers/"+id+"/delete","POST",{revision:list.revision})).status,200);assert.equal((await manager.listSubscribers()).counts.total,0);
    const status=await(await send("status")).json();status.data.services[0].dependsOn=["missing"];assert.equal((await send("status","PUT",status)).status,400);
    status.data.services[0].dependsOn=["identity"];status.data.services[0].ownerTeam="Operations";assert.equal((await send("status","PUT",status)).status,200);const stored=JSON.parse(await storage.read("status"));assert.equal(stored.services[0].ownerTeam,"Operations");assert.deepEqual(stored.services[0].dependsOn,["identity"]);
    const newReview=await(await send("incident-reviews/i1")).json();stored.incidents[0].phase="investigating";const raw=await storage.read("status");await storage.write("status",JSON.stringify(stored),require("../src/storage").revision(raw));assert.equal((await send("incident-reviews/i1","PUT",{...body,revision:newReview.revision,incidentRevision:newReview.incidentRevision})).status,409);
});
