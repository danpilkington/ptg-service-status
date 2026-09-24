"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const health=require("../health-monitor");
const config={type:"tcp",target:"192.168.1.20",port:443,interval:60,paused:false};
test("targets are restricted and thresholds prevent flapping",()=>{
 for(const target of ["127.0.0.1","169.254.169.254","8.8.8.8","localhost","192.168.1.20 & whoami","999.1.1.1"])assert.throws(()=>health.validate({...config,target}));
 assert.deepEqual(health.validate(config),config);
 assert.throws(()=>health.validate({...config,port:0}));
 let state=health.advance(null,{ok:true},0);assert.equal(state.status,"unknown");
 state=health.advance(state,{ok:true},1);assert.equal(state.status,"operational");
 for(let i=0;i<2;i++){state=health.advance(state,{ok:false},2+i);assert.equal(state.status,"operational");}
 state=health.advance(state,{ok:false},4);assert.equal(state.status,"outage");
 state=health.advance(state,{ok:true},5);assert.equal(state.status,"outage");
 state=health.advance(state,{ok:true},6);assert.equal(state.status,"operational");
});
test("Supabase monitors validate projects and services",()=>{
 const config={type:"supabase",projectRef:"xlbmpqyjpsnfvbgxsvql",services:["auth","db","rest","realtime","storage"],interval:60,paused:false};
 assert.deepEqual(health.validate(config),config);
 assert.deepEqual(health.validate({...config,projectRef:"jgsvzjvfcvvluarborzn",services:["auth"]}),{...config,projectRef:"jgsvzjvfcvvluarborzn",services:["auth"]});
 for(const invalid of [{projectRef:"unknown"},{services:["auth","auth"]},{services:["functions"]},{services:["unknown"]},{services:[]}]) assert.throws(()=>health.validate({...config,...invalid}));
});
test("Supabase health responses must report every requested service healthy",()=>{
 const services=["auth","db"];
 assert.equal(health.supabaseServicesHealthy({auth:"HEALTHY",db:"passing"},services),true);
 assert.equal(health.supabaseServicesHealthy({auth:"healthy",db:"degraded"},services),false);
 assert.equal(health.supabaseServicesHealthy({auth:"healthy"},services),false);
 assert.equal(health.supabaseServicesHealthy({services:{auth:{status:"operational"},db:{status:"ok"}}},services),true);
 assert.equal(health.supabaseServicesHealthy([{name:"auth",healthy:true,status:"ACTIVE_HEALTHY"},{name:"db",healthy:true,status:"ACTIVE_HEALTHY"}],services),true);
 assert.equal(health.supabaseServicesHealthy([{name:"auth",healthy:true,status:"ACTIVE_HEALTHY"}],services),false);
});
test("real TCP and ping probes work without a shell",async t=>{
 const net=require("node:net");const server=net.createServer(s=>s.end()).listen(0,"127.0.0.1");
 await new Promise(r=>server.once("listening",r));
 const port=server.address().port;
 assert.equal((await health.probe({type:"tcp",target:"127.0.0.1",port})).ok,true);
 await new Promise(r=>server.close(r));
 assert.equal((await health.probe({type:"tcp",target:"127.0.0.1",port})).ok,false);
 assert.equal((await health.probe({type:"ping",target:"127.0.0.1"})).ok,true);
});
test("published monitoring configuration, scheduling, privacy and pause",async t=>{
 const fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path"),express=require("express");
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"ptg-monitor-")),file=path.join(dir,"status.json");
 await fs.writeFile(file,JSON.stringify({services:[{id:"test",name:"Test",status:"degraded"}],incidents:[],maintenance:[]}));
 let probes=0;
 const monitor=health.createMonitor(file,async()=>{probes++;return {ok:true,message:"Reply",latencyMs:1};});
 const app=express();app.use(express.json());require("../admin-api")(app,{statusFile:file,key:"test-monitor-key-long-enough",monitor});
 const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));
 t.after(async()=>{monitor.stop();await new Promise(r=>server.close(r));await fs.unlink(file);await fs.rmdir(dir);});
 const url="http://127.0.0.1:"+server.address().port,headers={Authorization:"Bearer test-monitor-key-long-enough","Content-Type":"application/json"};
 let snapshot=await(await fetch(url+"/api/admin/status",{headers})).json();
 assert.equal((await fetch(url+"/api/admin/checks")).status,401);
 const put=s=>fetch(url+"/api/admin/status",{method:"PUT",headers,body:JSON.stringify(s)});
 snapshot.data.services[0].monitor={...config,target:"8.8.8.8"};
 assert.equal((await put(snapshot)).status,400);
 snapshot.data.services[0].monitor=config;
 let response=await put(snapshot);assert.equal(response.status,200);snapshot=await response.json();
 await monitor.tick();await monitor.tick();assert.equal(probes,1);
 const checks=await(await fetch(url+"/api/admin/checks",{headers})).json();assert.equal(checks.checks.test.successes,1);
 const published=monitor.publicServices(snapshot.data.services);assert.equal(published[0].status,"unknown");
 assert.ok(!JSON.stringify(published).includes(config.target));assert.equal(published[0].monitor,undefined);
 snapshot.data.services[0].monitor.paused=true;
 response=await put(snapshot);assert.equal(response.status,200);snapshot=await response.json();
 await monitor.tick();assert.equal(probes,1);assert.equal(monitor.publicServices(snapshot.data.services)[0].status,"degraded");
 snapshot.data.services[0].monitor={...config,target:"192.168.1.21"};response=await put(snapshot);assert.equal(response.status,200);
 await monitor.tick();assert.equal(probes,2);
});
