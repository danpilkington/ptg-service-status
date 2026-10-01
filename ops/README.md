# Backup and independent monitoring setup

## Confirmed IT1 setup

IT1\PROGRESSIVE is SQL Server Express. Its default SQL backup directory is C:\Program Files\Microsoft SQL Server\MSSQL15.PROGRESSIVE\MSSQL\Backup. Express does not provide SQL Server Agent; use Windows Task Scheduler. The current Windows account can inspect server metadata but cannot open PTG-STATUS or install its backup plan. Run database operations under an account authorised by your DBA. No tasks have been registered by these changes.

The startup helper points to C:\PTG-Status; confirm the running application's directory on IT1 before deploying the updated files. Retain the live .env, notification state and storage configuration. Do not rerun the old file-to-SQL migration.

## Daily verified SQL backup (IT1)

1. Deploy the ops folder into the active project directory on IT1. Use a protected deployment folder, not a user-editable shared location.
2. Ask the DBA to provision an account with BACKUP DATABASE permission on PTG-STATUS and permission to run RESTORE VERIFYONLY. Windows Task Scheduler also needs that account to log on as a batch job. The SQL Server service needs write access to the backup destination. A complete restore needs additional DBA permissions.
3. From an elevated Windows PowerShell on IT1, run:

    .\ops\install-backup-task.ps1 -BackupAccount 'PROGRESSIVE\your-backup-account'

The installer uses the configured IT1 named-pipe endpoint, since the earlier TCP connection was unavailable. It prompts for its Windows credential and creates a daily 02:00 local-time task. It uses the SQL instance's default backup directory unless -BackupDirectory is provided. Paths are interpreted on the SQL host. Existing tasks are not replaced. No passwords are written into scripts or task command arguments.

4. Start the task once through Task Scheduler and confirm a successful Last Run Result and C:\ProgramData\PTG-Status-Operations\sql-backup-health.json. Each backup is uniquely named, copy-only and verified with checksums. Copy-only preserves any existing full/differential backup strategy.
5. Configure SQL_BACKUP_HEALTH_FILE=C:\ProgramData\PTG-Status-Operations\sql-backup-health.json in the application's environment and restart it. Allow the application identity to read that file. The integration panel then shows the latest attempt, verified backup and failures; no verified backup within 26 hours is overdue.

These .bak files are not encrypted by the script. Use a protected encrypted volume and an off-host encrypted backup copy. The default SQL directory is on IT1 and does not protect against losing IT1. Adopt the retention/copy policy in RECOVERY.md with your existing backup platform. The script never deletes backups. RESTORE VERIFYONLY validates backup readability; a real restore drill is still required.

## Encrypted complete application recovery bundle

A SQL backup does not contain Teams/Freshservice state, Windows DPAPI recovery material or host settings. During a planned stopped-site window, collect an encrypted application bundle as well. This tool does not replace the native database backup or the application's source/version archive.

Set PTG_BACKUP_PASSWORD through a protected environment/secret mechanism, separately from .env and admin passwords. It must be at least 16 characters. Do not paste the passphrase into scripts or command-line arguments. Keep its recovery copy separately from backups.

    node ops/recovery.js backup --site-stopped --output D:\ProtectedBackups\ptg-20261001.ptgbackup
    node ops/recovery.js verify --input D:\ProtectedBackups\ptg-20261001.ptgbackup
    node ops/recovery.js stage --input D:\ProtectedBackups\ptg-20261001.ptgbackup --target D:\ProtectedRestore\ptg-20261001

The destination's parent folder must already exist with restricted access. Backup refuses to overwrite an existing file. Staging requires a new folder, includes integrity hashes, and never writes into a live database/application. Plaintext staged files contain account hashes and configuration secrets; keep their folder restricted. configuration/.env is deliberately separated from runnable application configuration. Review absolute paths and disable outbound integrations before using staged files in a test instance.

The encrypted bundle contains status, users, audit, approvals and availability documents, notification/cache state when present, configuration and package versions. Missing state for an enabled integration blocks export, and detected changes during collection stop it. Only use --site-stopped after stopping the actual application, not merely this duplicated folder. SQL restore: restore the native .bak through the DBA; compare the staged document counts/hashes, reconcile notification actions since the backup, and follow RECOVERY.md. File restore: use the staged documents as a complete set on an isolated installation before production cutover.

Encryption uses AES-256-GCM and a salted scrypt-derived key; verification checks authentication and per-file SHA-256 hashes. A wrong passphrase or altered archive fails verification. The tool does not schedule stopped-site exports, rotate backups or manage encryption passphrases.

## Independent monitor (another Windows host)

Install Node.js 20 or later and copy check-status.js and install-monitor-task.ps1 to a host independent of IT1. From elevated Windows PowerShell there:

    .\install-monitor-task.ps1 -NodePath 'C:\Program Files\nodejs\node.exe' -SiteUrl 'https://status.progressive.technology'

The task checks /api/health and /api/ready every minute. It runs under SYSTEM with a new directory in C:\ProgramData\PTG-Status-Monitor. Three consecutive failed runs produce exit 1; checker/configuration failure produces exit 2; successful checks and the first two transient failures produce exit 0. Persistent JSON records the endpoints, failure streak and recovery/failure transitions. An obsolete streak older than five minutes resets. Redirects, non-success responses and unexpected endpoint payloads count as failures.

Connect Task Scheduler results or health-state.json to your existing independent monitoring/alerting system. Installing this task alone sends no alerts. Agree the alert destination and missed-check monitoring before relying on it. Deploy the readiness endpoint first; the older application returns 404 for it. The monitor does not fetch /api/status or initiate tickets/messages.

## Verification completed in the development copy

Automated tests cover encrypted export/import, incorrect passwords, tampering, required documents, concurrent data changes, missing notification state, safe staging, failure thresholds and recovery, and overdue backup health. Live SQL backup, scheduling and production restart require the authorised IT1 operator; they have not been performed from this account.
