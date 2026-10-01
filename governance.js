"use strict";
const {randomUUID}=require("node:crypto");
const {revision}=require("./storage");
const serials=new WeakMap();
async function serial(storage,action){
    const prior=serials.get(storage)||Promise.resolve();
    const job=prior.catch(()=>{}).then(action);serials.set(storage,job);
    try{return await job;}finally{if(serials.get(storage)===job)serials.delete(storage);}
}
function actor(user){return {id:user?.id||"system",name:user?.username||user?.firstName||"System"};}
async function commit(storage,updates,user,action,target,details=""){
    // Audit writes and the affected records commit together.
    return serial(storage,async()=>{
        const raw=await storage.read("audit"),entries=JSON.parse(raw||"[]");
        entries.push({id:randomUUID(),at:new Date().toISOString(),actor:actor(user),action,target:String(target||""),details:String(details).slice(0,1000)});
        const changes=[...updates,{name:"audit",content:JSON.stringify(entries),expectedRevision:revision(raw)}];
        if(!storage.writeMany)throw new Error("Transactional storage is required for audited changes.");
        await storage.writeMany(changes);
    });
}
const update=(name,raw,data)=>({name,content:JSON.stringify(data,null,2)+"\n",expectedRevision:revision(raw)});
module.exports={commit,update,actor,serial};
