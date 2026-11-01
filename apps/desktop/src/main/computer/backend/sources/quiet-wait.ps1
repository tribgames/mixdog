
# Opt-in wait that ends once the window layer stops changing. Like cua's launch
# poll (a cheap signal every 200 ms, stable after 3 idle ticks) it samples Win32
# window metadata only: the window set in z-order, the foreground window, and
# each window's title, state and bounds. It never reads the accessibility tree
# or renders a surface, so a sample costs a few milliseconds. Content changes
# inside a window (canvas, text) are out of scope; verify covers those.
$script:QuietSampleIntervalMs = 200
# Consecutive unchanged comparisons that end the wait: 3 equal samples.
$script:QuietEqualRun = 2

function Get-QuietSample {
    $rows = foreach ($w in (Do-WindowSnapshot).windows) {
        '{0}|{1}|{2}|{3}|{4}|{5},{6},{7},{8}' -f $w.id, $w.title, $w.focused, $w.minimized, $w.maximized, $w.x, $w.y, $w.width, $w.height
    }
    return ($rows -join "`n")
}

# The requested time is a cap. A next sample only starts when a full interval
# plus a sample's cost still fits before it, so every compared pair is a full
# interval apart and no sample starts past the cap. A sample cannot be
# interrupted, so the wait overruns only if a sample runs longer than the
# previous one (measured Do-WindowSnapshot: 2-22 ms).
function Wait-UntilQuiet([double]$seconds, [scriptblock]$sample) {
    $capMs = [int]($seconds * 1000)
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $previous = $null
    $equalRun = 0
    $costMs = 0
    while ($true) {
        $startedMs = $clock.Elapsed.TotalMilliseconds
        $current = & $sample
        $costMs = $clock.Elapsed.TotalMilliseconds - $startedMs
        if ($null -ne $previous -and $current -eq $previous) {
            $equalRun++
            if ($equalRun -ge $script:QuietEqualRun) {
                return @{ quiet = $true; waited_ms = [int]$clock.Elapsed.TotalMilliseconds }
            }
        }
        else { $equalRun = 0 }
        $previous = $current
        $leftMs = $capMs - $clock.Elapsed.TotalMilliseconds
        # A shortened interval is no evidence of stability: when a full interval
        # and the next sample no longer fit, sleep out the cap and report not quiet.
        if ($leftMs -le $script:QuietSampleIntervalMs + $costMs) { break }
        [System.Threading.Thread]::Sleep($script:QuietSampleIntervalMs)
    }
    $leftMs = $capMs - $clock.Elapsed.TotalMilliseconds
    if ($leftMs -gt 0) { [System.Threading.Thread]::Sleep([int]$leftMs) }
    return @{ quiet = $false; waited_ms = [int]$clock.Elapsed.TotalMilliseconds; reason = 'still_changing' }
}