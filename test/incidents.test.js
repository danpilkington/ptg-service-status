"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const model = require("../incident-model");
const at = "2026-09-16T10:00:00.000Z";
const later = "2026-09-16T11:00:00.000Z";
const input = { id: "vpn-1", title: "VPN interruption", serviceId: "vpn", message: "Investigating connectivity.", start: at, phase: "investigating", impact: "confirmed", workaround: "Use the office network." };

test("incident stages retain server-owned history through resolution and reopening", () => {
    const initial = model.saveIncident({ ...input, updates: [{ message: "Forged", at: "2000-01-01" }] }, null, "VPN", at);
    assert.equal(initial.updates.length, 1);
    assert.equal(initial.updates[0].at, at);
    assert.equal(initial.updates[0].message, input.message);
    const updated = model.saveIncident({ ...initial, phase: "identified", pendingUpdate: "Gateway fault identified.", updates: [], nextUpdateAt: "2026-09-16T12:00:00Z" }, initial, "VPN", later);
    assert.equal(updated.updates.length, 2);
    assert.deepEqual(updated.updates[0], initial.updates[0]);
    assert.equal(updated.updates[1].message, "Gateway fault identified.");
    assert.equal(updated.phase, "identified");
    const same = model.saveIncident(updated, updated, "VPN", "2026-09-16T11:30:00Z");
    assert.equal(same.updatedAt, later);
    assert.deepEqual(same.updates, updated.updates);
    const resolved = model.saveIncident({ ...same, phase: "resolved", pendingUpdate: "Service restored." }, same, "VPN", "2026-09-16T12:00:00Z");
    assert.equal(resolved.nextUpdateAt, "");
    assert.equal(resolved.resolvedAt, "2026-09-16T12:00:00Z");
    assert.equal(resolved.updates.length, 3);
    const reopened = model.saveIncident({ ...resolved, phase: "investigating" }, resolved, "VPN", "2026-09-16T13:00:00Z");
    assert.equal(reopened.resolvedAt, undefined);
    assert.equal(reopened.updates.length, 4);
});

test("legacy notices remain readable and retain their original publication in the timeline", () => {
    const old = { id: "old", title: "Legacy issue", serviceId: "vpn", service: "VPN", source: "PTG", message: "Old message", start: at, updatedAt: at };
    const normal = model.normaliseIncident(old);
    assert.equal(normal.phase, "investigating"); assert.equal(normal.impact, "unknown");
    const saved = model.saveIncident({ ...old, message: "New message" }, old, "VPN", later);
    assert.equal(saved.updates.length, 2);
    assert.equal(saved.updates[0].message, "Old message");
    assert.equal(saved.updates[0].at, at);
});

test("Microsoft local assessments do not change provider health or descriptions", () => {
    const issue = { id: "MS1", source: "Microsoft", status: "degraded", message: "Provider description" };
    const unknown = model.applyAssessments([issue])[0];
    assert.equal(unknown.impact, "unknown");
    const assessment = model.saveAssessment({ id: "MS1", impact: "not-affected", note: "PTG checked; not affected.", workaround: "", nextUpdateAt: "" }, null, at);
    const result = model.applyAssessments([issue], [assessment])[0];
    assert.equal(result.status, "degraded");
    assert.equal(result.message, "Provider description");
    assert.equal(result.impact, "not-affected");
    assert.equal(result.ptgNote, "PTG checked; not affected.");
    const unchanged = model.saveAssessment(assessment, assessment, later);
    assert.equal(unchanged.updatedAt, at); assert.equal(unchanged.updates.length, 1);
    assert.equal(model.applyAssessments([{ ...issue, id: "MS2" }], [assessment])[0].impact, "unknown");
});

test("incident fields reject invalid stages, impacts, dates and excessive guidance", () => {
    assert.equal(model.validDetails({ phase: "invented" }), false);
    assert.equal(model.validDetails({ impact: "maybe" }), false);
    assert.equal(model.validDetails({ nextUpdateAt: "tomorrow" }), false);
    assert.equal(model.validDetails({ workaround: "x".repeat(3001) }), false);
    assert.equal(model.validDetails({ phase: "monitoring", impact: "unknown", nextUpdateAt: later }), true);
});
