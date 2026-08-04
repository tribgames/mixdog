# Chained sol rerun: waits for the CC n=8 full run (full-run-cc-n8.log ALL
# DONE), re-freezes the source snapshot from the current working tree (today's
# harness iteration), then runs mixdog solo sol-xhigh-nofast on the full
# 89-task set. Writes its own ALL DONE marker for pollers.
Set-Location 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
Start-Transcript -Path '.\full-run-sol2.log' -Force | Out-Null
$deadline = (Get-Date).AddHours(24)
while ((Get-Date) -lt $deadline) {
  $m = Get-Content '.\full-run-cc-n8.log' -Raw -ErrorAction SilentlyContinue
  if ($m -and $m -match 'ALL DONE') { break }
  Start-Sleep -Seconds 120
}
$env:PYTHONPATH = 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
"[sol2] snapshot refreeze start $(Get-Date -Format o)"
$snap = 'C:\Project\mixdog\benchmarks\terminal-bench-2.1\tb-src-snap-full2'
if (Test-Path $snap) { Remove-Item -Recurse -Force $snap }
python -m harness.src_overlay --output $snap
if ($LASTEXITCODE -ne 0) {
  "[sol2] snapshot refreeze FAILED exit=$LASTEXITCODE $(Get-Date -Format o)"
  "[sol2] ALL DONE $(Get-Date -Format o)"
  Stop-Transcript | Out-Null
  exit 1
}
$env:MIXDOG_TB_SRC_SNAPSHOT = $snap
$env:MIXDOG_TB_FALLBACK_STATE_DIR = 'C:\Project\mixdog\benchmarks\terminal-bench-2.1\tb-fallback-ab5'
"[sol2] start $(Get-Date -Format o)"
harbor run -d terminal-bench/terminal-bench-2-1 `
  --agent-import-path harness.mixdog_agent:MixdogAgent `
  -o jobs-full-sol2 -n 3 -r 2 `
  --retry-exclude AgentTimeoutError `
  --retry-exclude VerifierOutputParseError `
  --retry-exclude RewardFileEmptyError `
  --verifier-env UV_HTTP_TIMEOUT=300 `
  -q -y `
  --ak route_profile=sol-xhigh-nofast `
  --ak workflow=solo
"[sol2] exit=$LASTEXITCODE $(Get-Date -Format o)"
"[sol2] ALL DONE $(Get-Date -Format o)"
Stop-Transcript | Out-Null
