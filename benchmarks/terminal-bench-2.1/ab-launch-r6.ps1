# Round-6: batching rules + patch->shell ordering insurance, vs round-4 baseline.
Set-Location 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
Start-Transcript -Path '.\ab-r6.log' -Force | Out-Null
$env:PYTHONPATH = 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:MIXDOG_TB_SRC_SNAPSHOT = 'C:\Project\mixdog\benchmarks\terminal-bench-2.1\tb-src-snap-r6'
$env:MIXDOG_TB_FALLBACK_STATE_DIR = 'C:\Project\mixdog\benchmarks\terminal-bench-2.1\tb-fallback-ab5'
harbor run -d terminal-bench/terminal-bench-2-1 `
  --agent-import-path harness.mixdog_agent:MixdogAgent `
  -o jobs-ab5r6-rules -n 2 -r 2 `
  --retry-exclude AgentTimeoutError `
  --retry-exclude VerifierOutputParseError `
  --retry-exclude RewardFileEmptyError `
  --verifier-env UV_HTTP_TIMEOUT=300 `
  -q -y `
  -i terminal-bench/db-wal-recovery `
  -i terminal-bench/polyglot-c-py `
  --ae MIXDOG_AGENT_TRACE_PATH=/logs/agent/agent-trace.jsonl `
  --ak route_profile=opus5-solo `
  --ak workflow=solo
Stop-Transcript | Out-Null
