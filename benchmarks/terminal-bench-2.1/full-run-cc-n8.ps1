# Full TB2.1 (89 tasks, k=1) — Claude Code, Opus 5, effort=high, n=8.
# Uses the prebaked agent (harness.claude_code_prebaked): the claude linux
# binary is downloaded ONCE on the host and docker-cp'd into each trial,
# removing the ~275MB per-container download that tripped setup timeouts.
# Standalone (no master-chain wait): launched directly via Task Scheduler.
# Auth: extracts the live OAuth access token from ~/.claude/.credentials.json
# at launch time and injects it as CLAUDE_CODE_OAUTH_TOKEN.
Set-Location 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
Start-Transcript -Path '.\full-run-cc-n8.log' -Force | Out-Null
$env:PYTHONPATH = 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
# Ensure the host-cached claude binary exists (version-pinned to the host CLI).
$ccVersion = '2.1.220'
$binDir = '.\cc-bin'
$bin = Join-Path $binDir 'claude-linux-x64'
if (-not (Test-Path $bin)) {
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  "[cc-n8] downloading claude $ccVersion linux-x64 to host cache..."
  curl.exe -fsSL -o $bin "https://downloads.claude.ai/claude-code-releases/$ccVersion/linux-x64/claude"
  if ($LASTEXITCODE -ne 0) { Write-Error 'claude binary download failed'; Stop-Transcript | Out-Null; exit 1 }
}
$env:CC_PREBAKED_BINARY = (Resolve-Path $bin).Path
$creds = Get-Content "$env:USERPROFILE\.claude\.credentials.json" -Raw | ConvertFrom-Json
$token = $creds.claudeAiOauth.accessToken
if (-not $token) { $token = $creds.accessToken }
if (-not $token) { Write-Error 'no Claude Code OAuth access token found'; Stop-Transcript | Out-Null; exit 1 }
$env:CLAUDE_CODE_OAUTH_TOKEN = $token
$env:CLAUDE_FORCE_OAUTH = '1'
"[cc-n8] start $(Get-Date -Format o)"
harbor run -d terminal-bench/terminal-bench-2-1 `
  --agent-import-path harness.claude_code_prebaked:ClaudeCodePrebaked `
  -m claude-opus-5 `
  --ak reasoning_effort=high `
  --agent-setup-timeout-multiplier 4 `
  -o jobs-full-cc-n8 -n 8 -r 2 -q -y
"[cc-n8] exit=$LASTEXITCODE $(Get-Date -Format o)"
"[cc-n8] ALL DONE $(Get-Date -Format o)"
Stop-Transcript | Out-Null
