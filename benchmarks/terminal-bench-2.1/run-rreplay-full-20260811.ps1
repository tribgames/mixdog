# Reasoning-replay FULL run (2026-08-11), direct start: spec-matched to
# jobs-full-fair-sol-nofast-solobench-n8-20260811 except
# MIXDOG_OAI_EXPLICIT_REASONING_REPLAY=1 (recovery-only reasoning replay).
Set-Location 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
$env:PYTHONPATH = 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$snapshotRoot = Join-Path ([IO.Path]::GetTempPath()) ("mixdog-tb-src-" + [guid]::NewGuid().ToString("N"))
$fallbackStateRoot = Join-Path ([IO.Path]::GetTempPath()) ("mixdog-tb-fallback-" + [guid]::NewGuid().ToString("N"))
$overlay = & python -m harness.src_overlay --output $snapshotRoot 2>&1
if ($LASTEXITCODE -ne 0) { Write-Output "[rreplay-full] overlay FAILED: $overlay"; exit 1 }
$env:MIXDOG_TB_SRC_SNAPSHOT = $snapshotRoot
$env:MIXDOG_TB_FALLBACK_STATE_DIR = $fallbackStateRoot
Write-Output "[rreplay-full] snapshot=$snapshotRoot"
Write-Output "[rreplay-full] start $(Get-Date -Format o)"
harbor run -d terminal-bench/terminal-bench-2-1 `
    --agent-import-path harness.mixdog_agent:MixdogAgent `
    -o jobs-full-mixdog-sol-nofast-rreplay-n8-20260811 `
    -n 8 -k 1 -r 2 `
    --retry-exclude AgentTimeoutError `
    --retry-exclude VerifierOutputParseError `
    --retry-exclude RewardFileEmptyError `
    --verifier-env UV_HTTP_TIMEOUT=300 `
    -q -y `
    --ak workflow=solo-bench `
    --ak route_profile=sol-xhigh-nofast `
    --ae MIXDOG_BOOT_JITTER_MS=0 `
    --ae MIXDOG_OAI_EXPLICIT_REASONING_REPLAY=1 `
    *>> '.\mixdog-rreplay-full-20260811.log'
Write-Output "[rreplay-full] exit=$LASTEXITCODE $(Get-Date -Format o)"
