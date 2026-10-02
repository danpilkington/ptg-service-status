"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function createIntegrationHealth(clock = Date.now) {
    const records = new Map(), jobs = new Map();
    function configure(id, enabled = true) {
        records.set(id, { enabled, state: enabled ? "waiting" : "disabled", lastAttemptAt: null,
            lastSuccessAt: null, lastEventAt: null, failures: 0, message: "", running: false });
    }
    async function run(id, action, failureMessage, eventCount = () => 0) {
        if (jobs.has(id)) return jobs.get(id);
        const record = records.get(id);
        if (!record?.enabled) return null;
        record.lastAttemptAt = new Date(clock()).toISOString(); record.running = true;
        const job = Promise.resolve().then(action).then(value => {
            record.state = "healthy"; record.lastSuccessAt = new Date(clock()).toISOString();
            record.failures = 0; record.message = "";
            if (eventCount(value)) record.lastEventAt = record.lastSuccessAt;
            return value;
        }, error => {
            record.state = "error"; record.failures++; record.message = failureMessage;
            throw error;
        }).finally(() => { record.running = false; jobs.delete(id); });
        jobs.set(id, job); return job;
    }
    function snapshot() {
        return Object.fromEntries([...records].map(([id, r]) => [id, { ...r,
            state: r.enabled && r.state === "healthy" && clock() - Date.parse(r.lastSuccessAt) > 180000 ? "stale" : r.state }]));
    }
    return { configure, run, snapshot };
}

function createMicrosoftCache({ load, health, clock = Date.now, file = null, interval = 60000 }) {
    let snapshot = null, attemptedAt = null, pending = null, loaded = false, refreshFailed = false;
    async function restore() {
        if (loaded) return; loaded = true;
        if (!file) return;
        try {
            const saved = JSON.parse(await fs.readFile(file, "utf8"));
            if (saved.version === 1 && Number.isFinite(Date.parse(saved.checkedAt)) && Date.parse(saved.checkedAt) <= clock()
                && Array.isArray(saved.services) && Array.isArray(saved.incidents) && Array.isArray(saved.maintenance)) snapshot = saved;
        } catch (error) { if (error.code !== "ENOENT") console.error("Microsoft cache could not be restored."); }
    }
    async function refresh() {
        await restore();
        attemptedAt = clock();
        try {
            const data = await health.run("microsoft", load, "Microsoft health could not be refreshed. Check Graph access and connectivity.");
            if (!data) { refreshFailed = true; return; }
            snapshot = { version: 1, ...data, checkedAt: new Date(clock()).toISOString() };
            refreshFailed = false;
            if (file) {
                const temp = file + "." + randomUUID() + ".tmp";
                try { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(temp, JSON.stringify(snapshot), { flag: "wx", mode: 0o600 }); await fs.rename(temp, file); }
                catch { console.error("Microsoft cache could not be saved. Last known data remains available until restart."); }
                finally { await fs.unlink(temp).catch(() => {}); }
            }
        } catch { refreshFailed = true; }
    }
    async function get() {
        if (pending) await pending;
        else if (attemptedAt === null || clock() - attemptedAt >= interval) {
            pending = refresh(); try { await pending; } finally { pending = null; }
        }
        const stale = !snapshot || refreshFailed || clock() - Date.parse(snapshot.checkedAt) > 120000;
        return { data: snapshot ? structuredClone(snapshot) : null, stale,
            checkedAt: snapshot?.checkedAt || null, available: !!snapshot && !stale };
    }
    return { get };
}

async function readiness({ storage, monitor, automation, clock = Date.now }) {
    let timeout;
    let storageOk = false;
    try {
        await Promise.race([Promise.all(["status", "users"].map(async name => {
            const raw = await storage.read(name); if (name === "status" && raw === null) throw new Error("Missing status");
            const value = JSON.parse(raw || "[]");
            if (name === "users" ? !Array.isArray(value) : !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid document");
        })), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Storage timeout")), 3000); })]);
        storageOk = true;
    } catch {} finally { clearTimeout(timeout); }
    const worker = monitor.workerHealth();
    const monitorOk = worker.started && !worker.error && !!worker.lastCompletedAt && clock() - Date.parse(worker.lastCompletedAt) < 90000;
    const automationOk = !!automation.lastCompletedAt && clock() - Date.parse(automation.lastCompletedAt) < 180000 && !automation.error;
    const ready = storageOk && monitorOk && automationOk;
    return { status: ready ? "ready" : "not-ready", checks: { storage: storageOk, monitoring: monitorOk, automation: automationOk } };
}
module.exports = { createIntegrationHealth, createMicrosoftCache, readiness };
