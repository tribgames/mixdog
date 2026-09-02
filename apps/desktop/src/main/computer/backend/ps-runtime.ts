/**
 * The rest of the host: direct window capture, integrity and input recovery, guarded hotkeys, OCR, clipboard, and the request dispatch loop.
 *
 * PowerShell source for the resident Computer Use worker. It is one program
 * split by capability; the pieces are joined in file order, so a line here
 * keeps the meaning it had in the whole.
 */
import { RESPONSE_MARKER } from '../shared/common';

export const PS_RUNTIME = String.raw`
function Get-WindowCapture($req) {
  $info = Resolve-WindowInfo $req.window $req.window_id
  try {
    $capture = [MixWin32]::CaptureVisibleWindow($info.Handle)
  } catch {
    throw "native window capture failed for $($info.Id): $($_.Exception.Message)"
  }
  return @{
    text = ('native window capture: ' + $info.Title)
    title = $info.Title
    window_id = $info.Id
    x = $capture.X
    y = $capture.Y
    width = $capture.Width
    height = $capture.Height
    visible_samples = $capture.VisibleSamples
    capture_source = 'screen_region'
    image_base64 = $capture.PngBase64
  }
}

function Get-WindowIntegrity($req) {
  $info = Resolve-WindowInfo $req.window $req.window_id
  $integrity = [MixWin32]::WindowIntegrity($info.Handle)
  return @{
    text = ('window integrity: ' + $integrity.TargetName)
    window_id = $info.Id
    known = $integrity.Known
    higher = $integrity.Higher
    own_rid = $integrity.OwnRid
    target_rid = $integrity.TargetRid
    own_name = $integrity.OwnName
    target_name = $integrity.TargetName
  }
}

function Get-InputRecoveryState($req) {
  $state = Get-CurrentSession
  $target = [IntPtr]::Zero
  if ($req.ref) {
    $target = Get-RefTopHandle (Get-RefRecord $req.ref)
  } elseif ($req.window_id -or $req.window) {
    $target = (Resolve-WindowInfo $req.window $req.window_id).Handle
  } elseif ([MixWin32]::IsWindowHandle($state.LastFocus)) {
    $target = $state.LastFocus
  }
  if (-not [MixWin32]::IsWindowHandle($target)) {
    throw 'foreground input target is unavailable before dispatch'
  }
  $foreground = [MixWin32]::Foreground()
  $restore = if ([MixWin32]::IsWindowHandle($state.OriginalFocus)) {
    $state.OriginalFocus
  } else {
    $foreground
  }
  $cursor = [MixWin32]::Cursor()
  # Recorded now, while the window still exists: an action can close exactly the
  # window that held focus, and a destroyed handle can no longer name its owner.
  $restoreOwnerId = ''
  if ([MixWin32]::IsWindowHandle($restore)) {
    $restoreInfo = [MixWin32]::Info($restore)
    if ($null -ne $restoreInfo) { $restoreOwnerId = [string]$restoreInfo.OwnerId }
  }
  return @{
    text = 'foreground input recovery state captured'
    target_window_id = [MixWin32]::WindowId($target)
    foreground_window_id = $(if ([MixWin32]::IsWindowHandle($foreground)) { [MixWin32]::WindowId($foreground) } else { '' })
    restore_window_id = $(if ([MixWin32]::IsWindowHandle($restore)) { [MixWin32]::WindowId($restore) } else { '' })
    restore_owner_window_id = $restoreOwnerId
    cursor_x = $cursor.x
    cursor_y = $cursor.y
  }
}

function Restore-InputRecoveryState($req) {
  $restoreFocus = $req.restore_focus -ne $false
  $restore = [MixWin32]::ParseWindowId([string]$req.restore_window_id)
  $restoredTarget = if ($restoreFocus) { 'original' } else { 'preserved' }
  if ($restoreFocus -and -not [MixWin32]::IsWindowHandle($restore)) {
    # The action can close the very window that held focus. Its owner is the
    # truthful next home for focus instead of wherever Windows happened to land.
    $owner = [MixWin32]::ParseWindowId([string]$req.restore_owner_window_id)
    if (-not [MixWin32]::IsWindowHandle($owner)) {
      throw 'input recovery restore window is stale or invalid'
    }
    $restore = $owner
    $restoredTarget = 'owner'
  }
  if ($restoreFocus -and [MixWin32]::Foreground() -ne $restore) {
    [void][MixWin32]::Focus($restore)
  }
  [void][MixWin32]::SetCursorPos([int]$req.cursor_x, [int]$req.cursor_y)
  [System.Threading.Thread]::Sleep(30)
  [void][MixWin32]::SetCursorPos([int]$req.cursor_x, [int]$req.cursor_y)
  $foreground = [MixWin32]::Foreground()
  $cursor = [MixWin32]::Cursor()
  return @{
    foreground_window_id = $(if ([MixWin32]::IsWindowHandle($foreground)) { [MixWin32]::WindowId($foreground) } else { '' })
    restored_target = $restoredTarget
    cursor_x = $cursor.x
    cursor_y = $cursor.y
  }
}

# Hotkeys ride .NET SendKeys: its SendWait waits for the target to process
# each key, which raw SendInput batches cannot. SendKeys' lock-key side effect
# is detected and reverted here.
function Send-KeysGuarded($keys) {
  $keyText = [string]$keys
  $modifierVks = @()
  $vk = $null
  $repeat = 1
  if ($keyText -match '^(?<mods>[\^%+]+)(?<key>[A-Za-z0-9])$') {
    foreach ($modifier in $matches['mods'].ToCharArray()) {
      switch ($modifier) {
        '^' { $modifierVks += 0x11 }
        '%' { $modifierVks += 0x12 }
        '+' { $modifierVks += 0x10 }
      }
    }
    $vk = [int][char](([string]$matches['key']).ToUpperInvariant())
  } elseif ($keyText -match '^(?<mods>[\^%+]*)\{(?<key>[A-Za-z]+[0-9]*)(?:\s+(?<repeat>[0-9]{1,3}))?\}$') {
    foreach ($modifier in $matches['mods'].ToCharArray()) {
      switch ($modifier) {
        '^' { $modifierVks += 0x11 }
        '%' { $modifierVks += 0x12 }
        '+' { $modifierVks += 0x10 }
      }
    }
    try {
      $vk = [MixWin32]::NamedVirtualKey(([string]$matches['key']).ToUpperInvariant())
    } catch {
      $vk = $null
    }
    if ($matches['repeat']) {
      $repeat = [int]$matches['repeat']
      if ($repeat -lt 1 -or $repeat -gt 100) { $vk = $null }
    }
  }
  if ($null -ne $vk) {
    foreach ($modifierVk in $modifierVks) { [MixWin32]::KeyDown([System.UInt16]$modifierVk) }
    try {
      for ($count = 0; $count -lt $repeat; $count++) {
        [MixWin32]::KeyTap([System.UInt16]$vk)
      }
    } finally {
      for ($i = $modifierVks.Count - 1; $i -ge 0; $i--) {
        [MixWin32]::KeyUp([System.UInt16]$modifierVks[$i])
      }
    }
    return
  }
  $locks = @(
    @{ token = '{NUMLOCK}'; vk = 0x90; key = [System.Windows.Forms.Keys]::NumLock },
    @{ token = '{CAPSLOCK}'; vk = 0x14; key = [System.Windows.Forms.Keys]::CapsLock },
    @{ token = '{SCROLLLOCK}'; vk = 0x91; key = [System.Windows.Forms.Keys]::Scroll }
  )
  $before = @{}
  foreach ($l in $locks) { $before[$l.token] = [System.Windows.Forms.Control]::IsKeyLocked($l.key) }
  [System.Windows.Forms.SendKeys]::SendWait($keys)
  Start-Sleep -Milliseconds 30
  foreach ($l in $locks) {
    if (([string]$keys).ToUpper().Contains($l.token)) { continue }
    if ([System.Windows.Forms.Control]::IsKeyLocked($l.key) -ne $before[$l.token]) { [MixWin32]::KeyTap([System.UInt16]$l.vk) }
  }
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
        return Background-Unavailable 'key' 'MSAA ref does not expose an exact native keyboard target; use set_value or explicit foreground delivery' $refRecord.WindowId 'background_unsupported'
      }
      $preferred = Get-ExactNativeElementHandle $refRecord.Element
      if ($preferred -eq [IntPtr]::Zero) {
        return Background-Unavailable 'key' 'element has no exact native keyboard target; use explicit foreground delivery' $refRecord.WindowId 'background_unsupported'
      }
    } elseif ($req.window_id -or $req.window) {
      $target = (Resolve-WindowInfo $req.window $req.window_id).Handle
    } else {
      return Background-Unavailable 'key' 'background key requires an exact ref or window_id' $null 'target_required'
    }
    $before = Get-ObservableTargetState $refRecord 'key'
    try {
      $messageTarget = [MixWin32]::BackgroundKeys($target, $preferred, [string]$req.keys)
      return Complete-NativeAction 'key' $messageTarget ([MixWin32]::WindowId($target)) $before $refRecord "keys delivered to $messageTarget as native window messages"
    } catch {
      return Native-BackgroundFailure 'key' $_.Exception ([MixWin32]::WindowId($target))
    }
  }
  $target = [IntPtr]::Zero
  $focusPoint = $null
  if ($req.ref) {
    $focusPoint = Get-ElPoint $req.ref $false
    $target = $focusPoint[2]
  } elseif ($req.window_id -or $req.window) {
    $target = (Resolve-WindowInfo $req.window $req.window_id).Handle
  } else {
    $target = (Get-CurrentSession).LastFocus
  }
  if (-not [MixWin32]::IsWindowHandle($target)) {
    return New-ActionResult 'key' 'none' 'suspected_noop' $false 'key requires window_id/window or a prior focus_window in this session' 'target_required' 'foreground' $null
  }
  return Invoke-ForegroundInput $target 'key' {
    if ($null -ne $focusPoint) {
      [MixWin32]::Click($focusPoint[0], $focusPoint[1])
      Start-Sleep -Milliseconds 80
    }
    if (([string]$req.keys) -notmatch '[{}^%+~()]') { [MixWin32]::SendText([string]$req.keys) }
    else { Send-KeysGuarded $req.keys }
  }
}

function Do-Type($req) {
  $text = if ($null -eq $req.text) { '' } else { [string]$req.text }
  if ($req.delivery -ne 'foreground') {
    $target = [IntPtr]::Zero
    $preferred = [IntPtr]::Zero
    $refRecord = $null
    if ($req.ref) {
      $refRecord = Get-RefRecord $req.ref
      $target = Get-RefTopHandle $refRecord
      if ($refRecord.Kind -eq 'msaa') {
        return Background-Unavailable 'type' 'MSAA ref does not expose an exact native keyboard target; use set_value or explicit foreground delivery' $refRecord.WindowId 'background_unsupported'
      }
      $preferred = Get-ExactNativeElementHandle $refRecord.Element
      if ($preferred -eq [IntPtr]::Zero) {
        return Background-Unavailable 'type' 'element has no exact native keyboard target; use set_value or explicit foreground delivery' $refRecord.WindowId 'background_unsupported'
      }
    } elseif ($req.window_id -or $req.window) {
      $target = (Resolve-WindowInfo $req.window $req.window_id).Handle
    } else {
      return Background-Unavailable 'type' 'background type requires an exact ref or window_id' $null 'target_required'
    }
    $before = Get-ObservableTargetState $refRecord 'type'
    try {
      if ($null -ne $req.x -and $null -ne $req.y) {
        [void][MixWin32]::BackgroundPointer(
          $target, [int]$req.x, [int]$req.y, 'click', $null)
        Start-Sleep -Milliseconds 80
      }
      $messageTarget = [MixWin32]::BackgroundText($target, $preferred, $text)
      return Complete-NativeAction 'type' $messageTarget ([MixWin32]::WindowId($target)) $before $refRecord "typed $($text.Length) literal characters into $messageTarget as native window messages"
    } catch {
      return Native-BackgroundFailure 'type' $_.Exception ([MixWin32]::WindowId($target))
    }
  }
  $target = [IntPtr]::Zero
  $focusPoint = $null
  if ($req.ref) {
    $focusPoint = Get-ElPoint $req.ref $false
    $target = $focusPoint[2]
  } elseif ($req.window_id -or $req.window) {
    $target = (Resolve-WindowInfo $req.window $req.window_id).Handle
    if ($null -ne $req.x -and $null -ne $req.y) {
      $focusPoint = @([int]$req.x, [int]$req.y, $target)
    }
  } else {
    $target = (Get-CurrentSession).LastFocus
  }
  if (-not [MixWin32]::IsWindowHandle($target)) {
    return New-ActionResult 'type' 'none' 'suspected_noop' $false 'type requires window_id/window or a prior focus_window in this session' 'target_required' 'foreground' $null
  }
  return Invoke-ForegroundInput $target 'type' {
    if ($null -ne $focusPoint) {
      [MixWin32]::Click($focusPoint[0], $focusPoint[1])
      Start-Sleep -Milliseconds 80
    }
    [MixWin32]::SendText($text)
  }
}

function Do-OcrImage($req) {
  $encoded = [string]$req.image_base64
  if ([string]::IsNullOrWhiteSpace($encoded)) { throw 'ocr_image requires image_base64' }
  $maximum = if ($null -ne $req.max_ocr_words) { [int]$req.max_ocr_words } else { 300 }
  if ($maximum -lt 1 -or $maximum -gt 1000) { throw 'max_ocr_words must be 1..1000' }
  [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
  [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null
  $path = [System.IO.Path]::Combine(
    [System.IO.Path]::GetTempPath(),
    'mixdog-ocr-' + [Guid]::NewGuid().ToString('N') + '.img')
  $stream = $null
  $bitmap = $null
  try {
    [System.IO.File]::WriteAllBytes($path, [Convert]::FromBase64String($encoded))
    $file = Await-WinRt (
      [Windows.Storage.StorageFile]::GetFileFromPathAsync($path)
    ) ([Windows.Storage.StorageFile])
    $stream = Await-WinRt (
      $file.OpenAsync([Windows.Storage.FileAccessMode]::Read)
    ) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await-WinRt (
      [Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)
    ) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await-WinRt (
      $decoder.GetSoftwareBitmapAsync()
    ) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $language = ([string]$req.ocr_language).Trim()
    $engine = if ($language) {
      [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage(
        ([Windows.Globalization.Language]::new($language)))
    } else {
      [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    }
    if ($null -eq $engine) {
      throw "Windows OCR has no recognizer for language '$language'"
    }
    $ocr = Await-WinRt (
      $engine.RecognizeAsync($bitmap)
    ) ([Windows.Media.Ocr.OcrResult])
    $words = New-Object System.Collections.ArrayList
    $lines = New-Object System.Collections.ArrayList
    $totalWords = 0
    $lineIndex = 0
    foreach ($line in $ocr.Lines) {
      $minX = [double]::PositiveInfinity; $minY = [double]::PositiveInfinity
      $maxX = [double]::NegativeInfinity; $maxY = [double]::NegativeInfinity
      foreach ($word in $line.Words) {
        $rect = $word.BoundingRect
        $minX = [math]::Min($minX, [double]$rect.X)
        $minY = [math]::Min($minY, [double]$rect.Y)
        $maxX = [math]::Max($maxX, [double]$rect.X + [double]$rect.Width)
        $maxY = [math]::Max($maxY, [double]$rect.Y + [double]$rect.Height)
        if ($totalWords -lt $maximum) {
          [void]$words.Add([ordered]@{
            text = [string]$word.Text
            line = [int]$lineIndex
            x = [int][math]::Round($rect.X)
            y = [int][math]::Round($rect.Y)
            width = [int][math]::Round($rect.Width)
            height = [int][math]::Round($rect.Height)
            center_x = [int][math]::Round($rect.X + $rect.Width / 2)
            center_y = [int][math]::Round($rect.Y + $rect.Height / 2)
          })
        }
        $totalWords++
      }
      [void]$lines.Add([ordered]@{
        line = [int]$lineIndex
        text = [string]$line.Text
        x = $(if ([double]::IsInfinity($minX)) { 0 } else { [int][math]::Round($minX) })
        y = $(if ([double]::IsInfinity($minY)) { 0 } else { [int][math]::Round($minY) })
        width = $(if ([double]::IsInfinity($minX)) { 0 } else { [int][math]::Round($maxX - $minX) })
        height = $(if ([double]::IsInfinity($minY)) { 0 } else { [int][math]::Round($maxY - $minY) })
      })
      $lineIndex++
    }
    return @{
      text = ('OCR: ' + $lineIndex + ' lines, ' + $totalWords + ' words')
      language = [string]$engine.RecognizerLanguage.LanguageTag
      lines = @($lines)
      words = @($words)
      total_words = [int]$totalWords
      truncated_words = [math]::Max(0, [int]$totalWords - [int]$words.Count)
    }
  } finally {
    if ($null -ne $bitmap -and $bitmap -is [System.IDisposable]) { $bitmap.Dispose() }
    if ($null -ne $stream -and $stream -is [System.IDisposable]) { $stream.Dispose() }
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  }
}

function Do-OcrStatus($req) {
  [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime] | Out-Null
  [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null
  $requested = ([string]$req.ocr_language).Trim()
  $installed = @(
    [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages |
      ForEach-Object { [string]$_.LanguageTag }
  )
  $engine = if ($requested) {
    [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage(
      ([Windows.Globalization.Language]::new($requested)))
  } else {
    [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  }
  return @{
    text = 'Windows OCR readiness'
    available = $null -ne $engine
    requested_language = $(if ($requested) { $requested } else { $null })
    active_language = $(if ($null -ne $engine) { [string]$engine.RecognizerLanguage.LanguageTag } else { $null })
    installed_languages = @($installed)
  }
}

# Clipboard passthrough is an explicit global operation. Semantic set_value is
# preferred because it neither replaces the user's clipboard nor steals focus.
function Do-ClipboardRead {
  $text = [System.Windows.Forms.Clipboard]::GetText()
  if (-not $text) { return @{ text = 'Clipboard is empty or not text.' } }
  if ($text.Length -gt 30000) { $text = $text.Substring(0, 30000) + '... (truncated)' }
  return @{ text = $text }
}

function Do-ClipboardWrite($text) {
  if ($null -eq $text -or ([string]$text).Length -eq 0) {
    [System.Windows.Forms.Clipboard]::Clear()
    $verified = -not [System.Windows.Forms.Clipboard]::ContainsText()
    return New-ActionResult 'clipboard_write' 'clipboard' $(if ($verified) { 'confirmed' } else { 'unverifiable' }) $verified 'cleared clipboard' $null 'background' $null
  }
  [System.Windows.Forms.Clipboard]::SetText([string]$text)
  $verified = [System.Windows.Forms.Clipboard]::GetText() -eq [string]$text
  return New-ActionResult 'clipboard_write' 'clipboard' $(if ($verified) { 'confirmed' } else { 'unverifiable' }) $verified ('clipboard set: ' + ([string]$text).Length + ' chars') $null 'background' $null
}

# Move/resize a top-level window; omitted fields keep the current bounds. Also
# the agent's remedy when the occlusion guard reports a covered element.
function Do-MoveWindow($req) {
  if ($null -eq $req.x -and $null -eq $req.y -and
      $null -eq $req.width -and $null -eq $req.height) {
    throw 'move_window requires x, y, width, or height'
  }
  $info = Resolve-WindowInfo $req.window $req.window_id
  $x = if ($null -ne $req.x) { [int]$req.x } else { $info.X }
  $y = if ($null -ne $req.y) { [int]$req.y } else { $info.Y }
  $w = if ($null -ne $req.width) { [int]$req.width } else { $info.Width }
  $hh = if ($null -ne $req.height) { [int]$req.height } else { $info.Height }
  if ($w -lt 1 -or $hh -lt 1) { throw 'window width and height must be positive' }
  [void][MixWin32]::ShowWindow($info.Handle, 9)
  if (-not [MixWin32]::MoveWindow($info.Handle, $x, $y, $w, $hh, $true)) {
    throw "could not move window: $($info.Id)"
  }
  $after = [MixWin32]::Info($info.Handle)
  $verified = $after.X -eq $x -and $after.Y -eq $y -and $after.Width -eq $w -and $after.Height -eq $hh
  $message = 'moved {0} to {1},{2} size {3}x{4}' -f $info.Id, $x, $y, $w, $hh
  return New-ActionResult 'move_window' 'win32' $(if ($verified) { 'confirmed' } else { 'unverifiable' }) $verified $message $null 'background' $info.Id
}

function Do-WindowState($req) {
  $state = ([string]$req.state).ToLower()
  if ($state -notin @('minimize','maximize','restore')) {
    throw 'window state must be minimize, maximize, or restore'
  }
  $info = Resolve-WindowInfo $req.window $req.window_id
  $command = switch ($state) {
    'minimize' { 6 }
    'maximize' { 3 }
    'restore' { 9 }
    default { throw 'window_state requires state=minimize, maximize, or restore' }
  }
  [void][MixWin32]::ShowWindow($info.Handle, $command)
  Start-Sleep -Milliseconds 80
  $verified = switch ($state) {
    'minimize' { [MixWin32]::IsMinimized($info.Handle) }
    'maximize' { [MixWin32]::IsMaximized($info.Handle) }
    'restore' {
      -not [MixWin32]::IsMinimized($info.Handle) -and
      -not [MixWin32]::IsMaximized($info.Handle)
    }
  }
  return New-ActionResult 'window_state' 'win32' $(if ($verified) { 'confirmed' } else { 'unverifiable' }) $verified "$state window $($info.Id)" $null 'background' $info.Id
}

function Do-CloseWindow($req) {
  $info = Resolve-WindowInfo $req.window $req.window_id
  if (-not [MixWin32]::CloseWindow($info.Handle)) {
    return New-ActionResult 'close_window' 'win32' 'suspected_noop' $false "could not request close for $($info.Id)" 'window_close_rejected' 'background' $info.Id
  }
  Start-Sleep -Milliseconds 120
  $verified = -not [MixWin32]::IsWindowHandle($info.Handle)
  $message = if ($verified) {
    "closed window $($info.Id)"
  } else {
    "close requested for $($info.Id); the app may be showing a save or confirmation dialog"
  }
  return New-ActionResult 'close_window' 'win32' $(if ($verified) { 'confirmed' } else { 'unverifiable' }) $verified $message $null 'background' $info.Id
}

function Do-Launch($app) {
  $target = [string]$app
  if ([string]::IsNullOrWhiteSpace($target)) { throw 'launch requires app' }
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $target
  $startInfo.UseShellExecute = $true
  try {
    $process = [System.Diagnostics.Process]::Start($startInfo)
  } catch [System.ComponentModel.Win32Exception] {
    $nativeCode = [int]$_.Exception.NativeErrorCode
    $category = switch ($nativeCode) {
      { $_ -in 2, 3 } { 'target_not_found'; break }
      5 { 'access_denied'; break }
      { $_ -in 31, 1155 } { 'no_file_association'; break }
      1223 { 'launch_cancelled'; break }
      default { 'shell_launch_failed' }
    }
    throw "launch failed [$category/$nativeCode] for '$target': $($_.Exception.Message)"
  } catch {
    throw "launch failed [shell_launch_failed] for '$target': $($_.Exception.Message)"
  }
  $result = New-ActionResult 'launch' 'windows_shell' 'unverifiable' $false ('launched ' + $target) $null 'background' $null
  if ($null -ne $process) {
    $result.pid = [int]$process.Id
    try { $result.app_hint = [string]$process.ProcessName } catch {}
  }
  return $result
}

function Release-SessionState {
  $state = Get-CurrentSession
  $current = [MixWin32]::Foreground()
  if (($state.OriginalFocus -ne [IntPtr]::Zero) -and
      ($current -eq $state.LastFocus) -and
      [MixWin32]::IsWindowHandle($state.OriginalFocus)) {
    [void][MixWin32]::Focus($state.OriginalFocus)
  }
  $state.Map.Clear()
  $state.Generation = [int]$state.Generation + 1
  $state.LastFocus = [IntPtr]::Zero
  $state.OriginalFocus = [IntPtr]::Zero
  return @{ text = 'computer session released' }
}

function Invalidate-RefsForRequest($req) {
  $readActions = @('list_windows','window_snapshot','related_windows','snapshot','find','clipboard_read','wait','window_bounds','window_capture','window_predicates','window_integrity','input_recovery_state','ocr_image','ocr_status','release_session')
  if ($null -ne $req -and -not ($readActions -contains [string]$req.action)) {
    $state = Get-CurrentSession
    $state.Map.Clear()
    $state.Generation = [int]$state.Generation + 1
  }
}

function Handle($req) {
  $script:CurrentSession = Get-SessionState $req.session_id
  $readActions = @('list_windows','window_snapshot','related_windows','snapshot','find','clipboard_read','wait','window_bounds','window_capture','window_predicates','window_integrity','input_recovery_state','ocr_image','ocr_status')
  if ($req.read_only -and -not ($readActions -contains [string]$req.action)) {
    throw "read_only run: '$($req.action)' is a mutation"
  }
  switch ($req.action) {
    'list_windows' { return Do-ListWindows }
    'window_snapshot' { return Do-WindowSnapshot }
    'related_windows' { return Do-RelatedWindows $req }
    'snapshot'     { return Snapshot-Window $req }
    'find'         { return Snapshot-Window $req }
    'invoke'       { return Invoke-BackgroundSemantic $req.ref { Do-Invoke $req.ref } }
    'set_value'    { return Invoke-BackgroundSemantic $req.ref { Do-SetValue $req.ref $req.text } }
    'toggle'       { return Invoke-BackgroundSemantic $req.ref { Do-Toggle $req.ref } }
    'click'        { return Do-ClickFamily $req 'click' }
    'double_click' { return Do-ClickFamily $req 'double' }
    'right_click'  { return Do-ClickFamily $req 'right' }
    'middle_click' { return Do-ClickFamily $req 'middle' }
    'triple_click' { return Do-ClickFamily $req 'triple' }
    'mouse_move'   { return Do-MouseMove $req }
    'wait'         { return Do-Wait $req }
    'drag'         { return Do-Drag $req }
    'scroll'       { return Do-Scroll $req }
    'focus_window' { return Do-Focus $req }
    'window_bounds'{ return Get-WindowBounds $req }
    'window_capture'{ return Get-WindowCapture $req }
    'window_predicates'{ return Get-WindowPredicates $req }
    'invoke_menu'  { return Do-InvokeMenu $req }
    'window_integrity'{ return Get-WindowIntegrity $req }
    'input_recovery_state' { return Get-InputRecoveryState $req }
    'restore_input_state' { return Restore-InputRecoveryState $req }
    'move_window'  { return Do-MoveWindow $req }
    'key'          { return Do-Key $req }
    'type'         { return Do-Type $req }
    'window_state' { return Do-WindowState $req }
    'close_window' { return Do-CloseWindow $req }
    'ocr_image'    { return Do-OcrImage $req }
    'ocr_status'   { return Do-OcrStatus $req }
    'clipboard_read'  { return Do-ClipboardRead }
    'clipboard_write' { return Do-ClipboardWrite $req.text }
    'launch'       { return Do-Launch $req.app }
    'release_session' { return Release-SessionState }
    default        { throw "unknown action: $($req.action)" }
  }
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# Read stdin as UTF-8 explicitly: [Console]::In follows the console code page
# (CP949 etc.), which corrupts multibyte command payloads (e.g. Korean window
# titles) and breaks JSON parsing. A StreamReader over the raw handle is code-
# page independent.
$__stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
while ($true) {
  $line = $__stdin.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  $id = 0
  try {
    $req = $line | ConvertFrom-Json
    $id = [int]$req.id
    try { $res = Handle $req } finally { Invalidate-RefsForRequest $req }
    $out = @{ id = $id; ok = $true; result = $res } | ConvertTo-Json -Compress -Depth 6
  } catch {
    $out = @{ id = $id; ok = $false; error = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
  }
  [Console]::Out.WriteLine('${RESPONSE_MARKER}' + $out)
}
`;
