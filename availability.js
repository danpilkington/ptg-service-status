"use strict";
const {revision}=require("./storage");
const {serial}=require("./governance");
const DAY=86400000,STATES=["operational","degraded","advisory","outage","maintenance","unknown"];
function addInterval(data,start,end,services){
    while(start<end){
        const day=new Date(start).toISOString().slice(0,10),boundary=Date.parse(day+"T00:00:00Z")+DAY,stop=Math.min(end,boundary);
        const bucket=data.days[day] ||= {};
        for(const service of services){
            const row=bucket[service.id] ||= {id:service.id,name:service.name,source:service.source,outageCount:0};
            const state=STATES.includes(service.status)?service.status:"unknown";
            row[state]=(row[state]||0)+(stop-start)/1000;
        }
        start=stop;
    }
}
function sample(data,services,now){
    data=structuredClone(data||{days:{},previous:[],at:null,startedAt:now});
    if(data.at!==null&&now<=data.at)return data;
    if(data.at!==null)addInterval(data,data.at,Math.min(now,data.at+120000),data.previous);
    const current=services.map(s=>({id:s.id,name:s.name||s.serviceName||s.id,source:s.source||"PTG",status:STATES.includes(s.status)?s.status:"unknown"}));
    const day=new Date(now).toISOString().slice(0,10),bucket=data.days[day]||={};
    for(const s of current){
        if(s.status==="outage"&&data.previous.find(old=>old.id===s.id)?.status!=="outage"){
            const row=bucket[s.id]||={id:s.id,name:s.name,source:s.source,outageCount:0};row.outageCount++;
        }
    }
    data.previous=current;data.at=now;
    const cutoff=new Date(now-400*DAY).toISOString().slice(0,10);
    for(const day of Object.keys(data.days))if(day<cutoff)delete data.days[day];
    return data;
}
function report(data,month,now=Date.now(),services=[]){
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw Object.assign(new Error("Choose a valid reporting month."),{status:400});
    const from=Date.parse(month+"-01T00:00:00Z"),to=Math.min(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),1),now);
    if(from>=to||from<now-400*DAY)throw Object.assign(new Error("Choose the current month or a month within the last 12 months."),{status:400});
    data=structuredClone(data||{days:{},previous:[],at:null,startedAt:null});
    if(data.at!==null)addInterval(data,data.at,Math.min(now,data.at+120000),data.previous);
    const rows=new Map();
    for(const s of [...services,...data.previous])rows.set(s.id,{id:s.id,name:s.name||s.serviceName||s.id,source:s.source||"PTG",outageCount:0});
    for(const [day,bucket] of Object.entries(data.days)){
        if(!day.startsWith(month))continue;
        for(const value of Object.values(bucket)){
            const row=rows.get(value.id)||{id:value.id,name:value.name,source:value.source,outageCount:0};
            for(const state of [...STATES,"outageCount"])row[state]=(row[state]||0)+(value[state]||0);
            rows.set(value.id,row);
        }
    }
    const elapsed=(to-from)/1000;
    return {month,from:new Date(from).toISOString(),to:new Date(to).toISOString(),startedAt:data.startedAt?new Date(data.startedAt).toISOString():null,
        rows:[...rows.values()].map(row=>{
            const known=STATES.filter(s=>s!=="unknown").reduce((n,s)=>n+(row[s]||0),0);
            const eligible=known-(row.maintenance||0);
            return {...row,unknown:Math.max(0,elapsed-known),coverage:100*known/elapsed,operationalPercent:eligible?100*(row.operational||0)/eligible:null};
        }).sort((a,b)=>a.name.localeCompare(b.name))};
}
function createAvailability(storage){
    return {async record(services,now=Date.now()){
        return serial(storage,async()=>{
            const raw=await storage.read("availability"),old=JSON.parse(raw||"null");
            if(old&&now-old.at<60000)return;
            const next=sample(old,services,now);
            await storage.write("availability",JSON.stringify(next),revision(raw));
        });
    },async report(month,services){return report(JSON.parse(await storage.read("availability")||"null"),month,Date.now(),services);}};
}
module.exports={sample,report,createAvailability};
