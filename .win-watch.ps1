[CmdletBinding()]
param(
  [string]$LogPath = (Join-Path $PSScriptRoot '.win-watch.log'),
  [ValidateRange(1, 86400)]
  [int]$DurationSeconds = 1800,
  # This is a polling interval, not a guaranteed window-detection latency.
  [ValidateRange(100, 60000)]
  [int]$PollMilliseconds = 500,
  # Titles and command lines can contain sensitive data; collect them only when requested.
  [switch]$IncludeSensitiveData
)

<#
Usage:
  .\.win-watch.ps1 [-LogPath <path>] [-DurationSeconds <seconds>]
                   [-PollMilliseconds <100-60000>] [-IncludeSensitiveData]
The log is appended to, never deleted.  Detection is polling-based; actual
latency can exceed PollMilliseconds.  Titles and command lines are redacted
unless -IncludeSensitiveData is supplied.
#>

if ($env:OS -ne 'Windows_NT') {
  throw 'This diagnostic requires Windows.'
}

$logDirectory = Split-Path -Parent ([IO.Path]::GetFullPath($LogPath))
if (-not (Test-Path -LiteralPath $logDirectory -PathType Container)) {
  throw "Log directory does not exist: $logDirectory"
}
$script:log = [IO.Path]::GetFullPath($LogPath)

if (-not ('WinWatchNative' -as [type])) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WinWatchNative {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
}

function Write-WatchLog([string]$Message) {
  Add-Content -LiteralPath $script:log -Value ("[{0}] {1}" -f (Get-Date).ToString('HH:mm:ss.fff'), $Message) -Encoding utf8
}

function ConvertTo-LogValue([string]$Value) {
  if ($null -eq $Value) { return '<unavailable>' }
  return $Value.Replace("`r", '\r').Replace("`n", '\n')
}

function Get-WindowSnapshot([IntPtr]$Handle) {
  $className = New-Object Text.StringBuilder 256
  $classLength = [WinWatchNative]::GetClassName($Handle, $className, $className.Capacity)
  $class = if ($classLength -gt 0) { $className.ToString() } else { '<unavailable>' }

  $rect = New-Object WinWatchNative+RECT
  $hasRect = [WinWatchNative]::GetWindowRect($Handle, [ref]$rect)
  $rectText = if ($hasRect) {
    '({0},{1})-({2},{3})' -f $rect.Left, $rect.Top, $rect.Right, $rect.Bottom
  } else {
    '<unavailable>'
  }

  [uint32]$processId = 0
  $threadId = [WinWatchNative]::GetWindowThreadProcessId($Handle, [ref]$processId)
  $processName = '<unavailable>'
  $processStart = ''
  $pidState = if ($threadId -gt 0 -and $processId -gt 0) { 'ok' } else { 'unavailable' }

  if ($pidState -eq 'ok') {
    try {
      $process = Get-Process -Id $processId -ErrorAction Stop
      $processName = $process.ProcessName
      try { $processStart = $process.StartTime.ToUniversalTime().Ticks } catch { $processStart = '' }
    } catch {
      $pidState = 'process-unavailable'
    }

    [uint32]$verifiedProcessId = 0
    $verifiedThreadId = [WinWatchNative]::GetWindowThreadProcessId($Handle, [ref]$verifiedProcessId)
    if ($verifiedThreadId -eq 0 -or $verifiedProcessId -ne $processId) {
      $pidState = 'pid-raced'
      $processId = 0
      $processName = '<unavailable>'
      $processStart = ''
    }
  }

  $title = '<redacted>'
  $commandLine = '<redacted>'
  if ($script:includeSensitive -and $pidState -eq 'ok') {
    $titleBuffer = New-Object Text.StringBuilder 512
    [void][WinWatchNative]::GetWindowText($Handle, $titleBuffer, $titleBuffer.Capacity)
    $capturedTitle = $titleBuffer.ToString()
    $cimProcess = $null
    $cimStart = ''
    $capturedCommandLine = $null
    try {
      $cimProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction Stop
      $capturedCommandLine = $cimProcess.CommandLine
      if ($null -ne $cimProcess.CreationDate) {
        $cimStart = $cimProcess.CreationDate.ToUniversalTime().Ticks
      }
    } catch {
      $cimProcess = $null
    }

    [uint32]$finalProcessId = 0
    $finalThreadId = [WinWatchNative]::GetWindowThreadProcessId($Handle, [ref]$finalProcessId)
    if ($finalThreadId -gt 0 -and $finalProcessId -eq $processId -and
        -not [string]::IsNullOrEmpty($processStart) -and $cimProcess -and $cimStart -eq $processStart) {
      $title = ConvertTo-LogValue $capturedTitle
      $commandLine = ConvertTo-LogValue $capturedCommandLine
    } else {
      $title = '<discarded>'
      $commandLine = '<discarded>'
      $pidState = 'sensitive-capture-discarded'
      $processId = 0
      $processName = '<unavailable>'
      $processStart = ''
    }
  }

  [pscustomobject]@{
    Handle = $Handle.ToInt64().ToString('X')
    ProcessId = $processId
    ProcessName = $processName
    Class = $class
    Rect = $rectText
    PidState = $pidState
    Title = $title
    CommandLine = $commandLine
    Identity = '{0}|{1}|{2}' -f $processId, $class, $processStart
  }
}

$script:includeSensitive = $IncludeSensitiveData.IsPresent
$script:known = @{}
$script:baseline = $true
$end = (Get-Date).AddSeconds($DurationSeconds)
Write-WatchLog ("watch started pollMs={0} sensitive={1}" -f $PollMilliseconds, $script:includeSensitive)

while ((Get-Date) -lt $end) {
  $script:current = @{}
  $callback = {
    param($handle, $ignored)
    try {
      if (-not [WinWatchNative]::IsWindowVisible($handle)) { return $true }

      $snapshot = Get-WindowSnapshot $handle
      $previous = $script:known[$snapshot.Handle]
      $script:current[$snapshot.Handle] = $snapshot
      if (-not $script:baseline -and ($null -eq $previous -or $previous.Identity -ne $snapshot.Identity)) {
        $reason = if ($null -eq $previous) { 'appeared' } else { 'handle-reused-or-identity-changed' }
        Write-WatchLog ("NEW reason={0} hwnd=0x{1} pid={2} pidState={3} process={4} class={5} rect={6} title='{7}' cmd='{8}'" -f $reason, $snapshot.Handle, $snapshot.ProcessId, $snapshot.PidState, (ConvertTo-LogValue $snapshot.ProcessName), (ConvertTo-LogValue $snapshot.Class), $snapshot.Rect, $snapshot.Title, $snapshot.CommandLine)
      }
    } catch {
      Write-WatchLog ("WARN snapshot failed hwnd=0x{0}: {1}" -f $handle.ToInt64().ToString('X'), (ConvertTo-LogValue $_.Exception.Message))
    }
    return $true
  }

  if (-not [WinWatchNative]::EnumWindows($callback, [IntPtr]::Zero)) {
    Write-WatchLog ("WARN EnumWindows failed win32={0}" -f [Runtime.InteropServices.Marshal]::GetLastWin32Error())
  }
  $script:known = $script:current
  $script:baseline = $false
  if ((Get-Date) -lt $end) { Start-Sleep -Milliseconds $PollMilliseconds }
}

Write-WatchLog 'watch finished'
