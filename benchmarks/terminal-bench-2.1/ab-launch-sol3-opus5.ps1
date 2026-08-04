# Detached A/B round-3 launcher (Task Scheduler): mixdog solo, Claude Opus 5 lead.
# PREPARED — register/run via schtasks when the round starts.
Set-Location 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
Start-Transcript -Path '.\ab-sol3.log' -Force | Out-Null
$env:PYTHONPATH = 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:MIXDOG_TB_SRC_SNAPSHOT = 'C:\Project\mixdog\benchmarks\terminal-bench-2.1\tb-src-snap-ab5'
$env:MIXDOG_TB_FALLBACK_STATE_DIR = 'C:\Project\mixdog\benchmarks\terminal-bench-2.1\tb-fallback-ab5'
harbor run -d terminal-bench/terminal-bench-2-1 `
  --agent-import-path harness.mixdog_agent:MixdogAgent `
  -o jobs-ab5r3-solo-opus5 -n 4 -r 2 `
  --retry-exclude AgentTimeoutError `
  --retry-exclude VerifierOutputParseError `
  --retry-exclude RewardFileEmptyError `
  --verifier-env UV_HTTP_TIMEOUT=300 `
  -q -y `
  -i terminal-bench/log-summary-date-ranges `
  -i terminal-bench/regex-log `
  -i terminal-bench/write-compressor `
  -i terminal-bench/kv-store-grpc `
  -i terminal-bench/pypi-server `
  --ak route_profile=opus5-solo `
  --ak workflow=solo
Stop-Transcript | Out-Null
