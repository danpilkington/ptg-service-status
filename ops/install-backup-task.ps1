[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$BackupAccount,
    [string]$Server = 'np:\\IT1\pipe\MSSQL$PROGRESSIVE\sql\query',
    [string]$Database = 'PTG-STATUS',
    [string]$BackupDirectory,
    [string]$TaskName = 'PTG Status - Verified SQL Backup'
)
$ErrorActionPreference = 'Stop'
if ($env:COMPUTERNAME -ne 'IT1') { throw 'Run this installer on IT1. The task backs up its SQL instance.' }
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { throw 'This task already exists. Review it before changing its schedule.' }
$backupScript = Join-Path $PSScriptRoot 'backup-sql.ps1'
function Quote-TaskArgument([string]$Value) {
    if ($Value.Contains('"') -or $Value.Contains([char]10) -or $Value.Contains([char]13)) { throw 'Invalid task argument.' }
    return '"' + $Value + '"'
}
$arguments = '-NoProfile -NonInteractive -File ' + (Quote-TaskArgument $backupScript) + ' -Server ' + (Quote-TaskArgument $Server) + ' -Database ' + (Quote-TaskArgument $Database)
if ($BackupDirectory) { $arguments += ' -BackupDirectory ' + (Quote-TaskArgument $BackupDirectory) }
$windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$action = New-ScheduledTaskAction -Execute $windowsPowerShell -Argument $arguments
$trigger = New-ScheduledTaskTrigger -Daily -At '02:00'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
$credential = Get-Credential -UserName $BackupAccount -Message 'Windows account authorised to back up PTG-STATUS. Task Scheduler stores this credential; the script does not.'
if (-not $credential) { throw 'No account was supplied.' }
$null = Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -User $credential.UserName -Password ($credential.GetNetworkCredential().Password) -Description 'Daily copy-only SQL backup with checksum and RESTORE VERIFYONLY. No backups are deleted.'
Write-Output 'Backup task created for 02:00 local time. Run it once and confirm sql-backup-health.json before relying on the schedule.'
