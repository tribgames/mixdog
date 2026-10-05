# Nearest native top-level ancestor, before crossing an owned-window boundary.
function Get-TopWindow($el) {
    $cur = $el
    for ($i = 0; $i -lt 50; $i++) {
        $handle = New-Object IntPtr($cur.Current.NativeWindowHandle)
        if ($handle -ne [IntPtr]::Zero -and [MixWin32]::TopLevelWindow($handle) -eq $handle) { return $cur }
        $parent = $Walker.GetParent($cur)
        if ($null -eq $parent) { return $cur }
        $cur = $parent
    }
    return $cur
}

function Get-TopWindowId($el) {
    return [MixWin32]::WindowId((New-Object IntPtr((Get-TopWindow $el).Current.NativeWindowHandle)))
}

function Assert-InputTarget($targetHandle, $action) {
    $lastFocus = (Get-CurrentSession).LastFocus
    if ($lastFocus -eq [IntPtr]::Zero) {
        throw "$action requires focus_window first"
    }
    if ([MixWin32]::Foreground() -ne $lastFocus) {
        throw 'foreground changed (the user is working in another window); input not sent. Call focus_window again.'
    }
    if ($targetHandle -eq [IntPtr]::Zero) {
        throw "$action target is not a window"
    }
    if ($targetHandle -ne $lastFocus) {
        throw "$action target differs from the focused window; call focus_window for the intended target"
    }
}

function Get-ElPoint($ref, $requireTopmost = $true) {
    $record = Get-RefRecord $ref
    if ($record.Kind -eq 'msaa') {
        $x = [int]($record.Msaa.X + $record.Msaa.Width / 2)
        $y = [int]($record.Msaa.Y + $record.Msaa.Height / 2)
        $topHandle = [MixWin32]::ParseWindowId([string]$record.WindowId)
    }
    else {
        $el = $record.Element
        $r = $el.Current.BoundingRectangle
        if ([double]::IsInfinity($r.Width) -or $r.Width -le 0 -or $r.Height -le 0) { throw "element $ref has no clickable bounds" }
        $x = [int]($r.X + $r.Width / 2)
        $y = [int]($r.Y + $r.Height / 2)
        $topHandle = New-Object IntPtr((Get-TopWindow $el).Current.NativeWindowHandle)
    }
    # Occlusion guard: a real click lands on whatever window is on top at that
    # point; refuse instead of clicking through to the wrong app.
    $atPoint = [MixWin32]::WindowAtPoint($x, $y)
    if ($requireTopmost -and $topHandle -ne [IntPtr]::Zero -and $atPoint -ne [IntPtr]::Zero -and
        $atPoint -ne $topHandle -and -not [MixWin32]::IsContainedSameProcess($atPoint, $topHandle)) {
        throw "element $ref is covered by another window at its click point; call focus_window first"
    }
    return @($x, $y, $topHandle)
}

# ref resolves to the occlusion-guarded element center; raw x/y are physical
# screen coordinates (a raw click hits whatever the model sees on top there).
function Get-PointArg($req) {
    # Resolve identity before activation; the foreground path rechecks live
    # bounds and occlusion after bringing that exact window forward.
    if ($req.ref) { return Get-ElPoint $req.ref $false }
    if ($null -eq $req.x -or $null -eq $req.y) { throw "$($req.action) requires ref or x/y screen coordinates" }
    $x = [int]$req.x
    $y = [int]$req.y
    if ($req.window_id -or $req.window) {
        $selected = Resolve-WindowInfo $req.window $req.window_id
        $atPoint = [MixWin32]::WindowAtPoint($x, $y)
        if ($atPoint -eq $selected.Handle) { return @($x, $y, $selected.Handle) }
        if ($atPoint -ne [IntPtr]::Zero -and [MixWin32]::IsContainedSameProcess($atPoint, $selected.Handle)) {
            return @($x, $y, $atPoint)
        }
        if ($atPoint -ne [IntPtr]::Zero -and [MixWin32]::IsOwnedBy($atPoint, $selected.Handle)) {
            foreach ($allowedId in @($req.allowed_window_ids)) {
                if ([MixWin32]::ParseWindowId([string]$allowedId) -eq $atPoint) {
                    return @($x, $y, $atPoint)
                }
            }
        }
        if ($req.delivery -ne 'foreground') { return @($x, $y, $selected.Handle) }
        return @($x, $y, $atPoint)
    }
    return @($x, $y, [MixWin32]::WindowAtPoint($x, $y))
}

