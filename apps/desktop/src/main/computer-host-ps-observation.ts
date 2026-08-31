/**
 * Observation: window listing, the bounded UIA/MSAA tree walk, element formatting, and the snapshot a capture is built from.
 *
 * PowerShell source for the resident Computer Use worker. It is one program
 * split by capability; the pieces are joined in file order, so a line here
 * keeps the meaning it had in the whole.
 */
export const PS_OBSERVATION = String.raw`
function Do-ListWindows {
  $lines = New-Object System.Collections.ArrayList
  $windows = New-Object System.Collections.ArrayList
  foreach ($info in [MixWin32]::Windows()) {
    $focus = if ($info.Focused) { ' focused' } else { '' }
    $state = if ($info.Minimized) { ' minimized' } elseif ($info.Maximized) { ' maximized' } else { '' }
    $owner = if ($info.OwnerId) { " owner=$($info.OwnerId)" } else { '' }
    $title = if ($info.Title) { $info.Title } else { '<untitled>' }
    [void]$lines.Add(('{0} | app={1} pid={2} class={3}{4}{5}{6} | "{7}" | {8}x{9} at {10},{11}' -f
      $info.Id, $info.App, $info.Pid, $info.ClassName, $owner, $focus, $state, $title,
      $info.Width, $info.Height, $info.X, $info.Y))
    [void]$windows.Add([ordered]@{
      id = [string]$info.Id
      title = [string]$info.Title
      class_name = [string]$info.ClassName
      app = [string]$info.App
      pid = [long]$info.Pid
      owner_id = [string]$info.OwnerId
      focused = [bool]$info.Focused
      minimized = [bool]$info.Minimized
      maximized = [bool]$info.Maximized
      x = [int]$info.X
      y = [int]$info.Y
      width = [int]$info.Width
      height = [int]$info.Height
    })
  }
  if ($lines.Count -eq 0) { return @{ text = 'No windows found.'; windows = @() } }
  return @{
    text = ('Windows:' + [Environment]::NewLine + ($lines -join [Environment]::NewLine))
    windows = @($windows)
  }
}

function Do-WindowSnapshot {
  $windows = New-Object System.Collections.ArrayList
  foreach ($info in [MixWin32]::WindowSnapshot()) {
    [void]$windows.Add([ordered]@{
      id = [string]$info.Id
      title = [string]$info.Title
      class_name = [string]$info.ClassName
      app = ''
      pid = [long]$info.Pid
      owner_id = [string]$info.OwnerId
      focused = [bool]$info.Focused
      minimized = [bool]$info.Minimized
      maximized = [bool]$info.Maximized
      x = [int]$info.X
      y = [int]$info.Y
      width = [int]$info.Width
      height = [int]$info.Height
    })
  }
  return @{ windows = @($windows) }
}

function Do-RelatedWindows($req) {
  $info = Resolve-WindowInfo $req.window $req.window_id
  return @{ window_ids = @([MixWin32]::RelatedWindowIds($info.Handle)) }
}

function Get-ContinuationFingerprint($value) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$value)
    $hash = $sha.ComputeHash($bytes)
    return ([System.BitConverter]::ToString($hash).Replace('-','').Substring(0,16).ToLower())
  } finally {
    $sha.Dispose()
  }
}

function Get-ElementPage($total, $offset, $max, $generation, $fingerprint) {
  $end = [math]::Min([int]$total, [int]$offset + [int]$max)
  return @{
    End = $end
    Continuation = $(if ($end -lt [int]$total) {
      '{0}:{1}:{2}:{3}' -f $generation, $end, $fingerprint, $total
    } else { $null })
  }
}

function Format-ObservationValue($value, $maximum = 120) {
  $text = ([string]$value) -replace '[\r\n\t]+',' '
  $text = $text.Replace('"', "'").Trim()
  if ($text.Length -gt [int]$maximum) { return $text.Substring(0, [int]$maximum) }
  return $text
}

function Get-ElementObservation($el) {
  $observation = @{
    Name = [string]$el.Cached.Name
    AutomationId = [string]$el.Cached.AutomationId
    Value = ''
    Toggle = ''
    Selected = ''
    Expanded = ''
    Range = ''
    CanInvoke = $false
    CanSetValue = $false
    CanToggle = $false
    CanScroll = $false
  }
  $pat = $null
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pat)) {
      $observation.Value = [string]$pat.Current.Value
      $observation.CanSetValue = $true
    }
  } catch {}
  $pat = $null
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pat)) {
      $observation.Toggle = [string]$pat.Current.ToggleState
      $observation.CanToggle = $true
    }
  } catch {}
  $pat = $null
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pat)) {
      $observation.Selected = [string]$pat.Current.IsSelected
    }
  } catch {}
  $pat = $null
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pat)) {
      $observation.Expanded = [string]$pat.Current.ExpandCollapseState
    }
  } catch {}
  $pat = $null
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern, [ref]$pat)) {
      $observation.Range = [string]$pat.Current.Value
    }
  } catch {}
  $pat = $null
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pat) -or
        $el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pat)) {
      $observation.CanInvoke = $true
    }
  } catch {}
  $pat = $null
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$pat)) {
      $observation.CanScroll = $true
    }
  } catch {}
  return [pscustomobject]$observation
}

function Get-MsaaObservation($node) {
  return [pscustomobject]@{
    Name = [string]$node.Name
    AutomationId = ''
    Value = [string]$node.Value
    Toggle = ''
    Selected = ''
    Expanded = ''
    Range = ''
    CanInvoke = -not [string]::IsNullOrWhiteSpace([string]$node.DefaultAction)
    CanSetValue = [string]$node.ControlType -in @('Edit','ComboBox')
    CanToggle = $false
    CanScroll = $false
    Source = 'msaa'
    Role = [string]$node.Role
    State = [string]$node.State
    DefaultAction = [string]$node.DefaultAction
  }
}

function Format-StructuredObservationState($observation, $kind) {
  if ($kind -eq 'msaa') {
    return Format-ObservationValue $observation.State 200
  }
  $parts = New-Object System.Collections.ArrayList
  if ($observation.Toggle) { [void]$parts.Add('toggle=' + $observation.Toggle) }
  if ($observation.Selected) { [void]$parts.Add('selected=' + $observation.Selected) }
  if ($observation.Expanded) { [void]$parts.Add('expanded=' + $observation.Expanded) }
  if ($observation.Range) { [void]$parts.Add('range=' + $observation.Range) }
  return ($parts -join ';')
}

function Get-ElementStructure($el) {
  $ancestors = New-Object System.Collections.ArrayList
  $parentRuntimeId = ''
  $inDocument = $false
  $parent = $Walker.GetParent($el)
  for ($depth = 0; $depth -lt 80 -and $null -ne $parent; $depth++) {
    if ([System.Windows.Automation.Automation]::Compare($parent, $AE::RootElement)) { break }
    $role = ''
    $name = ''
    try { $role = $parent.Current.ControlType.ProgrammaticName -replace 'ControlType\.','' } catch {}
    try { $name = [string]$parent.Current.Name } catch {}
    $runtimeId = Get-ElRuntimeKey $parent
    if ($depth -eq 0) { $parentRuntimeId = $runtimeId }
    if ($role -eq 'Document') { $inDocument = $true }
    [void]$ancestors.Add([ordered]@{
      runtime_id = [string]$runtimeId
      role = [string]$role
      name = (Format-ObservationValue $name 200)
    })
    $parent = $Walker.GetParent($parent)
  }
  $className = ''
  $hasKeyboardFocus = $false
  try { $className = [string]$el.Current.ClassName } catch {}
  try { $hasKeyboardFocus = [bool]$el.Current.HasKeyboardFocus } catch {}
  return [ordered]@{
    runtime_id = [string](Get-ElRuntimeKey $el)
    parent_runtime_id = [string]$parentRuntimeId
    class_name = [string]$className
    has_keyboard_focus = [bool]$hasKeyboardFocus
    in_document = [bool]$inDocument
    ancestors = @($ancestors)
  }
}

function Snapshot-Window($req) {
  $snapshotClock = [System.Diagnostics.Stopwatch]::StartNew()
  $info = Resolve-WindowInfo $req.window $req.window_id
  $win = Find-Window $req.window $req.window_id
  $state = Get-CurrentSession
  $expectedContinuation = $state.Continuation
  $state.Continuation = $null
  $state.Generation = [int]$state.Generation + 1
  $state.Map.Clear()
  $generation = $state.Generation
  $visibleOnly = if ($null -ne $req.visible_only) { [bool]$req.visible_only } else { $true }
  $includeNoninteractive = $null -ne $req.include_noninteractive -and [bool]$req.include_noninteractive
  $includeStructure = $null -ne $req.include_structure -and [bool]$req.include_structure
  $bounded = $null -ne $req.bounded -and [bool]$req.bounded
  $max = if ($null -ne $req.max_elements) { [int]$req.max_elements } else { 200 }
  if ($max -lt 1 -or $max -gt 1000) { throw 'max_elements must be 1..1000' }
  $query = ([string]$req.query).Trim().ToLower()
  $role = ([string]$req.role).Trim().ToLower()
  $fingerprintInput = ConvertTo-Json -Compress -InputObject @(
    $info.Id, $max, $visibleOnly, $includeNoninteractive, $includeStructure,
    $bounded, $query, $role
  )
  $continuationFingerprint = Get-ContinuationFingerprint $fingerprintInput
  $offset = 0
  $continuationTotal = $null
  if ($req.continuation) {
    $parts = ([string]$req.continuation).Split(':')
    [int]$tokenGeneration = 0
    [int]$tokenOffset = 0
    [int]$tokenTotal = 0
    $valid = $parts.Count -eq 4 -and
      [int]::TryParse($parts[0], [ref]$tokenGeneration) -and
      [int]::TryParse($parts[1], [ref]$tokenOffset) -and
      [int]::TryParse($parts[3], [ref]$tokenTotal) -and
      $tokenGeneration -eq ($generation - 1) -and
      $tokenOffset -ge 0 -and
      $tokenTotal -ge 0 -and
      $tokenOffset -le $tokenTotal -and
      [string]$expectedContinuation -eq [string]$req.continuation -and
      $parts[2] -eq $continuationFingerprint
    if (-not $valid) {
      throw 'continuation is stale or incompatible; capture the first page again'
    }
    $offset = $tokenOffset
    $continuationTotal = $tokenTotal
  }
  # Fetch the selected control classes once with cached properties, then filter
  # and page locally. The broader observation view is explicit so ordinary
  # snapshots do not flood the model with layout-only nodes.
  $interactiveCtTypes = @('Button','Edit','CheckBox','RadioButton','ComboBox','List','ListItem',
    'MenuItem','TabItem','Hyperlink','Tree','TreeItem','Slider','Document','Spinner','SplitButton')
  $ctTypes = @($interactiveCtTypes)
  if ($includeNoninteractive) {
    $ctTypes += @('Text','Custom','Group','Pane','Image','DataGrid','DataItem','Header',
      'HeaderItem','Table','ProgressBar','StatusBar','ToolBar','TitleBar','Separator')
  }
  $ctTypes = @($ctTypes | Select-Object -Unique)
  $conds = foreach ($t in $ctTypes) {
    New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::$t)
  }
  $cond = New-Object System.Windows.Automation.OrCondition([System.Windows.Automation.Condition[]]$conds)
  $cr = New-Object System.Windows.Automation.CacheRequest
  [void]$cr.Add($AE::NameProperty)
  [void]$cr.Add($AE::AutomationIdProperty)
  [void]$cr.Add($AE::ControlTypeProperty)
  [void]$cr.Add($AE::BoundingRectangleProperty)
  [void]$cr.Add($AE::IsEnabledProperty)
  [void]$cr.Add($AE::IsOffscreenProperty)
  $act = $cr.Activate()
  $uiaFindStarted = $snapshotClock.Elapsed.TotalMilliseconds
  try { $els = $win.FindAll($TS::Descendants, $cond) } finally { $act.Dispose() }
  $uiaFindMs = $snapshotClock.Elapsed.TotalMilliseconds - $uiaFindStarted
  if ($els.Count -gt 5000) {
    throw "accessibility candidate limit exceeded: $($els.Count) > 5000; narrow the role/query or use the interactive view"
  }
  $matches = New-Object System.Collections.ArrayList
  $seen = @{}
  $uiaFormatStarted = $snapshotClock.Elapsed.TotalMilliseconds
  foreach ($el in $els) {
    $r = $el.Cached.BoundingRectangle
    if ([double]::IsInfinity($r.Width) -or $r.Width -le 0 -or $r.Height -le 0) { continue }
    if ($visibleOnly) {
      if ($el.Cached.IsOffscreen) { continue }
      if ($r.X + $r.Width -le $info.X -or $r.X -ge $info.X + $info.Width -or
          $r.Y + $r.Height -le $info.Y -or $r.Y -ge $info.Y + $info.Height) { continue }
    }
    $ct = $el.Cached.ControlType.ProgrammaticName -replace 'ControlType\.',''
    if ($role -and $ct.ToLower() -ne $role) { continue }
    $observation = Get-ElementObservation $el
    $search = @(
      $observation.Name
      $observation.AutomationId
      $observation.Value
      $ct
    ) -join ' '
    if ($query -and -not $search.ToLower().Contains($query)) { continue }
    $dedupeKey = '{0}|{1}|{2}|{3}|{4}|{5}' -f
      [math]::Round($r.X), [math]::Round($r.Y), [math]::Round($r.Width), [math]::Round($r.Height),
      ([string]$observation.Name).ToLower(), $ct.ToLower()
    $record = @{
      Kind = 'uia'
      Element = $el
      Observation = $observation
      ControlType = $ct
      X = [double]$r.X
      Y = [double]$r.Y
      Width = [double]$r.Width
      Height = [double]$r.Height
      Enabled = [bool]$el.Cached.IsEnabled
      DedupeKey = $dedupeKey
    }
    [void]$matches.Add($record)
    $seen[$dedupeKey] = $record
  }
  $uiaFormatMs = $snapshotClock.Elapsed.TotalMilliseconds - $uiaFormatStarted
  $candidateCount = $els.Count
  $msaaWarning = ''
  $msaaSnapshotStarted = $snapshotClock.Elapsed.TotalMilliseconds
  $msaaMaximum = if ($bounded) {
    [math]::Min(5000, [math]::Max(200, ([int]$offset + [int]$max) * 8))
  } else {
    5000
  }
  $modernChromium = ([string]$info.ClassName) -like 'Chrome_WidgetWin*'
  if ($bounded -and ($matches.Count -gt 0 -or $modernChromium)) {
    $msaaNodes = @()
    $msaaWarning = if ($matches.Count -gt 0) {
      'MSAA enrichment skipped: UIA supplied the bounded capture'
    } else {
      'MSAA enrichment skipped: Chromium capture will use pixels or OCR'
    }
  } else {
    try {
      $msaaNodes = @([MixMsaa]::Snapshot($info.Handle, $info.Id, $msaaMaximum))
    } catch {
      throw "MSAA snapshot failed for $($info.Id): $([string]$_.Exception.Message)"
    }
  }
  $msaaSnapshotMs = $snapshotClock.Elapsed.TotalMilliseconds - $msaaSnapshotStarted
  $candidateCount += $msaaNodes.Count
  if ($candidateCount -gt 5000) {
    throw "accessibility candidate limit exceeded: $candidateCount > 5000; narrow the role/query"
  }
  foreach ($node in $msaaNodes) {
    if (-not $node.Refresh()) { continue }
    if ($visibleOnly) {
      if ($node.Offscreen) { continue }
      if ($node.X + $node.Width -le $info.X -or $node.X -ge $info.X + $info.Width -or
          $node.Y + $node.Height -le $info.Y -or $node.Y -ge $info.Y + $info.Height) { continue }
    }
    $ct = [string]$node.ControlType
    if ($ct -in @('Window','Client')) { continue }
    if (-not $includeNoninteractive -and -not ($interactiveCtTypes -contains $ct)) { continue }
    if ($role -and $ct.ToLower() -ne $role) { continue }
    $observation = Get-MsaaObservation $node
    $search = @(
      $observation.Name
      $observation.Value
      $observation.Role
      $observation.State
      $observation.DefaultAction
      $ct
    ) -join ' '
    if ($query -and -not $search.ToLower().Contains($query)) { continue }
    $dedupeKey = '{0}|{1}|{2}|{3}|{4}|{5}' -f
      $node.X, $node.Y, $node.Width, $node.Height,
      ([string]$node.Name).ToLower(), $ct.ToLower()
    $existing = $seen[$dedupeKey]
    $addsCapability = $null -ne $existing -and (
      ($observation.CanInvoke -and -not $existing.Observation.CanInvoke) -or
      ($observation.CanSetValue -and -not $existing.Observation.CanSetValue)
    )
    if ($null -ne $existing -and -not $addsCapability) { continue }
    $record = @{
      Kind = 'msaa'
      Msaa = $node
      Observation = $observation
      ControlType = $ct
      X = [double]$node.X
      Y = [double]$node.Y
      Width = [double]$node.Width
      Height = [double]$node.Height
      Enabled = [bool]$node.Enabled
      DedupeKey = $dedupeKey
    }
    [void]$matches.Add($record)
    if ($null -eq $existing) { $seen[$dedupeKey] = $record }
  }
  if ($null -ne $continuationTotal -and $matches.Count -ne $continuationTotal) {
    throw 'continuation is stale because the observed tree changed; capture the first page again'
  }
  $lines = New-Object System.Collections.ArrayList
  $elementsOut = New-Object System.Collections.ArrayList
  [void]$lines.Add("Window: $($info.Title) [$($info.Id)]")
  $view = if ($includeNoninteractive) { 'all' } else { 'interactive' }
  [void]$lines.Add("Elements: total=$($matches.Count) candidates=$candidateCount view=$view offset=$offset max=$max generation=$generation")
  if ($msaaWarning) { [void]$lines.Add("Warning: $msaaWarning") }
  $page = Get-ElementPage $matches.Count $offset $max $generation $continuationFingerprint
  $end = $page.End
  for ($i = $offset; $i -lt $end; $i++) {
    $record = $matches[$i]
    $observation = $record.Observation
    $ct = $record.ControlType
    $ref = 's{0}:e{1}' -f $generation, ($i - $offset)
    if ($record.Kind -eq 'msaa') {
      Set-MsaaRef $state $ref $record.Msaa $info.Id $generation
    } else {
      Set-ElRef $state $ref $record.Element $info.Id $generation
    }
    $mark = ($i - $offset) + 1
    $nm = Format-ObservationValue $observation.Name 80
    $cx = [math]::Round($record.X + $record.Width/2); $cy = [math]::Round($record.Y + $record.Height/2)
    $en = if ($record.Enabled) { '' } else { ' (disabled)' }
    $details = New-Object System.Collections.ArrayList
    if ($record.Kind -eq 'msaa') { [void]$details.Add('source=msaa') }
    if ($observation.AutomationId) { [void]$details.Add('id="' + (Format-ObservationValue $observation.AutomationId 80) + '"') }
    if ($observation.Value) { [void]$details.Add('value="' + (Format-ObservationValue $observation.Value 120) + '"') }
    if ($observation.Toggle) { [void]$details.Add('toggle=' + $observation.Toggle) }
    if ($observation.Selected) { [void]$details.Add('selected=' + $observation.Selected) }
    if ($observation.Expanded) { [void]$details.Add('expanded=' + $observation.Expanded) }
    if ($observation.Range) { [void]$details.Add('range=' + $observation.Range) }
    if ($record.Kind -eq 'msaa' -and $observation.Role) {
      [void]$details.Add('role="' + (Format-ObservationValue $observation.Role 80) + '"')
    }
    if ($record.Kind -eq 'msaa' -and $observation.State) {
      [void]$details.Add('state="' + (Format-ObservationValue $observation.State 120) + '"')
    }
    if ($record.Kind -eq 'msaa' -and $observation.DefaultAction) {
      [void]$details.Add('default_action="' + (Format-ObservationValue $observation.DefaultAction 80) + '"')
    }
    $actions = New-Object System.Collections.ArrayList
    if ($record.Enabled) { [void]$actions.Add('click') }
    if ($observation.CanInvoke) { [void]$actions.Add('invoke') }
    if ($observation.CanSetValue) { [void]$actions.Add('set_value') }
    if ($observation.CanToggle) { [void]$actions.Add('toggle') }
    if ($observation.CanScroll) { [void]$actions.Add('scroll') }
    $elementOut = [ordered]@{
      mark = [int]$mark
      ref = [string]$ref
      source = $(if ($record.Kind -eq 'msaa') { 'msaa' } else { 'uia' })
      role = [string]$ct
      name = (Format-ObservationValue $observation.Name 200)
      value = (Format-ObservationValue $observation.Value 300)
      state = (Format-StructuredObservationState $observation $record.Kind)
      enabled = [bool]$record.Enabled
      x = [int][math]::Round($record.X)
      y = [int][math]::Round($record.Y)
      width = [int][math]::Round($record.Width)
      height = [int][math]::Round($record.Height)
      center_x = [int]$cx
      center_y = [int]$cy
      actions = @($actions)
    }
    if ($includeStructure -and $record.Kind -eq 'uia') {
      $structure = Get-ElementStructure $record.Element
      $elementOut.runtime_id = $structure.runtime_id
      $elementOut.parent_runtime_id = $structure.parent_runtime_id
      $elementOut.class_name = $structure.class_name
      $elementOut.has_keyboard_focus = $structure.has_keyboard_focus
      $elementOut.in_document = $structure.in_document
      $elementOut.ancestors = @($structure.ancestors)
    }
    [void]$elementsOut.Add($elementOut)
    $detailText = if ($details.Count) { ' ' + ($details -join ' ') } else { '' }
    [void]$lines.Add(('[{0}] {1} "{2}"{3}{4} @{5},{6}' -f $ref, $ct, $nm, $en, $detailText, $cx, $cy))
  }
  if ($matches.Count -eq 0) { [void]$lines.Add('(no matching elements found)') }
  if ($null -ne $page.Continuation) { [void]$lines.Add("Continuation: $($page.Continuation)") }
  $state.Continuation = $page.Continuation
  return @{
    text = ($lines -join [Environment]::NewLine)
    window_id = $info.Id
    generation = $generation
    total_elements = $matches.Count
    continuation = $page.Continuation
    elements = @($elementsOut)
    timings_ms = @{
      uia_find_ms = [math]::Round($uiaFindMs, 2)
      uia_format_ms = [math]::Round($uiaFormatMs, 2)
      msaa_snapshot_ms = [math]::Round($msaaSnapshotMs, 2)
      total_ms = [math]::Round($snapshotClock.Elapsed.TotalMilliseconds, 2)
    }
  }
}

`;
