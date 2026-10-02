"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {createSubscriptions}=require("../src/subscriptions"),{revision}=require("../src/storage"),{calendar}=require("../assets/maintenance-calendar");
function fixture(){let raw=null;const messages=[];let fail=false;const storage={read:async()=>raw,write:async(name,content,expected)=>{assert.equal(name,"subscriptions");assert.equal(revision(raw),expected);raw=content;}};const env={SUBSCRIPTION_PUBLIC_URL:"https://status.example/"};const mailer={ready:true,send:async(email,subject,content)=>{if(fail)throw Error("provider secret must not surface");messages.push({email,subject,content});}};const options={storage,env,mailer,deliveryIntervalMs:0,getServices:async()=>[{id:"vpn",name:"VPN"}]};return {options,messages,read:()=>JSON.parse(raw),fail:value=>{fail=value},write:value=>{raw=JSON.stringify(value)}};}
const event=(message="Investigating",phase="investigating")=>({services:[],incidents:phase==="resolved"?[]:[{id:"incident1",serviceId:"vpn",title:"VPN unavailable",message,phase}],history:phase==="resolved"?[{id:"incident1",serviceId:"vpn",title:"VPN unavailable",message,phase}]:[],maintenance:[]});
const confirmation=f=>new URLSearchParams(f.messages.at(-1).content.match(/https:\/\/\S+/)[0].split("#")[1]).get("token");
test("subscriptions require confirmation and do not expose or persist confirmation tokens",async()=>{
    const f=fixture(),s=createSubscriptions(f.options);await s.reconcile({});await s.request("person@example.com",["vpn"]);const token=confirmation(f);
    assert.equal(f.read().subscribers[0].active,false);assert.ok(!JSON.stringify(f.read()).includes(token));
    await s.reconcile(event());assert.equal(f.messages.length,1);
    await s.confirm(token);await assert.rejects(()=>s.confirm(token));
    await s.reconcile(event("Cause found","identified"));assert.equal(f.messages.length,2);assert.match(f.messages[1].content,/Cause found/);
    await s.reconcile(event("Cause found","identified"));assert.equal(f.messages.length,2);
    await s.reconcile(event("Restored","resolved"));assert.equal(f.messages.length,3);
    const link=f.messages.at(-1).content.match(/Unsubscribe: (\S+)/)[1],secret=new URLSearchParams(link.split("#")[1]).get("token");
    await s.unsubscribe(secret);assert.equal(f.read().subscribers.length,0);await s.reconcile(event("Another update"));assert.equal(f.messages.length,3);
});
test("subscription preferences only change after confirmation; queued emails survive restart and unsubscribe cancels them",async()=>{
    const f=fixture(),s=createSubscriptions(f.options);await s.reconcile({});await s.request("person@example.com",["vpn"]);const result=await s.confirm(confirmation(f));
    f.fail(true);await s.reconcile(event());assert.equal(f.read().queue.length,1);assert.equal(s.snapshot().failed,true);
    const saved=f.read();saved.queue[0].nextAttempt=0;f.write(saved);f.fail(false);
    const restarted=createSubscriptions(f.options);await restarted.reconcile(event());assert.equal(f.read().queue.length,0);assert.equal(f.messages.length,2);
    f.fail(true);await restarted.reconcile(event("New update"));assert.equal(f.read().queue.length,1);
    await restarted.unsubscribe(result.unsubscribeToken);assert.equal(f.read().queue.length,0);
});
test("subscription validation rejects unknown services and invalid email; no initial incident dump",async()=>{
    const f=fixture(),s=createSubscriptions(f.options);await assert.rejects(()=>s.request("bad",["vpn"]));await assert.rejects(()=>s.request("person@example.com",["other"]));await assert.rejects(()=>s.request("person@example.com",[]));
    await s.request("person@example.com",["vpn"]);await s.confirm(confirmation(f));await s.reconcile(event());assert.equal(f.messages.length,1);
});
test("Outlook calendar uses UTC times, escapes content, folds long UTF-8 lines and excludes invalid windows",()=>{
    const output=calendar([{id:"m1",title:"Work, planned; tomorrow",message:"Line one\nLine two "+"é".repeat(100),serviceId:"vpn",start:"2026-10-25T01:30:00Z",end:"2026-10-25T02:30:00Z"},{id:"bad",start:"bad",end:"bad"}],new Date("2026-10-02T12:00:00Z"));
    assert.match(output,/DTSTART:20261025T013000Z/);assert.match(output,/DTEND:20261025T023000Z/);assert.match(output,/SUMMARY:Work\\, planned\\; tomorrow/);assert.equal((output.match(/BEGIN:VEVENT/g)||[]).length,1);
    for(const line of output.split("\r\n"))assert.ok(Buffer.byteLength(line)<=75);assert.ok(output.endsWith("END:VCALENDAR\r\n"));
});
test("visitor refreshes cannot bypass the one-minute email delivery limit",async()=>{
    const f=fixture(),s=createSubscriptions({...f.options,deliveryIntervalMs:60000});await s.reconcile({});await s.request("person@example.com",["vpn"]);await s.confirm(confirmation(f));await s.reconcile(event());assert.equal(f.messages.length,2);
    await s.reconcile(event("Second update","identified"));assert.equal(f.messages.length,2);assert.equal(f.read().queue.length,1);
});
