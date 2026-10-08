param([string]$ReportDirectory = ('docs/measurements/local-demo-' + [DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(5.5)).ToString('yyyyMMdd-HHmmss')))
$ErrorActionPreference = 'Continue'
$demoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $demoRoot
try {
    & .\scripts\local-demo.ps1 -Mode Private -Observability -EnvironmentOnly
    if (!$?) { throw 'Local environment preparation failed' }
    $env:TEST_DATABASE_URL = 'postgres://cce:cce_dev_only@127.0.0.1:54329/cce?sslmode=disable'
    $env:TEST_COLLAB_DATABASE_URL = 'postgres://cce_worker:cce_worker_dev_only@127.0.0.1:54329/cce?sslmode=disable'
    $env:CCE_E2E_RESTART = '1'; $env:CCE_E2E_STORAGE_FAILURE = '1'
    $env:CCE_EXECUTION_TESTS = '1'; $env:CCE_BACKUP_TESTS = '1'; $env:CCE_LOAD_TESTS = '1'
    $env:CCE_REPORT_DIR = $ReportDirectory
    $env:CCE_SCREENSHOT_DIR = $ReportDirectory + '/screenshots'
    $env:CCE_WORKSPACE_TEST_PORT = '3101'
    New-Item -ItemType Directory -Force -Path '.tmp/local-demo' | Out-Null
    foreach ($check in @('typecheck', 'lint', 'build', 'check:contracts', 'test')) {
        npm.cmd run $check > ('.tmp/local-demo/' + $check.Replace(':', '-') + '.txt') 2>&1
        if ($LASTEXITCODE -ne 0) { throw "npm $check failed; inspect .tmp/local-demo" }
        Write-Host "npm $check passed."
    }
    $composeArgs = @('compose', '-f', 'infra/compose/compose.yaml', '-f', 'infra/compose/compose.runner.yaml')
    docker @composeArgs stop jobs runner > .tmp/local-demo/go-stop.txt 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'Could not isolate the Go queues' }
    try {
        docker run --rm --network collaborative-code-editor_private `
          -e 'TEST_DATABASE_URL=postgres://cce:cce_dev_only@postgres:5432/cce?sslmode=disable' `
          -e 'TEST_COLLAB_ORIGIN=http://collab:8081' -e 'TEST_ARTIFACT_ENDPOINT=http://minio:9000' `
          -v "${demoRoot}:/workspace:ro" -v "${demoRoot}/.gopath/pkg/mod:/go/pkg/mod" `
          -v "${demoRoot}/.go-cache/linux:/root/.cache/go-build" -w /workspace/services/api `
          golang:1.27.1-bookworm sh -c 'go test -v ./... -count=1 && go test -v -race ./... -count=1 && go vet ./... && cd /workspace/services/runner && go test -v ./... -count=1 && go test -v -race ./... -count=1 && go vet ./...' `
          > .tmp/local-demo/go-linux.txt 2>&1
        $goExit = $LASTEXITCODE
    } finally {
        docker @composeArgs start jobs runner > .tmp/local-demo/go-restore.txt 2>&1
        $restoreExit = $LASTEXITCODE
    }
    if ($goExit -ne 0 -or $restoreExit -ne 0) { throw 'Go verification or worker restoration failed; inspect .tmp/local-demo' }
    if (Select-String -Path .tmp/local-demo/go-linux.txt -Pattern '^\s*--- SKIP:' -Quiet) { throw 'Go tests skipped; not acceptance' }
    Write-Host 'Linux API/runner normal, race and vet checks passed.'
    node scripts/accept-local-demo.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Local acceptance failed; inspect .tmp/local-demo and the report directory' }
    node scripts/check-secret-logs.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Configured-secret log boundary failed; values are withheld' }
    Write-Host 'Bounded local functional acceptance passed. Live GitHub OAuth needs its separate interactive check.'
} finally { Pop-Location }
