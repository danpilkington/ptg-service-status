"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { configuration, createTeamsNotifier } = require("../teams-notifier");

const webhookUrl = "https://prod-12.ukwest.logic.azure.com/workflows/test/triggers/manual/paths/invoke?api-version=2016-10-01";
const env = { TEAMS_WEBHOOK_URL: webhookUrl, TEAMS_STATUS_PAGE_URL: "https://status.example.com/" };

test("Teams configuration is optional and accepts only Microsoft HTTPS webhook hosts", () => {
    assert.equal(configuration({}), null);
    assert.throws(() => configuration({ TEAMS_WEBHOOK_URL: "http://prod.example.com/hook" }), /HTTPS/);
    assert.throws(() => configuration({ TEAMS_WEBHOOK_URL: "https://example.com/hook" }), /Microsoft Teams/);
    assert.throws(() => configuration({ ...env, TEAMS_STATUS_PAGE_URL: "http://status.example.com" }), /HTTPS/);
    assert.equal(configuration(env).statusPageUrl, "https://status.example.com/");
});

test("Teams posts one alert and one recovery per non-operational episode across restarts", async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ptg-teams-"));
    const stateFile = path.join(directory, "state.json"), requests = [];
    const mockFetch = async (url, options) => { requests.push({ url, options }); return new Response("", { status: 202 }); };
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const degraded = { id: "vpn", name: "VPN Primary", source: "PTG", status: "degraded", statusText: "Packet loss" };
    let notifier = createTeamsNotifier({ env, stateFile, fetch: mockFetch });
    assert.equal((await notifier.reconcile([{ ...degraded, status: "operational" }])).notified.length, 0);
    assert.equal((await notifier.reconcile([degraded])).notified.length, 1);
    assert.equal((await notifier.reconcile([{ ...degraded, status: "outage" }])).notified.length, 0);
    assert.equal((await notifier.reconcile([{ ...degraded, status: "unknown" }])).notified.length, 0);
    notifier = createTeamsNotifier({ env, stateFile, fetch: mockFetch });
    assert.equal((await notifier.reconcile([degraded])).notified.length, 0);
    assert.equal((await notifier.reconcile([{ ...degraded, status: "operational" }])).recovered.length, 1);
    assert.equal((await notifier.reconcile([degraded])).notified.length, 1);
    assert.equal(requests.length, 3);
    assert.equal(requests[0].url, webhookUrl);
    const alert = JSON.parse(requests[0].options.body);
    assert.equal(alert.type, "message");
    assert.equal(alert.attachments[0].content.type, "AdaptiveCard");
    assert.match(JSON.stringify(alert), /VPN Primary service alert/);
    assert.match(JSON.stringify(alert), /Packet loss/);
    assert.match(JSON.stringify(alert), /View PTG service status/);
    assert.match(JSON.stringify(JSON.parse(requests[1].options.body)), /has recovered/);
});

test("Teams retries a failed alert and ignores unknown status", async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ptg-teams-retry-"));
    const stateFile = path.join(directory, "state.json"); let attempts = 0;
    const mockFetch = async () => { attempts++; return attempts === 1 ? new Response("unavailable", { status: 503 }) : new Response("", { status: 202 }); };
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const notifier = createTeamsNotifier({ env, stateFile, fetch: mockFetch });
    const outage = { id: "erp", name: "ERP", source: "PTG", status: "outage" };
    await assert.rejects(notifier.reconcile([outage]), /HTTP 503/);
    assert.equal((await notifier.reconcile([outage])).notified.length, 1);
    assert.equal((await notifier.reconcile([{ ...outage, id: "pending", status: "unknown" }])).notified.length, 0);
    assert.equal(attempts, 2);
});
