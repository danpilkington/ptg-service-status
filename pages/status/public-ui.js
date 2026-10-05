(() => {
    "use strict";
    const $ = id => document.getElementById(id);
    const phases = { investigating: "Investigating", identified: "Identified", monitoring: "Monitoring", resolved: "Resolved" };
    const impacts = { unknown: "Impact not confirmed", confirmed: "Affecting PTG", "not-affected": "No PTG impact confirmed" };
    const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    const date = value => {
        const parsed = new Date(value);
        if (!value || Number.isNaN(parsed.getTime())) return "Not specified";
        const pad = part => String(part).padStart(2, "0");
        return `${pad(parsed.getDate())}/${pad(parsed.getMonth() + 1)}/${parsed.getFullYear()} ` +
            `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}`;
    };
    let cards = [];
    document.body.dataset.density = "compact";
    let latest = null, filter = "all", selected = "";
    const favouritesKey="ptg-dashboard-favourites";
    let favourites=new Set();try{favourites=window.PTGDashboard.parseFavourites(localStorage.getItem(favouritesKey));}catch{}
    const availabilityResults=new Map(),availabilityRequests=new Set();
    function openService(id,writeUrl=true){
        selected=id;
        if(writeUrl){const url=new URL(location.href);url.searchParams.set("service",id);history.pushState(null,"",url);}
        $("share-service-url").value=serviceLink(id);$("share-feedback").textContent="";
        renderDialog();if(!$("service-dialog").open)$("service-dialog").showModal();
    }
    function serviceLink(id){const url=new URL(location.pathname,location.origin);url.searchParams.set("service",id);return url.href;}
    function readServiceLink(){const id=new URL(location.href).searchParams.get("service");if(id)openService(id,false);else {selected="";$("service-dialog").close();}}
    let wallboard=false,wallboardPage=0,rotationPaused=false,wallboardPages=1;
    let wallboardFrame=0;
    function scheduleWallboard(){cancelAnimationFrame(wallboardFrame);wallboardFrame=requestAnimationFrame(renderWallboard);}
    function renderWallboard(){
        cards.forEach(c=>c.classList.remove("wallboard-offpage"));
        if(!wallboard)return;
        const visible=cards.filter(c=>!c.hidden),grid=$("service-grid");
        const controls=["wallboard-previous","wallboard-next","wallboard-pause"].map($);
        controls.forEach(c=>{c.hidden=true;});
        $("wallboard-page").textContent=visible.length+" services · All services on one page";
        // Measure the actual cards after responsive layout, including wrapped names.
        const measure=()=>{
            const style=getComputedStyle(grid),columns=style.gridTemplateColumns.split(" ").length;
            const rowHeight=Math.max(160,...visible.map(c=>c.getBoundingClientRect().height));
            const gap=parseFloat(style.rowGap)||0;
            const remaining=Math.max(0,innerHeight-grid.getBoundingClientRect().top-24);
            return columns*Math.max(1,Math.floor((remaining+gap)/(rowHeight+gap)));
        };
        let capacity=measure();
        wallboardPages=Math.max(1,Math.ceil(visible.length/capacity));
        if(wallboardPages>1){
            controls.forEach(c=>{c.hidden=false;});
            capacity=measure();wallboardPages=Math.max(1,Math.ceil(visible.length/capacity));
            wallboardPage=((wallboardPage%wallboardPages)+wallboardPages)%wallboardPages;
            const pageCards=new Set(visible.slice(wallboardPage*capacity,(wallboardPage+1)*capacity));
            cards.forEach(c=>c.classList.toggle("wallboard-offpage",!pageCards.has(c)));
            $("wallboard-page").textContent="Page "+(wallboardPage+1)+" of "+wallboardPages+" · "+visible.length+" services · "+(rotationPaused?"Rotation paused":"rotates every 15 seconds");
        }else wallboardPage=0;
    }
    window.addEventListener("resize",scheduleWallboard);
    document.fonts?.ready.then(scheduleWallboard);
    function setWallboard(enabled,writeUrl=true){
        wallboard=enabled;document.body.classList.toggle("wallboard-active",enabled);$("wallboard-controls").hidden=!enabled;
        $("wallboard-toggle").setAttribute("aria-pressed",String(enabled));
        if(writeUrl){const url=new URL(location.href);enabled?url.searchParams.set("wallboard","1"):url.searchParams.delete("wallboard");history.pushState(null,"",url);}
        if(!enabled&&document.fullscreenElement)document.exitFullscreen().catch(()=>{});
        renderWallboard();
    }
    $("wallboard-toggle").onclick=()=>{
        const enabled=!wallboard;
        setWallboard(enabled);
        if(enabled&&!document.fullscreenElement){
            try{
                const request=document.documentElement.requestFullscreen();
                request?.catch(()=>{$("wallboard-feedback").textContent="Full screen is unavailable. Wallboard mode remains active.";});
            }catch{$("wallboard-feedback").textContent="Full screen is unavailable. Wallboard mode remains active.";}
        }
    };
    $("wallboard-exit").onclick=()=>setWallboard(false);
    window.addEventListener("keydown",event=>{if(event.key==="Escape"&&wallboard&&!$("service-dialog").open&&!$("activity-dialog").open)setWallboard(false);});
    $("wallboard-next").onclick=()=>{wallboardPage++;renderWallboard();};
    $("wallboard-previous").onclick=()=>{wallboardPage=wallboardPages+wallboardPage-1;renderWallboard();};
    $("wallboard-pause").onclick=()=>{rotationPaused=!rotationPaused;$("wallboard-pause").textContent=rotationPaused?"Resume rotation":"Pause rotation";$("wallboard-pause").setAttribute("aria-pressed",String(rotationPaused));renderWallboard();};
    $("wallboard-fullscreen").onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();$("wallboard-feedback").textContent="";}catch{$("wallboard-feedback").textContent="Full screen is unavailable. Wallboard mode remains active.";}};
    document.addEventListener("fullscreenchange",()=>{$("wallboard-fullscreen").textContent=document.fullscreenElement?"Leave full screen":"Full screen";scheduleWallboard();});
    setInterval(()=>{if(wallboard&&wallboardPages>1&&!rotationPaused&&!document.hidden&&!$("service-dialog").open){wallboardPage++;renderWallboard();}},15000);
    $("copy-service-link").onclick=async()=>{try{await navigator.clipboard.writeText(serviceLink(selected));$("share-feedback").textContent="Service link copied.";}catch{$("share-service-url").focus();$("share-service-url").select();$("share-feedback").textContent="Select and copy the link below.";}};
    window.addEventListener("popstate",()=>{setWallboard(new URL(location.href).searchParams.get("wallboard")==="1",false);if(latest)readServiceLink();});
    $("service-dialog").addEventListener("close",()=>{if(!selected)return;selected="";const url=new URL(location.href);if(url.searchParams.has("service")){url.searchParams.delete("service");history.replaceState(null,"",url);}});
    setWallboard(new URL(location.href).searchParams.get("wallboard")==="1",false);
    function toggleFavourite(id){
        favourites.has(id)?favourites.delete(id):favourites.add(id);
        let saved=true;try{localStorage.setItem(favouritesKey,JSON.stringify([...favourites]));}catch{saved=false;}
        $("favourite-feedback").textContent=saved?"Favourites saved in this browser.":"Favourites are available for this visit. Browser storage is unavailable.";
        if(latest)syncServices(latest.services||[]);applyFilters();
        if(favourites.has(id))$("service-grid").scrollTop=0;
    }

    function syncServices(services) {
        const defaults = {
            "microsoft-365": ["Microsoft 365", "Microsoft cloud productivity services", "M"],
            "exchange-online": ["Outlook and Exchange", "Email, calendars and Exchange Online", "O"],
            "microsoft-teams": ["Microsoft Teams", "Chat, calls and meetings", "T"],
            "sharepoint-online": ["SharePoint Online", "SharePoint sites and cloud content", "S"],
            "onedrive": ["OneDrive", "Cloud file storage and synchronisation", "O"],
            "intune": ["Microsoft Intune", "Device management and Company Portal services", "I"],
            "identity": ["Microsoft Entra ID", "Cloud sign-in and authentication", "E"],
            "company-portal": ["Company Portal", "PTG application and device enrolment experience", "C"],
            "vpn": ["VPN Access", "Secure remote access to PTG resources", "V"],
            "network": ["Internet and Network", "PTG office connectivity", "N"],
            "meeting-rooms": ["Meeting Room Bookings", "Room calendars, panels and meeting spaces", "R"],
            "freshservice": ["Freshservice", "PTG IT support portal", "F"]
        };
        const grid = $("service-grid"), existing = new Map(cards.map(c => [c.dataset.service, c]));
        const seen = new Set();
        grid.querySelectorAll(".service-group-heading").forEach(el => el.remove());
        const ordered = [...services].sort((a,b) => Number(favourites.has(b.id))-Number(favourites.has(a.id)) || (a.source === "Microsoft" ? -1 : 0) - (b.source === "Microsoft" ? -1 : 0) || (a.order ?? 100) - (b.order ?? 100));
        const groups = new Map();
        for (const service of ordered) { const group = favourites.has(service.id) ? "Your favourites" : service.source === "Microsoft" ? "Microsoft 365 Managed Services" : String(service.group || "Progressive Technology Managed Services").trim() || "Progressive Technology Managed Services"; if (!groups.has(group)) groups.set(group, []); groups.get(group).push(service); }
        let currentGroup = "";
        for (const [group, grouped] of groups) for (const service of grouped) {
            if (!service || typeof service.id !== "string" || seen.has(service.id)) continue;
            seen.add(service.id);
            if (group !== currentGroup) { const heading = document.createElement("h3"); heading.className = "service-group-heading"; heading.textContent = group; heading.dataset.group = group; grid.append(heading); currentGroup = group; }
            const fallback = defaults[service.id] || [];
            const name = service.name || fallback[0] || service.serviceName || service.id;
            let card = existing.get(service.id);
            if (!card) {
                card = document.createElement("article");
                card.className = "service unknown"; card.id = "svc-" + service.id; card.dataset.service = service.id;
                card.innerHTML = '<div class="icon" aria-hidden="true"></div><div class="service-content"><h3></h3><p class="service-description"></p><span class="pill unknown">Loading…</span><span class="source-badge"></span><p class="service-check-time"></p><p class="service-owner-team"></p><p class="service-dependency-warning"></p><div class="service-actions"><button type="button" class="service-details">View details</button><button type="button" class="service-favourite" aria-pressed="false">☆ Favourite</button></div></div>';
                card.querySelector("button").addEventListener("click", () => {
                    openService(service.id);
                });
            }
            card.querySelector(".service-favourite").onclick=()=>toggleFavourite(service.id);
            const favouriteButton=card.querySelector(".service-favourite");
            favouriteButton.textContent=favourites.has(service.id)?"★ Favourited":"☆ Favourite";
            favouriteButton.setAttribute("aria-pressed",String(favourites.has(service.id)));
            favouriteButton.setAttribute("aria-label",(favourites.has(service.id)?"Remove ":"Add ")+name+(favourites.has(service.id)?" from favourites":" to favourites"));
            const checked = service.healthCheck?.checkedAt || service.checkedAt;
            const checkText = service.healthCheck?.stale || service.stale ? "Last check (stale): " : "Last checked: ";
            card.querySelector(".service-check-time").textContent = checked ? checkText + date(checked) : service.healthCheck ? "Awaiting automatic check" : "Manually reported · no automatic check";
            card.querySelector(".service-owner-team").textContent=service.ownerTeam?"Owner: "+service.ownerTeam:"";
            const warning=card.querySelector(".service-dependency-warning");warning.textContent=service.dependencyRisks?.length?"Dependency needs attention: "+service.dependencyRisks.map(dep=>dep.name).join(", "):"";warning.hidden=!service.dependencyRisks?.length;
            card.dataset.dependencyRisk=String(!!service.dependencyRisks?.length);
            card.dataset.group = group;
            card.title = name;
            card.dataset.source = service.source === "Microsoft" ? "microsoft" : "ptg";
            card.querySelector("h3").textContent = name;
            card.querySelector(".icon").textContent = fallback[2] || name.slice(0, 1).toUpperCase();
            card.querySelector(".service-description").textContent = service.description ?? fallback[1] ?? "";
            card.querySelector(".source-badge").textContent = card.dataset.source === "microsoft" ? "Microsoft 365 Managed Service" : service.group||"Progressive Technology Managed Services";
            card.querySelector("button").setAttribute("aria-label", "View details for " + name);
            grid.append(card);
        }
        existing.forEach((card, id) => { if (!seen.has(id)) card.remove(); });
        cards = [...grid.querySelectorAll(".service[data-service]")];
        $("service-load-state").hidden = true;
        $("favourite-count").textContent=cards.filter(c=>favourites.has(c.dataset.service)).length;
        return cards;
    }

    function renderItems(items, type) {
        if(window.PTGNotices)return window.PTGNotices.renderItems(items,type);
        if (!items?.length) {
            const empty = {
                incidents: ["No confirmed PTG incidents", "Microsoft-reported notices are listed separately below."],
                maintenance: ["No maintenance notices", "There are no published maintenance notices."],
                history: ["No resolved incidents yet", "Resolved PTG incidents will appear here with their updates."]
            }[type] || ["No active notices for this service", "Check its reported availability above."];
            return "<h3>" + empty[0] + "</h3><p>" + empty[1] + "</p>";
        }
        return items.map(item => {
            const maintenance = type === "maintenance";
            let html = '<article class="incident"><div class="incident-meta"><span>' + escape(item.source || "PTG") +
                "</span><span>" + escape(item.service || "") + "</span><span>" +
                (maintenance ? "Starts " + escape(date(item.start)) : "Updated " + escape(date(item.updatedAt || item.start))) + "</span></div>";
            html += "<h3>" + escape(item.title || "Service update") + "</h3>";
            if (!maintenance) html += '<div class="incident-badges"><span class="stage-badge">' +
                escape(phases[item.phase] || (item.source === "Microsoft" ? "Microsoft notice" : "Investigating")) +
                '</span><span class="impact-badge ' + (item.impact === "confirmed" ? "confirmed" : "") + '">' +
                escape(item.phase === "resolved" && item.impact === "confirmed" ? "Affected PTG" : impacts[item.impact] || impacts.unknown) + "</span></div>";
            html += '<p class="notice-copy">' + escape(item.message || item.description || "Further information is not currently available.") + "</p>";
            if (item.ptgNote) html += '<div class="local-guidance"><strong>PTG assessment</strong><p class="notice-copy">' +
                escape(item.ptgNote) + "</p><small>Assessed " + escape(date(item.assessmentUpdatedAt)) + "</small></div>";
            if (item.workaround) html += '<div class="local-guidance"><strong>What you can do</strong><p class="notice-copy">' + escape(item.workaround) + "</p></div>";
            if (item.nextUpdateAt && item.phase !== "resolved") html += '<p class="next-update"><strong>' +
                (Date.parse(item.nextUpdateAt) < Date.now() ? "Update due — awaiting further news: " : "Next update expected: ") +
                "</strong>" + escape(date(item.nextUpdateAt)) + "</p>";
            if (maintenance && item.end) html += "<p>Ends " + escape(date(item.end)) +
                (Date.parse(item.end) < Date.now() ? " · Scheduled window has ended; completion not yet confirmed." : "") + "</p>";
            if (item.updates?.length) {
                html += '<details data-detail="' + escape((item.source || "PTG") + ":" + item.id) + '"><summary>' +
                    (item.source === "Microsoft" ? "PTG assessment timeline" : "Incident timeline") +
                    " (" + item.updates.length + ' updates)</summary><ol class="timeline">';
                for (const u of [...item.updates].reverse()) {
                    html += "<li><strong>" + escape(phases[u.phase] || impacts[u.impact] || "Update") + "</strong><time>" +
                        escape(date(u.at)) + '</time><p class="notice-copy">' + escape(u.message) + "</p>";
                    if (u.workaround) html += '<p class="notice-copy">Workaround: ' + escape(u.workaround) + "</p>";
                    if (u.nextUpdateAt) html += "<p>Next update expected: " + escape(date(u.nextUpdateAt)) + "</p>";
                    html += "</li>";
                }
                html += "</ol></details>";
            }
            return html + "</article>";
        }).join("");
    }
    function replace(id, html) {
        const container = $(id);
        const open = new Set([...container.querySelectorAll("details[open][data-detail]")].map(el => el.dataset.detail));
        container.innerHTML = html;
        container.querySelectorAll("details[data-detail]").forEach(el => { el.open = open.has(el.dataset.detail); });
    }
    function applyFilters() {
        const query = $("service-search").value.trim().toLowerCase();
        let count = 0;
        for (const card of cards) {
            const match = filter === "all" || filter === card.dataset.source || filter === "favourites" && favourites.has(card.dataset.service) || (filter === "affected" &&
                (card.dataset.dependencyRisk==="true" || ["advisory", "degraded", "outage", "maintenance"].some(s => card.classList.contains(s)) ||
                    latest?.incidents?.some(i => i.serviceId === card.dataset.service && i.impact === "confirmed")));
            card.hidden = !match || !(card.querySelector("h3").textContent + " " + card.querySelector(".service-description").textContent).toLowerCase().includes(query);
            if (!card.hidden) count++;
        }
        document.querySelectorAll(".service-group-heading").forEach(h => { h.hidden = !cards.some(c => c.dataset.group === h.dataset.group && !c.hidden); });
        $("service-count").textContent = count + " of " + cards.length + " services shown";
        renderWallboard();
        $("filter-empty").hidden = count !== 0;
        $("filter-empty").querySelector("p").textContent=filter==="favourites"&&!cards.some(c=>favourites.has(c.dataset.service))?"No favourites yet. Choose All services and use ☆ Favourite to pin the services you rely on.":"No services match your search or filter.";
    }
    function renderAffected(){
        const container=$("affected-service-list");container.replaceChildren();
        const affected=window.PTGDashboard.affectedServices(latest);
        const unknown=(latest.services||[]).filter(s=>s.status==="unknown"||s.stale).length;
        $("affected-summary").textContent=affected.length?affected.length+" service"+(affected.length===1?" needs":"s need")+" attention. Microsoft reports and PTG impact are shown separately.":unknown?"No reported service issues. Some status information is unavailable or stale.":"No services currently have reported issues.";
        $("show-affected-services").hidden=!affected.length;
        for(const item of affected.slice(0,6)){
            const article=document.createElement("article");article.className="affected-service";article.dataset.status=item.status;
            const title=document.createElement("h3");title.textContent=item.name;
            const impact=document.createElement("p");impact.className="affected-impact";impact.textContent=({outage:"Service outage",degraded:"Degraded performance",advisory:"Advisory",maintenance:"Maintenance"}[item.status]||"Incident reported")+" · "+item.impact+(item.stale?" · Last known report":"");
            const guidance=document.createElement("p");guidance.className="affected-guidance";guidance.textContent=item.guidance;
            const action=document.createElement("button");action.type="button";action.className="secondary";action.textContent="View guidance";action.setAttribute("aria-label","View guidance for "+item.name);action.onclick=()=>openService(item.id);
            article.append(title,impact,guidance,action);container.append(article);
        }
    }
    const duration=seconds=>{const minutes=Math.round((seconds||0)/60);return minutes>=60?Math.floor(minutes/60)+"h "+minutes%60+"m":minutes+"m";};
    function availabilityHtml(id){
        const cached=availabilityResults.get(id);
        if(!cached)return '<section class="service-availability"><h3>Observed availability</h3><p role="status">Loading this month’s observations…</p></section>';
        if(cached.error)return '<section class="service-availability"><h3>Observed availability</h3><p role="status">Availability observations could not be loaded.</p><button id="retry-availability" type="button" class="secondary">Retry availability</button></section>';
        const result=cached.data,percent=Number.isFinite(result.operationalPercent)?result.operationalPercent.toFixed(2)+"%":"No observations yet";
        return '<section class="service-availability"><h3>Observed availability · '+escape(result.month)+'</h3><dl class="availability-stats"><div><dt>Fully operational</dt><dd>'+escape(percent)+'</dd></div><div><dt>Monitoring coverage</dt><dd>'+escape(Number(result.coverage||0).toFixed(1))+ '%</dd></div><div><dt>Observed outage time</dt><dd>'+escape(duration(result.outageSeconds))+'</dd></div><div><dt>Outage starts</dt><dd>'+escape(result.outageCount||0)+'</dd></div></dl><p class="help">Month to date, measured in UTC. Operational percentage excludes maintenance and unknown time; coverage includes maintenance. Gaps are unknown, not assumed uptime.</p><p class="help">Observations through '+escape(date(result.to))+(result.startedAt?' · Recording began '+escape(date(result.startedAt)):'')+'</p></section>';
    }
    async function loadAvailability(id,force=false){
        const cached=availabilityResults.get(id),month=new Date().toISOString().slice(0,7);
        if(availabilityRequests.has(id)||!force&&cached&&Date.now()-cached.at<60000&&cached.month===month)return;
        availabilityRequests.add(id);
        try{
            const response=await fetch("/api/services/"+encodeURIComponent(id)+"/availability",{cache:"no-store",signal:AbortSignal.timeout(10000)});
            if(!response.ok)throw Error("Unavailable");const result=await response.json();if(result.serviceId!==id)throw Error("Unexpected service");
            availabilityResults.set(id,{data:result,at:Date.now(),month});
        }catch{availabilityResults.set(id,{error:true,at:Date.now(),month});}
        finally{availabilityRequests.delete(id);if(selected===id&&$("service-dialog").open)renderDialog();}
    }
    function renderDialog() {
        if (!selected) return;
        const card = cards.find(c => c.dataset.service === selected);
        if (!card) { $("service-dialog-title").textContent = "Service removed"; $("service-dialog-content").textContent = "This service is no longer on the published dashboard."; return; }
        $("service-dialog-title").textContent = card.querySelector("h3").textContent;
        const service = latest?.services?.find(s => s.id === selected);
        let html = "<p><strong>Reported availability: " + escape(service?.statusText || service?.status || "Status unavailable") + "</strong></p>";
        html += "<p>" + escape(service?.description || card.querySelector(".service-description").textContent) + "</p>";
        if (service?.healthCheck) html += "<p>Automatic check: " + escape(service.healthCheck.checkedAt ? date(service.healthCheck.checkedAt) : "Awaiting results") + "</p>";
        if(service?.healthCheck?.monitorError)html+="<p>The automatic monitor needs attention. A service outage has not been confirmed by this check.</p>";
        if(service?.stale)html+="<p>Last known Microsoft status from "+escape(date(service.checkedAt))+". This data is stale.</p>";
        if (card.dataset.source === "microsoft") html += "<p>Microsoft reports service health. Local impact assessments appear on each notice below.</p>";
        if (!latest) html += "<p>Live status could not be loaded.</p>";
        if(service?.healthCheck)html+="<p>Last successful automatic check: "+escape(service.healthCheck.lastSuccessfulCheckAt?date(service.healthCheck.lastSuccessfulCheckAt):"No successful check recorded since monitoring started")+"</p>";
        else if(service?.source==="Microsoft")html+="<p>Microsoft report collected: "+escape(date(service.checkedAt))+"</p>";
        else if(service)html+="<p>Manual status published: "+escape(date(latest.publishedAt))+"</p>";
        if(service?.ownerTeam)html+="<p><strong>Owner team:</strong> "+escape(service.ownerTeam)+"</p>";
        if(service?.dependsOn?.length)html+="<h3>Service dependencies</h3><ul>"+service.dependsOn.map(id=>{const dep=latest.services.find(s=>s.id===id);return "<li>"+escape(dep?.name||dep?.serviceName||id)+": "+escape(dep?.statusText||dep?.status||"Status unavailable")+"</li>";}).join("")+"</ul>";
        if(service?.dependencyRisks?.length)html+="<p class=\"dependency-risk-note\">A dependency needs attention: "+escape(service.dependencyRisks.map(dep=>dep.name).join(", "))+". This indicates possible impact; this service's reported availability has not been changed automatically.</p>";
        const dependents=latest?.services?.filter(s=>s.dependsOn?.includes(selected))||[];
        if(dependents.length)html+="<h3>Services that depend on this</h3><p>"+escape(dependents.map(s=>s.name||s.serviceName||s.id).join(", "))+"</p>";
        html+=availabilityHtml(selected);
        html += "<h3>Current notices</h3>" + renderItems(latest?.incidents?.filter(i => i.serviceId === selected), "service");
        for (const [type, label] of [["maintenance", "Maintenance"], ["history", "Resolved incidents"]]) {
            const items = latest?.[type]?.filter(i => i.serviceId === selected) || [];
            if (items.length) html += "<h3>" + label + "</h3>" + renderItems(items, type);
        }
        replace("service-dialog-content", html);
        $("retry-availability")?.addEventListener("click",()=>void loadAvailability(selected,true));
        if(latest)void loadAvailability(selected);
    }
    function update(data) {
        const firstLoad=!latest;
        latest = data;
        window.PTGCalendar?.render(data.maintenance || []);
        renderAffected();
        const announcement = data.announcement;
        $("announcement").hidden = !announcement;
        if (announcement) { $("announcement").className = "announcement " + announcement.level; $("announcement-heading").textContent = announcement.title; $("announcement-text").textContent = announcement.message; }
        const rank = { confirmed: 0, unknown: 1, "not-affected": 2 };
        const items = [...(data.incidents || [])].sort((a, b) => (rank[a.impact || "unknown"] ?? 1) - (rank[b.impact || "unknown"] ?? 1) ||
            Date.parse(b.updatedAt || b.start) - Date.parse(a.updatedAt || a.start));
        const relevant = items.filter(i => i.source !== "Microsoft" || i.impact === "confirmed");
        const provider = items.filter(i => i.source === "Microsoft" && i.impact !== "confirmed");
        replace("incidents", renderItems(relevant, "incidents"));
        replace("provider-incidents", renderItems(provider, "service"));
        $("provider-summary").textContent = "Other Microsoft notices (" + provider.length + ")";
        $("provider-notices").hidden = !provider.length;
        replace("history", renderItems(data.history || [], "history"));
        const confirmed = items.filter(i => i.impact === "confirmed").length;
        $("impact-total").textContent = confirmed;
        $("impact-summary").textContent = confirmed ? confirmed + " active incident" + (confirmed === 1 ? " is" : "s are") +
            " confirmed to affect PTG. See guidance below." :
            "No incidents are confirmed to affect PTG. Microsoft notices are assessed separately.";
        if (!data.microsoftAvailable) $("impact-summary").textContent += " Microsoft live information is unavailable.";
        applyFilters();
        if(firstLoad)readServiceLink();
        if ($("service-dialog").open) renderDialog();
    }
    function unavailable() {
        latest = null; applyFilters();
        document.querySelectorAll(".service-check-time").forEach(el=>{el.textContent="Current check unavailable · previous information may be stale";});
        $("affected-service-list").replaceChildren();$("affected-summary").textContent="Current affected services could not be checked. Try Refresh status.";$("show-affected-services").hidden=true;
        $("announcement").hidden = true;
        $("service-load-state").hidden = false;
        $("service-load-state").textContent = "Unable to load the service list. Try Refresh status.";
        if (!cards.length) $("filter-empty").hidden = true;
        $("impact-total").textContent = "—";
        $("impact-summary").textContent = "Live impact information is unavailable.";
        $("provider-notices").hidden = true;
        $("history").textContent = "Incident history could not be retrieved.";
        if ($("service-dialog").open) renderDialog();
    }
    document.querySelectorAll("[data-filter]").forEach(button => button.addEventListener("click", () => {
        filter = button.dataset.filter;
        document.querySelectorAll("[data-filter]").forEach(b => b.setAttribute("aria-pressed", String(b === button)));
        applyFilters();
    }));
    $("show-affected-services").addEventListener("click",()=>{document.querySelector('[data-filter="affected"]').click();$("service-search").value="";applyFilters();$("services").scrollIntoView({block:"start",behavior:"smooth"});});
    window.addEventListener("storage",event=>{if(event.key===favouritesKey||event.key===null){try{favourites=window.PTGDashboard.parseFavourites(localStorage.getItem(favouritesKey));}catch{favourites=new Set();}if(latest)syncServices(latest.services||[]);applyFilters();}});
    $("service-search").addEventListener("input", applyFilters);
    $("reset-filters")?.addEventListener("click", () => {
        filter = "all"; $("service-search").value = "";
        document.querySelectorAll("[data-filter]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.filter === "all")));
        applyFilters(); $("service-search").focus();
    });
    $("close-service-dialog").addEventListener("click", () => $("service-dialog").close());


    // Incidents and maintenance remain visible together beneath service health.
    const activity = document.querySelector(".dashboard-sidebar");
    $("services").querySelector(".section-head").append(document.querySelector(".activity-tools"));
    activity.append($("current-activity"), $("maintenance-view"), $("incident-history"));
    for (const id of ["current-activity", "maintenance-view", "incident-history"]) {
        $(id).hidden = false; $(id).setAttribute("role", "region");
    }
    $("maintenance-view").setAttribute("aria-label", "Maintenance");
    const incidentBody = document.createElement("div");
    incidentBody.className = "activity-body"; incidentBody.tabIndex = 0;
    incidentBody.setAttribute("aria-label", "Current incident notices");
    incidentBody.append($("incidents"), $("provider-notices"));
    $("current-activity").append(incidentBody);
    $("maintenance").tabIndex = 0;
    $("maintenance").setAttribute("aria-label", "Maintenance notices");
    $("incident-history").setAttribute("aria-label", "Incident history");
    $("history").tabIndex = 0;
    $("history").setAttribute("aria-label", "Resolved incident notices");
    $("activity-dialog-content").append($("support-view"));
    $("planned-activity").hidden = true;
    function openActivity(id) {
        if (id === "incident-history") {
            $("history").focus({preventScroll:true});
            if (matchMedia("(max-width:1000px)").matches) $("incident-history").scrollIntoView({block:"start"});
            return;
        }
        $("support-view").hidden = id !== "support-view";
        $("activity-dialog-title").textContent = id === "incident-history" ? "Incident history" : "IT support";
        if (!$("activity-dialog").open) $("activity-dialog").showModal();
    }
    $("open-history").addEventListener("click", () => openActivity("incident-history"));
    $("open-support").addEventListener("click", () => openActivity("support-view"));
    $("close-activity-dialog").addEventListener("click", () => $("activity-dialog").close());
    document.querySelectorAll('a[href="#incident-history"],a[href="#planned-activity"],a[href="#current-activity"]').forEach(link => {
        link.addEventListener("click", event => {
            event.preventDefault();
            if (link.hash === "#incident-history") return openActivity("incident-history");
            const target = link.hash === "#planned-activity" ? $("maintenance") : incidentBody;
            target.focus();
            if (matchMedia("(max-width:1000px)").matches) target.scrollIntoView({block:"start"});
        });
    });
    try { const density = localStorage.getItem("ptg-dashboard-density"); if (["compact","comfortable"].includes(density)) document.body.dataset.density = density; } catch {}
    $("dashboard-density").value = document.body.dataset.density;
    $("dashboard-density").addEventListener("change", event => {
        document.body.dataset.density = event.target.value;
        try { localStorage.setItem("ptg-dashboard-density", event.target.value); } catch {}
    });
    fetch("/api/subscriptions/config",{cache:"no-store"}).then(r=>r.ok?r.json():null).then(config=>{const link=$("subscription-link");if(link)link.hidden=!config?.enabled;}).catch(()=>{});
    window.PTGView = { renderItems, update, unavailable, syncServices };
})();
