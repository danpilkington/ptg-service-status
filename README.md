# PTG Service Status

A Node.js dashboard with Microsoft Graph health and a connected administration workspace.

## Run
Use Node.js 20 or later. Run npm ci, then npm start. Open http://127.0.0.1:3000.
The header links to /admin/ and the admin header returns to the public page.
A static file server cannot provide the status or publishing APIs.

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
