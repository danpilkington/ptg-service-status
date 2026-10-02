"use strict";
const {execFile}=require("node:child_process");
const path=require("node:path");
function protect(value, decrypt=false) {
    if(process.platform!=="win32")return Promise.reject(new Error("API credential storage requires Windows DPAPI."));
    const operation=decrypt?"Unprotect":"Protect";
    const script="$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $result=[Security.Cryptography.ProtectedData]::"+operation+"($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))";
    return new Promise((resolve,reject)=>{
        const child=execFile(path.join(process.env.SystemRoot||"C:\\Windows","System32","WindowsPowerShell","v1.0","powershell.exe"),["-NoProfile","-NonInteractive","-Command",script],{windowsHide:true,timeout:10000,maxBuffer:65536},(error,out)=>{
            if(error)return reject(new Error("Windows could not protect or unlock the API credentials under the current server account."));
            resolve(out.trim());
        });
        child.stdin.on("error",()=>{});
        child.stdin.end(value);
    });
}
async function open(config) {
    if(!config?.secret)return {apiKey:config?.apiKey||"",authorization:config?.authorization||""};
    return JSON.parse(Buffer.from(await protect(config.secret,true),"base64").toString("utf8"));
}
async function seal(config) {
    const {apiKey="",authorization="",secret,...rest}=config;
    if(!apiKey&&!authorization)return {...rest,hasApiKey:false,hasAuthorization:false};
    const encrypted=await protect(Buffer.from(JSON.stringify({apiKey,authorization})).toString("base64"));
    return {...rest,secret:encrypted,hasApiKey:!!apiKey,hasAuthorization:!!authorization};
}
module.exports={open,seal};
