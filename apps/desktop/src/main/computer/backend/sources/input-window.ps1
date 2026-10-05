function Do-Focus($req) {
    $info = Resolve-WindowInfo $req.window $req.window_id
    $refusal = Get-ForegroundRefusal 'focus_window' $info.Handle $req
    if ($null -ne $refusal) { return $refusal }
    $state = Get-CurrentSession
    $previous = [MixWin32]::Foreground()
    # Focus moves the desktop like any input: user input while it settles stops
    # it, and a target that does not keep the foreground was not focused.
    [MixInputObservation]::Begin()
    try {
        if (-not [MixWin32]::Focus($info.Handle)) {
            return New-ActionResult 'focus_window' 'foreground' 'suspected_noop' $false "could not bring window to foreground: $($info.Title)" 'foreground_unavailable' 'foreground' $info.Id
        }
        if ($previous -ne $info.Handle) { [System.Threading.Thread]::Sleep(120) }
        [MixInputObservation]::AssertContinue()
        if ([MixWin32]::Foreground() -ne $info.Handle) {
            return New-ActionResult 'focus_window' 'foreground' 'suspected_noop' $false "the foreground moved away from $($info.Title) before focus settled" 'foreground_changed' 'foreground' $info.Id
        }
        $state.LastFocus = $info.Handle
        return New-ActionResult 'focus_window' 'foreground' 'confirmed' $true "focused: $($info.Title)" $null 'foreground' $info.Id
    }
    finally {
        [MixInputObservation]::End()
    }
}

function Get-WindowBounds($req) {
    $info = Resolve-WindowInfo $req.window $req.window_id
    if ($info.Width -le 0 -or $info.Height -le 0) {
        throw "window has no capturable bounds: $($info.Id)"
    }
    return @{
        text               = ('window bounds: ' + $info.Title)
        title              = $info.Title
        window_id          = $info.Id
        owner_id           = $info.OwnerId
        x                  = $info.X
        y                  = $info.Y
        width              = $info.Width
        height             = $info.Height
        client_x           = $info.ClientX
        client_y           = $info.ClientY
        client_width       = $info.ClientWidth
        client_height      = $info.ClientHeight
        related_window_ids = @([MixWin32]::RelatedWindowIds($info.Handle))
    }
}

# Read-only predicate state. Deliberately does NOT touch the session ref map or
# generation: waiting for a condition must never invalidate the refs the caller
# is holding from its last capture.
function Get-WindowPredicates($req) {
    try {
        $info = Resolve-WindowInfo $req.window $req.window_id
    }
    catch {
        $detail = [string]$_.Exception.Message
        $isAbsent = $detail.StartsWith('window_id is stale or invalid:') -or
        $detail.StartsWith('foreground window not found') -or
        $detail.StartsWith('window not found:')
        if (-not $isAbsent) { throw }
        return @{
            text      = 'window predicate state: absent'
            window_id = if ($req.window_id) { [string]$req.window_id } else { $null }
            title     = ''
            exists    = $false
            returned  = 0
            elements  = @()
        }
    }
    if ($req.include_elements -eq $false) {
        return @{
            text      = ('window predicate state: ' + $info.Title)
            window_id = $info.Id
            title     = [string]$info.Title
            exists    = $true
            returned  = 0
            elements  = @()
        }
    }
    $win = Find-Window $req.window $req.window_id
    $max = if ($null -ne $req.max_elements) { [int]$req.max_elements } else { 400 }
    if ($max -lt 1 -or $max -gt 1000) { throw 'max_elements must be 1..1000' }
    # Negative predicates need every exposed name/value, including Custom and
    # container controls. A display-oriented role filter cannot prove absence.
    $cond = [System.Windows.Automation.Condition]::TrueCondition
    $cr = New-Object System.Windows.Automation.CacheRequest
    [void]$cr.Add($AE::NameProperty)
    [void]$cr.Add($AE::ControlTypeProperty)
    [void]$cr.Add($AE::IsEnabledProperty)
    [void]$cr.Add($AE::IsOffscreenProperty)
    [void]$cr.Add($AE::IsValuePatternAvailableProperty)
    [void]$cr.Add([System.Windows.Automation.ValuePattern]::ValueProperty)
    [void]$cr.Add($AE::IsTextPatternAvailableProperty)
    [void]$cr.Add($AE::IsKeyboardFocusableProperty)
    $act = $cr.Activate()
    try { $els = $win.FindAll($TS::Descendants, $cond) } finally { $act.Dispose() }
    $observations = New-Object System.Collections.ArrayList
    $textComplete = $true
    $readText = -not (([string]$info.ClassName) -like 'Chrome_WidgetWin*')
    foreach ($el in $els) {
        if ($observations.Count -ge $max) { $textComplete = $false; break }
        if ($el.Cached.IsOffscreen) { continue }
        $ct = $el.Cached.ControlType.ProgrammaticName -replace 'ControlType\.', ''
        $name = ''
        try { $name = [string]$el.Cached.Name } catch { $textComplete = $false }
        $value = ''
        if (@('Edit', 'ComboBox', 'Document', 'Spinner') -contains $ct) {
            $cachedValue = Get-CachedSupported $el ([System.Windows.Automation.ValuePattern]::ValueProperty)
            if ($null -ne $cachedValue) { $value = [string]$cachedValue }
            elseif (Get-CachedFlag $el $AE::IsValuePatternAvailableProperty) { $textComplete = $false }
        }
        # A terminal or document body has no value; its visible lines are what
        # a present/absent predicate has to match.
        # Static labels already carry their text as a name; only a focusable
        # surface is read, which also bounds the per-poll cost.
        if ($readText -and (Get-CachedFlag $el $AE::IsKeyboardFocusableProperty) -and
            -not (Get-CachedFlag $el $AE::IsValuePatternAvailableProperty) -and
            (Get-CachedFlag $el $AE::IsTextPatternAvailableProperty)) {
            $lines = Get-VisibleTextLines $el
            if ($null -eq $lines) { $textComplete = $false }
            else {
                foreach ($line in $lines) {
                    if ($observations.Count -ge $max) { $textComplete = $false; break }
                    if ($line.Length -gt 200) { $textComplete = $false }
                    [void]$observations.Add([ordered]@{
                            role    = [string]$ct
                            name    = (Format-ObservationValue $line 200)
                            value   = ''
                            enabled = [bool]$el.Cached.IsEnabled
                        })
                }
            }
        }
        if ([string]::IsNullOrWhiteSpace($name) -and [string]::IsNullOrWhiteSpace($value)) { continue }
        if ($name.Length -gt 200 -or $value.Length -gt 200) { $textComplete = $false }
        [void]$observations.Add([ordered]@{
                role    = [string]$ct
                name    = (Format-ObservationValue $name 200)
                value   = (Format-ObservationValue $value 200)
                enabled = [bool]$el.Cached.IsEnabled
            })
    }
    if ($observations.Count -lt $max) {
        $msaaLimit = [Math]::Min(5000, [Math]::Max(100, $max * 5))
        try {
            $msaaSnapshot = [MixMsaa]::SnapshotWithStatus($info.Handle, $info.Id, $msaaLimit)
            $msaaNodes = @($msaaSnapshot.Nodes)
            if (-not $msaaSnapshot.Complete) { $textComplete = $false }
        }
        catch {
            $msaaNodes = @()
            $textComplete = $false
        }
        foreach ($node in $msaaNodes) {
            if ($observations.Count -ge $max) { $textComplete = $false; break }
            # SnapshotWithStatus already refreshed each node. Re-reading the
            # entire tree doubles cross-process calls and can mix two layouts.
            if ($node.Width -le 0 -or $node.Height -le 0) { continue }
            $msaaName = [string]$node.Name
            $msaaValue = [string]$node.Value
            if ([string]::IsNullOrWhiteSpace($msaaName) -and [string]::IsNullOrWhiteSpace($msaaValue)) { continue }
            if ($msaaName.Length -gt 200 -or $msaaValue.Length -gt 200) { $textComplete = $false }
            [void]$observations.Add([ordered]@{
                    role    = (Format-ObservationValue ([string]$node.ControlType) 100)
                    name    = (Format-ObservationValue $msaaName 200)
                    value   = (Format-ObservationValue $msaaValue 200)
                    enabled = [bool]$node.Enabled
                })
        }
    }
    return @{
        text          = ('window predicate state: ' + $info.Title)
        window_id     = $info.Id
        title         = [string]$info.Title
        exists        = $true
        returned      = $observations.Count
        text_complete = $textComplete -and $observations.Count -gt 0
        elements      = @($observations)
    }
}

