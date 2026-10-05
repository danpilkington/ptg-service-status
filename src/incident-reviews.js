"use strict";
const {revision}=require("./storage"),{commit,update}=require("./governance"),{normaliseIncident}=require("./incident-model");
const clean=value=>typeof value==="string"?value.trim():"";
const escape=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
function report(incident,review={},service){
    const item=normaliseIncident(incident),start=Date.parse(item.start),end=item.phase==="resolved"?Date.parse(item.resolvedAt):NaN;
    return {incident:{id:item.id,title:item.title,service:item.service||service?.name||item.serviceId,serviceId:item.serviceId,phase:item.phase,impact:item.impact,message:item.message,start:item.start,resolvedAt:item.resolvedAt||null,elapsedMinutes:Number.isFinite(start)&&Number.isFinite(end)&&end>=start?Math.round((end-start)/60000):null,timeline:item.updates},ownerTeam:service?.ownerTeam||"",review};
}
function htmlReport(data){
    const i=data.incident,r=data.review,section=(title,value)=>`<section><h2>${escape(title)}</h2><p>${escape(value||"Not recorded")}</p></section>`;
    return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(i.title)} - Incident review</title><style>body{max-width:900px;margin:40px auto;padding:0 24px;font:15px/1.6 Arial,sans-serif;color:#152b3d}h1{line-height:1.2}h2{font-size:20px;border-bottom:1px solid #cbd5df;margin-top:28px}p{white-space:pre-wrap;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%}td,th{text-align:left;border-bottom:1px solid #dce3ea;padding:10px;vertical-align:top;overflow-wrap:anywhere}small{color:#526878}@media print{body{margin:0;font-size:11pt}section{break-inside:avoid}thead{display:table-header-group}}</style></head><body><small>PTG · Internal incident review · Generated ${escape(new Date().toISOString())}</small><h1>${escape(i.title)}</h1><p>Service: ${escape(i.service)}\nOwner team: ${escape(data.ownerTeam||"Unassigned")}\nStage: ${escape(i.phase)} · Impact: ${escape(i.impact)}\nOpened: ${escape(i.start)}\nResolved: ${escape(i.resolvedAt||"Not resolved")}\nIncident elapsed time: ${i.elapsedMinutes===null?"Unavailable":i.elapsedMinutes+" minutes"}</p><small>Elapsed incident time is not measured service outage time. Dates and timeline entries are published records; deleted/corrected entries may affect the displayed timeline.</small>${section("Incident summary",i.message)}${section("Impact assessment",r.impactSummary)}${section("Root cause",r.rootCause)}${section("Resolution",r.resolution)}${section("Lessons learned",r.lessonsLearned)}<section><h2>Follow-up actions</h2><table><thead><tr><th>Action</th><th>Owner</th><th>Due</th><th>Status</th></tr></thead><tbody>${(r.actions||[]).map(a=>`<tr><td>${escape(a.title)}</td><td>${escape(a.owner||"Unassigned")}</td><td>${escape(a.dueDate||"Not set")}</td><td>${a.completed?"Complete":"Open"}</td></tr>`).join("")||'<tr><td colspan="4">No actions recorded</td></tr>'}</tbody></table></section><section><h2>Published timeline</h2>${i.timeline.map(u=>`<p><strong>${escape(u.at)} · ${escape(u.phase||"Update")}</strong>\n${escape(u.message)}</p>`).join("")||"<p>No timeline entries recorded</p>"}</section><small>Review last saved: ${escape(r.updatedAt||"Not saved")}</small></body></html>`;
}
function validReview(input){
    for(const field of ["impactSummary","rootCause","resolution","lessonsLearned"])if(typeof input[field]!=="string"||input[field].length>5000)return false;
    return Array.isArray(input.actions)&&input.actions.length<=30&&input.actions.every(a=>a&&typeof a.title==="string"&&a.title.trim()&&a.title.length<=500&&typeof a.owner==="string"&&a.owner.length<=100&&typeof a.completed==="boolean"&&(a.dueDate===""||typeof a.dueDate==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(a.dueDate)&&Number.isFinite(Date.parse(a.dueDate+"T00:00:00Z"))&&new Date(a.dueDate+"T00:00:00Z").toISOString().slice(0,10)===a.dueDate));
}
function attachReviews(app,{storage}){
    const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
    app.use("/api/admin/incident-reviews",(req,res,next)=>{if(req.adminUser.role!=="admin")return res.status(403).json({error:"Administrator access required."});next();});
    app.get("/api/admin/action-dashboard",wrap(async(req,res)=>{
        if(req.adminUser.role!=="admin")return res.sendStatus(403);
        const status=JSON.parse(await storage.read("status")),raw=await storage.read("reviews"),reviews=JSON.parse(raw||"{}");
        const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/London",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
        const items=Object.entries(reviews).flatMap(([id,r])=>(r.actions||[]).map((a,index)=>({...a,incidentId:id,index,incidentTitle:status.incidents?.find(i=>i.id===id)?.title||id,overdue:!a.completed&&!!a.dueDate&&a.dueDate<today})));
        res.json({items,revision:revision(raw)});
    }));
    app.put("/api/admin/action-dashboard/:id/:index",wrap(async(req,res)=>{
        if(req.adminUser.role!=="admin")return res.sendStatus(403);
        const raw=await storage.read("reviews"),reviews=JSON.parse(raw||"{}"),action=reviews[req.params.id]?.actions?.[Number(req.params.index)];
        if(req.body.revision!==revision(raw))return res.status(409).json({error:"Actions changed. Refresh and retry."});
        if(!action||typeof req.body.completed!=="boolean")return res.status(400).json({error:"Invalid action."});
        action.completed=req.body.completed;reviews[req.params.id].updatedAt=new Date().toISOString();await commit(storage,[update("reviews",raw,reviews)],req.adminUser,"incident.action_updated",req.params.id);res.json({ok:true});
    }));
    app.get("/api/admin/incident-reviews",wrap(async(req,res)=>{
        const status=JSON.parse(await storage.read("status")),reviews=Object.assign(Object.create(null),JSON.parse(await storage.read("reviews")||"{}"));
        const items=(status.incidents||[]).filter(i=>i.phase==="resolved"||reviews[i.id]).map(i=>({id:i.id,title:i.title,service:i.service||i.serviceId,phase:i.phase,resolvedAt:i.resolvedAt,reviewed:!!reviews[i.id],openActions:(reviews[i.id]?.actions||[]).filter(a=>!a.completed).length})).sort((a,b)=>Date.parse(b.resolvedAt||0)-Date.parse(a.resolvedAt||0));
        res.json({items});
    }));
    async function load(id){const statusRaw=await storage.read("status"),status=JSON.parse(statusRaw),incident=(status.incidents||[]).find(i=>i.id===id),raw=await storage.read("reviews"),reviews=Object.assign(Object.create(null),JSON.parse(raw||"{}"));return {status,statusRaw,incident,raw,reviews};}
    app.get("/api/admin/incident-reviews/:id",wrap(async(req,res)=>{
        const {status,incident,raw,reviews}=await load(req.params.id);if(!incident)return res.status(404).json({error:"Incident not found."});
        const data=report(incident,reviews[incident.id],status.services.find(s=>s.id===incident.serviceId)||status.retiredServices?.find(s=>s.id===incident.serviceId));
        if(req.query.download==="html"){res.set({"Content-Type":"text/html; charset=utf-8","Content-Disposition":'attachment; filename="ptg-incident-review.html"',"Content-Security-Policy":"default-src 'none'; style-src 'unsafe-inline'"});return res.send(htmlReport(data));}
        res.json({...data,revision:revision(raw),incidentRevision:revision(JSON.stringify(incident))});
    }));
    app.put("/api/admin/incident-reviews/:id",wrap(async(req,res)=>{
        const {incident,statusRaw,raw,reviews}=await load(req.params.id);if(!incident)return res.status(404).json({error:"Incident not found."});
        if(incident.phase!=="resolved")return res.status(409).json({error:"Resolve the incident before saving its review."});
        if(req.body?.revision!==revision(raw)||req.body?.incidentRevision!==revision(JSON.stringify(incident)))return res.status(409).json({error:"The review or incident changed. Reload before saving."});
        if(!validReview(req.body||{}))return res.status(400).json({error:"Keep review sections under 5,000 characters, with up to 30 actions and valid due dates."});
        const saved={impactSummary:clean(req.body.impactSummary),rootCause:clean(req.body.rootCause),resolution:clean(req.body.resolution),lessonsLearned:clean(req.body.lessonsLearned),actions:req.body.actions.map(a=>({title:clean(a.title),owner:clean(a.owner),dueDate:a.dueDate,completed:a.completed})),updatedAt:new Date().toISOString()};
        reviews[incident.id]=saved;await commit(storage,[update("reviews",raw,reviews),{name:"status",content:statusRaw,expectedRevision:revision(statusRaw)}],req.adminUser,"incident.review_saved",incident.id,"Follow-up actions: "+saved.actions.length);
        res.json({saved:true});
    }));
}
module.exports={attachReviews,report,htmlReport,validReview};
