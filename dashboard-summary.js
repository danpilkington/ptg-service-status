"use strict";
(function(root){
    function affectedServices(data,now=Date.now()){
        const states=new Set(["outage","degraded","advisory","maintenance"]),priority={outage:0,degraded:1,advisory:2,maintenance:3};
        return (data.services||[]).map(service=>{
            const incidents=(data.incidents||[]).filter(i=>i.serviceId===service.id&&i.phase!=="resolved").sort((a,b)=>(a.impact==="confirmed"?0:1)-(b.impact==="confirmed"?0:1)||(Date.parse(b.updatedAt||b.start)||0)-(Date.parse(a.updatedAt||a.start)||0));
            const confirmed=incidents.some(i=>i.impact==="confirmed");
            if(!states.has(service.status)&&!confirmed)return null;
            const incident=incidents[0];
            const maintenance=(data.maintenance||[]).find(m=>m.serviceId===service.id&&Date.parse(m.start)<=now&&Date.parse(m.end)>now);
            const updates=[...(incident?.updates||[])].sort((a,b)=>(Date.parse(b.at)||0)-(Date.parse(a.at)||0));
            const stale=service.stale||service.source==="Microsoft"&&data.microsoftStale;
            const impact=confirmed?"Affecting PTG":service.source!=="Microsoft"?"PTG service issue":incidents.length&&incidents.every(i=>i.impact==="not-affected")?"PTG assessed no impact":"PTG impact not confirmed";
            return {id:service.id,name:service.name||service.serviceName||service.id,status:service.status,confirmed,stale:!!stale,impact,
                guidance:incident?.workaround||incident?.ptgNote||updates[0]?.workaround||updates[0]?.message||incident?.message||maintenance?.message||"Open service details for the latest information.",nextUpdateAt:incident?.nextUpdateAt||null};
        }).filter(Boolean).sort((a,b)=>Number(b.confirmed)-Number(a.confirmed)||(priority[a.status]??4)-(priority[b.status]??4)||a.name.localeCompare(b.name));
    }
    function parseFavourites(raw){try{const value=JSON.parse(raw||"[]");return new Set(Array.isArray(value)?value.filter(id=>typeof id==="string"&&id.length>0&&id.length<=100).slice(0,500):[]);}catch{return new Set();}}
    const api={affectedServices,parseFavourites};
    if(typeof module!=="undefined"&&module.exports)module.exports=api;
    else root.PTGDashboard=api;
})(typeof window!=="undefined"?window:globalThis);
