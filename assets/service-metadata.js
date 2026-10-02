(function(root){
    "use strict";
    const providers=[{id:"microsoft-365",name:"Microsoft 365"},{id:"exchange-online",name:"Exchange Online"},{id:"microsoft-teams",name:"Microsoft Teams"},{id:"sharepoint-online",name:"SharePoint Online"},{id:"onedrive",name:"OneDrive"},{id:"intune",name:"Microsoft Intune"},{id:"identity",name:"Microsoft Entra ID"}];
    function validateServices(services){
        const ids=new Set([...services.map(s=>s.id),...providers.map(s=>s.id)]),byId=new Map(services.map(s=>[s.id,s]));
        for(const service of services){
            if(service.ownerTeam!==undefined&&(typeof service.ownerTeam!=="string"||service.ownerTeam.length>100))throw new Error("Keep the owner team under 100 characters.");
            if(service.escalationContact!==undefined&&(typeof service.escalationContact!=="string"||service.escalationContact.length>254||/[\r\n]/.test(service.escalationContact)))throw new Error("Keep escalation contacts on one line under 254 characters.");
            const deps=service.dependsOn===undefined?[]:service.dependsOn;
            if(!Array.isArray(deps)||deps.length>30||new Set(deps).size!==deps.length||deps.some(id=>typeof id!=="string"||!ids.has(id)||id===service.id))throw new Error("Select unique existing dependencies. A service cannot depend on itself; remove references before deleting a dependency.");
        }
        const done=new Set(),visiting=new Set();
        function visit(id){if(visiting.has(id))throw new Error("Dependencies cannot form a circular chain.");if(done.has(id))return;visiting.add(id);for(const dep of byId.get(id)?.dependsOn||[])visit(dep);visiting.delete(id);done.add(id);}
        for(const service of services)visit(service.id);
    }
    function publicService(service){const {escalationContact,...safe}=service;return safe;}
    function withDependencies(services){
        const byId=new Map(services.map(s=>[s.id,s]));
        return services.map(service=>{
            const seen=new Set([service.id]),risks=[];
            function walk(id){if(seen.has(id))return;seen.add(id);const dep=byId.get(id);if(!dep){risks.push({id,name:id,status:"unknown",stale:false});return;}
                if(dep.stale||dep.healthCheck?.stale||dep.healthCheck?.monitorError||dep.status!=="operational")risks.push({id,name:dep.name||dep.serviceName||dep.id,status:dep.stale||dep.healthCheck?.stale?"unknown":dep.status||"unknown",stale:!!(dep.stale||dep.healthCheck?.stale)});
                for(const nested of dep.dependsOn||[])walk(nested);
            }
            for(const id of service.dependsOn||[])walk(id);
            return {...publicService(service),dependencyRisks:risks};
        });
    }
    const api={providers,validateServices,publicService,withDependencies};
    if(typeof module!=="undefined")module.exports=api;else root.PTGServices=api;
})(typeof window!=="undefined"?window:globalThis);
