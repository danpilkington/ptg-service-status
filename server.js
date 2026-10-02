"use strict";

require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const express = require("express");
const path = require("path");

const { ClientSecretCredential } = require("@azure/identity");

const app = express();
const { normaliseIncident, applyAssessments } = require("./src/incident-model");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";

const STATUS_FILE = process.env.STATUS_FILE || path.join(__dirname, "status.json");

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

const requiredEnvironmentVariables = [
    "AZURE_TENANT_ID",
    "AZURE_CLIENT_ID",
    "AZURE_CLIENT_SECRET"
];

const missingEnvironmentVariables =
    requiredEnvironmentVariables.filter(
        name => !process.env[name]
    );

if (missingEnvironmentVariables.length > 0) {
    console.warn(
        "Microsoft Graph integration is not fully configured. Missing:",
        missingEnvironmentVariables.join(", ")
    );
}

const credential = missingEnvironmentVariables.length === 0
    ? new ClientSecretCredential(
        process.env.AZURE_TENANT_ID,
        process.env.AZURE_CLIENT_ID,
        process.env.AZURE_CLIENT_SECRET
    )
    : null;

app.disable("x-powered-by");
app.set("trust proxy",process.env.TRUST_PROXY||"loopback");

app.use((request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "SAMEORIGIN");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    response.setHeader(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=()"
    );

    next();
});

app.use(express.json({ limit: "2mb" }));


const storage = require("./src/storage").createStorage({ statusFile: STATUS_FILE });
const subscriptions = require("./src/subscriptions").createSubscriptions({storage,getServices:async()=>{
    const status=JSON.parse(await storage.read("status"));
    return [...microsoftServiceDefinitions.map(s=>({id:s.id,name:s.displayName})),...(status.services||[]).map(s=>({id:s.id,name:s.name||s.serviceName||s.id}))].filter((s,i,all)=>all.findIndex(a=>a.id===s.id)===i);
}});
subscriptions.attach(app);
const availability = require("./src/availability").createAvailability(storage);
const healthMonitor = require("./src/health-monitor").createMonitor(STATUS_FILE, undefined, storage);
const freshserviceNotifier = require("./src/freshservice").createFreshserviceNotifier();
const teamsNotifier = require("./src/teams-notifier").createTeamsNotifier();
let statusAutomationTimer;
const { createIntegrationHealth, createMicrosoftCache, readiness } = require("./src/integration-health");
const integrations = createIntegrationHealth();
for (const [id, enabled] of Object.entries({microsoft:!!credential, freshservice:freshserviceNotifier.enabled, teams:teamsNotifier.enabled, availability:true})) integrations.configure(id, enabled);
const automation = {started:false,lastCompletedAt:null,error:false,running:false};
const microsoftCache = createMicrosoftCache({
    health:integrations,
    file:require.main === module ? process.env.MICROSOFT_CACHE_FILE || path.join(__dirname,"microsoft-cache.json") : null,
    load:async()=>{
        const [health,issues]=await Promise.all([getMicrosoftHealthOverviews(),getMicrosoftIssues()]);
        return {services:createMicrosoftServices(health),...splitMicrosoftIssues(issues)};
    }
});
app.locals.integrations = integrations;
app.locals.monitor = healthMonitor;
app.locals.automation = automation;
app.locals.storage = storage;
require("./src/admin-api")(app, { statusFile: STATUS_FILE, monitor: healthMonitor, storage, availability, subscriptions, integrationHealth:async()=>{
    const status=JSON.parse(await storage.read("status"));
    const auditRaw=await storage.read("audit")||"[]";
    return {subscriptions:subscriptions.snapshot(),sso:{...app.locals.ssoDiagnostics?.(),groupAccessEnabled:!!status.microsoftAdmin?.groupAccess},checkedAt:new Date().toISOString(),integrations:{...integrations.snapshot(),backup:await require("./ops/backup-health").backupHealth(process.env.SQL_BACKUP_HEALTH_FILE)},monitoring:healthMonitor.workerHealth(),automation:{...automation},checks:healthMonitor.details(status.services||[]),retention:{auditCount:JSON.parse(auditRaw).length,auditBytes:Buffer.byteLength(auditRaw),incidents:(status.incidents||[]).length,assessments:(status.microsoftAssessments||[]).length,incidentLimit:500,availabilityDays:400}};
} });
// Explicit URL mappings keep existing bookmarks and sign-in redirects stable.
// Only these public assets are served; the project directory is never exposed.
const publicFiles = new Map([
    ["/", "pages/status/index.html"], ["/index.html", "pages/status/index.html"],
    ["/info.html", "pages/info/index.html"], ["/maintenance.html", "pages/maintenance/index.html"],
    ["/subscriptions.html", "pages/subscriptions/index.html"],
    ["/app.js", "pages/status/app.js"], ["/public-ui.js", "pages/status/public-ui.js"],
    ["/subscriptions-ui.js", "pages/subscriptions/subscriptions-ui.js"],
    ["/style.css", "assets/style.css"], ["/dashboard-summary.js", "assets/dashboard-summary.js"],
    ["/maintenance-calendar.js", "assets/maintenance-calendar.js"], ["/service-metadata.js", "assets/service-metadata.js"],
    ["/admin/", "pages/admin/index.html"], ["/admin/index.html", "pages/admin/index.html"],
    ["/admin/style.css", "pages/admin/style.css"], ["/admin/app.js", "pages/admin/app.js"],
    ["/admin/management.js", "pages/admin/management.js"], ["/admin/microsoft.js", "pages/admin/microsoft.js"],

]);
app.get(/^\/admin$/, (req, res) => res.redirect(302, "/admin/"));
app.use((req, res, next) => {
    if (!["GET", "HEAD"].includes(req.method) || !publicFiles.has(req.path)) return next();
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-PTG-Project-Layout", "organized-v1");
    res.sendFile(path.join(__dirname, publicFiles.get(req.path)));
});

function normaliseText(value) {
    return String(value || "").trim().toLowerCase();
}

function mapMicrosoftStatus(status) {
    const value = normaliseText(status);

    const mappings = {
        serviceoperational: "operational",
        serviceadvisory: "advisory",
        servicedegradation: "degraded",
        serviceinterruption: "outage",
        restoringservice: "degraded",
        extendedrecovery: "degraded",
        investigating: "degraded",
        investigationsuspended: "unknown",
        falsepositive: "operational",
        postincidentreviewpublished: "operational",
        servicerestored: "operational",
        resolved: "operational",
        resolvedexternal: "operational",
        confirmed: "degraded",
        reported: "degraded",
        assessing: "degraded",
        mitigationexternal: "degraded",
        mitigationconfirmed: "degraded"
    };

    return mappings[value] || "unknown";
}

function getStatusPriority(status) {
    const priorities = {
        operational: 0,
        unknown: 1,
        maintenance: 2,
        advisory: 3,
        degraded: 4,
        outage: 5
    };

    return priorities[status] ?? priorities.unknown;
}

function getWorstStatus(statuses) {
    return statuses.reduce((worst, status) => {
        return getStatusPriority(status) > getStatusPriority(worst)
            ? status
            : worst;
    }, "operational");
}

function matchesAny(name, searchTerms) {
    const normalisedName = normaliseText(name);

    return searchTerms.some(
        term => normalisedName.includes(normaliseText(term))
    );
}

const microsoftServiceDefinitions = [
    {
        id: "microsoft-365",
        displayName: "Microsoft 365",
        match: [
            "Microsoft 365 suite"
        ]
    },
    {
        id: "exchange-online",
        displayName: "Outlook and Exchange",
        match: [
            "Exchange Online",
            "Microsoft 365 Exchange Online",
            "Outlook"
        ]
    },
    {
        id: "microsoft-teams",
        displayName: "Microsoft Teams",
        match: [
            "Microsoft Teams",
            "Teams"
        ]
    },
    {
        id: "sharepoint-online",
        displayName: "SharePoint Online",
        match: [
            "SharePoint Online",
            "SharePoint"
        ]
    },
    {
        id: "onedrive",
        displayName: "OneDrive",
        match: [
            "OneDrive for Business",
            "OneDrive"
        ]
    },
    {
        id: "intune",
        displayName: "Microsoft Intune",
        match: [
            "Microsoft Intune",
            "Microsoft Intune Suite",
            "Intune"
        ]
    },
    {
        id: "identity",
        displayName: "Microsoft Entra ID",
        match: [
            "Microsoft Entra",
            "Microsoft Entra ID",
            "Azure Active Directory",
            "Identity Service"
        ]
    }
];

async function readLocalStatus() {
    const content = await storage.read("status");
    const data = JSON.parse(content);

    return {
        dashboardRefreshSeconds: data.dashboardRefreshSeconds,
        announcement: data.announcement || null,
        publishedAt: data.publishedAt || new Date().toISOString(),
        services: Array.isArray(data.services)
            ? data.services
            : [],
        incidents: Array.isArray(data.incidents)
            ? data.incidents
            : [],
        maintenance: Array.isArray(data.maintenance)
            ? data.maintenance
            : [],
        microsoftAssessments: Array.isArray(data.microsoftAssessments) ? data.microsoftAssessments : [],
        supportUrls:
            data.supportUrls && typeof data.supportUrls === "object"
                ? data.supportUrls
                : {}
    };
}

async function getGraphAccessToken(abortSignal) {
    if (!credential) {
        throw new Error(
            "Microsoft Graph credentials are not configured."
        );
    }

    const token = await credential.getToken(GRAPH_SCOPE, {abortSignal});

    if (!token?.token) {
        throw new Error(
            "Microsoft Graph did not return an access token."
        );
    }

    return token.token;
}

async function graphGet(relativeUrl) {
    const abortSignal = AbortSignal.timeout(12000);
    const accessToken = await getGraphAccessToken(abortSignal);

    const response = await fetch(
        `${GRAPH_BASE_URL}${relativeUrl}`,
        {
            headers: {
                "Authorization": `Bearer ${accessToken}`,
                "Accept": "application/json"
            },
            signal: abortSignal
        }
    );

    if (!response.ok) {
        const responseBody = await response.text();

        throw new Error(
            `Microsoft Graph returned HTTP ${response.status}: ` +
            responseBody.slice(0, 500)
        );
    }

    return response.json();
}

async function getMicrosoftHealthOverviews() {
    const result = await graphGet(
        "/admin/serviceAnnouncement/healthOverviews"
    );

    return Array.isArray(result.value)
        ? result.value
        : [];
}

async function getMicrosoftIssues() {
    const select = [
        "id",
        "service",
        "status",
        "classification",
        "feature",
        "featureGroup",
        "impactDescription",
        "title",
        "startDateTime",
        "endDateTime",
        "lastModifiedDateTime",
        "isResolved"
    ].join(",");

    const filter = "isResolved eq false";

    const result = await graphGet(
        "/admin/serviceAnnouncement/issues" +
        `?$filter=${encodeURIComponent(filter)}` +
        `&$select=${encodeURIComponent(select)}`
    );

    return Array.isArray(result.value)
        ? result.value
        : [];
}

function createMicrosoftServices(healthOverviews) {
    return microsoftServiceDefinitions.map(definition => {
        const matchingServices = healthOverviews.filter(service =>
            matchesAny(
                service.service || service.id,
                definition.match
            )
        );

        if (matchingServices.length === 0) {
            return {
                id: definition.id,
                serviceName: definition.displayName,
                status: "unknown",
                statusText: "Status unavailable",
                source: "Microsoft"
            };
        }

        const statuses = matchingServices.map(service =>
            mapMicrosoftStatus(service.status)
        );

        const worstStatus = getWorstStatus(statuses);

        return {
            id: definition.id,
            serviceName: matchingServices
                .map(service => service.service || service.id)
                .filter(Boolean)
                .join(", "),
            status: worstStatus,
            statusText: {
                operational: "Operational",
                advisory: "Service advisory",
                degraded: "Degraded performance",
                outage: "Service outage",
                maintenance: "Maintenance",
                unknown: "Status unavailable"
            }[worstStatus],
            source: "Microsoft"
        };
    });
}

function findServiceDefinition(microsoftServiceName) {
    return microsoftServiceDefinitions.find(definition =>
        matchesAny(
            microsoftServiceName,
            definition.match
        )
    );
}

function createMicrosoftIncident(issue) {
    const definition = findServiceDefinition(issue.service);

    return {
        id: issue.id,
        title: issue.title || "Microsoft service incident",
        service:
            definition?.displayName ||
            issue.service ||
            "Microsoft 365",
        serviceId: definition?.id || null,
        status: mapMicrosoftStatus(issue.status),
        message:
            issue.impactDescription ||
            "Microsoft has published an active service health issue.",
        classification: issue.classification || "",
        feature: issue.feature || "",
        source: "Microsoft",
        start: issue.startDateTime || "",
        updatedAt: issue.lastModifiedDateTime || "",
        end: issue.endDateTime || ""
    };
}

function splitMicrosoftIssues(issues) {
    const incidents = [];
    const maintenance = [];

    for (const issue of issues) {
        const mapped = createMicrosoftIncident(issue);
        const classification = normaliseText(issue.classification);

        if (
            classification.includes("planned maintenance") ||
            classification.includes("maintenance")
        ) {
            mapped.status = "maintenance";
            maintenance.push(mapped);
        } else {
            incidents.push(mapped);
        }
    }

    return {
        incidents,
        maintenance
    };
}

function createOverall(services) {
    const status = getWorstStatus(
        services.map(service => service.status)
    );

    const content = {
        operational: {
            title: "All systems operational",
            description:
                "All monitored PTG and Microsoft services are operating normally."
        },
        advisory: {
            title: "Service advisory in effect",
            description:
                "An advisory has been published for one or more monitored services."
        },
        degraded: {
            title: "Some services are degraded",
            description:
                "One or more monitored services are experiencing degraded performance."
        },
        outage: {
            title: "A service outage is active",
            description:
                "One or more monitored services are currently unavailable."
        },
        maintenance: {
            title: "Maintenance is in progress",
            description:
                "Maintenance is currently affecting one or more monitored services."
        },
        unknown: {
            title: "Some status information is unavailable",
            description:
                "One or more service statuses could not be retrieved."
        }
    };

    return {
        status,
        ...content[status]
    };
}

app.get("/api/status", async (request, response) => {
    response.setHeader(
        "Cache-Control",
        "no-store, no-cache, must-revalidate"
    );

    let localStatus;

    try {
        localStatus = await readLocalStatus();
    } catch (error) {
        console.error("Unable to read status storage:", error);

        return response.status(500).json({
            error: "PTG status data is temporarily unavailable."
        });
    }

    const microsoft = await microsoftCache.get();
    const microsoftAvailable = microsoft.available;
    const microsoftServices = microsoft.data ? microsoft.data.services.map(service=>({...service,stale:microsoft.stale,checkedAt:microsoft.checkedAt,statusText:service.statusText+(microsoft.stale?" (last known)":"")})) :
        microsoftServiceDefinitions.map(definition=>({id:definition.id,serviceName:definition.displayName,status:"unknown",statusText:"Status unavailable",source:"Microsoft"}));
    const microsoftIncidents = microsoft.data?.incidents || [];
    const microsoftMaintenance = microsoft.data?.maintenance || [];

    const { applyMaintenance, activeAnnouncement } = require("./src/dashboard-model");
    const now = Date.now();
    const localServices = applyMaintenance(healthMonitor.publicServices(localStatus.services), localStatus.maintenance, now).map(service => ({
        ...service,
        source: service.source || "PTG"
    }));

    const services = [
        ...microsoftServices,
        ...localServices
    ];

    const uniqueServices = require("./assets/service-metadata").withDependencies([...new Map(services.map(service => [service.id, service])).values()]);
    // Retained provider data is display-only: do not count it as a fresh observation or send alerts.
    const observedServices = uniqueServices.map(service=>service.stale?{...service,status:"unknown"}:service);
    const actionableServices = observedServices;
    await integrations.run("availability",()=>availability.record(observedServices),"Availability recording failed. Check storage access.").catch(()=>{});
    void integrations.run("freshservice",()=>freshserviceNotifier.reconcile(actionableServices),"Freshservice reconciliation failed. Check credentials, connectivity and state-file access.",result=>(result?.created?.length||0)+(result?.recovered?.length||0)).catch(()=>{});
    void integrations.run("teams",()=>teamsNotifier.reconcile(actionableServices),"Teams reconciliation failed. Check webhook connectivity and state-file access.",result=>(result?.notified?.length||0)+(result?.recovered?.length||0)).catch(()=>{});
    const assessedMicrosoftIncidents = applyAssessments(microsoftIncidents, localStatus.microsoftAssessments);
    const localIncidents = localStatus.incidents.map(normaliseIncident);
    const responseBody = {
        dashboardRefreshSeconds: [15,30,60,120,300].includes(localStatus.dashboardRefreshSeconds) ? localStatus.dashboardRefreshSeconds : 30,
        checkedAt: new Date().toISOString(),
        publishedAt: localStatus.publishedAt,
        announcement: activeAnnouncement(localStatus.announcement, now),
        microsoftAvailable,
        microsoftStale:microsoft.stale,
        microsoftCheckedAt:microsoft.checkedAt,
        overall: createOverall(observedServices),
        services: uniqueServices,
        incidents: [
            ...assessedMicrosoftIncidents,
            ...localIncidents.filter(item => item.phase !== "resolved")
        ],
        maintenance: [
            ...microsoftMaintenance,
            ...localStatus.maintenance.filter(item => Date.parse(item.end) > now)
        ],
        history: localIncidents.filter(item => item.phase === "resolved").sort((a, b) => Date.parse(b.resolvedAt || b.updatedAt) - Date.parse(a.resolvedAt || a.updatedAt)),
        supportUrls: localStatus.supportUrls
    };

    void subscriptions.reconcile(responseBody).catch(()=>console.error("Subscription delivery needs attention."));
    response.json(responseBody);
});

app.get("/api/maintenance/calendar.ics",async(req,res,next)=>{
    try{
        const local=await readLocalStatus(),microsoft=await microsoftCache.get();
        let items=[...(local.maintenance||[]),...(microsoft.data?.maintenance||[])].filter(i=>Date.parse(i.end)>Date.now());
        if(req.query.id){if(typeof req.query.id!=="string")return res.sendStatus(400);items=items.filter(i=>i.id===req.query.id);if(!items.length)return res.sendStatus(404);}
        res.set({"Content-Type":"text/calendar; charset=utf-8","Content-Disposition":'attachment; filename="ptg-maintenance.ics"',"Cache-Control":"no-store"});
        res.send(require("./assets/maintenance-calendar").calendar(items));
    }catch(error){next(error);}
});
require("./src/public-availability").attachPublicAvailability(app,{storage,availability,microsoftIds:microsoftServiceDefinitions.map(s=>s.id)});

app.get("/api/health", (request,response)=>{
    response.set("Cache-Control","no-store").json({status:"ok",checkedAt:new Date().toISOString()});
});
app.get("/api/ready", async(request,response)=>{
    const result=await readiness({storage,monitor:healthMonitor,automation});
    response.set("Cache-Control","no-store").status(result.status==="ready"?200:503).json({...result,checkedAt:new Date().toISOString()});
});

app.use((request, response) => {
    response.status(404).json({
        error: "Not found"
    });
});

app.use((error, request, response, next) => {
    console.error(error);

    if (response.headersSent) {
        return next(error);
    }

    response.status(error.status === 409 ? 409 : error.status === 400 ? 400 : error.status === 413 ? 413 : 500).json({
        error: error.status === 409 ? "Data has changed. Reload and reapply your changes." : error.status === 400 ? "Invalid JSON request" : error.status === 413 ? "Request too large" : "Unexpected server error"
    });
});

if (require.main === module) {
    (async () => {
        // Fail before listening if configured SQL storage is unavailable; never fall back to old files.
        await storage.upgrade();
        await storage.read("status");
        await storage.read("users");
        const server = app.listen(PORT, HOST, () => {
            healthMonitor.start();
            console.log("PTG Status Page running at http://" + HOST + ":" + PORT + " (" + storage.kind + " storage)");
            {
                const internalHost = HOST === "0.0.0.0" ? "127.0.0.1" : HOST === "::" ? "[::1]" : HOST.includes(":") ? `[${HOST}]` : HOST;
                const refresh = async () => {
                    if(automation.running)return; automation.running=true;automation.started=true;
                    try { await fetch(`http://${internalHost}:${server.address().port}/api/status`, { signal: AbortSignal.timeout(30000) })
                    .then(response => { if (!response.ok) throw new Error("status endpoint returned HTTP " + response.status); })
                    .then(()=>{automation.error=false;})
                    .catch(error=>{automation.error=true;console.error("Status automation refresh failed:",error.message);});
                    } finally {automation.running=false;automation.lastCompletedAt=new Date().toISOString();}
                };
                void refresh();
                statusAutomationTimer = setInterval(refresh, 60000);
                statusAutomationTimer.unref();
            }
        });
        const stop = () => { clearInterval(statusAutomationTimer); healthMonitor.stop(); server.close(() => storage.close().finally(() => process.exit(0))); };
        process.once("SIGINT", stop); process.once("SIGTERM", stop);
    })().catch(async error => {
        console.error("Website startup failed: " + error.message);
        await storage.close().catch(() => {}); process.exitCode = 1;
    });
}
module.exports = app;
