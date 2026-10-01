[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$NodePath,
    [string]$SiteUrl = 'https://status.progressive.technology',
    [string]$InstallDirectory = (Join-Path $env:ProgramData 'PTG-Status-Monitor'),
    [string]$TaskName = 'PTG Status - Independent Health Check'
)
$ErrorActionPreference = 'Stop'
if ($env:COMPUTERNAME -eq 'IT1') { throw 'Install this task on an independent Windows host so an IT1 failure can be detected.' }
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'Provide the absolute path to an installed Node.js executable.' }
$uri = [Uri]$SiteUrl
if ($uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) { throw 'Provide the deployed HTTPS URL.' }
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { throw 'This task already exists. Review it before changing it.' }
if (Test-Path -LiteralPath $InstallDirectory) { throw 'Use a new protected installation directory; existing files are not overwritten.' }
$null = New-Item -ItemType Directory -Path $InstallDirectory
$monitorScript = Join-Path $InstallDirectory 'check-status.js'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'check-status.js') -Destination $monitorScript
$stateFile = Join-Path $InstallDirectory 'health-state.json'
function Quote-TaskArgument([string]$Value) {
    if ($Value.Contains('"') -or $Value.Contains([char]10) -or $Value.Contains([char]13)) { throw 'Invalid task argument.' }
    return '"' + $Value + '"'
}
$arguments = (Quote-TaskArgument $monitorScript) + ' --url ' + (Quote-TaskArgument $SiteUrl) + ' --state ' + (Quote-TaskArgument $stateFile)
$action = New-ScheduledTaskAction -Execute $NodePath -Argument $arguments
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 50)
$null = Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Independent HTTPS liveness/readiness check. Exit 1 after three consecutive failures; exit 2 if the checker cannot run. No messages are sent.'
Write-Output 'Monitor task created. Connect task failure results or health-state.json to your monitoring system; this task does not send alerts itself.'
