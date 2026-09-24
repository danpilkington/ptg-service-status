"use strict";
const fs = require("node:fs/promises"), path = require("node:path");
const {randomUUID} = require("node:crypto");
function configuration(env=process.env) {
 const domain=String(env.FRESHSERVICE_DOMAIN||"").trim().toLowerCase(),apiKey=String(env.FRESHSERVICE_API_KEY||"").trim(),requesterEmail=String(env.FRESHSERVICE_REQUESTER_EMAIL||"").trim();
 if(!domain&&!apiKey&&!requesterEmail)return null;
 if(!/^[a-z0-9][a-z0-9-]*$/.test(domain))throw new Error("FRESHSERVICE_DOMAIN must be the Freshservice subdomain only.");
 if(!apiKey&&!requesterEmail)return null;
 if(!apiKey||/[\r\n]/.test(apiKey))throw new Error("FRESHSERVICE_API_KEY is required.");
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(requesterEmail))throw new Error("FRESHSERVICE_REQUESTER_EMAIL must be a valid email address.");
 const priority=Number(env.FRESHSERVICE_PRIORITY||3);if(![1,2,3,4].includes(priority))throw new Error("FRESHSERVICE_PRIORITY must be 1, 2, 3, or 4.");
 const optionalId=name=>{if(!env[name])return undefined;const value=Number(env[name]);if(!Number.isSafeInteger(value)||value<1)throw new Error(name+" must be a positive integer.");return value;};
 const recoveryStatus=Number(env.FRESHSERVICE_RECOVERY_STATUS||11);if(!Number.isSafeInteger(recoveryStatus)||recoveryStatus<1)throw new Error("FRESHSERVICE_RECOVERY_STATUS must be a positive integer.");
 return {domain,apiKey,requesterEmail,priority,recoveryStatus,groupId:optionalId("FRESHSERVICE_GROUP_ID"),workspaceId:optionalId("FRESHSERVICE_WORKSPACE_ID")};
}
function escapeHtml(value){return String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");}
function serviceKey(service){return (service.source||"PTG")+":"+service.id;}
function createFreshserviceNotifier(options={}) {
 const env=options.env||process.env,config=configuration(env),request=options.fetch||globalThis.fetch;
 const stateFile=options.stateFile||env.FRESHSERVICE_STATE_FILE||path.join(__dirname,"freshservice-state.json");let statePromise,queue=Promise.resolve();
 async function loadState(){if(!statePromise)statePromise=fs.readFile(stateFile,"utf8").then(JSON.parse).catch(error=>{if(error.code==="ENOENT")return {version:1,services:{}};throw new Error("Freshservice state could not be read: "+error.message);});return statePromise;}
 async function saveState(state){const temporary=stateFile+"."+randomUUID()+".tmp";await fs.mkdir(path.dirname(stateFile),{recursive:true});try{await fs.writeFile(temporary,JSON.stringify(state,null,2)+"\n",{flag:"wx",mode:0o600});await fs.rename(temporary,stateFile);}finally{await fs.unlink(temporary).catch(()=>{});}}
 async function createTicket(service){
  const name=service.name||service.serviceName||service.id,status=String(service.status||"unknown"),checkedAt=new Date().toISOString();
  const payload={subject:`[AUTO ALERT] ${name}'s status has changed to ${status}`,description:[`<p>The PTG status page detected that <strong>${escapeHtml(name)}</strong> is no longer Operational.</p>`,`<p><strong>Status:</strong> ${escapeHtml(status)}<br>`,`<strong>Detail:</strong> ${escapeHtml(service.statusText||"No additional detail supplied")}<br>`,`<strong>Source:</strong> ${escapeHtml(service.source||"PTG")}<br>`,`<strong>Detected:</strong> ${escapeHtml(checkedAt)}</p>`,"<p>This ticket was created automatically by the PTG service status application.</p>"].join(""),email:config.requesterEmail,status:2,priority:config.priority,source:2,tags:["status-page","automated-monitoring"],...(config.groupId?{group_id:config.groupId}:{}),...(config.workspaceId?{workspace_id:config.workspaceId}:{})};
  const response=await request(`https://${config.domain}.freshservice.com/api/v2/tickets`,{method:"POST",headers:{Authorization:`Basic ${Buffer.from(config.apiKey+":X").toString("base64")}`,Accept:"application/json","Content-Type":"application/json"},body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)}),body=await response.text();
  if(!response.ok)throw new Error(`Freshservice returned HTTP ${response.status}: ${body.slice(0,300)}`);let parsed;try{parsed=JSON.parse(body);}catch{throw new Error("Freshservice returned invalid JSON.");}if(!parsed.ticket?.id)throw new Error("Freshservice did not return a ticket ID.");return {id:parsed.ticket.id,createdAt:checkedAt};
 }
 async function updateTicket(ticketId,pathSuffix,method,payload){
  const response=await request(`https://${config.domain}.freshservice.com/api/v2/tickets/${ticketId}${pathSuffix}`,{method,headers:{Authorization:`Basic ${Buffer.from(config.apiKey+":X").toString("base64")}`,Accept:"application/json","Content-Type":"application/json"},body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)}),body=await response.text();
  if(!response.ok)throw new Error(`Freshservice returned HTTP ${response.status}: ${body.slice(0,300)}`);
 }
 async function addRecoveryNote(ticketId,service,recoveredAt){
  const name=service.name||service.serviceName||service.id;
  await updateTicket(ticketId,"/notes","POST",{private:true,body:`<p><strong>${escapeHtml(name)}</strong> returned to Operational at ${escapeHtml(recoveredAt)}.</p><p>The PTG status page detected this recovery automatically. Please verify normal service before closing this incident.</p>`});
 }
 async function setRecoveryStatus(ticketId){await updateTicket(ticketId,"","PUT",{status:config.recoveryStatus});}
 async function run(services){
  if(!config)return {enabled:false,created:[],recovered:[]};const state=await loadState();if(!state.services||typeof state.services!=="object")state.services={};const currentKeys=new Set(services.map(serviceKey));let changed=false;
  for(const [key,previous] of Object.entries(state.services))if(!currentKeys.has(key)&&previous.active){state.services[key]={...previous,active:false,status:"absent"};changed=true;}
  if(changed)await saveState(state);const recovered=[];
  for(const service of services){
   if(service.status!=="operational")continue;const key=serviceKey(service),previous=state.services[key];
   if(previous?.active&&previous.ticketId){
    const recoveredAt=previous.recoveredAt||new Date().toISOString();let current=previous;
    if(!current.recoveryNoteAdded){await addRecoveryNote(current.ticketId,service,recoveredAt);current={...current,status:"recovering",recoveredAt,recoveryNoteAdded:true};state.services[key]=current;await saveState(state);}
    await setRecoveryStatus(current.ticketId);state.services[key]={...current,active:false,status:"operational",recoveryStatus:config.recoveryStatus,recoveryCompletedAt:new Date().toISOString()};await saveState(state);recovered.push({serviceId:service.id,ticketId:current.ticketId});
   }else if(previous?.active||previous?.status!=="operational"){state.services[key]={...previous,active:false,status:"operational",recoveredAt:new Date().toISOString()};await saveState(state);}
  }
  const created=[];
  for(const service of services){if(service.status==="operational"||service.status==="unknown")continue;const key=serviceKey(service);if(state.services[key]?.active)continue;const ticket=await createTicket(service);state.services[key]={active:true,status:String(service.status),ticketId:ticket.id,createdAt:ticket.createdAt};await saveState(state);created.push({serviceId:service.id,ticketId:ticket.id});}
  return {enabled:true,created,recovered};
 }
 return {enabled:!!config,reconcile(services){const operation=queue.then(()=>run(Array.isArray(services)?services:[]));queue=operation.catch(()=>{});return operation;}};
}
module.exports={configuration,createFreshserviceNotifier};
