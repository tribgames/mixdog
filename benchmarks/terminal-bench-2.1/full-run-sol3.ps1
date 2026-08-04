# Chained sol run: waits for the v3 opus run (full-run-final.log ALL DONE),
# then runs sol-xhigh-nofast on the full 89-task set at n=8 with the same
# fixed snapshot semantics (run-tb21 refreezes the working tree at launch).
# Detached via Task Scheduler (pwsh 7) like the main run.
Set-Location 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
Start-Transcript -Path '.\full-run-sol3.log' -Force | Out-Null
$deadline = (Get-Date).AddHours(24)
while ((Get-Date) -lt $deadline) {
  $m = Get-Content '.\full-run-final.log' -Raw -ErrorAction SilentlyContinue
  if ($m -and $m -match '\[full-final\] ALL DONE') { break }
  Start-Sleep -Seconds 120
}
"[sol3] chain start $(Get-Date -Format o)"
.\harness\run-tb21.ps1 -JobsDir jobs-full-sol3 -Concurrent 8 -RouteProfile sol-xhigh-nofast -Workflow solo -AgentEnv MIXDOG_TURN_TIMING=1,MIXDOG_BOOT_JITTER_MS=0
"[sol3] ALL DONE $(Get-Date -Format o)"
Stop-Transcript | Out-Null
