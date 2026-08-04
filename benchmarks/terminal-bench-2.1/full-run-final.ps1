# Final 89-task full run (opus5-solo, today's polished snapshot). Detached
# via Task Scheduler (pwsh 7) so the session child guardian cannot kill it.
Set-Location 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
Start-Transcript -Path '.\full-run-final.log' -Force | Out-Null
# MIXDOG_BOOT_JITTER_MS=0: CC parity — no artificial first-ask spread; the
# per-trial setup variance (npm install, 2-4 min) already staggers starts.
.\harness\run-tb21.ps1 -JobsDir jobs-full-final -Concurrent 8 -RouteProfile opus5-solo -Workflow solo -AgentEnv MIXDOG_TURN_TIMING=1,MIXDOG_BOOT_JITTER_MS=0
"[full-final] ALL DONE $(Get-Date -Format o)"
Stop-Transcript | Out-Null
