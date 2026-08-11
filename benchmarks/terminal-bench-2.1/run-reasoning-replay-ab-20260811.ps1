$ErrorActionPreference = 'Stop'
Set-Location 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'

$tasks = @(
    'log-summary-date-ranges',
    'openssl-selfsigned-cert',
    'vulnerable-secret',
    'kv-store-grpc'
)
$common = @{
    Include = $tasks
    Concurrent = 4
    Attempts = 1
    MaxRetries = 2
    RouteProfile = 'sol-xhigh-nofast'
    Workflow = 'solo'
}
$baseEnv = @(
    'MIXDOG_OAI_TRANSPORT=http-sse',
    'MIXDOG_OAI_STATELESS_HTTP=1',
    'MIXDOG_TURN_TIMING=1',
    'MIXDOG_BOOT_JITTER_MS=0'
)

"[reasoning-ab] control start $(Get-Date -Format o)"
& .\harness\run-tb21.ps1 @common `
    -JobsDir 'jobs-reasoning-replay-control-n4-20260811' `
    -AgentEnv $baseEnv
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

"[reasoning-ab] treatment start $(Get-Date -Format o)"
& .\harness\run-tb21.ps1 @common `
    -JobsDir 'jobs-reasoning-replay-treatment-n4-20260811' `
    -AgentEnv ($baseEnv + @('MIXDOG_OAI_EXPLICIT_REASONING_REPLAY=1'))
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

"[reasoning-ab] complete $(Get-Date -Format o)"
