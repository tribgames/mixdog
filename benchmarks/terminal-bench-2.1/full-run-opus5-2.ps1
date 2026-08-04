# Mixdog Opus 5 full run (n=8, parity with the CC n=8 run): re-freezes the
# source snapshot from the
# current working tree (today's committed iteration), then runs mixdog solo
# opus5-solo (high, no fast tier) on the full 89-task set — the
# apples-to-apples counterpart to the CC Opus 5 high n=8 run.
Set-Location 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
Start-Transcript -Path '.\full-run-opus5-2.log' -Force | Out-Null
$env:PYTHONPATH = 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
"[opus5-2] snapshot refreeze start $(Get-Date -Format o)"
$snap = 'C:\Project\mixdog\benchmarks\terminal-bench-2.1\tb-src-snap-full2'
if (Test-Path $snap) { Remove-Item -Recurse -Force $snap }
python -m harness.src_overlay --output $snap
if ($LASTEXITCODE -ne 0) {
  "[opus5-2] snapshot refreeze FAILED exit=$LASTEXITCODE $(Get-Date -Format o)"
  "[opus5-2] ALL DONE $(Get-Date -Format o)"
  Stop-Transcript | Out-Null
  exit 1
}
$env:MIXDOG_TB_SRC_SNAPSHOT = $snap
$env:MIXDOG_TB_FALLBACK_STATE_DIR = 'C:\Project\mixdog\benchmarks\terminal-bench-2.1\tb-fallback-ab5'
"[opus5-2] start $(Get-Date -Format o)"
harbor run -d terminal-bench/terminal-bench-2-1 `
  --agent-import-path harness.mixdog_agent:MixdogAgent `
  -o jobs-full-opus5-2 -n 8 -r 2 `
  --retry-exclude AgentTimeoutError `
  --retry-exclude VerifierOutputParseError `
  --retry-exclude RewardFileEmptyError `
  --verifier-env UV_HTTP_TIMEOUT=300 `
  -q -y `
  --ak route_profile=opus5-solo `
  --ak workflow=solo
"[opus5-2] exit=$LASTEXITCODE $(Get-Date -Format o)"
"[opus5-2] ALL DONE $(Get-Date -Format o)"
Stop-Transcript | Out-Null
