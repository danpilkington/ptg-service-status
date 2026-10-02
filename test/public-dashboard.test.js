"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {affectedServices,parseFavourites}=require("../assets/dashboard-summary");
const {attachPublicAvailability}=require("../src/public-availability");

test("affected overview separates provider notices, confirmed impact, unknown monitoring and resolved history",()=>{
 const now=Date.parse("2026-10-01T10:00:00Z");
 const data={services:[{id:"teams",name:"Teams",source:"Microsoft",status:"degraded",stale:true},{id:"vpn",name:"VPN",source:"PTG",status:"operational"},{id:"check",name:"Check",status:"unknown"},{id:"normal",status:"operational"}],incidents:[{id:"t",serviceId:"teams",impact:"not-affected",message:"Provider advisory"},{id:"v",serviceId:"vpn",impact:"confirmed",workaround:"Use alternate connection"},{id:"r",serviceId:"normal",phase:"resolved",impact:"confirmed"}]};
 const result=affectedServices(data,now);assert.equal(result.length,2);assert.equal(result[0].id,"vpn");assert.equal(result[0].impact,"Affecting PTG");assert.equal(result[0].guidance,"Use alternate connection");
 assert.equal(result[1].impact,"PTG assessed no impact");assert.equal(result[1].stale,true);assert.ok(!result.some(s=>s.id==="check"));
});

test("summary uses newest published guidance and only active maintenance windows",()=>{
 const now=100000;const result=affectedServices({services:[{id:"vpn",status:"outage"},{id:"net",status:"maintenance"}],incidents:[{serviceId:"vpn",message:"Original",updates:[{at:new Date(2000).toISOString(),message:"New guidance"},{at:new Date(1000).toISOString(),message:"Old guidance"}]}],maintenance:[{serviceId:"net",start:new Date(0).toISOString(),end:new Date(now+1).toISOString(),message:"Network work"}]},now);
 assert.equal(result[0].guidance,"New guidance");assert.equal(result[1].guidance,"Network work");
 assert.equal(affectedServices({services:[{id:"net",status:"maintenance"}],maintenance:[{serviceId:"net",start:new Date(now+1).toISOString(),end:new Date(now+1000).toISOString(),message:"Future work"}]},now)[0].guidance,"Open service details for the latest information.");
});

test("favourites recover safely from malformed or unexpected browser storage",()=>{
 for(const raw of ["invalid",'{}','null'])assert.equal(parseFavourites(raw).size,0);
 assert.deepEqual([...parseFavourites('["vpn","vpn",1,null,"", "teams"]')],["vpn","teams"]);
});

test("public availability exposes only aggregates for an existing service and safely handles missing data",async t=>{
 const express=require("express"),app=express();let broken=false;
 const storage={read:async()=>{if(broken)throw Error("private connection credentials");return JSON.stringify({services:[{id:"vpn",monitor:{target:"private-address",secret:"private-token"}}]});}};
 const availability={report:async()=>({month:"2026-10",from:"2026-10-01T00:00:00Z",to:"2026-10-01T01:00:00Z",startedAt:null,rows:[{id:"vpn",operationalPercent:99,coverage:80,outage:60,maintenance:120,unknown:720,outageCount:1,secret:"private-token"},{id:"retired",name:"Retired private service"}]})};
 attachPublicAvailability(app,{storage,availability,microsoftIds:["teams"]});
 const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));t.after(()=>new Promise(r=>server.close(r)));
 const base="http://127.0.0.1:"+server.address().port+"/api/services/";
 const response=await fetch(base+"vpn/availability");assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"no-store");const data=await response.json();assert.equal(data.operationalPercent,99);assert.equal(data.outageSeconds,60);assert.ok(!JSON.stringify(data).includes("private"));
 assert.equal((await fetch(base+"retired/availability")).status,404);
 const blank=await(await fetch(base+"teams/availability")).json();assert.equal(blank.operationalPercent,null);assert.equal(blank.coverage,0);assert.equal(blank.unknownSeconds,3600);
 broken=true;const unavailable=await fetch(base+"vpn/availability");assert.equal(unavailable.status,503);assert.ok(!(await unavailable.text()).includes("private"));
});

test("successful probe timestamp survives target failures and monitor errors without inventing a success",()=>{
 const {advance}=require("../src/health-monitor");let state=advance(null,{ok:false,message:"Connection refused"},1);assert.equal(state.lastSuccessfulCheckAt,null);
 state=advance(state,{ok:true},2);assert.equal(state.lastSuccessfulCheckAt,new Date(2).toISOString());state=advance(state,{ok:false},3);assert.equal(state.lastSuccessfulCheckAt,new Date(2).toISOString());
 state=advance(state,{ok:false,kind:"monitor-error"},4);assert.equal(state.lastSuccessfulCheckAt,new Date(2).toISOString());
});
