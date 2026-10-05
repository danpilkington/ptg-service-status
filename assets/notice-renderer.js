(function(root){"use strict";
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
root.PTGNotices={renderItems};
})(typeof window!=="undefined"?window:globalThis);