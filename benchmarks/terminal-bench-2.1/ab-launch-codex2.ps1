# Detached A/B round-2 launcher (Task Scheduler): codex.
Set-Location 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
Start-Transcript -Path '.\ab-codex2.log' -Force | Out-Null
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:CODEX_FORCE_AUTH_JSON = '1'
harbor run -d terminal-bench/terminal-bench-2-1 -a codex -m gpt-5.6-sol --ak reasoning_effort=xhigh `
  -o jobs-ab5r2-codex -n 4 -r 2 -q -y `
  -i terminal-bench/prove-plus-comm `
  -i terminal-bench/polyglot-c-py `
  -i terminal-bench/db-wal-recovery `
  -i terminal-bench/git-leak-recovery `
  -i terminal-bench/fix-code-vulnerability
Stop-Transcript | Out-Null
