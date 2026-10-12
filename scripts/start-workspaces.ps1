param([switch]$NoBuild, [switch]$IncludeJobs)
$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path -Parent $PSScriptRoot
Push-Location $workspaceRoot
try {
    # Prepare local credentials without displaying them or restarting services.
    & .\scripts\local-demo.ps1 -Mode Private -Workspaces -EnvironmentOnly
    if ($LASTEXITCODE -ne 0) { throw 'Workspace environment preparation failed' }
    foreach ($line in Get-Content -LiteralPath '.env.demo.local') {
        if ($line -match '^([A-Z_]+)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') }
    }
    # Preserve the running stack's monitoring topology and its existing credentials.
    $args = @('compose', '--env-file', '.env', '-f', 'infra/compose/compose.yaml', '-f', 'infra/compose/compose.runner.yaml', '-f', 'infra/compose/compose.workspaces.yaml')
    $monitoring = docker ps --filter 'name=^/collaborative-code-editor-otel-collector-1$' --quiet
    if ($monitoring) { $args += @('-f', 'infra/compose/compose.observability.yaml', '-f', 'infra/compose/compose.observability-runner.yaml') }
    $ErrorActionPreference = 'Continue'
    $args += @('up', '-d', '--no-deps', '--wait')
    if (!$NoBuild) { $args += '--build' }
    $args += @('api', 'web', 'workspaces')
    if ($IncludeJobs) { $args += 'jobs' }
    docker @args
    if ($LASTEXITCODE -ne 0) { throw 'Workspace startup failed' }
    docker compose -f infra/compose/compose.yaml restart edge
    if ($LASTEXITCODE -ne 0) { throw 'Edge restart failed' }
    Write-Host 'Development workspaces available at http://localhost:3000'
} finally { Pop-Location }
