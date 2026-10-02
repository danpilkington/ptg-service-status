param([string]$BaseUrl = 'http://127.0.0.1:3000')
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$response = Invoke-WebRequest -Uri ($BaseUrl.TrimEnd('/') + '/index.html') -UseBasicParsing
if ($response.Headers['X-PTG-Project-Layout'] -ne 'organized-v1') { throw 'Restart the status page service with the new layout before running cleanup.' }
$archive = Join-Path $projectRoot ('backups/legacy-source-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$legacy = @('admin-api.js','availability.js','azure-sso.js','dashboard-model.js','freshservice.js','governance.js','health-monitor.js','incident-model.js','incident-reviews.js','integration-health.js','m365-health.js','monitor-secrets.js','public-availability.js','storage.js','subscription-mail.js','subscriptions.js','teams-notifier.js','user-auth.js','welcome-email.js','dashboard-summary.js','service-metadata.js','maintenance-calendar.js','style.css','SSO-SETUP.txt','WEBSITE-UPGRADES.txt','freshservice-snippet.html','admin','index.html','app.js','public-ui.js','info.html','subscriptions.html','subscriptions-ui.js','maintenance.html')
foreach ($relative in $legacy) {
    $source = [IO.Path]::GetFullPath((Join-Path $projectRoot $relative))
    if (-not $source.StartsWith($projectRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid cleanup path.' }
    if (Test-Path -LiteralPath $source) {
        New-Item -ItemType Directory -Path $archive -Force | Out-Null
        Move-Item -LiteralPath $source -Destination (Join-Path $archive $relative)
    }
}
Write-Output 'Obsolete source files archived. Runtime data and configuration preserved.'
