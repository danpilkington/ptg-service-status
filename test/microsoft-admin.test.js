"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {create,validate,summarize}=require("../src/microsoft-admin");
const tenant="11111111-1111-1111-1111-111111111111",oid="22222222-2222-2222-2222-222222222222",admin="33333333-3333-3333-3333-333333333333",editor="44444444-4444-4444-4444-444444444444";
const policy={groupAccess:true,requireAccount:false,adminGroupId:admin,editorGroupId:editor,devicesEnabled:true,staleDays:7};
function fixture(request){let data={microsoftAdmin:{...policy}},now=Date.UTC(2026,9,2);return {get data(){return data;},set data(d){data=d;},advance(ms){now+=ms;},api:create({read:async()=>JSON.stringify(data)},{env:{AZURE_TENANT_ID:tenant,AZURE_CLIENT_ID:oid,AZURE_CLIENT_SECRET:"mock",ADMIN_SSO_ENABLED:"true"},credential:{getToken:async()=>({token:"mock-token"})},clock:()=>now,request})};}
test("group settings accept security group IDs and reject ambiguous roles and invalid thresholds",()=>{
 assert.deepEqual(validate(policy),policy);assert.throws(()=>validate({...policy,adminGroupId:""}));assert.throws(()=>validate({...policy,editorGroupId:admin}));assert.throws(()=>validate({...policy,staleDays:0}));assert.throws(()=>validate({...policy,adminGroupId:"group-name"}));
});
test("automatic group access maps roles, denies disabled accounts and wrong tenants, and rechecks membership",async()=>{
 let groups=[admin,editor],calls=0,failed=false;
 const f=fixture(async(url,options)=>{calls++;assert.match(url,/users.*checkMemberGroups/);assert.deepEqual(JSON.parse(options.body).groupIds,[admin,editor]);if(failed)return {ok:false,status:403};return {ok:true,json:async()=>({value:groups})};});
 const claims={tid:tenant,oid,name:"Example"};
 let user=await f.api.resolve([],claims,tenant);assert.equal(user.role,"admin");assert.equal(user.groupManaged,true);assert.equal(user.id,"entra:"+oid);
 assert.equal(await f.api.resolve([], {...claims,tid:oid},tenant),null);
 assert.equal(await f.api.resolve([{entraObjectId:oid,active:false}],claims,tenant),null);
 groups=[editor];user=await f.api.resolve([],claims,tenant);assert.equal(user.role,"admin");assert.equal(calls,1);
 f.advance(60001);user=await f.api.resolve([],claims,tenant);assert.equal(user.role,"editor");
 groups=[];f.advance(60001);assert.equal(await f.api.resolve([],claims,tenant),null);
 failed=true;f.advance(60001);await assert.rejects(f.api.resolve([],claims,tenant),/denied/);

 f.data.microsoftAdmin.groupAccess=false;assert.equal(await f.api.resolve([],claims,tenant),null);assert.equal(await f.api.resolve([{id:"local",entraObjectId:oid,active:true,role:"admin"}],claims,tenant),null);
});
test("device counts distinguish compliance and check-in and paginate without exposing identities",async()=>{
 let calls=0,fail=false;const f=fixture(async url=>{calls++;if(fail)return {ok:false,status:403};assert(!url.includes("userPrincipalName"));assert(!url.includes("deviceName"));return {ok:true,json:async()=>url.includes("page=2")?{value:[{id:"b",operatingSystem:"iOS",complianceState:"noncompliant",lastSyncDateTime:"2026-09-01T00:00:00Z"}]}:{value:[{id:"a",operatingSystem:"Windows",complianceState:"compliant",lastSyncDateTime:"2026-10-01T00:00:00Z"},{id:"c",complianceState:"unknown",lastSyncDateTime:"0001-01-01T00:00:00Z"}],"@odata.nextLink":"https://graph.microsoft.com/v1.0/deviceManagement/managedDevices?page=2"}};});
 let result=await f.api.devices();assert.deepEqual(result.counts,{total:3,compliant:1,noncompliant:1,other:1,stale:1,neverCheckedIn:1});assert.equal(result.stale,false);assert.equal(calls,2);
 await f.api.devices();assert.equal(calls,2);f.advance(300001);fail=true;result=await f.api.devices();assert.equal(result.stale,true);assert.equal(result.counts.total,3);
 f.data.microsoftAdmin.devicesEnabled=false;assert.equal((await f.api.devices()).enabled,false);
 const blocked=fixture(async()=>({ok:false,status:403}));result=await blocked.api.devices();assert.equal(result.available,false);assert(!result.counts);
});
test("Graph continuation cannot send bearer tokens to another origin",async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return {ok:true,json:async()=>({value:[],"@odata.nextLink":"https://attacker.example/v1.0/devices"})};});assert.equal((await f.api.devices()).available,false);assert.equal(calls,1);
});

test("Microsoft controls and device reports are admin-only, validated and audited",async t=>{
 const express=require("express"),{createFileStorage,revision}=require("../src/storage"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"ptg-ms-controls-")),file=path.join(dir,"status.json");await fs.writeFile(file,JSON.stringify({services:[],incidents:[],maintenance:[]}));const store=createFileStorage(file);
 const api=create(store,{env:{AZURE_TENANT_ID:tenant,AZURE_CLIENT_ID:oid,AZURE_CLIENT_SECRET:"mock",ADMIN_SSO_ENABLED:"true"},credential:{getToken:async()=>({token:"mock"})},request:async url=>({ok:true,json:async()=>url.includes("/groups/")?{id:url.includes(admin)?admin:editor,securityEnabled:true}:{value:[]}})});
 const app=express();app.use(express.json());app.use((req,res,next)=>{if(!req.get("x-role"))return res.sendStatus(401);req.adminUser={id:"test",role:req.get("x-role")};next();});api.attach(app);const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));t.after(async()=>{await new Promise(r=>server.close(r));for(const name of await fs.readdir(dir))await fs.unlink(path.join(dir,name));await fs.rmdir(dir);});const base="http://127.0.0.1:"+server.address().port;
 for(const endpoint of ["microsoft-controls","device-compliance"]){assert.equal((await fetch(base+"/api/admin/"+endpoint)).status,401);assert.equal((await fetch(base+"/api/admin/"+endpoint,{headers:{"x-role":"editor"}})).status,403);}
 const initial=await(await fetch(base+"/api/admin/microsoft-controls",{headers:{"x-role":"admin"}})).json();assert.equal(initial.settings.groupAccess,false);
 const save=(settings,version=initial.revision)=>fetch(base+"/api/admin/microsoft-controls",{method:"PUT",headers:{"x-role":"admin","Content-Type":"application/json"},body:JSON.stringify({settings,revision:version})});
 assert.equal((await save({...policy,staleDays:100})).status,400);assert.equal((await save(policy,"stale")).status,409);let response=await save(policy);assert.equal(response.status,200);const result=await response.json();assert.equal(result.revision,revision(await store.read("status")));assert.equal(JSON.parse(await store.read("audit")).at(-1).action,"microsoft.controls");
 response=await fetch(base+"/api/admin/device-compliance",{headers:{"x-role":"admin"}});assert.equal(response.status,200);assert.equal((await response.json()).counts.total,0);
});

test("Microsoft sessions recheck group roles and revoke access after membership removal",async t=>{
 const express=require("express"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path"),{mock}=require("node:test"),graph=require("../src/microsoft-admin");
 let groups=[admin];const f=fixture(async()=>({ok:true,json:async()=>({value:groups})}));mock.method(graph,"forStorage",()=>f.api);
 const azurePath=require.resolve("../src/azure-sso");require(azurePath);const old=require.cache[azurePath].exports;
 require.cache[azurePath].exports=(app,{read,issueSession,wrap,resolveUser})=>app.post("/api/admin/test-signin",wrap(async(req,res)=>{const claims={tid:tenant,oid};res.json(issueSession(await resolveUser(await read(),claims,tenant),claims));}));
 const oldTenant=process.env.AZURE_TENANT_ID;process.env.AZURE_TENANT_ID=tenant;
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"ptg-group-session-")),file=path.join(dir,"status.json");await fs.writeFile(file,JSON.stringify({services:[],incidents:[],maintenance:[]}));const store=require("../src/storage").createFileStorage(file,path.join(dir,"users.json"));
 const app=express();app.use(express.json());require("../src/user-auth")(app,{statusFile:file,storage:store,key:"group-session-test-key-more-than-24",welcomeMailer:{configuration:()=>({})}});const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));
 t.after(async()=>{require.cache[azurePath].exports=old;mock.restoreAll();if(oldTenant===undefined)delete process.env.AZURE_TENANT_ID;else process.env.AZURE_TENANT_ID=oldTenant;await new Promise(r=>server.close(r));for(const name of await fs.readdir(dir))await fs.unlink(path.join(dir,name));await fs.rmdir(dir);});
 const base="http://127.0.0.1:"+server.address().port;const login=await(await fetch(base+"/api/admin/test-signin",{method:"POST"})).json();const headers={Authorization:"Bearer "+login.token};assert.equal(login.user.role,"admin");assert.equal(login.user.groupManaged,true);assert.equal((await fetch(base+"/api/admin/users",{headers})).status,200);
 groups=[editor];f.advance(60001);assert.equal((await(await fetch(base+"/api/admin/me",{headers})).json()).user.role,"editor");assert.equal((await fetch(base+"/api/admin/users",{headers})).status,403);
 groups=[];f.advance(60001);assert.equal((await fetch(base+"/api/admin/me",{headers})).status,401);
});
