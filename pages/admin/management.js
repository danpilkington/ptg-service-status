(()=>{
    "use strict";
    window.PTGManagement=({$,text,button,run,accountRequest,format,getKey})=>{
        let subscriberOffset=0,subscriberRevision=null,currentReview=null,reviewDirty=false;
        async function loadSubscribers(){
            const requested=getKey();const result=await accountRequest("subscribers?"+new URLSearchParams({search:$("subscriber-search").value,filter:$("subscriber-filter").value,offset:subscriberOffset}));if(!requested||getKey()!==requested)return;
            subscriberRevision=result.revision;subscriberOffset=result.offset;
            const c=result.counts;$("subscriber-counts").textContent=`${c.confirmed} confirmed · ${c.paused} paused · ${c.pending} awaiting confirmation · ${c.expired} expired · ${c.queued} queued emails · ${c.failed} failed deliveries · ${c.confirmationFailures||0} confirmation email failures`;
            const services=new Map(result.services.map(s=>[s.id,s.name]));const list=$("subscriber-list");list.replaceChildren();
            for(const subscriber of result.items){
                const row=text("article","","subscriber-row");
                row.append(text("h3",subscriber.email),text("p",subscriber.status+" · "+subscriber.serviceIds.map(id=>services.get(id)||id).join(", ")),text("p","Last accepted email: "+format(subscriber.lastDeliveredAt)+" · Queued: "+subscriber.queued+" · Failed: "+subscriber.failed,"help"));
                if(subscriber.confirmationEmailStatus==="failed")row.append(text("p","The latest confirmation email was not accepted by Microsoft 365. The subscriber can request a new link.","help"));
                if(subscriber.lastDeliveryFailureAt)row.append(text("p","Last delivery failure: "+format(subscriber.lastDeliveryFailureAt),"help"));
                const actions=text("div","","actions");
                async function manage(action){
                    if(action==="delete"&&!confirm("Remove "+subscriber.email+" and cancel its queued emails? The address must subscribe and confirm again to receive updates."))return;
                    await accountRequest("subscribers/"+encodeURIComponent(subscriber.id)+"/"+action,"POST",{revision:subscriberRevision});
                    $("subscriber-feedback").textContent=action==="retry"?"Failed emails will retry on the next delivery cycle.":action==="pause"?"Subscriber paused; queued emails cancelled.":action==="resume"?"Subscriber resumed for future updates.":"Subscriber removed.";
                    await loadSubscribers();
                }
                if(subscriber.status==="confirmed"||subscriber.status==="paused")actions.append(button(subscriber.status==="paused"?"Resume updates":"Pause updates",()=>run(()=>manage(subscriber.status==="paused"?"resume":"pause"))));
                if(subscriber.failed&&subscriber.status==="confirmed")actions.append(button("Retry queued emails",()=>run(()=>manage("retry"))));
                actions.append(button("Remove subscriber",()=>run(()=>manage("delete"))));row.append(actions);list.append(row);
            }
            if(!result.items.length)list.append(text("p","No subscribers match this filter."));
            $("subscriber-page").textContent=result.total?`${result.offset+1}–${Math.min(result.offset+50,result.total)} of ${result.total}`:"No matching subscribers";
            $("subscriber-newer").dataset.available=String(result.offset>0);$("subscriber-older").dataset.available=String(result.offset+50<result.total);
        }
        $("subscriber-search-form").onsubmit=event=>{event.preventDefault();subscriberOffset=0;run(loadSubscribers);};
        $("subscriber-newer").onclick=()=>{if($("subscriber-newer").dataset.available==="true"){subscriberOffset=Math.max(0,subscriberOffset-50);run(loadSubscribers);}};
        $("subscriber-older").onclick=()=>{if($("subscriber-older").dataset.available==="true"){subscriberOffset+=50;run(loadSubscribers);}};
        document.querySelector('[data-admin-tab="manage-subscribers"]').addEventListener("click",()=>{if(getKey())run(loadSubscribers);});
        function clearReview(){currentReview=null;reviewDirty=false;$("incident-review-editor").hidden=true;$("incident-review-form").reset();$("review-actions").replaceChildren();$("review-timeline").replaceChildren();}
        function actionRow(action={title:"",owner:"",dueDate:"",completed:false}){
            if($("review-actions").children.length>=30){$("review-feedback").textContent="Keep the review to at most 30 follow-up actions.";return;}
            const row=text("div","","review-action-row");
            for(const [field,label,type,max] of [["title","Action","text",500],["owner","Owner","text",100],["dueDate","Due date","date",10]]){const control=document.createElement("label"),input=document.createElement("input");control.textContent=label;input.type=type;input.dataset.actionField=field;input.value=action[field]||"";input.maxLength=max;if(field==="title")input.required=true;control.append(input);row.append(control);}
            const completed=document.createElement("label"),check=document.createElement("input");check.type="checkbox";check.dataset.actionField="completed";check.checked=!!action.completed;completed.append(check,document.createTextNode(" Complete"));row.append(completed,button("Remove action",()=>{row.remove();reviewDirty=true;}));$("review-actions").append(row);
        }
        async function loadReviews(){
            const requested=getKey(),result=await accountRequest("incident-reviews");if(!requested||getKey()!==requested)return;
            const list=$("incident-review-list");list.replaceChildren();
            for(const item of result.items){const row=text("article","","incident-review-row");row.append(text("h3",item.title),text("p",item.service+" · "+(item.reviewed?"Review recorded":"Review not yet recorded")+" · "+item.openActions+" open follow-up actions"+(item.phase!=="resolved"?" · Incident reopened":"")),button("Open review",()=>run(()=>loadReview(item.id))));list.append(row);}
            if(!result.items.length)list.append(text("p","Resolve a PTG incident to create its review report."));
        }
        async function loadReview(id,force=false){
            if(reviewDirty&&!force&&!confirm("Discard the unsaved incident review and open another?"))return;
            const requested=getKey(),result=await accountRequest("incident-reviews/"+encodeURIComponent(id));if(!requested||requested!==getKey())return;
            currentReview=result;result.review ||= {};reviewDirty=false;$("incident-review-editor").hidden=false;$("review-incident-title").textContent=result.incident.title;
            const i=result.incident;$("review-incident-summary").textContent=i.service+" · Owner: "+(result.ownerTeam||"Unassigned")+" · Opened: "+format(i.start)+" · Resolved: "+format(i.resolvedAt)+" · Incident elapsed time: "+(i.elapsedMinutes===null?"Not available":i.elapsedMinutes+" minutes")+". This is not measured outage time.";
            for(const field of ["impactSummary","rootCause","resolution","lessonsLearned"])$("review-"+field).value=result.review[field]||"";
            $("review-actions").replaceChildren();for(const action of result.review.actions||[])actionRow(action);
            $("review-save").dataset.resolved=String(i.phase==="resolved");$("review-save").disabled=i.phase!=="resolved";$("review-timeline").replaceChildren();
            for(const entry of i.timeline)$("review-timeline").append(text("p",format(entry.at)+" · "+(entry.phase||"Update")+" · "+entry.message));
            $("incident-review-editor").scrollIntoView({behavior:"smooth",block:"start"});
        }
        $("reviews-refresh").onclick=()=>run(loadReviews);
        document.querySelector('[data-admin-tab="incident-reviews"]').addEventListener("click",()=>{if(getKey())run(loadReviews);});
        $("incident-review-form").addEventListener("input",()=>{reviewDirty=true;});
        $("review-add-action").onclick=()=>{actionRow();reviewDirty=true;};
        $("review-clear").onclick=()=>{if(!reviewDirty||confirm("Discard this unsaved incident review?"))clearReview();};
        $("incident-review-form").onsubmit=event=>{event.preventDefault();if(!currentReview)return;run(async()=>{
            const body={revision:currentReview.revision,incidentRevision:currentReview.incidentRevision,actions:[...$("review-actions").children].map(row=>Object.fromEntries([...row.querySelectorAll("input")].map(input=>[input.dataset.actionField,input.type==="checkbox"?input.checked:input.value])))};
            for(const field of ["impactSummary","rootCause","resolution","lessonsLearned"])body[field]=$("review-"+field).value;
            const id=currentReview.incident.id;await accountRequest("incident-reviews/"+encodeURIComponent(id),"PUT",body);reviewDirty=false;await loadReview(id,true);await loadReviews();$("review-feedback").textContent="Incident review saved. Follow-up actions remain here for tracking.";
        });};
        $("review-download").onclick=()=>run(async()=>{
            if(!currentReview)return;if(reviewDirty){$("review-feedback").textContent="Save the review before downloading its report.";return;}
            const r=await fetch("/api/admin/incident-reviews/"+encodeURIComponent(currentReview.incident.id)+"?download=html",{headers:{Authorization:"Bearer "+getKey()},cache:"no-store"});if(!r.ok)throw new Error("The incident report could not be downloaded.");
            const url=URL.createObjectURL(await r.blob()),link=document.createElement("a");link.href=url;link.download="ptg-incident-review.html";link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);$("review-feedback").textContent="Report downloaded. Open it in a browser to print or save as PDF.";
        });
        return {dirty:()=>reviewDirty,clear(){clearReview();subscriberRevision=null;subscriberOffset=0;for(const id of ["subscriber-list","incident-review-list"])$(id).replaceChildren();for(const id of ["subscriber-feedback","subscriber-counts","subscriber-page","review-feedback","review-incident-title","review-incident-summary"])$(id).textContent="";$("subscribers-nav").hidden=true;$("reviews-nav").hidden=true;}};
    };
})();
