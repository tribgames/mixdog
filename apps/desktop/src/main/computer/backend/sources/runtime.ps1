# Lets go of every button and key the session still holds; the end of a turn
# does this while the session stays warm for a follow-up. Both releases run
# even when the first one fails: the second holds input the user would
# otherwise keep receiving.
function Release-HeldInput($state) {
    $releaseFailure = $null
    try { Release-HeldPointerButtons $state } catch { $releaseFailure = $_ }
    try { Release-HeldKeys $state } catch { if ($null -eq $releaseFailure) { $releaseFailure = $_ } }
    if ($null -ne $releaseFailure) { throw $releaseFailure }
    return @{ text = 'held input released' }
}

function Release-SessionState {
    $state = Get-CurrentSession
    # The host puts focus and pointer back from the session's restore point; a
    # release only lets go of what the session still holds.
    $releaseFailure = $null
    try { $null = Release-HeldInput $state } catch { $releaseFailure = $_ }
    try { $null = Release-CursorTheme $state } catch { if ($null -eq $releaseFailure) { $releaseFailure = $_ } }
    $state.Map.Clear()
    $state.Generation = [int]$state.Generation + 1
    $state.LastFocus = [IntPtr]::Zero
    if ($null -ne $releaseFailure) { throw $releaseFailure }
    return @{ text = 'computer session released' }
}

# A sequence holds its cursor theme across steps, so the host ends that hold
# explicitly rather than leaving the swapped cursors to the watchdog's timeout.
function Do-ReleaseCursorTheme {
    $restored = Release-CursorTheme (Get-CurrentSession)
    return @{ text = 'cursor theme released'; system_theme_restored = [bool]$restored }
}

# A sequence step followed by a ref step of the same sequence keeps the refs;
# Get-RefRecord re-proves each one's identity before that later step uses it.
function Invalidate-RefsForRequest($req) {
    $readActions = @@MIXDOG_RETAIN_REFS_ACTIONS@@
    if ($null -ne $req -and $req.retain_refs -ne $true -and -not ($readActions -contains [string]$req.action)) {
        $state = Get-CurrentSession
        $state.Map.Clear()
        $state.Generation = [int]$state.Generation + 1
    }
}

# A target that refused the no-activate style still got the input, but the
# result must not present that delivery as protected from raising it. A
# sequence step carries its input's result inside the step envelope.
function Add-ActivationProtection($req, $res) {
    if (-not [MixWin32]::ActivationUnprotected) { return }
    $annotated = $res
    if ($req.action -eq 'sequence_step' -and $res -is [System.Collections.IDictionary]) { $annotated = $res.step_result }
    if ($annotated -is [System.Collections.IDictionary] -and
        $annotated.delivery_accepted -eq $true -and $annotated.delivery -eq 'background') {
        $annotated.activation_protection = 'unavailable'
        $annotated.text = "$($annotated.text); the target refused the no-activate hold, so background delivery could not keep it from coming forward"
    }
}

function Handle($req) {
    $script:CurrentSession = Get-SessionState $req.session_id
    $script:CurrentRequest = $req
    Assert-ExecutionAuthorization $req
    $readActions = @@MIXDOG_NATIVE_READ_ACTIONS@@
    if ($req.read_only -and -not ($readActions -contains [string]$req.action)) {
        throw "read_only run: '$($req.action)' is a mutation"
    }
    $inputScope = $req.delivery -eq 'foreground' -and -not ($readActions -contains [string]$req.action)
    if ($inputScope) {
        if ($req.observed_input_monitor_id -and $null -ne $req.observed_input_user_sequence) {
            [MixInputObservation]::BeginExpected([string]$req.observed_input_monitor_id, [long]$req.observed_input_user_sequence)
        }
        else {
            [MixInputObservation]::Begin()
        }
    }
    try {
        switch ($req.action) {
            'sequence_step' { return Invoke-SequenceStep $req }
            'list_windows' { return Do-ListWindows }
            'window_snapshot' { return Do-WindowSnapshot }
            'related_windows' { return Do-RelatedWindows $req }
            'snapshot' { return Snapshot-Window $req }
            'find' { return Snapshot-Window $req }
            'invoke' {
                if ($req.delivery -eq 'foreground') { return Do-ClickFamily $req 'click' }
                return Invoke-BackgroundSemantic $req.ref { Do-Invoke $req.ref }
            }
            'set_value' { return Invoke-BackgroundSemantic $req.ref { Do-SetValue $req.ref $req.text } 'type' }
            'toggle' { return Invoke-BackgroundSemantic $req.ref { Do-Toggle $req.ref } }
            'click' { return Do-ClickFamily $req 'click' }
            'double_click' { return Do-ClickFamily $req 'double' }
            'right_click' { return Do-ClickFamily $req 'right' }
            'middle_click' { return Do-ClickFamily $req 'middle' }
            'triple_click' { return Do-ClickFamily $req 'triple' }
            'mouse_move' { return Do-MouseMove $req }
            'mouse_down' { return Do-ClickFamily $req 'press' }
            'mouse_up' { return Do-ClickFamily $req 'release' }
            'wait' { return Do-Wait $req }
            'drag' { return Do-Drag $req }
            'scroll' { return Do-Scroll $req }
            'focus_window' { return Do-Focus $req }
            'window_bounds' { return Get-WindowBounds $req }
            'window_capture' { return Get-WindowCapture $req }
            'validate_background_input' {
                $info = Resolve-WindowInfo $req.window $req.window_id
                try {
                    foreach ($step in @($req.steps)) {
                        $target = $info.Handle
                        $preferred = [IntPtr]::Zero
                        if ($step.ref) {
                            $record = Get-RefRecord $step.ref
                            # A type step still lands through the element's own value pattern.
                            if ([string]$step.action -eq 'type' -and (Test-BackgroundValueTarget $record)) { continue }
                            if ($record.Kind -ne 'uia') {
                                throw 'background_unsupported|semantic ref exposes no exact native keyboard target; no input sent'
                            }
                            $target = Get-RefTopHandle $record
                            $preferred = Get-ExactNativeElementHandle $record.Element
                            if ($preferred -eq [IntPtr]::Zero) {
                                throw 'background_unsupported|element exposes no exact native keyboard target; no input sent'
                            }
                        }
                        [MixWin32]::ValidateBackgroundInput($target, $preferred, [string]$step.action, [string]$step.keys)
                    }
                }
                catch { throw $_.Exception.GetBaseException().Message }
                return @{ text = 'background input preflight passed'; input_not_dispatched = $true }
            }
            'window_predicates' { return Get-WindowPredicates $req }
            'accessibility_probe' { return Probe-WindowAccessibility $req }
            'invoke_menu' { return Do-InvokeMenu $req }
            'window_integrity' { return Get-WindowIntegrity $req }
            'input_recovery_state' { return Get-InputRecoveryState $req }
            'input_idle_state' {
                $state = [MixInputObservation]::Read()
                return @{
                    ready          = ($state.Ready -and [MixInputObservation]::IdleDesktopReady())
                    observer_ready = $state.Ready
                    monitor        = $state.Generation
                    sequence       = $state.Sequence
                    idleMs         = [Math]::Max(0, ([long][Environment]::TickCount - [long]$state.Tick + 4294967296) % 4294967296)
                    held           = [MixInputObservation]::AnyInputHeld()
                }
            }
            'restore_input_state' { return Restore-InputRecoveryState $req }
            'move_window' { return Do-MoveWindow $req }
            'key' { return Do-Key $req }
            'key_down' { return Do-KeyHold $req 'down' }
            'key_up' { return Do-KeyHold $req 'up' }
            'type' { return Do-Type $req }
            'window_state' { return Do-WindowState $req }
            'close_window' { return Do-CloseWindow $req }
            'terminate_process' { return Do-TerminateProcess $req }
            'ocr_image' { return Do-OcrImage $req }
            'ocr_status' { return Do-OcrStatus $req }
            'clipboard_read' { return Do-ClipboardRead }
            'clipboard_write' { return Do-ClipboardWrite $req.text }
            'launch' { return Do-Launch $req.app }
            'list_installed_apps' { return Do-ListInstalledApps $req }
            'release_session' { return Release-SessionState }
            'release_held_input' { return Release-HeldInput (Get-CurrentSession) }
            'release_sequence_holds' { return Release-SequenceHolds (Get-CurrentSession) }
            'release_cursor_theme' { return Do-ReleaseCursorTheme }
            default { throw "unknown action: $($req.action)" }
        }
    }
    finally {
        if ($inputScope) { [MixInputObservation]::End() }
    }
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[MixNativeInput]::InitializeOwnership([MixInputObservation]::Marker)
# Read stdin as UTF-8 explicitly: [Console]::In follows the console code page
# (CP949 etc.), which corrupts multibyte command payloads (e.g. Korean window
# titles) and breaks JSON parsing. A StreamReader over the raw handle is code-
# page independent.
$__stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
while ($true) {
    $line = $__stdin.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }
    $id = 0
    $retireAfterReply = $false
    try {
        $req = $line | ConvertFrom-Json
        $id = [int]$req.id
        [MixWin32]::PointerEventsGenerated = 0
        [MixWin32]::PointerEventsFailed = 0
        if ($req.pointer_feedback -eq $true) {
            [MixWin32]::PointerProgress = [Action[int, int, bool, string]] {
                param($x, $y, $held, $phase)
                $progress = @{ id = $id; x = $x; y = $y; held = $held; phase = $phase } | ConvertTo-Json -Compress
                [Console]::Out.WriteLine('@@MIXDOG_POINTER@@' + $progress)
            }
        }
        [MixWin32]::ActivationUnprotected = $false
        try { $res = Handle $req } finally {
            [MixWin32]::PointerProgress = $null
            Invalidate-RefsForRequest $req
        }
        Add-ActivationProtection $req $res
        $envelope = @{ id = $id; ok = $true; result = $res }
        if ($req.pointer_feedback -eq $true) {
            $envelope.pointer_feedback = @{
                generated = [MixWin32]::PointerEventsGenerated
                failed    = [MixWin32]::PointerEventsFailed
            }
        }
        $out = $envelope | ConvertTo-Json -Compress -Depth 6
    }
    catch {
        $failure = $_.Exception
        while ($null -ne $failure.InnerException -and $failure.Message -notmatch '^[a-z][a-z0-9_]+:') {
            $failure = $failure.InnerException
        }
        $envelope = @{ id = $id; ok = $false; error = "$($failure.Message)" }
        # A failed or interrupted input may already have moved the presented cursor;
        # its accounting must survive the failure so the host never mistakes an
        # aborted glide for a request that produced no cursor events.
        if ($null -ne $req -and $req.pointer_feedback -eq $true) {
            $envelope.pointer_feedback = @{
                generated = [MixWin32]::PointerEventsGenerated
                failed    = [MixWin32]::PointerEventsFailed
            }
        }
        if ($req.action -eq 'window_capture' -and $failure.Data.Contains('CaptureCleanup')) {
            $cleanup = $failure.Data['CaptureCleanup']
            $envelope.result = @{ capture_cleanup = $cleanup }
            # Never reuse a worker whose asynchronous work or resource release is unconfirmed.
            $retireAfterReply = $cleanup.status -ne 'confirmed'
        }
        $out = $envelope | ConvertTo-Json -Compress -Depth 6
    }
    [Console]::Out.WriteLine('@@MIXDOG_RESPONSE_MARKER@@' + $out)
    if ($retireAfterReply) { break }
}
