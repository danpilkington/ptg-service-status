"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const recovery=require("../ops/recovery"),{check,validateUrl}=require("../ops/check-status"),{backupHealth}=require("../ops/backup-health");
const password="isolated-test-passphrase-12345";
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),"ptg-recovery-test-"));t.after(async()=>{async function remove(p){for(const e of await fs.readdir(p,{withFileTypes:true})){const f=path.join(p,e.name);if(e.isDirectory())await remove(f);else await fs.unlink(f);}await fs.rmdir(p);}await remove(dir);});const docs={status:JSON.stringify({services:[{id:"vpn"}],incidents:[],maintenance:[]}),users:"[]",audit:'[{"action":"published"}]',approvals:"[]",availability:"null"};await fs.writeFile(path.join(dir,".env"),"AZURE_CLIENT_SECRET=test-private-secret");await fs.writeFile(path.join(dir,".env.example"),"AZURE_CLIENT_SECRET=\n");await fs.writeFile(path.join(dir,"teams-state.json"),'{"services":{"PTG:vpn":{"active":true}}}');return {dir,docs,storage:{kind:"sql",read:async name=>docs[name]}};}

test("encrypted recovery bundle includes all storage, notification state and configuration without plaintext secrets",async t=>{
 const f=await fixture(t),bundle=await recovery.collect({...f,baseDir:f.dir,siteStopped:true,env:{AZURE_CLIENT_SECRET:"test-private-secret",TEAMS_WEBHOOK_URL:"configured"}});
 const encrypted=recovery.encrypt(bundle,password);assert.equal(encrypted.includes(Buffer.from("test-private-secret")),false);assert.equal(encrypted.includes(Buffer.from("published")),false);
 assert.deepEqual(recovery.decrypt(encrypted,password),bundle);assert.equal(recovery.summary(bundle).auditEntries,1);
 assert.ok(bundle.files.some(f=>f.name==="state/teams-state.json"));assert.ok(bundle.files.some(f=>f.name==="configuration/runtime.json"));
});

test("wrong passwords, tampering, missing documents and unsafe restore paths are rejected",async t=>{
 const f=await fixture(t),bundle=await recovery.collect({...f,baseDir:f.dir,siteStopped:true,env:{}}),encrypted=recovery.encrypt(bundle,password);
 assert.throws(()=>recovery.decrypt(encrypted,"different-passphrase-12345"),/verification failed/);encrypted[encrypted.length-1]^=1;assert.throws(()=>recovery.decrypt(encrypted,password),/verification failed/);
 assert.throws(()=>recovery.encrypt(bundle,"short"),/passphrase/);assert.throws(()=>recovery.validate({...bundle,files:bundle.files.filter(f=>f.name!=="documents/audit.json")}),/missing/);
 assert.throws(()=>recovery.validate({...bundle,files:[...bundle.files,{name:"../outside.txt",content:"unsafe",sha256:"x"}]}),/validation/);
});

test("collection requires stopped site and detects concurrent storage or absent enabled notification state",async t=>{
 const f=await fixture(t);await assert.rejects(recovery.collect({...f,baseDir:f.dir,env:{}}),/Stop the production/);
 await assert.rejects(recovery.collect({...f,baseDir:f.dir,siteStopped:true,env:{FRESHSERVICE_API_KEY:"configured"}}),/state is missing/);
 let reads=0;const storage={kind:"file",read:async name=>name==="audit"?++reads===1?"[]":"[{}]":f.docs[name]};
 await assert.rejects(recovery.collect({storage,baseDir:f.dir,siteStopped:true,env:{}}),/Storage changed/);
});

test("restore staging verifies manifest and never overwrites a previous recovery set",async t=>{
 const f=await fixture(t),bundle=await recovery.collect({...f,baseDir:f.dir,siteStopped:true,env:{}}),target=path.join(f.dir,"restore");
 await recovery.stage(bundle,target);assert.equal(await fs.readFile(path.join(target,"documents","audit.json"),"utf8"),f.docs.audit);
 assert.equal(await fs.readFile(path.join(target,"configuration",".env"),"utf8"),"AZURE_CLIENT_SECRET=test-private-secret");assert.ok((await fs.readdir(target)).includes("manifest.json"));
 await assert.rejects(recovery.stage(bundle,target),{code:"EEXIST"});
});

test("independent checker requires HTTPS, detects redirects/errors, alerts after three samples and reports recovery",async()=>{
 for(const url of ["http://example.test","https://user:secret@example.test","https://example.test/?token=secret"])assert.throws(()=>validateUrl(url));
 let failing=true;const request=async url=>({ok:!failing,status:failing?503:200,json:async()=>({status:url.endsWith("ready")?"ready":"ok"})});
 let previous=null;for(let i=1;i<=3;i++){previous=await check({url:"https://example.test",previous,request,now:i*60000});assert.equal(previous.alerted,i===3);}assert.equal(previous.event,"failure");
 previous=await check({url:"https://example.test",previous,request,now:240000});assert.equal(previous.event,"unchanged");
 failing=false;previous=await check({url:"https://example.test",previous,request,now:300000});assert.equal(previous.event,"recovery");assert.equal(previous.failures,0);
 const error=await check({url:"https://example.test",request:async()=>{throw Error("secret transport detail");}});assert.equal(error.failures,1);assert.ok(!JSON.stringify(error).includes("secret"));
});

test("independent checker rejects a misleading success body and resets stale or other-site streaks",async()=>{
 const request=async()=>({ok:true,status:200,json:async()=>({status:"unexpected"})});
 const previous={url:"https://other.test",failures:100,alerted:true,checkedAt:new Date(0).toISOString()};
 assert.equal((await check({url:"https://example.test",previous,request,now:60000})).failures,1);
 assert.equal((await check({url:"https://example.test",previous:{...previous,url:"https://example.test"},request,now:400000})).failures,1);
});

test("backup health shows disabled, verified, overdue and failed backups without exposing file paths",async t=>{
 const f=await fixture(t),file=path.join(f.dir,"backup-health.json"),now=200000000;
 assert.equal((await backupHealth(null,now)).state,"disabled");assert.equal((await backupHealth(file,now)).state,"error");
 const record={succeeded:true,checkedAt:new Date(now).toISOString(),verifiedAt:new Date(now).toISOString(),file:"private-server-path"};await fs.writeFile(file,JSON.stringify(record));
 assert.equal((await backupHealth(file,now)).state,"healthy");assert.ok(!JSON.stringify(await backupHealth(file,now)).includes("private-server-path"));
 assert.equal((await backupHealth(file,now+27*3600000)).state,"stale");await fs.writeFile(file,JSON.stringify({...record,succeeded:false}));assert.equal((await backupHealth(file,now)).state,"error");
 await fs.writeFile(file,"invalid");assert.equal((await backupHealth(file,now)).state,"error");
});
