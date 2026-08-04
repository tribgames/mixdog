# Final 4-task smoke (opus5-solo, today's polished snapshot). Detached via
# Task Scheduler so the session child guardian cannot kill it on memory dips.
Set-Location 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
Start-Transcript -Path '.\smoke-final.log' -Force | Out-Null
.\harness\run-tb21.ps1 -JobsDir jobs-smoke-final -Include db-wal-recovery,git-leak-recovery,polyglot-c-py,prove-plus-comm -Concurrent 4 -RouteProfile opus5-solo -Workflow solo -AgentEnv MIXDOG_TURN_TIMING=1
"[smoke-final] ALL DONE $(Get-Date -Format o)"
Stop-Transcript | Out-Null
