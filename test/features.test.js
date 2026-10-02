"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path"),express=require("express");
const {createFileStorage,revision}=require("../src/storage");
const {sample,report}=require("../src/availability");
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"ptg-features-")),file=path.join(dir,"status.json");
 await fs.writeFile(file,JSON.stringify({services:[{id:"vpn",name:"VPN",status:"operational"}],incidents:[],maintenance:[]}));
 const storage=createFileStorage(file),mail=[],app=express();app.use(express.json());
 require("../src/admin-api")(app,{allowLocalUsers:true,statusFile:file,storage,key:"feature-bootstrap-key-at-least-24",welcomeMailer:{configuration:()=>({ready:true}),send:async(user,link,event="created")=>{mail.push({user:structuredClone(user),link,event});return {status:"accepted",message:"Accepted"};}}});
 app.use((e,req,res,next)=>res.status(e.status||500).json({error:e.message}));
 const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));
 t.after(async()=>{await new Promise(r=>server.close(r));for(const name of await fs.readdir(dir))await fs.unlink(path.join(dir,name));await fs.rmdir(dir);});
 const base="http://127.0.0.1:"+server.address().port+"/api/admin/";
 const send=(route,method="GET",body,token="feature-bootstrap-key-at-least-24")=>fetch(base+route,{method,headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
 const create=async(username,role="editor",password)=>{const response=await send("users","POST",{username,email:username+"@example.test",firstName:"Test",lastName:"User",jobTitle:"IT",role,active:true,...(password?{password}:{})});assert.equal(response.status,201);return (await response.json()).user;};
 const login=async(username,password)=>{const response=await send("login","POST",{username,password},"");assert.equal(response.status,200);return (await response.json()).token;};
 return {storage,send,create,login,mail};
}
test("password setup and reset links are hashed, expiring, one-use, and revoke old sessions",async t=>{
 const f=await fixture(t),user=await f.create("new-user");
 const link=f.mail[0].link,token=new URLSearchParams(new URL(link).hash.slice(1)).get("token");
 const raw=await f.storage.read("users");
 assert.ok(!raw.includes(token.split(".")[1]));assert.ok(JSON.parse(raw)[0].passwordSetupRequired);
 let response=await f.send("password/complete","POST",{token,password:"new-password-long"},"");
 assert.equal(response.status,200);const session=await f.login("new-user","new-password-long");
 assert.equal((await f.send("password/complete","POST",{token,password:"another-password-long"},"")).status,400);
 await f.send("users/"+user.id+"/password-link","POST",{});
 const reset=new URLSearchParams(new URL(f.mail.at(-1).link).hash.slice(1)).get("token");
 assert.equal((await f.send("password/complete","POST",{token:reset,password:"another-password-long"},"")).status,200);
 assert.equal((await f.send("me","GET",null,session)).status,401);
 await f.send("users/"+user.id+"/password-link","POST",{});
 const expired=new URLSearchParams(new URL(f.mail.at(-1).link).hash.slice(1)).get("token");
 const before=await f.storage.read("users"),users=JSON.parse(before);users[0].passwordLink.expires=Date.now()-1;
 await f.storage.write("users",JSON.stringify(users),revision(before));
 assert.equal((await f.send("password/complete","POST",{token:expired,password:"another-password-long"},"")).status,400);
 const unknown=await f.send("password/request","POST",{username:"missing"},"");
 const known=await f.send("password/request","POST",{username:"new-user"},"");
 assert.equal(unknown.status,202);assert.deepEqual(await unknown.json(),await known.json());
 // Allow queued generic requests to complete before fixture cleanup.
 await new Promise(r=>setTimeout(r,100));
 const audit=await f.storage.read("audit");assert.ok(!audit.includes(token));assert.ok(!audit.includes("new-password-long"));
});
test("editors cannot publish directly; approval is atomic, restricted and rejects stale proposals",async t=>{
 const f=await fixture(t);await f.create("editor","editor","editor-password-long");await f.create("admin","admin","admin-password-long");
 const editor=await f.login("editor","editor-password-long"),admin=await f.login("admin","admin-password-long");
 let snapshot=await(await f.send("status")).json();snapshot.data.services[0].status="outage";
 let response=await f.send("status","PUT",snapshot,editor);assert.equal(response.status,202);const queued=await response.json();
 assert.equal(JSON.parse(await f.storage.read("status")).services[0].status,"operational");
 assert.equal((await f.send("approvals/"+queued.requestId+"/approve","POST",{},editor)).status,403);
 assert.equal((await f.send("audit","GET",null,editor)).status,403);
 assert.equal((await f.send("approvals/"+queued.requestId+"/approve","POST",{},admin)).status,200);
 assert.equal(JSON.parse(await f.storage.read("status")).services[0].status,"outage");
 assert.equal((await f.send("approvals/"+queued.requestId+"/approve","POST",{},admin)).status,409);
 snapshot=await(await f.send("status")).json();snapshot.data.services[0].status="operational";
 const second=await(await f.send("status","PUT",snapshot,editor)).json();
 snapshot.data.services[0].name="Updated service";assert.equal((await f.send("status","PUT",snapshot,admin)).status,200);
 assert.equal((await f.send("approvals/"+second.requestId+"/approve","POST",{},admin)).status,409);
 assert.equal((await f.send("approvals/"+second.requestId+"/reject","POST",{reason:"Please reload"},admin)).status,200);
 const audit=await(await f.send("audit")).json();assert.ok(audit.entries.some(e=>e.action==="publishing.approved"));assert.ok(audit.entries.some(e=>e.action==="publishing.rejected"));
});
test("availability splits UTC boundaries and excludes gaps and maintenance from operational percentage",()=>{
 const at=Date.parse("2026-09-30T23:59:00Z"),service=status=>[{id:"vpn",name:"VPN",status}];
 let state=sample(null,service("operational"),at);
 state=sample(state,service("outage"),at+60000);
 state=sample(state,service("maintenance"),at+120000);
 state=sample(state,service("operational"),at+180000);
 // Ten-minute gap: at most two minutes of the last observed state are credited.
 state=sample(state,service("operational"),at+780000);
 const september=report(state,"2026-09",at+780000).rows[0];
 assert.equal(september.operational,60);assert.equal(september.outage||0,0);
 const october=report(state,"2026-10",at+780000).rows[0];
 assert.equal(october.operational,120);assert.equal(october.outage,60);assert.equal(october.maintenance,60);
 assert.equal(october.unknown,480);assert.equal(october.outageCount,1);
 assert.ok(Math.abs(october.operationalPercent-66.6666666667)<0.001);
 assert.throws(()=>report(state,"2026-13",at),/valid reporting month/);
});
test("multi-document file commit rejects stale updates without partial changes and recovers interrupted transactions",async t=>{
 const f=await fixture(t),status=await f.storage.read("status");
 await assert.rejects(f.storage.writeMany([{name:"audit",content:"[]",expectedRevision:null},{name:"status",content:"{}",expectedRevision:"stale"}]),{status:409});
 assert.equal(await f.storage.read("audit"),null);assert.equal(await f.storage.read("status"),status);
 // A durable transaction journal must be completed before the next read.
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"ptg-recovery-")),file=path.join(dir,"status.json");
 await fs.writeFile(file,"{}");await fs.writeFile(file+".transaction",JSON.stringify([{name:"status",content:'{"recovered":true}'},{name:"audit",content:'[{"action":"test"}]'}]));
 const store=createFileStorage(file);assert.equal(JSON.parse(await store.read("status")).recovered,true);assert.equal(JSON.parse(await store.read("audit"))[0].action,"test");
 for(const name of await fs.readdir(dir))await fs.unlink(path.join(dir,name));await fs.rmdir(dir);
});
