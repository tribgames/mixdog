# Menu entries by exact label, with the accelerator ampersand removed. Menus are
# resolved one live level at a time and never fall back to pixels.
# A menu label as a person reads it: without the access-key ampersand, the
# "(V)" a localized menu appends for that key, the accelerator after a tab, or
# a trailing ellipsis. "보기(&V)" and "Save &As...\tCtrl+Shift+S" both answer to
# their plain name.
function Normalize-MenuLabel($label) {
    $text = ([string]$label) -replace '&', ''
    $text = ($text -split "`t")[0]
    $text = $text -replace '\s*\([A-Za-z0-9]\)', ''
    $text = $text -replace '(\.\.\.|\u2026)\s*$', ''
    return $text.Trim().ToLower()
}

function Get-MenuCandidates($root, $name, $menuOnly = $false) {
    $wanted = Normalize-MenuLabel $name
    $types = if ($menuOnly) { @('MenuItem') } else { @('MenuItem', 'Button', 'SplitButton', 'ListItem') }
    $conds = foreach ($t in $types) {
        New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::$t)
    }
    $cond = if (@($conds).Count -eq 1) { $conds } else {
        New-Object System.Windows.Automation.OrCondition([System.Windows.Automation.Condition[]]$conds)
    }
    $found = New-Object System.Collections.ArrayList
    $elements = @()
    try {
        $elements = @($root.FindAll($TS::Descendants, $cond))
    }
    catch {
        # UIA providers can disappear between capture and invocation. An empty UIA
        # candidate set lets the exact MSAA fallback inspect the same target.
        return @()
    }
    foreach ($el in $elements) {
        $label = ''
        try {
            if ($el.Current.IsOffscreen) { continue }
            $label = [string]$el.Current.Name
        }
        catch { continue }
        if ((Normalize-MenuLabel $label) -eq $wanted) { [void]$found.Add($el) }
    }
    return @($found)
}

function Get-MsaaMenuCandidates($info, $name, $menuOnly = $false) {
    $wanted = Normalize-MenuLabel $name
    $found = New-Object System.Collections.ArrayList
    $seen = @{}
    $windowIds = New-Object System.Collections.ArrayList
    foreach ($relatedId in @([MixWin32]::RelatedWindowIds($info.Handle))) {
        [void]$windowIds.Add([string]$relatedId)
    }
    [void]$windowIds.Add([string]$info.Id)
    foreach ($windowId in @($windowIds | Select-Object -Unique)) {
        try {
            $handle = [MixWin32]::ParseWindowId($windowId)
            if (-not [MixWin32]::IsWindowHandle($handle)) { continue }
            $targetInfo = [MixWin32]::Info($handle)
            # Win32 menu bars belong to OBJID_MENU, not the client tree.
            $nodes = @([MixMsaa]::MenuSnapshot($handle, $targetInfo.Id, 5000))
            if ($nodes.Count -eq 0) {
                $nodes = @([MixMsaa]::Snapshot($handle, $targetInfo.Id, 5000))
            }
        }
        catch {
            continue
        }
        foreach ($node in $nodes) {
            if (-not $node.Refresh() -or -not $node.Enabled -or $node.Offscreen) { continue }
            if ([string]$node.ControlType -notin @('MenuItem', 'Button', 'SplitButton', 'ListItem')) { continue }
            if ($menuOnly -and [string]$node.ControlType -ne 'MenuItem') { continue }
            $label = Normalize-MenuLabel $node.Name
            if ($label -ne $wanted) { continue }
            $identity = '{0}|{1}|{2}|{3}|{4}|{5}|{6}' -f
            $label, $node.ControlType, $node.X, $node.Y, $node.Width, $node.Height, $node.DefaultAction
            if ($seen[$identity]) { continue }
            $seen[$identity] = $true
            [void]$found.Add($node)
        }
    }
    return @($found)
}

function Expand-MenuElement($el) {
    $pat = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pat)) {
        if ([string]$pat.Current.ExpandCollapseState -ne 'Expanded') {
            Assert-ExecutionAuthorization $script:CurrentRequest
            $pat.Expand()
        }
        return $true
    }
    $pat = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) {
        Assert-ExecutionAuthorization $script:CurrentRequest
        $pat.Invoke()
        return $true
    }
    return $false
}

# A classic menu bar answers the whole path from its own menu handles: no level
# opens on screen, and the chosen item reaches the window as the same command a
# click sends. $null means the window has no classic menu or the path does not
# start on it, and the accessibility route decides instead.
function Invoke-Win32MenuPath($req, $info, $path) {
    $menu = [MixWin32]::WindowMenu($info.Handle)
    if ($menu -eq [IntPtr]::Zero) { return $null }
    $walked = @()
    $position = 0
    for ($i = 0; $i -lt $path.Count; $i++) {
        $segment = $path[$i]
        $wanted = Normalize-MenuLabel $segment
        $entries = @([MixWin32]::MenuEntries($info.Handle, $menu, $position, $i -gt 0))
        $indexes = @(for ($index = 0; $index -lt $entries.Count; $index++) {
                if ((Normalize-MenuLabel $entries[$index].Label) -eq $wanted) { $index }
            })
        if ($indexes.Count -eq 0) {
            if ($i -eq 0) { return $null }
            # The level's own entries turn a guessed name into a corrected one.
            $available = (@($entries | ForEach-Object { (($_.Label -replace '&', '' -split "`t")[0] -replace '\s*\([A-Za-z0-9]\)', '').Trim() } |
                        Where-Object { $_ }) | Select-Object -First 20) -join ', '
            throw "menu_path_not_found: no menu entry named '$segment' after $($walked -join ' > '); entries: $available"
        }
        if ($indexes.Count -gt 1) {
            throw "menu_path_ambiguous: '$segment' matched $($indexes.Count) entries; use a more exact path"
        }
        $entry = $entries[$indexes[0]]
        if (-not $entry.Enabled) { throw "menu_item_disabled: '$segment' is disabled" }
        $walked += $segment
        if ($i -lt $path.Count - 1) {
            if ($entry.SubMenu -eq [IntPtr]::Zero) {
                throw "menu_path_not_found: '$segment' opens no submenu for '$($path[$i + 1])'"
            }
            $menu = $entry.SubMenu
            $position = $indexes[0]
            continue
        }
        if ($entry.SubMenu -ne [IntPtr]::Zero) {
            throw "menu_item_not_invokable: '$segment' opens a submenu; name one of its entries"
        }
        Assert-ExecutionAuthorization $req $info.Handle
        [MixWin32]::PostMenuCommand($info.Handle, $entry.Id)
        return New-ActionResult 'invoke_menu' 'win32_menu' 'unverifiable' $false ('invoked menu path: ' + ($walked -join ' > ')) $null 'background' $info.Id
    }
}

function Do-InvokeMenu($req) {
    $info = Resolve-WindowInfo $req.window $req.window_id
    $path = @(@($req.path) | ForEach-Object { [string]$_ } | Where-Object { $_.Trim().Length -gt 0 })
    if ($path.Count -lt 1 -or $path.Count -gt 8) { throw 'menu path must have 1..8 segments' }
    $classic = Invoke-Win32MenuPath $req $info $path
    if ($null -ne $classic) { return $classic }
    return Invoke-BackgroundWindow $info.Handle {
        $root = $null
        $walked = @()
        # Menu levels this call opened itself. A walk that stops early must not
        # leave them on screen for the user or the next command.
        $opened = 0
        try {
            for ($i = 0; $i -lt $path.Count; $i++) {
                $segment = $path[$i]
                # Native applications usually expose menu state through MSAA immediately.
                # Use that exact path before asking UIA to walk an entire provider tree.
                $msaaCandidates = Get-MsaaMenuCandidates $info $segment ($i -gt 0)
                if ($msaaCandidates.Count -gt 1) {
                    throw "menu_path_ambiguous: '$segment' matched $($msaaCandidates.Count) entries; use a more exact path"
                }
                if ($msaaCandidates.Count -eq 1 -and -not [string]::IsNullOrWhiteSpace([string]$msaaCandidates[0].DefaultAction)) {
                    $walked += $segment
                    try {
                        Assert-ExecutionAuthorization $req $info.Handle
                        $msaaCandidates[0].DoDefaultAction()
                    }
                    catch {
                        $code = if ($i -eq $path.Count - 1) {
                            'menu_item_not_invokable'
                        }
                        else {
                            'menu_expand_unavailable'
                        }
                        throw "$($code): '$segment' MSAA default action failed: $($_.Exception.Message)"
                    }
                    if ($i -eq $path.Count - 1) {
                        return New-ActionResult 'invoke_menu' 'msaa_menu' 'unverifiable' $false ('invoked menu path: ' + ($walked -join ' > ')) $null 'background' $info.Id
                    }
                    Start-Sleep -Milliseconds 120
                    $opened++
                    $root = $null
                    continue
                }
                # Do not initialize a potentially stalled UIA provider while MSAA can
                # resolve the exact path. Reacquire only when the next level needs UIA.
                if ($null -eq $root) { $root = Find-Window $req.window $req.window_id }
                $candidates = Get-MenuCandidates $root $segment ($i -gt 0)
                if ($candidates.Count -eq 0 -and $i -gt 0) {
                    # A submenu may live outside the parent item's UIA subtree, but it must
                    # still belong to this exact window's owned popup chain.
                    $popupCandidates = New-Object System.Collections.ArrayList
                    foreach ($popupId in @([MixWin32]::RelatedWindowIds($info.Handle))) {
                        $popupHandle = [MixWin32]::ParseWindowId([string]$popupId)
                        if ($popupHandle -eq $info.Handle -or -not [MixWin32]::IsOwnedBy($popupHandle, $info.Handle)) { continue }
                        $popupRoot = $AE::FromHandle($popupHandle)
                        foreach ($candidate in @(Get-MenuCandidates $popupRoot $segment $true)) {
                            [void]$popupCandidates.Add($candidate)
                        }
                    }
                    $candidates = @($popupCandidates)
                }
                if ($candidates.Count -eq 0) {
                    # A wrong path and a popup chain that closed under the user's own
                    # click fail identically here, so the count that separates them
                    # travels with the error instead of being guessed later.
                    $ownedPopups = @([MixWin32]::RelatedWindowIds($info.Handle)).Count
                    throw "menu_path_not_found: no enabled menu entry named '$segment' after $($walked -join ' > '); owned_popups=$ownedPopups"
                }
                if ($candidates.Count -gt 1) {
                    throw "menu_path_ambiguous: '$segment' matched $($candidates.Count) entries; use a more exact path"
                }
                $el = $candidates[0]
                $elementWindow = [IntPtr](Get-TopWindow $el).Current.NativeWindowHandle
                if ($elementWindow -ne $info.Handle -and -not [MixWin32]::IsOwnedBy($elementWindow, $info.Handle)) {
                    throw 'menu_target_mismatch: menu element no longer belongs to the requested window'
                }
                Assert-ExecutionAuthorization $req $elementWindow
                $enabled = $true
                try { $enabled = [bool]$el.Current.IsEnabled } catch {}
                if (-not $enabled) { throw "menu_item_disabled: '$segment' is disabled" }
                $walked += $segment
                if ($i -eq $path.Count - 1) {
                    $pat = $null
                    if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) {
                        Assert-ExecutionAuthorization $req $elementWindow
                        $pat.Invoke()
                        return New-ActionResult 'invoke_menu' 'uia_menu' 'unverifiable' $false ('invoked menu path: ' + ($walked -join ' > ')) $null 'background' $info.Id
                    }
                    $pat = $null
                    if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pat)) {
                        $before = [string]$pat.Current.ToggleState
                        Assert-ExecutionAuthorization $req $elementWindow
                        $pat.Toggle()
                        $after = [string]$pat.Current.ToggleState
                        $verified = $before -ne $after
                        return New-ActionResult 'invoke_menu' 'uia_menu_toggle' (Get-VerifiedEffect $verified) $verified ('toggled menu path: ' + ($walked -join ' > ') + " from $before to $after") $null 'background' $info.Id
                    }
                    throw "menu_item_not_invokable: '$segment' exposes no menu action"
                }
                if (-not (Expand-MenuElement $el)) {
                    throw "menu_expand_unavailable: '$segment' cannot be opened through accessibility"
                }
                Start-Sleep -Milliseconds 120
                $opened++
                $root = $el
            }
        }
        catch {
            # Nothing was invoked, so the window has to return to the state it had
            # before this call; the original cause still travels to the caller.
            if ($opened -gt 0) {
                try { [void][MixWin32]::BackgroundKeys($info.Handle, [IntPtr]::Zero, ('{ESC}' * $opened)) } catch {}
            }
            throw
        }
    }
}

