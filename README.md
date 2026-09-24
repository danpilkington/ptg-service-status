# PTG Service Status

A Node.js dashboard with Microsoft Graph health and a connected administration workspace.

## Run
Use Node.js 20 or later. Run npm ci, then npm start. Open http://127.0.0.1:3000.
The header links to /admin/ and the admin header returns to the public page.
A static file server cannot provide the status or publishing APIs.

## Configuration
Set variables on the host or in a local .env file (never commit it):
- PORT: defaults to 3000.
- HOST: defaults to 127.0.0.1; configure for your reverse proxy.
- ADMIN_API_KEY: optional administrator bootstrap/recovery key of at least 24 characters. Individual accounts can sign in without it after initial setup.
- AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET: server-side Graph credentials.
- SUPABASE_ACCESS_TOKEN: server-side Supabase Management API token used by Supabase project health checks.
- FRESHSERVICE_DOMAIN, FRESHSERVICE_API_KEY, FRESHSERVICE_REQUESTER_EMAIL: enable automatic Freshservice tickets. DOMAIN is only the account subdomain (for example, `company` for `company.freshservice.com`). The requester must already be valid in Freshservice.
- FRESHSERVICE_PRIORITY: optional priority from 1 (Low) to 4 (Urgent); defaults to 3 (High).
- FRESHSERVICE_RECOVERY_STATUS: numeric Freshservice status used after a service recovers; defaults to 11 (`Awaiting Verification` in this account).
- FRESHSERVICE_GROUP_ID, FRESHSERVICE_WORKSPACE_ID: optional numeric routing IDs.
- FRESHSERVICE_STATE_FILE: optional persistent deduplication file path; defaults to `freshservice-state.json` beside the application. Keep it on durable storage and writable by the Node service account.
- STATUS_FILE: optional absolute path to a persistent status file; defaults to status.json.

Generate a key: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
Distribute it only to authorised administrators. The admin page keeps it only in memory.
Individual administrator/editor accounts are managed at /admin/. The recovery key remains shared access.
Use HTTPS and restrict administration to trusted users/network access when hosting.
Grant the Graph application service-health read permissions with administrator consent.
Missing or failed Graph access displays Microsoft services as unavailable; PTG statuses remain available.
Supabase checks support the Atomic and Hub projects and the auth, db, rest, realtime, storage and functions services. The token is never stored in status.json or sent to the admin browser.

## Publish
Connect at /admin/, set PTG availability, and create or update incidents, resolve them into history, and manage maintenance notices.
Edits remain drafts until Publish changes succeeds. Validated data is saved to the configured storage backend.
Conflicting edits are rejected: reload and reapply changes.
Use a single Node server process for in-memory login sessions and monitoring results.
Notices do not automatically change availability or expire: update service availability separately, resolve incidents, and remove obsolete maintenance notices.
Microsoft statuses remain automatic. Public pages refresh every 60 seconds and on window focus.

When Freshservice is configured, the first observed actionable status creates an Open ticket through Freshservice API v2. Actionable statuses are advisory, degraded, outage and maintenance; `unknown` is ignored because it may only mean that a check is pending or unavailable. Further changes during the same outage do not create duplicates. Once the service returns to `operational`, the original ticket receives a private recovery note and moves to the configured recovery status (`Awaiting Verification`). A later actionable event can then create a new ticket. Recovery steps are persisted separately so a retry cannot duplicate the note. The server checks every 60 seconds, with the first scheduled check one minute after startup, independently of dashboard visitors. Public status requests can also supply a fresh observation. Failed requests are logged and retried on the next status refresh.

## Hosting
Host the Node application with a writable persistent volume for STATUS_FILE and TLS at the proxy.
Only listed public assets are served. Source, .env, dependencies and status data are not static assets.
Azure Static Web Apps alone does not run server.js. staticwebapp.config.json is a starting point for
a future static frontend with separately implemented APIs, not a complete deployment path.
Back up status.json before changes.

## Checks
Run npm test. Tests cover authentication, publishing, validation, conflicts and static file exposure.
Publishing tests use a temporary status file and do not change the site's data.

## Assets
Both pages share style.css; admin/style.css adds editor controls.
The company logo loads from the company website. Host an approved local copy for independent availability.
Replace STATUS_PAGE_URL in freshservice-snippet.html with the deployed HTTPS URL before using it.
m365-health.js and microsoft-health are deprecation notes for the old, unimplemented endpoint.

When working from a UNC network path in PowerShell, run node server.js and node --test test/admin.test.js test/incidents.test.js directly; npm scripts use cmd.exe, which does not support a UNC working directory.

## Incident timelines and PTG impact
PTG incidents support investigating, identified, monitoring and resolved stages. Each published change appends a server-timestamped timeline entry. Existing published history is retained even if a client submits different update timestamps. Resolved incidents stay in status.json and appear in public history; published incidents cannot be deleted through the editor. Reopen one by editing its stage.

Impact is separate from availability: unknown means not confirmed, confirmed means affecting PTG, and not-affected means PTG has assessed no local impact. Legacy incidents default to unknown. Microsoft provider status is never overridden by an assessment. Admins can add a PTG note, workaround and expected next update for each currently reported Microsoft issue. Assessments are keyed by Microsoft issue ID and remain stored when the issue disappears from the active feed; this does not create a Microsoft incident-history archive.

The public headline still summarises reported service health, including Microsoft's provider status. The confirmed PTG incident count and impact labels explain local relevance. Affected service filtering includes reported degraded/outage/advisory/maintenance states and confirmed local incidents; it does not treat unknown availability as a confirmed outage.

Next-update times are communication expectations, not scheduled posts. Overdue updates are labelled accordingly. The editor supports draft preview and protects unsaved form changes. Maintenance timing and Microsoft automation remain unchanged.

Storage limits: up to 500 PTG incidents including history, 500 Microsoft assessments and a 1.8 MB saved file. Back up and archive old data offline before approaching these limits. No history is silently pruned. Entra sign-in is deferred; individual local accounts and the recovery ADMIN_API_KEY are supported.

## Dashboard layout and controls
The public dashboard places service health beside incidents on desktop and first on mobile. Support is integrated into the sidebar instead of floating over the page. Use Refresh status for an immediate check; automatic refresh remains enabled. Service search and source/affected filters can be cleared with Show all services when no matches remain.

PTG services can be added, renamed, described and removed in Administration. Save changes to the draft and publish to update the public dashboard. See admin/README.md for linked-notice safeguards and refresh behavior. Restart the Node server after deploying the service-management update.

The admin workspace now supports service groups/display order, recoverable browser drafts, expiring site announcements and automatic maintenance windows. Restart the Node server after deploying these changes; the admin page checks the publishing version and gives a restart message if an older process is running. See admin/README.md for behavior and recovery limitations.

## SQL Server

SQL Server storage is prepared for IT1\\PROGRESSIVE / PTG-STATUS using Windows authentication. The current file backend stays enabled until migration succeeds. See [database/README.md](database/README.md) for the migration commands, access requirements and SSMS views. Users, services, incidents, maintenance and settings move together; existing password hashes are retained.
