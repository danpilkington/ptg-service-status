"use strict";
const fs=require("node:fs/promises"),path=require("node:path");
function validateUrl(value){
    const url=new URL(value);
    if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash)throw new Error("Use the deployed HTTPS site URL without credentials, query or fragment.");
    url.pathname="/";return url.origin;
}
async function check({url,previous=null,request=fetch,now=Date.now(),threshold=3}){
    url=validateUrl(url);const outcomes=await Promise.all(["health","ready"].map(async endpoint=>{
        try{
            const response=await request(url+"/api/"+endpoint,{redirect:"error",cache:"no-store",signal:AbortSignal.timeout(10000)});
            if(!response.ok)return {endpoint,ok:false,httpStatus:response.status};
            const body=await response.json();
            return {endpoint,ok:body.status===(endpoint==="health"?"ok":"ready"),httpStatus:response.status};
        }catch{return {endpoint,ok:false,httpStatus:null};}
    }));
    const validPrevious=previous?.url===url&&Number.isFinite(Date.parse(previous.checkedAt))&&now-Date.parse(previous.checkedAt)>=0&&now-Date.parse(previous.checkedAt)<=5*60000;
    const failures=outcomes.every(x=>x.ok)?0:(validPrevious&&Number.isSafeInteger(previous.failures)&&previous.failures>=0?Math.min(previous.failures,100000):0)+1;
    const alerted=failures>=threshold;
    const event=alerted&&!previous?.alerted?"failure":!failures&&previous?.alerted&&previous.url===url?"recovery":"unchanged";
    return {version:1,url,checkedAt:new Date(now).toISOString(),failures,alerted,event,outcomes};
}
async function main(args=process.argv.slice(2)){
    const option=name=>{const i=args.indexOf(name);if(i<0||!args[i+1]||args[i+1].startsWith("--"))throw new Error("Provide "+name);return args[i+1];};
    const url=option("--url"),stateFile=path.resolve(option("--state"));let previous=null;
    try{previous=JSON.parse(await fs.readFile(stateFile,"utf8"));}catch(error){if(error.code!=="ENOENT")throw new Error("Monitor state could not be read.");}
    const result=await check({url,previous});const temp=stateFile+"."+require("node:crypto").randomUUID()+".tmp";
    try{await fs.writeFile(temp,JSON.stringify(result,null,2),{flag:"wx",mode:0o600});await fs.rename(temp,stateFile);}finally{await fs.unlink(temp).catch(()=>{});}
    console.log(JSON.stringify(result));process.exitCode=result.alerted?1:0;
}
if(require.main===module)main().catch(()=>{console.error("Independent status check failed to run. Check the HTTPS URL and writable state-file directory.");process.exitCode=2;});
module.exports={validateUrl,check,main};
