"use strict";
const {test,mock}=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");

test("public stale status keeps notices but suppresses alert/recovery and known availability; readiness detects storage failure",async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"ptg-operational-")),file=path.join(dir,"status.json");
 await fs.writeFile(file,JSON.stringify({services:[{id:"vpn",name:"VPN",status:"operational"}],incidents:[],maintenance:[]}));
 Object.assign(process.env,{STORAGE_DRIVER:"file",STATUS_FILE:file,USERS_FILE:path.join(dir,"users.json"),ADMIN_API_KEY:"operational-test-key-at-least-24",AZURE_TENANT_ID:"",AZURE_CLIENT_ID:"",AZURE_CLIENT_SECRET:"",FRESHSERVICE_DOMAIN:"",FRESHSERVICE_API_KEY:"",FRESHSERVICE_REQUESTER_EMAIL:"",TEAMS_WEBHOOK_URL:"",WELCOME_EMAIL_ENABLED:"false"});
 let stale=true;const observations={teams:[],freshservice:[]};
 mock.method(require("../src/integration-health"),"createMicrosoftCache",()=>({get:async()=>({available:!stale,stale,checkedAt:"2026-01-01T00:00:00Z",data:{services:[{id:"microsoft-teams",source:"Microsoft",serviceName:"Teams",status:"operational",statusText:"Operational"}],incidents:[{id:"retained-issue",serviceId:"microsoft-teams",title:"Retained notice",source:"Microsoft"}],maintenance:[]}})}));
 mock.method(require("../src/teams-notifier"),"createTeamsNotifier",()=>({enabled:true,reconcile:async services=>{observations.teams.push(structuredClone(services));return {notified:[],recovered:[]};}}));
 mock.method(require("../src/freshservice"),"createFreshserviceNotifier",()=>({enabled:true,reconcile:async services=>{observations.freshservice.push(structuredClone(services));return {created:[],recovered:[]};}}));
 const app=require("../server"),server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));
 t.after(async()=>{mock.restoreAll();await new Promise(r=>server.close(r));for(const name of await fs.readdir(dir))await fs.unlink(path.join(dir,name));await fs.rmdir(dir);});
 const base="http://127.0.0.1:"+server.address().port;
 const result=await(await fetch(base+"/api/status")).json();await new Promise(r=>setImmediate(r));
 assert.equal(result.microsoftStale,true);assert.equal(result.incidents[0].id,"retained-issue");assert.equal(result.services[0].status,"operational");assert.match(result.services[0].statusText,/last known/);assert.equal(result.overall.status,"unknown");
 for(const sent of [observations.teams[0],observations.freshservice[0]])assert.equal(sent.find(s=>s.id==="microsoft-teams").status,"unknown");
 const recorded=JSON.parse(await app.locals.storage.read("availability"));assert.equal(recorded.previous.find(s=>s.id==="microsoft-teams").status,"unknown");
 assert.equal((await fetch(base+"/api/health")).status,200);assert.equal((await fetch(base+"/api/ready")).status,503);
 mock.method(app.locals.monitor,"workerHealth",()=>({started:true,error:false,lastCompletedAt:new Date().toISOString()}));
 app.locals.automation.lastCompletedAt=new Date().toISOString();assert.equal((await fetch(base+"/api/ready")).status,200);
 const oldRead=app.locals.storage.read;app.locals.storage.read=async()=>{throw Error("secret storage detail");};
 let ready=await fetch(base+"/api/ready");assert.equal(ready.status,503);assert.equal((await ready.json()).checks.storage,false);assert.equal((await fetch(base+"/api/health")).status,200);app.locals.storage.read=oldRead;
 stale=false;const fresh=await(await fetch(base+"/api/status")).json();await new Promise(r=>setImmediate(r));assert.equal(fresh.microsoftStale,false);assert.equal(fresh.overall.status,"operational");assert.equal(observations.teams.at(-1)[0].status,"operational");
});
