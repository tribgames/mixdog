
function Get-ElRuntimeKey($el) {
    try { return [string](@($el.GetRuntimeId()) -join ',') } catch { return '' }
}

# What the caller saw: the snapshot's cached view when there is one, else the live one.
function Get-ElIdentity($el) {
    foreach ($view in @('Cached', 'Current')) {
        try {
            $info = $el.$view
            # PowerShell turns a property that is not cached into $null, not an error.
            if ($null -eq $info.ControlType) { continue }
            $bounds = $info.BoundingRectangle
            return @{
                ControlType  = $info.ControlType
                Name         = [string]$info.Name
                AutomationId = [string]$info.AutomationId
                X            = [double]$bounds.X
                Y            = [double]$bounds.Y
                Width        = [double]$bounds.Width
                Height       = [double]$bounds.Height
            }
        }
        catch {}
    }
    return $null
}

function Set-ElRef($state, $ref, $el, $windowId, $generation) {
    $state.Map[$ref] = @{
        Kind        = 'uia'
        Element     = $el
        WindowId    = [string]$windowId
        Generation  = [int]$generation
        RuntimeId   = Get-ElRuntimeKey $el
        UiaIdentity = Get-ElIdentity $el
    }
}

# A provider that rebuilds its tree (Chromium/Electron re-rendering) retires the
# element a ref held while the same control stays where the caller saw it. Only
# one enabled element of the same window with the same role, name, automation id
# and bounds may stand in; anything else stays stale.
function Find-ReboundElement($record) {
    $identity = $record.UiaIdentity
    if ($null -eq $identity -or $null -eq $identity.ControlType) { return $null }
    if ([string]::IsNullOrEmpty($identity.Name) -and [string]::IsNullOrEmpty($identity.AutomationId)) { return $null }
    $top = [MixWin32]::ParseWindowId([string]$record.WindowId)
    if (-not [MixWin32]::IsWindowHandle($top)) { return $null }
    try {
        $root = $AE::FromHandle($top)
        $typeCondition = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $identity.ControlType)
        $keyCondition = if ($identity.Name) {
            New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $identity.Name)
        }
        else {
            New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $identity.AutomationId)
        }
        $candidates = $root.FindAll($TS::Descendants, (New-Object System.Windows.Automation.AndCondition($typeCondition, $keyCondition)))
        $matched = @(foreach ($candidate in $candidates) {
                $current = $candidate.Current
                $bounds = $current.BoundingRectangle
                if ([string]$current.AutomationId -ne $identity.AutomationId -or -not $current.IsEnabled) { continue }
                if ([math]::Abs($bounds.X - $identity.X) -gt 2 -or [math]::Abs($bounds.Y - $identity.Y) -gt 2 -or
                    [math]::Abs($bounds.Width - $identity.Width) -gt 2 -or [math]::Abs($bounds.Height - $identity.Height) -gt 2) { continue }
                $candidate
            })
        if ($matched.Count -ne 1) { return $null }
        $rebound = $matched[0]
        $reboundTop = New-Object IntPtr((Get-TopWindow $rebound).Current.NativeWindowHandle)
        if ([MixWin32]::WindowId($reboundTop) -ne [string]$record.WindowId) { return $null }
        return $rebound
    }
    catch { return $null }
}

function Get-MsaaIdentity($node) {
    return '{0}|{1}' -f $node.ControlType, $node.Name
}

function Set-MsaaRef($state, $ref, $node, $windowId, $generation) {
    $state.Map[$ref] = @{
        Kind       = 'msaa'
        Msaa       = $node
        WindowId   = [string]$windowId
        Generation = [int]$generation
        RuntimeId  = [string]$node.Key
        # MSAA has no runtime id; the role and name it was observed with stand in
        # when a later sequence step reaches this ref after an earlier delivery.
        Identity   = Get-MsaaIdentity $node
    }
}

function Get-RefRecord($ref) {
    $map = (Get-CurrentSession).Map
    if (-not $map.ContainsKey($ref)) { throw "ref $ref is stale, from another session, or unknown; take a fresh snapshot/find" }
    $record = $map[$ref]
    if ([int]$record.Generation -ne [int](Get-CurrentSession).Generation) {
        throw "ref $ref is stale; take a fresh snapshot/find"
    }
    $continuation = $script:CurrentRequest.sequence_continuation -eq $true
    if ($record.Kind -eq 'msaa') {
        $top = [MixWin32]::ParseWindowId([string]$record.WindowId)
        if ($null -eq $record.Msaa -or
            (-not [MixWin32]::IsWindowHandle($top)) -or
            ([string]$record.Msaa.WindowId -ne [string]$record.WindowId) -or
            (-not $record.Msaa.Refresh())) {
            throw "ref $ref is stale or its MSAA target changed; take a fresh snapshot/find"
        }
        if ($continuation) {
            if ((Get-MsaaIdentity $record.Msaa) -ne [string]$record.Identity) {
                throw "ref $ref no longer identifies the same element after an earlier step; take a fresh snapshot/find"
            }
            if (-not $record.Msaa.Enabled -or $record.Msaa.Offscreen) {
                throw "ref $ref is disabled or off screen after an earlier step; take a fresh snapshot/find"
            }
        }
        return $record
    }
    if ($null -eq $record.Element) { throw "ref $ref is stale; take a fresh snapshot/find" }
    $el = $record.Element
    $sameElement = $false
    try {
        $top = New-Object IntPtr((Get-TopWindow $el).Current.NativeWindowHandle)
        $sameElement = [MixWin32]::IsWindowHandle($top) -and
        ([MixWin32]::WindowId($top) -eq [string]$record.WindowId) -and
        ((Get-ElRuntimeKey $el) -eq [string]$record.RuntimeId)
    }
    catch {}
    if (-not $sameElement) {
        # A later step of a sequence acts on what earlier steps left, so only the
        # step the caller aimed from its observation may stand in a rebuilt twin.
        $rebound = if ($continuation) { $null } else { Find-ReboundElement $record }
        if ($null -eq $rebound) { throw "ref $ref is stale or its target changed; take a fresh snapshot/find" }
        $record.Element = $rebound
        $record.RuntimeId = Get-ElRuntimeKey $rebound
        $el = $rebound
    }
    # An earlier step of this sequence may have covered, hidden, or disabled it.
    if ($continuation) {
        $current = $null
        try { $current = $el.Current } catch {}
        if ($null -eq $current -or -not $current.IsEnabled -or $current.IsOffscreen) {
            throw "ref $ref is disabled or off screen after an earlier step; take a fresh snapshot/find"
        }
    }
    return $record
}

function Get-El($ref) {
    $record = Get-RefRecord $ref
    if ($record.Kind -ne 'uia') { throw "ref $ref is an MSAA element, not a UIA element" }
    return $record.Element
}

function Get-RefTopHandle($record) {
    if ($record.Kind -eq 'msaa') {
        return [MixWin32]::ParseWindowId([string]$record.WindowId)
    }
    return New-Object IntPtr((Get-TopWindow $record.Element).Current.NativeWindowHandle)
}

function Get-ObservableTargetState($target, $action) {
    if ($null -eq $target) { return $null }
    if ($target -is [System.Collections.IDictionary] -and $target.Contains('Kind')) {
        if ($target.Kind -eq 'msaa') {
            try { return [string]$target.Msaa.ObservableState() } catch { return $null }
        }
        return Get-ObservableElementState $target.Element $action
    }
    return Get-ObservableElementState $target $action
}

