(() => {
    "use strict";

    const API_URL = "/api/status";
    const REFRESH_INTERVAL_MS = 30 * 1000;

    const labels = {
        operational: "Operational",
        degraded: "Degraded performance",
        advisory: "Service advisory",
        outage: "Service outage",
        maintenance: "Maintenance",
        unknown: "Status unavailable"
    };

    const severity = {
        operational: 0,
        unknown: 1,
        maintenance: 2,
        advisory: 3,
        degraded: 4,
        outage: 5
    };

    let serviceCards = [];
    let requestedServiceHighlighted = false;

    function escapeHtml(value) {
        return String(value ?? "").replace(
            /[&<>"']/g,
            character => ({
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                "\"": "&quot;",
                "'": "&#39;"
            })[character]
        );
    }

    function normaliseState(value) {
        const state = String(value || "").toLowerCase();

        return Object.prototype.hasOwnProperty.call(labels, state)
            ? state
            : "unknown";
    }

    function formatDate(value) {
        if (!value) {
            return "";
        }

        const date = new Date(value);

        if (Number.isNaN(date.getTime())) {
            return String(value);
        }

        const pad = part => String(part).padStart(2, "0");
        return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ` +
            `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    function updateCard(service) {
        const card = serviceCards.find(
            item => item.dataset.service === service.id
        );

        if (!card) {
            return;
        }

        const state = normaliseState(service.status);
        const pill = card.querySelector(".pill");

        card.classList.remove(
            "operational",
            "degraded",
            "advisory",
            "outage",
            "maintenance",
            "unknown"
        );

        card.classList.add(state);

        if (pill) {
            pill.textContent = service.statusText || labels[state];

            pill.classList.remove(
                "operational",
                "degraded",
                "advisory",
                "outage",
                "maintenance",
                "unknown"
            );

            pill.classList.add(state);
        }

        card.title = service.serviceName
            ? `${service.serviceName}: ${service.statusText || labels[state]}`
            : service.statusText || labels[state];
    }

    function setUnavailable(card) {
        updateCard({
            id: card.dataset.service,
            status: "unknown",
            statusText: "Status unavailable"
        });
    }

    const renderItems = window.PTGView.renderItems;

    function determineOverallStatus(services) {
        if (!Array.isArray(services) || services.length === 0) {
            return "unknown";
        }

        return services.reduce((worstState, service) => {
            const currentState = normaliseState(service.status);

            return severity[currentState] > severity[worstState]
                ? currentState
                : worstState;
        }, "operational");
    }

    function updateManagedStatus(id, title, services) {
        const card = document.getElementById(id);
        if (!card) {
            return;
        }

        const state = determineOverallStatus(services);
        const statusTitle = {
            operational: "All systems operational",
            advisory: "Service advisory in effect",
            degraded: "Some services are degraded",
            outage: "A service outage is active",
            maintenance: "Maintenance is in progress",
            unknown: "Status unavailable"
        }[state];
        const summary = {
            operational: "All monitored services are operating normally.",
            advisory: "An advisory affects one or more services.",
            degraded: "One or more services are experiencing degraded performance.",
            outage: "One or more services are currently unavailable.",
            maintenance: "Maintenance is affecting one or more services.",
            unknown: "Service information is currently unavailable."
        }[state];

        card.className = `managed-status ${state}`;
        card.querySelector("h2").textContent = statusTitle;
        card.querySelector(".managed-status-summary").textContent = summary;
        card.querySelector(".managed-status-metric").textContent =
            `${labels[state]} · ${services.length} service${services.length === 1 ? "" : "s"}`;
        card.querySelector(".managed-status-icon").textContent =
            { operational: "✓", advisory: "!", degraded: "!", outage: "×", maintenance: "●", unknown: "?" }[state];
    }

    function updateManagedStatuses(services) {
        const microsoft = services.filter(service => service.source === "Microsoft");
        const ptg = services.filter(service => service.source !== "Microsoft");
        updateManagedStatus("microsoft-status", "Microsoft", microsoft);
        updateManagedStatus("ptg-status", "PTG", ptg);
    }

    function updateOverall(data) {
        const services = Array.isArray(data.services)
            ? data.services
            : [];

        updateManagedStatuses(services);

        const overallState = normaliseState(
            data.overall?.status || determineOverallStatus(services)
        );

        const titleByState = {
            operational: "All systems operational",
            advisory: "Service advisory in effect",
            degraded: "Some services are degraded",
            outage: "A service outage is active",
            maintenance: "Maintenance is in progress",
            unknown: "Some status information is unavailable"
        };

        const descriptionByState = {
            operational:
                "All monitored PTG and Microsoft services are operating normally.",
            advisory:
                "An advisory has been published for one or more services.",
            degraded:
                "One or more monitored services are experiencing degraded performance.",
            outage:
                "One or more monitored services are currently unavailable.",
            maintenance:
                "Maintenance is currently affecting one or more services.",
            unknown:
                "Some service information could not be retrieved. PTG-managed statuses may still be available."
        };

        const iconByState = {
            operational: "✓",
            advisory: "!",
            degraded: "!",
            outage: "×",
            maintenance: "●",
            unknown: "?"
        };

        const colours = {
            operational: ["#e9f8f1", "#15865a"],
            advisory: ["#fff4d6", "#a86500"],
            degraded: ["#fff4d6", "#a86500"],
            outage: ["#fff0ee", "#ba2d24"],
            maintenance: ["#f3edff", "#6d3bd1"],
            unknown: ["#eef2f5", "#5d6975"]
        };

        const overallMetric = document.getElementById("overall-metric");

        if (overallMetric) {
            overallMetric.textContent = labels[overallState];
        }
    }

    function updateTimestamp(value) {
        const timestamp = document.getElementById("updated");
        const date = new Date(value || Date.now());

        timestamp.classList.remove("error");
        timestamp.textContent = formatDate(date);

        if (!Number.isNaN(date.getTime())) {
            timestamp.dateTime = date.toISOString();
        }
    }

    function updateSupportUrls(supportUrls) {
        for (const [id, url] of Object.entries(supportUrls || {})) {
            const link = document.getElementById(`support-${id}`);

            if (link && /^https:\/\//i.test(url)) {
                link.href = url;
            }
        }
    }

    function highlightRequestedService() {
        const requestedService = new URLSearchParams(
            window.location.search
        ).get("service")?.trim().toLowerCase();

        if (!requestedService) {
            return;
        }

        const card = serviceCards.find(
            item => item.dataset.service === requestedService
        );

        if (!card) {
            return;
        }

        requestedServiceHighlighted = true;
        card.classList.add("selected");

        setTimeout(() => {
            card.scrollIntoView({
                behavior: "smooth",
                block: "center"
            });
        }, 100);
    }

    function renderStatus(data) {
        const services = Array.isArray(data.services)
            ? data.services
            : [];

        serviceCards = window.PTGView.syncServices(services);
        serviceCards.forEach(setUnavailable);
        services.forEach(updateCard);

        updateOverall(data);

        const incidents = Array.isArray(data.incidents)
            ? data.incidents
            : [];

        const maintenance = Array.isArray(data.maintenance)
            ? data.maintenance
            : [];

        document.getElementById("service-total").textContent =
            services.length;

        document.getElementById("service-count").textContent =
            `${services.length} services monitored`;

        document.getElementById("incident-total").textContent =
            incidents.length;



        document.getElementById("maintenance").innerHTML =
            renderItems(maintenance, "maintenance");

        window.PTGView.update(data);
        updateSupportUrls(data.supportUrls);
        updateTimestamp(data.checkedAt || data.publishedAt);
        if (!requestedServiceHighlighted) highlightRequestedService();

    }

    async function loadStatus() {
        const response = await fetch(
            `${API_URL}?v=${Date.now()}`,
            {
                cache: "no-store",
                signal: AbortSignal.timeout(20000),
                headers: {
                    "Accept": "application/json"
                }
            }
        );

        if (!response.ok) {
            throw new Error(
                `Status API returned HTTP ${response.status}`
            );
        }

        const data = await response.json();
        renderStatus(data);
    }

    function handleLoadError(error) {
        console.error("Unable to load service status:", error);

        serviceCards.forEach(setUnavailable);
        window.PTGView.unavailable();

        const timestamp = document.getElementById("updated");

        timestamp.removeAttribute("datetime");
        document.getElementById("incident-total").textContent = "—";
        for (const id of ["incidents", "maintenance"]) {
            document.getElementById(id).innerHTML = "<h3>Status unavailable</h3><p>Current updates could not be retrieved. Please try again shortly.</p>";
        }
        timestamp.textContent = "Unable to retrieve live status";
        timestamp.classList.add("error");

        const overallMetric = document.getElementById("overall-metric");
        if (overallMetric) {
            overallMetric.textContent = "Unavailable";
        }
        ["microsoft-status", "ptg-status"].forEach(id => {
            const card = document.getElementById(id);
            if (!card) return;
            card.className = "managed-status unknown";
            card.querySelector("h2").textContent = "Status unavailable";
            card.querySelector(".managed-status-summary").textContent = "Service information could not be retrieved.";
            card.querySelector(".managed-status-metric").textContent = "Unavailable";
            card.querySelector(".managed-status-icon").textContent = "?";
        });
    }
    let refreshing = false, refreshTimer = null, nextRefreshAt = 0, lastRefreshFailed = false;
    const countdown = document.getElementById("refresh-countdown");

    function updateCountdown() {
        if (!countdown) return;

        if (refreshing) {
            countdown.textContent = "Checking for updates…";
            countdown.classList.remove("countdown-warning");
            return;
        }

        const totalSeconds = Math.max(
            0,
            Math.ceil((nextRefreshAt - Date.now()) / 1000)
        );

        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;

        countdown.textContent =
            (lastRefreshFailed ? "Retrying in " : "Next refresh in ") +
            minutes + "m " +
            seconds.toString().padStart(2, "0") + "s";

        // Start pulsing red at 10 seconds or below
        countdown.classList.toggle("countdown-warning", totalSeconds <= 10);
    }
    async function refresh() {
        if (refreshing) return;
        refreshing = true;
        window.clearTimeout(refreshTimer);
        updateCountdown();
        const button = document.getElementById("refresh-status");
        if (button) { button.disabled = true; button.textContent = "Refreshing…"; }
        try {
            await loadStatus();
            lastRefreshFailed = false;
        } catch (error) {
            lastRefreshFailed = true;
            handleLoadError(error);
        } finally {
            refreshing = false;
            nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;
            refreshTimer = window.setTimeout(refresh, REFRESH_INTERVAL_MS);
            updateCountdown();
            if (button) { button.disabled = false; button.textContent = "↻ Refresh status"; }
        }
    }

    document.getElementById("refresh-status")?.addEventListener("click", refresh);
    highlightRequestedService();
    window.addEventListener("focus", refresh);
    refresh();
    window.setInterval(updateCountdown, 1000);
})();
