"use strict";
const {ClientSecretCredential}=require("@azure/identity");
const {revision}=require("./storage"),{commit,update}=require("./governance");
const guid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const instances=new WeakMap();
function settings(data){const s=data.microsoftAdmin||{};return {groupAccess:!!s.groupAccess,requireAccount:false,mfaEnabled:!!s.mfaEnabled,adminGroupId:s.adminGroupId||"",editorGroupId:s.editorGroupId||"",devicesEnabled:!!s.devicesEnabled,staleDays:Number.isInteger(s.staleDays)?s.staleDays:7};}
function validate(input){
    if(!input||typeof input.groupAccess!=="boolean"||typeof input.devicesEnabled!=="boolean"||!Number.isInteger(input.staleDays)||input.staleDays<1||input.staleDays>90)throw Error("Enter valid Microsoft controls and a last check-in threshold from 1 to 90 days.");
    const result={...input};for(const key of ["adminGroupId","editorGroupId"]){if(typeof input[key]!=="string"||(input[key]&&!guid.test(input[key])))throw Error("Enter valid Entra group Object IDs.");result[key]=input[key].toLowerCase();}
    if(result.groupAccess&&!result.adminGroupId)throw Error("Configure an administrator group before enabling group access.");
    if(result.adminGroupId&&result.adminGroupId===result.editorGroupId)throw Error("Use different groups for administrator and editor access.");
    return settings({microsoftAdmin:result});
}
function summarize(devices,staleDays,now=Date.now()){
    const counts={total:devices.length,compliant:0,noncompliant:0,other:0,stale:0,neverCheckedIn:0},states=Object.create(null),platforms=Object.create(null);
    for(const d of devices){const state=d.complianceState||"unknown";states[state]=(states[state]||0)+1;const os=d.operatingSystem||"Unknown";platforms[os]=(platforms[os]||0)+1;
        if(state==="compliant")counts.compliant++;else if(state==="noncompliant")counts.noncompliant++;else counts.other++;
        const stamp=Date.parse(d.lastSyncDateTime);if(!Number.isFinite(stamp)||stamp<=Date.UTC(1970,0,2))counts.neverCheckedIn++;else if(stamp<now-staleDays*86400000)counts.stale++;
    }return {counts,states,platforms,staleDays,checkedAt:new Date(now).toISOString()};
}
function summarizeMfa(rows,now=Date.now()){
 const counts={total:rows.length,registered:0,notRegistered:0,unknown:0,capable:0,passwordless:0,ssprRegistered:0,admins:0,adminsNotRegistered:0},methods=Object.create(null);
 for(const r of rows){if(r.isMfaRegistered===true)counts.registered++;else if(r.isMfaRegistered===false)counts.notRegistered++;else counts.unknown++;if(r.isMfaCapable===true)counts.capable++;if(r.isPasswordlessCapable===true)counts.passwordless++;if(r.isSsprRegistered===true)counts.ssprRegistered++;if(r.isAdmin===true){counts.admins++;if(r.isMfaRegistered===false)counts.adminsNotRegistered++;}for(const m of new Set(Array.isArray(r.methodsRegistered)?r.methodsRegistered:[]))methods[m]=(methods[m]||0)+1;}
 return {counts,methods,checkedAt:new Date(now).toISOString()};
}
function create(storage,{env=process.env,request=global.fetch,clock=Date.now,credential}={}){
    const ready=!!(env.AZURE_TENANT_ID&&env.AZURE_CLIENT_ID&&env.AZURE_CLIENT_SECRET);
    if(!credential&&ready)credential=new ClientSecretCredential(env.AZURE_TENANT_ID,env.AZURE_CLIENT_ID,env.AZURE_CLIENT_SECRET);
    const members=new Map();let last=null,lastThreshold=null,nextDeviceAttempt=0,deviceJob=null,lastFailed=false;
    async function graph(url,body){
        const target=new URL(url,"https://graph.microsoft.com");if(target.origin!=="https://graph.microsoft.com"||!target.pathname.startsWith("/v1.0/"))throw Error("Invalid Graph continuation.");
        if(!credential)throw Error("Configure the existing Azure tenant credentials on the server.");
        const token=await credential.getToken("https://graph.microsoft.com/.default");
        const response=await request(target.href,{method:body?"POST":"GET",headers:{Authorization:"Bearer "+token.token,...(body?{"Content-Type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
        if(!response.ok){const e=Error(response.status===403?"Microsoft Graph access was denied. Check application permissions, admin consent and Intune licensing.":"Microsoft Graph is temporarily unavailable. Check credentials and connectivity.");e.status=503;throw e;}return response.json();
    }
    async function config(){return settings(JSON.parse(await storage.read("status")));}
    async function role(oid,policy){
        if(!guid.test(oid))return null;
        const key=oid+":"+policy.adminGroupId+":"+policy.editorGroupId,cached=members.get(key);
        if(cached&&cached.expires>clock())return cached.role;
        const result=await graph("/v1.0/users/"+oid+"/checkMemberGroups",{groupIds:[policy.adminGroupId,policy.editorGroupId].filter(Boolean)});
        if(!Array.isArray(result.value))throw Error("Microsoft returned an invalid group response.");
        const ids=result.value.map(id=>String(id).toLowerCase()),resolved=ids.includes(policy.adminGroupId)?"admin":policy.editorGroupId&&ids.includes(policy.editorGroupId)?"editor":null;
        for(const [id,item]of members)if(item.expires<=clock())members.delete(id);
        if(members.size>10000)members.clear();members.set(key,{role:resolved,expires:clock()+60000});return resolved;
    }
    const profiles=new Map();
    async function profile(oid){
        const cached=profiles.get(oid);if(cached&&cached.expires>clock())return cached.value;
        let value={jobTitle:""},ttl=60000;
        try{const result=await graph("/v1.0/users/"+oid+"?$select=displayName,jobTitle");value={jobTitle:typeof result.jobTitle==="string"?result.jobTitle.trim().slice(0,160):""};ttl=300000;}catch{/* Profile enrichment never grants or blocks access. */}
        for(const [id,p]of profiles)if(p.expires<=clock())profiles.delete(id);if(profiles.size>10000)profiles.clear();profiles.set(oid,{value,expires:clock()+ttl});return value;
    }
    async function resolve(users,claims,tenant){
        if(claims.tid!==tenant||!guid.test(claims.oid||""))return null;
        const policy=await config();if(!policy.groupAccess)return null;
        const access=await role(claims.oid.toLowerCase(),policy);if(!access)return null;
        const info=await profile(claims.oid.toLowerCase());
        return {...({id:"entra:"+claims.oid.toLowerCase(),username:claims.oid.toLowerCase(),firstName:String(claims.name||"Microsoft user").slice(0,100),lastName:"",jobTitle:info.jobTitle,active:true,entraObjectId:claims.oid.toLowerCase()}),role:access,groupManaged:true,access:{groupId:access==="admin"?policy.adminGroupId:policy.editorGroupId,verifiedAt:new Date(members.get(claims.oid.toLowerCase()+":"+policy.adminGroupId+":"+policy.editorGroupId)?.expires-60000||clock()).toISOString()}};
    }
    let deviceRows=[],mfaRows=[];
    async function trend(kind,summary){
        if(!storage.write)return;
        await require("./governance").serial(storage,async()=>{
            const raw=await storage.read("insights"),value=JSON.parse(raw||"{}");const day=summary.checkedAt.slice(0,10);
            value[kind]=[...(value[kind]||[]).filter(r=>r.day!==day&&r.day>=new Date(clock()-365*86400000).toISOString().slice(0,10)),{day,checkedAt:summary.checkedAt,counts:summary.counts}].sort((a,b)=>a.day.localeCompare(b.day));
            await storage.write("insights",JSON.stringify(value),revision(raw));
        }).catch(()=>{});
    }
    async function devices(){
        const policy=await config();if(!policy.devicesEnabled)return {enabled:false,message:"Enable the device compliance overview in Microsoft controls."};
        if(nextDeviceAttempt>clock()&&lastThreshold===policy.staleDays)return {enabled:true,available:!!last,stale:lastFailed,...(last||{}),message:lastFailed?"The latest device refresh failed. Showing the last successful snapshot.":""};
        if(!deviceJob)deviceJob=(async()=>{
            nextDeviceAttempt=clock()+300000;lastThreshold=policy.staleDays;
            try{let url="/v1.0/deviceManagement/managedDevices?$select=id,deviceName,operatingSystem,complianceState,lastSyncDateTime&$top=999",all=[],pages=0;const seen=new Set();
                while(url){if(++pages>100||seen.has(url)||all.length>100000)throw Error("The device overview exceeded its safe paging limit.");seen.add(url);const data=await graph(url);if(!Array.isArray(data.value))throw Error("Invalid device response.");all.push(...data.value);url=data["@odata.nextLink"];}
                deviceRows=[...new Map(all.map(d=>[d.id,d])).values()].map(d=>({id:d.id,name:d.deviceName||d.id,operatingSystem:d.operatingSystem||"Unknown",complianceState:d.complianceState||"unknown",lastSyncDateTime:d.lastSyncDateTime||null}));last=summarize(deviceRows,policy.staleDays,clock());lastFailed=false;await trend("devices",last);
            }catch{lastFailed=true;nextDeviceAttempt=clock()+60000;}
            return {enabled:true,available:!!last,stale:lastFailed,...(last||{}),message:lastFailed?(last?"The latest device refresh failed. Showing the last successful snapshot.":"Device data is unavailable. Check DeviceManagementManagedDevices.Read.All application permission, admin consent, Azure credentials and Intune licensing."):""};
        })().finally(()=>{deviceJob=null;});return deviceJob;
    }
    let nextMfaAttempt=0,mfaLast=null,mfaFailed=false,mfaJob=null;
    async function mfa(){
        if(!(await config()).mfaEnabled)return {enabled:false,message:"Enable MFA registration reporting in Microsoft controls."};
        const result=()=>({enabled:true,available:!!mfaLast,stale:mfaFailed,...(mfaLast||{}),message:mfaFailed?(mfaLast?"Latest refresh failed. Showing the last successful MFA snapshot.":"MFA report unavailable. Check AuditLog.Read.All application permission, admin consent and tenant reporting licensing."):""});
        if(nextMfaAttempt>clock())return result();
        if(!mfaJob)mfaJob=(async()=>{nextMfaAttempt=clock()+300000;try{let url="/v1.0/reports/authenticationMethods/userRegistrationDetails",all=[],pages=0;const seen=new Set();while(url){if(++pages>100||seen.has(url)||all.length>100000)throw Error("MFA paging limit exceeded.");seen.add(url);const data=await graph(url);if(!Array.isArray(data.value))throw Error("Invalid MFA report.");all.push(...data.value);url=data["@odata.nextLink"];}mfaRows=[...new Map(all.map(r=>[r.id,r])).values()].map(r=>({id:r.id,name:r.userDisplayName||r.id,username:r.userPrincipalName||"",registered:r.isMfaRegistered===true?true:r.isMfaRegistered===false?false:null,capable:r.isMfaCapable===true,passwordless:r.isPasswordlessCapable===true,methods:Array.isArray(r.methodsRegistered)?r.methodsRegistered:[],...r}));mfaLast=summarizeMfa(mfaRows,clock());mfaFailed=false;await trend("mfa",mfaLast);}catch{mfaFailed=true;nextMfaAttempt=clock()+60000;}return result();})().finally(()=>{mfaJob=null;});return mfaJob;
    }
    function attach(app){const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next),admin=(req,res,next)=>req.adminUser.role==="admin"?next():res.status(403).json({error:"Administrator access required."});
        app.get("/api/admin/microsoft-controls",admin,wrap(async(req,res)=>{const raw=await storage.read("status");res.json({settings:settings(JSON.parse(raw)),revision:revision(raw),credentialsReady:ready});}));
        app.put("/api/admin/microsoft-controls",admin,wrap(async(req,res)=>{
            let value;try{value=validate(req.body.settings);}catch(e){return res.status(400).json({error:e.message});}
            const raw=await storage.read("status");if(req.body.revision!==revision(raw))return res.status(409).json({error:"Published data changed. Reload Microsoft controls and retry."});
            if(value.groupAccess){if(env.ADMIN_SSO_ENABLED!=="true")return res.status(400).json({error:"Enable Microsoft SSO on the server before enabling group access."});for(const id of [value.adminGroupId,value.editorGroupId].filter(Boolean)){const group=await graph("/v1.0/groups/"+id+"?$select=id,securityEnabled");if(group.id?.toLowerCase()!==id||group.securityEnabled!==true)return res.status(400).json({error:"Choose existing Entra security groups. Synced AD security groups are supported."});}}
            const data=JSON.parse(raw);data.microsoftAdmin=value;
            await commit(storage,[update("status",raw,data)],req.adminUser,"microsoft.controls","admin",JSON.stringify(value));members.clear();nextDeviceAttempt=0;nextMfaAttempt=0;
            res.json({settings:value,revision:revision(JSON.stringify(data,null,2)+"\n"),credentialsReady:ready});
        }));
        app.get("/api/admin/security-trends",admin,wrap(async(req,res)=>res.json(JSON.parse(await storage.read("insights")||"{}"))));
        for(const kind of ["devices","mfa"])app.get("/api/admin/"+kind+"-details",admin,wrap(async(req,res)=>{
            const snapshot=await(kind==="devices"?devices():mfa());if(!snapshot.enabled||!snapshot.available)return res.json({...snapshot,items:[],total:0});
            const query=String(req.query.search||"").toLowerCase().slice(0,200),filter=String(req.query.filter||"all");
            let rows=(kind==="devices"?deviceRows:mfaRows.map(r=>({id:r.id,name:r.name,username:r.username,registered:r.registered,capable:r.capable,passwordless:r.passwordless,methods:r.methods}))).filter(r=>JSON.stringify(r).toLowerCase().includes(query));
            if(filter!=="all")rows=rows.filter(r=>kind==="devices"?(filter==="stale"?Number.isFinite(Date.parse(r.lastSyncDateTime))&&Date.parse(r.lastSyncDateTime)>Date.UTC(1970,0,2)&&Date.parse(r.lastSyncDateTime)<clock()-(snapshot.staleDays||7)*86400000:filter==="never"?!Number.isFinite(Date.parse(r.lastSyncDateTime))||Date.parse(r.lastSyncDateTime)<=Date.UTC(1970,0,2):r.complianceState===filter):(filter==="missing"?r.registered===false:filter==="registered"?r.registered===true:r.registered===null));
            if(req.query.download==="csv"){
                const fields=kind==="devices"?["name","operatingSystem","complianceState","lastSyncDateTime"]:["name","username","registered","capable","passwordless","methods"];
                const cell=v=>'"'+String(Array.isArray(v)?v.join("; "):v??"").replace(/^[\t\r\n ]*[=+@-]/,"'$&").replace(/"/g,'""')+'"';
                res.set("Content-Disposition",'attachment; filename="'+kind+'-details.csv"').type("text/csv").send([fields.join(","),...rows.map(r=>fields.map(f=>cell(r[f])).join(","))].join("\r\n"));return;
            }
            const offset=Math.max(0,Number(req.query.offset)||0);res.json({available:true,stale:snapshot.stale,checkedAt:snapshot.checkedAt,items:rows.slice(offset,offset+50),total:rows.length,offset});
        }));
        app.get("/api/admin/mfa-registration",admin,wrap(async(req,res)=>res.json(await mfa())));
        app.get("/api/admin/device-compliance",admin,wrap(async(req,res)=>res.json(await devices())));
    }
    return {resolve,role,devices,mfa,attach,config};
}
function forStorage(storage){if(!instances.has(storage))instances.set(storage,create(storage));return instances.get(storage);}
module.exports={create,forStorage,settings,validate,summarize,summarizeMfa};
