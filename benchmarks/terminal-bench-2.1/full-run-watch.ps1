# Full-run watcher: every 5 min, write per-run settled/pass counts to
# full-run-status.txt. Stops when the CC transcript (run 4, last in the
# chain) reports ALL DONE or after 36 hours.
Set-Location 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
$deadline = (Get-Date).AddHours(36)
do {
  Start-Sleep -Seconds 300
  $lines = @("updated: $(Get-Date -Format o)")
  foreach ($d in @('jobs-full-sol','jobs-full-opus5','jobs-full-codex','jobs-full-cc')) {
    $settled = 0; $pass = 0
    Get-ChildItem -Recurse -Filter result.json -Path $d -ErrorAction SilentlyContinue | ForEach-Object {
      try { $j = Get-Content $_.FullName -Raw | ConvertFrom-Json } catch { return }
      if (-not $j.task_id) { return }
      if ($j.verifier_result -or $j.exception_info) { $settled++ }
      if ($j.verifier_result.rewards.reward -eq 1) { $pass++ }
    }
    $lines += ('{0,-16} settled={1,-3} pass={2}' -f $d, $settled, $pass)
  }
  $master = Get-Content '.\full-run-master.log' -Tail 3 -ErrorAction SilentlyContinue
  $lines += ($master | ForEach-Object { 'master: ' + $_ })
  $cc = Get-Content '.\full-run-cc.log' -Tail 2 -ErrorAction SilentlyContinue
  $lines += ($cc | ForEach-Object { 'cc: ' + $_ })
  Set-Content -Path '.\full-run-status.txt' -Value ($lines -join "`n")
  $done = ($cc | Select-String 'ALL DONE') -ne $null
} while (-not $done -and (Get-Date) -lt $deadline)
