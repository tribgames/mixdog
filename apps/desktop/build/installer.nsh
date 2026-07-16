!define LEGACY_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\5343bdcc-87a7-52f8-80e7-87b62e476a38"
!define LEGACY_EXE "$PROGRAMFILES64\Mixdog\Mixdog.exe"

!macro abortLegacyMigration message
  MessageBox MB_OK|MB_ICONSTOP "${message}$\r$\n$\r$\nThe new per-user Mixdog was not installed. Your .mixdog data was not changed."
  Abort
!macroend

!macro customInit
  SetRegView 64
  ReadRegStr $R0 HKLM "${LEGACY_UNINSTALL_KEY}" "UninstallString"
  IfFileExists "${LEGACY_EXE}" 0 legacyExeMissing
    StrCmp $R0 "" 0 legacyDetected
    !insertmacro abortLegacyMigration "The legacy Program Files Mixdog exists, but its official HKLM uninstaller is missing."

  legacyExeMissing:
    StrCmp $R0 "" legacyMigrationDone
    !insertmacro abortLegacyMigration "The legacy Mixdog HKLM uninstall entry exists, but C:\Program Files\Mixdog\Mixdog.exe is missing."

  legacyDetected:
    ${StdUtils.TestParameter} $R1 "acceptLegacyMigration"
    StrCmp $R1 "true" legacyMigrationAccepted
    IfSilent legacyMigrationCancelled
    MessageBox MB_YESNO|MB_ICONEXCLAMATION \
      "An older all-users Mixdog is installed in C:\Program Files\Mixdog.$\r$\n$\r$\nSetup must request administrator permission, close only that legacy Mixdog process, and run its official uninstaller before installing the new per-user app.$\r$\n$\r$\nYour .mixdog settings, authentication, and sessions will be preserved.$\r$\n$\r$\nContinue?" \
      IDYES legacyMigrationAccepted IDNO legacyMigrationCancelled

  legacyMigrationCancelled:
    !insertmacro abortLegacyMigration "Legacy Mixdog migration was cancelled or was not explicitly accepted."

  legacyMigrationAccepted:
    InitPluginsDir
    File /oname=$PLUGINSDIR\migrate-legacy.ps1 "${BUILD_RESOURCES_DIR}\migrate-legacy.ps1"
    File /oname=$PLUGINSDIR\elevate.exe "${NSISDIR}\elevate.exe"
    Delete "$TEMP\MixdogMigration.log"
    nsExec::ExecToStack /TIMEOUT=600000 '"$PLUGINSDIR\elevate.exe" -wait "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\migrate-legacy.ps1" -LogPath "$TEMP\MixdogMigration.log"'
    Pop $R2
    Pop $R3
    StrCmp $R2 "0" legacyVerify
    !insertmacro abortLegacyMigration "Administrator approval was cancelled or legacy Mixdog migration failed (exit $R2). Details: $TEMP\MixdogMigration.log"

  legacyVerify:
    ReadRegStr $R0 HKLM "${LEGACY_UNINSTALL_KEY}" "UninstallString"
    StrCmp $R0 "" 0 legacyVerificationFailed
    IfFileExists "$PROGRAMFILES64\Mixdog\*.*" legacyVerificationFailed
    IfFileExists "C:\Users\Public\Desktop\Mixdog.lnk" legacyVerificationFailed
    IfFileExists "C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Mixdog.lnk" legacyVerificationFailed
    Goto legacyMigrationDone

  legacyVerificationFailed:
    !insertmacro abortLegacyMigration "Legacy Mixdog removal could not be verified. Protected files or its HKLM uninstall entry remain. Details: $TEMP\MixdogMigration.log"

  legacyMigrationDone:
!macroend
