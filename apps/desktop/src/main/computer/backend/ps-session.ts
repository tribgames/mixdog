/**
 * Worker prelude: assembly loading with its build cache, the compiled Win32/UIA types, per-session state, and exact window resolution.
 *
 * PowerShell source for the resident Computer Use worker. It is one program
 * split by capability; the pieces are joined in file order, so a line here
 * keeps the meaning it had in the whole.
 */
import { MIXDOG_HOST_CSHARP } from './native-source';

export const PS_SESSION = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName Accessibility
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$AccessibilityAssemblyPath = [Accessibility.IAccessible].Assembly.Location
$MixdogHostSource = @"
${MIXDOG_HOST_CSHARP}
"@
$MixdogHostRefs = @('System.dll','System.Core.dll','System.Drawing.dll',$AccessibilityAssemblyPath)
$MixdogHostCacheDir = [string]$env:MIXDOG_COMPUTER_HOST_CACHE
$MixdogHostBuild = [string]$env:MIXDOG_COMPUTER_HOST_BUILD
$MixdogHostAssembly = ''
if ($MixdogHostCacheDir -and $MixdogHostBuild) {
  $MixdogHostAssembly = Join-Path $MixdogHostCacheDir ('mixdog-computer-host-' + $MixdogHostBuild + '.dll')
}
$MixdogHostLoaded = $false
# Loading the cached assembly skips the C# compile that every new worker would
# otherwise repeat; a miss compiles once and publishes it for the next worker.
if ($MixdogHostAssembly -and (Test-Path -LiteralPath $MixdogHostAssembly)) {
  try { Add-Type -Path $MixdogHostAssembly; $MixdogHostLoaded = $true } catch { $MixdogHostLoaded = $false }
}
if (-not $MixdogHostLoaded -and $MixdogHostAssembly) {
  try {
    New-Item -ItemType Directory -Force -Path $MixdogHostCacheDir | Out-Null
    $MixdogHostStaging = $MixdogHostAssembly + '.' + [string]$PID + '.tmp'
    Add-Type -ReferencedAssemblies $MixdogHostRefs -TypeDefinition $MixdogHostSource -OutputAssembly $MixdogHostStaging
    # A concurrent worker may publish the same build first; either file works.
    Move-Item -LiteralPath $MixdogHostStaging -Destination $MixdogHostAssembly -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $MixdogHostStaging) {
      Remove-Item -LiteralPath $MixdogHostStaging -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $MixdogHostAssembly) {
      Add-Type -Path $MixdogHostAssembly
      $MixdogHostLoaded = $true
    }
  } catch { $MixdogHostLoaded = $false }
}
if (-not $MixdogHostLoaded) {
  Add-Type -ReferencedAssemblies $MixdogHostRefs -TypeDefinition $MixdogHostSource
}
[void][MixWin32]::MakeDpiAware()
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$Walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$Sessions = @{}
$script:CurrentSession = $null

function Get-SessionState($id) {
  $key = if ($id) { [string]$id } else { 'default' }
  if (-not $Sessions.ContainsKey($key)) {
    $Sessions[$key] = @{
      Map = @{}
      Generation = 0
      Continuation = $null
      LastFocus = [IntPtr]::Zero
      OriginalFocus = [IntPtr]::Zero
    }
  }
  return $Sessions[$key]
}

function Get-CurrentSession {
  if ($null -eq $script:CurrentSession) { throw 'computer session is not initialized' }
  return $script:CurrentSession
}

function Await-WinRt($operation, [Type]$resultType) {
  if ($null -eq $script:WinRtAsTaskGeneric) {
    $script:WinRtAsTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
      Where-Object {
        $_.Name -eq 'AsTask' -and
        $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name.StartsWith('IAsyncOperation')
      })[0]
  }
  $asTask = $script:WinRtAsTaskGeneric.MakeGenericMethod($resultType)
  $task = $asTask.Invoke($null, @($operation))
  $task.Wait(-1) | Out-Null
  return $task.Result
}

function Resolve-WindowInfo($title, $windowId) {
  if ($windowId) {
    $handle = [MixWin32]::ParseWindowId([string]$windowId)
    if (-not [MixWin32]::IsWindowHandle($handle)) { throw "window_id is stale or invalid: $windowId" }
    return [MixWin32]::Info($handle)
  }
  if (-not $title) {
    $handle = [MixWin32]::Foreground()
    if (-not [MixWin32]::IsWindowHandle($handle)) { throw 'foreground window not found' }
    return [MixWin32]::Info($handle)
  }
  $exact = New-Object System.Collections.ArrayList
  $partial = New-Object System.Collections.ArrayList
  foreach ($info in [MixWin32]::Windows()) {
    if ($info.Title -eq $title) { [void]$exact.Add($info) }
    elseif ($info.Title -and $info.Title.ToLower().Contains(([string]$title).ToLower())) { [void]$partial.Add($info) }
  }
  if ($exact.Count -eq 1) { return $exact[0] }
  if ($exact.Count -gt 1) {
    $ids = @($exact | ForEach-Object { $_.Id }) -join ' | '
    throw "window title is ambiguous: $title (ids: $ids); use window_id"
  }
  if ($partial.Count -eq 1) { return $partial[0] }
  if ($partial.Count -gt 1) {
    $matches = @($partial | ForEach-Object { "$($_.Id) $($_.Title)" }) -join ' | '
    throw "window title is ambiguous: $title (matches: $matches); use window_id"
  }
  throw "window not found: $title"
}

function Find-Window($title, $windowId) {
  $info = Resolve-WindowInfo $title $windowId
  try { return $AE::FromHandle($info.Handle) } catch { throw "window has no UI Automation root: $($info.Id) $($info.Title)" }
}

`;
