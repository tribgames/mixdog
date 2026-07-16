[CmdletBinding()]
param(
  [string]$SimulationRoot,
  [string]$LogPath
)

$ErrorActionPreference = 'Stop'
$legacyId = '5343bdcc-87a7-52f8-80e7-87b62e476a38'
$legacyRegistrySubKey = "Software\Microsoft\Windows\CurrentVersion\Uninstall\$legacyId"
$realMode = [string]::IsNullOrWhiteSpace($SimulationRoot)

function Write-MigrationLog([string]$Message) {
  if ([string]::IsNullOrWhiteSpace($LogPath)) { return }
  try {
    [IO.File]::WriteAllText($LogPath, $Message, [Text.UTF8Encoding]::new($false))
  } catch {
    # Logging must not hide the original migration result.
  }
}

trap {
  $details = ($_ | Format-List * -Force | Out-String).Trim()
  Write-MigrationLog $details
  [Console]::Error.WriteLine($details)
  exit 1
}

function Get-LegacyUninstallString {
  $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
    [Microsoft.Win32.RegistryHive]::LocalMachine,
    [Microsoft.Win32.RegistryView]::Registry64
  )
  $legacyKey = $null
  try {
    $legacyKey = $baseKey.OpenSubKey($legacyRegistrySubKey)
    if (-not $legacyKey) { throw "Legacy HKLM uninstall key is missing: $legacyRegistrySubKey" }
    return [string]$legacyKey.GetValue('UninstallString')
  } finally {
    if ($legacyKey) { $legacyKey.Dispose() }
    $baseKey.Dispose()
  }
}

function Test-LegacyUninstallKey {
  $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
    [Microsoft.Win32.RegistryHive]::LocalMachine,
    [Microsoft.Win32.RegistryView]::Registry64
  )
  $legacyKey = $null
  try {
    $legacyKey = $baseKey.OpenSubKey($legacyRegistrySubKey)
    return $null -ne $legacyKey
  } finally {
    if ($legacyKey) { $legacyKey.Dispose() }
    $baseKey.Dispose()
  }
}

if ($realMode) {
  $legacyDir = 'C:\Program Files\Mixdog'
  $legacyExe = Join-Path $legacyDir 'Mixdog.exe'
  $publicShortcut = 'C:\Users\Public\Desktop\Mixdog.lnk'
  $startShortcut = 'C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Mixdog.lnk'
  $uninstallString = Get-LegacyUninstallString

  Get-CimInstance Win32_Process |
    Where-Object { $_.Name -ieq 'Mixdog.exe' -and $_.ExecutablePath -ieq $legacyExe } |
    ForEach-Object {
      $process = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
      if ($process) {
        [void]$process.CloseMainWindow()
        if (-not $process.WaitForExit(10000)) {
          Stop-Process -Id $process.Id -Force -ErrorAction Stop
        }
      }
    }
} else {
  if ($env:MIXDOG_MIGRATION_TEST -ne '1') { throw 'Migration simulation requires MIXDOG_MIGRATION_TEST=1.' }
  $legacyDir = Join-Path $SimulationRoot 'Program Files\Mixdog'
  $legacyExe = Join-Path $legacyDir 'Mixdog.exe'
  $uninstallKey = Join-Path $SimulationRoot "registry\$legacyId"
  $publicShortcut = Join-Path $SimulationRoot 'Users\Public\Desktop\Mixdog.lnk'
  $startShortcut = Join-Path $SimulationRoot 'ProgramData\Microsoft\Windows\Start Menu\Programs\Mixdog.lnk'
  $uninstallString = Get-Content -LiteralPath (Join-Path $uninstallKey 'UninstallString.txt') -Raw
}

if (-not (Test-Path -LiteralPath $legacyExe)) { throw "Legacy executable is missing: $legacyExe" }
if ([string]::IsNullOrWhiteSpace($uninstallString)) { throw 'Official legacy uninstall command is empty.' }

$command = $uninstallString.Trim()
if ($command -match '^"([^"]+)"\s*(.*)$') {
  $uninstaller = $Matches[1]
  $arguments = $Matches[2]
} elseif ($command -match '^(.*?\.exe)\s*(.*)$') {
  $uninstaller = $Matches[1]
  $arguments = $Matches[2]
} else {
  throw "Cannot parse official legacy uninstall command: $command"
}

$legacyPrefix = [IO.Path]::GetFullPath($legacyDir).TrimEnd('\') + '\'
$uninstallerPath = [IO.Path]::GetFullPath($uninstaller)
if (-not $uninstallerPath.StartsWith($legacyPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to run a legacy uninstaller outside $legacyDir"
}

$argumentList = @()
if (-not [string]::IsNullOrWhiteSpace($arguments)) { $argumentList += $arguments }
if ($realMode) {
  $argumentList += '/S'
  $launchFile = $uninstallerPath
} elseif ([IO.Path]::GetExtension($uninstallerPath) -ieq '.ps1') {
  $argumentList = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$uninstallerPath`"") + $argumentList
  $launchFile = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
} else {
  $launchFile = $uninstallerPath
}
$process = Start-Process -FilePath $launchFile -ArgumentList $argumentList -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Official legacy uninstaller failed with exit $($process.ExitCode)." }

$removed = $false
$deadline = [DateTime]::UtcNow.AddSeconds(45)
do {
  $registryRemains = if ($realMode) { Test-LegacyUninstallKey } else { Test-Path -LiteralPath $uninstallKey }
  $directoryHasContents = if (Test-Path -LiteralPath $legacyDir) {
    @(Get-ChildItem -LiteralPath $legacyDir -Force -ErrorAction SilentlyContinue).Count -gt 0
  } else {
    $false
  }
  $remnants = @(
    $directoryHasContents,
    $registryRemains,
    (Test-Path -LiteralPath $publicShortcut),
    (Test-Path -LiteralPath $startShortcut)
  )
  if ($remnants -notcontains $true) {
    $removed = $true
    break
  }
  Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $deadline)

if (-not $removed) {
  throw 'Official legacy uninstall completed but protected legacy remnants remain.'
}

if (Test-Path -LiteralPath $legacyDir) {
  Remove-Item -LiteralPath $legacyDir -Force -ErrorAction SilentlyContinue
}
Write-MigrationLog 'MIGRATION_COMPLETED'
exit 0
