# Round-6 Codex side: gpt-5.6-sol xhigh, same 2-task pair.
Set-Location 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
Start-Transcript -Path '.\ab-codex3.log' -Force | Out-Null
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:CODEX_FORCE_AUTH_JSON = '1'
harbor run -d terminal-bench/terminal-bench-2-1 -a codex -m gpt-5.6-sol --ak reasoning_effort=xhigh `
  -o jobs-ab5r6-codex -n 2 -r 2 -q -y `
  -i terminal-bench/db-wal-recovery `
  -i terminal-bench/polyglot-c-py
Stop-Transcript | Out-Null
