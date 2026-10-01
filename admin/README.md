
## Automatic account welcome emails

New accounts require an email address. After an enabled account is successfully saved,
the server sends its username, initial password and sign-in link through Microsoft Graph.
Both administrator and editor accounts receive this welcome email. Existing accounts can
be edited without an email address until one is added. Editing or resetting an existing
account does not send another welcome email.

Configured sender: status@progressive-technology.co.uk
Sign-in URL: https://status.progressive.technology/admin/#admin-overview

Microsoft 365 setup:
1. Open Microsoft Entra admin centre > App registrations and select the application
   whose client ID matches AZURE_CLIENT_ID in the website's server configuration.
2. Under API permissions, add Microsoft Graph > Application permissions > Mail.Send.
3. Grant administrator consent for the tenant. The sender must be a Microsoft 365 mailbox
   that this application is permitted to send from. Restrict application mailbox access
   to the status mailbox through your Exchange application access configuration.
4. Restart the website to load the new mail settings and acquire a fresh access token.

Server settings:
- WELCOME_EMAIL_ENABLED=true
- WELCOME_EMAIL_FROM=status@progressive-technology.co.uk
- ADMIN_SIGN_IN_URL=https://status.progressive.technology/admin/#admin-overview
- Uses the existing AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET.

The form reports whether Microsoft 365 accepted the email or an error occurred.
Acceptance is not proof of delivery; check the recipient inbox or Exchange message trace.
The account is retained if sending fails, so do not recreate it. After correcting the mail
setup, share that account's sign-in details directly, or reset its password and share the
new details. Welcome messages are not automatically retried after a timeout.

Passwords are used transiently to compose the requested email. The database retains only
the password hash; request contents and mail provider bodies are not logged. No extra
copy is saved in the sender's Sent Items. Source and mail configuration are server-only.

Reference: https://learn.microsoft.com/en-us/graph/api/user-sendmail

## Secure password links, approvals, audit and availability

This update replaces passwords in welcome emails with one-use setup links (valid for
24 hours). Existing passwords keep working. New users created through the admin form
choose their own password; administrators no longer enter or email it. The sign-in
screen includes Forgot your password. Reset links expire after one hour, invalidate
older links when reissued, and sign out existing sessions when used. Disabled/deleted
accounts cannot use password links. Only a hash of the link token is stored. Tokens
remain in the email URL fragment and are removed from the browser address on opening.

Use Send password link on an enabled account to resend a setup/reset link after a
mail failure. Password-change links need the existing Microsoft 365 mail setup.

Editors now submit all status changes for approval. Administrators can still publish
directly. Approvals shows submitted details beside the currently published content.
Only a different administrator can approve/reject a request. Approval publishes the
saved validated submission, not arbitrary data supplied with the approval request.
If published content has changed, the request must be rejected and resubmitted against
the latest version. Requests are stored server-side; changing tabs does not lose them.

Audit history records successful account changes, password-link requests/completions,
publishing, submissions and review decisions with time, actor and target. It is available
only to administrators, paginated 50 records at a time. Passwords, hashes, reset tokens
and monitoring credentials are excluded. Mutation and audit records commit together.
This is an application audit history, not tamper-proof evidence against database admins.

Availability reports collect observations every minute, including without visitors.
They cover PTG and Microsoft services as reported by the public status endpoint.
Monthly UTC reports show fully operational percentage, outage/maintenance/unknown time,
coverage and observed outage starts. Fully operational percentage is operational time
divided by operational + advisory + degraded + outage time. Unknown and maintenance
are excluded from that denominator. A last observation is trusted for at most two minutes;
longer gaps and time before recording began remain unknown. Reports are estimates from
observed status, not synthetic historical uptime. Daily totals are retained for 400 days.
CSV exports include the individual status durations. Recording starts on server restart.

Deployment: restart the website under its existing PROGRESSIVE\administrator account.
Startup extends the SQL Documents name constraint for audit, approvals and availability,
without changing current status or user records. If the runtime account cannot alter
the schema, run node database-setup.js upgrade as a database administrator first.
Do not rerun the old file migration on a live SQL database. File-backed installations
create private audit.json, approvals.json and availability.json sidecars; multi-document
writes use a recovery journal to complete interrupted transactions before further reads.
Back up the entire database (or all file-sidecar records for file installations).
