# Round-6 CC side: Claude Code headless, Opus 5, same 2-task pair.
Set-Location 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
Start-Transcript -Path '.\ab-cc3.log' -Force | Out-Null
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$creds = Get-Content "$env:USERPROFILE\.claude\.credentials.json" -Raw | ConvertFrom-Json
$token = $creds.claudeAiOauth.accessToken
if (-not $token) { $token = $creds.accessToken }
if (-not $token) { Write-Error 'no Claude Code OAuth access token found'; Stop-Transcript | Out-Null; exit 1 }
$env:CLAUDE_CODE_OAUTH_TOKEN = $token
$env:CLAUDE_FORCE_OAUTH = '1'
harbor run -d terminal-bench/terminal-bench-2-1 -a claude-code -m claude-opus-5 `
  -o jobs-ab5r6-cc -n 2 -r 2 -q -y `
  -i terminal-bench/db-wal-recovery `
  -i terminal-bench/polyglot-c-py
Stop-Transcript | Out-Null
