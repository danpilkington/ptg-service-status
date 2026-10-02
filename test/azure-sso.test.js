"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const attach = require("../src/azure-sso");
const tenant = "11111111-1111-1111-1111-111111111111", oid = "22222222-2222-2222-2222-222222222222";
test("SSO is opt-in and restricted to a tenant and HTTPS callback", () => {
    const env = { ADMIN_SSO_ENABLED: "true", AZURE_TENANT_ID: tenant, AZURE_CLIENT_ID: oid, AZURE_CLIENT_SECRET: "test", ADMIN_SSO_REDIRECT_URI: "https://example.com/api/admin/sso/callback" };
    assert.ok(attach.configuration(env));
    for (const changes of [{ADMIN_SSO_ENABLED:"false"},{AZURE_TENANT_ID:"common"},{AZURE_CLIENT_SECRET:""},{ADMIN_SSO_REDIRECT_URI:"http://example.com/api/admin/sso/callback"}]) assert.equal(attach.configuration({...env,...changes}),null);
});
test("only one active explicitly linked approved account is authorised", () => {
    const user = { id: "one", active: true, role: "editor", entraObjectId: oid, email: "person@example.com" }, claims = { tid: tenant, oid };
    assert.equal(attach.authorisedUser([user],claims,tenant),user);
    for (const users of [[{...user,active:false}],[{...user,entraObjectId:""}],[{...user,role:"other"}],[user,{...user,id:"two"}]]) assert.equal(attach.authorisedUser(users,claims,tenant),null);
    assert.equal(attach.authorisedUser([user],{...claims,tid:oid},tenant),null);
});
test("SSO start protects browser state and callback rejects unbound state", async t => {
    const app = express();
    attach(app,{read:async()=>[],issueSession:()=>{throw new Error("must not issue")},wrap:fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next),config:{tenant,client:oid,secret:"test",redirect:"https://example.com/api/admin/sso/callback"}});
    const server=app.listen(0,"127.0.0.1"); await new Promise(r=>server.once("listening",r)); t.after(()=>new Promise(r=>server.close(r)));
    const base="http://127.0.0.1:"+server.address().port;
    const started=await fetch(base+"/api/admin/sso/start",{redirect:"manual"});
    const url=new URL(started.headers.get("location"));
    assert.equal(url.searchParams.get("code_challenge_method"),"S256"); assert.ok(url.searchParams.get("nonce"));
    assert.match(started.headers.get("set-cookie"),/HttpOnly/);assert.match(started.headers.get("set-cookie"),/Secure/);
    const rejected=await fetch(base+"/api/admin/sso/callback?state="+url.searchParams.get("state")+"&code=forged",{redirect:"manual"});
    assert.equal(rejected.headers.get("location"),"/admin/?sso=failed");
    assert.equal((await fetch(base+"/api/admin/sso/complete",{method:"POST"})).status,401);
});
test("authorised SSO handoff is single-use and rechecks account deactivation", async t => {
    let active=true, issued=0;
    const user={id:"approved",active:true,role:"editor",entraObjectId:oid};
    const app=express();
    attach(app,{read:async()=>[{...user,active}],issueSession:u=>{issued++;return {token:"application-session",user:u}},wrap:fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next),config:{tenant,client:oid,secret:"test",redirect:"https://example.com/api/admin/sso/callback"},verifyIdentity:async()=>({tid:tenant,oid})});
    const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));t.after(()=>new Promise(r=>server.close(r)));
    const base="http://127.0.0.1:"+server.address().port;
    const realFetch=global.fetch;
    global.fetch=(url,options)=>String(url).startsWith("https://login.microsoftonline.com/")?Promise.resolve({ok:true,json:async()=>({id_token:"mock-token"})}):realFetch(url,options);
    t.after(()=>{global.fetch=realFetch});
    async function signIn(){
        const start=await fetch(base+"/api/admin/sso/start",{redirect:"manual"});
        const state=new URL(start.headers.get("location")).searchParams.get("state");
        const callback=await fetch(base+"/api/admin/sso/callback?state="+state+"&code=test",{redirect:"manual",headers:{Cookie:start.headers.get("set-cookie").split(";")[0]}});
        assert.equal(callback.headers.get("location"),"/admin/?sso=complete");
        assert.equal(issued,0);
        return callback.headers.getSetCookie().find(value => value.startsWith("ptg_sso_handoff=")).split(";")[0];
    }
    let cookie=await signIn();active=false;
    assert.equal((await fetch(base+"/api/admin/sso/complete",{method:"POST",headers:{Cookie:cookie}})).status,403);
    active=true;cookie=await signIn();
    const done=await fetch(base+"/api/admin/sso/complete",{method:"POST",headers:{Cookie:cookie}});
    assert.equal((await done.json()).token,"application-session");assert.equal(issued,1);
    assert.equal((await fetch(base+"/api/admin/sso/complete",{method:"POST",headers:{Cookie:cookie}})).status,401);
});
test("SSO diagnostic failures expose a safe reason and numeric Microsoft codes only",async t=>{
    const app=express();attach(app,{read:async()=>[],issueSession:()=>({}),wrap:fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next),config:{tenant,client:oid,secret:"PRIVATE-CREDENTIAL",redirect:"https://example.com/api/admin/sso/callback"}});
    const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));t.after(()=>new Promise(r=>server.close(r)));
    const base="http://127.0.0.1:"+server.address().port,realFetch=global.fetch;
    global.fetch=(url,options)=>String(url).startsWith("https://login.microsoftonline.com/")?Promise.resolve({ok:false,json:async()=>({error_codes:[7000215,"unsafe"],error_description:"PRIVATE-CREDENTIAL"})}):realFetch(url,options);t.after(()=>{global.fetch=realFetch});
    const started=await fetch(base+"/api/admin/sso/start",{redirect:"manual"});const state=new URL(started.headers.get("location")).searchParams.get("state");
    const result=await fetch(base+"/api/admin/sso/callback?state="+state+"&code=test",{redirect:"manual",headers:{Cookie:started.headers.get("set-cookie").split(";")[0]}});
    assert.equal(result.headers.get("location"),"/admin/?sso=failed");const d=app.locals.ssoDiagnostics();assert.equal(d.recentFailures[0].reason,"exchange");assert.deepEqual(d.recentFailures[0].providerCodes,[7000215]);assert.ok(!JSON.stringify(d).includes("PRIVATE-CREDENTIAL"));
    const config=await(await fetch(base+"/api/admin/sso/config")).json();assert.deepEqual(config,{enabled:true});
});

test("group-authorised SSO grants automatic access and rechecks the handoff",async t=>{
 let allowed=true,issued=0;const app=express();attach(app,{read:async()=>[],resolveUser:async(users,claims)=>allowed?{id:"entra:"+claims.oid,active:true,role:"admin",entraObjectId:claims.oid}:null,issueSession:(user,claims)=>{assert.equal(claims.oid,oid);issued++;return {token:"group-session",user};},wrap:fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next),config:{tenant,client:oid,secret:"test",redirect:"https://example.com/api/admin/sso/callback"},verifyIdentity:async()=>({tid:tenant,oid})});
 const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));t.after(()=>new Promise(r=>server.close(r)));const base="http://127.0.0.1:"+server.address().port;const realFetch=global.fetch;global.fetch=(url,options)=>String(url).startsWith("https://login.microsoftonline.com/")?Promise.resolve({ok:true,json:async()=>({id_token:"mock"})}):realFetch(url,options);t.after(()=>{global.fetch=realFetch;});
 async function start(){const response=await fetch(base+"/api/admin/sso/start",{redirect:"manual"}),state=new URL(response.headers.get("location")).searchParams.get("state"),callback=await fetch(base+"/api/admin/sso/callback?state="+state+"&code=test",{redirect:"manual",headers:{Cookie:response.headers.get("set-cookie").split(";")[0]}});assert.equal(callback.headers.get("location"),"/admin/?sso=complete");return callback.headers.getSetCookie().find(v=>v.startsWith("ptg_sso_handoff=")).split(";")[0];}
 let cookie=await start();allowed=false;assert.equal((await fetch(base+"/api/admin/sso/complete",{method:"POST",headers:{Cookie:cookie}})).status,403);assert.equal(issued,0);allowed=true;cookie=await start();assert.equal((await(await fetch(base+"/api/admin/sso/complete",{method:"POST",headers:{Cookie:cookie}})).json()).token,"group-session");assert.equal(issued,1);
});
