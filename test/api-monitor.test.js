"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),health=require("../health-monitor");
test("HTTP checks enforce status, response content and network boundaries",async t=>{
 const os=require("node:os"),http=require("node:http");
 const ip=Object.values(os.networkInterfaces()).flat().find(i=>i.family==="IPv4"&&health.allowed(i.address))?.address;
 assert.throws(()=>health.validate({type:"http",target:"https://8.8.8.8/",interval:60,paused:false}));
 assert.throws(()=>health.validate({type:"http",target:"http://192.168.1.20/",interval:60,paused:false,apiKey:"dummy"}));
 if(!ip){t.skip("No private test interface");return;}
 const server=http.createServer((req,res)=>{res.statusCode=req.url==="/redirect"?302:200;res.end('{"alive":true}');}).listen(0,ip);
 await new Promise(r=>server.once("listening",r));t.after(()=>new Promise(r=>server.close(r)));
 const config={type:"http",target:"http://"+ip+":"+server.address().port+"/",interval:60,paused:false,expectedText:'"alive":true'};
 assert.equal((await health.probe(config)).ok,true);
 assert.equal((await health.probe({...config,expectedText:"missing"})).ok,false);
 assert.equal((await health.probe({...config,target:config.target+"redirect"})).ok,false);
});
test("credentials are encrypted on disk, redacted in APIs and available only to the probe",async t=>{
 const fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os"),express=require("express");
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"ptg-api-check-")),file=path.join(dir,"status.json");
 await fs.writeFile(file,JSON.stringify({services:[{id:"api",name:"API",status:"unknown"}],incidents:[],maintenance:[]}));
 const monitor=health.createMonitor(file,async config=>{assert.equal(config.apiKey,"dummy-test-api-key");assert.equal(config.authorization,"Basic dummy-test-auth");return {ok:true,message:"Passed",latencyMs:1};});
 const app=express();app.use(express.json());require("../admin-api")(app,{statusFile:file,key:"test-publishing-key-long-enough",monitor});
 const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));
 t.after(async()=>{await new Promise(r=>server.close(r));await fs.unlink(file);await fs.rmdir(dir);});
 const url="http://127.0.0.1:"+server.address().port+"/api/admin/status",headers={Authorization:"Bearer test-publishing-key-long-enough","Content-Type":"application/json"};
 let snapshot=await(await fetch(url,{headers})).json();
 snapshot.data.services[0].monitor={type:"http",target:"https://192.168.1.20/health",interval:60,paused:false,apiKey:"dummy-test-api-key",authorization:"Basic dummy-test-auth",expectedText:"true"};
 const put=s=>fetch(url,{method:"PUT",headers,body:JSON.stringify(s)});
 let response=await put(snapshot);assert.equal(response.status,200,await response.clone().text());snapshot=await response.json();
 const raw=await fs.readFile(file,"utf8");assert.ok(!raw.includes("dummy-test"));assert.ok(JSON.parse(raw).services[0].monitor.secret);
 assert.ok(!JSON.stringify(snapshot).includes("dummy-test"));assert.equal(snapshot.data.services[0].monitor.hasApiKey,true);assert.equal(snapshot.data.services[0].monitor.secret,undefined);
 await monitor.tick();assert.equal(monitor.details(JSON.parse(raw).services).api.successes,1);
 response=await put(snapshot);assert.equal(response.status,200);snapshot=await response.json();
 assert.equal(JSON.parse(await fs.readFile(file,"utf8")).services[0].monitor.secret,JSON.parse(raw).services[0].monitor.secret);
 snapshot.data.services[0].monitor.apiKey="";snapshot.data.services[0].monitor.authorization="";
 response=await put(snapshot);assert.equal(response.status,200);snapshot=await response.json();assert.equal(snapshot.data.services[0].monitor.hasApiKey,false);
});
