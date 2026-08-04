# Detached A/B round-5 launcher: mixdog solo-fast, Opus 5, round-2 light task set.
Set-Location 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
Start-Transcript -Path '.\ab-sol5.log' -Force | Out-Null
$env:PYTHONPATH = 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:MIXDOG_TB_SRC_SNAPSHOT = 'C:\Project\mixdog\benchmarks\terminal-bench-2.1\tb-src-snap-ab5fast'
$env:MIXDOG_TB_FALLBACK_STATE_DIR = 'C:\Project\mixdog\benchmarks\terminal-bench-2.1\tb-fallback-ab5'
harbor run -d terminal-bench/terminal-bench-2-1 `
  --agent-import-path harness.mixdog_agent:MixdogAgent `
  -o jobs-ab5r5-solofast -n 8 -r 2 `
  --retry-exclude AgentTimeoutError `
  --retry-exclude VerifierOutputParseError `
  --retry-exclude RewardFileEmptyError `
  --verifier-env UV_HTTP_TIMEOUT=300 `
  -q -y `
  -i terminal-bench/prove-plus-comm `
  -i terminal-bench/polyglot-c-py `
  -i terminal-bench/db-wal-recovery `
  -i terminal-bench/git-leak-recovery `
  -i terminal-bench/fix-code-vulnerability `
  --ak route_profile=opus5-solo `
  --ak workflow=solo-fast
Stop-Transcript | Out-Null
