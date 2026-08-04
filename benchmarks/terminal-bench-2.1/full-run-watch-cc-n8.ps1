# Watcher for the CC n=8 full run: every 5 min, write settled/pass counts to
# full-run-cc-n8-status.txt. Stops on ALL DONE in full-run-cc-n8.log or 24h.
# (jobs-full-sol2 stays in the loop so a later manual sol2 launch is counted.)
Set-Location 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
$deadline = (Get-Date).AddHours(24)
do {
  Start-Sleep -Seconds 300
  $lines = @("updated: $(Get-Date -Format o)")
  foreach ($d in @('jobs-full-cc-n8','jobs-full-sol2')) {
    $settled = 0; $pass = 0
    Get-ChildItem -Recurse -Filter result.json -Path $d -ErrorAction SilentlyContinue | ForEach-Object {
      try { $j = Get-Content $_.FullName -Raw | ConvertFrom-Json } catch { return }
      if (-not $j.task_id) { return }
      if ($j.verifier_result -or $j.exception_info) { $settled++ }
      if ($j.verifier_result.rewards.reward -eq 1) { $pass++ }
    }
    $lines += ('{0,-16} settled={1,-3} pass={2}' -f $d, $settled, $pass)
  }
  $cc = Get-Content '.\full-run-cc-n8.log' -Tail 2 -ErrorAction SilentlyContinue
  $lines += ($cc | ForEach-Object { 'cc-n8: ' + $_ })
  $sol2 = Get-Content '.\full-run-sol2.log' -Tail 2 -ErrorAction SilentlyContinue
  $lines += ($sol2 | ForEach-Object { 'sol2: ' + $_ })
  Set-Content -Path '.\full-run-cc-n8-status.txt' -Value ($lines -join "`n")
  $done = ($cc | Select-String 'ALL DONE') -ne $null
} while (-not $done -and (Get-Date) -lt $deadline)
