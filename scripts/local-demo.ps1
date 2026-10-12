param(
    [ValidateSet('Base', 'Private')][string]$Mode = 'Base',
    [switch]$TestPorts,
    [switch]$Observability,
    [switch]$Workspaces,
    [switch]$EnvironmentOnly
)
$ErrorActionPreference = 'Stop'
$demoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $demoRoot
try {
    function Import-DemoEnvironment([string]$path) {
        if (!(Test-Path -LiteralPath $path)) { return }
        foreach ($line in Get-Content -LiteralPath $path) {
            if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
                $key = $Matches[1]; $value = $Matches[2].Trim()
                if ($value.StartsWith('"') -and $value.EndsWith('"')) { $value = $value.Substring(1, $value.Length - 2) }
                elseif ($value.StartsWith("'") -and $value.EndsWith("'")) { $value = $value.Substring(1, $value.Length - 2) }
                else { $value = ($value -replace '\s+#.*$', '').Trim() }
                if ($value) { [Environment]::SetEnvironmentVariable($key, $value, 'Process') }
            }
        }
    }
    function Get-DemoRandomToken {
        $bytes = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($bytes); return [Convert]::ToBase64String($bytes) } finally { $rng.Dispose() }
    }
    function Get-DemoContainerSetting([string]$container, [string]$key) {
        $exists = docker ps -a --filter "name=^/$container$" --format '{{.ID}}'
        if ($LASTEXITCODE -ne 0) { throw 'Docker inventory failed' }
        if (!$exists) { return $null }
        $settings = docker inspect $container --format '{{json .Config.Env}}' | ConvertFrom-Json
        foreach ($setting in $settings) { if ($setting.StartsWith($key + '=')) { return $setting.Substring($key.Length + 1) } }
    }
    function Resolve-DemoImage([string]$key, [string]$tag, [string]$dockerfile) {
        $value = [Environment]::GetEnvironmentVariable($key, 'Process')
        if (!$value) {
            $exists = docker image ls --quiet $tag
            if (!$exists) { docker build -f $dockerfile -t $tag .; if ($LASTEXITCODE -ne 0) { throw 'Runtime template build failed' } }
            $value = docker image inspect $tag --format '{{.Id}}'
        }
        if ($value -notmatch '^sha256:[0-9a-f]{64}$') { throw 'Runtime settings require immutable local sha256 image IDs' }
        docker image inspect $value --format '{{.Id}}' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Configured runtime image is unavailable' }
        [Environment]::SetEnvironmentVariable($key, $value, 'Process')
    }
    Import-DemoEnvironment '.env.demo.local'
    Import-DemoEnvironment '.env'
    docker info --format '{{.ServerVersion}}' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Start Docker Desktop in Linux-container mode, then retry' }
    Write-Host 'Docker is available; preparing local configuration.'
    if ($Workspaces) {
        if (!$env:WORKSPACE_INTERNAL_TOKEN) { $env:WORKSPACE_INTERNAL_TOKEN = Get-DemoRandomToken }
        Resolve-DemoImage 'WORKSPACE_IMAGE' 'cce-workspace-toolchains:local' 'services/workspaces/Toolchains.Dockerfile'
    }
    if ($Mode -eq 'Private') {
        if (!$env:RUNNER_INTERNAL_TOKEN) { $env:RUNNER_INTERNAL_TOKEN = Get-DemoRandomToken }
        if ($env:RUNNER_INTERNAL_TOKEN.Length -lt 32) { throw 'Private runner token must contain at least 32 characters' }
        Resolve-DemoImage 'RUNNER_PYTHON_IMAGE' 'cce-runtime-python:phase07' 'services/runner/Python.Dockerfile'
        Resolve-DemoImage 'RUNNER_JAVASCRIPT_IMAGE' 'cce-runtime-javascript:phase07' 'services/runner/Javascript.Dockerfile'
    }
    if ($Observability -and !$env:GRAFANA_ADMIN_PASSWORD) {
        $env:GRAFANA_ADMIN_PASSWORD = Get-DemoContainerSetting 'collaborative-code-editor-grafana-1' 'GF_SECURITY_ADMIN_PASSWORD'
        if (!$env:GRAFANA_ADMIN_PASSWORD) { $env:GRAFANA_ADMIN_PASSWORD = Get-DemoRandomToken }
    }
    $runtimeKeys = @('RUNNER_INTERNAL_TOKEN', 'RUNNER_PYTHON_IMAGE', 'RUNNER_JAVASCRIPT_IMAGE', 'GRAFANA_ADMIN_PASSWORD', 'WORKSPACE_INTERNAL_TOKEN', 'WORKSPACE_IMAGE')
    $runtimeLines = foreach ($key in $runtimeKeys) { $value = [Environment]::GetEnvironmentVariable($key, 'Process'); if ($value) { "$key=$value" } }
    if ($runtimeLines) { [IO.File]::WriteAllText((Join-Path $demoRoot '.env.demo.local'), ($runtimeLines -join "`n") + "`n", (New-Object Text.UTF8Encoding($false))) }
    Write-Host 'Local runtime settings prepared; credential values are not displayed.'
    if ($EnvironmentOnly) { return }
    $composeArgs = @('compose')
    if (Test-Path -LiteralPath '.env') { $composeArgs += @('--env-file', '.env') }
    $composeArgs += @('-f', 'infra/compose/compose.yaml')
    if ($TestPorts) { $composeArgs += @('-f', 'infra/compose/compose.test.yaml') }
    if ($Mode -eq 'Private') { $composeArgs += @('-f', 'infra/compose/compose.runner.yaml') }
    if ($Workspaces) { $composeArgs += @('-f', 'infra/compose/compose.workspaces.yaml') }
    if ($Observability) {
        $composeArgs += @('-f', 'infra/compose/compose.observability.yaml')
        if ($Mode -eq 'Private') { $composeArgs += @('-f', 'infra/compose/compose.observability-runner.yaml') }
    }
    docker @composeArgs config --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Compose configuration failed' }
    if ($Mode -eq 'Base') {
        $runner = docker ps --filter 'label=com.docker.compose.project=collaborative-code-editor' --filter 'label=com.docker.compose.service=runner' --quiet
        if ($runner) { docker stop $runner | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Private runner stop failed' } }
    }
    # Windows PowerShell 5 can classify native progress on stderr as an error
    # under Stop. Preserve native output and judge the actual Docker exit code.
    $ErrorActionPreference = 'Continue'
    docker @composeArgs up -d --build --wait
    $dockerExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($dockerExit -ne 0) { throw 'Local stack startup failed; existing volumes are retained' }
    Write-Host "Local $Mode demo started: http://localhost:3000 (existing data retained)."
} finally { Pop-Location }
