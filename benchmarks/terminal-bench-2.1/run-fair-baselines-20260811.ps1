# Fair-baseline chain (2026-08-11): wait for the running Opus full run, then
# run three spec-matched 89-task full runs sequentially, all with web search
# OFF and no priority tier anywhere:
#   1. mixdog  sol-xhigh-nofast  (GPT, fast OFF — replaces the fast=true run)
#   2. Claude Code  claude-opus-5 high  --disallowedTools WebSearch,WebFetch
#   3. Codex  gpt-5.6-sol xhigh  via harness.codex_nosearch (tools.web_search=false)
Set-Location 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
Start-Transcript -Path '.\fair-chain-20260811.log' -Force | Out-Null
$env:PYTHONPATH = 'C:\Project\mixdog\benchmarks\terminal-bench-2.1'
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'

# ---- Phase 0: wait for the in-flight Opus full run to finish -------------
# Completion marker: Harbor prints its final results table (header contains
# "Trials") into the run transcript. Fallback: no task containers for 10
# consecutive minutes (crashed/aborted run) also releases the chain.
$opusLog = '.\full-currentstate-stop-opus5-20260811.log'
"[fair] phase0 wait-for-opus start $(Get-Date -Format o)"
$idleMinutes = 0
while ($true) {
    $done = (Test-Path $opusLog) -and
        (Select-String -Path $opusLog -Pattern 'Trials' -Quiet)
    if ($done) { "[fair] opus results table detected"; break }
    $containers = @(docker ps -q).Count
    if ($containers -eq 0) { $idleMinutes++ } else { $idleMinutes = 0 }
    if ($idleMinutes -ge 10) { "[fair] no containers for 10min — releasing chain"; break }
    Start-Sleep -Seconds 60
}
"[fair] phase0 done $(Get-Date -Format o)"

# ---- Phase 1: mixdog GPT full run, fast OFF ------------------------------
"[fair] phase1 mixdog sol-xhigh-nofast start $(Get-Date -Format o)"
try {
    & .\harness\run-tb21.ps1 `
        -JobsDir 'jobs-full-fair-sol-nofast-solobench-n8-20260811' `
        -Concurrent 8 `
        -RouteProfile 'sol-xhigh-nofast' `
        -Workflow 'solo-bench' `
        *>> '.\fair-mixdog-sol-nofast-20260811.log'
} catch { $_ | Out-File -Append '.\fair-mixdog-sol-nofast-20260811.log' }
"[fair] phase1 exit=$LASTEXITCODE $(Get-Date -Format o)"

# ---- Phase 2: Claude Code Opus baseline, web tools disallowed ------------
"[fair] phase2 claude-code opus start $(Get-Date -Format o)"
$ccVersion = '2.1.220'
$binDir = '.\cc-bin'
$bin = Join-Path $binDir 'claude-linux-x64'
if (-not (Test-Path $bin)) {
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    "[fair] downloading claude $ccVersion linux-x64 to host cache..."
    curl.exe -fsSL -o $bin "https://downloads.claude.ai/claude-code-releases/$ccVersion/linux-x64/claude"
    if ($LASTEXITCODE -ne 0) { "[fair] ERROR claude binary download failed — skipping phase2" }
}
if (Test-Path $bin) {
    $env:CC_PREBAKED_BINARY = (Resolve-Path $bin).Path
    # Token extracted here (not at chain launch) so it is fresh for this phase.
    $creds = Get-Content "$env:USERPROFILE\.claude\.credentials.json" -Raw | ConvertFrom-Json
    $token = $creds.claudeAiOauth.accessToken
    if (-not $token) { $token = $creds.accessToken }
    if ($token) {
        $env:CLAUDE_CODE_OAUTH_TOKEN = $token
        $env:CLAUDE_FORCE_OAUTH = '1'
        try {
            harbor run -d terminal-bench/terminal-bench-2-1 `
                --agent-import-path harness.claude_code_prebaked:ClaudeCodePrebaked `
                -m claude-opus-5 `
                --ak reasoning_effort=high `
                --ak disallowed_tools='WebSearch,WebFetch' `
                --agent-setup-timeout-multiplier 4 `
                -o jobs-full-fair-cc-nosearch-n8-20260811 -n 8 -r 2 -q -y `
                *>> '.\fair-cc-nosearch-20260811.log'
        } catch { $_ | Out-File -Append '.\fair-cc-nosearch-20260811.log' }
        "[fair] phase2 exit=$LASTEXITCODE $(Get-Date -Format o)"
    } else {
        "[fair] ERROR no Claude Code OAuth token — skipping phase2"
    }
}

# ---- Phase 3: Codex GPT baseline, web search disabled --------------------
"[fair] phase3 codex nosearch start $(Get-Date -Format o)"
$env:CODEX_FORCE_AUTH_JSON = '1'
try {
    harbor run -d terminal-bench/terminal-bench-2-1 `
        --agent-import-path harness.codex_nosearch:CodexNoSearch `
        -m gpt-5.6-sol `
        --ak reasoning_effort=xhigh `
        -o jobs-full-fair-codex-nosearch-n8-20260811 -n 8 -r 2 -q -y `
        *>> '.\fair-codex-nosearch-20260811.log'
} catch { $_ | Out-File -Append '.\fair-codex-nosearch-20260811.log' }
"[fair] phase3 exit=$LASTEXITCODE $(Get-Date -Format o)"
"[fair] ALL DONE $(Get-Date -Format o)"
Stop-Transcript | Out-Null
