# Retention and recovery plan

## Retention policy to adopt

- Availability observations: the existing 400-day daily retention remains in effect.
- Audit: retain 12 months online and export older entries into encrypted annual archives retained for 7 years, subject to PTG policy approval. No automatic audit deletion is implemented.
- Resolved incidents and completed approvals: review quarterly; export and verify an archive before removing any records. Incident deletion protections remain in place. Alert at 400 of the 500 incident/assessment limit.
- Microsoft cache: retain one last successful snapshot, replace on successful refresh. It is a recovery aid, not historical incident evidence.
- Notification state: retain active and recovering records. Archive inactive records only after verifying ticket/alert reconciliation; never reset these files as routine cleanup.

## Backup scope and proposed targets

Target recovery point: 24 hours for published content/accounts; target recovery time: 2 hours. Agree these targets with IT and validate them with restore drills. Use encrypted daily backups with 30 daily and 12 monthly copies, a separate protected destination, and alert on missed backups. Existing application backup downloads contain published status only and are not full recovery backups.

SQL: back up the complete PTG-STATUS database with its audit, approvals and availability documents. Include transaction logs if the selected recovery model and tighter recovery point require them. File backend: stop the application, then copy STATUS_FILE, USERS_FILE and audit.json, approvals.json, availability.json beside STATUS_FILE. Preserve any STATUS_FILE.transaction recovery journal; restart completes it before reads. Keep each backup as one consistent set.

For either backend also stop the application while copying configured FRESHSERVICE_STATE_FILE, TEAMS_STATE_FILE and MICROSOFT_CACHE_FILE (defaults beside the application). Include private host configuration, application version/lockfile, service identity, reverse-proxy settings and secret recovery procedure. Protect .env and account data; never publish backups through the website or commit them. DPAPI monitoring secrets depend on the original Windows account/machine: prove decryptability on the recovery host or securely re-enter credentials there.

## Restore drill (quarterly and after storage changes)

1. Record the application version and backup timestamp; verify integrity hashes and database backup verification. Use an isolated host with outbound Teams, Freshservice and welcome email disabled. Never point a drill at the production notification endpoints.
2. Restore the database or complete file set, then notification state and Microsoft cache. Configure the selected storage backend explicitly; never switch to stale file snapshots when recovering SQL.
3. Provision the Windows service identity and storage permissions. Restore/re-enter monitoring secrets as necessary. Start a single application process. Startup schema upgrade may require a database administrator; runtime rights should be limited after upgrade.
4. Confirm /api/health is live and /api/ready returns 200 once workers have completed. Sign in and check services, incident timelines, approvals, audit and availability reports. Verify monitor credential decryption and a draft/publish cycle in isolation.
5. Compare record counts and sample values to the backup manifest. Record achieved recovery point/time and failures in the IT recovery log.
6. Before production cutover, stop the old process. Reconcile restored Freshservice ticket IDs and Teams state against actions since the backup to prevent duplicate alerts or recovery actions. Enable integrations only after this check, then verify their panel and an external HTTP check.

## Independent monitoring

Configure an existing external monitor to check the deployed HTTPS /api/health (process liveness) and /api/ready (storage and workers), alerting after repeated failures through a channel independent of this application. Microsoft/Teams/Freshservice failures appear in the authenticated integration panel and do not make storage readiness fail. A provider outage is not an application failure. The ops folder now includes Windows Task Scheduler installers for SQL backups on IT1 and an independent HTTPS checker on another host. They have not been activated. Connect task results to the selected monitoring system; these scripts do not send alerts. See ops/README.md.

## Capacity review

The integration panel exposes audit count/bytes and incident/assessment counts. Audit remains a JSON document and grows on every audited mutation; plan a database-backed append-only audit table with indexed pagination before sustained growth makes publishing slow. Verify archive exports and a restore drill before any retention job deletes source records. Backups and archives need separate access controls from application administrators.

## Recovery tooling

See ops/README.md for SQL Express backup scheduling, backup-health panel configuration, encrypted complete recovery bundles and verified staging. Native SQL backups and encrypted application-state bundles serve different recovery needs; preserve both. A verified archive is not a completed restore drill.
