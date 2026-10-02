"use strict";
const {ClientSecretCredential}=require("@azure/identity");
const {validEmail}=require("./welcome-email");
function createSubscriptionMailer(env=process.env,dependencies={}){
    let credential;
    const sender=env.SUBSCRIPTION_EMAIL_FROM||env.WELCOME_EMAIL_FROM;
    const ready=env.SUBSCRIPTIONS_ENABLED==="true"&&validEmail(sender)&&["AZURE_TENANT_ID","AZURE_CLIENT_ID","AZURE_CLIENT_SECRET"].every(k=>env[k]);
    return {ready,async send(email,subject,content){
        if(!ready)throw new Error("Subscription email is not configured.");
        if(!validEmail(email))throw new Error("Invalid recipient.");
        credential ||= dependencies.credential||new ClientSecretCredential(env.AZURE_TENANT_ID,env.AZURE_CLIENT_ID,env.AZURE_CLIENT_SECRET);
        const token=await credential.getToken("https://graph.microsoft.com/.default",{abortSignal:AbortSignal.timeout(15000)});
        const response=await (dependencies.fetch||fetch)("https://graph.microsoft.com/v1.0/users/"+encodeURIComponent(sender)+"/sendMail",{method:"POST",headers:{Authorization:"Bearer "+token.token,"Content-Type":"application/json"},signal:AbortSignal.timeout(15000),body:JSON.stringify({message:{subject,body:{contentType:"Text",content},toRecipients:[{emailAddress:{address:email}}]},saveToSentItems:false})});
        if(response.status!==202)throw new Error("Subscription email was refused.");
    }};
}
module.exports={createSubscriptionMailer};
