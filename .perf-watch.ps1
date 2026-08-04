$log='C:\Project\mixdog\.perf-watch.log'
"[start] $(Get-Date -Format HH:mm:ss) perf sampler (5s)" | Out-File $log -Encoding utf8
$end=(Get-Date).AddMinutes(45)
$prev=@{}
while((Get-Date) -lt $end){
  $now=Get-Date -Format HH:mm:ss
  $mem=[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024)
  $procs=Get-Process | Where-Object { $_.CPU -gt 5 }
  $deltas=@()
  foreach($p in $procs){
    $k="$($p.Id)"
    $c=[math]::Round($p.CPU,1)
    if($prev.ContainsKey($k)){
      $d=[math]::Round($c-$prev[$k],1)
      if($d -gt 0.5){ $deltas += "{0}({1})+{2}s" -f $p.ProcessName,$p.Id,$d }
    }
    $prev[$k]=$c
  }
  if($deltas.Count -gt 0 -or $mem -lt 1500){
    "[{0}] freeMB={1} busy: {2}" -f $now,$mem,(($deltas | Sort-Object { -[double]($_ -replace '.*\+','' -replace 's','') } | Select-Object -First 6) -join ' ') | Out-File $log -Append -Encoding utf8
  }
  Start-Sleep -Seconds 5
}
"[done] $(Get-Date -Format HH:mm:ss)" | Out-File $log -Append -Encoding utf8
