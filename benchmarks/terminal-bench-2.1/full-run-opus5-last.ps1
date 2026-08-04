# Reordered full run: opus5 moved to the END of the chain (after CC).
# Waits for full-run-cc.log ALL DONE, then runs mixdog opus5-solo on the
# full 89-task set. Writes its own ALL DONE marker for pollers.
Set-Location 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
Start-Transcript -Path '.\full-run-opus5.log' -Force | Out-Null
$deadline = (Get-Date).AddHours(40)
while ((Get-Date) -lt $deadline) {
  $m = Get-Content '.\full-run-cc.log' -Raw -ErrorAction SilentlyContinue
  if ($m -and $m -match 'ALL DONE') { break }
  Start-Sleep -Seconds 120
}
$env:PYTHONPATH = 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:MIXDOG_TB_SRC_SNAPSHOT = 'C:\Project\mixdog\benchmarks\terminal-bench-2.1\tb-src-snap-full'
$env:MIXDOG_TB_FALLBACK_STATE_DIR = 'C:\Project\mixdog\benchmarks\terminal-bench-2.1\tb-fallback-ab5'
"[opus5-last] start $(Get-Date -Format o)"
harbor run -d terminal-bench/terminal-bench-2-1 `
  --agent-import-path harness.mixdog_agent:MixdogAgent `
  -o jobs-full-opus5 -n 3 -r 2 `
  --retry-exclude AgentTimeoutError `
  --retry-exclude VerifierOutputParseError `
  --retry-exclude RewardFileEmptyError `
  --verifier-env UV_HTTP_TIMEOUT=300 `
  -q -y `
  --ak route_profile=opus5-solo `
  --ak workflow=solo
"[opus5-last] exit=$LASTEXITCODE $(Get-Date -Format o)"
"[opus5-last] ALL DONE $(Get-Date -Format o)"
Stop-Transcript | Out-Null
