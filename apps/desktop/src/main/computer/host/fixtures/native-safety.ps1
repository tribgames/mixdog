[Console]::Error.WriteLine('probe:compile-fixtures')
Add-Type -ReferencedAssemblies @(
  'System.dll','System.Drawing.dll','System.Windows.Forms.dll',$AccessibilityAssemblyPath
) -TypeDefinition @'
using System;
using System.Drawing;
using System.Windows.Forms;
public sealed class MixdogMsaaValueFixture : Control {
  protected override AccessibleObject CreateAccessibilityInstance() { return new ValueAccessibleObject(this); }
  sealed class ValueAccessibleObject : ControlAccessibleObject {
    readonly MixdogMsaaValueFixture owner;
    public ValueAccessibleObject(MixdogMsaaValueFixture owner) : base(owner) { this.owner = owner; }
    public override string Name { get { return "msaa value fixture"; } }
    public override AccessibleRole Role { get { return AccessibleRole.Text; } }
    public override string Value {
      get { return owner.Text ?? ""; }
      set { owner.Text = value ?? ""; }
    }
    public override Rectangle Bounds { get { return owner.RectangleToScreen(owner.ClientRectangle); } }
  }
}
public sealed class MixdogMsaaActionFixture : Control {
  public int ActivationCount { get; private set; }
  protected override AccessibleObject CreateAccessibilityInstance() { return new ActionAccessibleObject(this); }
  sealed class ActionAccessibleObject : ControlAccessibleObject {
    readonly MixdogMsaaActionFixture owner;
    public ActionAccessibleObject(MixdogMsaaActionFixture owner) : base(owner) { this.owner = owner; }
    public override string Name { get { return "msaa action fixture"; } }
    public override AccessibleRole Role { get { return AccessibleRole.PushButton; } }
    public override string DefaultAction { get { return "Press"; } }
    public override void DoDefaultAction() { owner.ActivationCount++; }
    public override Rectangle Bounds { get { return owner.RectangleToScreen(owner.ClientRectangle); } }
  }
}
'@
$script:CurrentSession = Get-SessionState 'safety-probe'
[Console]::Error.WriteLine('probe:session-and-windows')
$probeResults = New-Object System.Collections.ArrayList
$firstState = Get-SessionState 'session-a'
$secondState = Get-SessionState 'session-b'
$firstState.Map['s1:e0'] = 'owned'
[void]$probeResults.Add(@{
  name = 'session-isolation'
  ok = $firstState.Map.ContainsKey('s1:e0') -and -not $secondState.Map.ContainsKey('s1:e0')
  error = ''
})
$windows = @([MixWin32]::Windows())
$stableWindow = $windows.Count -gt 0 -and [MixWin32]::ParseWindowId($windows[0].Id) -eq $windows[0].Handle
[void]$probeResults.Add(@{ name = 'stable-window-id'; ok = $stableWindow; error = '' })
[Console]::Error.WriteLine('probe:create-fixtures')
$form = New-Object System.Windows.Forms.Form
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Location = New-Object System.Drawing.Point(-30000, -30000)
$form.Size = New-Object System.Drawing.Size(500, 300)
$form.ShowInTaskbar = $false
$windowTitle = 'mixdog-window-probe-' + $PID
$form.Text = $windowTitle
$button = New-Object System.Windows.Forms.Button
$button.Location = New-Object System.Drawing.Point(10, 10)
$button.Size = New-Object System.Drawing.Size(100, 30)
$button.Text = 'native'
$textBox = New-Object System.Windows.Forms.TextBox
$textBox.Location = New-Object System.Drawing.Point(10, 60)
$textBox.Size = New-Object System.Drawing.Size(200, 30)
$textBox.AccessibleName = 'msaa edit'
$checkBox = New-Object System.Windows.Forms.CheckBox
$checkBox.Location = New-Object System.Drawing.Point(10, 105)
$checkBox.Size = New-Object System.Drawing.Size(150, 30)
$checkBox.Text = 'verify'
$label = New-Object System.Windows.Forms.Label
$label.Location = New-Object System.Drawing.Point(10, 150)
$label.Size = New-Object System.Drawing.Size(200, 30)
$label.Text = 'observation fixture'
$label.AccessibleName = 'observation fixture'
$msaaValue = New-Object MixdogMsaaValueFixture
$msaaValue.Location = New-Object System.Drawing.Point(10, 190)
$msaaValue.Size = New-Object System.Drawing.Size(200, 30)
$msaaAction = New-Object MixdogMsaaActionFixture
$msaaAction.Location = New-Object System.Drawing.Point(230, 190)
$msaaAction.Size = New-Object System.Drawing.Size(200, 30)
$script:nativeClickCount = 0
$button.Add_Click({ $script:nativeClickCount++ })
$form.Controls.Add($button)
$form.Controls.Add($textBox)
$form.Controls.Add($checkBox)
$form.Controls.Add($label)
$form.Controls.Add($msaaValue)
$form.Controls.Add($msaaAction)
$owned = New-Object System.Windows.Forms.Form
$owned.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$owned.Location = New-Object System.Drawing.Point(-29500, -30000)
$owned.Size = New-Object System.Drawing.Size(200, 100)
$owned.ShowInTaskbar = $false
$owned.Text = $windowTitle
$form.AddOwnedForm($owned)
[void]$form.Handle
[void]$button.Handle
[void]$textBox.Handle
[void]$checkBox.Handle
[void]$label.Handle
[void]$msaaValue.Handle
[void]$msaaAction.Handle
[void]$owned.Handle
[void][MixWin32]::ShowWindow($form.Handle, 4)
[void][MixWin32]::ShowWindow($owned.Handle, 4)
[System.Windows.Forms.Application]::DoEvents()
$ambiguous = $false
try { [void](Resolve-WindowInfo $windowTitle $null) } catch {
  $ambiguous = "$($_.Exception.Message)" -match 'window title is ambiguous'
}
$ownedInfo = [MixWin32]::Info($owned.Handle)
$windowIdentityOk = $ambiguous -and $ownedInfo.OwnerId -eq [MixWin32]::WindowId($form.Handle)
[void]$probeResults.Add(@{ name = 'duplicate-title-owned-window'; ok = $windowIdentityOk; error = '' })
$shownInfo = [MixWin32]::Info($form.Handle)
$shownListed = @([MixWin32]::WindowSnapshot() | Where-Object { $_.Handle -eq $form.Handle }).Count -eq 1
$cloakOk = -not [MixWin32]::IsCloaked($form.Handle) -and -not $shownInfo.Cloaked -and $shownListed
[void]$probeResults.Add(@{
  name = 'uncloaked-window-stays-listed'; ok = $cloakOk
  error = ('cloaked={0}; listed={1}' -f $shownInfo.Cloaked, $shownListed)
})
[Console]::Error.WriteLine('probe:uia-observation')
$interactiveObservation = Snapshot-Window ([pscustomobject]@{
  window_id = [MixWin32]::WindowId($form.Handle); window = $null
  query = 'observation fixture'; role = ''; visible_only = $false
  include_noninteractive = $false; max_elements = 20; continuation = $null
})
$broadObservation = Snapshot-Window ([pscustomobject]@{
  window_id = [MixWin32]::WindowId($form.Handle); window = $null
  query = 'observation fixture'; role = ''; visible_only = $false
  include_noninteractive = $true; max_elements = 20; continuation = $null
})
$observationOk = $interactiveObservation.total_elements -eq 0 -and
  $broadObservation.total_elements -ge 1 -and
  $broadObservation.text -match 'view=all' -and
  $broadObservation.text -match '"observation fixture"' -and
  @($broadObservation.elements).Count -ge 1 -and
  [int](@($broadObservation.elements)[0].mark) -eq 1 -and
  [string](@($broadObservation.elements)[0].ref) -match '^s\d+:e\d+' -and
  @($broadObservation.elements)[0].bounds -eq $null -and
  [int](@($broadObservation.elements)[0].width) -gt 0
[void]$probeResults.Add(@{ name = 'noninteractive-observation'; ok = $observationOk; error = $broadObservation.text })
[Console]::Error.WriteLine('probe:msaa-observation')
$msaaNodes = @([MixMsaa]::Snapshot($form.Handle, [MixWin32]::WindowId($form.Handle), 100))
$msaaButton = @($msaaNodes | Where-Object { $_.Name -eq 'native' -and $_.DefaultAction }) | Select-Object -First 1
$msaaEdit = @($msaaNodes | Where-Object { $_.Name -eq 'msaa value fixture' -and $_.ControlType -eq 'Edit' }) | Select-Object -First 1
$msaaActionOk = $null -ne $msaaButton -and $null -ne $msaaEdit
$msaaClickCount = -1
$msaaReadback = ''
$msaaText = ''
if ($msaaActionOk) {
  $msaaButton.DoDefaultAction()
  [System.Windows.Forms.Application]::DoEvents()
  $msaaClickCount = $script:nativeClickCount
  $msaaActionOk = $msaaClickCount -eq 1
  $script:nativeClickCount = 0
  $msaaReadback = $msaaEdit.SetValue('MSAA')
  [System.Windows.Forms.Application]::DoEvents()
  $msaaText = $msaaValue.Text
  $msaaActionOk = $msaaActionOk -and $msaaText -eq 'MSAA' -and $msaaReadback -eq 'MSAA'
  $msaaValue.Text = ''
}
[System.Windows.Forms.Application]::DoEvents()
[void]$probeResults.Add(@{
  name = 'direct-msaa-enumerate-invoke-value'; ok = $msaaActionOk
  error = ('nodes={0}; button={1}; edit={2}; clicks={3}; text={4}; readback={5}; tree={6}' -f
    $msaaNodes.Count, ($null -ne $msaaButton), ($null -ne $msaaEdit), $msaaClickCount, $msaaText, $msaaReadback,
    (@($msaaNodes | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.Name, $_.ControlType, $_.Role, $_.DefaultAction }) -join '; '))
})
[Console]::Error.WriteLine('probe:msaa-ref-actions')
$msaaActionSnapshot = Snapshot-Window ([pscustomobject]@{
  window_id = [MixWin32]::WindowId($form.Handle); window = $null
  query = 'msaa action fixture'; role = ''; visible_only = $false
  include_noninteractive = $false; max_elements = 20; continuation = $null
})
$msaaActionMatch = [regex]::Match($msaaActionSnapshot.text, '\[(?<ref>s\d+:e\d+)\] Button "msaa action fixture"')
$msaaInvokeResult = if ($msaaActionMatch.Success) { Do-Invoke $msaaActionMatch.Groups['ref'].Value } else { $null }
$msaaValueSnapshot = Snapshot-Window ([pscustomobject]@{
  window_id = [MixWin32]::WindowId($form.Handle); window = $null
  query = 'msaa value fixture'; role = ''; visible_only = $false
  include_noninteractive = $false; max_elements = 20; continuation = $null
})
$msaaValueMatch = [regex]::Match($msaaValueSnapshot.text, '\[(?<ref>s\d+:e\d+)\] Edit "msaa value fixture"')
$msaaSetResult = if ($msaaValueMatch.Success) { Do-SetValue $msaaValueMatch.Groups['ref'].Value 'ref-value' } else { $null }
$msaaRefActionsOk = $msaaActionMatch.Success -and $msaaValueMatch.Success -and
  $msaaAction.ActivationCount -eq 1 -and
  @('msaa_default_action','uia_invoke') -contains $msaaInvokeResult.path -and
  @('msaa_value','uia_value') -contains $msaaSetResult.path -and
  $msaaSetResult.verified -eq $true -and $msaaValue.Text -eq 'ref-value'
[void]$probeResults.Add(@{
  name = 'msaa-generation-ref-actions'; ok = $msaaRefActionsOk
  error = ('action={0}; value={1}; activation={2}; text={3}; invokePath={4}; setPath={5}; verified={6}; actionTree={7}' -f
    $msaaActionMatch.Success, $msaaValueMatch.Success, $msaaAction.ActivationCount, $msaaValue.Text,
    $msaaInvokeResult.path, $msaaSetResult.path, $msaaSetResult.verified, $msaaActionSnapshot.text)
})
$msaaValue.Text = ''
[Console]::Error.WriteLine('probe:background-pointer')
$buttonPoint = $button.PointToScreen((New-Object System.Drawing.Point(10, 10)))
$nativePointerTarget = [MixWin32]::BackgroundPointer($form.Handle, $buttonPoint.X, $buttonPoint.Y, 'click', '')
$nativePointerDeadline = [DateTime]::UtcNow.AddMilliseconds(200)
do {
  [System.Windows.Forms.Application]::DoEvents()
  if ($script:nativeClickCount -ge 1) { break }
  Start-Sleep -Milliseconds 5
} while ([DateTime]::UtcNow -lt $nativePointerDeadline)
$nativePointerOk = $script:nativeClickCount -eq 1 -and $nativePointerTarget -eq [MixWin32]::WindowId($button.Handle)
$nativePointerError = 'clicks={0}; target={1}; expected={2}' -f $script:nativeClickCount, $nativePointerTarget, [MixWin32]::WindowId($button.Handle)
[void]$probeResults.Add(@{ name = 'background-native-pointer'; ok = $nativePointerOk; error = $nativePointerError })
$textPoint = $textBox.PointToScreen((New-Object System.Drawing.Point(20, 10)))
$textEnd = $textBox.PointToScreen((New-Object System.Drawing.Point(120, 10)))
$moveTarget = [MixWin32]::BackgroundPointer($form.Handle, $textPoint.X, $textPoint.Y, 'move', '')
$dragTarget = [MixWin32]::BackgroundDrag($form.Handle, $textPoint.X, $textPoint.Y, $textEnd.X, $textEnd.Y, '')
$wheelTarget = [MixWin32]::BackgroundWheel($form.Handle, $textPoint.X, $textPoint.Y, -3, '')
$textWindowId = [MixWin32]::WindowId($textBox.Handle)
$pointerFamilyOk = $moveTarget -eq $textWindowId -and $dragTarget -eq $textWindowId -and $wheelTarget -eq $textWindowId
[void]$probeResults.Add(@{ name = 'background-native-pointer-family'; ok = $pointerFamilyOk; error = '' })
[Console]::Error.WriteLine('probe:background-checkbox')
$checkRef = 'probe:checkbox'
$probeState = Get-CurrentSession
$probeState.Map.Clear()
Set-ElRef $probeState $checkRef ($AE::FromHandle($checkBox.Handle)) ([MixWin32]::WindowId($form.Handle)) $probeState.Generation
$verifiedClick = Do-ClickFamily ([pscustomobject]@{
  action = 'click'; ref = $checkRef; delivery = 'background'
  window_id = [MixWin32]::WindowId($form.Handle); window = $null; modifiers = ''
}) 'click'
[System.Windows.Forms.Application]::DoEvents()
$verifiedClickOk = $verifiedClick.verified -eq $false -and $verifiedClick.effect -eq 'unverifiable' -and $verifiedClick.path -eq 'win32_message'
$verifiedClickError = 'checked={0}; verified={1}; effect={2}; message={3}' -f $checkBox.Checked, $verifiedClick.verified, $verifiedClick.effect, $verifiedClick.text
[void]$probeResults.Add(@{ name = 'background-native-click-honest-unverifiable'; ok = $verifiedClickOk; error = $verifiedClickError })
[Console]::Error.WriteLine('probe:semantic-checkbox')
$checkBox.Checked = $false
[System.Windows.Forms.Application]::DoEvents()
$semanticDeadline = [DateTime]::UtcNow.AddMilliseconds(200)
do {
  $semanticSnapshot = Snapshot-Window ([pscustomobject]@{
    window_id = [MixWin32]::WindowId($form.Handle); window = $null
    query = 'verify'; role = ''; visible_only = $false
    include_noninteractive = $false; max_elements = 20; continuation = $null
  })
  $semanticMatch = [regex]::Match($semanticSnapshot.text, '\[(?<ref>s\d+:e\d+)\] (?:CheckBox|Button) "verify"')
  if ($semanticMatch.Success) { break }
  [System.Windows.Forms.Application]::DoEvents()
  [System.Threading.Thread]::Sleep(10)
} while ([DateTime]::UtcNow -lt $semanticDeadline)
$semanticClick = if ($semanticMatch.Success) { Do-Invoke $semanticMatch.Groups['ref'].Value } else { $null }
[System.Windows.Forms.Application]::DoEvents()
$semanticClickOk = $semanticMatch.Success -and $checkBox.Checked -and
  $semanticClick.action -eq 'invoke' -and @('uia_toggle','msaa_default_action') -contains $semanticClick.path -and
  (($semanticClick.verified -eq $true -and $semanticClick.effect -eq 'confirmed') -or
    ($semanticClick.verified -eq $false -and $semanticClick.effect -eq 'unverifiable'))
$semanticClickError = 'match={0}; checked={1}; verified={2}; effect={3}; path={4}; message={5}; tree={6}' -f
  $semanticMatch.Success, $checkBox.Checked, $semanticClick.verified, $semanticClick.effect, $semanticClick.path, $semanticClick.text, $semanticSnapshot.text
[void]$probeResults.Add(@{ name = 'semantic-ref-click-invokes-toggle'; ok = $semanticClickOk; error = $semanticClickError })
[Console]::Error.WriteLine('probe:background-keys')
$editRef = 'probe:edit'
$probeState.Map.Clear()
Set-ElRef $probeState $editRef ($AE::FromHandle($textBox.Handle)) ([MixWin32]::WindowId($form.Handle)) $probeState.Generation
$verifiedKey = Do-Key ([pscustomobject]@{
  action = 'key'; ref = $editRef; keys = 'Hello'; delivery = 'background'
  window_id = [MixWin32]::WindowId($form.Handle); window = $null
})
[System.Windows.Forms.Application]::DoEvents()
$nativeKeyOk = $textBox.Text -eq 'Hello' -and $verifiedKey.verified -eq $false -and
  $verifiedKey.goal_verified -eq $false -and $verifiedKey.state_changed -eq $true -and $verifiedKey.effect -eq 'unverifiable'
$nativeKeyError = 'text={0}; verified={1}; goal={2}; changed={3}; effect={4}; message={5}' -f
  $textBox.Text, $verifiedKey.verified, $verifiedKey.goal_verified, $verifiedKey.state_changed, $verifiedKey.effect, $verifiedKey.text
[void]$probeResults.Add(@{ name = 'background-native-key-honest-unverifiable'; ok = $nativeKeyOk; error = $nativeKeyError })
$textBox.Text = ''
$literalText = 'literal {text} ^%+ 한글'
$typed = Do-Type ([pscustomobject]@{
  action = 'type'; ref = $editRef; text = $literalText; delivery = 'background'
  window_id = [MixWin32]::WindowId($form.Handle); window = $null
})
[System.Windows.Forms.Application]::DoEvents()
$literalTypeOk = $textBox.Text -eq $literalText -and $typed.action -eq 'type' -and $typed.path -eq 'win32_message'
[void]$probeResults.Add(@{
  name = 'background-literal-type'; ok = $literalTypeOk
  error = ('text={0}; expected={1}; action={2}; path={3}' -f $textBox.Text, $literalText, $typed.action, $typed.path)
})
[Console]::Error.WriteLine('probe:drag-and-recovery')
$coordinateDrag = Do-Drag ([pscustomobject]@{
  action = 'drag'; ref = $null; to = $null; x = $textPoint.X; y = $textPoint.Y
  to_x = $textEnd.X; to_y = $textEnd.Y; delivery = 'background'
  window_id = [MixWin32]::WindowId($form.Handle); window = $null; modifiers = ''
})
$coordinateDragOk = $coordinateDrag.action -eq 'drag' -and $coordinateDrag.path -eq 'win32_message' -and -not $coordinateDrag.code
[void]$probeResults.Add(@{
  name = 'background-coordinate-drag'; ok = $coordinateDragOk
  error = ('action={0}; path={1}; code={2}; text={3}' -f $coordinateDrag.action, $coordinateDrag.path, $coordinateDrag.code, $coordinateDrag.text)
})
Invalidate-RefsForRequest ([pscustomobject]@{ action = 'key' })
$staleRefRejected = $false
try { [void](Get-El $editRef) } catch { $staleRefRejected = "$($_.Exception.Message)" -match 'stale' }
[void]$probeResults.Add(@{ name = 'mutation-invalidates-refs'; ok = $staleRefRejected; error = '' })
$pageOne = Get-ElementPage 205 0 200 7 'probe'
$pageOffset = [int](([string]$pageOne.Continuation).Split(':')[1])
$pageTwo = Get-ElementPage 205 $pageOffset 200 8 'probe'
$paginationOk = $pageOne.End -eq 200 -and $pageOne.Continuation -eq '7:200:probe:205' -and
  $pageTwo.End -eq 205 -and $null -eq $pageTwo.Continuation
$paginationError = 'pageOne={0}/{1}; pageTwo={2}/{3}' -f $pageOne.End, $pageOne.Continuation, $pageTwo.End, $pageTwo.Continuation
[void]$probeResults.Add(@{ name = 'ax-pagination-over-200'; ok = $paginationOk; error = $paginationError })
$recovery = Get-InputRecoveryState ([pscustomobject]@{
  window_id = [MixWin32]::WindowId($form.Handle); window = $null; ref = $null
})
$recoveryOk = $recovery.target_window_id -eq [MixWin32]::WindowId($form.Handle) -and
  $recovery.cursor_x -is [int] -and $recovery.cursor_y -is [int]
[void]$probeResults.Add(@{ name = 'foreground-recovery-state'; ok = $recoveryOk; error = '' })
$minimized = Do-WindowState ([pscustomobject]@{
  window_id = [MixWin32]::WindowId($form.Handle); window = $null; state = 'minimize'
})
$restored = Do-WindowState ([pscustomobject]@{
  window_id = [MixWin32]::WindowId($form.Handle); window = $null; state = 'restore'
})
$windowStateOk = $minimized.verified -eq $true -and $restored.verified -eq $true
[void]$probeResults.Add(@{
  name = 'window-state-minimize-restore'; ok = $windowStateOk
  error = ('minimized={0}; restored={1}' -f $minimized.verified, $restored.verified)
})
@@MIXDOG_LIVE_CLIPBOARD_PROBE@@
[Console]::Error.WriteLine('probe:ocr')
$ocrBitmap = New-Object System.Drawing.Bitmap(64, 64)
$ocrGraphics = [System.Drawing.Graphics]::FromImage($ocrBitmap)
$ocrGraphics.Clear([System.Drawing.Color]::White)
$ocrStream = New-Object System.IO.MemoryStream
$ocrBitmap.Save($ocrStream, [System.Drawing.Imaging.ImageFormat]::Png)
$ocrEncoded = [Convert]::ToBase64String($ocrStream.ToArray())
$ocrStream.Dispose()
$ocrGraphics.Dispose()
$ocrBitmap.Dispose()
$ocrResult = Do-OcrImage ([pscustomobject]@{ image_base64 = $ocrEncoded; ocr_language = $null; max_ocr_words = 10 })
$ocrOk = -not [string]::IsNullOrWhiteSpace([string]$ocrResult.language) -and [int]$ocrResult.total_words -ge 0
[void]$probeResults.Add(@{
  name = 'windows-ocr-image'; ok = $ocrOk
  error = ('language={0}; words={1}' -f $ocrResult.language, $ocrResult.total_words)
})
[Console]::Error.WriteLine('probe:close-fixtures')
$owned.Close()
$owned.Dispose()
$form.Close()
$form.Dispose()
$missingLaunchTarget = Join-Path $env:TEMP ('mixdog-computer-missing-' + [Guid]::NewGuid().ToString('N') + '.pptx')
try {
  [void](Do-Launch $missingLaunchTarget)
  [void]$probeResults.Add(@{ name = 'launch-missing-target'; ok = $false; error = 'missing target unexpectedly launched' })
} catch {
  $missingLaunchError = "$($_.Exception.Message)"
  [void]$probeResults.Add(@{
    name = 'launch-missing-target'
    ok = $missingLaunchError -match 'launch failed \[target_not_found/(2|3)\]'
    error = $missingLaunchError
  })
}
try {
  Assert-TypingTarget
  [void]$probeResults.Add(@{ name = 'key'; ok = $true; error = '' })
} catch {
  [void]$probeResults.Add(@{ name = 'key'; ok = $false; error = "$($_.Exception.Message)" })
}
try {
  Assert-InputTarget ([IntPtr]::Zero) 'click'
  [void]$probeResults.Add(@{ name = 'click'; ok = $true; error = '' })
} catch {
  [void]$probeResults.Add(@{ name = 'click'; ok = $false; error = "$($_.Exception.Message)" })
}
$probeJson = @{ results = $probeResults } | ConvertTo-Json -Compress -Depth 5
[Console]::Out.WriteLine('@@MIXCU@@' + $probeJson)
exit
