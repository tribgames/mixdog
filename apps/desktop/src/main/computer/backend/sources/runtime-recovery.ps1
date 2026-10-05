
function Get-WindowCapture($req) {
    $info = Resolve-WindowInfo $req.window $req.window_id
    $capture = if ($req.capture_backend -eq 'wgc') {
        Get-WindowGraphicsCapture $info.Handle
    }
    elseif (-not $req.capture_backend -or $req.capture_backend -eq 'print_window') {
        [MixWin32]::CaptureWindowSurface($info.Handle)
    }
    else { throw 'capture_source_unavailable|unknown window capture backend' }
    return @{
        text            = ('native window capture: ' + $info.Title)
        title           = $info.Title
        window_id       = $info.Id
        x               = $capture.X
        y               = $capture.Y
        width           = $capture.Width
        height          = $capture.Height
        capture_source  = 'window_surface'
        capture_cleanup = @{ status = 'confirmed' }
        image_base64    = $capture.PngBase64
    }
}

function Get-WindowIntegrity($req) {
    $info = Resolve-WindowInfo $req.window $req.window_id
    $integrity = [MixWin32]::WindowIntegrity($info.Handle)
    return @{
        text        = ('window integrity: ' + $integrity.TargetName)
        window_id   = $info.Id
        known       = $integrity.Known
        higher      = $integrity.Higher
        own_rid     = $integrity.OwnRid
        target_rid  = $integrity.TargetRid
        own_name    = $integrity.OwnName
        target_name = $integrity.TargetName
    }
}

function Get-InputRecoveryState($req) {
    $state = Get-CurrentSession
    $target = [IntPtr]::Zero
    if ($req.after_input -eq $true -and $req.window_id) {
        # Post-dispatch monitoring must survive an action closing its own dialog.
        # This read grants no input permission and never resolves another target.
        $target = [MixWin32]::ParseWindowId([string]$req.window_id)
    }
    elseif ($req.ref) {
        $target = Get-RefTopHandle (Get-RefRecord $req.ref)
    }
    elseif ($req.window_id -or $req.window) {
        $target = (Resolve-WindowInfo $req.window $req.window_id).Handle
    }
    elseif ([MixWin32]::IsWindowHandle($state.LastFocus)) {
        $target = $state.LastFocus
    }
    $targetExists = [MixWin32]::IsWindowHandle($target)
    if ($target -eq [IntPtr]::Zero -or (-not $targetExists -and $req.after_input -ne $true)) {
        throw 'foreground input target is unavailable before dispatch'
    }
    $targetOwnerId = ''
    if ($targetExists) {
        $targetInfo = [MixWin32]::Info($target)
        if ($null -ne $targetInfo) { $targetOwnerId = [string]$targetInfo.OwnerId }
    }
    $foreground = [MixWin32]::Foreground()
    # The host keeps the session's restore point; each read reports where focus is now.
    $restore = $foreground
    $cursor = [MixWin32]::Cursor()
    # Recorded now, while the window still exists: an action can close exactly the
    # window that held focus, and a destroyed handle can no longer name its owner.
    $restoreOwnerId = ''
    if ([MixWin32]::IsWindowHandle($restore)) {
        $restoreInfo = [MixWin32]::Info($restore)
        if ($null -ne $restoreInfo) { $restoreOwnerId = [string]$restoreInfo.OwnerId }
    }
    $inputEvidence = [MixInputObservation]::Read()
    return @{
        text                     = 'foreground input recovery state captured'
        input_observer_ready     = $inputEvidence.Ready
        input_monitor_id         = $inputEvidence.Generation
        input_user_sequence      = $inputEvidence.Sequence
        target_window_id         = [MixWin32]::WindowId($target)
        target_exists            = $targetExists
        target_owner_window_id   = $targetOwnerId
        foreground_window_id     = $(if ([MixWin32]::IsWindowHandle($foreground)) { [MixWin32]::WindowId($foreground) } else { '' })
        restore_window_id        = $(if ([MixWin32]::IsWindowHandle($restore)) { [MixWin32]::WindowId($restore) } else { '' })
        restore_owner_window_id  = $restoreOwnerId
        cursor_x                 = $cursor.x
        cursor_y                 = $cursor.y
        input_tick               = [MixWin32]::InputTick()
        synthetic_input          = (Get-PhysicalInputIdleMs) -eq [int]::MaxValue
        foreground_within_target = ($foreground -eq $target -or [MixWin32]::IsOwnedBy($foreground, $target))
        foreground_child_process = ($targetExists -and [MixWin32]::IsChildProcessWindow($foreground, $target))
    }
}

function Restore-InputRecoveryState($req) {
    Assert-RecoveryInputUnchanged $req
    [MixInputObservation]::BeginExpected([string]$req.expected_input_monitor_id, [long]$req.expected_input_user_sequence)
    try {
        $restoreFocus = $req.restore_focus -ne $false
        $restore = [MixWin32]::ParseWindowId([string]$req.restore_window_id)
        $restoredTarget = if ($restoreFocus) { 'original' } else { 'preserved' }
        if ($restoreFocus -and -not [MixWin32]::IsWindowHandle($restore)) {
            # The action can close the very window that held focus. Its owner is the
            # truthful next home for focus instead of wherever Windows happened to land.
            $owner = [MixWin32]::ParseWindowId([string]$req.restore_owner_window_id)
            if (-not [MixWin32]::IsWindowHandle($owner)) {
                throw 'input recovery restore window is stale or invalid'
            }
            $restore = $owner
            $restoredTarget = 'owner'
        }
        if ($restoreFocus -and $null -ne $req.held_window_ids) {
            # A release may only take focus from a window the session itself held.
            # Anything else in front belongs to another session or came forward on
            # its own; when every held window is gone, the foreground is only
            # where Windows fell back to.
            $foreground = [MixWin32]::Foreground()
            $held = $foreground -eq $restore
            $anyAlive = $false
            foreach ($id in @($req.held_window_ids)) {
                $handle = [MixWin32]::ParseWindowId([string]$id)
                if (-not [MixWin32]::IsWindowHandle($handle)) { continue }
                $anyAlive = $true
                if ($foreground -eq $handle -or [MixWin32]::IsOwnedBy($foreground, $handle)) { $held = $true }
            }
            if (-not $held -and $anyAlive) {
                throw 'foreground_changed: another window holds the foreground; the desktop was not restored'
            }
        }
        if ($restoreFocus -and -not (Test-VisibleFocusHome $restore)) {
            # The Start menu or search can hold focus when a session begins and be
            # hidden by the time it ends; focus sent there lands where nobody sees it.
            $restoreFocus = $false
            $restoredTarget = 'unavailable'
        }
        if ($restoreFocus -and [MixWin32]::Foreground() -ne $restore) {
            [void][MixWin32]::Focus($restore)
        }
        Assert-RecoveryInputUnchanged $req
        [void][MixWin32]::SetCursorPos([int]$req.cursor_x, [int]$req.cursor_y)
        [System.Threading.Thread]::Sleep(30)
        Assert-RecoveryInputUnchanged $req
        [void][MixWin32]::SetCursorPos([int]$req.cursor_x, [int]$req.cursor_y)
        $foreground = [MixWin32]::Foreground()
        $cursor = [MixWin32]::Cursor()
        $inputEvidence = [MixInputObservation]::Read()
        return @{
            input_observer_ready     = $inputEvidence.Ready
            input_monitor_id         = $inputEvidence.Generation
            input_user_sequence      = $inputEvidence.Sequence
            foreground_window_id     = $(if ([MixWin32]::IsWindowHandle($foreground)) { [MixWin32]::WindowId($foreground) } else { '' })
            restored_target          = $restoredTarget
            cursor_x                 = $cursor.x
            cursor_y                 = $cursor.y
            input_tick               = [MixWin32]::InputTick()
            synthetic_input          = (Get-PhysicalInputIdleMs) -eq [int]::MaxValue
            foreground_within_target = ($foreground -eq [MixWin32]::ParseWindowId([string]$req.window_id) -or
                [MixWin32]::IsOwnedBy($foreground, [MixWin32]::ParseWindowId([string]$req.window_id)))
        }
    }
    finally { [MixInputObservation]::End() }
}

# Focus goes home only to a window the user can still see.
function Test-VisibleFocusHome($handle) {
    $info = [MixWin32]::Info($handle)
    return ($null -ne $info -and $info.Visible -and -not $info.Cloaked -and -not $info.Minimized)
}

function Assert-RecoveryInputUnchanged($req) {
    $evidence = [MixInputObservation]::Read()
    if (-not $evidence.Ready -or -not $req.expected_input_monitor_id -or $null -eq $req.expected_input_user_sequence -or
        $evidence.Generation -ne $req.expected_input_monitor_id) {
        throw 'input_observation_unavailable: cannot establish the original input observation'
    }
    if ($evidence.Sequence -ne [long]$req.expected_input_user_sequence) {
        throw 'user_input_active: desktop input changed; recovery must not override the user'
    }
}

