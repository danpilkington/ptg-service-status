"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { createFileStorage, createStorage, sqlConfig, revision } = require("../storage");
const { migrate, activate } = require("../database-setup");

test("file storage rejects racing writes and preserves the winning snapshot", async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ptg-storage-"));
    const file = path.join(dir, "status.json");
    await fs.writeFile(file, '{"services":[]}');
    t.after(async()=>{for(const name of await fs.readdir(dir))await fs.unlink(path.join(dir,name));await fs.rmdir(dir);});
    const a=createFileStorage(file),b=createFileStorage(file);
    const old=revision(await a.read("status"));
    const results=await Promise.allSettled([a.write("status",'{"services":[1]}',old),b.write("status",'{"services":[2]}',old)]);
    assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
    assert.equal(results.find(r=>r.status==="rejected").reason.status,409);
    assert.equal(await a.read("users"),null);
    await a.write("users","[]",null);
    await assert.rejects(b.write("users","[1]",null),{status:409});
    assert.equal(await a.read("users"),"[]");
    await assert.rejects(a.read("other"),/Unknown storage/);
});
test("SQL configuration uses Windows identity and encrypted explicit connection strings",()=>{
    const config=sqlConfig({SQL_SERVER:"np:\\\\IT1\\pipe\\MSSQL$PROGRESSIVE\\sql\\query",SQL_DATABASE:"PTG-STATUS",SQL_TRUST_SERVER_CERTIFICATE:"true"});
    assert.match(config.connectionString,/Trusted_Connection=Yes/);
    assert.match(config.connectionString,/Encrypt=Yes/);
    assert.match(config.connectionString,/TrustServerCertificate=Yes/);
    assert.ok(!/Pwd=|Uid=/.test(config.connectionString));
    assert.match(sqlConfig({SQL_SERVER:"IT1\\PROGRESSIVE",SQL_DATABASE:"a};Password=bad"}).connectionString,/Database=\{a}};Password=bad\}/);
    assert.match(sqlConfig({SQL_SERVER:"IT1",SQL_DATABASE:"PTG-STATUS"}).connectionString,/TrustServerCertificate=No/);
    assert.throws(()=>createStorage({statusFile:"unused",env:{STORAGE_DRIVER:"sql"}}),/SQL_SERVER/);
    assert.throws(()=>createStorage({statusFile:"unused",env:{STORAGE_DRIVER:"typo"}}),/STORAGE_DRIVER/);
});
test("publishing, accounts and health monitoring use injected storage without local files",async t=>{
    const docs={status:JSON.stringify({services:[{id:"vpn",name:"VPN",status:"operational",monitor:{type:"tcp",target:"192.168.1.1",port:443,interval:60,paused:false}}],incidents:[],maintenance:[]}),users:"[]"};
    const storage={read:async name=>docs[name],write:async(name,content,expected)=>{
        if(revision(docs[name])!==expected){const e=new Error("Conflict");e.status=409;throw e;}docs[name]=content;
    }};
    const initial=JSON.parse(docs.status); initial.services[0].monitor=require("../health-monitor").validate(initial.services[0].monitor); docs.status=JSON.stringify(initial);
    const monitor=require("../health-monitor").createMonitor("nonexistent",async()=>({ok:true,message:"OK",latencyMs:1}),storage);
    await monitor.tick();
    assert.ok(monitor.details(JSON.parse(docs.status).services).vpn);
    const app=express();app.use(express.json());
    require("../admin-api")(app,{statusFile:"nonexistent",key:"storage-test-key-with-more-than-24-characters",storage,monitor});
    const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));
    t.after(()=>new Promise(r=>server.close(r)));
    const base="http://127.0.0.1:"+server.address().port+"/api/admin/";
    const headers={Authorization:"Bearer storage-test-key-with-more-than-24-characters","Content-Type":"application/json"};
    const send=(route,method="GET",body)=>fetch(base+route,{method,headers,...(body?{body:JSON.stringify(body)}:{})});
    const snapshot=await(await send("status")).json();snapshot.data.services[0].name="Updated VPN";
    assert.equal((await send("status","PUT",snapshot)).status,200);
    assert.equal(JSON.parse(docs.status).services[0].name,"Updated VPN");
    assert.equal((await send("status","PUT",snapshot)).status,409);
    const user={username:"db.user",firstName:"Database",lastName:"User",jobTitle:"Test",role:"admin",active:true,password:"long-test-password"};
    assert.equal((await send("users","POST",user)).status,201);
    assert.equal(JSON.parse(docs.users)[0].username,"db.user");
    assert.ok(!docs.users.includes(user.password));
    const login=await send("login","POST",{username:user.username,password:user.password});
    assert.equal(login.status,200);
    const token=(await login.json()).token;
    assert.equal((await fetch(base+"status",{headers:{Authorization:"Bearer "+token}})).status,200);
});
function fakeSqlStore(initial={}) {
    let rows=structuredClone(initial), staged;
    class Transaction {
        async begin(){staged=structuredClone(rows);}
        async commit(){rows=staged;staged=null;}
        async rollback(){staged=null;}
    }
    class Request {
        constructor(){this.params={};}
        input(name,type,value){this.params[name]=value;return this;}
        async query(query){
            if(query.startsWith("SELECT"))return {recordset:Object.entries(staged).map(([Name,Content])=>({Name,Revision:revision(Content)}))};
            staged[this.params.name]=this.params.content;return {rowsAffected:[1]};
        }
    }
    return {sql:{Transaction,Request,ISOLATION_LEVEL:{SERIALIZABLE:4},NVarChar:()=>{},VarChar:()=>{}},pool:async()=>({}),read:async name=>rows[name],snapshot:()=>rows};
}
test("migration is repeatable, preserves complete records, refuses overwrite and rolls back changed source",async()=>{
    const docs={status:JSON.stringify({services:[],incidents:[],maintenance:[],retiredServices:[{id:"old"}]}),users:"[]"};
    const source={read:async name=>docs[name]},store=fakeSqlStore();
    assert.deepEqual(await migrate(store,source),{services:0,users:0});
    assert.deepEqual(store.snapshot(),docs);
    await migrate(store,source);
    const occupied=fakeSqlStore({status:'{"different":true}'});
    await assert.rejects(migrate(occupied,source),/different data/);
    assert.deepEqual(occupied.snapshot(),{status:'{"different":true}'});
    let reads=0;
    const changing={read:async name=>name==="status"?(++reads===1?docs.status:docs.status+" "):docs.users};
    const empty=fakeSqlStore();
    await assert.rejects(migrate(empty,changing),/changed during/);
    assert.deepEqual(empty.snapshot(),{});
    await assert.rejects(migrate(fakeSqlStore(),{read:async name=>name==="status"?docs.status:'[{"id":"x","username":"x","passwordHash":"plaintext"}]'}),/invalid identity/);
});
test("activation only changes the storage switch and preserves other environment settings",async t=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),"ptg-env-")),file=path.join(dir,".env");
    t.after(async()=>{await fs.unlink(file);await fs.rmdir(dir);});
    await fs.writeFile(file,"# config\nADMIN_API_KEY=test-value\nSTORAGE_DRIVER=file\nSQL_DATABASE=PTG-STATUS\n");
    await activate(file);
    const text=await fs.readFile(file,"utf8");
    assert.match(text,/ADMIN_API_KEY=test-value/);assert.match(text,/SQL_DATABASE=PTG-STATUS/);
    assert.equal(text.match(/^STORAGE_DRIVER=/gm).length,1);assert.match(text,/STORAGE_DRIVER=sql/);
});

