# The user and the agent share one physical mouse and keyboard. Physical input
# within this window means the user is working, so foreground actions hold
# until the user pauses instead of fighting them for the cursor.
$UserInputIdleMs = 3000
$UserInputWaitMaxMs = 30000

function Get-PhysicalInputIdleMs {
    $req = $script:CurrentRequest
    $known = 0
    $hasKnown = $false
    if ($null -ne $req -and $null -ne $req.known_injection_tick) {
        $known = [int]$req.known_injection_tick
        $hasKnown = $true
    }
    return [MixWin32]::PhysicalInputIdleMs($known, $hasKnown)
}

# Returns the milliseconds spent waiting, or -1 when the user was still active
# at the deadline. An input origin that cannot be observed refuses at once:
# waiting would hold the foreground lane only to report the wrong reason.
function Wait-UserInputIdle {
    $started = [Environment]::TickCount
    $waited = $false
    while ($true) {
        $idle = Get-PhysicalInputIdleMs
        if ($idle -lt 0) { throw 'input_observation_unavailable: input origin cannot be observed' }
        if ($idle -ge $UserInputIdleMs) {
            if ($waited) { return [int]([Environment]::TickCount - $started) }
            return 0
        }
        if (([Environment]::TickCount - $started) -ge $UserInputWaitMaxMs) { return -1 }
        $waited = $true
        [System.Threading.Thread]::Sleep([math]::Max(100, [math]::Min(500, $UserInputIdleMs - $idle)))
    }
}

function New-UserInputActiveResult($action, $windowId) {
    $seconds = [math]::Round($UserInputWaitMaxMs / 1000)
    $message = 'the user is actively using the mouse or keyboard; ' + $action + ' waited ' + $seconds + 's and sent no input. Capture fresh state and retry once the user pauses'
    return New-ActionResult $action 'foreground' 'suspected_noop' $false $message 'user_input_active' 'foreground' $windowId
}

# Acquiring a theme launches the watchdog that releases whatever this session
# pressed, which is far too much work to repeat per keystroke. A sequence holds
# one lease for all of its steps; the host releases it when the sequence ends,
# however it ended. Pointer actions blank the system cursor so the overlay
# pointer is the only arrow; key/type leave the user's cursor artwork alone.
# Whether the focused field hides what is typed into it. A focus that cannot be
# read is reported as masked: the board must never light a key it cannot vouch
# for, and an unreadable field is exactly the case where that matters.
function Test-FocusMasked {
    try {
        $el = [System.Windows.Automation.AutomationElement]::FocusedElement
        if ($null -eq $el) { return $true }
        if ([bool]$el.Current.IsPassword) { return $true }
        # UIA answers for its own providers only. A legacy edit control reports
        # nothing there and raises MSAA's PROTECTED state instead, so ask that
        # too before letting a keystroke onto the board.
        $handle = [int]$el.Current.NativeWindowHandle
        if ($handle -eq 0) { return $false }
        return [MixMsaa]::IsProtectedInput([IntPtr]$handle)
    }
    catch { return $true }
}

$script:CursorThemeDecorated = $false

# Pointer actions hide the real arrow so the overlay arrow is the only pointer;
# key/type never touch the user's cursor artwork. A held lease keeps the
# decoration it was acquired with. The watchdog owns restoration.
# The watchdog ends a lease on its own (user input or its timeout); a held one
# that already ended is dropped so the next action takes a fresh lease.
function Clear-ExpiredCursorTheme($state) {
    if ($null -eq $state.CursorTheme -or $state.CursorTheme.Expired -ne $true) { return }
    $expired = $state.CursorTheme
    $state.CursorTheme = $null
    try { $expired.Dispose() } catch { }
}

function Acquire-CursorTheme($state, $reservation, [bool]$decorate = $false) {
    Clear-ExpiredCursorTheme $state
    if ($null -ne $state.CursorTheme) {
        if ($null -ne $reservation) { $reservation.Dispose() }
        return $state.CursorTheme
    }
    $script:CursorThemeDecorated = $decorate
    if ($null -ne $reservation) { return [MixCursorTheme]::Complete($reservation, $decorate) }
    return [MixCursorTheme]::Begin($decorate)
}

# True when a held lease was restored here, so the caller can report it.
function Release-CursorTheme($state) {
    $theme = $state.CursorTheme
    $state.CursorTheme = $null
    if ($null -eq $theme) { return $false }
    $theme.Dispose()
    return $true
}

# Every foreground action passes this before anything moves. An elevated window
# holding the foreground cannot be displaced by a lower process, so it refuses
# first: activation would fail, and waiting on input that window hides from the
# observer could only end in the wrong reason. Then the user gets the idle
# window, and input during the wait refuses too. Returns the refusal, or $null.
function Get-ForegroundRefusal($action, $targetHandle, $request) {
    $windowId = [MixWin32]::WindowId($targetHandle)
    $holderHandle = [MixWin32]::Foreground()
    if ($holderHandle -ne $targetHandle -and [MixWin32]::IsWindowHandle($holderHandle)) {
        $holder = [MixWin32]::WindowIntegrity($holderHandle)
        if ($holder.Known -and $holder.Higher) {
            $holderInfo = [MixWin32]::Info($holderHandle)
            return New-ActionResult $action 'foreground' 'suspected_noop' $false "the foreground belongs to '$($holderInfo.Title)', which runs at $($holder.TargetName) integrity above this host ($($holder.OwnName)); Windows lets a lower process neither take the foreground from it nor type into it, so no input was sent. Ask the user to switch away from that window." 'foreground_unavailable' 'foreground' $windowId
        }
    }
    $userWaitMs = Wait-UserInputIdle
    if ($userWaitMs -lt 0) { return New-UserInputActiveResult $action $windowId }
    Assert-ExecutionAuthorization $request $targetHandle
    if ($userWaitMs -gt 0) {
        return New-ActionResult $action 'foreground' 'suspected_noop' $false 'user input occurred after observation; capture fresh state before acting' 'user_input_active' 'foreground' $windowId
    }
    return $null
}

function Invoke-ForegroundInput($targetHandle, $action, $body, [bool]$pointerMayActivate = $false) {
    if (-not [MixWin32]::IsWindowHandle($targetHandle)) {
        return New-ActionResult $action 'foreground' 'suspected_noop' $false "$action target window is invalid" 'target_required' 'foreground' $null
    }
    $refusal = Get-ForegroundRefusal $action $targetHandle $script:CurrentRequest
    if ($null -ne $refusal) { return $refusal }
    $state = Get-CurrentSession
    $previous = [MixWin32]::Foreground()
    [MixInputObservation]::Begin()
    $priorAuthorization = [MixInputObservation]::DispatchAuthorization
    $dispatchReady = $false
    # A pointer action may activate a target that refused focus (see
    # [MixWin32]::BeginPointerActivation); any third window still stops it.
    $pointerActivation = $false
    [MixInputObservation]::DispatchAuthorization = [Action] {
        Assert-ExecutionAuthorization $script:CurrentRequest $targetHandle
        if (-not $dispatchReady) { return }
        $foregroundNow = [MixWin32]::Foreground()
        if ($foregroundNow -ne $targetHandle -and -not ($pointerActivation -and [MixWin32]::HoldsForActivation($foregroundNow))) {
            throw 'foreground_changed: target lost foreground before input dispatch'
        }
    }
    $cursorTheme = $null
    $themeHeld = $false
    $bodyCompleted = $false
    # The watchdog takes about a second to start and connect, and that wait needs
    # nothing from the target. Start it now so it runs alongside activation and
    # the focus settle instead of after them; a refused action drops it unused.
    Clear-ExpiredCursorTheme $state
    $cursorReservation = if ($null -eq $state.CursorTheme) { [MixCursorTheme]::Reserve() } else { $null }
    $inputContinues = $script:CurrentRequest.input_continues -eq $true
    # The host holds the blanked cursor between a session's commands and ends
    # the hold itself; the watchdog still restores on user input or worker exit.
    $holdPointer = $script:CurrentRequest.hold_pointer -eq $true
    $cursorFeedback = @{ system_theme_applied = $false; system_theme_restored = $false; pointer_moved = $false }
    # A first foreground action costs seconds while a follow-up costs hundreds of
    # milliseconds, and the total alone never says which stage owns that gap.
    $phaseClock = [System.Diagnostics.Stopwatch]::StartNew()
    $phaseMs = [ordered]@{}
    $markPhase = {
        param($name)
        $phaseMs[$name] = [Math]::Round($phaseClock.Elapsed.TotalMilliseconds, 2)
        $phaseClock.Restart()
    }
    try {
        [MixInputObservation]::AssertContinue()
        $focused = [MixWin32]::Focus($targetHandle)
        if (-not $focused -and -not $pointerMayActivate) {
            return New-ActionResult $action 'foreground' 'suspected_noop' $false "Windows foreground lock prevented target activation; no input was sent" 'foreground_unavailable' 'foreground' ([MixWin32]::WindowId($targetHandle))
        }
        if ($focused -and $previous -ne $targetHandle) {
            # SetForegroundWindow can report success before the target message loop is
            # ready for input. Keep a bounded focus-settle interval before dispatch.
            [System.Threading.Thread]::Sleep(120)
        }
        if ($focused -and [MixWin32]::Foreground() -ne $targetHandle) {
            return New-ActionResult $action 'foreground' 'suspected_noop' $false "foreground changed before input dispatch; no input was sent" 'foreground_changed' 'foreground' ([MixWin32]::WindowId($targetHandle))
        }
        if (-not $focused) {
            $pointerActivation = $true
            [MixWin32]::BeginPointerActivation([MixWin32]::Foreground())
        }
        $dispatchReady = $true
        & $markPhase 'activation_ms'
        [MixInputObservation]::AssertContinue()
        Assert-ExecutionAuthorization $script:CurrentRequest $targetHandle
        # A sequence that continues may mix pointer and key steps, so it keeps one decorated lease.
        $decorate = $action -notin @('key', 'type', 'key_down', 'key_up') -or $inputContinues
        $cursorTheme = Acquire-CursorTheme $state $cursorReservation $decorate
        $themeHeld = [object]::ReferenceEquals($cursorTheme, $state.CursorTheme)
        $cursorReservation = $null
        $cursorFeedback.system_theme_applied = [bool]$script:CursorThemeDecorated
        & $markPhase 'cursor_theme_ms'
        # Read it while the target still holds focus, before any key lands.
        if ($action -in @('key', 'type', 'key_down', 'key_up')) {
            $cursorFeedback.focus_masked = Test-FocusMasked
        }
        $pointerBefore = [MixWin32]::Cursor()
        [MixInputObservation]::AssertContinue()
        & $body
        $bodyCompleted = $true
        & $markPhase 'dispatch_ms'
        $pointerAfter = [MixWin32]::Cursor()
        $cursorFeedback.pointer_moved = $pointerBefore.x -ne $pointerAfter.x -or $pointerBefore.y -ne $pointerAfter.y
        # SendKeys-based bodies bypass MixWin32, so stamp the injection here too.
        [MixWin32]::NoteInjection()
        # SendInput only enqueues events. Custom renderers such as Chromium consume
        # them asynchronously, so keep the target stable through a bounded settle.
        # A step with more input behind it keeps the same target and the same queue
        # order, so only the step that ends the sequence owes that wait.
        if (-not $inputContinues) { [System.Threading.Thread]::Sleep(240) }
        & $markPhase 'settle_ms'
        $current = [MixWin32]::Foreground()
        if ($current -ne $previous -and [MixWin32]::IsWindowHandle($current)) {
            $state.LastFocus = $current
        }
        elseif ($current -eq $targetHandle) {
            $state.LastFocus = $targetHandle
        }
        $path = if ($focused) { 'foreground_sendinput' } else { 'foreground_pointer_activation' }
        $result = New-ActionResult $action $path 'unverifiable' $false "$action input dispatched; inspect the fresh capture before treating it as complete" $null 'foreground' ([MixWin32]::WindowId($targetHandle))
        $result.injection_tick = [MixWin32]::LastInjectionTick
        $result.cursor_feedback = $cursorFeedback
        $result.foreground_phase_ms = $phaseMs
        return $result
    }
    finally {
        # A reservation the action never reached belongs to nobody: close it so
        # the helper exits instead of waiting out its own timeout.
        if ($null -ne $cursorReservation) {
            try { $cursorReservation.Dispose() } catch { }
            $cursorReservation = $null
        }
        # Visible input leaves the one physical pointer at its destination.
        # Never jump it back between actions or after user intervention.
        try {
            if ($null -ne $cursorTheme) {
                # Input that ran, or a hold an earlier action began, keeps the cursor
                # blanked; a refusal before any input hands it straight back.
                $keepTheme = ($inputContinues -or ($holdPointer -and $script:CursorThemeDecorated)) -and ($bodyCompleted -or $themeHeld)
                if ($keepTheme) { $state.CursorTheme = $cursorTheme }
                else {
                    $state.CursorTheme = $null
                    $cursorTheme.Dispose()
                    if ($script:CursorThemeDecorated) { $cursorFeedback.system_theme_restored = $true }
                }
            }
        }
        finally {
            if ($pointerActivation) { [MixWin32]::EndPointerActivation() }
            [MixInputObservation]::DispatchAuthorization = $priorAuthorization
            [MixInputObservation]::End()
        }
    }
}

