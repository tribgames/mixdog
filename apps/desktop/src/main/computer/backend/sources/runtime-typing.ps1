# The tagged engine sends the key grammar without changing lock-key state.
function Send-KeysGuarded($keys) {
    [MixTaggedKeys]::Send([string]$keys)
}

# The typing indicator belongs where the text lands. A focused point was just
# clicked, so the pointer is already there; a semantic ref names its control
# without moving anything. With neither, the pointer still sits wherever the
# user left it, and animating that spot would announce input it never receives.
function Report-TypingPoint($req, $point) {
    if ($null -ne $point) {
        [MixWin32]::ReportCurrentPointer('type')
        return
    }
    if (-not $req.ref) { return }
    # A ref this action cannot resolve fails on its own path; the indicator must
    # never be the reason input is refused.
    try { $resolved = Get-ElPoint $req.ref $false } catch { return }
    [MixWin32]::ReportInputPoint($resolved[0], $resolved[1], 'type')
}

function Focus-TypingPoint($req, $target, $point) {
    if ($null -eq $point) { return }
    if ($req.ref) { $point = Get-ElPoint $req.ref $false }
    if ($point[2] -ne $target) { throw 'target_mismatch|text target changed after focus; no input sent' }
    [MixWin32]::GlideCursor($target, $point[0], $point[1])
    [MixWin32]::Click($point[0], $point[1])
    Start-Sleep -Milliseconds 80
}

function Get-NativeElementHandle($el) {
    $cur = $el
    for ($i = 0; $i -lt 50 -and $null -ne $cur; $i++) {
        $handle = New-Object IntPtr($cur.Current.NativeWindowHandle)
        if ($handle -ne [IntPtr]::Zero) { return $handle }
        $cur = $Walker.GetParent($cur)
    }
    return [IntPtr]::Zero
}

function Get-ExactNativeElementHandle($el) {
    if ($null -eq $el) { return [IntPtr]::Zero }
    return New-Object IntPtr($el.Current.NativeWindowHandle)
}

# Keystrokes land on the FOREGROUND window. Re-assert the last focus_window
# target before sending; when the user moved to another window and it cannot
# be reclaimed, fail instead of typing into their window.
function Assert-TypingTarget {
    $lastFocus = (Get-CurrentSession).LastFocus
    if ($lastFocus -eq [IntPtr]::Zero) {
        throw 'key requires focus_window first'
    }
    if ([MixWin32]::Foreground() -eq $lastFocus) { return }
    throw 'foreground changed (the user is working in another window); keys not sent. Call focus_window again.'
}

# Plain text (no SendKeys grammar characters) rides IME-immune unicode
# SendInput: under an active Korean IME, SendKeys' per-key synthesis gets
# translated into jamo ("parity" becomes hangul noise), while
# KEYEVENTF_UNICODE lands the literal characters verbatim.
function Do-Key($req) {
    if ($req.delivery -ne 'foreground') {
        $target = [IntPtr]::Zero
        $preferred = [IntPtr]::Zero
        $refRecord = $null
        if ($req.ref) {
            $refRecord = Get-RefRecord $req.ref
            $target = Get-RefTopHandle $refRecord
            if ($refRecord.Kind -eq 'msaa') {
                return Background-Unavailable 'key' 'MSAA ref does not expose an exact native keyboard target; use explicit foreground delivery' $refRecord.WindowId 'background_unsupported'
            }
            $preferred = Get-ExactNativeElementHandle $refRecord.Element
            if ($preferred -eq [IntPtr]::Zero) {
                return Background-Unavailable 'key' 'element has no exact native keyboard target; use explicit foreground delivery' $refRecord.WindowId 'background_unsupported'
            }
        }
        elseif ($req.window_id -or $req.window) {
            $target = (Resolve-WindowInfo $req.window $req.window_id).Handle
        }
        else {
            return Background-Unavailable 'key' 'background key requires an exact ref or window_id' $null 'target_required'
        }
        $before = Get-ObservableTargetState $refRecord 'key'
        try {
            Assert-ExecutionAuthorization $req $target
            $messageTarget = [MixWin32]::BackgroundKeys($target, $preferred, [string]$req.keys)
            return Complete-NativeAction 'key' $messageTarget ([MixWin32]::WindowId($target)) $before $refRecord "keys delivered to $messageTarget as native window messages"
        }
        catch {
            return Native-BackgroundFailure 'key' $_.Exception ([MixWin32]::WindowId($target))
        }
    }
    $target = [IntPtr]::Zero
    $focusPoint = $null
    if ($req.ref) {
        $focusPoint = Get-ElPoint $req.ref $false
        $target = $focusPoint[2]
    }
    elseif ($req.window_id -or $req.window) {
        $target = (Resolve-WindowInfo $req.window $req.window_id).Handle
    }
    else {
        $target = (Get-CurrentSession).LastFocus
    }
    if (-not [MixWin32]::IsWindowHandle($target)) {
        return New-ActionResult 'key' 'none' 'suspected_noop' $false 'key requires window_id/window or a prior focus_window in this session' 'target_required' 'foreground' $null
    }
    return Invoke-ForegroundInput $target 'key' {
        Focus-TypingPoint $req $target $focusPoint
        Report-TypingPoint $req $focusPoint
        # A sequence of one character carries no grammar: '+' and its kin are the
        # character that was asked for, not a SendKeys prefix or group.
        $sequence = [string]$req.keys
        if ($sequence.Length -eq 1 -or $sequence -notmatch '[{}^%+~()#]') { [MixWin32]::SendText($sequence) }
        else { Send-KeysGuarded $req.keys }
    }
}

# Holding a key past the end of its command needs the real keyboard: a window
# message cannot leave a key physically down for the next command to build on.
function Do-KeyHold($req, $direction) {
    $action = "key_$direction"
    if ($req.delivery -ne 'foreground') {
        return Background-Unavailable $action 'a held key requires the real keyboard; use explicit foreground delivery' $null 'background_unsupported'
    }
    $keys = [string]$req.keys
    $target = [IntPtr]::Zero
    $focusPoint = $null
    if ($req.ref) {
        $focusPoint = Get-ElPoint $req.ref $false
        $target = $focusPoint[2]
    }
    elseif ($req.window_id -or $req.window) {
        $target = (Resolve-WindowInfo $req.window $req.window_id).Handle
    }
    else {
        $target = (Get-CurrentSession).LastFocus
    }
    if (-not [MixWin32]::IsWindowHandle($target)) {
        return New-ActionResult $action 'none' 'suspected_noop' $false "$action requires window_id/window or a prior focus_window in this session" 'target_required' 'foreground' $null
    }
    $state = Get-CurrentSession
    return Invoke-ForegroundInput $target $action {
        Focus-TypingPoint $req $target $focusPoint
        Report-TypingPoint $req $focusPoint
        [MixTaggedKeys]::Hold($keys, ($direction -eq 'down'))
        if ($direction -eq 'down') { $state.HeldKeys[$keys] = $true }
        else { $state.HeldKeys.Remove($keys) }
    }
}

function Do-Type($req) {
    $text = if ($null -eq $req.text) { '' } else { [string]$req.text }
    if ($req.delivery -eq 'foreground' -and $text.Length -gt $script:MaximumForegroundTextCharacters) {
        throw "input_too_large: foreground text exceeds $script:MaximumForegroundTextCharacters UTF-16 code units"
    }
    if ($req.delivery -ne 'foreground') {
        $target = [IntPtr]::Zero
        $preferred = [IntPtr]::Zero
        $refRecord = $null
        if ($req.ref) {
            $refRecord = Get-RefRecord $req.ref
            $target = Get-RefTopHandle $refRecord
            if ($refRecord.Kind -ne 'msaa') { $preferred = Get-ExactNativeElementHandle $refRecord.Element }
            # Either there is no exact native keyboard target, or the host drops posted
            # characters (XAML/WinUI/UWP). The element's own value pattern carries the
            # text on this same background delivery, so it is a transport choice inside
            # background rather than an escalation to foreground.
            if ($preferred -eq [IntPtr]::Zero -or -not (Test-BackgroundKeyboardRoute $target $preferred)) {
                if (Test-BackgroundValueTarget $refRecord) {
                    $valued = Invoke-BackgroundSemantic $req.ref { Do-SetValue $req.ref $text } 'type'
                    $valued.action = 'type'
                    return $valued
                }
                if ($preferred -eq [IntPtr]::Zero) {
                    return Background-Unavailable 'type' 'element exposes no native keyboard target and no settable value; use explicit foreground delivery' $refRecord.WindowId 'background_unsupported'
                }
            }
        }
        elseif ($req.window_id -or $req.window) {
            $target = (Resolve-WindowInfo $req.window $req.window_id).Handle
        }
        else {
            return Background-Unavailable 'type' 'background type requires an exact ref or window_id' $null 'target_required'
        }
        $before = Get-ObservableTargetState $refRecord 'type'
        $pointerCompleted = $false
        try {
            # One hold covers the click, the wait and the text, so the target is
            # never activatable between them; the settle and foreground recovery
            # run once, when the scope ends.
            $inactive = [MixWin32]::BeginInactive($target)
            try {
                if ($null -ne $req.x -and $null -ne $req.y) {
                    [void][MixWin32]::BackgroundPointer(
                        $target, [int]$req.x, [int]$req.y, 'click', $null)
                    $pointerCompleted = $true
                    Start-Sleep -Milliseconds 80
                }
                Assert-ExecutionAuthorization $req $target
                $messageTarget = [MixWin32]::BackgroundText($target, $preferred, $text)
            }
            finally { [MixWin32]::EndInactive($inactive) }
            return Complete-NativeAction 'type' $messageTarget ([MixWin32]::WindowId($target)) $before $refRecord "typed $($text.Length) literal characters into $messageTarget as native window messages"
        }
        catch {
            return Native-BackgroundFailure 'type' $_.Exception ([MixWin32]::WindowId($target)) $pointerCompleted
        }
    }
    $target = [IntPtr]::Zero
    $focusPoint = $null
    if ($req.ref) {
        $focusPoint = Get-ElPoint $req.ref $false
        $target = $focusPoint[2]
    }
    elseif ($req.window_id -or $req.window) {
        $target = (Resolve-WindowInfo $req.window $req.window_id).Handle
        if ($null -ne $req.x -and $null -ne $req.y) {
            $focusPoint = @([int]$req.x, [int]$req.y, $target)
        }
    }
    else {
        $target = (Get-CurrentSession).LastFocus
    }
    if (-not [MixWin32]::IsWindowHandle($target)) {
        return New-ActionResult 'type' 'none' 'suspected_noop' $false 'type requires window_id/window or a prior focus_window in this session' 'target_required' 'foreground' $null
    }
    return Invoke-ForegroundInput $target 'type' {
        Focus-TypingPoint $req $target $focusPoint
        Report-TypingPoint $req $focusPoint
        [MixWin32]::SendText($text)
    }
}

