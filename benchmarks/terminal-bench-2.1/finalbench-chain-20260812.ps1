param(
    [ValidateSet('gpt', 'opus')]
    [string]$StartAt = 'gpt'
)

# Final 4-run TB2.1 comparison chain (2026-08-12), sequential, 89 tasks, n=8.
# Web search OFF everywhere (mixdog has no web tool in bench; CC gets
# --disallowedTools WebSearch,WebFetch; Codex runs tools.web_search=false).
#   phase1 mixdog  GPT sol xhigh      (route sol-xhigh-nofast, fast OFF)
#   phase2 mixdog  Opus 5 high        (route opus5-solo)
#   phase3 Claude Code  claude-opus-5 effort=high
#   phase4 Codex        gpt-5.6-sol   effort=xhigh
Set-Location 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
$transcriptPath = if ($StartAt -eq 'gpt') {
    '.\finalbench-gpt-chain-r3-20260812.log'
} else {
    '.\finalbench-after-gpt-r1-20260812.log'
}
Start-Transcript -Path $transcriptPath -Force | Out-Null
$env:PYTHONPATH = 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'

# Docker's predefined address pools cap concurrent compose networks (~31 on
# Docker Desktop defaults). Orphan networks from an aborted run exhausted the
# pool on 2026-08-12 and killed 77/89 trials with "all predefined address
# pools have been fully subnetted", so every phase starts from a clean pool.
function Clear-DockerNetworks([string]$phase) {
    docker network prune -f *> $null
    $left = @(docker network ls -q).Count
    "[chain] $phase network pool cleaned — networks left=$left"
}

# ---- phase1: mixdog GPT sol xhigh, fast OFF ------------------------------
if ($StartAt -eq 'gpt') {
    Clear-DockerNetworks 'phase1'
    "[chain] phase1 mixdog sol-xhigh-nofast start $(Get-Date -Format o)"
    try {
        & .\harness\run-tb21.ps1 `
            -JobsDir 'jobs-finalbench-mixdog-gpt-nofast-r5-20260812' `
            -Concurrent 8 `
            -RouteProfile 'sol-xhigh-nofast' `
            -Workflow 'solo-bench' `
            *>> '.\finalbench-mixdog-gpt-nofast-r5-20260812.log'
    } catch { $_ | Out-File -Append '.\finalbench-mixdog-gpt-nofast-r5-20260812.log' }
    "[chain] phase1 exit=$LASTEXITCODE $(Get-Date -Format o)"
}

# ---- phase2: mixdog Opus 5, effort high ----------------------------------
Clear-DockerNetworks 'phase2'
"[chain] phase2 mixdog opus5-solo start $(Get-Date -Format o)"
try {
    & .\harness\run-tb21.ps1 `
        -JobsDir 'jobs-finalbench-mixdog-opus-r2-20260812' `
        -Concurrent 8 `
        -RouteProfile 'opus5-solo' `
        -Workflow 'solo-bench' `
        *>> '.\finalbench-mixdog-opus-r2-20260812.log'
} catch { $_ | Out-File -Append '.\finalbench-mixdog-opus-r2-20260812.log' }
"[chain] phase2 exit=$LASTEXITCODE $(Get-Date -Format o)"

# ---- phase3: Claude Code Opus baseline, web tools disallowed -------------
# The 2026-08-11 fair CC run died 89/89 NonZeroAgentExitCodeError on a stale
# OAuth token, so refresh the host credential before extracting it here.
Clear-DockerNetworks 'phase3'
"[chain] phase3 claude-code opus start $(Get-Date -Format o)"
$ccVersion = '2.1.220'
$binDir = '.\cc-bin'
$bin = Join-Path $binDir 'claude-linux-x64'
if (-not (Test-Path $bin)) {
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    "[chain] downloading claude $ccVersion linux-x64 to host cache..."
    curl.exe -fsSL -o $bin "https://downloads.claude.ai/claude-code-releases/$ccVersion/linux-x64/claude"
    if ($LASTEXITCODE -ne 0) { "[chain] ERROR claude binary download failed" }
}
$credPath = "$env:USERPROFILE\.claude\.credentials.json"
function Get-CcToken {
    if (-not (Test-Path $credPath)) { return $null }
    $c = Get-Content $credPath -Raw | ConvertFrom-Json
    $t = $c.claudeAiOauth.accessToken
    if (-not $t) { $t = $c.accessToken }
    $exp = $c.claudeAiOauth.expiresAt
    [pscustomobject]@{ Token = $t; ExpiresAt = $exp }
}
$cc = Get-CcToken
$stale = $true
if ($cc -and $cc.ExpiresAt) {
    $left = ([DateTimeOffset]::FromUnixTimeMilliseconds([int64]$cc.ExpiresAt) - [DateTimeOffset]::UtcNow).TotalMinutes
    "[chain] claude token ttl=$([math]::Round($left,1))min"
    $stale = $left -lt 45
}
if ($stale -and (Get-Command claude -ErrorAction SilentlyContinue)) {
    "[chain] refreshing host claude credential..."
    try { claude -p 'ok' *>> '.\finalbench-cc-opus-20260812.log' } catch { "[chain] refresh probe failed" }
    $cc = Get-CcToken
}
if ((Test-Path $bin) -and $cc -and $cc.Token) {
    $env:CC_PREBAKED_BINARY = (Resolve-Path $bin).Path
    $env:CLAUDE_CODE_OAUTH_TOKEN = $cc.Token
    $env:CLAUDE_FORCE_OAUTH = '1'
    try {
        harbor run -d terminal-bench/terminal-bench-2-1 `
            --agent-import-path harness.claude_code_prebaked:ClaudeCodePrebaked `
            -m claude-opus-5 `
            --ak reasoning_effort=high `
            --ak disallowed_tools='WebSearch,WebFetch' `
            --agent-setup-timeout-multiplier 4 `
            -o jobs-finalbench-cc-opus-20260812 -n 8 -r 2 -q -y `
            *>> '.\finalbench-cc-opus-20260812.log'
    } catch { $_ | Out-File -Append '.\finalbench-cc-opus-20260812.log' }
    "[chain] phase3 exit=$LASTEXITCODE $(Get-Date -Format o)"
} else {
    "[chain] ERROR phase3 skipped — missing claude binary or OAuth token"
}

# ---- phase4: Codex GPT baseline, web search disabled ---------------------
Clear-DockerNetworks 'phase4'
"[chain] phase4 codex nosearch start $(Get-Date -Format o)"
$env:CODEX_FORCE_AUTH_JSON = '1'
try {
    harbor run -d terminal-bench/terminal-bench-2-1 `
        --agent-import-path harness.codex_nosearch:CodexNoSearch `
        -m gpt-5.6-sol `
        --ak reasoning_effort=xhigh `
        -o jobs-finalbench-codex-gpt-20260812 -n 8 -r 2 -q -y `
        *>> '.\finalbench-codex-gpt-20260812.log'
} catch { $_ | Out-File -Append '.\finalbench-codex-gpt-20260812.log' }
"[chain] phase4 exit=$LASTEXITCODE $(Get-Date -Format o)"
"[chain] ALL DONE $(Get-Date -Format o)"
Stop-Transcript | Out-Null
