# Detached round-3 watcher (Task Scheduler): waits for both r3 runs to settle,
# then writes a summary to ab-r3-summary.txt for shell-free pickup.
Set-Location 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
$deadline = (Get-Date).AddMinutes(45)
do {
  Start-Sleep -Seconds 45
  $done = 0
  foreach ($d in @('jobs-ab5r3-solo-opus5','jobs-ab5r3-cc-opus5')) {
    $c = (Get-ChildItem -Recurse -Filter result.json -Path $d -ErrorAction SilentlyContinue | ForEach-Object {
      $j = Get-Content $_.FullName -Raw | ConvertFrom-Json
      if ($j.task_id -and ($j.verifier_result -or $j.exception_info)) { 1 }
    } | Measure-Object).Count
    if ($c -ge 5) { $done++ }
  }
} while ($done -lt 2 -and (Get-Date) -lt $deadline)
$out = @("settled-sides: $done", "written: $(Get-Date -Format o)")
foreach ($d in @('jobs-ab5r3-solo-opus5','jobs-ab5r3-cc-opus5')) {
  $out += "== $d =="
  Get-ChildItem -Recurse -Filter result.json -Path $d -ErrorAction SilentlyContinue | ForEach-Object {
    $j = Get-Content $_.FullName -Raw | ConvertFrom-Json
    if (-not $j.task_id) { return }
    $out += ('{0,-26} reward={1} exc={2}' -f $j.task_id.name, ($j.verifier_result.rewards.reward ?? '-'), ($j.exception_info.exception_type ?? '-'))
  }
}
Set-Content -Path '.\ab-r3-summary.txt' -Value ($out -join "`n")
