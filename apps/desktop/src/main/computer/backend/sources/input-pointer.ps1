function Get-ModifierVks($modifiers) {
    if (-not $modifiers) { return @() }
    $vks = @()
    foreach ($part in ([string]$modifiers).ToLower().Split('+')) {
        switch ($part.Trim()) {
            'ctrl' { $vks += 0x11 }
            'shift' { $vks += 0x10 }
            'alt' { $vks += 0x12 }
            'win' { $vks += 0x5B }
            'super' { $vks += 0x5B }
            '' { }
            default { throw "unknown modifier: $part (use ctrl, shift, alt, win)" }
        }
    }
    return $vks
}

function Test-AllowedPointTarget($candidate, $selectedHandle, $allowedWindowIds) {
    if ($candidate -eq $selectedHandle) { return $true }
    if ([MixWin32]::IsContainedSameProcess($candidate, $selectedHandle)) { return $true }
    if ([MixWin32]::IsOwnedBy($candidate, $selectedHandle)) {
        foreach ($allowedId in @($allowedWindowIds)) {
            if ([MixWin32]::ParseWindowId([string]$allowedId) -eq $candidate) { return $true }
        }
    }
    return $false
}

function Invoke-PointerModifiers($modifiers, $body) {
    $pressed = @()
    try {
        foreach ($vk in @(Get-ModifierVks $modifiers)) {
            [MixWin32]::KeyDown([UInt16]$vk)
            $pressed += $vk
        }
        & $body
    }
    finally {
        $releaseFailed = $false
        for ($i = $pressed.Count - 1; $i -ge 0; $i--) {
            try { [MixWin32]::KeyUp([UInt16]$pressed[$i]) } catch { $releaseFailed = $true }
        }
        if ($releaseFailed) { throw 'input_cleanup_unconfirmed: pointer modifier release failed' }
    }
}

function Invoke-ForegroundWheel($target, $x, $y, $clicks, $horizontal, $modifiers) {
    [MixWin32]::GlideCursor($target, $x, $y)
    Invoke-PointerModifiers $modifiers {
        if ($horizontal) { [MixWin32]::MouseHWheel($clicks) }
        else { [MixWin32]::MouseWheel($clicks) }
    }
}

function Do-ClickFamily($req, $kind) {
    if (($kind -eq 'press' -or $kind -eq 'release') -and $req.delivery -eq 'foreground') {
        # The real pointer belongs to the user: it must never stay pressed between
        # commands, so a held button is background-only.
        throw 'background_unsupported|a held pointer button is background-only; no input sent'
    }
    if ($req.ref -and $kind -eq 'click' -and $req.delivery -ne 'foreground' -and -not $req.modifiers) {
        # Keep click intent: a supported semantic action wins, but an element that
        # has no such pattern can still accept a target-bound native pointer message.
        # A failed/uncertain semantic attempt returns its result, never a second input.
        $semantic = Invoke-BackgroundSemantic $req.ref { Do-Invoke $req.ref $true }
        if ($null -ne $semantic) {
            $semantic.action = $req.action
            return $semantic
        }
    }
    $p = Get-PointArg $req
    $target = $p[2]
    $refRecord = if ($req.ref) { Get-RefRecord $req.ref } else { $null }
    $before = Get-ObservableTargetState $refRecord $req.action
    $selectedHandle = [IntPtr]::Zero
    $allowedWindowIds = @($req.allowed_window_ids)
    if ($req.window_id -or $req.window) {
        $selected = Resolve-WindowInfo $req.window $req.window_id
        $selectedHandle = $selected.Handle
        $allowedOwnedTarget = $target -ne $selected.Handle -and
        [MixWin32]::IsOwnedBy($target, $selected.Handle) -and
        (Test-AllowedPointTarget $target $selected.Handle $allowedWindowIds)
        $pointTargetAllowed = Test-AllowedPointTarget $target $selected.Handle $allowedWindowIds
        if (-not $pointTargetAllowed -and $req.delivery -ne 'foreground') {
            return New-ActionResult $req.action 'none' 'suspected_noop' $false 'frame point is covered by or belongs to a different window' 'target_mismatch' $req.delivery $selected.Id
        }
        if (-not $allowedOwnedTarget) { $target = $selected.Handle }
    }
    if ($req.delivery -ne 'foreground') {
        if (-not $req.ref -and -not $req.window_id -and -not $req.window) {
            return Background-Unavailable $req.action 'background pixel input requires an exact window_id-bound frame' $null 'target_required'
        }
        $pressHold = [IntPtr]::Zero
        try {
            Assert-ExecutionAuthorization $req $target
            # A held button keeps its window non-activatable until the matching
            # release, so the press, the gap and the release share one hold.
            if ($kind -eq 'press') { $pressHold = [MixWin32]::HoldInactive($target) }
            $messageTarget = [MixWin32]::BackgroundPointer($target, $p[0], $p[1], $kind, $req.modifiers)
            if ($kind -eq 'press' -or $kind -eq 'release') {
                $recorded = $pressHold
                $pressHold = [IntPtr]::Zero
                Record-HeldPointer $target $p $kind $recorded
            }
            $message = "$($req.action) delivered to $messageTarget as a native window message"
            return Complete-NativeAction $req.action $messageTarget ([MixWin32]::WindowId($target)) $before $refRecord $message
        }
        catch {
            return Native-BackgroundFailure $req.action $_.Exception ([MixWin32]::WindowId($target))
        }
        finally {
            # Only a press that did not land still owns its hold here.
            [MixWin32]::ReleaseInactive($pressHold)
        }
    }
    return Invoke-ForegroundInput $target $req.action {
        if ($req.ref) { $p = Get-ElPoint $req.ref $true }
        if ($selectedHandle -ne [IntPtr]::Zero) {
            # Foreground delivery deliberately brings the exact target forward.
            # Revalidate only after that focus settles: checking before focus makes
            # every legitimately covered target impossible to operate.
            $focusedPointTarget = [MixWin32]::WindowAtPoint($p[0], $p[1])
            if (-not (Test-AllowedPointTarget $focusedPointTarget $selectedHandle $allowedWindowIds)) {
                throw 'target_mismatch|frame point remains covered after exact target focus'
            }
        }
        [MixWin32]::GlideCursor($target, $p[0], $p[1])
        Invoke-PointerModifiers $req.modifiers {
            switch ($kind) {
                'click' { [MixWin32]::Click($p[0], $p[1]) }
                'double' { [MixWin32]::DoubleClick($p[0], $p[1]) }
                'right' { [MixWin32]::RightClick($p[0], $p[1]) }
                'middle' { [MixWin32]::MiddleClick($p[0], $p[1]) }
                'triple' { [MixWin32]::TripleClick($p[0], $p[1]) }
                'move' {
                    [void][MixWin32]::SetCursorPos($p[0], $p[1])
                    [System.Threading.Thread]::Sleep(16)
                    [MixWin32]::AssertCursorPosition($p[0], $p[1])
                }
            }
        }
    } $true
}

function Do-MouseMove($req) {
    return Do-ClickFamily $req 'move'
}

function Record-HeldPointer($target, $point, $kind, $hold = [IntPtr]::Zero) {
    $state = Get-CurrentSession
    if ($null -eq $state.HeldPointerTargets) { $state.HeldPointerTargets = @{} }
    if ($null -eq $state.HeldPointerInactive) { $state.HeldPointerInactive = @{} }
    $id = [string][MixWin32]::WindowId($target)
    $previous = $state.HeldPointerInactive[$id]
    if ($kind -eq 'press') {
        $state.HeldPointerTargets[$id] = @([int]$point[0], [int]$point[1])
        $state.HeldPointerInactive[$id] = $hold
    }
    else {
        $state.HeldPointerTargets.Remove($id)
        $state.HeldPointerInactive.Remove($id)
    }
    # A release ends the press's hold; a repeated press replaces the earlier one.
    if ($null -ne $previous) { [MixWin32]::ReleaseInactive([IntPtr]$previous) }
}

function Release-HeldPointerButtons($state) {
    # Every exit from a session releases what this session pressed; an unreleased
    # button would leave the target believing a drag is still in progress. The
    # no-activate holds of those presses, and of a sequence that never reached
    # its last step, end here too, each one even when another fails.
    $failed = $false
    if ($null -ne $state.HeldPointerTargets) {
        foreach ($id in @($state.HeldPointerTargets.Keys)) {
            $point = $state.HeldPointerTargets[$id]
            $hold = if ($null -ne $state.HeldPointerInactive) { $state.HeldPointerInactive[$id] } else { $null }
            try {
                try {
                    $handle = [MixWin32]::ParseWindowId([string]$id)
                    [void][MixWin32]::BackgroundPointer($handle, [int]$point[0], [int]$point[1], 'release', '')
                }
                finally {
                    if ($null -ne $hold) {
                        $state.HeldPointerInactive.Remove($id)
                        [MixWin32]::ReleaseInactive([IntPtr]$hold)
                    }
                }
            }
            catch { $failed = $true }
        }
        $state.HeldPointerTargets.Clear()
    }
    if ($null -ne $state.HeldPointerInactive) {
        foreach ($id in @($state.HeldPointerInactive.Keys)) {
            try { [MixWin32]::ReleaseInactive([IntPtr]$state.HeldPointerInactive[$id]) }
            catch { $failed = $true }
        }
        $state.HeldPointerInactive.Clear()
    }
    if ($null -ne $state.SequenceInactive) {
        foreach ($id in @($state.SequenceInactive.Keys)) {
            try { [MixWin32]::EndInactive($state.SequenceInactive[$id]) }
            catch { $failed = $true }
        }
        $state.SequenceInactive.Clear()
    }
    if ($failed) { throw 'input_cleanup_unconfirmed: a held pointer button could not be released' }
}

function Release-HeldKeys($state) {
    if ($null -eq $state.HeldKeys -or $state.HeldKeys.Count -eq 0) { return }
    # A key left down keeps acting on whatever the user does next, so every exit
    # from a session releases what this session pressed.
    $failed = $false
    foreach ($keys in @($state.HeldKeys.Keys)) {
        try { [MixTaggedKeys]::Hold([string]$keys, $false) }
        catch { $failed = $true }
    }
    $state.HeldKeys.Clear()
    if ($failed) { throw 'input_cleanup_unconfirmed: a held key could not be released' }
}

function Do-Wait($req) {
    $s = if ($null -ne $req.duration) { [double]$req.duration } else { 1 }
    if ($s -lt 0 -or $s -gt 30) { throw 'wait duration must be 0..30 seconds' }
    Start-Sleep -Milliseconds ([int]($s * 1000))
    return @{ text = ('waited ' + $s + 's') }
}

function Do-Drag($req) {
    if ($null -ne $req.waypoints -and @($req.waypoints).Count -gt 0) {
        # The host has already mapped every waypoint into screen pixels of one
        # window, so the gesture travels as a single press.
        $points = @($req.waypoints)
        if ($points.Count -lt 2) { throw 'waypoint drag requires at least two points' }
        if (-not $req.window_id -and -not $req.window) {
            return Background-Unavailable 'drag' 'waypoint drag requires an exact window_id-bound frame' $null 'target_required'
        }
        $info = Resolve-WindowInfo $req.window $req.window_id
        $xs = [int[]]@($points | ForEach-Object { [int]$_.x })
        $ys = [int[]]@($points | ForEach-Object { [int]$_.y })
        if ($req.delivery -ne 'foreground') {
            try {
                Assert-ExecutionAuthorization $req $info.Handle
                $messageTarget = [MixWin32]::BackgroundDragPath($info.Handle, $xs, $ys, $req.modifiers)
                return New-ActionResult 'drag' 'win32_message' 'unverifiable' $false "drag delivered to $messageTarget through $($points.Count) waypoints as native window messages; refresh state before treating it as complete" $null 'background' $info.Id
            }
            catch {
                return Native-BackgroundFailure 'drag' $_.Exception $info.Id
            }
        }
        return Invoke-ForegroundInput $info.Handle 'drag' {
            for ($index = 0; $index -lt $xs.Length; $index++) {
                Assert-DragPointTargets $req $info.Handle $xs[$index] $ys[$index] $xs[$index] $ys[$index]
            }
            Invoke-PointerModifiers $req.modifiers { [MixWin32]::DragPath($xs, $ys, $info.Handle) }
        } $true
    }
    if ($null -ne $req.x -or $null -ne $req.y -or $null -ne $req.to_x -or $null -ne $req.to_y) {
        if ($null -eq $req.x -or $null -eq $req.y -or $null -eq $req.to_x -or $null -eq $req.to_y) {
            throw 'coordinate drag requires x, y, to_x, and to_y from one frame_id'
        }
        if (-not $req.window_id -and -not $req.window) {
            return Background-Unavailable 'drag' 'coordinate drag requires an exact window_id-bound frame' $null 'target_required'
        }
        $info = Resolve-WindowInfo $req.window $req.window_id
        $x1 = [int]$req.x; $y1 = [int]$req.y
        $x2 = [int]$req.to_x; $y2 = [int]$req.to_y
        if ($req.delivery -ne 'foreground') {
            try {
                Assert-ExecutionAuthorization $req $info.Handle
                $messageTarget = [MixWin32]::BackgroundDrag(
                    $info.Handle, $x1, $y1, $x2, $y2, $req.modifiers)
                return New-ActionResult 'drag' 'win32_message' 'unverifiable' $false "drag delivered to $messageTarget as native window messages; refresh state before treating it as complete" $null 'background' $info.Id
            }
            catch {
                return Native-BackgroundFailure 'drag' $_.Exception $info.Id
            }
        }
        return Invoke-ForegroundInput $info.Handle 'drag' {
            Assert-DragPointTargets $req $info.Handle $x1 $y1 $x2 $y2
            Invoke-PointerModifiers $req.modifiers { [MixWin32]::Drag($x1, $y1, $x2, $y2, $info.Handle) }
        } $true
    }
    if (-not $req.to) { throw 'drag requires to (destination ref)' }
    $refRecord = Get-RefRecord $req.ref
    $before = Get-ObservableTargetState $refRecord 'drag'
    $a = Get-ElPoint $req.ref $false
    $b = Get-ElPoint $req.to $false
    if ($a[2] -ne $b[2]) {
        return New-ActionResult 'drag' 'none' 'suspected_noop' $false 'drag endpoints belong to different windows' 'target_mismatch' $req.delivery $null
    }
    if ($req.delivery -ne 'foreground') {
        try {
            Assert-ExecutionAuthorization $req $a[2]
            $messageTarget = [MixWin32]::BackgroundDrag($a[2], $a[0], $a[1], $b[0], $b[1], $req.modifiers)
            return Complete-NativeAction 'drag' $messageTarget ([MixWin32]::WindowId($a[2])) $before $refRecord "drag delivered to $messageTarget as native window messages"
        }
        catch {
            return Native-BackgroundFailure 'drag' $_.Exception ([MixWin32]::WindowId($a[2]))
        }
    }
    $dragTarget = $a[2]
    return Invoke-ForegroundInput $dragTarget 'drag' {
        $a = Get-ElPoint $req.ref $true
        $b = Get-ElPoint $req.to $true
        if ($a[2] -ne $dragTarget -or $b[2] -ne $dragTarget) {
            throw 'target_mismatch|drag endpoints changed after focus; no input sent'
        }
        Assert-DragPointTargets $req $dragTarget $a[0] $a[1] $b[0] $b[1]
        Invoke-PointerModifiers $req.modifiers { [MixWin32]::Drag($a[0], $a[1], $b[0], $b[1], $dragTarget) }
    } $true
}

function Assert-DragPointTargets($req, $target, $x1, $y1, $x2, $y2) {
    Assert-ExecutionAuthorization $req $target
    foreach ($point in @(@($x1, $y1), @($x2, $y2))) {
        if (-not (Test-AllowedPointTarget ([MixWin32]::WindowAtPoint($point[0], $point[1])) $target @($req.allowed_window_ids))) {
            throw 'target_mismatch|drag endpoint is covered or outside the observed target; no input sent'
        }
    }
}

function Do-Scroll($req) {
    $direction = ([string]$req.direction).ToLower()
    $amount = if ($null -ne $req.amount) {
        [math]::Max(1, [math]::Min(100, [math]::Abs([int]$req.amount)))
    }
    elseif ($null -ne $req.dy) {
        [math]::Max(1, [math]::Min(100, [math]::Abs([int]$req.dy)))
    }
    else { 3 }
    $horizontal = $direction -in @('left', 'right')
    $amt = if ($direction -in @('up', 'left')) {
        - $amount
    }
    elseif ($direction -in @('down', 'right')) {
        $amount
    }
    elseif ($null -ne $req.dy -and [int]$req.dy -lt 0) {
        - $amount
    }
    else {
        $amount
    }
    $wheelClicks = if ($horizontal) { $amt } else { - $amt }
    if ($null -ne $req.x -or $null -ne $req.y) {
        if ($null -eq $req.x -or $null -eq $req.y) { throw 'coordinate scroll requires x and y from frame_id' }
        if (-not $req.window_id -and -not $req.window) {
            return Background-Unavailable 'scroll' 'coordinate scroll requires an exact window_id-bound frame' $null 'target_required'
        }
        $info = Resolve-WindowInfo $req.window $req.window_id
        $x = [int]$req.x; $y = [int]$req.y
        if ($req.delivery -ne 'foreground') {
            try {
                Assert-ExecutionAuthorization $req $info.Handle
                $messageTarget = [MixWin32]::BackgroundWheel(
                    $info.Handle, $x, $y, $wheelClicks, $req.modifiers, $horizontal)
                return New-ActionResult 'scroll' 'win32_message' 'unverifiable' $false "scrolled $direction at frame point through native window messages; refresh state before treating it as complete" $null 'background' $info.Id
            }
            catch {
                return Native-BackgroundFailure 'scroll' $_.Exception $info.Id
            }
        }
        return Invoke-ForegroundInput $info.Handle 'scroll' {
            Invoke-ForegroundWheel $info.Handle $x $y $wheelClicks $horizontal $req.modifiers
        } $true
    }
    if ($req.ref) {
        $refRecord = Get-RefRecord $req.ref
        if ($req.delivery -ne 'foreground' -and -not $req.modifiers -and $refRecord.Kind -eq 'uia') {
            $el = $refRecord.Element
            $pat = $null
            # Background path: ScrollPattern scrolls without touching mouse or focus.
            if ($el.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$pat)) {
                [void](Show-ReferencePointer $req.ref 'scroll')
                $before = if ($horizontal) { $pat.Current.HorizontalScrollPercent } else { $pat.Current.VerticalScrollPercent }
                $dir = if ($amt -gt 0) { [System.Windows.Automation.ScrollAmount]::SmallIncrement } else { [System.Windows.Automation.ScrollAmount]::SmallDecrement }
                $n = [math]::Min([math]::Abs($amt) * 3, 30)
                for ($i = 0; $i -lt $n; $i++) {
                    Assert-ExecutionAuthorization $req ([IntPtr](Get-TopWindow $el).Current.NativeWindowHandle)
                    if ($horizontal) {
                        if (-not $pat.Current.HorizontallyScrollable) { break }
                        $pat.Scroll($dir, [System.Windows.Automation.ScrollAmount]::NoAmount)
                    }
                    else {
                        if (-not $pat.Current.VerticallyScrollable) { break }
                        $pat.Scroll([System.Windows.Automation.ScrollAmount]::NoAmount, $dir)
                    }
                }
                $after = if ($horizontal) { $pat.Current.HorizontalScrollPercent } else { $pat.Current.VerticalScrollPercent }
                $verified = $before -ne $after
                return New-ActionResult 'scroll' 'uia_scroll' (Get-VerifiedEffect $verified) $verified "scrolled $($req.ref) $direction $n increments through UIA" $null 'background' (Get-TopWindowId $el)
            }
        }
        if ($req.delivery -ne 'foreground') {
            $p = Get-ElPoint $req.ref $false
            $before = Get-ObservableTargetState $refRecord 'scroll'
            try {
                Assert-ExecutionAuthorization $req $p[2]
                $messageTarget = [MixWin32]::BackgroundWheel($p[2], $p[0], $p[1], $wheelClicks, $req.modifiers, $horizontal)
                return Complete-NativeAction 'scroll' $messageTarget ([MixWin32]::WindowId($p[2])) $before $refRecord "scroll delivered to $messageTarget as a native window message"
            }
            catch {
                return Native-BackgroundFailure 'scroll' $_.Exception ([MixWin32]::WindowId($p[2]))
            }
        }
        $p = Get-ElPoint $req.ref $false
        return Invoke-ForegroundInput $p[2] 'scroll' {
            $focusedPoint = Get-ElPoint $req.ref $true
            if ($focusedPoint[2] -ne $p[2]) { throw 'target_mismatch|scroll target changed after focus; no input sent' }
            Invoke-ForegroundWheel $p[2] $focusedPoint[0] $focusedPoint[1] $wheelClicks $horizontal $req.modifiers
        } $true
    }
    if ($req.delivery -ne 'foreground') {
        if (-not $req.window_id -and -not $req.window) {
            return Background-Unavailable 'scroll' 'background scroll requires an exact ref or window_id' $null 'target_required'
        }
        $info = Resolve-WindowInfo $req.window $req.window_id
        $x = [int]($info.X + $info.Width / 2)
        $y = [int]($info.Y + $info.Height / 2)
        try {
            Assert-ExecutionAuthorization $req $info.Handle
            $messageTarget = [MixWin32]::BackgroundWheel($info.Handle, $x, $y, $wheelClicks, $req.modifiers, $horizontal)
            return New-ActionResult 'scroll' 'win32_message' 'unverifiable' $false "scroll delivered to $messageTarget as a native window message; refresh state before treating it as complete" $null 'background' $info.Id
        }
        catch {
            return Native-BackgroundFailure 'scroll' $_.Exception $info.Id
        }
    }
    $info = Resolve-WindowInfo $req.window $req.window_id
    return Invoke-ForegroundInput $info.Handle 'scroll' {
        $x = [int]($info.X + $info.Width / 2)
        $y = [int]($info.Y + $info.Height / 2)
        Invoke-ForegroundWheel $info.Handle $x $y $wheelClicks $horizontal $req.modifiers
    } $true
}

