/**
 * Acting on a target: ref bookkeeping, semantic invoke/set-value/toggle, the occlusion-guarded point resolution, and every Win32 gesture.
 *
 * PowerShell source for the resident Computer Use worker. It is one program
 * split by capability; the pieces are joined in file order, so a line here
 * keeps the meaning it had in the whole.
 */
export const PS_INPUT = String.raw`
function Get-ElRuntimeKey($el) {
  try { return [string](@($el.GetRuntimeId()) -join ',') } catch { return '' }
}

function Set-ElRef($state, $ref, $el, $windowId, $generation) {
  $state.Map[$ref] = @{
    Kind = 'uia'
    Element = $el
    WindowId = [string]$windowId
    Generation = [int]$generation
    RuntimeId = Get-ElRuntimeKey $el
  }
}

function Set-MsaaRef($state, $ref, $node, $windowId, $generation) {
  $state.Map[$ref] = @{
    Kind = 'msaa'
    Msaa = $node
    WindowId = [string]$windowId
    Generation = [int]$generation
    RuntimeId = [string]$node.Key
  }
}

function Get-RefRecord($ref) {
  $map = (Get-CurrentSession).Map
  if (-not $map.ContainsKey($ref)) { throw "ref $ref is stale, from another session, or unknown; take a fresh snapshot/find" }
  $record = $map[$ref]
  if ([int]$record.Generation -ne [int](Get-CurrentSession).Generation) {
    throw "ref $ref is stale; take a fresh snapshot/find"
  }
  if ($record.Kind -eq 'msaa') {
    $top = [MixWin32]::ParseWindowId([string]$record.WindowId)
    if ($null -eq $record.Msaa -or
        (-not [MixWin32]::IsWindowHandle($top)) -or
        ([string]$record.Msaa.WindowId -ne [string]$record.WindowId) -or
        (-not $record.Msaa.Refresh())) {
      throw "ref $ref is stale or its MSAA target changed; take a fresh snapshot/find"
    }
    return $record
  }
  if ($null -eq $record.Element) { throw "ref $ref is stale; take a fresh snapshot/find" }
  $el = $record.Element
  try {
    $top = New-Object IntPtr((Get-TopWindow $el).Current.NativeWindowHandle)
    $runtimeId = Get-ElRuntimeKey $el
    if ((-not [MixWin32]::IsWindowHandle($top)) -or
        ([MixWin32]::WindowId($top) -ne [string]$record.WindowId) -or
        ($runtimeId -ne [string]$record.RuntimeId)) {
      throw "ref $ref no longer identifies the same element"
    }
  } catch {
    throw "ref $ref is stale or its target changed; take a fresh snapshot/find"
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

function New-ActionResult($action, $path, $effect, $verified, $message, $code, $delivery, $windowId) {
  $accepted = $null -eq $code -and $path -ne 'none' -and $effect -ne 'suspected_noop'
  return @{
    text = $message
    action = $action
    path = $path
    effect = $effect
    verified = $verified
    delivery_accepted = $accepted
    goal_verified = $verified
    code = $code
    delivery = $delivery
    window_id = $windowId
  }
}

function Background-Unavailable($action, $message, $windowId, $code = 'background_unavailable') {
  return New-ActionResult $action 'none' 'suspected_noop' $false $message $code 'background' $windowId
}

function Invoke-BackgroundWindow($target, [scriptblock]$operation) {
  $foregroundBefore = [MixWin32]::Foreground()
  $result = $null
  try {
    $result = & $operation
  } finally {
    $foregroundAfter = [MixWin32]::Foreground()
    $targetTookFocus = $target -ne [IntPtr]::Zero -and (
      $foregroundAfter -eq $target -or
      [MixWin32]::IsContainedSameProcess($foregroundAfter, $target) -or
      [MixWin32]::IsOwnedBy($foregroundAfter, $target)
    )
    if (
      $foregroundBefore -ne [IntPtr]::Zero -and
      $foregroundBefore -ne $target -and
      [MixWin32]::IsWindowHandle($foregroundBefore) -and
      $targetTookFocus
    ) {
      [void][MixWin32]::Focus($foregroundBefore)
    }
  }
  return $result
}

function Invoke-BackgroundSemantic($ref, [scriptblock]$operation) {
  $record = Get-RefRecord $ref
  $target = Get-RefTopHandle $record
  return Invoke-BackgroundWindow $target $operation
}

function Native-BackgroundFailure($action, $exception, $windowId) {
  $detail = [string]$exception.Message
  $code = 'background_unavailable'
  foreach ($candidate in @(
    'background_target_hung',
    'background_blocked_uipi',
    'background_message_rejected',
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
  return Background-Unavailable $action $detail $windowId $code
}

function Get-ObservableElementState($el, $action) {
  if ($null -eq $el) { return $null }
  try {
    $parts = New-Object System.Collections.ArrayList
    $pat = $null
    if ($action -in @('click','double_click','right_click','middle_click','triple_click')) {
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
    if ($action -in @('key','type')) {
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
  } catch {
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
  } else {
    '; refresh state before treating it as complete'
  }
  $result = New-ActionResult $action 'win32_message' 'unverifiable' $false ($message + $suffix) $null 'background' $windowId
  $result.state_changed = $stateChanged
  return $result
}

function Do-Invoke($ref) {
  $record = Get-RefRecord $ref
  if ($record.Kind -eq 'msaa') {
    try {
      $defaultAction = [string]$record.Msaa.DefaultAction
      $record.Msaa.DoDefaultAction()
      return New-ActionResult 'invoke' 'msaa_default_action' 'unverifiable' $false "invoked $ref through MSAA default action: $defaultAction" $null 'background' $record.WindowId
    } catch {
      $message = 'MSAA default action failed for {0}: {1}' -f $ref, $_.Exception.Message
      return Background-Unavailable 'invoke' $message $record.WindowId 'msaa_action_failed'
    }
  }
  $el = $record.Element
  $pat = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pat)) {
    $before = [string]$pat.Current.ToggleState
    $pat.Toggle()
    $after = [string]$pat.Current.ToggleState
    $verified = $before -ne $after
    return New-ActionResult 'invoke' 'uia_toggle' $(if ($verified) { 'confirmed' } else { 'unverifiable' }) $verified "activated $ref through UIA toggle from $before to $after" $null 'background' ([MixWin32]::WindowId((New-Object IntPtr((Get-TopWindow $el).Current.NativeWindowHandle))))
  }
  $pat = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) {
    $pat.Invoke()
    return New-ActionResult 'invoke' 'uia_invoke' 'unverifiable' $false "invoked $ref through UIA" $null 'background' ([MixWin32]::WindowId((New-Object IntPtr((Get-TopWindow $el).Current.NativeWindowHandle))))
  }
  if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pat)) {
    $pat.Select()
    return New-ActionResult 'invoke' 'uia_selection' 'unverifiable' $false "selected $ref through UIA" $null 'background' ([MixWin32]::WindowId((New-Object IntPtr((Get-TopWindow $el).Current.NativeWindowHandle))))
  }
  $top = New-Object IntPtr((Get-TopWindow $el).Current.NativeWindowHandle)
  return Background-Unavailable 'invoke' "element $ref exposes no semantic toggle/invoke/select action; no physical fallback was attempted" ([MixWin32]::WindowId($top))
}

function Do-SetValue($ref, $text) {
  $record = Get-RefRecord $ref
  if ($record.Kind -eq 'msaa') {
    try {
      $actual = [string]$record.Msaa.SetValue([string]$text)
      $verified = $actual -eq [string]$text
      $effect = if ($verified) { 'confirmed' } else { 'unverifiable' }
      return New-ActionResult 'set_value' 'msaa_value' $effect $verified "set $ref value through MSAA; readback=$verified" $null 'background' $record.WindowId
    } catch {
      $message = 'MSAA value set failed for {0}: {1}' -f $ref, $_.Exception.Message
      return Background-Unavailable 'set_value' $message $record.WindowId 'msaa_value_failed'
    }
  }
  $el = $record.Element
  $pat = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pat)) {
    $pat.SetValue($text)
    $actual = ''
    for ($attempt = 0; $attempt -lt 8; $attempt++) {
      $actual = [string]$pat.Current.Value
      if ($actual -eq [string]$text) { break }
      Start-Sleep -Milliseconds 25
    }
    $verified = $actual -eq [string]$text
    $effect = if ($verified) { 'confirmed' } else { 'unverifiable' }
    return New-ActionResult 'set_value' 'uia_value' $effect $verified "set $ref value through UIA; readback=$verified" $null 'background' ([MixWin32]::WindowId((New-Object IntPtr((Get-TopWindow $el).Current.NativeWindowHandle))))
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
    $pat.Toggle()
    $after = $before
    for ($attempt = 0; $attempt -lt 10 -and $before -eq $after; $attempt++) {
      Start-Sleep -Milliseconds 25
      $freshPattern = $null
      try {
        if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$freshPattern)) {
          $after = $freshPattern.Current.ToggleState
        }
      } catch {}
    }
    $verified = $before -ne $after
    return New-ActionResult 'toggle' 'uia_toggle' $(if ($verified) { 'confirmed' } else { 'unverifiable' }) $verified "toggled $ref from $before to $after" $null 'background' ([MixWin32]::WindowId((New-Object IntPtr((Get-TopWindow $el).Current.NativeWindowHandle))))
  }
  $result = Do-Invoke $ref
  $result.action = 'toggle'
  return $result
}

# Nearest top-level ancestor (child of the desktop root) for an element.
function Get-TopWindow($el) {
  $cur = $el
  for ($i = 0; $i -lt 50; $i++) {
    $parent = $Walker.GetParent($cur)
    if ($null -eq $parent) { return $cur }
    if ([System.Windows.Automation.Automation]::Compare($parent, $AE::RootElement)) { return $cur }
    $cur = $parent
  }
  return $cur
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
    $x = [int]($record.Msaa.X + $record.Msaa.Width/2)
    $y = [int]($record.Msaa.Y + $record.Msaa.Height/2)
    $topHandle = [MixWin32]::ParseWindowId([string]$record.WindowId)
  } else {
    $el = $record.Element
    $r = $el.Current.BoundingRectangle
    if ([double]::IsInfinity($r.Width) -or $r.Width -le 0 -or $r.Height -le 0) { throw "element $ref has no clickable bounds" }
    $x = [int]($r.X + $r.Width/2)
    $y = [int]($r.Y + $r.Height/2)
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
  if ($req.ref) { return Get-ElPoint $req.ref ($req.delivery -eq 'foreground') }
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

# The user and the agent share one physical mouse and keyboard. Physical input
# within this window means the user is working, so foreground actions hold
# until the user pauses instead of fighting them for the cursor.
$UserInputIdleMs = 1500
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
# at the deadline.
function Wait-UserInputIdle {
  $started = [Environment]::TickCount
  while ($true) {
    $idle = Get-PhysicalInputIdleMs
    if ($idle -ge $UserInputIdleMs) { return [int]([Environment]::TickCount - $started) }
    if (([Environment]::TickCount - $started) -ge $UserInputWaitMaxMs) { return -1 }
    [System.Threading.Thread]::Sleep([math]::Max(100, [math]::Min(500, $UserInputIdleMs - $idle)))
  }
}

function New-UserInputActiveResult($action, $windowId) {
  $seconds = [math]::Round($UserInputWaitMaxMs / 1000)
  $message = 'the user is actively using the mouse or keyboard; ' + $action + ' waited ' + $seconds + 's and sent no input. Capture fresh state and retry once the user pauses'
  return New-ActionResult $action 'foreground' 'suspected_noop' $false $message 'user_input_active' 'foreground' $windowId
}

function Invoke-ForegroundInput($targetHandle, $action, $body, [bool]$pointerMayActivate = $false) {
  if (-not [MixWin32]::IsWindowHandle($targetHandle)) {
    return New-ActionResult $action 'foreground' 'suspected_noop' $false "$action target window is invalid" 'target_required' 'foreground' $null
  }
  $userWaitMs = Wait-UserInputIdle
  if ($userWaitMs -lt 0) {
    return New-UserInputActiveResult $action ([MixWin32]::WindowId($targetHandle))
  }
  $state = Get-CurrentSession
  $previous = [MixWin32]::Foreground()
  $cursor = [MixWin32]::Cursor()
  if ($state.OriginalFocus -eq [IntPtr]::Zero -and $previous -ne $targetHandle) {
    $state.OriginalFocus = $previous
  }
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
  try {
    & $body
    # SendKeys-based bodies bypass MixWin32, so stamp the injection here too.
    [MixWin32]::NoteInjection()
    # SendInput only enqueues events. Custom renderers such as Chromium consume
    # them asynchronously, so keep the target stable through a bounded settle.
    [System.Threading.Thread]::Sleep(240)
    $current = [MixWin32]::Foreground()
    if ($current -ne $previous -and [MixWin32]::IsWindowHandle($current)) {
      $state.LastFocus = $current
    } elseif ($current -eq $targetHandle) {
      $state.LastFocus = $targetHandle
    }
    $path = if ($focused) { 'foreground_sendinput' } else { 'foreground_pointer_activation' }
    $result = New-ActionResult $action $path 'unverifiable' $false "$action input dispatched; inspect the fresh capture before treating it as complete" $null 'foreground' ([MixWin32]::WindowId($targetHandle))
    $result.injection_tick = [MixWin32]::LastInjectionTick
    if ($userWaitMs -gt 0) { $result.user_wait_ms = $userWaitMs }
    return $result
  } finally {
    # A user who grabbed the mouse after dispatch owns the cursor now; putting
    # it back under their hand would be the very fight the idle wait avoids.
    if ((Get-PhysicalInputIdleMs) -ge $UserInputIdleMs) {
      [void][MixWin32]::SetCursorPos($cursor.x, $cursor.y)
      # Keep focus for a popup or keyboard follow-up; session_release restores
      # the original window once the bounded Computer Use chain is finished.
      [System.Threading.Thread]::Sleep(30)
      [void][MixWin32]::SetCursorPos($cursor.x, $cursor.y)
    }
  }
}

function Get-ModifierVks($modifiers) {
  if (-not $modifiers) { return @() }
  $vks = @()
  foreach ($part in ([string]$modifiers).ToLower().Split('+')) {
    switch ($part.Trim()) {
      'ctrl'  { $vks += 0x11 }
      'shift' { $vks += 0x10 }
      'alt'   { $vks += 0x12 }
      'win'   { $vks += 0x5B }
      'super' { $vks += 0x5B }
      ''      { }
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

function Do-ClickFamily($req, $kind) {
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
    try {
      $messageTarget = [MixWin32]::BackgroundPointer($target, $p[0], $p[1], $kind, $req.modifiers)
      $message = "$($req.action) delivered to $messageTarget as a native window message"
      return Complete-NativeAction $req.action $messageTarget ([MixWin32]::WindowId($target)) $before $refRecord $message
    } catch {
      return Native-BackgroundFailure $req.action $_.Exception ([MixWin32]::WindowId($target))
    }
  }
  return Invoke-ForegroundInput $target $req.action {
    if ($selectedHandle -ne [IntPtr]::Zero) {
      # Foreground delivery deliberately brings the exact target forward.
      # Revalidate only after that focus settles: checking before focus makes
      # every legitimately covered target impossible to operate.
      $focusedPointTarget = [MixWin32]::WindowAtPoint($p[0], $p[1])
      if (-not (Test-AllowedPointTarget $focusedPointTarget $selectedHandle $allowedWindowIds)) {
        throw 'target_mismatch|frame point remains covered after exact target focus'
      }
    }
    $vks = Get-ModifierVks $req.modifiers
    foreach ($vk in $vks) { [MixWin32]::KeyDown([System.UInt16]$vk) }
    try {
      switch ($kind) {
        'click'  { [MixWin32]::Click($p[0], $p[1]) }
        'double' { [MixWin32]::DoubleClick($p[0], $p[1]) }
        'right'  { [MixWin32]::RightClick($p[0], $p[1]) }
        'middle' { [MixWin32]::MiddleClick($p[0], $p[1]) }
        'triple' { [MixWin32]::TripleClick($p[0], $p[1]) }
        'move'   { [void][MixWin32]::SetCursorPos($p[0], $p[1]) }
      }
    } finally {
      for ($i = $vks.Count - 1; $i -ge 0; $i--) { [MixWin32]::KeyUp([System.UInt16]$vks[$i]) }
    }
  } $true
}

function Do-MouseMove($req) {
  return Do-ClickFamily $req 'move'
}

function Do-Wait($req) {
  $s = if ($null -ne $req.duration) { [double]$req.duration } else { 1 }
  if ($s -lt 0 -or $s -gt 30) { throw 'wait duration must be 0..30 seconds' }
  Start-Sleep -Milliseconds ([int]($s * 1000))
  return @{ text = ('waited ' + $s + 's') }
}

function Do-Drag($req) {
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
        $messageTarget = [MixWin32]::BackgroundDrag(
          $info.Handle, $x1, $y1, $x2, $y2, $req.modifiers)
        return New-ActionResult 'drag' 'win32_message' 'unverifiable' $false "drag delivered to $messageTarget as native window messages; refresh state before treating it as complete" $null 'background' $info.Id
      } catch {
        return Native-BackgroundFailure 'drag' $_.Exception $info.Id
      }
    }
    return Invoke-ForegroundInput $info.Handle 'drag' {
      [MixWin32]::Drag($x1, $y1, $x2, $y2)
    } $true
  }
  if (-not $req.to) { throw 'drag requires to (destination ref)' }
  $refRecord = Get-RefRecord $req.ref
  $before = Get-ObservableTargetState $refRecord 'drag'
  $foreground = $req.delivery -eq 'foreground'
  $a = Get-ElPoint $req.ref $foreground
  $b = Get-ElPoint $req.to $foreground
  if ($a[2] -ne $b[2]) {
    return New-ActionResult 'drag' 'none' 'suspected_noop' $false 'drag endpoints belong to different windows' 'target_mismatch' $req.delivery $null
  }
  if ($req.delivery -ne 'foreground') {
    try {
      $messageTarget = [MixWin32]::BackgroundDrag($a[2], $a[0], $a[1], $b[0], $b[1], $req.modifiers)
      return Complete-NativeAction 'drag' $messageTarget ([MixWin32]::WindowId($a[2])) $before $refRecord "drag delivered to $messageTarget as native window messages"
    } catch {
      return Native-BackgroundFailure 'drag' $_.Exception ([MixWin32]::WindowId($a[2]))
    }
  }
  return Invoke-ForegroundInput $a[2] 'drag' {
    [MixWin32]::Drag($a[0], $a[1], $b[0], $b[1])
  } $true
}

function Do-Scroll($req) {
  $direction = ([string]$req.direction).ToLower()
  $amount = if ($null -ne $req.amount) {
    [math]::Max(1, [math]::Min(100, [math]::Abs([int]$req.amount)))
  } elseif ($null -ne $req.dy) {
    [math]::Max(1, [math]::Min(100, [math]::Abs([int]$req.dy)))
  } else { 3 }
  $horizontal = $direction -in @('left','right')
  $amt = if ($direction -in @('up','left')) {
    -$amount
  } elseif ($direction -in @('down','right')) {
    $amount
  } elseif ($null -ne $req.dy -and [int]$req.dy -lt 0) {
    -$amount
  } else {
    $amount
  }
  $wheelClicks = if ($horizontal) { $amt } else { -$amt }
  if ($null -ne $req.x -or $null -ne $req.y) {
    if ($null -eq $req.x -or $null -eq $req.y) { throw 'coordinate scroll requires x and y from frame_id' }
    if (-not $req.window_id -and -not $req.window) {
      return Background-Unavailable 'scroll' 'coordinate scroll requires an exact window_id-bound frame' $null 'target_required'
    }
    $info = Resolve-WindowInfo $req.window $req.window_id
    $x = [int]$req.x; $y = [int]$req.y
    if ($req.delivery -ne 'foreground') {
      try {
        $messageTarget = [MixWin32]::BackgroundWheel(
          $info.Handle, $x, $y, $wheelClicks, $req.modifiers, $horizontal)
        return New-ActionResult 'scroll' 'win32_message' 'unverifiable' $false "scrolled $direction at frame point through native window messages; refresh state before treating it as complete" $null 'background' $info.Id
      } catch {
        return Native-BackgroundFailure 'scroll' $_.Exception $info.Id
      }
    }
    return Invoke-ForegroundInput $info.Handle 'scroll' {
      [void][MixWin32]::SetCursorPos($x, $y)
      if ($horizontal) { [MixWin32]::MouseHWheel($wheelClicks) }
      else { [MixWin32]::MouseWheel($wheelClicks) }
    } $true
  }
  if ($req.ref) {
    $refRecord = Get-RefRecord $req.ref
    if ($refRecord.Kind -eq 'uia') {
      $el = $refRecord.Element
      $pat = $null
      # Background path: ScrollPattern scrolls without touching mouse or focus.
      if ($el.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$pat)) {
        $before = if ($horizontal) { $pat.Current.HorizontalScrollPercent } else { $pat.Current.VerticalScrollPercent }
        $dir = if ($amt -gt 0) { [System.Windows.Automation.ScrollAmount]::SmallIncrement } else { [System.Windows.Automation.ScrollAmount]::SmallDecrement }
        $n = [math]::Min([math]::Abs($amt) * 3, 30)
        for ($i = 0; $i -lt $n; $i++) {
          if ($horizontal) {
            if (-not $pat.Current.HorizontallyScrollable) { break }
            $pat.Scroll($dir, [System.Windows.Automation.ScrollAmount]::NoAmount)
          } else {
            if (-not $pat.Current.VerticallyScrollable) { break }
            $pat.Scroll([System.Windows.Automation.ScrollAmount]::NoAmount, $dir)
          }
        }
        $after = if ($horizontal) { $pat.Current.HorizontalScrollPercent } else { $pat.Current.VerticalScrollPercent }
        $verified = $before -ne $after
        return New-ActionResult 'scroll' 'uia_scroll' $(if ($verified) { 'confirmed' } else { 'unverifiable' }) $verified "scrolled $($req.ref) $direction $n increments through UIA" $null 'background' ([MixWin32]::WindowId((New-Object IntPtr((Get-TopWindow $el).Current.NativeWindowHandle))))
      }
    }
    if ($req.delivery -ne 'foreground') {
      $p = Get-ElPoint $req.ref $false
      $before = Get-ObservableTargetState $refRecord 'scroll'
      try {
        $messageTarget = [MixWin32]::BackgroundWheel($p[2], $p[0], $p[1], $wheelClicks, $req.modifiers, $horizontal)
        return Complete-NativeAction 'scroll' $messageTarget ([MixWin32]::WindowId($p[2])) $before $refRecord "scroll delivered to $messageTarget as a native window message"
      } catch {
        return Native-BackgroundFailure 'scroll' $_.Exception ([MixWin32]::WindowId($p[2]))
      }
    }
    $p = Get-ElPoint $req.ref
    return Invoke-ForegroundInput $p[2] 'scroll' {
      [void][MixWin32]::SetCursorPos($p[0], $p[1])
      if ($horizontal) { [MixWin32]::MouseHWheel($wheelClicks) }
      else { [MixWin32]::MouseWheel($wheelClicks) }
    } $true
  }
  if ($req.delivery -ne 'foreground') {
    if (-not $req.window_id -and -not $req.window) {
      return Background-Unavailable 'scroll' 'background scroll requires an exact ref or window_id' $null 'target_required'
    }
    $info = Resolve-WindowInfo $req.window $req.window_id
    $x = [int]($info.X + $info.Width/2)
    $y = [int]($info.Y + $info.Height/2)
    try {
      $messageTarget = [MixWin32]::BackgroundWheel($info.Handle, $x, $y, $wheelClicks, $req.modifiers, $horizontal)
      return New-ActionResult 'scroll' 'win32_message' 'unverifiable' $false "scroll delivered to $messageTarget as a native window message; refresh state before treating it as complete" $null 'background' $info.Id
    } catch {
      return Native-BackgroundFailure 'scroll' $_.Exception $info.Id
    }
  }
  $info = Resolve-WindowInfo $req.window $req.window_id
  return Invoke-ForegroundInput $info.Handle 'scroll' {
    $x = [int]($info.X + $info.Width/2)
    $y = [int]($info.Y + $info.Height/2)
    [void][MixWin32]::SetCursorPos($x, $y)
    if ($horizontal) { [MixWin32]::MouseHWheel($wheelClicks) }
    else { [MixWin32]::MouseWheel($wheelClicks) }
  } $true
}

function Do-Focus($req) {
  $info = Resolve-WindowInfo $req.window $req.window_id
  if ((Wait-UserInputIdle) -lt 0) {
    return New-UserInputActiveResult 'focus_window' $info.Id
  }
  $state = Get-CurrentSession
  $previous = [MixWin32]::Foreground()
  if ($state.OriginalFocus -eq [IntPtr]::Zero -and $previous -ne $info.Handle) {
    $state.OriginalFocus = $previous
  }
  if (-not [MixWin32]::Focus($info.Handle)) {
    return New-ActionResult 'focus_window' 'foreground' 'suspected_noop' $false "could not bring window to foreground: $($info.Title)" 'foreground_unavailable' 'foreground' $info.Id
  }
  $state.LastFocus = $info.Handle
  return New-ActionResult 'focus_window' 'foreground' 'confirmed' $true "focused: $($info.Title)" $null 'foreground' $info.Id
}

function Get-WindowBounds($req) {
  $info = Resolve-WindowInfo $req.window $req.window_id
  if ($info.Width -le 0 -or $info.Height -le 0) {
    throw "window has no capturable bounds: $($info.Id)"
  }
  return @{
    text = ('window bounds: ' + $info.Title)
    title = $info.Title
    window_id = $info.Id
    owner_id = $info.OwnerId
    x = $info.X
    y = $info.Y
    width = $info.Width
    height = $info.Height
    client_x = $info.ClientX
    client_y = $info.ClientY
    client_width = $info.ClientWidth
    client_height = $info.ClientHeight
    related_window_ids = @([MixWin32]::RelatedWindowIds($info.Handle))
  }
}

# Read-only predicate state. Deliberately does NOT touch the session ref map or
# generation: waiting for a condition must never invalidate the refs the caller
# is holding from its last capture.
function Get-WindowPredicates($req) {
  try {
    $info = Resolve-WindowInfo $req.window $req.window_id
  } catch {
    $detail = [string]$_.Exception.Message
    $isAbsent = $detail.StartsWith('window_id is stale or invalid:') -or
      $detail.StartsWith('foreground window not found') -or
      $detail.StartsWith('window not found:')
    if (-not $isAbsent) { throw }
    return @{
      text = 'window predicate state: absent'
      window_id = if ($req.window_id) { [string]$req.window_id } else { $null }
      title = ''
      exists = $false
      returned = 0
      elements = @()
    }
  }
  if ($req.include_elements -eq $false) {
    return @{
      text = ('window predicate state: ' + $info.Title)
      window_id = $info.Id
      title = [string]$info.Title
      exists = $true
      returned = 0
      elements = @()
    }
  }
  $win = Find-Window $req.window $req.window_id
  $max = if ($null -ne $req.max_elements) { [int]$req.max_elements } else { 400 }
  if ($max -lt 1 -or $max -gt 1000) { throw 'max_elements must be 1..1000' }
  $ctTypes = @('Button','Edit','CheckBox','RadioButton','ComboBox','List','ListItem','MenuItem',
    'TabItem','Hyperlink','TreeItem','Slider','Document','Spinner','SplitButton','Text',
    'StatusBar','ProgressBar')
  $conds = foreach ($t in $ctTypes) {
    New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::$t)
  }
  $cond = New-Object System.Windows.Automation.OrCondition([System.Windows.Automation.Condition[]]$conds)
  $cr = New-Object System.Windows.Automation.CacheRequest
  [void]$cr.Add($AE::NameProperty)
  [void]$cr.Add($AE::ControlTypeProperty)
  [void]$cr.Add($AE::IsEnabledProperty)
  [void]$cr.Add($AE::IsOffscreenProperty)
  $act = $cr.Activate()
  try { $els = $win.FindAll($TS::Descendants, $cond) } finally { $act.Dispose() }
  $observations = New-Object System.Collections.ArrayList
  foreach ($el in $els) {
    if ($observations.Count -ge $max) { break }
    if ($el.Cached.IsOffscreen) { continue }
    $ct = $el.Cached.ControlType.ProgrammaticName -replace 'ControlType\.',''
    $name = ''
    try { $name = [string]$el.Cached.Name } catch {}
    $value = ''
    if (@('Edit','ComboBox','Document','Spinner') -contains $ct) {
      $pat = $null
      try {
        if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pat)) {
          $value = [string]$pat.Current.Value
        }
      } catch {}
    }
    if ([string]::IsNullOrWhiteSpace($name) -and [string]::IsNullOrWhiteSpace($value)) { continue }
    [void]$observations.Add([ordered]@{
      role = [string]$ct
      name = (Format-ObservationValue $name 200)
      value = (Format-ObservationValue $value 200)
      enabled = [bool]$el.Cached.IsEnabled
    })
  }
  if ($observations.Count -lt $max) {
    $msaaLimit = [Math]::Min(5000, [Math]::Max(100, $max * 5))
    try {
      $msaaNodes = @([MixMsaa]::Snapshot($info.Handle, $info.Id, $msaaLimit))
    } catch {
      $msaaNodes = @()
    }
    foreach ($node in $msaaNodes) {
      if ($observations.Count -ge $max) { break }
      if (-not $node.Refresh() -or $node.Width -le 0 -or $node.Height -le 0) { continue }
      $msaaName = [string]$node.Name
      $msaaValue = [string]$node.Value
      if ([string]::IsNullOrWhiteSpace($msaaName) -and [string]::IsNullOrWhiteSpace($msaaValue)) { continue }
      [void]$observations.Add([ordered]@{
        role = (Format-ObservationValue ([string]$node.ControlType) 100)
        name = (Format-ObservationValue $msaaName 200)
        value = (Format-ObservationValue $msaaValue 200)
        enabled = [bool]$node.Enabled
      })
    }
  }
  return @{
    text = ('window predicate state: ' + $info.Title)
    window_id = $info.Id
    title = [string]$info.Title
    exists = $true
    returned = $observations.Count
    elements = @($observations)
  }
}

# Menu entries by exact label, with the accelerator ampersand removed. Menus are
# resolved one live level at a time and never fall back to pixels.
function Get-MenuCandidates($root, $name) {
  $wanted = (([string]$name) -replace '&','').Trim().ToLower()
  $types = @('MenuItem','Button','SplitButton','ListItem')
  $conds = foreach ($t in $types) {
    New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::$t)
  }
  $cond = New-Object System.Windows.Automation.OrCondition([System.Windows.Automation.Condition[]]$conds)
  $found = New-Object System.Collections.ArrayList
  $elements = @()
  try {
    $elements = @($root.FindAll($TS::Descendants, $cond))
  } catch {
    # UIA providers can disappear between capture and invocation. An empty UIA
    # candidate set lets the exact MSAA fallback inspect the same target.
    return @()
  }
  foreach ($el in $elements) {
    $label = ''
    try { $label = [string]$el.Current.Name } catch {}
    if ((($label -replace '&','').Trim().ToLower()) -eq $wanted) { [void]$found.Add($el) }
  }
  return @($found)
}

function Get-MsaaMenuCandidates($info, $name) {
  $wanted = (([string]$name) -replace '&','').Trim().ToLower()
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
      $nodes = @([MixMsaa]::Snapshot($handle, $targetInfo.Id, 5000))
    } catch {
      continue
    }
    foreach ($node in $nodes) {
      if (-not $node.Refresh() -or -not $node.Enabled) { continue }
      if ([string]$node.ControlType -notin @('MenuItem','Button','SplitButton','ListItem')) { continue }
      $label = (([string]$node.Name) -replace '&','').Trim().ToLower()
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
    if ([string]$pat.Current.ExpandCollapseState -ne 'Expanded') { $pat.Expand() }
    return $true
  }
  $pat = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) {
    $pat.Invoke()
    return $true
  }
  return $false
}

function Do-InvokeMenu($req) {
  $info = Resolve-WindowInfo $req.window $req.window_id
  return Invoke-BackgroundWindow $info.Handle {
    $win = Find-Window $req.window $req.window_id
    $path = @(@($req.path) | ForEach-Object { [string]$_ } | Where-Object { $_.Trim().Length -gt 0 })
    if ($path.Count -lt 1 -or $path.Count -gt 8) { throw 'menu path must have 1..8 segments' }
    $root = $win
    $walked = @()
    for ($i = 0; $i -lt $path.Count; $i++) {
      $segment = $path[$i]
      # Native applications usually expose menu state through MSAA immediately.
      # Use that exact path before asking UIA to walk an entire provider tree.
      $msaaCandidates = Get-MsaaMenuCandidates $info $segment
      if ($msaaCandidates.Count -gt 1) {
        throw "menu_path_ambiguous: '$segment' matched $($msaaCandidates.Count) entries; use a more exact path"
      }
      if ($msaaCandidates.Count -eq 1) {
        $walked += $segment
        try {
          $msaaCandidates[0].DoDefaultAction()
        } catch {
          $code = if ($i -eq $path.Count - 1) {
            'menu_item_not_invokable'
          } else {
            'menu_expand_unavailable'
          }
          throw "$($code): '$segment' MSAA default action failed: $($_.Exception.Message)"
        }
        if ($i -eq $path.Count - 1) {
          return New-ActionResult 'invoke_menu' 'msaa_menu' 'unverifiable' $false ('invoked menu path: ' + ($walked -join ' > ')) $null 'background' $info.Id
        }
        Start-Sleep -Milliseconds 120
        $root = $win
        continue
      }
      $candidates = Get-MenuCandidates $root $segment
      if ($candidates.Count -eq 0 -and $i -gt 0) {
        # An opened submenu is often a popup window owned by the app rather than a
        # child of the item that opened it. Only one menu can be open at a time.
        $candidates = Get-MenuCandidates ($AE::RootElement) $segment
      }
      if ($candidates.Count -eq 0) {
        throw "menu_path_not_found: no enabled menu entry named '$segment' after $($walked -join ' > ')"
      }
      if ($candidates.Count -gt 1) {
        throw "menu_path_ambiguous: '$segment' matched $($candidates.Count) entries; use a more exact path"
      }
      $el = $candidates[0]
      $enabled = $true
      try { $enabled = [bool]$el.Current.IsEnabled } catch {}
      if (-not $enabled) { throw "menu_item_disabled: '$segment' is disabled" }
      $walked += $segment
      if ($i -eq $path.Count - 1) {
        $pat = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) {
          $pat.Invoke()
          return New-ActionResult 'invoke_menu' 'uia_menu' 'unverifiable' $false ('invoked menu path: ' + ($walked -join ' > ')) $null 'background' $info.Id
        }
        $pat = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pat)) {
          $before = [string]$pat.Current.ToggleState
          $pat.Toggle()
          $after = [string]$pat.Current.ToggleState
          $verified = $before -ne $after
          return New-ActionResult 'invoke_menu' 'uia_menu_toggle' $(if ($verified) { 'confirmed' } else { 'unverifiable' }) $verified ('toggled menu path: ' + ($walked -join ' > ') + " from $before to $after") $null 'background' $info.Id
        }
        throw "menu_item_not_invokable: '$segment' exposes no menu action"
      }
      if (-not (Expand-MenuElement $el)) {
        throw "menu_expand_unavailable: '$segment' cannot be opened through accessibility"
      }
      Start-Sleep -Milliseconds 120
      $root = $el
    }
  }
}

`;
