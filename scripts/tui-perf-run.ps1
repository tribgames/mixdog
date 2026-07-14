# TUI typing-lag perf measurement launcher.
#
# Enables the render/event-loop probes with tuned thresholds, routes probe
# output to a DEDICATED fresh log, then launches mixdog exactly like `mixdog`.
# Reproduce the lag (long transcript + streaming, type continuously), then
# /exit. The log is then read to pin the bottleneck.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$log  = Join-Path $repo 'tui-perf.log'

# Probe gates. Thresholds lowered below the defaults (80ms stall / 120ms gap)
# because the synthetic measurement put real stalls at ~40-60ms, under the
# defaults, so they would never be logged.
$env:MIXDOG_TUI_PERF               = '1'
$env:MIXDOG_TUI_PERF_STALL_MS      = '40'
$env:MIXDOG_TUI_PERF_RENDER_GAP_MS = '50'
$env:MIXDOG_TUI_LOOP_PROBE         = '1'
$env:MIXDOG_TUI_STDERR_LOG         = $log

# Start from a clean log so the read is unambiguous.
if (Test-Path $log) { Remove-Item $log -Force }

Write-Host "perf log -> $log" -ForegroundColor Cyan
Write-Host 'Reproduce: long transcript + streaming, type continuously to trigger lag, then /exit.' -ForegroundColor Cyan

node (Join-Path $repo 'src\cli.mjs') @args
