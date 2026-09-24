"use strict";
const { randomUUID } = require("node:crypto");
const phases = ["investigating", "identified", "monitoring", "resolved"];
const impacts = ["unknown", "confirmed", "not-affected"];
const optionalText = (value, max) => value === undefined || (typeof value === "string" && value.length <= max);
const isDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const clean = value => typeof value === "string" ? value.trim() : "";
const correctionFields = ["message", "phase", "impact", "workaround", "nextUpdateAt"];
function validDetails(item) {
    return (!item.phase || phases.includes(item.phase)) &&
        (item.impact === undefined || impacts.includes(item.impact)) &&
        optionalText(item.workaround, 3000) && optionalText(item.pendingUpdate, 5000) &&
        (item.nextUpdateAt === undefined || item.nextUpdateAt === "" || isDate(item.nextUpdateAt));
}
function normaliseIncident(item) {
    return { ...item, phase: item.phase || "investigating", impact: item.impact || "unknown",
        workaround: item.workaround || "", nextUpdateAt: item.nextUpdateAt || "",
        updates: Array.isArray(item.updates) ? item.updates : [] };
}
function validUpdateCorrections(corrections, updates = []) {
    if (corrections === undefined) return true;
    if (!Array.isArray(corrections) || corrections.length > updates.length) return false;
    const existing = new Set(updates.map(update => update.id));
    return new Set(corrections.map(correction => correction?.id)).size === corrections.length && corrections.every(correction =>
        correction && typeof correction.id === "string" && existing.has(correction.id) &&
        typeof correction.message === "string" && correction.message.trim().length > 0 && correction.message.length <= 5000 &&
        phases.includes(correction.phase) && impacts.includes(correction.impact) &&
        optionalText(correction.workaround, 3000) &&
        (correction.nextUpdateAt === "" || isDate(correction.nextUpdateAt)));
}
function validUpdateDeletions(deletions, updates = [], corrections = []) {
    if (deletions === undefined) return true;
    if (!Array.isArray(deletions) || deletions.length > updates.length || new Set(deletions).size !== deletions.length) return false;
    const existing = new Set(updates.map(update => update.id));
    const corrected = new Set((corrections || []).map(correction => correction.id));
    return deletions.every(id => typeof id === "string" && existing.has(id) && !corrected.has(id));
}
function applyUpdateCorrections(updates, corrections) {
    const byId = new Map((corrections || []).map(correction => [correction.id, correction]));
    return updates.map(update => {
        const correction = byId.get(update.id);
        if (!correction) return update;
        return { ...update, ...Object.fromEntries(correctionFields.map(field => [field,
            field === "message" || field === "workaround" ? clean(correction[field]) : correction[field]])) };
    });
}
function saveIncident(input, previous, service, now) {
    const before = previous && normaliseIncident(previous);
    const result = { id: input.id, title: clean(input.title), message: clean(input.message),
        serviceId: input.serviceId, service, source: "PTG", start: previous?.start || input.start,
        phase: input.phase || before?.phase || "investigating",
        impact: input.impact || before?.impact || "unknown",
        workaround: clean(input.workaround ?? before?.workaround),
        nextUpdateAt: input.nextUpdateAt ?? before?.nextUpdateAt ?? "" };
    if (result.phase === "resolved") result.nextUpdateAt = "";
    const changed = !before || ["title", "message", "serviceId", "phase", "impact", "workaround", "nextUpdateAt"].some(k => result[k] !== before[k]) || !!clean(input.pendingUpdate);
    // History is built from persisted data, never from client-supplied timestamps or updates.
    let updates = before ? [...before.updates] : [];
    if (before && !updates.length) updates.push({ id: randomUUID(), at: before.updatedAt || before.start,
        phase: before.phase, impact: before.impact, message: before.message,
        workaround: before.workaround, nextUpdateAt: before.nextUpdateAt });
    if (before) {
        const deleted = new Set(input.deletedUpdateIds || []);
        updates = applyUpdateCorrections(updates.filter(update => !deleted.has(update.id)), input.updateCorrections);
    }
    if (changed) updates.push({ id: randomUUID(), at: now, phase: result.phase, impact: result.impact,
        message: clean(input.pendingUpdate) || result.message, workaround: result.workaround, nextUpdateAt: result.nextUpdateAt });
    result.updatedAt = changed ? now : before.updatedAt || before.start;
    result.updates = updates;
    if (result.phase === "resolved") result.resolvedAt = before?.phase === "resolved" ? before.resolvedAt || now : now;
    return result;
}
function saveAssessment(input, previous, now) {
    const result = { id: input.id, impact: input.impact, note: clean(input.note),
        workaround: clean(input.workaround), nextUpdateAt: input.nextUpdateAt || "" };
    const changed = !previous || ["impact", "note", "workaround", "nextUpdateAt"].some(k => result[k] !== (previous[k] || ""));
    result.updatedAt = changed ? now : previous.updatedAt;
    result.updates = [...(previous?.updates || [])];
    if (changed) result.updates.push({ id: randomUUID(), at: now, impact: result.impact,
        message: result.note || "PTG impact assessment updated.", workaround: result.workaround, nextUpdateAt: result.nextUpdateAt });
    return result;
}
function applyAssessments(issues, assessments = []) {
    const byId = new Map(assessments.map(item => [item.id, item]));
    return issues.map(issue => {
        const local = byId.get(issue.id);
        return { ...issue, impact: local?.impact || "unknown", ptgNote: local?.note || "",
            workaround: local?.workaround || "", nextUpdateAt: local?.nextUpdateAt || "",
            assessmentUpdatedAt: local?.updatedAt || "", updates: local?.updates || [] };
    });
}
module.exports = { phases, impacts, isDate, optionalText, validDetails, validUpdateCorrections, validUpdateDeletions, applyUpdateCorrections, normaliseIncident, saveIncident, saveAssessment, applyAssessments };
