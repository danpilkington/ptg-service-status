"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {configuration,createFreshserviceNotifier}=require("../freshservice");
const env={FRESHSERVICE_DOMAIN:"example-company",FRESHSERVICE_API_KEY:"secret-key",FRESHSERVICE_REQUESTER_EMAIL:"status@example.com",FRESHSERVICE_PRIORITY:"4",FRESHSERVICE_GROUP_ID:"12",FRESHSERVICE_WORKSPACE_ID:"34"};
test("Freshservice configuration is optional and validates supplied settings",()=>{assert.equal(configuration({}),null);assert.equal(configuration({FRESHSERVICE_DOMAIN:"example-company"}),null);assert.throws(()=>configuration({FRESHSERVICE_DOMAIN:"https://bad.example"}));assert.throws(()=>configuration({...env,FRESHSERVICE_PRIORITY:"5"}));assert.equal(configuration(env).priority,4);});
test("one ticket is created per non-operational episode and state survives restart",async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),"ptg-freshservice-")),stateFile=path.join(directory,"state.json"),requests=[];let ticketCount=0;
 const mockFetch=async(url,options)=>{requests.push({url,options});if(url.endsWith("/notes"))return new Response(JSON.stringify({conversation:{id:50}}),{status:201});if(options.method==="PUT")return new Response(JSON.stringify({ticket:{id:1001,status:11}}),{status:200});ticketCount++;return new Response(JSON.stringify({ticket:{id:1000+ticketCount}}),{status:201});};t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const degraded={id:"vpn",name:"VPN <Primary>",source:"PTG",status:"degraded",statusText:"Packet loss"};let notifier=createFreshserviceNotifier({env,stateFile,fetch:mockFetch});
 assert.equal((await notifier.reconcile([{...degraded,status:"operational"}])).created.length,0);assert.equal((await notifier.reconcile([degraded])).created.length,1);assert.equal((await notifier.reconcile([{...degraded,status:"outage"}])).created.length,0);
 assert.equal((await notifier.reconcile([{...degraded,status:"unknown"}])).created.length,0);
 notifier=createFreshserviceNotifier({env,stateFile,fetch:mockFetch});assert.equal((await notifier.reconcile([degraded])).created.length,0);const recovery=await notifier.reconcile([{...degraded,status:"operational"}]);assert.equal(recovery.recovered[0].ticketId,1001);assert.equal((await notifier.reconcile([degraded])).created.length,1);
 assert.equal(requests.length,4);assert.equal(requests[0].url,"https://example-company.freshservice.com/api/v2/tickets");assert.equal(requests[0].options.headers.Authorization,`Basic ${Buffer.from("secret-key:X").toString("base64")}`);const payload=JSON.parse(requests[0].options.body);assert.equal(payload.status,2);assert.equal(payload.priority,4);assert.equal(payload.group_id,12);assert.equal(payload.workspace_id,34);assert.match(payload.description,/VPN &lt;Primary&gt;/);
 assert.match(requests[1].url,/\/tickets\/1001\/notes$/);assert.equal(JSON.parse(requests[1].options.body).private,true);assert.match(JSON.parse(requests[1].options.body).body,/returned to Operational/);assert.equal(requests[2].options.method,"PUT");assert.deepEqual(JSON.parse(requests[2].options.body),{status:11});
});
test("unknown status does not create a ticket",async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),"ptg-freshservice-unknown-")),stateFile=path.join(directory,"state.json");let requests=0;
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));const notifier=createFreshserviceNotifier({env,stateFile,fetch:async()=>{requests++;return new Response(JSON.stringify({ticket:{id:1}}),{status:201});}});
 const result=await notifier.reconcile([{id:"pending",name:"Pending check",status:"unknown",source:"PTG"}]);assert.equal(result.created.length,0);assert.equal(requests,0);
});
test("failed ticket requests are retried without recording an active outage",async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),"ptg-freshservice-retry-")),stateFile=path.join(directory,"state.json");let attempts=0;
 const mockFetch=async()=>{attempts++;if(attempts===1)return new Response("unavailable",{status:503});return new Response(JSON.stringify({ticket:{id:55}}),{status:201});};t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const notifier=createFreshserviceNotifier({env,stateFile,fetch:mockFetch}),service={id:"api",name:"API",status:"outage",source:"PTG"};await assert.rejects(notifier.reconcile([service]),/HTTP 503/);assert.equal((await notifier.reconcile([service])).created[0].ticketId,55);assert.equal(attempts,2);
});
test("a failed recovery status update retries without duplicating the recovery note",async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),"ptg-freshservice-recovery-")),stateFile=path.join(directory,"state.json");let notes=0,updates=0;
 const mockFetch=async(url,options)=>{if(url.endsWith("/notes")){notes++;return new Response(JSON.stringify({conversation:{id:2}}),{status:201});}if(options.method==="PUT"){updates++;if(updates===1)return new Response("unavailable",{status:503});return new Response(JSON.stringify({ticket:{id:77,status:11}}),{status:200});}return new Response(JSON.stringify({ticket:{id:77}}),{status:201});};
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));const notifier=createFreshserviceNotifier({env,stateFile,fetch:mockFetch}),outage={id:"erp",name:"ERP",status:"outage",source:"PTG"};
 await notifier.reconcile([outage]);await assert.rejects(notifier.reconcile([{...outage,status:"operational"}]),/HTTP 503/);const retry=await notifier.reconcile([{...outage,status:"operational"}]);assert.equal(retry.recovered[0].ticketId,77);assert.equal(notes,1);assert.equal(updates,2);
});
