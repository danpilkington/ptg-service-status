(()=>{"use strict";window.PTGMicrosoftAdmin=({$,accountRequest,run,text,format,hasOtherEdits,afterSave})=>{
    let revision=null,dirty=false,generation=0;
    const fields=["group-access","admin-group-id","editor-group-id","devices-enabled","device-stale-days"];
    const read=()=>({groupAccess:$("group-access").checked,adminGroupId:$("admin-group-id").value.trim(),editorGroupId:$("editor-group-id").value.trim(),requireAccount:false,devicesEnabled:$("devices-enabled").checked,staleDays:Number($("device-stale-days").value)});
    async function load(){const gen=generation;try{const result=await accountRequest("microsoft-controls");if(gen!==generation)return;revision=result.revision;const s=result.settings;
        $("group-access").checked=s.groupAccess;$("admin-group-id").value=s.adminGroupId;$("editor-group-id").value=s.editorGroupId;$("devices-enabled").checked=s.devicesEnabled;$("device-stale-days").value=s.staleDays;dirty=false;
        $("microsoft-controls-feedback").textContent=result.credentialsReady?"Microsoft controls loaded.":"Azure tenant credentials are missing on the server.";
    }catch(e){$("microsoft-controls-feedback").textContent=e.message;}}
    async function devices(){const gen=generation;$("device-compliance-feedback").textContent="Loading device overview…";try{const result=await accountRequest("device-compliance");if(gen!==generation)return;
        for(const id of ["device-compliance-counts","device-compliance-states","device-compliance-platforms"])$(id).replaceChildren();
        $("device-compliance-feedback").textContent=result.message||("Last successful check: "+format(result.checkedAt)+" · Check-in threshold: "+result.staleDays+" days");
        if(!result.available)return;
        for(const [key,label]of [["total","Managed devices"],["compliant","Compliant"],["noncompliant","Non-compliant"],["other","Other / unknown"],["stale","Overdue check-in"],["neverCheckedIn","No recorded check-in"]]){const card=text("div","","metric");card.append(text("strong",String(result.counts[key])),text("span",label));$("device-compliance-counts").append(card);}
        for(const [id,values]of [["device-compliance-states",result.states],["device-compliance-platforms",result.platforms]])for(const [name,count]of Object.entries(values))$(id).append(text("p",name+": "+count));
        if(result.stale)$("device-compliance-feedback").textContent+=" Last successful check: "+format(result.checkedAt);
    }catch(e){if(gen!==generation)return;for(const id of ["device-compliance-counts","device-compliance-states","device-compliance-platforms"])$(id).replaceChildren();$("device-compliance-feedback").textContent=e.message;}}
    $("microsoft-controls-form").addEventListener("input",()=>{dirty=true;});
    $("microsoft-controls-form").onsubmit=e=>{e.preventDefault();if(hasOtherEdits()){ $("microsoft-controls-feedback").textContent="Publish or discard your other edits before saving Microsoft controls.";return;}run(async()=>{const result=await accountRequest("microsoft-controls","PUT",{settings:read(),revision});revision=result.revision;dirty=false;await afterSave();$("microsoft-controls-feedback").textContent="Microsoft controls saved. Group membership is checked on Microsoft sign-in.";});};
    $("microsoft-controls-reload").onclick=()=>{if(!dirty||confirm("Discard unsaved Microsoft controls?"))run(load);};
    $("device-compliance-refresh").onclick=()=>run(devices);
    document.querySelector('[data-admin-tab="device-compliance"]').addEventListener("click",()=>{void devices();});
    return {load,dirty:()=>dirty,clear(){generation++;dirty=false;revision=null;for(const id of ["microsoft-controls-nav","device-compliance-nav"])$(id).hidden=true;for(const id of ["device-compliance-counts","device-compliance-states","device-compliance-platforms"])$(id).replaceChildren();$("microsoft-controls-feedback").textContent="";$("device-compliance-feedback").textContent="";$("microsoft-controls-form").reset();}};
};})();
