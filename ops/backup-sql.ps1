[CmdletBinding()]
param(
    [string]$Server = 'np:\\IT1\pipe\MSSQL$PROGRESSIVE\sql\query',
    [string]$Database = 'PTG-STATUS',
    [string]$BackupDirectory,
    [string]$LogDirectory = (Join-Path $env:ProgramData 'PTG-Status-Operations')
)
$ErrorActionPreference = 'Stop'
$backupStatus = @{ checkedAt = [DateTime]::UtcNow.ToString('o'); succeeded = $false; database = $Database; failures = 0 }
try {
    $previousBackup = Get-Content -LiteralPath (Join-Path $LogDirectory 'sql-backup-health.json') -Raw -ErrorAction Stop | ConvertFrom-Json
    if ($previousBackup.failures -ge 0 -and $previousBackup.failures -le 100000) { $backupStatus.failures = [int]$previousBackup.failures }
    if ($previousBackup.verifiedAt) { $backupStatus.verifiedAt = $previousBackup.verifiedAt }
} catch { }
$sqlConnection = New-Object System.Data.SqlClient.SqlConnection
$connectionBuilder = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
$connectionBuilder.DataSource = $Server
$connectionBuilder.InitialCatalog = 'master'
$connectionBuilder.IntegratedSecurity = $true
$connectionBuilder.Encrypt = $true
# Matches the current IT1 setup; use a trusted SQL certificate when provisioned.
$connectionBuilder.TrustServerCertificate = $true
$connectionBuilder.ConnectTimeout = 15
$sqlConnection.ConnectionString = $connectionBuilder.ConnectionString
try {
    if ([string]::IsNullOrWhiteSpace($Database) -or $Database.Length -gt 128) { throw 'Invalid database name.' }
    $sqlConnection.Open()
    $sqlCommand = $sqlConnection.CreateCommand()
    $sqlCommand.CommandTimeout = 900
    if ([string]::IsNullOrWhiteSpace($BackupDirectory)) {
        $sqlCommand.CommandText = "SELECT CONVERT(nvarchar(260), SERVERPROPERTY('InstanceDefaultBackupPath'));"
        $BackupDirectory = [string]$sqlCommand.ExecuteScalar()
    }
    if ([string]::IsNullOrWhiteSpace($BackupDirectory) -or -not [System.IO.Path]::IsPathRooted($BackupDirectory)) { throw 'Configure an absolute backup directory on the SQL host.' }
    $safeDatabase = $Database -replace '[^A-Za-z0-9_-]', '_'
    $backupFile = Join-Path $BackupDirectory ($safeDatabase + '_' + [DateTime]::UtcNow.ToString('yyyyMMdd_HHmmss') + '_' + [Guid]::NewGuid().ToString('N') + '.bak')
    $quotedDatabase = '[' + $Database.Replace(']', ']]') + ']'
    $sqlCommand.CommandText = 'BACKUP DATABASE ' + $quotedDatabase + ' TO DISK = @file WITH COPY_ONLY, CHECKSUM; RESTORE VERIFYONLY FROM DISK = @file WITH CHECKSUM;'
    $null = $sqlCommand.Parameters.Add('@file', [System.Data.SqlDbType]::NVarChar, 4000)
    $sqlCommand.Parameters['@file'].Value = $backupFile
    $null = $sqlCommand.ExecuteNonQuery()
    $backupStatus.succeeded = $true
    $backupStatus.failures = 0
    $backupStatus.file = $backupFile
    $backupStatus.verifiedAt = [DateTime]::UtcNow.ToString('o')
} catch {
    $backupStatus.failures = [Math]::Min(100000, $backupStatus.failures + 1)
    $backupStatus.message = 'SQL backup or verification failed. Check Windows login rights, database access, SQL service write permissions and free disk space.'
} finally {
    $sqlConnection.Dispose()
    try {
        $null = New-Item -ItemType Directory -Path $LogDirectory -Force
        $backupStatus | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $LogDirectory 'sql-backup-health.json') -Encoding UTF8
    } catch { Write-Error 'Cannot write backup health record.'; exit 2 }
}
$backupStatus | ConvertTo-Json
if (-not $backupStatus.succeeded) { exit 1 }
