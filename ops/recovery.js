"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes, createCipheriv, createDecipheriv, createHash, scryptSync } = require("node:crypto");
const root = path.join(__dirname, "..");
const documents = ["status", "users", "audit", "approvals", "availability", "subscriptions", "reviews", "insights"];
const optionalFiles = { "freshservice-state.json":"FRESHSERVICE_STATE_FILE", "teams-state.json":"TEAMS_STATE_FILE", "microsoft-cache.json":"MICROSOFT_CACHE_FILE" };
const settingsFiles = [".env", "package.json", "package-lock.json", "web.config", "start-pm2.cmd"];
const allowedNames = new Set([...documents.map(n=>"documents/"+n+".json"),...Object.keys(optionalFiles).map(n=>"state/"+n),...settingsFiles.map(n=>"configuration/"+n),"configuration/runtime.json"]);
const magic = Buffer.from("PTGBACK1"), maxBytes = 100 * 1024 * 1024;
const digest = content => createHash("sha256").update(content).digest("hex");
function key(password, salt) {
    if (typeof password !== "string" || password.length < 16 || password.length > 1024) throw new Error("Set PTG_BACKUP_PASSWORD to a separate backup passphrase of 16–1024 characters.");
    return scryptSync(password, salt, 32, { N:32768, r:8, p:1, maxmem:64*1024*1024 });
}
function encrypt(bundle, password) {
    const salt=randomBytes(16),iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key(password,salt),iv);
    cipher.setAAD(magic);
    const data=Buffer.concat([cipher.update(JSON.stringify(bundle),"utf8"),cipher.final()]);
    if(data.length>maxBytes)throw new Error("Backup exceeds the 100 MB limit.");
    return Buffer.concat([magic,salt,iv,cipher.getAuthTag(),data]);
}
function validate(bundle) {
    if(!bundle||![1,2,3,4].includes(bundle.version)||!["file","sql"].includes(bundle.storage)||!Number.isFinite(Date.parse(bundle.createdAt))||!Array.isArray(bundle.files)||bundle.files.length>allowedNames.size)throw new Error("Invalid backup manifest.");
    const seen=new Set();
    for(const file of bundle.files){
        if(!file||!allowedNames.has(file.name)||seen.has(file.name)||typeof file.content!=="string"||file.sha256!==digest(file.content))throw new Error("Backup file integrity or manifest validation failed.");
        seen.add(file.name);
        if(file.name.endsWith(".json"))JSON.parse(file.content);
    }
    for(const name of documents.filter(n=>n==="insights"?bundle.version>=4:n==="reviews"?bundle.version>=3:n==="subscriptions"?bundle.version>=2:true))if(!seen.has("documents/"+name+".json"))throw new Error("Backup is missing a required storage document.");
    const status=JSON.parse(bundle.files.find(f=>f.name==="documents/status.json").content);
    if(!status||!Array.isArray(status.services)||!Array.isArray(status.incidents)||!Array.isArray(status.maintenance))throw new Error("Backup status data is invalid.");
    for(const name of ["users","audit","approvals"]){if(!Array.isArray(JSON.parse(bundle.files.find(f=>f.name==="documents/"+name+".json").content)))throw new Error("Backup "+name+" data is invalid.");}
    return bundle;
}
function decrypt(data, password) {
    if(!Buffer.isBuffer(data)||data.length<53||data.length>maxBytes+52||!data.subarray(0,8).equals(magic))throw new Error("Unsupported or oversized backup.");
    const derived=key(password,data.subarray(8,24));
    try {
        const cipher=createDecipheriv("aes-256-gcm",derived,data.subarray(24,36));cipher.setAAD(magic);cipher.setAuthTag(data.subarray(36,52));
        return validate(JSON.parse(Buffer.concat([cipher.update(data.subarray(52)),cipher.final()]).toString("utf8")));
    } catch {throw new Error("Backup verification failed: wrong passphrase, damaged archive or invalid manifest.");}
}
async function collect({storage,baseDir=root,env=process.env,siteStopped=false}) {
    if(!siteStopped)throw new Error("Stop the production application before making a complete recovery bundle; pass --site-stopped only after it is stopped.");
    const files=[];
    const add=(name,content)=>files.push({name,content,sha256:digest(content)});
    for(const name of documents){
        const content=await storage.read(name);
        if(name==="status"&&!content)throw new Error("Status storage is missing.");
        add("documents/"+name+".json",content??(name==="availability"?"null":name==="insights"?"{}":"[]"));
    }
    for(const [name,setting] of Object.entries(optionalFiles)){
        try{add("state/"+name,await fs.readFile(env[setting]||path.join(baseDir,name),"utf8"));}
        catch(error){if(error.code!=="ENOENT")throw error;if((name==="teams-state.json"&&env.TEAMS_WEBHOOK_URL)||(name==="freshservice-state.json"&&env.FRESHSERVICE_API_KEY))throw new Error("Enabled integration state is missing; reconcile its history before creating a recovery bundle.");}
    }
    for(const name of settingsFiles){try{add("configuration/"+name,await fs.readFile(path.join(baseDir,name),"utf8"));}catch(error){if(error.code!=="ENOENT")throw error;}}
    const example=await fs.readFile(path.join(baseDir,".env.example"),"utf8").catch(()=>"");
    const names=[...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(m=>m[1]);
    names.push("STATUS_FILE","USERS_FILE","MICROSOFT_CACHE_FILE","MONITOR_ALLOWED_CIDRS");
    add("configuration/runtime.json",JSON.stringify(Object.fromEntries([...new Set(names)].filter(n=>env[n]!==undefined).map(n=>[n,env[n]])),null,2));
    // Confirm no storage or state changed during export. The stopped-site requirement also covers actions in flight.
    for(const name of documents){const current=await storage.read(name);const saved=files.find(f=>f.name==="documents/"+name+".json").content;if((current??(name==="availability"?"null":name==="insights"?"{}":"[]"))!==saved)throw new Error("Storage changed during backup. Stop the application and retry.");}
    for(const [name,setting] of Object.entries(optionalFiles)){
        let current=null;try{current=await fs.readFile(env[setting]||path.join(baseDir,name),"utf8");}catch(error){if(error.code!=="ENOENT")throw error;}
        if(current!==(files.find(f=>f.name==="state/"+name)?.content??null))throw new Error("Notification/cache state changed during backup. Stop the application and retry.");
    }
    return validate({version:4,createdAt:new Date().toISOString(),storage:storage.kind,files});
}
async function readArchive(file,password){const stat=await fs.stat(file);if(stat.size>maxBytes+52)throw new Error("Backup exceeds the 100 MB limit.");return decrypt(await fs.readFile(file),password);}
function summary(bundle){
    const get=name=>JSON.parse(bundle.files.find(f=>f.name==="documents/"+name+".json").content);
    return {createdAt:bundle.createdAt,storage:bundle.storage,files:bundle.files.length,services:get("status").services.length,incidents:get("status").incidents.length,users:get("users").length,auditEntries:get("audit").length};
}
async function stage(bundle,target){
    validate(bundle);const resolved=path.resolve(target);
    // Require a new directory so extraction never overwrites an existing recovery set.
    await fs.mkdir(resolved,{recursive:false,mode:0o700});
    for(const file of bundle.files){
        const dest=path.resolve(resolved,...file.name.split("/"));
        if(!dest.startsWith(resolved+path.sep))throw new Error("Unsafe restore path.");
        await fs.mkdir(path.dirname(dest),{recursive:true,mode:0o700});await fs.writeFile(dest,file.content,{flag:"wx",mode:0o600});
    }
    await fs.writeFile(path.join(resolved,"manifest.json"),JSON.stringify({...summary(bundle),hashes:bundle.files.map(({name,sha256})=>({name,sha256}))},null,2),{flag:"wx",mode:0o600});
    return summary(bundle);
}
async function main(args=process.argv.slice(2)){
    const command=args[0],option=name=>{const i=args.indexOf(name);if(i<0||!args[i+1]||args[i+1].startsWith("--"))throw new Error("Provide "+name+" and its value.");return args[i+1];};
    if(!["backup","verify","stage"].includes(command))throw new Error("Use backup --site-stopped --output FILE, verify --input FILE, or stage --input FILE --target NEW_DIRECTORY. Set PTG_BACKUP_PASSWORD separately.");
    const password=process.env.PTG_BACKUP_PASSWORD;
    key(password,Buffer.alloc(16));
    if(command!=="backup"){
        const bundle=await readArchive(option("--input"),password);
        console.log(JSON.stringify(command==="stage"?await stage(bundle,option("--target")):summary(bundle),null,2));return;
    }
    if(!args.includes("--site-stopped"))throw new Error("Stop the application first and pass --site-stopped.");
    const output=path.resolve(option("--output"));
    require("dotenv").config({path:path.join(root,".env")});
    const storage=require("../src/storage").createStorage({statusFile:process.env.STATUS_FILE||path.join(root,"status.json")});
    try{
        const bundle=await collect({storage,siteStopped:true});const archive=encrypt(bundle,password);
        // Verify authentication and manifest before creating a backup, and again from disk afterwards.
        decrypt(archive,password);await fs.writeFile(output,archive,{flag:"wx",mode:0o600});await readArchive(output,password);
        console.log(JSON.stringify({verified:true,...summary(bundle)},null,2));
    }finally{await storage.close().catch(()=>{});}
}
if(require.main===module)main().catch(()=>{console.error("Recovery operation failed. Check the command, backup passphrase, storage permissions and destination. Existing data was not overwritten.");process.exitCode=1;});
module.exports={encrypt,decrypt,validate,collect,readArchive,summary,stage,main};
