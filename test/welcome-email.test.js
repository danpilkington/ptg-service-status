"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {createWelcomeMailer,validEmail}=require("../welcome-email");
const express=require("express");
const env={WELCOME_EMAIL_ENABLED:"true",WELCOME_EMAIL_FROM:"status@progressive-technology.co.uk",
ADMIN_SIGN_IN_URL:"https://status.progressive.technology/admin/#admin-overview",
AZURE_TENANT_ID:"test",AZURE_CLIENT_ID:"test",AZURE_CLIENT_SECRET:"test"};
test("welcome email uses the required sender and exact credentials; reports acceptance accurately",async()=>{
 let request;
 const mailer=createWelcomeMailer(env,{credential:{getToken:async()=>({token:"test-token"})},fetch:async(url,options)=>{request={url,...options};return {status:202};}});
 const user={username:"test.user",firstName:"Test",email:"recipient@example.test"};
 assert.equal((await mailer.send(user,"Secret & <literal> password")).status,"accepted");
 assert.equal(request.url,"https://graph.microsoft.com/v1.0/users/status%40progressive-technology.co.uk/sendMail");
 const data=JSON.parse(request.body);
 assert.equal(data.message.from.emailAddress.address,env.WELCOME_EMAIL_FROM);
 assert.equal(data.message.toRecipients[0].emailAddress.address,user.email);
 assert.match(data.message.body.content,/Username: test.user/);
 assert.ok(data.message.body.content.includes("Password: Secret & <literal> password"));
 assert.ok(data.message.body.content.includes(env.ADMIN_SIGN_IN_URL));
 assert.equal(data.message.body.contentType,"Text");assert.equal(data.saveToSentItems,false);
});
test("disabled configuration, provider rejection and timeout do not expose passwords",async()=>{
 const user={username:"test",firstName:"Test",email:"test@example.test"};
 const disabled=createWelcomeMailer({},{fetch:()=>assert.fail("Must not send")});
 assert.equal((await disabled.send(user,"private")).status,"not_configured");
 const deps={credential:{getToken:async()=>({token:"token"})},fetch:async()=>({status:403})};
 const denied=await createWelcomeMailer(env,deps).send(user,"private");
 assert.equal(denied.status,"failed");assert.match(denied.message,/Mail.Send/);
 const timedOut=await createWelcomeMailer(env,{...deps,fetch:async()=>{throw new Error("private");}}).send(user,"private");
 assert.equal(timedOut.status,"unknown");assert.ok(!JSON.stringify(timedOut).includes("private"));
 assert.equal(validEmail("x@example.test\r\nBcc:other@example.test"),false);
 assert.equal(createWelcomeMailer({...env,ADMIN_SIGN_IN_URL:"javascript:alert(1)"}).configuration().ready,false);
});
test("account invitations are sent once, only after persistence, with visible failure results",async t=>{
 let raw="[]",calls=0,failSave=false,failMail=false;
 const storage={read:async()=>raw,write:async(name,value)=>{if(failSave)throw new Error("Storage unavailable");raw=value;}};
 const welcomeMailer={configuration:()=>({ready:true,message:"Ready"}),send:async(user,password)=>{
  calls++;assert.equal(JSON.parse(raw).some(u=>u.id===user.id),true);assert.equal(password,"long-test-password");
  assert.ok(!raw.includes(password));
  return failMail?{status:"failed",message:"Email could not be sent."}:{status:"accepted",message:"Accepted for delivery."};
 }};
 const app=express();app.use(express.json());require("../user-auth")(app,{statusFile:"unused",key:"test-key-longer-than-24-characters",storage,welcomeMailer});
 app.use((error,req,res,next)=>res.status(500).json({error:"Save failed"}));
 const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));t.after(()=>new Promise(r=>server.close(r)));
 const base="http://127.0.0.1:"+server.address().port+"/api/admin/users";
 const send=(body,id,token="test-key-longer-than-24-characters")=>fetch(base+(id?"/"+id:""),{method:id?"PUT":"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify(body)});
 const user={username:"test",email:"recipient@example.test",firstName:"Test",lastName:"User",jobTitle:"IT",role:"admin",active:true,password:"long-test-password"};
 assert.equal((await send(user,null,"wrong")).status,401);
 assert.equal((await send({...user,email:""})).status,400);assert.equal(calls,0);
 let response=await send(user);assert.equal(response.status,201);const created=await response.json();
 assert.equal(created.welcomeEmail.status,"accepted");assert.equal(created.user.email,user.email);assert.equal(calls,1);
 assert.equal((await send(user)).status,409);assert.equal(calls,1);
 response=await send({...user,password:"",jobTitle:"Updated"},created.user.id);
 assert.equal(response.status,200);assert.equal(calls,1);assert.equal((await response.json()).welcomeEmail,undefined);
 failSave=true;assert.equal((await send({...user,username:"storage-fail"})).status,500);assert.equal(calls,1);failSave=false;
 failMail=true;response=await send({...user,username:"mail-fail"});
 assert.equal(response.status,201);assert.equal((await response.json()).welcomeEmail.status,"failed");assert.equal(calls,2);
 response=await send({...user,username:"disabled",active:false});assert.equal((await response.json()).welcomeEmail.status,"skipped");assert.equal(calls,2);
});
test("deactivation and deletion emails contain no passwords",async()=>{
 for(const event of ["deactivated","deleted"]){
  let content;
  const mailer=createWelcomeMailer(env,{credential:{getToken:async()=>({token:"fake"})},fetch:async(url,options)=>{content=JSON.parse(options.body);return {status:202};}});
  const result=await mailer.send({username:"test",firstName:"Test",email:"test@example.test"},"must-not-appear",event);
  assert.equal(result.status,"accepted");assert.ok(content.message.body.content.includes(event));
  assert.ok(!JSON.stringify(content).includes("must-not-appear"));
 }
});
test("deletion protects admins, revokes sessions and sends notifications only after successful changes",async t=>{
 let raw="[]",failWrite=false;const notices=[];
 const storage={read:async()=>raw,write:async(name,value)=>{if(failWrite)throw new Error("Unavailable");raw=value;}};
 const app=express();app.use(express.json());
 require("../user-auth")(app,{statusFile:"unused",key:"bootstrap-key-at-least-24-characters",storage,welcomeMailer:{
  configuration:()=>({ready:true}),send:async(user,password,event="created")=>{
   if(event==="deleted")assert.ok(!JSON.parse(raw).some(u=>u.id===user.id));
   if(event==="deactivated")assert.equal(JSON.parse(raw).find(u=>u.id===user.id).active,false);
   notices.push(event);return {status:"failed",message:"Simulated email failure"};
  }
 }});
 app.use((e,req,res,next)=>res.status(500).json({error:"Write failed"}));
 const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));t.after(()=>new Promise(r=>server.close(r)));
 const base="http://127.0.0.1:"+server.address().port+"/api/admin/";
 const send=(route,method="GET",body,token="bootstrap-key-at-least-24-characters",origin)=>fetch(base+route,{method,headers:{Authorization:"Bearer "+token,"Content-Type":"application/json",...(origin?{Origin:origin}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const template={username:"admin",email:"admin@example.test",firstName:"Test",lastName:"User",jobTitle:"IT",role:"admin",active:true,password:"long-test-password"};
 const admin=(await(await send("users","POST",template)).json()).user;
 const editorBody={...template,username:"editor",role:"editor"};
 const editor=(await(await send("users","POST",editorBody)).json()).user;
 const login=async username=>(await(await send("login","POST",{username,password:template.password})).json()).token;
 const adminToken=await login("admin"),editorToken=await login("editor");
 assert.equal((await send("users/"+editor.id,"DELETE",null,"wrong")).status,401);
 assert.equal((await send("users/"+admin.id,"DELETE",null,editorToken)).status,403);
 assert.equal((await send("users/"+admin.id,"DELETE",null,adminToken)).status,400);
 assert.equal((await send("users/"+admin.id,"DELETE")).status,400);
 assert.equal((await send("users/"+editor.id,"DELETE",null,adminToken,"https://other.example")).status,403);
 assert.equal((await send("users/missing","DELETE")).status,404);
 let response=await send("users/"+editor.id,"PUT",{...editorBody,password:"",active:false});
 assert.equal(response.status,200);assert.equal((await response.json()).accountEmail.status,"failed");
 assert.equal((await send("me","GET",null,editorToken)).status,401);
 await send("users/"+editor.id,"PUT",{...editorBody,password:"",active:false});
 assert.equal(notices.filter(e=>e==="deactivated").length,1);
 await send("users/"+editor.id,"PUT",{...editorBody,password:"",active:true});
 const renewedToken=await login("editor");
 failWrite=true;
 assert.equal((await send("users/"+editor.id,"DELETE")).status,500);
 assert.equal(notices.filter(e=>e==="deleted").length,0);failWrite=false;
 response=await send("users/"+editor.id,"DELETE");
 assert.equal(response.status,200);assert.equal((await response.json()).accountEmail.status,"failed");
 assert.equal((await send("me","GET",null,renewedToken)).status,401);
 assert.equal((await send("users/"+editor.id,"DELETE")).status,404);
 assert.equal(notices.filter(e=>e==="deleted").length,1);
});
