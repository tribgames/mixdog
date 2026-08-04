# Full TB2.1 run 4: Claude Code (Opus 5). Waits for the sequential master
# (runs 1-3) to finish, then runs — keeps concurrency at one harbor at a time.
Set-Location 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
Start-Transcript -Path '.\full-run-cc.log' -Force | Out-Null
$deadline = (Get-Date).AddHours(36)
while ((Get-Date) -lt $deadline) {
  $m = Get-Content '.\full-run-master.log' -Raw -ErrorAction SilentlyContinue
  if ($m -and $m -match 'ALL DONE') { break }
  Start-Sleep -Seconds 120
}
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$creds = Get-Content "$env:USERPROFILE\.claude\.credentials.json" -Raw | ConvertFrom-Json
$token = $creds.claudeAiOauth.accessToken
if (-not $token) { $token = $creds.accessToken }
if (-not $token) { Write-Error 'no Claude Code OAuth access token found'; Stop-Transcript | Out-Null; exit 1 }
$env:CLAUDE_CODE_OAUTH_TOKEN = $token
$env:CLAUDE_FORCE_OAUTH = '1'
"[cc-full] start $(Get-Date -Format o)"
harbor run -d terminal-bench/terminal-bench-2-1 -a claude-code -m claude-opus-5 `
  -o jobs-full-cc -n 3 -r 2 -q -y
"[cc-full] exit=$LASTEXITCODE $(Get-Date -Format o)"
"[cc-full] ALL DONE $(Get-Date -Format o)"
Stop-Transcript | Out-Null
