# Appends a progress snapshot every 3 minutes until the bench finishes.
# Runs independently of any agent turn so the reporting cadence never stalls.
param(
  [string]$JobsDir = 'C:\Project\mixdog\benchmarks\terminal-bench-2.1\jobs-full-opus5-solo-20260823-144706',
  [string]$LogPath = 'C:\Project\mixdog\benchmarks\terminal-bench-2.1\analysis\progress-log.txt',
  [int]$IntervalSec = 180,
  [int]$MaxChecks = 80
)

Set-Location 'C:\Project\mixdog'
for ($i = 1; $i -le $MaxChecks; $i++) {
  $stamp = (Get-Date).ToString('HH:mm:ss')
  $snapshot = & node benchmarks/terminal-bench-2.1/analysis/progress.mjs $JobsDir 2>&1
  Add-Content -LiteralPath $LogPath -Value "===== check $i @ $stamp ====="
  Add-Content -LiteralPath $LogPath -Value $snapshot
  Add-Content -LiteralPath $LogPath -Value ''
  if ($snapshot -match '진행\s+89/89') {
    Add-Content -LiteralPath $LogPath -Value '===== BENCH COMPLETE ====='
    break
  }
  Start-Sleep -Seconds $IntervalSec
}
