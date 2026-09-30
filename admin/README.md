
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
