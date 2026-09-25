# Administration
Open /admin/ through the Node server. Both pages link to each other.
Configure ADMIN_API_KEY (24+ characters), then connect with that key.
Service changes and notices remain unpublished until Publish changes succeeds. Unpublished edits are saved in this browser for recovery; the admin key is never saved.
Reload discards drafts after confirmation. Disconnect clears the key and draft.
Microsoft health is automatic and cannot be overridden here.
Maintenance times use your browser's local timezone and are saved as ISO timestamps.
Resolve incidents to retain their timelines, remove obsolete maintenance notices, and update service availability separately.
Concurrent updates are rejected to prevent overwriting another administrator.
This workspace uses a shared key, not Entra authentication or an attributed audit log.
See ../README.md for hosting and testing.

## Control centre
The Overview tab is the administration landing page. It summarises PTG service availability, active incidents, the current site announcement, active or upcoming maintenance, overdue actions and unpublished changes. Summary cards and quick actions open the relevant editor; all changes continue to use the existing draft, review and publish workflow.

## Incident workflow
Create a notice with stage, PTG impact, workaround and optional next-update time, then Add incident to draft. Use Edit / add update to change its details or stage and add a timeline message. Published timeline entries can be corrected or staged for deletion; deletions can be undone until the draft is published. Corrections retain the original server-issued identity and publication time. Save changes to the draft before publishing. Choosing Resolved moves the published incident to public history; it remains editable in the resolved history section. A published incident cannot be deleted.

## Microsoft assessments
Refresh Microsoft issues to load the provider feed. Open an issue and select its PTG impact, note and guidance. Save assessment to draft, then publish. Provider availability remains unchanged. Missing Microsoft connectivity does not prevent PTG incident editing. Previously saved assessments are preserved.

Preview draft shows staged content only. Save open form changes before publishing. All timestamps are displayed in the viewer's local timezone; new timeline timestamps are assigned by the server on publication. Timeline entries do not identify individual administrators while the shared key is in use.

Use Clear form or Cancel edit to discard unfinished incident or maintenance form input without discarding other staged changes. Reset assessment form returns an individual Microsoft form to its currently staged values. Changes already saved to the draft remain pending until Publish changes; use Reload to discard the entire draft.

## Admin workspace tools
- The workspace menu links to services, incident communications, maintenance, Microsoft impact and the review area.
- Needs attention flags overdue updates, maintenance notices whose window has ended, work planned within 24 hours and Microsoft issues still awaiting an impact decision. It uses the currently loaded data and refreshes time-based indicators once a minute.
- Bulk status changes affect only checked PTG services and remain staged until published.
- Incident templates populate a new editable form, default impact to unconfirmed and suggest a next update in 30 minutes. Review the text before staging. Use the 30-minute/one-hour shortcuts to set expectations; these do not schedule notifications.
- Edit maintenance to change dates, service or message while keeping the notice ID.
- Search incidents by text and stage; search Microsoft issues by title, service or reference.
- Review changes compares the staged draft with the last loaded/published snapshot, including before/after fields and removed maintenance. Reverting a field to its published value clears that change.
- Download published backup exports the loaded published snapshot as JSON, excluding unsaved drafts and the admin key. Refresh first if you need to pick up another administrator's latest changes. Backups are downloaded locally; automatic restore/import is not implemented.

## Managing the service catalogue
Use Add service to set a name, description and availability. Save service to draft, review the changes, then Publish changes. Edit service changes those details without changing its permanent reference. The public dashboard builds its cards from the published catalogue and updates on refresh, window focus or its 60-second refresh cycle. Filters, counts, details and incident service choices include new services automatically. Up to 100 PTG services are supported.

Remove service stages removal from the dashboard. First resolve or reassign its active incidents and remove or reassign all linked maintenance notices. Resolved incident history remains available after removal; assign an existing service before reopening such an incident. Removed references are retained by the server and cannot be reused. Microsoft services remain managed automatically by the provider integration.

After deploying this service-management update, restart the Node server and refresh both pages to load the new publishing validation and dynamic catalogue. Existing published data is retained.

## Groups, announcements and scheduled availability
Edit a service to set its group and display order (0–9999; lower numbers first). The public page groups PTG services under those headings; each group follows the earliest service in its order. Microsoft 365 stays first. Empty groups disappear when filters hide all their services.

Site announcement supports one information, warning or urgent banner with an optional expiry in local time. Save it to the draft and publish. Reset form returns to the staged values; Remove announcement stages removal. Expired banners disappear on the next status refresh.

Select automatic status in a maintenance notice to show maintenance during its published window. It is enabled for new notices; existing notices retain their previous behavior until edited and enabled. The server calculates availability on each request without changing saved service health. Outage, degraded and advisory states take priority. Overlapping windows remain active until all applicable windows end. Afterward the latest saved status is used, and ended notices leave the public maintenance list but remain in the admin workspace. Timing is evaluated by the server; open pages pick it up on refresh or within 60 seconds.

## Recovering drafts
Staged changes and unfinished forms are stored locally in this browser and origin. Reconnect with the admin key after refreshing, then choose Restore draft or Discard saved draft. Drafts contain unpublished content, so use a trusted browser. Successful publishing, explicit Reload and Disconnect clear the local copy. If another administrator has published, restore is blocked: download the saved draft for reference and reapply changes to the current version. Downloaded drafts have no automatic import facility. Private browsing, cleared site data or full browser storage can prevent recovery; a message reports storage failures.

## Ping and TCP health checks
Restart the Node server after deploying this update. In Add/Edit service select Ping or TCP, enter an internal IPv4 address, select 30/60/300 seconds and (for TCP) a port, then save and publish. Monitoring runs independently of browsers, with up to four checks at once, approximately five-second scheduling granularity and a three-second network timeout. The server must reach the target; Ping requires the OS ping utility and allowed ICMP replies.

The service is initially unknown. Two consecutive successes establish or restore operational status; three failures establish an outage. Intermediate results retain the established status. Restarting the server resets this in-memory history to unknown. Stale results become unknown. Last result, time and counters appear on admin service cards and refresh every 30 seconds. Public data excludes the target, port and diagnostics; service details show the latest check time.

While automatic checks are enabled their result replaces saved availability. To override, select Pause checks and use saved availability and publish the desired status. Manual status removes the check. Scheduled maintenance still applies, while more serious health states take priority. Checks do not automatically create incident notices.

Allowed targets default to RFC1918 private IPv4 ranges. Server administrators may restrict these with MONITOR_ALLOWED_CIDRS, a comma-separated list such as 192.168.1.0/24,10.20.0.0/16. Invalid entries allow nothing. Loopback, link-local and multicast/reserved ranges remain blocked. Hostnames, public targets outside the allowlist, HTTP checks and alert delivery are not included. Targets are treated as arguments, never shell commands.

## Authenticated API checks
Select HTTP/HTTPS API (GET), paste a plain URL, and optionally supply X-API-Key and the full Authorization value (Basic … or Bearer …). Authenticated checks require HTTPS. Success requires HTTP 2xx plus the expected response text when configured. Verify the API's successful response before setting this text.

Credentials are encrypted with Windows DPAPI for the account publishing/running the Node server. They are never returned by admin APIs, included in public responses or saved in browser drafts. Blank credential fields retain saved values; Remove saved credentials clears them. After recovering a draft, re-enter unpublished credential changes. Moving the server to another Windows account requires re-entering credentials. Restrict access to the server account and status file.

Hostnames must resolve to approved internal IPv4 ranges. Validated addresses are pinned for each connection; redirects are rejected. Responses are capped at 64 KB. URLs with embedded credentials, query parameters or fragments are rejected. TLS certificate validation stays enabled. If using an internal CA, configure NODE_EXTRA_CA_CERTS to its IT-approved PEM certificate before restarting Node. HTTP 200 alone does not detect a failure described only in a response body.

## Individual users

Restart the Node server after installing this update. Open /admin/index.html, expand **Administrator key access**, and connect with the existing ADMIN_API_KEY. In **Users**, create your first account with Administrator access. You can then sign in using its username and password.

Accounts include username, first name, last name, job title, role and enabled status. Administrators manage users; editors can publish status updates. Account changes save immediately, independently of status drafts. Edit an account to change its details, reset its password, or disable access. Blank passwords on edits preserve the existing password. Passwords require 12–256 characters.

Passwords use salted scrypt hashes in server-side users.json, separate from public status data. This file is excluded from source control and the public file allowlist. Back it up and restrict its filesystem permissions to the server account and authorised administrators. Set USERS_FILE to use a different private storage path if required. Use HTTPS for deployed password sign-in.

Sessions are kept in page/server memory, expire after eight hours, and end when the server restarts or the user signs out. Password resets, disabling an account and role changes revoke that account's sessions. The last enabled administrator cannot be disabled or demoted. The existing administrator key remains a recovery credential; it can be removed from server configuration after individual administrators are established if recovery access is not wanted.
