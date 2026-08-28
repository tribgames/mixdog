$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$env:MIXDOG_OFFICE_HOST_LIBRARY = '1'
. (Join-Path $PSScriptRoot 'office-com-host.ps1')
Remove-Item Env:MIXDOG_OFFICE_HOST_LIBRARY -ErrorAction SilentlyContinue

if (-not ('MixdogOfficeInterop' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

public static class MixdogOfficeInterop
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("ole32.dll")]
    private static extern int GetRunningObjectTable(int reserved, out IRunningObjectTable runningObjectTable);

    [DllImport("ole32.dll")]
    private static extern int CreateBindCtx(int reserved, out IBindCtx bindContext);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern IntPtr SendMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint attachThreadId, uint attachToThreadId, bool attach);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(IntPtr hWnd, int command);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    private static string NormalizePath(string value)
    {
        if (String.IsNullOrWhiteSpace(value)) return String.Empty;
        value = value.Trim();
        while (value.StartsWith("!", StringComparison.Ordinal)) value = value.Substring(1);
        Uri uri;
        if (Uri.TryCreate(value, UriKind.Absolute, out uri) && uri.IsFile) value = uri.LocalPath;
        try { return Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar); }
        catch { return String.Empty; }
    }

    public static object TryGetRunningFile(string path)
    {
        IRunningObjectTable table = null;
        IBindCtx context = null;
        IEnumMoniker enumerator = null;
        try
        {
            if (GetRunningObjectTable(0, out table) != 0 || table == null) return null;
            if (CreateBindCtx(0, out context) != 0 || context == null) return null;
            table.EnumRunning(out enumerator);
            if (enumerator == null) return null;
            enumerator.Reset();
            string expected = NormalizePath(path);
            IMoniker[] monikers = new IMoniker[1];
            while (enumerator.Next(1, monikers, IntPtr.Zero) == 0)
            {
                IMoniker moniker = monikers[0];
                try
                {
                    string displayName;
                    moniker.GetDisplayName(context, null, out displayName);
                    if (!String.Equals(NormalizePath(displayName), expected, StringComparison.OrdinalIgnoreCase)) continue;
                    object value;
                    table.GetObject(moniker, out value);
                    return value;
                }
                catch { }
                finally
                {
                    if (moniker != null && Marshal.IsComObject(moniker)) Marshal.ReleaseComObject(moniker);
                }
            }
            return null;
        }
        finally
        {
            if (enumerator != null && Marshal.IsComObject(enumerator)) Marshal.ReleaseComObject(enumerator);
            if (context != null && Marshal.IsComObject(context)) Marshal.ReleaseComObject(context);
            if (table != null && Marshal.IsComObject(table)) Marshal.ReleaseComObject(table);
        }
    }

    public static void RegisterExcelInstances()
    {
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            StringBuilder className = new StringBuilder(64);
            GetClassName(hWnd, className, className.Capacity);
            if (String.Equals(className.ToString(), "XLMAIN", StringComparison.OrdinalIgnoreCase))
            {
                SendMessage(hWnd, 0x0400u + 18u, IntPtr.Zero, IntPtr.Zero);
            }
            return true;
        }, IntPtr.Zero);
    }

    public static int ProcessIdForWindow(long hWnd)
    {
        uint processId;
        GetWindowThreadProcessId(new IntPtr(hWnd), out processId);
        return unchecked((int)processId);
    }

    public static long FindWindowByClassAndTitle(string expectedClass, string titlePart)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            if (!IsWindowVisible(hWnd)) return true;
            StringBuilder className = new StringBuilder(64);
            GetClassName(hWnd, className, className.Capacity);
            if (!String.Equals(className.ToString(), expectedClass, StringComparison.OrdinalIgnoreCase)) return true;
            StringBuilder title = new StringBuilder(1024);
            GetWindowText(hWnd, title, title.Capacity);
            if (title.ToString().IndexOf(titlePart, StringComparison.OrdinalIgnoreCase) < 0) return true;
            found = hWnd;
            return false;
        }, IntPtr.Zero);
        return found.ToInt64();
    }

    public static bool ActivateWindow(long hWnd)
    {
        IntPtr target = new IntPtr(hWnd);
        if (target == IntPtr.Zero) return false;
        uint ignored;
        uint currentThread = GetCurrentThreadId();
        uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out ignored);
        uint targetThread = GetWindowThreadProcessId(target, out ignored);
        bool attachedForeground = false;
        bool attachedTarget = false;
        try
        {
            if (foregroundThread != 0 && foregroundThread != currentThread)
                attachedForeground = AttachThreadInput(currentThread, foregroundThread, true);
            if (targetThread != 0 && targetThread != currentThread)
                attachedTarget = AttachThreadInput(currentThread, targetThread, true);
            ShowWindowAsync(target, IsIconic(target) ? 9 : 5);
            BringWindowToTop(target);
            SetForegroundWindow(target);
            return GetForegroundWindow() == target;
        }
        finally
        {
            if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
            if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
        }
    }
}
'@
}

function Session-Response($state, $value) {
  $result = [ordered]@{
    ok = $true
    session = [string]$state.Id
    mode = [string]$state.Mode
    backend = 'microsoft-office-com'
  }
  foreach ($entry in $value.GetEnumerator()) { $result[$entry.Key] = $entry.Value }
  return $result
}

function Same-DocumentPath($document, [string]$path) {
  try {
    return [string]::Equals(
      [System.IO.Path]::GetFullPath([string]$document.FullName),
      [System.IO.Path]::GetFullPath($path),
      [System.StringComparison]::OrdinalIgnoreCase
    )
  } catch {
    return $false
  }
}

function Find-RunningDocumentExact([string]$format, [string]$path) {
  if ($format -eq 'xlsx') { [MixdogOfficeInterop]::RegisterExcelInstances() }
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    $candidate = [MixdogOfficeInterop]::TryGetRunningFile($path)
    if ($null -ne $candidate) {
      if (Same-DocumentPath $candidate $path) { return $candidate }
      try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($candidate) } catch {}
    }
    Start-Sleep -Milliseconds 100
  }
  $app = Active-Application (ProgId-ForFormat $format)
  if ($null -eq $app) { return $null }
  try {
    return Find-OpenDocument $app $format $path
  } finally {
    try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch {}
  }
}

function File-AppearsOpen([string]$path) {
  $stream = $null
  try {
    $stream = [System.IO.File]::Open(
      $path,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None
    )
    return $false
  } catch {
    return $true
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
  }
}

function New-OfficeApplication([string]$format, [bool]$visible) {
  $app = New-Object -ComObject (ProgId-ForFormat $format)
  try { $app.DisplayAlerts = 0 } catch {}
  try { $app.AutomationSecurity = 3 } catch {}
  if ($format -ne 'pptx') {
    try { $app.Visible = $visible } catch {}
  }
  return $app
}

function Set-OfficeVisible($app, $document, [string]$format) {
  try { $app.Visible = $true } catch {}
  switch ($format) {
    'docx' { try { $document.ActiveWindow.Visible = $true } catch {} }
    'xlsx' { try { $document.Windows.Item(1).Visible = $true } catch {} }
  }
}

function Open-OwnedDocument($app, [string]$format, [string]$path, [bool]$visible) {
  switch ($format) {
    'docx' { $document = $app.Documents.Open($path) }
    'xlsx' {
      $document = $app.Workbooks.Open($path)
      try { $app.CalculateFullRebuild() } catch {}
    }
    'pptx' { $document = $app.Presentations.Open($path, $false, $false, $visible) }
  }
  if ($visible) { Set-OfficeVisible $app $document $format }
  return $document
}

function Create-OwnedDocument($app, [string]$format, [string]$path, [bool]$visible) {
  $saveFormat = Office-SaveFormatForPath $format $path
  switch ($format) {
    'docx' {
      $document = $app.Documents.Add()
      try { $document.SaveAs2($path, $saveFormat) } catch { $document.SaveAs($path, $saveFormat) }
    }
    'xlsx' {
      $document = $app.Workbooks.Add()
      $document.SaveAs($path, $saveFormat)
    }
    'pptx' {
      $document = $app.Presentations.Add()
      $document.SaveAs($path, $saveFormat)
    }
  }
  if ($visible) { Set-OfficeVisible $app $document $format }
  return $document
}

function Application-Hwnd($app, $document, [string]$format) {
  if ($format -eq 'docx' -and $null -ne $document) {
    try {
      $hWnd = [long]$document.ActiveWindow.Hwnd
      if ($hWnd) { return $hWnd }
    } catch {}
  }
  if ($format -eq 'pptx' -and $null -ne $document) {
    try {
      $hWnd = [long]$document.Windows.Item(1).HWND
      if ($hWnd) { return $hWnd }
    } catch {}
  }
  try {
    $hWnd = [long]$app.Hwnd
    if ($hWnd) { return $hWnd }
  } catch {}
  try {
    $hWnd = [long]$app.HWND
    if ($hWnd) { return $hWnd }
  } catch {}
  if ($format -eq 'pptx' -and $null -ne $document) {
    try {
      $title = [System.IO.Path]::GetFileName([string]$document.FullName)
      $hWnd = [long][MixdogOfficeInterop]::FindWindowByClassAndTitle('PPTFrameClass', $title)
      if ($hWnd) { return $hWnd }
    } catch {}
  }
  return 0
}

function Set-OfficeForeground([long]$hWnd) {
  if (-not $hWnd) { return $false }
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    try {
      if ([MixdogOfficeInterop]::ActivateWindow($hWnd)) { return $true }
    } catch {
      return $false
    }
    Start-Sleep -Milliseconds 50
  }
  return $false
}

function Open-SessionState($payload) {
  $id = [string]$payload.session
  if ([string]::IsNullOrWhiteSpace($id)) { throw 'open_session requires session' }
  $format = ([string]$payload.format).ToLowerInvariant()
  if (@('docx', 'xlsx', 'pptx') -notcontains $format) { throw "Unsupported Office session format: $format" }
  $path = [System.IO.Path]::GetFullPath([string]$payload.path)
  $mode = ([string]$payload.mode).ToLowerInvariant()
  if ($mode -eq 'live') { $mode = 'attach' }
  if (@('attach', 'visible', 'background') -notcontains $mode) { throw "Unsupported Office session mode: $mode" }
  $create = [bool]$payload.create
  if ($create -and $mode -eq 'attach') { throw 'create does not support attach mode' }

  $app = $null
  $document = $null
  $ownership = 'owned'
  try {
    if (-not $create -and @('attach', 'visible') -contains $mode) {
      $document = Find-RunningDocumentExact $format $path
      if ($null -ne $document) {
        $app = $document.Application
        $ownership = 'attached'
      } elseif ($mode -eq 'attach') {
        throw "The exact document is not registered as open in Microsoft Office: $path"
      } elseif (File-AppearsOpen $path) {
        throw "The document appears open but its exact COM object is unavailable; refusing to open a duplicate: $path"
      }
    }

    if ($null -eq $document) {
      if ($create) {
        if ((Test-Path -LiteralPath $path) -and -not [bool]$payload.overwrite) {
          throw "Office create target already exists: $path"
        }
        $directory = [System.IO.Path]::GetDirectoryName($path)
        if ($directory) { [System.IO.Directory]::CreateDirectory($directory) | Out-Null }
      } elseif (-not (Test-Path -LiteralPath $path)) {
        throw "Office document not found: $path"
      }
      $visible = $mode -eq 'visible'
      $app = New-OfficeApplication $format $visible
      $document = if ($create) {
        Create-OwnedDocument $app $format $path $visible
      } else {
        Open-OwnedDocument $app $format $path $visible
      }
    } elseif ($mode -eq 'visible') {
      Set-OfficeVisible $app $document $format
    }

    $hWnd = Application-Hwnd $app $document $format
    if ($mode -eq 'visible' -and $format -eq 'pptx') {
      for ($attempt = 0; -not $hWnd -and $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 100
        $hWnd = Application-Hwnd $app $document $format
      }
    }
    $foregroundActivated = $mode -eq 'visible' -and $format -eq 'pptx' -and (Set-OfficeForeground $hWnd)
    $processId = if ($hWnd) { [MixdogOfficeInterop]::ProcessIdForWindow($hWnd) } else { 0 }
    return [pscustomobject]@{
      Id = $id
      Format = $format
      Path = $path
      Mode = $mode
      Ownership = $ownership
      App = $app
      Document = $document
      Visible = $mode -ne 'background'
      AppPid = $processId
      WindowHwnd = $hWnd
      ForegroundActivated = [bool]$foregroundActivated
      DocumentId = "${format}:$($path.ToLowerInvariant())"
    }
  } catch {
    if ($null -ne $document) {
      if ($ownership -eq 'owned') { try { $document.Close($false) } catch {} }
      try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($document) } catch {}
    }
    if ($null -ne $app) {
      if ($ownership -eq 'owned') { try { $app.Quit() } catch {} }
      try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch {}
    }
    throw
  }
}

function Close-SessionState($state, [bool]$save) {
  if ($save) { Save-Document $state.Document $state.Format }
  $process = $null
  if ($state.Ownership -eq 'owned' -and [int]$state.AppPid -gt 0) {
    try { $process = [System.Diagnostics.Process]::GetProcessById([int]$state.AppPid) } catch {}
  }
  if ($state.Ownership -eq 'owned') {
    try { $state.Document.Close($false) } catch {}
  }
  try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($state.Document) } catch {}
  $state.Document = $null
  if ($state.Ownership -eq 'owned') {
    try { $state.App.Quit() } catch {}
  }
  try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($state.App) } catch {}
  $state.App = $null
  $exited = $null -eq $process
  if (-not $exited) {
    try { $exited = [bool]$process.WaitForExit(250) } catch { $exited = $true }
  }
  if (-not $exited) {
    try {
      $process.Kill()
      $exited = [bool]$process.WaitForExit(1000)
    } catch {}
  }
  if ($null -ne $process) { try { $process.Dispose() } catch {} }
}

function Reopen-BackgroundExcelSession($state, [string]$restorePath = '') {
  if ($state.Format -ne 'xlsx' -or $state.Mode -ne 'background' -or $state.Ownership -ne 'owned') {
    throw 'Full-file Excel restore is available only for owned background sessions'
  }
  $current = $state.Document
  try { $current.Close($false) } finally {
    try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($current) } catch {}
    $state.Document = $null
  }
  if (-not [string]::IsNullOrWhiteSpace($restorePath)) {
    [System.IO.File]::Copy([System.IO.Path]::GetFullPath($restorePath), [System.IO.Path]::GetFullPath($state.Path), $true)
  }
  $state.Document = $state.App.Workbooks.Open($state.Path)
  try { $state.App.CalculateFullRebuild() } catch {}
}

function Reopen-BackgroundPowerPointSession($state, [string]$restorePath = '') {
  if ($state.Format -ne 'pptx' -or $state.Mode -ne 'background' -or $state.Ownership -ne 'owned') {
    throw 'PowerPoint process reopen is available only for owned background sessions'
  }
  if ($null -ne $state.Document) {
    try { $state.Document.Close() } finally {
      try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($state.Document) } catch {}
      $state.Document = $null
    }
  }
  if ($null -ne $state.App) {
    try { $state.App.Quit() } catch {}
    try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($state.App) } catch {}
    $state.App = $null
  }
  if (-not [string]::IsNullOrWhiteSpace($restorePath)) {
    [System.IO.File]::Copy(
      [System.IO.Path]::GetFullPath($restorePath),
      [System.IO.Path]::GetFullPath($state.Path),
      $true
    )
  }
  $state.App = New-OfficeApplication 'pptx' $false
  $state.Document = Open-OwnedDocument $state.App 'pptx' $state.Path $false
  $state.WindowHwnd = Application-Hwnd $state.App $state.Document 'pptx'
  $state.AppPid = if ($state.WindowHwnd) {
    [MixdogOfficeInterop]::ProcessIdForWindow([long]$state.WindowHwnd)
  } else {
    0
  }
  return $state.Document
}

function Invoke-SessionAction($state, $payload) {
  $document = $state.Document
  $format = $state.Format
  switch ([string]$payload.action) {
    'snapshot' {
      $value = Snapshot-Document $document $format $payload
      return Session-Response $state ([ordered]@{ value = $value })
    }
    'issues' {
      $wasSaved = [bool]$document.Saved
      $value = Issues-Document $document $format $payload
      if ($wasSaved -and -not [bool]$document.Saved) { $document.Saved = $true }
      return Session-Response $state ([ordered]@{ value = $value })
    }
    'validate' {
      # The persistent session already proves that the exact document is open.
      # Starting a second Word/Excel/PowerPoint COM application can bind to the
      # same process; quitting that validator then destroys this live session.
      $wasSaved = [bool]$document.Saved
      $snapshot = Snapshot-Document $document $format ([ordered]@{})
      $inspection = if ($null -ne $payload.inspectIssues -and -not [bool]$payload.inspectIssues) {
        [ordered]@{ ok = $true; issueCount = 0; issues = @() }
      } else {
        Issues-Document $document $format ([ordered]@{})
      }
      if ($wasSaved -and -not [bool]$document.Saved) { $document.Saved = $true }
      $value = [ordered]@{
        ok = [bool]$inspection.ok
        opened = $true
        issueCount = [int]$inspection.issueCount
        issues = @($inspection.issues)
        snapshotFingerprint = Snapshot-Fingerprint $snapshot
        documentSaved = [bool]$document.Saved
      }
      return Session-Response $state ([ordered]@{ value = $value })
    }
    'checkpoint' {
      $output = [System.IO.Path]::GetFullPath([string]$payload.output)
      $value = Snapshot-Document $document $format $payload
      if ($format -eq 'docx') {
        return Session-Response $state ([ordered]@{
          fingerprint = Snapshot-Fingerprint $value
          saved = [bool]$document.Saved
          value = $value
        })
      }
      Save-DocumentCopy $document $format $output
      return Session-Response $state ([ordered]@{
        output = $output
        saved = [bool]$document.Saved
        value = $value
      })
    }
    'save_copy' {
      $output = [System.IO.Path]::GetFullPath([string]$payload.output)
      Save-DocumentCopy $document $format $output
      return Session-Response $state ([ordered]@{
        output = $output
        saved = [bool]$document.Saved
      })
    }
    'replace_presentation_from_source' {
      if ($format -ne 'pptx' -or $state.Mode -ne 'background' -or $state.Ownership -ne 'owned') {
        throw 'PowerPoint source replacement is available only for owned background sessions'
      }
      $sourcePath = [System.IO.Path]::GetFullPath([string]$payload.source)
      $checkpoint = [System.IO.Path]::GetFullPath([string]$payload.checkpoint)
      $current = $state.Document
      try {
        $current.Close()
        try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($current) } catch {}
        $state.Document = $null
        $document = $state.App.Presentations.Open($sourcePath, $false, $false, $false)
        $state.Document = $document
        $document.SaveAs($state.Path, (Office-SaveFormatForPath 'pptx' $state.Path))
        $sourceSlideCount = [int]$document.Slides.Count
        $selected = if ($payload.slides) {
          @($payload.slides | ForEach-Object { [int]$_ })
        } else {
          if ($sourceSlideCount -le 0) { @() } else { @(1..$sourceSlideCount) }
        }
        if (@($selected | Where-Object { $_ -lt 1 -or $_ -gt $sourceSlideCount }).Count -gt 0) {
          throw "import_slides selection is outside source deck range 1-$sourceSlideCount"
        }
        $identitySelection = $selected.Count -eq $sourceSlideCount
        if ($identitySelection) {
          for ($identityIndex = 1; $identityIndex -le $sourceSlideCount; $identityIndex++) {
            if ([int]$selected[$identityIndex - 1] -ne $identityIndex) {
              $identitySelection = $false
              break
            }
          }
        }
        if (-not $identitySelection) {
          $sourceIds = @{}
          $keep = @{}
          foreach ($slideNumber in $selected) {
            if (-not $keep.ContainsKey([int]$slideNumber)) {
              $keep[[int]$slideNumber] = $true
              $sourceIds[[int]$slideNumber] = [int]$document.Slides.Item([int]$slideNumber).SlideID
            }
          }
          for ($slideIndex = $sourceSlideCount; $slideIndex -ge 1; $slideIndex--) {
            if (-not $keep.ContainsKey($slideIndex)) { $document.Slides.Item($slideIndex).Delete() }
          }
          $placed = @{}
          for ($targetIndex = 1; $targetIndex -le $selected.Count; $targetIndex++) {
            $sourceSlide = [int]$selected[$targetIndex - 1]
            $sourceId = [int]$sourceIds[$sourceSlide]
            if (-not $placed.ContainsKey($sourceSlide)) {
              $document.Slides.FindBySlideID($sourceId).MoveTo($targetIndex)
              $placed[$sourceSlide] = $true
            } else {
              $duplicates = $document.Slides.FindBySlideID($sourceId).Duplicate()
              $duplicates.Item(1).MoveTo($targetIndex)
            }
          }
        }
        Save-Document $document $format
        $null = Reopen-BackgroundPowerPointSession $state
        $document = $state.Document
        $value = Snapshot-Document $document $format ([ordered]@{})
        return Session-Response $state ([ordered]@{
          saved = $true
          results = @([ordered]@{
            op = 'import_slides'
            changed = $true
            count = [int]$selected.Count
            source = $sourcePath
            replacedEmptyDeck = $true
          })
          value = $value
        })
      } catch {
        $line = [int]$_.InvocationInfo.ScriptLineNumber
        $message = $_.Exception.Message
        if ($null -ne $state.Document) {
          try { $state.Document.Close() } catch {}
          try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($state.Document) } catch {}
          $state.Document = $null
        }
        $restoreWarning = ''
        try {
          $restorePath = if (Test-Path -LiteralPath $checkpoint) { $checkpoint } else { '' }
          $null = Reopen-BackgroundPowerPointSession $state $restorePath
        } catch {
          $restoreWarning = " Restore reopen failed: $($_.Exception.Message)"
        }
        throw "replace_presentation_from_source failed at office-com-session-host.ps1:$line`: $message$restoreWarning"
      }
    }
    'batch' {
      $excelCheckpoint = ''
      if ($format -eq 'xlsx') {
        $extension = [System.IO.Path]::GetExtension($state.Path)
        $excelCheckpoint = Join-Path ([System.IO.Path]::GetTempPath()) "mixdog-excel-batch-$([guid]::NewGuid().ToString('N'))$extension"
        Save-DocumentCopy $document $format $excelCheckpoint
      }
      try {
        $applied = Apply-Operations $document $format $payload.operations $true ([bool]$payload.requireChanges)
        $shouldSave = $state.Mode -eq 'background' -or [bool]$payload.save
        if ($shouldSave) { Save-Document $document $format }
        return Session-Response $state ([ordered]@{
          saved = $shouldSave
          results = $applied.results
          undoUnits = $applied.undoUnits
        })
      } catch {
        if ($excelCheckpoint) {
          try {
            if ($state.Mode -eq 'background' -and $state.Ownership -eq 'owned') {
              Reopen-BackgroundExcelSession $state
            } else {
              Restore-ExcelCheckpoint $document $excelCheckpoint
            }
          } catch {}
        }
        throw
      } finally {
        if ($excelCheckpoint) { Remove-Item $excelCheckpoint -Force -ErrorAction SilentlyContinue }
      }
    }
    'rollback' {
      if ($format -eq 'xlsx' -and $state.Mode -eq 'background' -and $state.Ownership -eq 'owned') {
        Reopen-BackgroundExcelSession $state ([string]$payload.checkpoint)
        $document = $state.Document
      } else {
        Rollback-LiveDocument $document $format ([string]$payload.checkpoint) ([int]$payload.undoUnits)
      }
      $value = Snapshot-Document $document $format $payload
      if ($state.Mode -eq 'background') { Save-Document $document $format }
      return Session-Response $state ([ordered]@{ rolledBack = $true; value = $value })
    }
    'save' {
      Save-Document $document $format
      return Session-Response $state ([ordered]@{ saved = $true; path = $state.Path })
    }
    'render' {
      $output = [System.IO.Path]::GetFullPath([string]$payload.output)
      $wasSaved = [bool]$document.Saved
      Render-Document $document $format $output
      if ($wasSaved -and -not [bool]$document.Saved) { $document.Saved = $true }
      return Session-Response $state ([ordered]@{ output = $output })
    }
    default { throw "Unsupported Office session action: $($payload.action)" }
  }
}

$state = $null
try {
  while ($null -ne ($raw = [Console]::In.ReadLine())) {
    if ([string]::IsNullOrWhiteSpace($raw)) { continue }
    $requestId = ''
    $closeAfterResponse = $false
    $stateToClose = $null
    try {
      $payload = $raw | ConvertFrom-Json
      $requestId = [string]$payload.requestId
      if ($payload.action -eq 'open_session') {
        if ($null -ne $state) { throw 'Office session is already open in this host' }
        $state = Open-SessionState $payload
        $result = Session-Response $state ([ordered]@{
          opened = $true
          ownership = $state.Ownership
          visible = $state.Visible
          appPid = $state.AppPid
          windowHwnd = $state.WindowHwnd
          foregroundActivated = $state.ForegroundActivated
          documentId = $state.DocumentId
          path = $state.Path
        })
      } else {
        if ($null -eq $state) { throw 'Office session host has no open document' }
        if ([string]$payload.session -ne [string]$state.Id) { throw 'Office session id does not match this host' }
        if ($payload.action -eq 'close_session') {
          if ([bool]$payload.save) { Save-Document $state.Document $state.Format }
          $result = Session-Response $state ([ordered]@{
            closed = $true
            saved = [bool]$payload.save
            ownership = $state.Ownership
            appPid = $state.AppPid
            path = $state.Path
          })
          $stateToClose = $state
          $state = $null
          $closeAfterResponse = $true
        } else {
          $result = Invoke-SessionAction $state $payload
        }
      }
    } catch {
      $result = [ordered]@{
        ok = $false
        backend = 'microsoft-office-com'
        error = [string]$_.Exception.Message
      }
    }
    if ($requestId) { $result['requestId'] = $requestId }
    Emit-Json $result
    if ($closeAfterResponse) {
      try { Close-SessionState $stateToClose $false } catch {}
      break
    }
  }
} finally {
  if ($null -ne $state) {
    try { Close-SessionState $state $false } catch {}
  }
}
