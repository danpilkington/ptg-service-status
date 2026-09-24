"use strict";
const net = require("node:net");
const {execFile} = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const tls = require("node:tls");
const SUPABASE_PROJECTS = new Set(["xlbmpqyjpsnfvbgxsvql", "jgsvzjvfcvvluarborzn"]);
const SUPABASE_SERVICES = new Set(["auth", "db", "db_postgres_user", "pooler", "realtime", "rest", "storage", "pg_bouncer"]);
const SUPABASE_HEALTHY_VALUES = new Set(["ok", "okay", "available", "healthy", "operational", "passing", "passed", "up"]);
// Include enterprise CAs already trusted by Windows; retain normal TLS verification.
const apiTrustedCAs = typeof tls.getCACertificates === "function" ? [...new Set([...tls.getCACertificates("default"), ...tls.getCACertificates("system")])] : undefined;
function number(ip) { return ip.split(".").reduce((n,v)=>(n*256+Number(v))>>>0,0); }
function allowed(ip) {
    if (net.isIP(ip)!==4) return false;
    const ranges=(process.env.MONITOR_ALLOWED_CIDRS || "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16").split(",");
    return ranges.some(raw=>{
        const [base,bits]=raw.trim().split("/"), prefix=Number(bits);
        if(net.isIP(base)!==4 || bits===undefined || !Number.isInteger(prefix) || prefix<0 || prefix>32) return false;
        const mask=prefix===0?0:(0xffffffff << (32-prefix))>>>0;
        return (number(ip)&mask)===(number(base)&mask);
    }) && !/^(0|127|169\.254|22[4-9]|23\d|24\d|25[0-5])\./.test(ip);
}
function validate(config) {
    if(config==null) return null;
    if(config.type==="supabase"){
        if(!SUPABASE_PROJECTS.has(config.projectRef)||!Array.isArray(config.services)||!config.services.length||config.services.length>SUPABASE_SERVICES.size||config.services.some(service=>typeof service!=="string"||!SUPABASE_SERVICES.has(service))||new Set(config.services).size!==config.services.length||![30,60,300].includes(config.interval)||typeof config.paused!=="boolean")
            throw new Error("Supabase checks need a supported project, one or more valid services, and a 30/60/300-second interval.");
        return {type:"supabase",projectRef:config.projectRef,services:[...config.services],interval:config.interval,paused:config.paused};
    }
    if(config.type==="http"){
        let url;try{url=new URL(config.target);}catch{throw new Error("Enter a valid HTTP/HTTPS URL.");}
        if(!["http:","https:"].includes(url.protocol)||url.username||url.password||url.hash||url.search||config.target.length>2048)throw new Error("Use an HTTP/HTTPS URL without embedded credentials, query parameters or fragments.");
        if(net.isIP(url.hostname)&&!allowed(url.hostname))throw new Error("API target is outside the allowed networks.");
        for(const value of [config.apiKey,config.authorization])if(value!==undefined&&(typeof value!=="string"||value.length>8192||/[\r\n]/.test(value)))throw new Error("Invalid API credential header.");
        if((config.apiKey||config.authorization||config.hasApiKey||config.hasAuthorization)&&url.protocol!=="https:")throw new Error("Authenticated API checks require HTTPS.");
        if(config.method!==undefined&&!["GET","POST"].includes(config.method))throw new Error("API method must be GET or POST.");
        if(![30,60,300].includes(config.interval)||typeof config.paused!=="boolean"||typeof(config.expectedText??"")!=="string"||(config.expectedText||"").length>500)throw new Error("Check the API interval and expected response text.");
        return {type:"http",target:url.href,interval:config.interval,paused:config.paused,expectedText:config.expectedText||"",...(config.method?{method:config.method}:{}),...(config.secret?{secret:config.secret,hasApiKey:!!config.hasApiKey,hasAuthorization:!!config.hasAuthorization}:{apiKey:config.apiKey||"",authorization:config.authorization||""})};
    }
    if(!["ping","tcp"].includes(config.type) || !allowed(config.target) ||
        ![30,60,300].includes(config.interval) || typeof config.paused!=="boolean" ||
        (config.type==="tcp" && (!Number.isInteger(config.port)||config.port<1||config.port>65535)))
        throw new Error("Health checks need an allowed internal IPv4 address, Ping or TCP, a 30/60/300-second interval, and a TCP port from 1 to 65535.");
    return {type:config.type,target:config.target,interval:config.interval,paused:config.paused,...(config.type==="tcp"?{port:config.port}:{})};
}
function probe(config) {
    if(config.type==="supabase") return probeSupabase(config);
    if(config.type==="http") return probeApi(config);
    const start=Date.now();
    return new Promise(resolve=>{
        const finish=(ok,message)=>resolve({ok,message,latencyMs:ok?Date.now()-start:null});
        if(config.type==="tcp"){
            const socket=net.createConnection({host:config.target,port:config.port});
            let finished=false;
            const done=(ok,message)=>{if(finished)return;finished=true;socket.destroy();finish(ok,message);};
            socket.setTimeout(3000);
            socket.once("connect",()=>done(true,"TCP connection accepted"));
            socket.once("timeout",()=>done(false,"Connection timed out"));
            socket.once("error",()=>done(false,"Connection refused or unreachable"));
        } else {
            const windows=process.platform==="win32";
            const executable=windows?path.join(process.env.SystemRoot||"C:\\Windows","System32","PING.EXE"):"ping";
            const args=windows?["-4","-n","1","-w","3000",config.target]:["-n","-c","1","-W","3",config.target];
            execFile(executable,args,{timeout:4500,windowsHide:true,maxBuffer:16384},(error,stdout)=>{
                const ok=!error&&(!windows||/TTL=\d+/i.test(stdout));
                finish(ok,ok?"Ping reply received":error?.code==="ENOENT"?"Ping utility unavailable":"No ping reply (device offline or ICMP blocked)");
            });
        }
    });
}

function supabaseServicesHealthy(body, services) {
    if(Array.isArray(body)){
        const reported=new Map(body.filter(item=>item&&typeof item.name==="string").map(item=>[item.name,item]));
        return services.every(service=>{
            const item=reported.get(service);
            return !!item&&(item.healthy===true||SUPABASE_HEALTHY_VALUES.has(String(item.status||"").replace(/^ACTIVE_/i,"").toLowerCase()));
        });
    }
    return services.every(service=>{
        const value=body?.[service] ?? body?.services?.[service];
        if(typeof value === "boolean") return value;
        if(typeof value === "string") return SUPABASE_HEALTHY_VALUES.has(value.trim().toLowerCase());
        if(value && typeof value === "object") return supabaseServicesHealthy(value,["status"]);
        return false;
    });
}

async function probeSupabase(config) {
    const started=Date.now();
    try {
        config=validate(config);
        const token=process.env.SUPABASE_ACCESS_TOKEN;
        if(!token||typeof token!=="string"||token.length>8192||/[\r\n]/.test(token)) return {ok:false,message:"Supabase access token is not configured",latencyMs:null};
        const params=new URLSearchParams();
        params.set("services",config.services.join(","));
        const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
        let response;
        try {
            response=await fetch(`https://api.supabase.com/v1/projects/${config.projectRef}/health?${params}`,{headers:{Accept:"application/json",Authorization:`Bearer ${token}`},redirect:"manual",signal:controller.signal});
        } finally { clearTimeout(timer); }
        const responseText=await response.text();
        if(response.status<200||response.status>=300){
            let detail="";try{const errorBody=JSON.parse(responseText);detail=errorBody.message||errorBody.error||errorBody.error_description||"";}catch{}
            return {ok:false,message:"Supabase health API returned HTTP "+response.status+(detail?": "+String(detail).slice(0,300):""),latencyMs:null};
        }
        let body;try{body=JSON.parse(responseText);}catch{return {ok:false,message:"Supabase health API returned invalid JSON",latencyMs:null};}
        const ok=supabaseServicesHealthy(body,config.services);
        return {ok,message:ok?"Supabase services are healthy":"One or more Supabase services are unhealthy",latencyMs:ok?Date.now()-started:null};
    } catch(error) {
        return {ok:false,message:error?.name==="AbortError"?"Supabase health check timed out":"Supabase health check failed",latencyMs:null};
    }
}

async function probeApi(config) {
    const started=Date.now();
    try {
        config=validate(config);
        const url=new URL(config.target);
        let dnsTimer,addresses;
        try {addresses=await Promise.race([require("node:dns").promises.lookup(url.hostname,{all:true,family:4}),new Promise((resolve,reject)=>{dnsTimer=setTimeout(()=>reject(new Error("DNS timeout")),4000);})]);}finally{clearTimeout(dnsTimer);}
        if(!addresses.length||addresses.some(a=>!allowed(a.address)))return {ok:false,message:"API host is outside the allowed networks",latencyMs:null};
        const address=addresses[0].address;
        return await new Promise(resolve=>{
            let finished=false,request,timer;
            const done=(ok,message)=>{if(finished)return;finished=true;clearTimeout(timer);request?.destroy();resolve({ok,message,latencyMs:ok?Date.now()-started:null});};
            const headers={Accept:"application/json"};
            if(config.method==="POST"){headers["Content-Type"]="application/json";headers["Content-Length"]=2;}
            if(config.apiKey)headers["X-API-Key"]=config.apiKey;
            if(config.authorization)headers.Authorization=config.authorization;
            request=require(url.protocol==="https:"?"node:https":"node:http").request(url,{
                method:config.method||"GET",headers,agent:false,
                ...(url.protocol==="https:" && apiTrustedCAs ? {ca:apiTrustedCAs} : {}),
                lookup:(hostname,options,callback)=>options?.all?callback(null,[{address,family:4}]):callback(null,address,4)
            },response=>{
                if(response.statusCode<200||response.statusCode>=300){response.resume();return done(false,"API returned HTTP "+response.statusCode);}
                const chunks=[];let size=0;
                response.on("data",chunk=>{size+=chunk.length;if(size>65536)return done(false,"API response exceeds 64 KB");chunks.push(chunk);});
                response.on("error",()=>done(false,"API response interrupted"));
                response.on("end",()=>{const ok=!config.expectedText||Buffer.concat(chunks).toString("utf8").includes(config.expectedText);done(ok,ok?"API health check passed":"API response did not contain expected text");});
            });
            timer=setTimeout(()=>done(false,"API request timed out"),5000);
            request.on("error",error=>done(false,["UNABLE_TO_GET_ISSUER_CERT_LOCALLY","UNABLE_TO_VERIFY_LEAF_SIGNATURE","SELF_SIGNED_CERT_IN_CHAIN","DEPTH_ZERO_SELF_SIGNED_CERT"].includes(error.code) ? "API certificate issuer is not trusted by the server" : error.code==="CERT_HAS_EXPIRED" ? "API TLS certificate has expired" : error.code==="ERR_TLS_CERT_ALTNAME_INVALID" ? "API hostname does not match its TLS certificate" : "API connection failed ("+(error.code||"network error")+")"));
            request.end(config.method==="POST"?"{}":undefined);
        });
    } catch {return {ok:false,message:"API target could not be resolved or validated",latencyMs:null};}
}
function redact(data) {
    return {...data,services:(data.services||[]).map(service=>{
        if(service.monitor?.type!=="http")return service;
        const {apiKey,authorization,secret,...monitor}=service.monitor;
        return {...service,monitor:{...monitor,hasApiKey:!!(apiKey||monitor.hasApiKey),hasAuthorization:!!(authorization||monitor.hasAuthorization)}};
    })};
}

function advance(previous,result,now) {
    const failures=result.ok?0:(previous?.failures||0)+1;
    const successes=result.ok?(previous?.successes||0)+1:0;
    let status=previous?.status||"unknown";
    if(failures>=3)status="outage";
    if(successes>=2)status="operational";
    return {...result,failures,successes,status,checkedAt:new Date(now).toISOString()};
}
function createMonitor(statusFile, check=probe, storage=null) {
    const states=new Map();let running=false,timer;
    async function tick() {
        if(running)return;running=true;
        try {
            const data=JSON.parse(storage ? await storage.read("status") : await fs.readFile(statusFile,"utf8"));
            const services=data.services||[];
            const jobs=[];
            for(const s of services) {
                let config;
                try{config=validate(s.monitor);}catch{states.delete(s.id);continue;}
                if(!config||config.paused){states.delete(s.id);continue;}
                const signature=JSON.stringify(config),old=states.get(s.id);
                if(old?.signature!==signature)states.delete(s.id);
                const state=states.get(s.id);
                if(!state||Date.now()-Date.parse(state.checkedAt)>=config.interval*1000)jobs.push({id:s.id,config,signature});
            }
            for(const id of states.keys())if(!services.some(s=>s.id===id))states.delete(id);
            let cursor=0;
            await Promise.all(Array.from({length:Math.min(4,jobs.length)},async()=>{
                while(cursor<jobs.length){
                    const job=jobs[cursor++];let result;
                    try{result=await check(job.config.type==="http"?{...job.config,...await require("./monitor-secrets").open(job.config),secret:undefined}:job.config);}catch{result={ok:false,message:"Health check could not complete",latencyMs:null};}
                    states.set(job.id,{...advance(states.get(job.id),result,Date.now()),signature:job.signature});
                }
            }));
        } catch(error){console.error("Health monitor could not read its configuration:",error.message);}
        finally{running=false;}
    }
    function result(service) {
        const state=states.get(service.id);
        if(!state||state.signature!==JSON.stringify(service.monitor))return null;
        const {signature,...safe}=state;
        return {...safe,stale:Date.now()-Date.parse(state.checkedAt)>Math.max(service.monitor.interval*2500,90000)};
    }
    return {
        tick,
        start(){if(!timer){void tick();timer=setInterval(()=>void tick(),5000);timer.unref();}},
        stop(){clearInterval(timer);timer=null;},
        details(services){return Object.fromEntries(services.map(s=>[s.id,result(s)]));},
        publicServices(services){return services.map(s=>{
            const {monitor,...publicService}=s;
            if(!monitor||monitor.paused)return publicService;
            let valid=true;try{validate(monitor);}catch{valid=false;}
            const current=valid?result(s):null;
            const status=current&&!current.stale?current.status:"unknown";
            return {...publicService,status,statusText:status==="operational"?"Operational":status==="outage"?"Health check failed":"Awaiting health checks",
                healthCheck:{checkedAt:current?.checkedAt||null,status}};
        });}
    };
}
module.exports={allowed,validate,probe,probeApi,probeSupabase,supabaseServicesHealthy,redact,advance,createMonitor};
