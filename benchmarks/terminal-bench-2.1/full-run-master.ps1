# Full TB2.1 (89 tasks, k=1, n=3) — three sequential runs:
#   1. mixdog solo, sol-xhigh-nofast (xhigh lead, no fast tier — symmetric with codex run3)
#   2. mixdog solo, opus5-solo (high, no fast tier)
#   3. codex, gpt-5.6-sol xhigh (fresh home = no fast tier)
Set-Location 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
Start-Transcript -Path '.\full-run-master.log' -Force | Out-Null
$env:PYTHONPATH = 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:MIXDOG_TB_SRC_SNAPSHOT = 'C:\Project\mixdog\benchmarks\terminal-bench-2.1\tb-src-snap-full'
$env:MIXDOG_TB_FALLBACK_STATE_DIR = 'C:\Project\mixdog\benchmarks\terminal-bench-2.1\tb-fallback-ab5'

"[master] run1 mixdog sol-high start $(Get-Date -Format o)"
harbor run -d terminal-bench/terminal-bench-2-1 `
  --agent-import-path harness.mixdog_agent:MixdogAgent `
  -o jobs-full-sol -n 3 -r 2 `
  --retry-exclude AgentTimeoutError `
  --retry-exclude VerifierOutputParseError `
  --retry-exclude RewardFileEmptyError `
  --verifier-env UV_HTTP_TIMEOUT=300 `
  -q -y `
  --ak route_profile=sol-xhigh-nofast `
  --ak workflow=solo
"[master] run1 exit=$LASTEXITCODE $(Get-Date -Format o)"

"[master] run2 mixdog opus5 start $(Get-Date -Format o)"
harbor run -d terminal-bench/terminal-bench-2-1 `
  --agent-import-path harness.mixdog_agent:MixdogAgent `
  -o jobs-full-opus5 -n 3 -r 2 `
  --retry-exclude AgentTimeoutError `
  --retry-exclude VerifierOutputParseError `
  --retry-exclude RewardFileEmptyError `
  --verifier-env UV_HTTP_TIMEOUT=300 `
  -q -y `
  --ak route_profile=opus5-solo `
  --ak workflow=solo
"[master] run2 exit=$LASTEXITCODE $(Get-Date -Format o)"

"[master] run3 codex start $(Get-Date -Format o)"
$env:CODEX_FORCE_AUTH_JSON = '1'
harbor run -d terminal-bench/terminal-bench-2-1 -a codex -m gpt-5.6-sol --ak reasoning_effort=xhigh `
  -o jobs-full-codex -n 3 -r 2 -q -y
"[master] run3 exit=$LASTEXITCODE $(Get-Date -Format o)"
"[master] ALL DONE $(Get-Date -Format o)"
Stop-Transcript | Out-Null
