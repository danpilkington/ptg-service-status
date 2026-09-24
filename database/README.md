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
