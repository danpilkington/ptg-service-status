"use strict";
function attachPublicAvailability(app,{storage,availability,microsoftIds=[]}){
    app.get("/api/services/:id/availability",async(req,res)=>{
        res.set("Cache-Control","no-store");
        try{
            const data=JSON.parse(await storage.read("status"));
            const services=Array.isArray(data.services)?data.services:[];
            const service=services.find(s=>s.id===req.params.id);
            if(!service&&!microsoftIds.includes(req.params.id))return res.status(404).json({error:"Service not found."});
            const month=new Date().toISOString().slice(0,7);
            const report=await availability.report(month,service?[service]:[]);
            const row=report.rows.find(r=>r.id===req.params.id);
            // Only numeric aggregate values for the requested currently published service are public.
            const numeric=name=>Number.isFinite(row?.[name])?row[name]:null;
            res.json({serviceId:req.params.id,month,from:report.from,to:report.to,startedAt:report.startedAt,
                operationalPercent:numeric("operationalPercent"),coverage:numeric("coverage")??0,outageSeconds:numeric("outage")??0,maintenanceSeconds:numeric("maintenance")??0,
                unknownSeconds:numeric("unknown")??(Date.parse(report.to)-Date.parse(report.from))/1000,outageCount:numeric("outageCount")??0});
        }catch{res.status(503).json({error:"Observed availability is temporarily unavailable."});}
    });
}
module.exports={attachPublicAvailability};
