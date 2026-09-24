(() => {
    "use strict";

    function setupAdminTabs() {
        const tabs = [...document.querySelectorAll("[data-admin-tab]")];
        if (!tabs.length) return;

        const activate = id => {
            tabs.forEach(tab => {
                const active = tab.dataset.adminTab === id;
                tab.setAttribute("aria-selected", String(active));
                tab.tabIndex = active ? 0 : -1;
                const panel = document.getElementById(tab.dataset.adminTab);
                if (panel) panel.hidden = !active;
            });
            history.replaceState(null, "", `#${id}`);
        };

        tabs.forEach((tab, index) => {
            tab.addEventListener("click", () => activate(tab.dataset.adminTab));
            tab.addEventListener("keydown", event => {
                if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + tabs.length) % tabs.length;
                tabs[next].focus();
                activate(tabs[next].dataset.adminTab);
            });
        });

        document.addEventListener("click", event => {
            const control = event.target.closest("[data-open-admin-tab]");
            if (!control) return;
            const id = control.dataset.openAdminTab;
            const tab = tabs.find(item => item.dataset.adminTab === id);
            if (!tab) return;
            event.preventDefault(); activate(id); tab.focus();
            document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
        });

        const requested = location.hash.slice(1);
        activate(tabs.some(tab => tab.dataset.adminTab === requested) ? requested : tabs[0].dataset.adminTab);
    }

    setupAdminTabs();
    const $ = id => document.getElementById(id);
    const labels = { operational: "Operational", degraded: "Degraded performance", advisory: "Service advisory", outage: "Service outage", maintenance: "Maintenance", unknown: "Status unavailable" };
    const phases = { investigating: "Investigating", identified: "Identified", monitoring: "Monitoring", resolved: "Resolved" };
    const impacts = { unknown: "Impact not confirmed", confirmed: "Affecting PTG", "not-affected": "No PTG impact confirmed" };
    let key = "", data = null, revision = "", dirty = false, busy = false, editingId = null, publicIssues = [];
    const changedForms = new Set();
    let baseline = null, editingMaintenance = null, editingService = null, editingTimeline = null;
    let publishedIds = new Set();
    let healthResults = {};
    const credentialEdits = new Map();
    const format = value => {
        const parsed = new Date(value);
        if (!value || Number.isNaN(parsed.getTime())) return "Not set";
        const pad = part => String(part).padStart(2, "0");
        return `${pad(parsed.getDate())}/${pad(parsed.getMonth() + 1)}/${parsed.getFullYear()} ` +
            `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}`;
    };
    const formatTime = value => {
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) return "";
        const pad = part => String(part).padStart(2, "0");
        return `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}`;
    };
    const localDate = value => {
        if (!value) return "";
        const d = new Date(value);
        return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    };
    const text = (tag, content, className) => {
        const el = document.createElement(tag);
        el.textContent = content;
        if (className) el.className = className;
        return el;
    };
    function button(name, action) {
        const el = text("button", name, "secondary"); el.type = "button";
        el.addEventListener("click", action); return el;
    }
    function feedback(message, error = false) {
        $("feedback").textContent = message; $("feedback").classList.toggle("error", error);
    }
    function markDirty(value = true) {
        dirty = baseline ? changes().length > 0 : value;
        renderReview();
        $("publish").disabled = !dirty || busy;
        $("save-state").textContent = dirty ? "Draft" : "Published";
        $("draft-label").textContent = dirty ? "You have unpublished changes" : "All changes published";
    }
    const hasUnsaved = () => dirty || changedForms.size > 0;

    function changes() {
        if (!baseline || !data) return [];
        const result = [];
        for (const service of data.services) {
            const old = baseline.services.find(s => s.id === service.id);
            const fields = ["name", "description", "status", "group", "order"].filter(k => !old || (old[k] ?? "") !== (service[k] ?? ""));
            if (fields.length) result.push({ title: service.name, detail: old ? "Updated service" : "New service",
                fields: fields.map(k => k + ": " + (old ? (k === "status" ? labels[old.status] : old[k] ?? "Not set") + " → " : "") + (k === "status" ? labels[service.status] : service[k] ?? "Not set")) });
        }
        for (const service of baseline.services.filter(old => !data.services.some(s => s.id === old.id))) {
            result.push({title: service.name, detail: "Removed service", fields: ["This service will no longer appear on the dashboard. Resolved incident history is retained."]});
        }
        if (JSON.stringify(data.announcement || null) !== JSON.stringify(baseline.announcement || null)) result.push({title: "Site announcement", detail: data.announcement ? "Updated announcement" : "Removed announcement", fields: [data.announcement ? data.announcement.title + ": " + data.announcement.message + " · " + data.announcement.level + " · Expires: " + format(data.announcement.expiresAt) : "The public banner will be removed."]});
        for (const service of data.services) {
            const old = baseline.services.find(s=>s.id===service.id);
            if (JSON.stringify(old?.monitor || null) !== JSON.stringify(service.monitor || null)) result.push({title:service.name,detail:"Changed health check",fields:[service.monitor ? service.monitor.type.toUpperCase()+" "+(service.monitor.type==="supabase"?service.monitor.projectRef:service.monitor.target)+(service.monitor.port?":"+service.monitor.port:"")+" every "+service.monitor.interval+"s"+(service.monitor.paused?" (paused)":"") : "Manual availability"]});
        }
        const names = { autoStatus: "Automatic maintenance status", title: "Title", message: "Details", serviceId: "Service", phase: "Stage", impact: "PTG impact",
            workaround: "Workaround", nextUpdateAt: "Next update", start: "Starts", end: "Ends", pendingUpdate: "New timeline entry", note: "PTG guidance" };
        const value = (item, field) => item?.[field] || (field === "phase" ? "investigating" : field === "impact" ? "unknown" : "");
        const display = (field, v) => field === "autoStatus" ? (v ? "Enabled" : "Disabled") : field === "phase" ? phases[v] : field === "impact" ? impacts[v] :
            field === "serviceId" ? data.services.find(s => s.id === v)?.name || v :
            ["nextUpdateAt", "start", "end"].includes(field) && v ? format(v) : v || "Not set";
        for (const [type, label, fields] of [
            ["incidents", "Incident", ["title", "serviceId", "message", "phase", "impact", "workaround", "nextUpdateAt", "pendingUpdate"]],
            ["maintenance", "Maintenance", ["title", "serviceId", "message", "start", "end", "autoStatus"]],
            ["microsoftAssessments", "Microsoft assessment", ["impact", "note", "workaround", "nextUpdateAt"]]
        ]) {
            const oldItems = baseline[type] || [], current = data[type] || [];
            for (const item of current) {
                const old = oldItems.find(i => i.id === item.id);
                const changed = fields.filter(field => !old || value(old, field) !== value(item, field));
                if (changed.length) result.push({ title: item.title || item.id, detail: (old ? "Updated " : "New ") + label.toLowerCase(),
                    fields: changed.map(field => names[field] + ": " + (old ? display(field, value(old, field)) + " → " : "") + display(field, value(item, field))) });
                for (const correction of item.updateCorrections || []) {
                    const original = old?.updates?.find(update => update.id === correction.id);
                    result.push({ title: item.title || item.id, detail: "Corrected published timeline update",
                        fields: [format(original?.at), "Message: " + (original?.message || "Not set") + " → " + correction.message] });
                }
                for (const updateId of item.deletedUpdateIds || []) {
                    const original = old?.updates?.find(update => update.id === updateId);
                    result.push({ title: item.title || item.id, detail: "Delete published timeline update",
                        fields: [format(original?.at), original?.message || "Update unavailable"] });
                }
            }
            for (const old of oldItems.filter(i => !current.some(n => n.id === i.id))) result.push({ title: old.title || old.id, detail: "Removed " + label.toLowerCase(), fields: ["This notice will be removed when published."] });
        }
        return result;
    }
    function renderReview() {
        if (!data) return;
        const list = changes(), container = $("change-list"); container.replaceChildren();
        $("change-count").textContent = list.length;
        if (!list.length) container.append(text("p", "No staged changes. Your workspace matches the published status.", "empty-state"));
        for (const change of list) {
            const details = document.createElement("details");
            details.className = "change-item";
            details.append(text("summary", change.detail + " · " + change.title));
            change.fields.forEach(value => details.append(text("p", value)));
            container.append(details);
        }
        renderDashboard(); renderAttention(); renderHealthResults();
    }
    function renderDashboard() {
        if (!data || !$("admin-overview")) return;
        const counts = data.services.reduce((totals, service) => {
            totals[service.status] = (totals[service.status] || 0) + 1; return totals;
        }, {});
        $("dashboard-operational").textContent = counts.operational || 0;
        $("dashboard-affected").textContent = ["degraded", "advisory", "outage", "maintenance"].reduce((total, state) => total + (counts[state] || 0), 0);
        $("dashboard-unknown").textContent = counts.unknown || 0;
        $("dashboard-change-total").textContent = changes().length;
        $("dashboard-published").textContent = format(data.publishedAt);
        $("dashboard-live-state").textContent = dirty ? "Draft changes" : "Published state";
        $("dashboard-live-state").classList.toggle("draft", dirty);

        if (data.announcement) {
            $("dashboard-announcement").textContent = data.announcement.title;
            $("dashboard-announcement-detail").textContent = (data.announcement.level || "info").replace(/^./, value => value.toUpperCase()) +
                (data.announcement.expiresAt ? " · Expires " + format(data.announcement.expiresAt) : " · No expiry set");
        } else {
            $("dashboard-announcement").textContent = "No site-wide announcement";
            $("dashboard-announcement-detail").textContent = "The public banner is currently clear.";
        }

        const incidents = data.incidents.filter(incident => incident.phase !== "resolved")
            .sort((a, b) => Date.parse(b.updatedAt || b.start) - Date.parse(a.updatedAt || a.start));
        if (incidents.length) {
            const latest = incidents[0];
            $("dashboard-incident-summary").textContent = incidents.length + " active incident" + (incidents.length === 1 ? "" : "s");
            $("dashboard-incident-detail").textContent = (latest.service || latest.serviceId) + " · " + (phases[latest.phase] || "Investigating") + " · " + latest.title;
        } else {
            $("dashboard-incident-summary").textContent = "No active incidents";
            $("dashboard-incident-detail").textContent = "There are no active PTG incident notices.";
        }

        const now = Date.now();
        const maintenance = [...data.maintenance].filter(item => Date.parse(item.end) > now)
            .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
        const active = maintenance.find(item => Date.parse(item.start) <= now) || maintenance[0];
        if (active) {
            const inProgress = Date.parse(active.start) <= now;
            $("dashboard-maintenance-summary").textContent = inProgress ? "Maintenance in progress" : "Next: " + active.title;
            $("dashboard-maintenance-detail").textContent = (active.service || active.serviceId) + " · " +
                (inProgress ? "Ends " + format(active.end) : "Starts " + format(active.start));
        } else {
            $("dashboard-maintenance-summary").textContent = "No upcoming maintenance";
            $("dashboard-maintenance-detail").textContent = "No scheduled window is currently active or upcoming.";
        }
    }
    function renderAttention() {
        const container = $("attention-items"); container.replaceChildren();
        const now = Date.now();
        const overdue = data.incidents.filter(i => i.phase !== "resolved" && i.nextUpdateAt && Date.parse(i.nextUpdateAt) < now);
        const providerDue = data.microsoftAssessments.filter(a => publicIssues.some(i => i.id === a.id) && a.nextUpdateAt && Date.parse(a.nextUpdateAt) < now);
        const ended = data.maintenance.filter(i => Date.parse(i.end) < now);
        const upcoming = data.maintenance.filter(i => Date.parse(i.start) > now && Date.parse(i.start) < now + 86400000);
        const unassessed = publicIssues.filter(i => !data.microsoftAssessments.some(a => a.id === i.id && a.impact !== "unknown"));
        const entries = [
            [overdue.length, "incident updates overdue", "#manage-incidents"],
            [providerDue.length, "Microsoft updates overdue", "#manage-microsoft"],
            [ended.length, "maintenance windows ended — review notices", "#manage-maintenance"],
            [upcoming.length, "maintenance windows in the next 24 hours", "#manage-maintenance"],
            [unassessed.length, "Microsoft issues awaiting an impact decision", "#manage-microsoft"]
        ];
        for (const [count, label, href] of entries) if (count) {
            const link = text("a", count + " " + label, "attention-link"); link.href = href; link.dataset.openAdminTab = href.slice(1); container.append(link);
        }
        if (!container.children.length) container.append(text("p", "No outstanding items in the loaded information.", "empty-state"));
    }

    function editService(service = null) {
        editingService = service?.id || null;
        $("service-form").reset(); changedForms.delete("service-form");
        $("service-editor-title").textContent = service ? "Edit service" : "Add a service";
        $("service-name").value = service?.name || "";
        $("service-description").value = service?.description || "";
        $("service-group").value = service?.group || "";
        $("service-order").value = service?.order ?? 100;
        $("service-check-type").value = service?.monitor?.type || "manual";
        $("service-check-target").value = service?.monitor?.target || "";
        $("service-supabase-project").value = service?.monitor?.projectRef || "xlbmpqyjpsnfvbgxsvql";
        document.querySelectorAll(".service-supabase-service").forEach(input => input.checked = service?.monitor?.services?.includes(input.value) || false);
        $("service-check-port").value = service?.monitor?.port || "";
        $("service-check-interval").value = String(service?.monitor?.interval || 60);
        $("service-check-paused").checked = service?.monitor?.paused || false;
        $("service-api-key").value = "";
        $("service-api-auth").value = "";
        $("service-api-clear").checked = false;
        $("service-api-expect").value = service?.monitor?.expectedText || "";
        $("service-api-method").value = service?.monitor?.method || "GET";
        $("service-api-saved").textContent = [service?.monitor?.hasApiKey ? "API key saved" : "", service?.monitor?.hasAuthorization ? "Authorization saved" : ""].filter(Boolean).join(" · ") || "No published credentials saved.";
        checkFields();
        $("service-initial-status").value = service?.status || "unknown";
        $("service-reference").textContent = service ? "Reference: " + service.id : "A permanent reference will be created when you add the service.";
        $("service-editor").showModal();
    }
    function removeService(service) {
        if (data.incidents.some(i => i.serviceId === service.id && i.phase !== "resolved") ||
            data.maintenance.some(i => i.serviceId === service.id)) {
            feedback("Resolve or reassign this service's active incidents, and remove or reassign its maintenance notices before removing it.", true);
            return;
        }
        if (["incident", "maintenance"].some(type => changedForms.has(type + "-form") && $(type + "-service").value === service.id)) {
            feedback("Save or clear the open notice form for this service before removing it.", true); return;
        }
        if (!confirm("Remove " + service.name + " from the dashboard when you publish? Resolved incident history will be kept.")) return;
        data.services = data.services.filter(s => s.id !== service.id);
        renderServiceCatalog(); counts(); markDirty();
        feedback("Service removal staged. Publish changes to update the public dashboard.");
    }
    function closeServiceEditor() {
        if (changedForms.has("service-form") && !confirm("Discard these unsaved service details?")) return;
        changedForms.delete("service-form"); $("service-editor").close();
    }

    function resetMaintenanceForm() {
        $("maintenance-form").reset(); editingMaintenance = null;
        $("maintenance-save").textContent = "Add maintenance to draft";
        $("maintenance-editor-title").textContent = "Schedule maintenance";
        $("maintenance-cancel").textContent = "Clear form";
        changedForms.delete("maintenance-form");
    }
    function editMaintenance(item) {
        if (changedForms.has("maintenance-form") && !confirm("Discard the current maintenance form changes?")) return;
        resetMaintenanceForm(); editingMaintenance = item.id;
        $("maintenance-service").value = item.serviceId;
        $("maintenance-title").value = item.title; $("maintenance-message").value = item.message;
        $("maintenance-auto").checked = item.autoStatus === true;
        $("maintenance-start").value = localDate(item.start); $("maintenance-end").value = localDate(item.end);
        $("maintenance-editor-title").textContent = "Edit maintenance";
        $("maintenance-save").textContent = "Save maintenance to draft"; $("maintenance-cancel").textContent = "Cancel edit";
        $("maintenance-title").focus(); $("maintenance-form").scrollIntoView({block:"center",behavior:"smooth"});
    }
    function filterMicrosoft() {
        const query = $("microsoft-search").value.trim().toLowerCase();
        let count = 0;
        $("microsoft-issues").querySelectorAll(":scope > details").forEach(details => {
            details.hidden = !details.dataset.search.includes(query);
            if (!details.hidden) count++;
        });
        $("microsoft-empty").hidden = count !== 0 || !publicIssues.length;
    }

    async function request(method = "GET") {
        const response = await fetch("/api/admin/status", {
            method, cache: "no-store", signal: AbortSignal.timeout(20000),
            headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
            ...(method === "PUT" ? { body: JSON.stringify({ revision, data: {...data,services:data.services.map(service=>({...service,monitor:service.monitor?{...service.monitor,...(credentialEdits.get(service.id)||{})}:null}))} }) } : {})
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Unable to connect to the publishing service.");
        if (method === "GET" && result.editorVersion !== 7) throw new Error("The publishing server needs a restart to enable this updated admin page. Restart the Node server, then connect again.");
        return result;
    }
    function timeline(item) {
        const details = document.createElement("details");
        const pending = new Set(item.deletedUpdateIds || []);
        const remaining = (item.updates?.length || 0) - pending.size;
        details.append(text("summary", "Published timeline (" + remaining + (pending.size ? ", " + pending.size + " pending deletion" : "") + ")"));
        const list = text("ol", "", "timeline");
        for (const update of [...(item.updates || [])].reverse()) {
            const li = document.createElement("li");
            li.append(text("strong", (phases[update.phase] || impacts[update.impact] || "Update") + " · " + format(update.at)),
                text("p", update.message));
            if (update.id && pending.has(update.id)) {
                li.classList.add("pending-deletion");
                li.append(text("p", "This update will be deleted when the draft is published.", "deletion-note"),
                    button("Undo deletion", () => undoTimelineDeletion(item.id, update.id)));
            } else if (update.id) {
                const remove = button("Delete published update", () => deleteTimelineUpdate(item.id, update.id));
                remove.classList.add("danger");
                li.append(button("Edit published update", () => editTimelineUpdate(item.id, update.id)), remove);
            }
            list.append(li);
        }
        details.append(list); return details;
    }
    function deleteTimelineUpdate(incidentId, updateId) {
        const item = data.incidents.find(incident => incident.id === incidentId);
        const update = item?.updates?.find(entry => entry.id === updateId);
        if (!update) return feedback("That published update is no longer available. Reload the workspace and try again.", true);
        if (!confirm("Delete the published update from " + format(update.at) + "? This remains reversible until you publish the draft.")) return;
        item.deletedUpdateIds = [...new Set([...(item.deletedUpdateIds || []), updateId])];
        item.updateCorrections = (item.updateCorrections || []).filter(correction => correction.id !== updateId);
        const original = baseline.incidents.find(incident => incident.id === incidentId)?.updates?.find(entry => entry.id === updateId);
        const index = item.updates.findIndex(entry => entry.id === updateId);
        if (original && index >= 0) item.updates[index] = structuredClone(original);
        renderEvents("incidents"); counts(); markDirty();
        feedback("Published update deletion staged. Publish changes to remove it, or use Undo deletion.");
    }
    function undoTimelineDeletion(incidentId, updateId) {
        const item = data.incidents.find(incident => incident.id === incidentId);
        if (!item) return;
        item.deletedUpdateIds = (item.deletedUpdateIds || []).filter(id => id !== updateId);
        if (!item.deletedUpdateIds.length) delete item.deletedUpdateIds;
        renderEvents("incidents"); counts(); markDirty();
        feedback("Timeline update deletion undone.");
    }
    function editTimelineUpdate(incidentId, updateId) {
        const item = data.incidents.find(incident => incident.id === incidentId);
        const update = item?.updates?.find(entry => entry.id === updateId);
        if (!update) return feedback("That published update is no longer available. Reload the workspace and try again.", true);
        editingTimeline = { incidentId, updateId };
        $("timeline-published").textContent = format(update.at); $("timeline-published").dateTime = update.at;
        $("timeline-message").value = update.message || "";
        $("timeline-phase").value = update.phase || "investigating";
        $("timeline-impact").value = update.impact || "unknown";
        $("timeline-workaround").value = update.workaround || "";
        $("timeline-next-update").value = localDate(update.nextUpdateAt);
        $("timeline-editor").showModal(); $("timeline-message").focus();
    }
    function closeTimelineEditor() {
        editingTimeline = null; $("timeline-form").reset(); $("timeline-editor").close();
    }
    function resetIncidentForm() {
        $("incident-form").reset(); editingId = null;
        $("incident-editor-title").textContent = "Create an incident";
        $("incident-save").textContent = "Add incident to draft";
        $("incident-cancel").hidden = false; $("incident-cancel").textContent = "Clear form"; $("update-note-field").hidden = true;
        changedForms.delete("incident-form");
    }
    function editIncident(item) {
        if (changedForms.has("incident-form") && !confirm("Discard the current incident form changes?")) return;
        resetIncidentForm(); editingId = item.id;
        $("incident-editor-title").textContent = "Edit incident / add update";
        if (!data.services.some(s => s.id === item.serviceId)) $("incident-service").add(new Option(item.service + " (removed service)", item.serviceId));
        for (const field of ["service", "title", "message", "phase", "impact", "workaround"]) {
            $("incident-" + field).value = field === "service" ? item.serviceId :
                item[field] || (field === "phase" ? "investigating" : field === "impact" ? "unknown" : "");
        }
        $("incident-next-update").value = localDate(item.nextUpdateAt);
        $("incident-save").textContent = "Save incident to draft";
        $("incident-cancel").hidden = false; $("incident-cancel").textContent = "Cancel edit"; $("update-note-field").hidden = false;
        $("incident-update").value = item.pendingUpdate || "";
        $("incident-form").scrollIntoView({ behavior: "smooth", block: "center" });
        $("incident-title").focus({ preventScroll: true });
    }
    function renderEvents(type) {
        const container = $(type); container.replaceChildren();
        const query = $("incident-search").value.trim().toLowerCase(), phase = $("incident-filter").value;
        const items = type === "incidents" ? data.incidents.filter(i => (phase === "all" || (i.phase || "investigating") === phase) && (i.title + " " + i.service + " " + i.message).toLowerCase().includes(query)) : data[type];
        if (!items.length) container.append(text("p", "No " + (type === "incidents" ? "incident" : "maintenance") + " notices.", "help"));
        const archive = document.createElement("details");
        archive.open = phase === "resolved" || !!query;
        archive.append(text("summary", "Resolved incident history (" + items.filter(i => i.phase === "resolved").length + ")"));
        for (const item of items) {
            const article = text("article", "", "incident");
            article.append(text("div", item.service + " · " + format(item.start) + (item.end ? " – " + format(item.end) : ""), "incident-meta"),
                text("h3", item.title), text("p", item.message));
            if (type === "incidents") {
                article.append(text("p", (phases[item.phase || "investigating"]) + " · " + impacts[item.impact || "unknown"], "impact-note"));
                if (item.pendingUpdate) article.append(text("p", "Draft update: " + item.pendingUpdate));
                article.append(button(publishedIds.has(item.id) ? "Edit published notice / add update" : "Edit draft incident", () => editIncident(item)), timeline(item));
                if (!publishedIds.has(item.id)) article.append(button("Remove draft incident", () => {
                    data.incidents = data.incidents.filter(i => i.id !== item.id);
                    if (editingId === item.id) resetIncidentForm();
                    markDirty(); renderEvents("incidents"); counts();
                }));
                if (item.phase === "resolved") archive.append(article); else container.append(article);
            } else {
                article.append(button(baseline?.maintenance?.some(event => event.id === item.id) ? "Edit published maintenance" : "Edit draft maintenance", () => editMaintenance(item)));
                article.append(button("Remove notice", () => {
                    if (editingMaintenance === item.id) resetMaintenanceForm();
                    data.maintenance = data.maintenance.filter(event => event.id !== item.id);
                    markDirty(); renderEvents(type); counts();
                }));
                container.append(article);
            }
        }
        if (type === "incidents" && items.some(i => i.phase === "resolved")) container.append(archive);
    }
    function counts() {
        $("service-total").textContent = data.services.length;
        $("incident-total").textContent = data.incidents.filter(i => i.phase !== "resolved").length;
        $("maintenance-total").textContent = data.maintenance.length;
        renderReview();
    }
    function field(form, name, caption, value, type = "textarea") {
        const id = form.id + "-" + name;
        const label = text("label", caption); label.htmlFor = id;
        const input = document.createElement(type === "datetime-local" ? "input" : type);
        input.id = id; input.name = name;
        if (type === "datetime-local") input.type = type;
        if (type === "textarea") { input.rows = 2; input.maxLength = name === "workaround" ? 3000 : 5000; }
        input.value = value || ""; form.append(label, input); return input;
    }
    function renderMicrosoft() {
        const container = $("microsoft-issues"); container.replaceChildren();
        publicIssues.forEach((issue, index) => {
            const saved = data.microsoftAssessments.find(a => a.id === issue.id) || { impact: "unknown" };
            const details = document.createElement("details");
            details.dataset.search = (issue.service + " " + issue.title + " " + issue.id).toLowerCase();
            details.append(text("summary", issue.service + " · " + issue.title));
            details.append(text("p", issue.message), text("p", "Microsoft reference: " + issue.id, "help"));
            const form = document.createElement("form"); form.id = "assessment-" + index;
            const select = field(form, "impact", "PTG impact", "", "select");
            for (const [value, label] of Object.entries(impacts)) select.add(new Option(label, value));
            select.value = saved.impact;
            field(form, "note", "PTG assessment / guidance", saved.note);
            field(form, "workaround", "Workaround", saved.workaround);
            field(form, "nextUpdateAt", "Next PTG update (your local time)", localDate(saved.nextUpdateAt), "datetime-local");
            const submit = text("button", "Save assessment to draft", "secondary"); submit.type = "submit";
            form.append(submit, button("Reset assessment form", () => {
                const current = data.microsoftAssessments.find(a => a.id === issue.id) || { impact: "unknown" };
                for (const name of ["impact", "note", "workaround", "nextUpdateAt"]) {
                    form.elements.namedItem(name).value = name === "nextUpdateAt" ? localDate(current[name]) : current[name] || "";
                }
                changedForms.delete(form.id);
            }));
            form.addEventListener("input", () => changedForms.add(form.id));
            form.addEventListener("submit", event => {
                event.preventDefault();
                const values = new FormData(form), next = values.get("nextUpdateAt");
                const assessment = { id: issue.id, impact: values.get("impact"), note: values.get("note").trim(),
                    workaround: values.get("workaround").trim(), nextUpdateAt: next ? new Date(next).toISOString() : "" };
                const previous = data.microsoftAssessments.findIndex(a => a.id === issue.id);
                if (previous < 0) data.microsoftAssessments.push(assessment);
                else data.microsoftAssessments[previous] = { ...data.microsoftAssessments[previous], ...assessment };
                changedForms.delete(form.id); markDirty();
                feedback("Microsoft assessment staged. Publish changes to make it visible.");
            });
            details.append(form); container.append(details);
        });
        filterMicrosoft(); renderAttention();
    }
    async function loadMicrosoft() {
        try {
            const response = await fetch("/api/status", { cache: "no-store", signal: AbortSignal.timeout(20000) });
            if (!response.ok) throw new Error("Status unavailable");
            const result = await response.json();
            if (!result.microsoftAvailable) throw new Error("Microsoft unavailable");
            publicIssues = (result.incidents || []).filter(i => i.source === "Microsoft");
            renderMicrosoft();
            $("microsoft-feedback").textContent = publicIssues.length ? publicIssues.length + " active Microsoft issues. Assessments are separate from Microsoft's status." : "No active Microsoft issues reported.";
        } catch {
            renderAttention();
            $("microsoft-feedback").textContent = "Microsoft issues could not be refreshed. Existing assessments are preserved; PTG editing is still available.";
        }
    }
    function renderServiceCatalog() {
        const selected = { incident: $("incident-service").value, maintenance: $("maintenance-service").value };
        $("services").replaceChildren();
        $("select-all-services").textContent = "Select all";
        for (const id of ["incident-service", "maintenance-service"]) $(id).replaceChildren();
        for (const service of [...data.services].sort((a,b) => (a.order ?? 100) - (b.order ?? 100))) {
            const card = text("article", "", "service " + service.status);
            const head = text("div", "", "service-header");
            const pill = text("span", labels[service.status], "pill " + service.status);
            head.append(text("h3", service.name || service.id), pill);
            const label = text("label", "Availability"); label.htmlFor = "status-" + service.id;
            const select = document.createElement("select"); select.id = label.htmlFor;
            for (const [value, name] of Object.entries(labels)) select.add(new Option(name, value));
            select.value = service.status;
            select.addEventListener("change", () => {
                service.status = select.value; service.statusText = labels[select.value];
                pill.textContent = service.statusText; pill.className = "pill " + select.value;
                card.className = "service " + select.value; markDirty();
            });
            const bulkLabel = text("label", "", "bulk-choice");
            const check = document.createElement("input"); check.type = "checkbox"; check.dataset.bulkService = service.id;
            check.setAttribute("aria-label", "Select " + (service.name || service.id));
            bulkLabel.append(check, text("span", "Select service"));
            const actions = text("div", "", "actions service-actions");
            actions.append(button("Edit service", () => editService(service)), button("Remove service", () => removeService(service)));
            const diagnostic = text("p", "", "health-result"); diagnostic.dataset.healthService = service.id;
            card.append(diagnostic);
            card.append(bulkLabel, head, text("p", (service.group || "Progressive Technology Managed Services ") + " · Order " + (service.order ?? 100), "help"), label, select, actions); $("services").append(card);
            for (const id of ["incident-service", "maintenance-service"]) $(id).add(new Option(service.name || service.id, service.id));
        }

        for (const type of ["incident", "maintenance"]) {
            const select = $(type + "-service");
            if (type === "incident" && editingId && selected.incident && !data.services.some(s => s.id === selected.incident)) {
                const old = data.incidents.find(i => i.id === editingId);
                if (old && old.serviceId === selected.incident) select.add(new Option(old.service + " (removed service)", old.serviceId));
            }
            if ([...select.options].some(o => o.value === selected[type])) select.value = selected[type];
        }
        if (!data.services.length) $("services").append(text("p", "No PTG services yet. Add a service to start publishing its health.", "empty-state"));
    }

    function render() {
        data.microsoftAssessments ||= [];
        const descriptions = { "company-portal": "PTG application and device enrolment experience", vpn: "Secure remote access to PTG resources", network: "PTG office connectivity", "meeting-rooms": "Room calendars, panels and meeting spaces", freshservice: "PTG IT support portal" };
        data.services.forEach(service => { service.description ??= descriptions[service.id] || ""; service.group ??= ""; service.order ??= 100; });
        baseline = structuredClone(data);
        publishedIds = new Set(data.incidents.map(i => i.id));
        $("connection").hidden = true; $("editor").hidden = false;
        $("published").textContent = format(data.publishedAt); $("published").dateTime = data.publishedAt;
        renderServiceCatalog();
        changedForms.clear(); resetIncidentForm(); resetMaintenanceForm(); renderAnnouncement();
        counts(); renderEvents("incidents"); renderEvents("maintenance"); renderMicrosoft(); markDirty(false);
    }
    async function run(action) {
        if (busy) return;
        busy = true;
        document.querySelectorAll("button, input, select, textarea").forEach(el => el.disabled = true);
        try { await action(); }
        catch (error) { feedback(error.message + " Your draft has not been discarded.", true); }
        finally {
            busy = false;
            document.querySelectorAll("button, input, select, textarea").forEach(el => el.disabled = false);
            $("publish").disabled = !dirty;
        }
    }
    async function load() {
        const result = await request();
        data = result.data; revision = result.revision; render();
        feedback("Published status loaded. Changes stay in this workspace until you publish.");
        await loadMicrosoft();
        await loadHealthResults();
        offerRecovery();
    }
    let editingUser = null, signedInUserId = null;
    async function accountRequest(route, method = "GET", body) {
        const response = await fetch("/api/admin/" + route, {
            method, headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
            cache: "no-store", ...(body ? { body: JSON.stringify(body) } : {})
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Unable to save account.");
        return result;
    }
    function clearUserForm() {
        editingUser = null; $("user-form").reset(); $("user-password").required = true;
        $("user-editor-title").textContent = "Create user";
    }
    async function loadUsers() {
        const { users } = await accountRequest("users");
        $("users-list").replaceChildren();
        for (const user of users) {
            const row = text("article", "", "user-account");
            row.append(text("strong", user.firstName + " " + user.lastName),
                text("p", user.jobTitle),
                text("p", user.username + " · " + (user.role === "admin" ? "Administrator" : "Editor") + " · " + (user.active ? "Enabled" : "Disabled")),
                button("Edit account", () => {
                    editingUser = user.id;
                    for (const field of ["username", "firstName", "lastName", "jobTitle", "role"]) $("user-" + field).value = user[field];
                    $("user-active").checked = user.active; $("user-password").value = ""; $("user-password").required = false;
                    $("user-editor-title").textContent = "Edit " + user.username; $("user-username").focus();
                }));
            $("users-list").append(row);
        }
        if (!users.length) $("users-list").append(text("p", "No individual accounts yet. Create an administrator to get started."));
    }
    async function loadAccount() {
        const { user } = await accountRequest("me");
        signedInUserId = user.id;
        const admin = user.role === "admin";
        $("manage-users").hidden = !admin; $("users-nav").hidden = !admin;
        if (admin) await loadUsers();
    }
    $("login-form").addEventListener("submit", event => {
        event.preventDefault();
        run(async () => {
            const result = await accountRequest("login", "POST", { username: $("login-username").value, password: $("login-password").value });
            key = result.token; $("login-password").value = "";
            await load(); await loadAccount();
        });
    });
    $("user-form").addEventListener("submit", event => {
        event.preventDefault();
        run(async () => {
            const body = {};
            for (const field of ["username", "firstName", "lastName", "jobTitle", "role", "password"]) body[field] = $("user-" + field).value;
            body.active = $("user-active").checked;
            try {
                await accountRequest("users" + (editingUser ? "/" + encodeURIComponent(editingUser) : ""), editingUser ? "PUT" : "POST", body);
                if (editingUser === signedInUserId && body.password) {
                    const login = await accountRequest("login", "POST", { username: body.username, password: body.password });
                    key = login.token;
                }
                clearUserForm(); $("users-feedback").textContent = "Account saved.";
                await loadUsers();
            } catch (error) { $("users-feedback").textContent = error.message; throw error; }
        });
    });
    $("user-clear").addEventListener("click", clearUserForm);
    $("users-refresh").addEventListener("click", () => run(loadUsers));
    $("connect-form").addEventListener("submit", event => {
        event.preventDefault(); key = $("admin-key").value;
        run(async () => { await load(); $("admin-key").value = ""; await loadAccount(); });
    });
    for (const type of ["incident", "maintenance"]) {
        $(type + "-form").addEventListener("input", () => changedForms.add(type + "-form"));
        $(type + "-form").addEventListener("submit", event => {
            event.preventDefault();
            const title = $(type + "-title").value.trim(), message = $(type + "-message").value.trim();
            if (!title || !message) return feedback("Enter a title and description.", true);
            let service = data.services.find(s => s.id === $(type + "-service").value);
            const previous = type === "incident" && editingId ? data.incidents.find(i => i.id === editingId) :
                type === "maintenance" && editingMaintenance ? data.maintenance.find(i => i.id === editingMaintenance) : null;
            if (!service && type === "incident" && previous && $("incident-phase").value === "resolved" && $("incident-service").value === previous.serviceId) service = { id: previous.serviceId, name: previous.service };
            if (!service) return feedback("Choose an active service. To reopen an incident for a removed service, assign it to an existing service first.", true);
            const item = { ...previous, id: previous?.id || crypto.randomUUID(), title, message,
                serviceId: service.id, service: service.name, source: "PTG", start: previous?.start || new Date().toISOString() };
            if (type === "maintenance") {
                const start = new Date($("maintenance-start").value), end = new Date($("maintenance-end").value);
                if (!(end > start)) return feedback("Maintenance must end after its start time.", true);
                item.start = start.toISOString(); item.end = end.toISOString(); item.autoStatus = $("maintenance-auto").checked;
            } else {
                item.phase = $("incident-phase").value; item.impact = $("incident-impact").value;
                item.workaround = $("incident-workaround").value.trim();
                const next = $("incident-next-update").value;
                item.nextUpdateAt = next && item.phase !== "resolved" ? new Date(next).toISOString() : "";
                item.pendingUpdate = $("incident-update").value.trim();
            }
            const collection = type === "incident" ? "incidents" : "maintenance";
            if (previous) data[collection][data[collection].findIndex(i => i.id === item.id)] = item;
            else data[collection].push(item);
            renderEvents(collection); counts(); markDirty();
            changedForms.delete(type + "-form");
            if (type === "incident") resetIncidentForm(); else resetMaintenanceForm();
            feedback(item.phase === "resolved" ? "Resolution staged. Check service availability above, then publish." : "Notice saved to draft. Publish changes to make it visible.");
        });
    }
    $("incident-cancel").addEventListener("click", () => {
        if (!changedForms.has("incident-form") || confirm("Discard changes in this incident form?")) resetIncidentForm();
    });
    $("maintenance-cancel").addEventListener("click", () => {
        if (changedForms.has("maintenance-form") && !confirm("Clear the unsaved maintenance form?")) return;
        resetMaintenanceForm();
    });
    $("timeline-form").addEventListener("submit", event => {
        event.preventDefault();
        const item = editingTimeline && data.incidents.find(incident => incident.id === editingTimeline.incidentId);
        const index = item?.updates?.findIndex(update => update.id === editingTimeline.updateId) ?? -1;
        if (!item || index < 0) return closeTimelineEditor();
        const message = $("timeline-message").value.trim();
        if (!message) return feedback("Enter an update message.", true);
        const next = $("timeline-next-update").value;
        const correction = { id: editingTimeline.updateId, message, phase: $("timeline-phase").value,
            impact: $("timeline-impact").value, workaround: $("timeline-workaround").value.trim(),
            nextUpdateAt: next ? new Date(next).toISOString() : "" };
        item.updates[index] = { ...item.updates[index], ...correction };
        const original = baseline.incidents.find(incident => incident.id === item.id)?.updates?.find(update => update.id === correction.id);
        const fields = ["message", "phase", "impact", "workaround", "nextUpdateAt"];
        const changed = fields.some(field => (correction[field] || "") !== (original?.[field] || ""));
        item.updateCorrections = (item.updateCorrections || []).filter(entry => entry.id !== correction.id);
        if (changed) item.updateCorrections.push(correction);
        closeTimelineEditor(); renderEvents("incidents"); counts(); markDirty();
        feedback(changed ? "Published update correction staged. Publish changes to make it live." : "The correction matched the published update, so no change was staged.");
    });
    $("timeline-close").addEventListener("click", closeTimelineEditor);
    $("timeline-cancel").addEventListener("click", closeTimelineEditor);
    $("publish").addEventListener("click", () => {
        if (changedForms.size) return feedback("Save or cancel your open form changes before publishing the draft.", true);
        if(data.services.some(s=>s.monitor?.credentialsChanged&&!credentialEdits.has(s.id)))return feedback("Re-enter API credentials for the recovered draft before publishing, or explicitly remove saved credentials.",true);
        run(async () => {
            const result = await request("PUT");
            clearRecovery(); credentialEdits.clear();
            data = result.data; revision = result.revision; render();
            await loadHealthResults();
            feedback("Changes published successfully. The main status page now uses this update.");
        });
    });
    $("reload").addEventListener("click", () => {
        if (hasUnsaved() && !confirm("Discard unpublished changes and reload the published status?")) return;
        clearRecovery(); credentialEdits.clear(); run(load);
    });
    $("refresh-microsoft").addEventListener("click", () => {
        if ([...changedForms].some(id => id.startsWith("assessment-"))) return feedback("Save assessment form changes before refreshing Microsoft issues.", true);
        run(loadMicrosoft);
    });
    $("disconnect").addEventListener("click", () => {
        if (hasUnsaved() && !confirm("Discard unpublished changes and disconnect?")) return;
        clearRecovery(); credentialEdits.clear();
        $("service-api-key").value="";$("service-api-auth").value="";
        accountRequest("logout", "POST").catch(() => {}); clearUserForm(); $("users-list").replaceChildren(); $("users-feedback").textContent = ""; $("login-password").value = "";
        key = ""; data = null; baseline = null; revision = ""; dirty = false; publicIssues = []; changedForms.clear();
        $("editor").hidden = true; $("connection").hidden = false; $("admin-key").value = "";
        $("published").textContent = "Connect to load"; $("published").removeAttribute("datetime");
        feedback("Signed out."); $("login-username").focus();
    });
    $("preview").addEventListener("click", () => {
        const container = $("preview-content"); container.replaceChildren();
        if (data.announcement) container.append(text("h3", "Announcement · " + data.announcement.level), text("p", data.announcement.title + "\n" + data.announcement.message), text("p", "Expires: " + format(data.announcement.expiresAt)));
        container.append(text("h3", "Service availability"));
        data.services.forEach(s => container.append(text("p", s.name + ": " + labels[s.status])));
        for (const [title, items] of [["Incident notices", data.incidents], ["Maintenance", data.maintenance], ["Microsoft assessments", data.microsoftAssessments]]) {
            container.append(text("h3", title));
            if (!items.length) container.append(text("p", "None."));
            items.forEach(item => {
                const article = text("article", "", "incident");
                article.append(text("h4", item.title || item.id), text("p", item.message || item.note || ""),
                    text("p", [phases[item.phase], impacts[item.impact]].filter(Boolean).join(" · ")));
                if (item.workaround) article.append(text("p", "Workaround: " + item.workaround));
                if (item.nextUpdateAt) article.append(text("p", "Next update: " + format(item.nextUpdateAt)));
                if (item.pendingUpdate) article.append(text("p", "New timeline update: " + item.pendingUpdate));
                container.append(article);
            });
        }
        $("preview-dialog").showModal();
    });


    $("add-service").addEventListener("click", () => editService());
    $("cancel-service").addEventListener("click", closeServiceEditor);
    $("service-editor").addEventListener("cancel", event => { event.preventDefault(); closeServiceEditor(); });
    $("service-form").addEventListener("input", () => changedForms.add("service-form"));
    $("service-form").addEventListener("submit", event => {
        event.preventDefault();
        const name = $("service-name").value.trim(), description = $("service-description").value.trim();
        if (!name) return feedback("Enter a service name.", true);
        const status = $("service-initial-status").value;
        const old = data.services.find(s => s.id === editingService);
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "service";
        const mode = $("service-check-type").value;
        const monitor = mode === "manual" ? null : {type:mode,target:$("service-check-target").value.trim(),interval:Number($("service-check-interval").value),paused:$("service-check-paused").checked,...(mode==="tcp"?{port:Number($("service-check-port").value)}:{}),...(mode==="supabase"?{projectRef:$("service-supabase-project").value,services:[...document.querySelectorAll(".service-supabase-service:checked")].map(input=>input.value)}:{})};
        if (mode === "supabase" && !monitor.services.length) return feedback("Select at least one Supabase service to monitor.",true);
        if (monitor && !["http","supabase"].includes(mode) && (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(monitor.target) || monitor.target.split(".").some(n=>Number(n)>255))) return feedback("Enter a valid internal IPv4 address for the health check.",true);
        const item = { ...old, monitor, id: old?.id || slug + "-" + crypto.randomUUID().slice(0, 8), name, description,
            group: $("service-group").value.trim(), order: Number($("service-order").value), status, statusText: labels[status], source: "PTG" };
        if (mode === "http") {
            let url;try{url=new URL(monitor.target);}catch{return feedback("Enter a plain HTTP/HTTPS API URL, without Markdown formatting.",true);}
            if(!["http:","https:"].includes(url.protocol))return feedback("Use an HTTP/HTTPS URL.",true);
            monitor.expectedText=$("service-api-expect").value;
            monitor.method=$("service-api-method").value;
            monitor.hasApiKey=old?.monitor?.hasApiKey||false;monitor.hasAuthorization=old?.monitor?.hasAuthorization||false;
            const apiKey=$("service-api-key").value, authorization=$("service-api-auth").value;
            if(apiKey||authorization||$("service-api-clear").checked){
                const edits=$("service-api-clear").checked?{apiKey:"",authorization:""}:{...(credentialEdits.get(item.id)||{})};
                if(apiKey)edits.apiKey=apiKey;if(authorization)edits.authorization=authorization;
                credentialEdits.set(item.id,edits);monitor.credentialsChanged=crypto.randomUUID();
            } else if(old?.monitor?.credentialsChanged)monitor.credentialsChanged=old.monitor.credentialsChanged;
        } else credentialEdits.delete(item.id);
        $("service-api-key").value="";$("service-api-auth").value="";
        if (old) data.services[data.services.findIndex(s => s.id === old.id)] = item;
        else data.services.push(item);
        for (const incident of data.incidents) if (incident.serviceId === item.id && incident.phase !== "resolved") incident.service = name;
        for (const notice of data.maintenance) if (notice.serviceId === item.id) notice.service = name;
        changedForms.delete("service-form"); $("service-editor").close();
        renderServiceCatalog(); renderEvents("incidents"); renderEvents("maintenance"); counts(); markDirty();
        feedback((old ? "Service changes" : "New service") + " staged. Publish to update the public dashboard.");
    });

    $("incident-search").addEventListener("input", () => renderEvents("incidents"));
    $("incident-filter").addEventListener("change", () => renderEvents("incidents"));
    $("microsoft-search").addEventListener("input", filterMicrosoft);
    $("select-all-services").addEventListener("click", () => {
        const boxes = [...document.querySelectorAll("[data-bulk-service]")];
        const all = boxes.every(box => box.checked);
        boxes.forEach(box => { box.checked = !all; });
        $("select-all-services").textContent = all ? "Select all" : "Clear selection";
    });
    $("apply-bulk").addEventListener("click", () => {
        const selected = [...document.querySelectorAll("[data-bulk-service]:checked")];
        if (!selected.length) return feedback("Select one or more PTG services first.", true);
        const state = $("bulk-status").value;
        for (const checkbox of selected) {
            const select = $("status-" + checkbox.dataset.bulkService);
            select.value = state; select.dispatchEvent(new Event("change"));
            checkbox.checked = false;
        }
        $("select-all-services").textContent = "Select all";
        feedback(selected.length + " service changes staged. Review them before publishing.");
    });
    $("use-template").addEventListener("click", () => {
        if (changedForms.has("incident-form") && !confirm("Replace the unsaved incident form with this template?")) return;
        const serviceId = $("incident-service").value;
        const service = data.services.find(s => s.id === serviceId);
        resetIncidentForm(); $("incident-service").value = serviceId;
        const templates = {
            outage: ["Service unavailable", "We are investigating reports that this service is unavailable. We will share an update when we know more."],
            degraded: ["Slow or intermittent service", "We are investigating reports of slow or intermittent access. Please avoid repeated retries while we investigate."],
            signin: ["Sign-in problem", "We are investigating reports of sign-in difficulties. Please contact IT support if you are affected."]
        };
        const template = templates[$("incident-template").value];
        $("incident-title").value = (service?.name || "Service") + ": " + template[0];
        $("incident-message").value = template[1];
        $("incident-impact").value = "unknown";
        $("incident-next-update").value = localDate(new Date(Date.now() + 1800000).toISOString());
        changedForms.add("incident-form");
        feedback("Template loaded. Confirm the details and PTG impact, then add it to your draft.");
        $("incident-title").focus();
    });
    document.querySelectorAll("[data-next-minutes]").forEach(b => b.addEventListener("click", () => {
        $("incident-next-update").value = localDate(new Date(Date.now() + Number(b.dataset.nextMinutes) * 60000).toISOString());
        changedForms.add("incident-form");
    }));
    $("export-status").addEventListener("click", () => {
        const blob = new Blob([JSON.stringify(baseline, null, 2) + "\n"], { type: "application/json" });
        const url = URL.createObjectURL(blob), link = document.createElement("a");
        link.href = url; link.download = "ptg-published-status-" + new Date().toISOString().slice(0, 10) + ".json";
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        feedback("Published status downloaded. Unpublished drafts and your admin key are not included.");
    });



    function checkFields() {
        const mode = $("service-check-type").value;
        $("service-check-target").required = ["ping","tcp","http"].includes(mode);
        $("service-check-port").required = mode === "tcp";
        $("service-api-fields").hidden = mode !== "http";
        $("service-supabase-fields").hidden = mode !== "supabase";
    }
    $("service-check-type").addEventListener("change", checkFields);
    function renderHealthResults() {
        if(!data) return;
        document.querySelectorAll("[data-health-service]").forEach(el=>{
            const service=data.services.find(s=>s.id===el.dataset.healthService), config=service?.monitor;
            if(!config){el.textContent="Manual availability";return;}
            if(config.paused){el.textContent="Checks paused · saved availability is shown";return;}
            if(JSON.stringify(config)!==JSON.stringify(baseline?.services.find(s=>s.id===service.id)?.monitor)){el.textContent="Health check changes awaiting publication";return;}
            const state=healthResults[service.id];
            const target=config.type==="supabase"?config.projectRef:config.target;
            el.textContent=config.type.toUpperCase()+" · "+target+(config.port?":"+config.port:"")+" · "+(!state?"Waiting for background checks":(state.stale?"Results are stale":state.message)+" · "+format(state.checkedAt)+" · "+state.successes+" consecutive successes / "+state.failures+" failures"+(state.latencyMs!==null?" · "+state.latencyMs+"ms":""));
        });
    }
    async function loadHealthResults(){
        if(!key||!data)return;
        try {
            const response=await fetch("/api/admin/checks",{headers:{Authorization:"Bearer "+key},cache:"no-store",signal:AbortSignal.timeout(10000)});
            if(!response.ok)throw new Error("Unavailable");
            healthResults=(await response.json()).checks||{};renderHealthResults();
        } catch {
            document.querySelectorAll("[data-health-service]").forEach(el=>{if(data?.services.find(s=>s.id===el.dataset.healthService)?.monitor)el.textContent="Monitoring results unavailable; reconnect or check the server.";});
        }
    }
    window.setInterval(()=>{if(!busy)void loadHealthResults();},30000);

    function renderAnnouncement() {
        const a = data.announcement;
        $("announcement-title").value = a?.title || "";
        $("announcement-message").value = a?.message || "";
        $("announcement-level").value = a?.level || "info";
        $("announcement-expiry").value = localDate(a?.expiresAt);
        changedForms.delete("announcement-form");
    }
    $("announcement-form").addEventListener("input", () => changedForms.add("announcement-form"));
    $("announcement-form").addEventListener("submit", event => {
        event.preventDefault();
        const title = $("announcement-title").value.trim(), message = $("announcement-message").value.trim();
        if (!title || !message) return feedback("Enter an announcement title and message.", true);
        const expiry = $("announcement-expiry").value;
        data.announcement = {title, message, level: $("announcement-level").value, expiresAt: expiry ? new Date(expiry).toISOString() : ""};
        changedForms.delete("announcement-form"); markDirty(); feedback("Announcement staged. Publish to display the banner.");
    });
    $("announcement-cancel").addEventListener("click", renderAnnouncement);
    $("announcement-remove").addEventListener("click", () => {
        data.announcement = null; renderAnnouncement(); markDirty(); feedback("Announcement removal staged.");
    });

    const draftKey = "ptg-admin-draft-v1";
    let recovery = null;
    function clearRecovery() {
        try { localStorage.removeItem(draftKey); } catch {}
        recovery = null; $("draft-recovery").hidden = true;
    }
    function persistDraft() {
        if (!key || !data || busy || recovery) return;
        try {
            if (!hasUnsaved()) { localStorage.removeItem(draftKey); return; }
            const forms = {};
            for (const id of changedForms) {
                const form = $(id); if (!form) continue;
                forms[id] = [...form.querySelectorAll("input,select,textarea")].filter(el => el.id && el.type !== "password").map(el => ({id:el.id,value:el.value,checked:el.checked}));
            }
            localStorage.setItem(draftKey, JSON.stringify({version:1,savedAt:new Date().toISOString(),revision,data,baseline,forms,editingId,editingMaintenance,editingService}));
            $("draft-storage").textContent = "Draft saved in this browser at " + formatTime(new Date()) + ". The admin key is not saved. Disconnect clears this copy.";
        } catch {
            $("draft-storage").textContent = "This browser could not save the draft. Keep this tab open until you publish.";
        }
    }
    function offerRecovery() {
        try {
            const raw = localStorage.getItem(draftKey);
            recovery = raw ? JSON.parse(raw) : null;
            if (!recovery || recovery.version !== 1 || !Array.isArray(recovery.data?.services) || !recovery.baseline) { recovery = null; return; }
            $("draft-recovery").hidden = false;
            const stale = recovery.revision !== revision;
            $("draft-recovery-message").textContent = "Saved " + format(recovery.savedAt) + ". " + (stale ? "Published information has changed. Download this draft for reference and reapply the changes to the current version; automatic restore is blocked." : "Restore staged changes and unfinished forms, or discard this saved copy.");
            $("restore-draft").hidden = stale;
        } catch { recovery = null; $("draft-storage").textContent = "The saved draft could not be read."; }
    }
    $("discard-draft").addEventListener("click", () => { clearRecovery(); feedback("Saved recovery copy discarded."); });
    $("download-draft").addEventListener("click", () => {
        if (!recovery) return;
        const url = URL.createObjectURL(new Blob([JSON.stringify(recovery,null,2)], {type:"application/json"}));
        const link = document.createElement("a"); link.href = url; link.download = "ptg-unpublished-draft.json"; link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
    });
    $("restore-draft").addEventListener("click", () => {
        if (!recovery || recovery.revision !== revision) return;
        if (hasUnsaved() && !confirm("Replace current edits with the saved draft?")) return;
        const saved = recovery; recovery = null;
        data = saved.data; render(); baseline = saved.baseline;
        if (saved.editingId) { const item = data.incidents.find(i=>i.id===saved.editingId); if (item) editIncident(item); }
        if (saved.editingMaintenance) { const item = data.maintenance.find(i=>i.id===saved.editingMaintenance); if (item) editMaintenance(item); }
        if (saved.forms["service-form"]) editService(data.services.find(i=>i.id===saved.editingService));
        for (const [id, fields] of Object.entries(saved.forms)) {
            if (!$(id)) continue;
            for (const field of fields) { const el = $(field.id); if (el && $(id).contains(el) && el.type !== "password") { el.value = field.value; if (el.type === "checkbox") el.checked = field.checked; } }
            changedForms.add(id);
        }
        checkFields();
        $("draft-recovery").hidden = true; markDirty(); feedback("Draft restored. Save unfinished forms, review and publish when ready.");
        persistDraft();
    });
    document.addEventListener("input", () => queueMicrotask(persistDraft));
    document.addEventListener("change", () => queueMicrotask(persistDraft));
    document.addEventListener("click", () => queueMicrotask(persistDraft));
    document.addEventListener("submit", () => queueMicrotask(persistDraft));
    document.addEventListener("visibilitychange", () => { if (document.hidden) persistDraft(); });

    window.setInterval(() => { if (data) renderAttention(); }, 60000);
    $("close-preview").addEventListener("click", () => $("preview-dialog").close());
    window.addEventListener("beforeunload", event => {
        persistDraft();
        if (hasUnsaved()) { event.preventDefault(); event.returnValue = ""; }
    });
})();


