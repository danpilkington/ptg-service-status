(() => {
    "use strict";
    const $ = id => document.getElementById(id);
    const phases = { investigating: "Investigating", identified: "Identified", monitoring: "Monitoring", resolved: "Resolved" };
    const impacts = { unknown: "Impact not confirmed", confirmed: "Affecting PTG", "not-affected": "No PTG impact confirmed" };
    const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "Not specified";
    let cards = [];
    document.body.dataset.density = "compact";
    let latest = null, filter = "all", selected = "";

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
        const ordered = [...services].sort((a,b) => (a.source === "Microsoft" ? -1 : 0) - (b.source === "Microsoft" ? -1 : 0) || (a.order ?? 100) - (b.order ?? 100));
        const groups = new Map();
        for (const service of ordered) { const group = service.source === "Microsoft" ? "Microsoft 365 Managed Services" : String(service.group || "Progressive Technology Managed Services").trim() || "Progressive Technology Managed Services"; if (!groups.has(group)) groups.set(group, []); groups.get(group).push(service); }
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
                card.innerHTML = '<div class="icon" aria-hidden="true"></div><div class="service-content"><h3></h3><p class="service-description"></p><span class="pill unknown">Loading…</span><span class="source-badge"></span><button type="button" class="service-details">View details</button></div>';
                card.querySelector("button").addEventListener("click", () => {
                    selected = service.id; renderDialog(); $("service-dialog").showModal();
                });
            }
            card.dataset.group = group;
            card.title = name;
            card.dataset.source = service.source === "Microsoft" ? "microsoft" : "ptg";
            card.querySelector("h3").textContent = name;
            card.querySelector(".icon").textContent = fallback[2] || name.slice(0, 1).toUpperCase();
            card.querySelector(".service-description").textContent = service.description ?? fallback[1] ?? "";
            card.querySelector(".source-badge").textContent = card.dataset.source === "microsoft" ? "Microsoft 365 Managed Service" : group;
            card.querySelector("button").setAttribute("aria-label", "View details for " + name);
            grid.append(card);
        }
        existing.forEach((card, id) => { if (!seen.has(id)) card.remove(); });
        cards = [...grid.querySelectorAll(".service[data-service]")];
        $("service-load-state").hidden = true;
        return cards;
    }

    function renderItems(items, type) {
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
            const match = filter === "all" || filter === card.dataset.source || (filter === "affected" &&
                (["advisory", "degraded", "outage", "maintenance"].some(s => card.classList.contains(s)) ||
                    latest?.incidents?.some(i => i.serviceId === card.dataset.service && i.impact === "confirmed")));
            card.hidden = !match || !(card.querySelector("h3").textContent + " " + card.querySelector(".service-description").textContent).toLowerCase().includes(query);
            if (!card.hidden) count++;
        }
        document.querySelectorAll(".service-group-heading").forEach(h => { h.hidden = !cards.some(c => c.dataset.group === h.dataset.group && !c.hidden); });
        $("service-count").textContent = count + " of " + cards.length + " services shown";
        $("filter-empty").hidden = count !== 0;
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
        if (card.dataset.source === "microsoft") html += "<p>Microsoft reports service health. Local impact assessments appear on each notice below.</p>";
        if (!latest) html += "<p>Live status could not be loaded.</p>";
        html += "<h3>Current notices</h3>" + renderItems(latest?.incidents?.filter(i => i.serviceId === selected), "service");
        for (const [type, label] of [["maintenance", "Maintenance"], ["history", "Resolved incidents"]]) {
            const items = latest?.[type]?.filter(i => i.serviceId === selected) || [];
            if (items.length) html += "<h3>" + label + "</h3>" + renderItems(items, type);
        }
        replace("service-dialog-content", html);
    }
    function update(data) {
        latest = data;
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
        if ($("service-dialog").open) renderDialog();
    }
    function unavailable() {
        latest = null; applyFilters();
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
    window.PTGView = { renderItems, update, unavailable, syncServices };
})();
