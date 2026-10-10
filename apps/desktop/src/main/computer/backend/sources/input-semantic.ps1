function New-ActionResult($action, $path, $effect, $verified, $message, $code, $delivery, $windowId) {
    $accepted = $null -eq $code -and $path -ne 'none' -and $effect -ne 'suspected_noop'
    # A target that refused the no-activate style still got the input, but the
    # result must not present that delivery as protected from raising it.
    $unprotected = $accepted -and $delivery -eq 'background' -and [MixWin32]::ActivationUnprotected -eq $true
    if ($unprotected) {
        [MixWin32]::ActivationUnprotected = $false
        $message = "$message; the target refused the no-activate hold, so background delivery could not keep it from coming forward"
    }
    $result = @{
        text              = $message
        action            = $action
        path              = $path
        effect            = $effect
        verified          = $verified
        delivery_accepted = $accepted
        goal_verified     = $verified
        code              = $code
        delivery          = $delivery
        window_id         = $windowId
    }
    if ($unprotected) { $result.activation_protection = 'unavailable' }
    return $result
}

function Get-VerifiedEffect($verified) {
    if ($verified) { return 'confirmed' }
    return 'unverifiable'
}

function Background-Unavailable($action, $message, $windowId, $code = 'background_unavailable', [bool]$mayHaveExecuted = $false) {
    $result = New-ActionResult $action 'none' 'suspected_noop' $false $message $code 'background' $windowId
    if ($mayHaveExecuted) {
        $result.delivery_accepted = $null
        $result.effect = 'unverifiable'
        $result.input_may_have_executed = $true
    }
    return $result
}

function Invoke-BackgroundWindow($target, [scriptblock]$operation) {
    $foregroundBefore = [MixWin32]::Foreground()
    $inputBefore = [MixInputObservation]::Read()
    $result = $null
    # Restoring focus after the fact needs foreground rights Windows may refuse,
    # so a window that would activate itself is held disabled for the call: the
    # steal never happens instead of being undone.
    $shielded = $target -ne [IntPtr]::Zero -and $foregroundBefore -ne $target -and
        [MixWin32]::SelfActivatesOnSemanticInput($target)
    $wasEnabled = $false
    # Held through the steal watch below. A target that accepts the no-activate
    # style declines activation, including one its host queues for when the
    # shield lifts; a target that refuses the style (higher integrity) is not
    # held, and the watch and restore below are then its only protection.
    $inactive = [MixWin32]::HoldInactive($target)
    try {
        if ($shielded) { $wasEnabled = [MixWin32]::SetWindowEnabled($target, $false) }
        $result = & $operation
    }
    finally {
        try {
            # A XAML host honours the shield outright. A Chromium host queues its own
            # activation instead and raises it once the window is enabled again, which
            # no wait here prevents and no restore can undo from a process without
            # foreground rights; the shield still spares every window that does honour it.
            if ($shielded -and $wasEnabled) { [void][MixWin32]::SetWindowEnabled($target, $true) }
            $tookFocus = {
                $foregroundAfter = [MixWin32]::Foreground()
                $target -ne [IntPtr]::Zero -and (
                    [MixWin32]::IsWithinTopLevel($foregroundAfter, $target) -or
                    [MixWin32]::IsContainedSameProcess($foregroundAfter, $target) -or
                    [MixWin32]::IsOwnedBy($foregroundAfter, $target)
                )
            }
            # False once user input superseded the observation: nothing is restored then.
            $restore = {
                try {
                    [MixInputObservation]::BeginExpected($inputBefore.Generation, $inputBefore.Sequence)
                    try {
                        [MixInputObservation]::AssertContinue()
                        [void][MixWin32]::Focus($foregroundBefore)
                    }
                    finally { [MixInputObservation]::End() }
                    return $true
                }
                catch {
                    if ($_.Exception.Message -notmatch 'user_input_active|input_observation_unavailable') { throw }
                    return $false
                }
            }
            $canRestore = $inputBefore.Ready -and
                $foregroundBefore -ne [IntPtr]::Zero -and
                $foregroundBefore -ne $target -and
                [MixWin32]::IsWindowHandle($foregroundBefore)
            # Measured on Windows 11 Settings: the frame raised itself 5-30 ms after
            # the accessibility call returned, disabled or not, so one check made
            # right away saw nothing to restore. Every self-activating target,
            # Chromium included, is watched for that short window, and one that
            # takes the foreground again after a restore is restored once more.
            $watching = $shielded -and $canRestore
            $restores = 0
            $watch = [System.Diagnostics.Stopwatch]::StartNew()
            while ($true) {
                if ($canRestore -and $restores -lt 2 -and (& $tookFocus)) {
                    $restores++
                    if (-not (& $restore)) { break }
                }
                if (-not $watching -or $restores -ge 2 -or $watch.ElapsedMilliseconds -ge 100) { break }
                Start-Sleep -Milliseconds 10
            }
        }
        finally {
            [MixWin32]::ReleaseInactive($inactive)
        }
    }
    return $result
}

function Show-ReferencePointer($ref, $phase) {
    if ($null -eq [MixWin32]::PointerProgress) { return }
    try {
        $point = Get-ElPoint $ref $false
        [MixWin32]::ReportPointer($point[0], $point[1], $false, $phase)
        return $point
    }
    catch {
        # Missing visual bounds must not replay or block an otherwise valid semantic action.
        [MixWin32]::PointerEventsFailed++
    }
}

function Invoke-BackgroundSemantic($ref, [scriptblock]$operation, $effect = 'release') {
    $record = Get-RefRecord $ref
    $target = Get-RefTopHandle $record
    $point = Show-ReferencePointer $ref 'prepare'
    # The presented pointer travels to the announced target before the worker acts
    # there, so the visible effect lands where and when the action really happens.
    # The wait follows that travel rather than always paying for the longest one.
    if ($null -ne $point) { Start-Sleep -Milliseconds ([MixWin32]::LastGlideWaitMs) }
    $result = Invoke-BackgroundWindow $target $operation
    if ($null -ne $point -and $result.delivery_accepted -eq $true) {
        # The action can close or relayout its element. Keep the point actually acted on.
        [MixWin32]::ReportPointer($point[0], $point[1], $false, $effect)
    }
    return $result
}

function Native-BackgroundFailure($action, $exception, $windowId, [bool]$priorInput = $false) {
    $detail = [string]$exception.Message
    if ($detail.Contains('input_cleanup_unconfirmed:')) {
        throw 'input_cleanup_unconfirmed: background input release was not acknowledged; do not replay input'
    }
    $code = 'background_unavailable'
    foreach ($candidate in @(
            'background_target_hung',
            'background_blocked_uipi',
            'background_message_rejected',
            'background_target_ambiguous',
            'background_unsupported',
            'target_mismatch',
            'stale_target'
        )) {
        if ($detail.Contains($candidate + '|')) {
            $code = $candidate
            $detail = $detail.Substring($detail.IndexOf($candidate + '|') + $candidate.Length + 1)
            $detail = $detail.Trim('"')
            break
        }
    }
    # Only complete preflight rejection proves that no input was attempted.
    return Background-Unavailable $action $detail $windowId $code ($priorInput -or $code -ne 'background_unsupported')
}

function Get-ObservableElementState($el, $action) {
    if ($null -eq $el) { return $null }
    try {
        $parts = New-Object System.Collections.ArrayList
        $pat = $null
        if ($action -in @('click', 'double_click', 'right_click', 'middle_click', 'triple_click')) {
            if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pat)) {
                [void]$parts.Add('toggle=' + [string]$pat.Current.ToggleState)
            }
            $pat = $null
            if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pat)) {
                [void]$parts.Add('selected=' + [string]$pat.Current.IsSelected)
            }
            $pat = $null
            if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pat)) {
                [void]$parts.Add('expanded=' + [string]$pat.Current.ExpandCollapseState)
            }
        }
        if ($action -in @('key', 'type')) {
            $pat = $null
            if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pat)) {
                [void]$parts.Add('value=' + [string]$pat.Current.Value)
            }
        }
        if ($action -eq 'drag') {
            $pat = $null
            if ($el.TryGetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern, [ref]$pat)) {
                [void]$parts.Add('range=' + [string]$pat.Current.Value)
            }
        }
        if ($action -eq 'scroll') {
            $pat = $null
            if ($el.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$pat)) {
                [void]$parts.Add('scroll=' + [string]$pat.Current.HorizontalScrollPercent + ',' + [string]$pat.Current.VerticalScrollPercent)
            }
        }
        $nativeHandle = Get-NativeElementHandle $el
        $native = [MixWin32]::NativeObservableState($nativeHandle, $action)
        if ($native) { [void]$parts.Add($native) }
        if ($parts.Count -eq 0) { return $null }
        return [string]($parts -join '|')
    }
    catch {
        return $null
    }
}

function Complete-NativeAction($action, $messageTarget, $windowId, $before, $targetState, $message) {
    $stateChanged = $false
    if ($null -ne $before) {
        Start-Sleep -Milliseconds 40
        $after = Get-ObservableTargetState $targetState $action
        $stateChanged = $null -ne $after -and $after -ne $before
    }
    $suffix = if ($stateChanged) {
        '; target state changed, but the requested goal is not verified'
    }
    else {
        '; refresh state before treating it as complete'
    }
    $result = New-ActionResult $action 'win32_message' 'unverifiable' $false ($message + $suffix) $null 'background' $windowId
    $result.state_changed = $stateChanged
    return $result
}

function Do-Invoke($ref, [bool]$allowNativeClick = $false) {
    $record = Get-RefRecord $ref
    if ($record.Kind -eq 'msaa') {
        if (-not $record.Msaa.Enabled) {
            return Background-Unavailable 'invoke' "element $ref is disabled; no input was sent" $record.WindowId 'element_disabled'
        }
        try {
            $defaultAction = [string]$record.Msaa.DefaultAction
            if ($allowNativeClick -and [string]::IsNullOrWhiteSpace($defaultAction)) { return $null }
            Assert-ExecutionAuthorization $script:CurrentRequest
            $record.Msaa.DoDefaultAction()
            return New-ActionResult 'invoke' 'msaa_default_action' 'unverifiable' $false "invoked $ref through MSAA default action: $defaultAction" $null 'background' $record.WindowId
        }
        catch {
            $message = 'MSAA default action failed for {0}: {1}' -f $ref, $_.Exception.Message
            return Background-Unavailable 'invoke' $message $record.WindowId 'msaa_action_failed' $true
        }
    }
    $el = $record.Element
    if (-not $el.Current.IsEnabled) {
        return Background-Unavailable 'invoke' "element $ref is disabled; no input was sent" $record.WindowId 'element_disabled'
    }
    $pat = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pat)) {
        $before = [string]$pat.Current.ToggleState
        Assert-ExecutionAuthorization $script:CurrentRequest
        $pat.Toggle()
        $after = [string]$pat.Current.ToggleState
        $verified = $before -ne $after
        return New-ActionResult 'invoke' 'uia_toggle' (Get-VerifiedEffect $verified) $verified "activated $ref through UIA toggle from $before to $after" $null 'background' (Get-TopWindowId $el)
    }
    $pat = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pat)) {
        $before = [string]$pat.Current.ExpandCollapseState
        if ($before -in @('Collapsed', 'PartiallyExpanded', 'Expanded')) {
            $expected = if ($before -eq 'Expanded') { 'Collapsed' } else { 'Expanded' }
            Assert-ExecutionAuthorization $script:CurrentRequest
            if ($expected -eq 'Expanded') { $pat.Expand() } else { $pat.Collapse() }
            $after = [string]$pat.Current.ExpandCollapseState
            $verified = $after -eq $expected
            return New-ActionResult 'invoke' 'uia_expand_collapse' (Get-VerifiedEffect $verified) $verified "activated $ref through UIA expand/collapse from $before to $after" $null 'background' $record.WindowId
        }
    }
    $pat = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) {
        Assert-ExecutionAuthorization $script:CurrentRequest
        $pat.Invoke()
        return New-ActionResult 'invoke' 'uia_invoke' 'unverifiable' $false "invoked $ref through UIA" $null 'background' (Get-TopWindowId $el)
    }
    if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pat)) {
        Assert-ExecutionAuthorization $script:CurrentRequest
        $pat.Select()
        return New-ActionResult 'invoke' 'uia_selection' 'unverifiable' $false "selected $ref through UIA" $null 'background' (Get-TopWindowId $el)
    }
    $top = New-Object IntPtr((Get-TopWindow $el).Current.NativeWindowHandle)
    if ($allowNativeClick) { return $null }
    return Background-Unavailable 'invoke' "element $ref exposes no semantic toggle/invoke/select action; no physical fallback was attempted" ([MixWin32]::WindowId($top))
}

# A XAML/WinUI/UWP host consumes only system-queue input, so posted characters
# reach nothing there. The native guard decides, and its refusal runs before any
# delivery, so a false answer means no input was sent.
function Test-BackgroundKeyboardRoute($top, $preferred) {
    try {
        [MixWin32]::ValidateBackgroundInput($top, $preferred, 'type', '')
        return $true
    }
    catch { return $false }
}

# A value-settable element accepts text through its own pattern, so background
# text input does not need an exact native keyboard target on that element.
function Test-BackgroundValueTarget($record) {
    if ($record.Kind -eq 'msaa') { return $true }
    $el = $record.Element
    $pat = $null
    if (-not $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pat)) { return $false }
    # A browser or Electron tab echoes the write without applying it in the
    # document, so its readback would confirm input that never landed.
    $top = New-Object IntPtr((Get-TopWindow $el).Current.NativeWindowHandle)
    return -not [MixWin32]::IsWebContentHost($top) -and -not (Test-IgnoredValueWrite $el)
}

# Excel's cells take a value write through UIA and echo it back on every later
# read, while the sheet, the formula bar and the saved workbook keep the old
# value: the readback confirms data that was never entered.
function Test-IgnoredValueWrite($el) {
    try { return [string]$el.Current.ClassName -eq 'XLSpreadsheetCell' } catch { return $false }
}

# A field inside a selectable item (File Explorer's name cell) edits the
# selection, not the item it sits in: with two files selected, writing one
# name renamed both. The owning item becomes the only selection first. Returns
# $null when the write is scoped to that item alone, or why it is not.
function Select-OwningItemAlone($el) {
    $selection = $null
    if (-not $el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection)) {
        $item = $null
        try { $item = $Walker.GetParent($el) } catch { return $null }
        if ($null -eq $item -or
            -not $item.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection)) {
            return $null
        }
    }
    try {
        $container = $selection.Current.SelectionContainer
        $containerSelection = $null
        $selectedCount = { @($containerSelection.Current.GetSelection()).Count }
        if ($null -eq $container -or
            -not $container.TryGetCurrentPattern([System.Windows.Automation.SelectionPattern]::Pattern, [ref]$containerSelection)) {
            return 'its container does not report the selection'
        }
        # Only a multi-selection can widen the write; a radio group or a
        # single-select list keeps its state untouched.
        if (-not $containerSelection.Current.CanSelectMultiple) { return $null }
        if ($selection.Current.IsSelected -and (& $selectedCount) -eq 1) { return $null }
        $selection.Select()
        for ($attempt = 0; $attempt -lt 10; $attempt++) {
            if ($selection.Current.IsSelected -and (& $selectedCount) -eq 1) { return $null }
            Start-Sleep -Milliseconds 20
        }
        return "$(& $selectedCount) items stay selected"
    }
    catch { return 'selection could not be read' }
}

function Do-SetValue($ref, $text) {
    $record = Get-RefRecord $ref
    if ($record.Kind -eq 'msaa') {
        try {
            Assert-ExecutionAuthorization $script:CurrentRequest
            $actual = [string]$record.Msaa.SetValue([string]$text)
            $verified = $actual -eq [string]$text
            $effect = Get-VerifiedEffect $verified
            return New-ActionResult 'set_value' 'msaa_value' $effect $verified "set $ref value through MSAA; readback=$verified" $null 'background' $record.WindowId
        }
        catch {
            $message = 'MSAA value set failed for {0}: {1}' -f $ref, $_.Exception.Message
            return Background-Unavailable 'set_value' $message $record.WindowId 'msaa_value_failed' $true
        }
    }
    $el = $record.Element
    $pat = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pat)) {
        if (Test-IgnoredValueWrite $el) {
            return Background-Unavailable 'set_value' "element $ref is an Excel cell, which echoes an accessibility value write without entering it; select the cell and type with explicit foreground delivery; no value was set" $record.WindowId 'value_write_ignored'
        }
        Assert-ExecutionAuthorization $script:CurrentRequest
        $scope = Select-OwningItemAlone $el
        if ($null -ne $scope) {
            return Background-Unavailable 'set_value' "element $ref belongs to an item that could not be made the only selection, and the write would apply to every selected item ($scope); no value was set" $record.WindowId 'selection_not_exclusive'
        }
        $pat.SetValue($text)
        $actual = ''
        for ($attempt = 0; $attempt -lt 8; $attempt++) {
            $actual = [string]$pat.Current.Value
            if ($actual -eq [string]$text) { break }
            Start-Sleep -Milliseconds 25
        }
        $verified = $actual -eq [string]$text
        $effect = Get-VerifiedEffect $verified
        return New-ActionResult 'set_value' 'uia_value' $effect $verified "set $ref value through UIA; readback=$verified" $null 'background' (Get-TopWindowId $el)
    }
    $topHandle = New-Object IntPtr((Get-TopWindow $el).Current.NativeWindowHandle)
    return Background-Unavailable 'set_value' "element $ref exposes no ValuePattern; no keystroke fallback was attempted" ([MixWin32]::WindowId($topHandle))
}

function Do-Toggle($ref) {
    $record = Get-RefRecord $ref
    if ($record.Kind -eq 'msaa') {
        $result = Do-Invoke $ref
        $result.action = 'toggle'
        return $result
    }
    $el = $record.Element
    $pat = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pat)) {
        $before = $pat.Current.ToggleState
        Assert-ExecutionAuthorization $script:CurrentRequest
        $pat.Toggle()
        $after = $before
        for ($attempt = 0; $attempt -lt 10 -and $before -eq $after; $attempt++) {
            Start-Sleep -Milliseconds 25
            $freshPattern = $null
            try {
                if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$freshPattern)) {
                    $after = $freshPattern.Current.ToggleState
                }
            }
            catch {}
        }
        $verified = $before -ne $after
        return New-ActionResult 'toggle' 'uia_toggle' (Get-VerifiedEffect $verified) $verified "toggled $ref from $before to $after" $null 'background' (Get-TopWindowId $el)
    }
    $result = Do-Invoke $ref
    $result.action = 'toggle'
    return $result
}

