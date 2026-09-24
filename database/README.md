# SQL Server storage

## Prepared connection

- SQL instance: IT1\PROGRESSIVE
- Database: PTG-STATUS
- Authentication: Windows integrated authentication
- Website Windows account: PROGRESSIVE\administrator
- Encryption: enabled; trust server certificate matches the supplied SSMS settings
- Connection transport: named pipes, using np:\\IT1\pipe\MSSQL$PROGRESSIVE\sql\query

The SQL instance responds over named pipes. The remote TCP connection did not complete.
The database exists and is online, but PROGRESSIVE\Dan.Pilkington cannot access it.
The site therefore remains on STORAGE_DRIVER=file until an authorised account runs migration.

## Complete the switch on IT1

Sign into IT1 as PROGRESSIVE\administrator, the same account that runs the website.
Stop the running website process/service before migration so there can be no concurrent file updates.
Open PowerShell in the website folder, then run:

    node database-setup.js check
    node database-setup.js migrate --site-stopped --activate

The migration:
1. Checks Windows authentication, database access and SQL compatibility.
2. Creates ptg_status.Documents and the Users and Services views if absent.
3. Transfers status.json and users.json together in a SQL transaction.
4. Verifies the stored data matches the original files exactly.
5. Changes only STORAGE_DRIVER to sql in .env, after verification passes.

Existing different SQL data is never overwritten. Identical data can be migrated again safely.
Original JSON files are retained; they stop receiving updates after SQL is enabled.
An absent users.json becomes an empty user collection. Existing password hashes are preserved.
Do not use --site-stopped while the site is running.

Start the website again under PROGRESSIVE\administrator. Its startup message must include
"(sql storage)". If a Windows service is used, ensure its environment does not override
STORAGE_DRIVER with file. For a manually started website:

    node server.js

Then confirm the public page loads, sign into /admin/, and check the existing accounts.

## Management Studio

Select PTG-STATUS. Refresh Tables and Views. For a readable account/service list, run:

    SELECT * FROM ptg_status.Users;
    SELECT * FROM ptg_status.Services;
    SELECT Name, Revision, UpdatedAt FROM ptg_status.Documents;

Use the admin website to edit records. Documents holds two JSON snapshots, status and users,
so all existing incident history, maintenance, provider assessments and monitoring settings
are preserved without a lossy conversion. The views expose useful fields in normal columns.
The Users view excludes password hashes. The underlying users document contains hashes,
never plaintext passwords. Do not grant ordinary staff direct access to Documents.

## Requirements and permissions

SQL Server 2016 or later and database compatibility level 130 or later are required.
Install a matching 64-bit SQL ODBC driver on the machine running Node. SQL_ODBC_DRIVER
currently names "SQL Server Native Client 11.0"; if IT1 uses a different installed driver,
change that setting to its exact name, for example "ODBC Driver 18 for SQL Server".
Get-OdbcDriver in PowerShell lists installed drivers. Node must be Windows x64/arm64
with a supported msnodesqlv8 native driver; reinstall dependencies on the host if its
Node architecture differs from the machine used to install them.

Initial setup needs permission to create the schema, table and views. The runtime account
only needs SELECT, INSERT and UPDATE on ptg_status.Documents. No SQL password is required.
Windows authentication uses the identity running Node; starting SSMS as an administrator
does not change the account running the website. Changing that account may also prevent
existing Windows DPAPI-encrypted monitoring credentials from being decrypted.

For a different runtime account, have a database administrator provision its Windows login
and database user, then grant the required rights. Do not grant database access to browsers.

## Operation

SQL storage uses a small connection pool and parameterised queries. Saves compare revisions
atomically to reject concurrent edits. SQL failures are reported; the site never silently
falls back to old JSON files. Startup checks storage before opening the HTTP listener.
Use one Node process: login sessions and live monitoring results remain in memory.

Back up PTG-STATUS using your normal SQL Server backup process. Keep the existing file
backups until the switch has been verified. Setting STORAGE_DRIVER=file uses the old files;
after SQL receives edits those files are stale, so export current database content before
any later rollback.

Connection references:
- https://tediousjs.github.io/node-mssql/#windows-authentication-example-using-msnodesqlv8
- https://learn.microsoft.com/en-us/sql/connect/node-js/node-js-driver-for-sql-server
