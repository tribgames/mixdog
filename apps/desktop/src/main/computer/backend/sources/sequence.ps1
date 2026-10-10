
# Batch one step's native work, not the whole sequence. The host still receives
# every checkpoint and decides whether a following step may run.
function Invoke-SequenceStep($req) {
    $step = $req.step
    $actions = @('invoke', 'set_value', 'click', 'right_click', 'middle_click', 'double_click',
        'triple_click', 'mouse_down', 'mouse_up', 'mouse_move', 'drag', 'scroll',
        'type', 'key', 'wait')
    # A held key is foreground-only. Say so instead of reporting bad grammar, so
    # the caller learns the supported route rather than re-sending the same step.
    if ($null -ne $step -and @('key_down', 'key_up') -contains [string]$step.action) {
        throw 'background_unsupported|a held key requires the real keyboard; use explicit foreground delivery'
    }
    if ($null -eq $step -or $actions -notcontains [string]$step.action -or
        $step.delivery -ne 'background' -or $req.delivery -ne 'background' -or
        -not $step.window_id -or $step.window -or
        [string]$step.session_id -ne [string]$req.session_id -or $step.read_only) {
        throw 'sequence_step_invalid: expected one exact-window background input'
    }
    if ($step.action -eq 'wait' -and
        ($null -eq $step.duration -or [double]$step.duration -lt 0 -or
        [double]$step.duration -gt 5 -or [double]::IsNaN([double]$step.duration))) {
        throw 'sequence_step_invalid: wait requires 0..5 seconds'
    }
    Assert-ExecutionAuthorization $step
    # One no-activate hold per target root spans the sequence's steps and the
    # settles between them; a step's own deliveries then only hold, and the
    # settle and foreground recovery run once, when the hold ends. A step marked
    # input_continues leaves the hold for the next step; any other step, a
    # failed one, or the session's held-input cleanup ends it.
    $state = Get-CurrentSession
    if ($null -eq $state.SequenceInactive) { $state.SequenceInactive = @{} }
    $handle = [MixWin32]::ParseWindowId([string]$step.window_id)
    $holdId = [string][MixWin32]::WindowId($handle)
    $continues = $step.input_continues -eq $true
    $holdFailure = $null
    foreach ($id in @($state.SequenceInactive.Keys)) {
        if ($id -eq $holdId) { continue }
        # A hold another sequence left behind ends before this one acts.
        $stale = $state.SequenceInactive[$id]
        $state.SequenceInactive.Remove($id)
        try { [MixWin32]::EndInactive($stale) } catch { if ($null -eq $holdFailure) { $holdFailure = $_ } }
    }
    if ($null -ne $holdFailure) { throw $holdFailure }
    if (-not $state.SequenceInactive.ContainsKey($holdId)) {
        $state.SequenceInactive[$holdId] = [MixWin32]::BeginInactive($handle)
    }
    $endHold = {
        $held = $state.SequenceInactive[$holdId]
        $state.SequenceInactive.Remove($holdId)
        [MixWin32]::EndInactive($held)
    }
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $holdEnded = $false
    $result = $null
    try {
        $before = Do-WindowSnapshot
        $beforeMs = $clock.Elapsed.TotalMilliseconds
        # Handle rechecks the original request's authorization and all input guards.
        # Never retry a dispatched step, including when the following observation fails.
        $result = Handle $step
        $deliveredAt = $clock.Elapsed.TotalMilliseconds
        $deliveryMs = $deliveredAt - $beforeMs
        $settleMs = @@MIXDOG_SEQUENCE_SETTLE_MS@@
        $creditMs = 0
        # A wait sends no input. Its elapsed time already satisfies this part of the
        # settle budget. Actual input always retains the full post-delivery interval.
        if ($step.action -eq 'wait') {
            $creditMs = [Math]::Min($settleMs, [Math]::Floor($deliveryMs))
        }
        $remainingMs = [int]($settleMs - $creditMs)
        if ($remainingMs -gt 0) { [System.Threading.Thread]::Sleep($remainingMs) }
        # The last step recovers the foreground before the windows are read back.
        if (-not $continues -or $result.delivery_accepted -eq $false) {
            $holdEnded = $true
            & $endHold
        }
    }
    finally {
        if (-not $holdEnded -and (-not $continues -or $null -eq $result)) { & $endHold }
    }
    $settledAt = $clock.Elapsed.TotalMilliseconds
    $after = Do-WindowSnapshot
    $finishedAt = $clock.Elapsed.TotalMilliseconds
    return @{
        step_result     = $result
        windows_before  = @($before.windows)
        windows_after   = @($after.windows)
        settle_delay_ms = $remainingMs
        timings_ms      = @{
            before_windows_ms = $beforeMs
            delivery_ms       = $deliveryMs
            settle_ms         = ($settledAt - $deliveredAt)
            settle_credit_ms  = $creditMs
            after_windows_ms  = ($finishedAt - $settledAt)
            backend_ms        = $finishedAt
        }
    }
}
