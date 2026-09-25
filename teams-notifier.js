"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const webhookHosts = ["logic.azure.com", "api.powerplatform.com", "webhook.office.com"];

function parseHttpsUrl(value, name, restrictHost = false) {
    let parsed;
    try { parsed = new URL(String(value || "").trim()); }
    catch { throw new Error(name + " must be a valid HTTPS URL."); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
        throw new Error(name + " must be an HTTPS URL without credentials or a fragment.");
    }
    if (restrictHost && !webhookHosts.some(host => parsed.hostname === host || parsed.hostname.endsWith("." + host))) {
        throw new Error(name + " must be a Microsoft Teams Workflow or Incoming Webhook URL.");
    }
    return parsed.toString();
}

function configuration(env = process.env) {
    const webhook = String(env.TEAMS_WEBHOOK_URL || "").trim();
    if (!webhook) return null;
    return {
        webhookUrl: parseHttpsUrl(webhook, "TEAMS_WEBHOOK_URL", true),
        statusPageUrl: env.TEAMS_STATUS_PAGE_URL ? parseHttpsUrl(env.TEAMS_STATUS_PAGE_URL, "TEAMS_STATUS_PAGE_URL") : ""
    };
}

function serviceKey(service) {
    return (service.source || "PTG") + ":" + service.id;
}

function card(service, event, occurredAt, statusPageUrl) {
    const name = service.name || service.serviceName || service.id;
    const recovery = event === "recovery";
    const status = recovery ? "operational" : String(service.status || "unknown");
    const content = {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard",
        version: "1.4",
        msteams: { width: "Full" },
        body: [
            { type: "TextBlock", size: "Large", weight: "Bolder", color: recovery ? "Good" : "Attention",
                text: recovery ? `✅ ${name} has recovered` : `🚨 ${name} service alert`, wrap: true },
            { type: "TextBlock", text: recovery ? `${name} has returned to Operational.` : `${name} is no longer Operational.`, wrap: true },
            { type: "FactSet", facts: [
                { title: "Status", value: status },
                { title: "Detail", value: recovery ? "Service recovery detected automatically." : (service.statusText || "No additional detail supplied") },
                { title: "Source", value: service.source || "PTG" },
                { title: recovery ? "Recovered" : "Detected", value: occurredAt }
            ] },
            { type: "TextBlock", text: "This notification was created automatically by the PTG service status application.",
                wrap: true, isSubtle: true, spacing: "Medium" }
        ]
    };
    if (statusPageUrl) content.actions = [{ type: "Action.OpenUrl", title: "View PTG service status", url: statusPageUrl }];
    return { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null, content }] };
}

function createTeamsNotifier(options = {}) {
    const env = options.env || process.env;
    const config = configuration(env);
    const request = options.fetch || globalThis.fetch;
    const stateFile = options.stateFile || env.TEAMS_STATE_FILE || path.join(__dirname, "teams-state.json");
    let statePromise;
    let queue = Promise.resolve();

    async function loadState() {
        if (!statePromise) statePromise = fs.readFile(stateFile, "utf8").then(JSON.parse).catch(error => {
            if (error.code === "ENOENT") return { version: 1, services: {} };
            throw new Error("Teams notification state could not be read: " + error.message);
        });
        return statePromise;
    }

    async function saveState(state) {
        const temporary = stateFile + "." + randomUUID() + ".tmp";
        await fs.mkdir(path.dirname(stateFile), { recursive: true });
        try {
            await fs.writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { flag: "wx", mode: 0o600 });
            await fs.rename(temporary, stateFile);
        } finally { await fs.unlink(temporary).catch(() => {}); }
    }

    async function post(service, event, occurredAt) {
        const response = await request(config.webhookUrl, {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify(card(service, event, occurredAt, config.statusPageUrl)),
            signal: AbortSignal.timeout(10000)
        });
        const body = await response.text();
        if (!response.ok) throw new Error(`Microsoft Teams returned HTTP ${response.status}: ${body.slice(0, 300)}`);
    }

    async function run(services) {
        if (!config) return { enabled: false, notified: [], recovered: [] };
        const state = await loadState();
        if (!state.services || typeof state.services !== "object") state.services = {};
        const currentKeys = new Set(services.map(serviceKey));
        let changed = false;
        for (const [key, previous] of Object.entries(state.services)) {
            if (!currentKeys.has(key) && previous.active) {
                state.services[key] = { ...previous, active: false, status: "absent" };
                changed = true;
            }
        }
        if (changed) await saveState(state);

        const recovered = [];
        for (const service of services) {
            if (service.status !== "operational") continue;
            const key = serviceKey(service), previous = state.services[key];
            if (previous?.active) {
                const recoveredAt = new Date().toISOString();
                await post(service, "recovery", recoveredAt);
                state.services[key] = { ...previous, active: false, status: "operational", recoveredAt };
                await saveState(state);
                recovered.push({ serviceId: service.id });
            } else if (previous?.status !== "operational") {
                state.services[key] = { ...previous, active: false, status: "operational" };
                await saveState(state);
            }
        }

        const notified = [];
        for (const service of services) {
            if (service.status === "operational" || service.status === "unknown") continue;
            const key = serviceKey(service);
            if (state.services[key]?.active) continue;
            const detectedAt = new Date().toISOString();
            await post(service, "alert", detectedAt);
            state.services[key] = { active: true, status: String(service.status), notifiedAt: detectedAt };
            await saveState(state);
            notified.push({ serviceId: service.id });
        }
        return { enabled: true, notified, recovered };
    }

    return {
        enabled: !!config,
        reconcile(services) {
            const operation = queue.then(() => run(Array.isArray(services) ? services : []));
            queue = operation.catch(() => {});
            return operation;
        }
    };
}

module.exports = { configuration, card, createTeamsNotifier };
