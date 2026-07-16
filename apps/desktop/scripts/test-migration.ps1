$ErrorActionPreference = 'Stop'
$root = Join-Path $env:TEMP "mixdog-migration-$([Guid]::NewGuid().ToString('N'))"
$legacyId = '5343bdcc-87a7-52f8-80e7-87b62e476a38'
$legacyDir = Join-Path $root 'Program Files\Mixdog'
$registryDir = Join-Path $root "registry\$legacyId"
$publicShortcut = Join-Path $root 'Users\Public\Desktop\Mixdog.lnk'
$startShortcut = Join-Path $root 'ProgramData\Microsoft\Windows\Start Menu\Programs\Mixdog.lnk'
$userData = Join-Path $root 'Users\tempe\.mixdog'
$uninstaller = Join-Path $legacyDir 'Uninstall Mixdog.ps1'

try {
  @($legacyDir, $registryDir, (Split-Path $publicShortcut), (Split-Path $startShortcut), $userData) |
    ForEach-Object { New-Item -ItemType Directory -Path $_ -Force | Out-Null }
  Set-Content -LiteralPath (Join-Path $legacyDir 'Mixdog.exe') -Value 'legacy'
  Set-Content -LiteralPath $publicShortcut -Value 'legacy shortcut'
  Set-Content -LiteralPath $startShortcut -Value 'legacy shortcut'
  Set-Content -LiteralPath (Join-Path $userData 'preserve.txt') -Value 'settings-auth-session'
  @'
param([Parameter(Mandatory)][string]$Root)
$ErrorActionPreference = 'Stop'
Remove-Item -LiteralPath (Join-Path $Root 'Users\Public\Desktop\Mixdog.lnk') -Force
Remove-Item -LiteralPath (Join-Path $Root 'ProgramData\Microsoft\Windows\Start Menu\Programs\Mixdog.lnk') -Force
Remove-Item -LiteralPath (Join-Path $Root 'registry') -Recurse -Force
Remove-Item -LiteralPath (Join-Path $Root 'Program Files\Mixdog') -Recurse -Force
'@ | Set-Content -LiteralPath $uninstaller
  Set-Content -LiteralPath (Join-Path $registryDir 'UninstallString.txt') -Value "`"$uninstaller`" -Root `"$root`""

  $env:MIXDOG_MIGRATION_TEST = '1'
  & (Join-Path $PSScriptRoot '..\build\migrate-legacy.ps1') -SimulationRoot $root
  if ($LASTEXITCODE -ne 0) { throw "Migration helper returned $LASTEXITCODE" }
  foreach ($removed in @($legacyDir, $registryDir, $publicShortcut, $startShortcut)) {
    if (Test-Path -LiteralPath $removed) { throw "Simulation remnant: $removed" }
  }
  if ((Get-Content -LiteralPath (Join-Path $userData 'preserve.txt') -Raw).Trim() -ne 'settings-auth-session') {
    throw 'Simulated .mixdog data was not preserved.'
  }
  Write-Output 'MIGRATION_SIMULATION=passed; LEGACY_REMNANTS=0; USER_DATA=preserved'
} finally {
  Remove-Item Env:MIXDOG_MIGRATION_TEST -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
