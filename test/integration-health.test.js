"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {createIntegrationHealth,createMicrosoftCache,readiness}=require("../src/integration-health");
const monitor=require("../src/health-monitor");
const fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");

test("Microsoft cache coalesces reads, retains notices on failure, retries, and recovers",async()=>{
 let now=100000,calls=0,fail=false;
 const health=createIntegrationHealth(()=>now);health.configure("microsoft");
 const cache=createMicrosoftCache({clock:()=>now,health,load:async()=>{calls++;await new Promise(r=>setTimeout(r,5));if(fail)throw Error("secret provider body");return {services:[{id:"teams",status:"outage"}],incidents:[{id:"issue"}],maintenance:[]};}});
 const values=await Promise.all([cache.get(),cache.get(),cache.get()]);assert.equal(calls,1);assert.equal(values[0].available,true);
 values[0].data.incidents.length=0;assert.equal((await cache.get()).data.incidents.length,1);
 fail=true;now+=60000;const stale=await cache.get();assert.equal(stale.stale,true);assert.equal(stale.available,false);assert.equal(stale.checkedAt,new Date(100000).toISOString());assert.equal(stale.data.incidents[0].id,"issue");
 assert.equal(health.snapshot().microsoft.failures,1);assert.ok(!JSON.stringify(health.snapshot()).includes("secret"));
 await cache.get();assert.equal(calls,2);fail=false;now+=60000;assert.equal((await cache.get()).stale,false);assert.equal(health.snapshot().microsoft.failures,0);
});

test("Microsoft disk snapshot survives restart and remains stale when refresh fails",async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"ptg-cache-")),file=path.join(dir,"cache.json");
 t.after(async()=>{for(const name of await fs.readdir(dir))await fs.unlink(path.join(dir,name));await fs.rmdir(dir);});
 let now=100000;const health=createIntegrationHealth(()=>now);health.configure("microsoft");
 const cache=createMicrosoftCache({file,clock:()=>now,health,load:async()=>({services:[{id:"a",status:"operational"}],incidents:[{id:"retained"}],maintenance:[]})});await cache.get();
 now+=1000;const reboot=createMicrosoftCache({file,clock:()=>now,health,load:async()=>{throw Error("unavailable");}});
 const restored=await reboot.get();assert.equal(restored.stale,true);assert.equal(restored.data.incidents[0].id,"retained");
 await fs.writeFile(file,"invalid");const invalid=createMicrosoftCache({file,clock:()=>now,health,load:async()=>{throw Error("unavailable");}});assert.equal((await invalid.get()).data,null);
});

test("disabled integration and failure before first Microsoft success have no invented status",async()=>{
 const health=createIntegrationHealth();health.configure("microsoft",false);let called=false;
 const cache=createMicrosoftCache({health,load:async()=>{called=true;}});assert.deepEqual(await cache.get(),{data:null,stale:true,checkedAt:null,available:false});assert.equal(called,false);assert.equal(health.snapshot().microsoft.state,"disabled");
 health.configure("microsoft");const failed=createMicrosoftCache({health,load:async()=>{throw Error("failure");}});assert.equal((await failed.get()).data,null);
});

test("integration checks distinguish reconciliation success from notification events and prevent overlap",async()=>{
 let now=100000,calls=0;const health=createIntegrationHealth(()=>now);health.configure("teams");
 const action=()=>health.run("teams",async()=>{calls++;await new Promise(r=>setTimeout(r,5));return {sent:0};},"Safe failure",r=>r.sent);
 await Promise.all([action(),action()]);assert.equal(calls,1);assert.equal(health.snapshot().teams.lastEventAt,null);
 await health.run("teams",async()=>({sent:1}),"Safe failure",r=>r.sent);assert.equal(health.snapshot().teams.lastEventAt,new Date(now).toISOString());
 now+=180001;assert.equal(health.snapshot().teams.state,"stale");
});

test("checker errors do not become outages and break target-failure streaks",()=>{
 for(const message of ["Supabase access token is not configured","API returned HTTP 401","API certificate issuer is not trusted by the server","Health check could not complete","API host is outside the allowed networks","Supabase health API returned HTTP 503"]){
  let state=null;for(let n=0;n<4;n++)state=monitor.advance(state,{ok:false,message},n);
  assert.equal(state.status,"unknown",message);assert.equal(state.kind,"monitor-error");assert.equal(state.failures,0);
  state=monitor.advance(state,{ok:true,message:"Passed"},5);assert.equal(state.status,"unknown");state=monitor.advance(state,{ok:true},6);assert.equal(state.status,"operational");
 }
 let state=monitor.advance(null,{ok:false,message:"Connection refused or unreachable"},1);
 state=monitor.advance(state,{ok:false,message:"Connection refused or unreachable"},2);state=monitor.advance(state,{ok:false,message:"Connection refused or unreachable"},3);assert.equal(state.status,"outage");
 state=monitor.advance(state,{ok:false,kind:"monitor-error",message:"Checker failed"},4);assert.equal(state.status,"unknown");
 for(const message of ["API returned HTTP 503","API TLS certificate has expired","One or more Supabase services are unhealthy"]){assert.equal(monitor.classifyResult({ok:false,message}).kind,"service-failure");}
});

test("public monitor errors expose no target or diagnostic secrets",async()=>{
 const config={type:"tcp",target:"192.168.1.20",port:443,interval:60,paused:false};
 const service={id:"a",status:"operational",monitor:config};
 const check=monitor.createMonitor("unused",async()=>({ok:false,kind:"monitor-error",message:"private diagnostic",latencyMs:null}),{read:async()=>JSON.stringify({services:[service]})});
 await check.tick();const data=check.publicServices([service])[0];assert.equal(data.status,"unknown");assert.equal(data.statusText,"Monitor needs attention");assert.equal(data.healthCheck.monitorError,true);assert.ok(!JSON.stringify(data).includes("private diagnostic"));assert.ok(!JSON.stringify(data).includes(config.target));
 const invalid=check.publicServices([{...service,monitor:{...config,target:"invalid"}}])[0];assert.equal(invalid.status,"unknown");assert.equal(invalid.healthCheck.monitorError,true);
});

test("readiness requires valid storage and recent successful worker cycles",async()=>{
 const now=200000,storage={read:async n=>n==="status"?"{}":"[]"};
 const worker={started:true,error:false,lastCompletedAt:new Date(now).toISOString()};
 const params={clock:()=>now,storage,monitor:{workerHealth:()=>worker},automation:{...worker}};
 assert.equal((await readiness(params)).status,"ready");
 for(const overrides of [{storage:{read:async()=>{throw Error("secret connection string");}}},{storage:{read:async()=>"malformed"}},{storage:{read:async()=>null}},{monitor:{workerHealth:()=>({...worker,started:false})}},{monitor:{workerHealth:()=>({...worker,error:true})}},{automation:{...worker,lastCompletedAt:new Date(0).toISOString()}}]){
  const result=await readiness({...params,...overrides});assert.equal(result.status,"not-ready");assert.ok(!JSON.stringify(result).includes("secret"));
 }
 const slow=await readiness({...params,storage:{read:()=>new Promise(()=>{})}});assert.equal(slow.checks.storage,false);
});

test("integration endpoint is authenticated and administrator-only",async t=>{
 const express=require("express"),dir=await fs.mkdtemp(path.join(os.tmpdir(),"ptg-integration-api-")),file=path.join(dir,"status.json");await fs.writeFile(file,'{"services":[],"incidents":[],"maintenance":[]}');
 const app=express();app.use(express.json());require("../src/admin-api")(app,{allowLocalUsers:true,statusFile:file,key:"integration-key-at-least-24-characters",integrationHealth:async()=>({integrations:{teams:{state:"healthy"}}}),welcomeMailer:{send:async()=>({status:"accepted"})}});
 const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));
 t.after(async()=>{await new Promise(r=>server.close(r));for(const name of await fs.readdir(dir))await fs.unlink(path.join(dir,name));await fs.rmdir(dir);});
 const base="http://127.0.0.1:"+server.address().port+"/api/admin/",headers={Authorization:"Bearer integration-key-at-least-24-characters","Content-Type":"application/json"};
 assert.equal((await fetch(base+"integrations")).status,401);const result=await fetch(base+"integrations",{headers});assert.equal(result.status,200);assert.equal(result.headers.get("cache-control"),"no-store");assert.equal((await result.json()).integrations.teams.state,"healthy");
 const create=await fetch(base+"users",{method:"POST",headers,body:JSON.stringify({username:"editor",firstName:"Test",lastName:"User",jobTitle:"IT",email:"editor@example.test",role:"editor",active:true,password:"long-test-password"})});assert.equal(create.status,201);
 const login=await fetch(base+"login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:"editor",password:"long-test-password"})});const session=await login.json();assert.equal(login.status,200);
 assert.equal((await fetch(base+"integrations",{headers:{Authorization:"Bearer "+session.token}})).status,403);
});
