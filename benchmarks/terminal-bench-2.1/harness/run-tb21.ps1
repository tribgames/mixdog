# terminal-bench 2.1 launcher with infra-error auto-retry baked in.
# Usage:
#   .\run-tb21.ps1 -JobsDir jobs-tb21                          # full suite
#   .\run-tb21.ps1 -JobsDir jobs-retry -Include qemu-startup,raman-fitting
param(
    [Parameter(Mandatory)][string]$JobsDir,
    [string[]]$Include = @(),
    [string[]]$Exclude = @(),
    [int]$Concurrent = 4,
    # Auto-retry count for trials that die before/around the agent run
    # (RuntimeError, NonZeroAgentExitCodeError, docker daemon death, ...).
    # Harbor's default exclude list keeps AgentTimeout/Verifier errors OUT of
    # retry, so real task failures are never retried — only infra errors.
    [int]$MaxRetries = 2
)
$ErrorActionPreference = "Stop"
# Windows: harbor/rich read+write UTF-8 content (agent logs, box-drawing
# glyphs); the cp949 default codec crashed a full run mid-flight. Force
# Python UTF-8 mode (files) + UTF-8 stdio for the whole child tree.
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
# Run from the terminal-bench-2.1 dir (parent of this harness/ dir) so that
# `harness.mixdog_agent` is importable regardless of where the repo lives.
$benchRoot = Split-Path $PSScriptRoot -Parent
Set-Location $benchRoot
$env:PYTHONPATH = $benchRoot

$harborArgs = @(
    "run",
    "-d", "terminal-bench/terminal-bench-2-1",
    "--agent-import-path", "harness.mixdog_agent:MixdogAgent",
    "-o", $JobsDir,
    "-n", $Concurrent,
    "-r", $MaxRetries,
    "--retry-exclude", "AgentTimeoutError",
    "--retry-exclude", "VerifierOutputParseError",
    # VerifierTimeoutError intentionally NOT excluded: a verifier (grader)
    # timeout is a load/infra artifact, not an agent failure — observed under
    # 8-way concurrency (torch-pipeline-parallelism: agent finished + verified,
    # grader exceeded its fixed 900s budget). Retrying is fair game.
    "--retry-exclude", "RewardFileEmptyError",
    # Verifier env-build resilience: grader uv installs of large wheel stacks
    # (CUDA torch ~2GB) hit the default 30s per-download timeout under 8-way
    # concurrency on this link (torch-pipeline-parallelism: agent PASSed, the
    # grader died downloading nvidia-cudnn). Longer waits only; grading
    # conditions themselves are unchanged.
    "--verifier-env", "UV_HTTP_TIMEOUT=300",
    "-q", "-y"
)
# Accept both array and comma-joined string; task names need the
# "terminal-bench/" prefix to match the dataset registry names.
function Expand-Tasks([string[]]$names) {
    $names | ForEach-Object { $_ -split "," } | Where-Object { $_ } | ForEach-Object {
        if ($_ -like "terminal-bench/*") { $_ } else { "terminal-bench/$_" }
    }
}
foreach ($t in (Expand-Tasks $Include)) { $harborArgs += @("-i", $t) }
foreach ($t in (Expand-Tasks $Exclude)) { $harborArgs += @("-x", $t) }

"harbor $($harborArgs -join ' ')"
harbor @harborArgs
