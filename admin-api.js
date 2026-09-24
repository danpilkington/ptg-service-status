"use strict";
const { createFileStorage, revision } = require("./storage");
const model = require("./incident-model");
const health = require("./health-monitor");
const states = new Set(["operational", "degraded", "advisory", "outage", "maintenance", "unknown"]);
const validText = (s, max) => typeof s === "string" && s.trim().length > 0 && s.length <= max;
const uniqueItems = (items, limit) => Array.isArray(items) && items.length <= limit &&
    items.every(i => i && validText(i.id, 100)) && new Set(items.map(i => i.id)).size === items.length;
module.exports = function attachAdmin(app, { statusFile, monitor, key = process.env.ADMIN_API_KEY, storage = createFileStorage(statusFile) }) {
    let writing = false;
    require("./user-auth")(app, { statusFile, key, storage });
    app.get("/api/admin/status", async (req, res, next) => {
        try {
            const raw = await storage.read("status");
            res.json({ data: health.redact(JSON.parse(raw)), revision: revision(raw), editorVersion: 5 });
        } catch (error) { next(error); }
    });
    app.get("/api/admin/checks", async (req,res,next)=>{
        try { const data=JSON.parse(await storage.read("status")); res.json({checks:monitor?monitor.details(data.services||[]):{}}); }
        catch(error){next(error);}
    });
    app.put("/api/admin/status", async (req, res, next) => {
        if (writing) return res.status(409).json({ error: "Another update is publishing. Reload before retrying." });
        writing = true;
        try {
            const raw = await storage.read("status");
            if (req.body?.revision !== revision(raw)) return res.status(409).json({ error: "Status has changed since you opened it. Reload and reapply your changes." });
            const current = JSON.parse(raw), input = req.body.data;
            const reservedIds = new Set(["microsoft-365", "exchange-online", "microsoft-teams", "sharepoint-online", "onedrive", "intune", "identity"]);
            const retired = current.retiredServices || [];
            const retiredIds = new Set(retired.map(s => s.id));
            if (!input || !uniqueItems(input.services, 100) || input.services.some(s =>
                !/^[a-z0-9][a-z0-9-]{0,79}$/.test(s.id) || reservedIds.has(s.id) || retiredIds.has(s.id) ||
                !validText(s.name, 100) || !model.optionalText(s.description, 500) || !model.optionalText(s.group, 60) || (s.order !== undefined && (!Number.isInteger(s.order) || s.order < 0 || s.order > 9999)) || !states.has(s.status))) {
                return res.status(400).json({ error: "Use unique service IDs, a name up to 100 characters, a description up to 500 characters, a group up to 60 characters, an order from 0 to 9999 and a valid status. Microsoft and retired service IDs are reserved." });
            }
            const monitors = new Map();
            try { for (const service of input.services) {
                let config=service.monitor;
                if(config?.type==="http"){
                    const old=current.services.find(s=>s.id===service.id)?.monitor;
                    if(old?.secret && config.apiKey===undefined && config.authorization===undefined) {
                        config={...config,secret:old.secret,hasApiKey:old.hasApiKey,hasAuthorization:old.hasAuthorization};
                        monitors.set(service.id,health.validate(config));continue;
                    }
                    const credentials = old?.type==="http" ? await require("./monitor-secrets").open(old) : {};
                    config={...config,secret:undefined,apiKey:config.apiKey===undefined?credentials.apiKey||"":config.apiKey,authorization:config.authorization===undefined?credentials.authorization||"":config.authorization};
                    config=await require("./monitor-secrets").seal(health.validate(config));
                }
                monitors.set(service.id,health.validate(config));
            } }
            catch(error){return res.status(400).json({error:error.message});}
            const announcement = input.announcement === undefined ? current.announcement || null : input.announcement;
            if (announcement !== null && (!validText(announcement.title, 160) || !validText(announcement.message, 2000) ||
                !["info", "warning", "urgent"].includes(announcement.level) ||
                (announcement.expiresAt && !model.isDate(announcement.expiresAt)))) {
                return res.status(400).json({error: "Check the announcement title, message, tone and expiry."});
            }
            const ids = new Set(input.services.map(s => s.id));
            const historicalReference = i => i.phase === "resolved" &&
                (current.incidents || []).some(old => old.id === i.id && old.serviceId === i.serviceId);
            for (const type of ["incidents", "maintenance"]) {
                const items = input[type];
                if (!uniqueItems(items, type === "incidents" ? 500 : 100) ||
                    items.some(i => !validText(i.title, 160) || !validText(i.message, 5000) ||
                        (!ids.has(i.serviceId) && !(type === "incidents" && historicalReference(i))) || !model.isDate(i.start) ||
                        (type === "incidents" && !model.validDetails(i)) ||
                        (type === "maintenance" && ((i.autoStatus !== undefined && typeof i.autoStatus !== "boolean") || !model.isDate(i.end) || Date.parse(i.end) <= Date.parse(i.start))))) {
                    return res.status(400).json({ error: "Check notice details and dates. Resolve or reassign active incidents and remove or reassign maintenance before removing a service. Maintenance must end after it starts." });
                }
            }
            if ((current.incidents || []).some(i => !input.incidents.some(n => n.id === i.id))) {
                return res.status(400).json({ error: "Published incidents cannot be deleted. Resolve the incident to retain its history." });
            }
            const assessments = input.microsoftAssessments ?? current.microsoftAssessments ?? [];
            if (!uniqueItems(assessments, 500) || assessments.some(i =>
                !model.impacts.includes(i.impact) || !model.optionalText(i.note, 5000) ||
                !model.validDetails(i))) {
                return res.status(400).json({ error: "Check Microsoft impact assessments and next-update dates." });
            }
            const labels = { operational: "Operational", degraded: "Degraded performance", advisory: "Service advisory", outage: "Service outage", maintenance: "Maintenance", unknown: "Status unavailable" };
            const now = new Date().toISOString();
            const output = { ...current, publishedAt: now, announcement: announcement ? {title: announcement.title.trim(), message: announcement.message.trim(), level: announcement.level, expiresAt: announcement.expiresAt || ""} : null };
            output.services = input.services.map(s => ({
                id: s.id, name: s.name.trim(), description: (s.description || "").trim(),
                group: (s.group || "").trim(), order: s.order ?? 100, monitor: monitors.get(s.id),
                status: s.status, statusText: labels[s.status], source: "PTG"
            }));
            output.retiredServices = [...retired, ...current.services.filter(s => !ids.has(s.id)).map(s => ({ id: s.id, name: s.name, removedAt: now }))];
            const serviceName = i => output.services.find(s => s.id === i.serviceId)?.name ||
                (current.incidents || []).find(old => old.id === i.id && old.serviceId === i.serviceId)?.service ||
                current.services.find(s => s.id === i.serviceId)?.name || i.serviceId;
            output.incidents = input.incidents.map(i => model.saveIncident(i,
                (current.incidents || []).find(old => old.id === i.id),
                i.phase === "resolved" ? (current.incidents || []).find(old => old.id === i.id && old.phase === "resolved" && old.serviceId === i.serviceId)?.service || serviceName(i) : serviceName(i), now));
            output.maintenance = input.maintenance.map(i => {
                const result = { id: i.id, title: i.title.trim(), message: i.message.trim(), serviceId: i.serviceId,
                    service: serviceName(i), source: "PTG",
                    start: i.start, end: i.end, autoStatus: i.autoStatus === true, status: "maintenance" };
                const old = (current.maintenance || []).find(x => x.id === i.id);
                result.updatedAt = old && Object.keys(result).every(k => result[k] === old[k]) ? old.updatedAt : now;
                return result;
            });
            output.microsoftAssessments = assessments.map(i => model.saveAssessment(i,
                (current.microsoftAssessments || []).find(old => old.id === i.id), now));
            const content = JSON.stringify(output, null, 2) + "\n";
            if (Buffer.byteLength(content) > 1800000) return res.status(400).json({ error: "The status archive is nearing its storage limit. Back up and archive older records before publishing more updates." });
            await storage.write("status", content, revision(raw));
            res.json({ data: health.redact(output), revision: revision(content) });
        } catch (error) { next(error); }
        finally {
            writing = false;
        }
    });
};

