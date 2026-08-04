# Reorder helper: kill master's run2 (opus5) harbor the moment it starts so
# the master chain falls through to run3 (codex). opus5 reruns last via
# full-run-opus5-last.ps1. Runs under Task Scheduler — immune to the mixdog
# session shell guardian.
Set-Location 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
Start-Transcript -Path '.\full-run-intercept.log' -Force | Out-Null
$deadline = (Get-Date).AddHours(6)
$killed = $false
while ((Get-Date) -lt $deadline) {
  $procs = Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -match 'jobs-full-opus5' -and $_.CommandLine -match 'harbor'
  }
  if ($procs) {
    foreach ($p in $procs) { "killing pid=$($p.ProcessId)"; taskkill /T /F /PID $p.ProcessId 2>&1 | Out-Null }
    $killed = $true
    break
  }
  if (Select-String -Path .\full-run-master.log -Pattern '\[master\] run3 codex start' -Quiet -ErrorAction SilentlyContinue) {
    'run3 already started without intercept target'
    break
  }
  Start-Sleep -Seconds 5
}
if ($killed) {
  Start-Sleep 10
  Remove-Item -Recurse -Force .\jobs-full-opus5 -ErrorAction SilentlyContinue
  "intercepted+cleaned $(Get-Date -Format o)"
} else {
  "no intercept $(Get-Date -Format o)"
}
Stop-Transcript | Out-Null
