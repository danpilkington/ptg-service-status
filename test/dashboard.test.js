"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {applyMaintenance,activeAnnouncement}=require("../dashboard-model");
test("scheduled maintenance respects boundaries, overlap, manual health and legacy notices",()=>{
 const services=[{id:"vpn",status:"operational"}];
 const window={serviceId:"vpn",start:"2026-09-17T10:00:00Z",end:"2026-09-17T11:00:00Z",autoStatus:true};
 const at=s=>Date.parse("2026-09-17T"+s+"Z");
 assert.equal(applyMaintenance(services,[window],at("09:59:59"))[0].status,"operational");
 assert.equal(applyMaintenance(services,[window],at("10:00:00"))[0].status,"maintenance");
 assert.equal(applyMaintenance(services,[window],at("11:00:00"))[0].status,"operational");
 assert.equal(services[0].status,"operational");
 assert.equal(applyMaintenance(services,[{...window,autoStatus:undefined}],at("10:30:00"))[0].status,"operational");
 assert.equal(applyMaintenance(services,[window,{...window,end:"2026-09-17T12:00:00Z"}],at("11:30:00"))[0].status,"maintenance");
 for(const status of ["outage","degraded","advisory"]) assert.equal(applyMaintenance([{id:"vpn",status}],[window],at("10:30:00"))[0].status,status);
 const announcement={title:"Planned work",expiresAt:window.end};
 assert.equal(activeAnnouncement(announcement,at("10:30:00")),announcement);
 assert.equal(activeAnnouncement(announcement,at("11:00:00")),null);
 assert.equal(activeAnnouncement({title:"No expiry"},at("11:00:00")).title,"No expiry");
});
test("publishing validates and exposes groups, announcements and automatic windows",async t=>{
 const fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"ptg-batch-")),file=path.join(dir,"status.json");
 await fs.writeFile(file,JSON.stringify({services:[{id:"vpn",name:"VPN",status:"operational"}],incidents:[],maintenance:[]}));
 Object.assign(process.env,{STORAGE_DRIVER:"file",STATUS_FILE:file,ADMIN_API_KEY:"dashboard-test-key-at-least-24",AZURE_TENANT_ID:"",AZURE_CLIENT_ID:"",AZURE_CLIENT_SECRET:"",FRESHSERVICE_DOMAIN:"",FRESHSERVICE_API_KEY:"",FRESHSERVICE_REQUESTER_EMAIL:""});
 const server=require("../server").listen(0,"127.0.0.1");
 await new Promise(r=>server.once("listening",r));
 t.after(async()=>{await new Promise(r=>server.close(r));await fs.unlink(file);await fs.rmdir(dir);});
 const base="http://127.0.0.1:"+server.address().port;
 const headers={Authorization:"Bearer "+process.env.ADMIN_API_KEY,"Content-Type":"application/json"};
 let snapshot=await (await fetch(base+"/api/admin/status",{headers})).json();
 const put=body=>fetch(base+"/api/admin/status",{method:"PUT",headers,body:JSON.stringify(body)});
 const now=Date.now();const iso=n=>new Date(now+n).toISOString();
 Object.assign(snapshot.data.services[0],{group:"Connectivity",order:0});
 snapshot.data.announcement={title:"IT update",message:"Planned work today",level:"warning",expiresAt:iso(3600000)};
 snapshot.data.maintenance=[{id:"m",serviceId:"vpn",title:"Upgrade",message:"Brief interruption",start:iso(-60000),end:iso(60000),autoStatus:true}];
 for(const change of [s=>s.data.services[0].order=-1,s=>s.data.services[0].group="x".repeat(61),s=>s.data.announcement.level="invalid",s=>s.data.announcement.expiresAt="bad",s=>s.data.maintenance[0].autoStatus="yes"]){
  const bad=structuredClone(snapshot);change(bad);assert.equal((await put(bad)).status,400);
 }
 let response;
 for(const level of ["info","warning","success","maintenance","urgent"]){
  snapshot.data.announcement.level=level;
  response=await put(snapshot);assert.equal(response.status,200,level);snapshot=await response.json();
  assert.equal(snapshot.data.announcement.level,level);
 }
 let pub=await (await fetch(base+"/api/status")).json();
 assert.equal(pub.announcement.title,"IT update");
 assert.equal(pub.announcement.level,"urgent");
 assert.equal(pub.services.find(s=>s.id==="vpn").status,"maintenance");
 assert.equal(pub.services.find(s=>s.id==="vpn").group,"Connectivity");
 assert.equal(snapshot.data.services[0].status,"operational");
 snapshot.data.maintenance[0].start=iso(-120000);snapshot.data.maintenance[0].end=iso(-60000);snapshot.data.announcement.expiresAt=iso(-1);
 response=await put(snapshot);assert.equal(response.status,200);
 pub=await (await fetch(base+"/api/status")).json();
 assert.equal(pub.announcement,null);assert.equal(pub.maintenance.length,0);assert.equal(pub.services.find(s=>s.id==="vpn").status,"operational");
});
