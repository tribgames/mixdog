# Detached A/B round-3 launcher (Task Scheduler): Claude Code headless, Opus 5.
# PREPARED — register/run via schtasks when the round starts.
# Auth: extracts the live OAuth access token from ~/.claude/.credentials.json
# at launch time and injects it as CLAUDE_CODE_OAUTH_TOKEN (Harbor adapter
# forwards it into the container; token bytes never hit a command line).
Set-Location 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
Start-Transcript -Path '.\ab-cc.log' -Force | Out-Null
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$creds = Get-Content "$env:USERPROFILE\.claude\.credentials.json" -Raw | ConvertFrom-Json
$token = $creds.claudeAiOauth.accessToken
if (-not $token) { $token = $creds.accessToken }
if (-not $token) { Write-Error 'no Claude Code OAuth access token found'; Stop-Transcript | Out-Null; exit 1 }
$env:CLAUDE_CODE_OAUTH_TOKEN = $token
$env:CLAUDE_FORCE_OAUTH = '1'
harbor run -d terminal-bench/terminal-bench-2-1 -a claude-code -m claude-opus-5 `
  -o jobs-ab5r3-cc-opus5 -n 4 -r 2 -q -y `
  -i terminal-bench/log-summary-date-ranges `
  -i terminal-bench/regex-log `
  -i terminal-bench/write-compressor `
  -i terminal-bench/kv-store-grpc `
  -i terminal-bench/pypi-server
Stop-Transcript | Out-Null
