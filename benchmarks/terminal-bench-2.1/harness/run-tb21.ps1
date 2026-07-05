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
    "--retry-exclude", "VerifierTimeoutError",
    "--retry-exclude", "RewardFileEmptyError",
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
