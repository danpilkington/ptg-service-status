"use strict";
const {randomBytes,randomUUID,createHash}=require("node:crypto");
const {revision}=require("./storage");
const {validEmail}=require("./welcome-email");
const digest=value=>createHash("sha256").update(value).digest("hex");
const empty=()=>({subscribers:[],seen:{},queue:[],initialised:false});
const events=data=>[...(data.incidents||[]),...(data.history||[]),...(data.maintenance||[])].filter(i=>i.source!=="Microsoft"||i.impact==="confirmed").map(i=>({id:i.id,source:i.source,serviceId:i.serviceId,title:i.title||"Service update",message:i.message||"",phase:i.phase||"maintenance",start:i.start,end:i.end,updatedAt:i.updatedAt,updates:i.updates||[]}));
function createSubscriptions({storage,mailer=require("./subscription-mail").createSubscriptionMailer(),env=process.env,getServices,deliveryIntervalMs=60000}){
    let base;try{base=new URL(env.SUBSCRIPTION_PUBLIC_URL||"https://status.progressive.technology/");if(base.protocol!=="https:"||base.username||base.password)base=null;}catch{base=null;}
    const enabled=!!base&&mailer.ready;
    let lock=Promise.resolve();
    function locked(fn){const operation=lock.catch(()=>{}).then(fn);lock=operation;return operation;}
    async function read(){const raw=await storage.read("subscriptions");const value=raw?JSON.parse(raw):empty();return {raw,value:Array.isArray(value)?empty():value};}
    const save=(raw,value)=>storage.write("subscriptions",JSON.stringify(value),revision(raw));
    const link=(action,token)=>new URL("subscriptions.html",base).href+"#"+new URLSearchParams({action,token});
    const rates=new Map();
    const summary={enabled,lastAttemptAt:null,lastSuccessAt:null,failed:false};
    async function request(email,serviceIds){
        if(!enabled)throw Object.assign(new Error("Email subscriptions are not configured."),{status:503});
        const services=await getServices();const allowed=new Set(services.map(s=>s.id));
        if(!validEmail(email)||!Array.isArray(serviceIds)||!serviceIds.length||serviceIds.length>100||serviceIds.some(id=>typeof id!=="string"||!allowed.has(id)))throw Object.assign(new Error("Enter an email and select valid services."),{status:400});
        email=email.trim().toLowerCase();
        let token;
        await locked(async()=>{
            const {raw,value}=await read();const now=Date.now();
            value.subscribers=value.subscribers.filter(s=>s.active||s.expires>now);
            const existing=value.subscribers.find(s=>s.email===email);
            if(existing?.requestedAt>now-120000)return;
            if(!existing&&value.subscribers.length>=10000)throw Object.assign(new Error("Subscriptions are busy. Try again later."),{status:503});
            token=randomBytes(32).toString("hex");
            const sub=existing||{id:randomUUID(),email,active:false};
            sub.pending={hash:digest(token),services:[...new Set(serviceIds)]};sub.expires=now+24*3600000;sub.requestedAt=now;
            if(!existing)value.subscribers.push(sub);await save(raw,value);
        });
        if(token){let failed=false;try{await mailer.send(email,"Confirm your PTG Status subscription",`Confirm updates for your selected services:\n${link("confirm",token)}\n\nThis link expires in 24 hours. If you did not request this, ignore this email. Existing preferences only change after confirmation.`);}catch{failed=true;}
            await locked(async()=>{const {raw,value}=await read(),sub=value.subscribers.find(s=>s.email===email&&s.pending?.hash===digest(token));if(sub){sub.confirmationEmailStatus=failed?"failed":"accepted";await save(raw,value);}});
            if(failed)throw new Error("Subscription confirmation delivery failed.");
        }
    }
    async function confirm(token){return locked(async()=>{
        const {raw,value}=await read(),sub=value.subscribers.find(s=>s.pending?.hash===digest(token)&&s.expires>Date.now());
        if(!sub)throw Object.assign(new Error("This confirmation link is invalid or expired."),{status:400});
        sub.active=true;sub.confirmedAt=new Date().toISOString();sub.services=sub.pending.services;delete sub.pending;
        const secret=randomBytes(32).toString("hex");sub.unsubscribeHash=digest(secret);await save(raw,value);
        return {message:"Your subscription is confirmed. You will receive new incident updates and maintenance notices for your selected services.",unsubscribeToken:secret};
    });}
    async function unsubscribe(token){return locked(async()=>{
        const {raw,value}=await read(),sub=value.subscribers.find(s=>s.unsubscribeHash===digest(token)||(s.unsubscribeHashes||[]).includes(digest(token)));
        if(sub){value.subscribers=value.subscribers.filter(s=>s.id!==sub.id);value.queue=value.queue.filter(job=>job.subscriberId!==sub.id);await save(raw,value);}
        return {message:"You have been unsubscribed from service updates."};
    });}
    let running=false,lastDeliveryStartedAt=0;
    async function reconcile(data){
        if(!enabled||running)return;running=true;summary.lastAttemptAt=new Date().toISOString();
        try{
            await locked(async()=>{
                const {raw,value}=await read(),current=events(data),seen={};let remindersChanged=false;
                value.reminders ||= {};
                for(const [id,at]of Object.entries(value.reminders))if(at<Date.now()-14*86400000)delete value.reminders[id];
                if(data.maintenanceRemindersEnabled){for(const item of data.maintenance||[]){const remaining=Date.parse(item.start)-Date.now();if(!Number.isFinite(remaining)||remaining<=0||remaining>86400000||item.source==="Microsoft"&&item.impact!=="confirmed")continue;const hours=remaining<=3600000?1:24;const id=item.id+":"+item.start+":"+hours;
                    for(const sub of value.subscribers.filter(s=>s.active&&!s.paused&&s.services.includes(item.serviceId))){const key=id+":"+sub.id;if(value.reminders[key])continue;if(value.queue.length>=50000)throw Error("Subscription outbox is full.");value.reminders[key]=Date.now();value.queue.push({id:randomUUID(),subscriberId:sub.id,event:{id:item.id,serviceId:item.serviceId,title:"Maintenance reminder: "+item.title,message:"Scheduled start: "+item.start+"\nScheduled end: "+item.end+"\n\n"+(item.message||""),phase:"maintenance",updates:[],start:item.start,end:item.end},reminder:true,attempts:0,nextAttempt:0,createdAt:Date.now()});remindersChanged=true;}}}
                for(const event of current){
                    const hash=digest(JSON.stringify(event));seen[event.id]=hash;
                    if(data.microsoftStale&&event.source==="Microsoft"){seen[event.id]=value.seen[event.id]||hash;continue;}
                    if(!value.initialised||value.seen[event.id]===hash)continue;
                    for(const sub of value.subscribers.filter(s=>s.active&&!s.paused&&s.services.includes(event.serviceId))){
                        if(value.queue.length>=50000)throw new Error("Subscription outbox is full.");
                        value.queue.push({id:randomUUID(),subscriberId:sub.id,event,attempts:0,nextAttempt:0,createdAt:Date.now()});
                    }
                }
                const changed=remindersChanged||!value.initialised||JSON.stringify(value.seen)!==JSON.stringify(seen);
                value.seen=seen;value.initialised=true;if(changed)await save(raw,value);
            });
            const jobs=await locked(async()=>{const {value}=await read();return Date.now()-lastDeliveryStartedAt<deliveryIntervalMs?[]:value.queue.filter(j=>j.nextAttempt<=Date.now()).slice(0,20).map(j=>j.id);});
            if(jobs.length)lastDeliveryStartedAt=Date.now();
            for(const id of jobs){
                const delivery=await locked(async()=>{
                    const {raw,value}=await read(),job=value.queue.find(j=>j.id===id&&j.nextAttempt<=Date.now());if(!job)return null;
                    const sub=value.subscribers.find(s=>s.id===job.subscriberId&&s.active&&!s.paused&&s.services.includes(job.event.serviceId));
                    if(!sub){value.queue=value.queue.filter(j=>j.id!==id);await save(raw,value);return null;}
                    if(job.reminder&&(!data.maintenanceRemindersEnabled||!data.maintenance?.some(item=>item.id===job.event.id&&item.start===job.event.start&&Date.parse(item.start)>Date.now()))){value.queue=value.queue.filter(j=>j.id!==id);await save(raw,value);return null;}
                    const token=randomBytes(32).toString("hex");sub.unsubscribeHashes=[...(sub.unsubscribeHashes||[]),digest(token)].slice(-100);
                    // Claim before sending, allowing confirmation/unsubscribe requests while Graph is slow.
                    job.nextAttempt=Date.now()+120000;await save(raw,value);return {email:sub.email,event:job.event,token};
                });
                if(!delivery)continue;
                let failed=false;
                try{
                    const e=delivery.event,last=e.updates.at(-1)?.message;
                    await mailer.send(delivery.email,"PTG Status: "+e.title,e.title+"\nStage: "+e.phase+"\n\n"+e.message+(last&&last!==e.message?"\n\nLatest update: "+last:"")+(e.start?"\nStarts: "+e.start:"")+(e.end?"\nEnds: "+e.end:"")+"\n\nView status: "+base.href+"\nUnsubscribe: "+link("unsubscribe",delivery.token));
                }catch{failed=true;}
                await locked(async()=>{
                    const {raw,value}=await read(),job=value.queue.find(j=>j.id===id);if(!job)return;
                    const subscriber=value.subscribers.find(s=>s.id===job.subscriberId);
                    if(subscriber){subscriber.lastDeliveryAttemptAt=new Date().toISOString();if(failed){subscriber.lastDeliveryFailureAt=subscriber.lastDeliveryAttemptAt;subscriber.deliveryFailures=(subscriber.deliveryFailures||0)+1;}else{subscriber.lastDeliveredAt=subscriber.lastDeliveryAttemptAt;subscriber.deliveryFailures=0;}}
                    if(failed){job.attempts++;job.nextAttempt=Date.now()+Math.min(3600000,60000*2**Math.min(job.attempts,6));}
                    else value.queue=value.queue.filter(j=>j.id!==id);
                    await save(raw,value);
                });
            }
            const {value}=await read();summary.failed=value.queue.some(j=>j.attempts>0);summary.lastSuccessAt=new Date().toISOString();
        }catch(error){summary.failed=true;throw error;}
        finally{running=false;}
    }
    async function listSubscribers({search="",filter="all",offset=0}={}){
        return locked(async()=>{
            const {raw,value}=await read(),now=Date.now(),queueCounts=new Map();
            for(const job of value.queue){const counts=queueCounts.get(job.subscriberId)||{queued:0,failed:0};counts.queued++;if(job.attempts>0)counts.failed++;queueCounts.set(job.subscriberId,counts);}
            const summaries=value.subscribers.map(s=>{
                const queued=queueCounts.get(s.id)||{queued:0,failed:0},status=s.active?(s.paused?"paused":"confirmed"):s.expires>now?"pending":"expired";
                return {id:s.id,email:s.email,serviceIds:s.services||s.pending?.services||[],status,confirmedAt:s.confirmedAt||null,requestedAt:s.requestedAt?new Date(s.requestedAt).toISOString():null,lastDeliveredAt:s.lastDeliveredAt||null,lastDeliveryFailureAt:s.lastDeliveryFailureAt||null,deliveryFailures:s.deliveryFailures||0,confirmationEmailStatus:s.confirmationEmailStatus||null,queued:queued.queued,failed:queued.failed};
            });
            const counts={confirmationFailures:summaries.filter(s=>s.confirmationEmailStatus==="failed"&&s.status!=="confirmed").length,total:summaries.length,confirmed:0,paused:0,pending:0,expired:0,queued:value.queue.length,failed:value.queue.filter(j=>j.attempts>0).length};for(const row of summaries)counts[row.status]++;
            const needle=search.toLowerCase();const matches=summaries.filter(s=>(filter==="all"||filter==="failed"?(filter!=="failed"||s.failed>0||s.deliveryFailures>0||s.confirmationEmailStatus==="failed"):s.status===filter)&&s.email.toLowerCase().includes(needle)).sort((a,b)=>a.email.localeCompare(b.email));
            const start=Math.max(0,Math.min(Math.floor(offset/50)*50,Math.floor(Math.max(0,matches.length-1)/50)*50));
            return {items:matches.slice(start,start+50),total:matches.length,offset:start,counts,revision:revision(raw)};
        });
    }
    async function manageSubscriber(id,action,expected,user){
        return locked(async()=>{
            const {raw,value}=await read();if(revision(raw)!==expected)throw Object.assign(new Error("Subscriptions changed. Refresh the list and retry."),{status:409});
            const sub=value.subscribers.find(s=>s.id===id);if(!sub)throw Object.assign(new Error("Subscriber not found."),{status:404});
            if(!["pause","resume","retry","delete"].includes(action))throw Object.assign(new Error("Invalid subscriber action."),{status:400});
            if(["resume","retry"].includes(action)&&!sub.active)throw Object.assign(new Error("This address must confirm its subscription first."),{status:400});
            if(action==="retry"&&sub.paused)throw Object.assign(new Error("Resume this subscriber before retrying delivery."),{status:400});
            if(action==="pause"){sub.paused=true;value.queue=value.queue.filter(j=>j.subscriberId!==id);}
            if(action==="resume")sub.paused=false;
            if(action==="retry")for(const job of value.queue.filter(j=>j.subscriberId===id)){job.nextAttempt=0;job.attempts=0;}
            if(action==="delete"){value.subscribers=value.subscribers.filter(s=>s.id!==id);value.queue=value.queue.filter(j=>j.subscriberId!==id);}
            await require("./governance").commit(storage,[require("./governance").update("subscriptions",raw,value)],user,"subscriber."+action,id);
            return {ok:true};
        });
    }
    function attachAdministration(app){
        const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(error=>{if([400,404,409].includes(error.status))return res.status(error.status).json({error:error.message});next(error);});
        app.use("/api/admin/subscribers",(req,res,next)=>{if(req.adminUser.role!=="admin")return res.status(403).json({error:"Administrator access required."});next();});
        app.get("/api/admin/subscribers",wrap(async(req,res)=>{
            const filter=typeof req.query.filter==="string"?req.query.filter:"all",search=typeof req.query.search==="string"?req.query.search.slice(0,254):"",offset=Math.max(0,Number(req.query.offset)||0);
            if(!["all","confirmed","paused","pending","expired","failed"].includes(filter))return res.status(400).json({error:"Invalid subscriber filter."});
            res.json({...await listSubscribers({search,filter,offset}),services:getServices?await getServices():[]});
        }));
        app.post("/api/admin/subscribers/:id/:action",wrap(async(req,res)=>res.json(await manageSubscriber(req.params.id,req.params.action,req.body?.revision,req.adminUser))));
    }
    function attach(app){
        const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(error=>{if([400,429,503].includes(error.status))return res.status(error.status).json({error:error.message});next(error);});
        app.use("/api/subscriptions",(req,res,next)=>{
            res.set("Cache-Control","no-store");
            if(req.method!=="GET"){
                try{if(req.get("Origin")&&new URL(req.get("Origin")).host!==req.get("Host"))return res.status(403).json({error:"Invalid request origin."});}catch{return res.sendStatus(403);}
                const now=Date.now();for(const [key,v]of rates)if(v.until<=now)rates.delete(key);
                const rate=rates.get(req.ip)||{count:0,until:now+15*60000};if(rate.count>=10||rates.size>=10000)return res.status(429).json({error:"Too many requests. Try again in 15 minutes."});rate.count++;rates.set(req.ip,rate);
            }next();
        });
        app.get("/api/subscriptions/config",wrap(async(req,res)=>res.json({enabled,services:enabled?await getServices():[]})));
        app.post("/api/subscriptions/request",wrap(async(req,res)=>{
            try{await request(req.body?.email,req.body?.serviceIds);}catch(error){if(error.status)throw error;console.error("Subscription confirmation email could not be delivered.");}
            res.status(202).json({message:"If delivery is available, a confirmation link will arrive shortly. Check your inbox and junk folder."});
        }));
        for(const action of ["confirm","unsubscribe"])app.post("/api/subscriptions/"+action,wrap(async(req,res)=>{
            const token=req.body?.token;if(typeof token!=="string"||!/^[a-f0-9]{64}$/.test(token))return res.status(400).json({error:"Invalid subscription link."});
            res.json(await (action==="confirm"?confirm:unsubscribe)(token));
        }));
    }
    return {attach,attachAdministration,listSubscribers,manageSubscriber,reconcile,request,confirm,unsubscribe,snapshot:()=>({...summary}),enabled};
}
module.exports={createSubscriptions,events};
