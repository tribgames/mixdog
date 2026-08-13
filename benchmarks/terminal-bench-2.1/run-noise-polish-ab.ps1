$ErrorActionPreference = 'Continue'
git -C C:\Project\mixdog worktree add C:\Project\mixdog-bench-base 4205555c 2>&1 | Out-Host
Set-Location C:\Project\mixdog\benchmarks\terminal-bench-2.1
& .\harness\run-tb21.ps1 -JobsDir jobs-noise-polish-cur-20260805 -Include db-wal-recovery,git-leak-recovery,fix-code-vulnerability -Concurrent 3 -RouteProfile opus5-solo *>&1 | Tee-Object -FilePath C:\Project\mixdog\benchmarks\terminal-bench-2.1\polish-cur.log | Out-Null
'CUR-DONE'
$env:MIXDOG_TB_PREBAKE_TAR = 'C:\Project\mixdog\benchmarks\terminal-bench-2.1\mixdog-prebake\mixdog-node-prebake.tar.gz'
Set-Location C:\Project\mixdog-bench-base\benchmarks\terminal-bench-2.1
& .\harness\run-tb21.ps1 -JobsDir jobs-noise-polish-base-20260805 -Include db-wal-recovery,git-leak-recovery,fix-code-vulnerability -Concurrent 3 -RouteProfile opus5-solo *>&1 | Tee-Object -FilePath C:\Project\mixdog\benchmarks\terminal-bench-2.1\polish-base.log | Out-Null
'BASE-DONE'
'ALL-RUNS-DONE'

