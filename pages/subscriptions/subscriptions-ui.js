(()=>{
    "use strict";
    const $=id=>document.getElementById(id),feedback=$("subscription-feedback"),params=new URLSearchParams(location.hash.slice(1)),token=params.get("token"),action=params.get("action");
    history.replaceState(null,"",location.pathname);
    const message=text=>{feedback.textContent=text;};
    async function post(route,body){const r=await fetch("/api/subscriptions/"+route,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});const result=await r.json();if(!r.ok)throw new Error(result.error||"Request failed. Please try again.");return result;}
    if(token&&["confirm","unsubscribe"].includes(action)){
        $("subscription-action").hidden=false;$("subscription-confirm").textContent=action==="confirm"?"Confirm subscription":"Unsubscribe from all updates";message(action==="confirm"?"Confirm to start receiving service updates.":"Select Unsubscribe to stop all service update emails.");
        $("subscription-confirm").onclick=async()=>{const b=$("subscription-confirm");b.disabled=true;try{const result=await post(action,{token});message(result.message);$("subscription-action").hidden=true;if(result.unsubscribeToken){const a=document.createElement("a");a.href="/subscriptions.html#"+new URLSearchParams({action:"unsubscribe",token:result.unsubscribeToken});a.textContent="Unsubscribe";feedback.after(a);}}catch(e){message(e.message);b.disabled=false;}};
        return;
    }
    fetch("/api/subscriptions/config",{cache:"no-store"}).then(r=>r.json()).then(config=>{
        if(!config.enabled){message("Email subscriptions are not yet enabled. Please check the status page for updates.");return;}
        message("Select the services you want to follow.");$("subscription-form").hidden=false;
        for(const service of config.services){const label=document.createElement("label"),input=document.createElement("input");input.type="checkbox";input.value=service.id;label.append(input,document.createTextNode(" "+service.name));$("subscription-services").append(label);}
    }).catch(()=>message("Subscription options could not be loaded. Please try again."));
    $("subscription-form").onsubmit=async event=>{event.preventDefault();const button=event.target.querySelector("button");button.disabled=true;try{const serviceIds=[...$("subscription-services").querySelectorAll("input:checked")].map(i=>i.value);if(!serviceIds.length)throw new Error("Select at least one service.");const result=await post("request",{email:$("subscription-email").value.trim(),serviceIds});message(result.message);}catch(e){message(e.message);}finally{button.disabled=false;}};
})();
