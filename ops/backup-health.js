"use strict";
const fs=require("node:fs/promises");
async function backupHealth(file,now=Date.now()){
    const base={enabled:!!file,state:file?"waiting":"disabled",lastAttemptAt:null,lastSuccessAt:null,lastEventAt:null,failures:0,message:""};
    if(!file)return base;
    try{
        const stat=await fs.stat(file);if(stat.size>16384)throw Error("Oversized health record");
        const record=JSON.parse(await fs.readFile(file,"utf8"));
        const checked=Date.parse(record.checkedAt),verified=Date.parse(record.verifiedAt);
        if(!Number.isFinite(checked)||checked>now+60000||typeof record.succeeded!=="boolean"||record.succeeded&&(!Number.isFinite(verified)||verified>now+60000))throw Error("Invalid health record");
        const recent=Number.isFinite(verified)&&now-verified<26*3600000;
        return {...base,state:!record.succeeded?"error":recent?"healthy":"stale",lastAttemptAt:record.checkedAt,lastSuccessAt:Number.isFinite(verified)?record.verifiedAt:null,
            failures:record.succeeded?0:Number.isSafeInteger(record.failures)&&record.failures>0?record.failures:1,message:!record.succeeded?"The last SQL backup or verification failed. Check the scheduled task on IT1.":recent?"":"No verified SQL backup within 26 hours. Check the scheduled task and backup destination."};
    }catch{return {...base,state:"error",message:"SQL backup health is unavailable. Check the record path and service-account read permissions."};}
}
module.exports={backupHealth};
