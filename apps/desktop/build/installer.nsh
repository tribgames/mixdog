!define LEGACY_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\5343bdcc-87a7-52f8-80e7-87b62e476a38"
!define LEGACY_EXE "$PROGRAMFILES64\Mixdog\Mixdog.exe"

!include "LogicLib.nsh"

!ifndef BUILD_UNINSTALLER
  Var MixdogProgressParent
  Var MixdogProgressStock
  Var MixdogProgressBar
  Var MixdogProgressDisplay
!endif

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

# electron-builder includes this file into the generated NSIS script BEFORE
# installer.nsi, so the define below applies to oneClick.nsh's
# MUI_PAGE_INSTFILES insertion.
#
# electron-builder resizes the one-click dialog and creates SpiderBanner's
# progress 1001 only after the MUI page-show hook. The hidden driver waits for
# that final control, copies its exact rectangle, clips the stock bars, and
# advances the installer-owned replacement monotonically. The driver creates
# no HWND at all, so there is no overlay form, focus transfer, or window jump.
!ifndef BUILD_UNINSTALLER
  Function MixdogInstFilesPre
    Push $0
    # SpiderBanner force-shows the shell while resizing 585x362 -> 387x156 and
    # recentring it. Layer alpha survives those ShowWindow calls, so keep the
    # transition fully transparent until the driver reveals the final bounds.
    System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -20) i.r0'
    IntOp $0 $0 | 0x00080000
    System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -20, i r0)'
    System::Call 'user32::SetLayeredWindowAttributes(p $HWNDPARENT, i 0, i 0, i 2)'
    ShowWindow $HWNDPARENT 0
    Pop $0
  FunctionEnd

  Function MixdogInstFilesShow
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    Push $6
    Push $7

    StrCpy $MixdogProgressParent $HWNDPARENT
    FindWindow $0 "#32770" "" $HWNDPARENT
    GetDlgItem $MixdogProgressStock $0 1004
    StrCpy $MixdogProgressBar 0
    StrCmp $MixdogProgressStock 0 progressShowDone

    # Create the replacement hidden. The driver shows it only after final
    # progress 1001 exists and the installer has reached its stable bounds.
    System::Call '*(i 0, i 0, i 0, i 0) p.r3'
    StrCmp $3 0 progressShowDone
    System::Call 'user32::GetWindowRect(p $MixdogProgressStock, p r3) i.r4'
    StrCmp $4 0 progressShowFreeRect
    System::Call 'user32::MapWindowPoints(p 0, p $MixdogProgressParent, p r3, i 2)'
    System::Call '*$3(i .r4, i .r5, i .r6, i .r7)'
    IntOp $6 $6 - $4
    IntOp $7 $7 - $5
    # WS_CHILD | PBS_SMOOTH, deliberately without WS_VISIBLE.
    System::Call 'user32::CreateWindowExW(i 0, w "msctls_progress32", w "", i 0x40000001, i r4, i r5, i r6, i r7, p $MixdogProgressParent, p 0, p 0, p 0) p.r2'
    StrCpy $MixdogProgressBar $2

  progressShowFreeRect:
    System::Free $3
    StrCmp $MixdogProgressBar 0 progressShowDone
    SendMessage $MixdogProgressBar 0x0406 0 1000
    SendMessage $MixdogProgressBar 0x0402 0 0
    # Hide the old MUI bar before it can paint. The later-created 1001 bar is
    # replaced atomically by the driver at its own final coordinates.
    System::Call 'user32::SetWindowPos(p $MixdogProgressStock, p 0, i -32000, i -32000, i 0, i 0, i 0x0015)'
    StrCpy $MixdogProgressDisplay 0
    InitPluginsDir
    File /oname=$PLUGINSDIR\progress-driver.ps1 "${BUILD_RESOURCES_DIR}\progress-driver.ps1"
    Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$PLUGINSDIR\progress-driver.ps1" -InstallerHwnd $MixdogProgressParent -PrimaryHwnd $MixdogProgressStock -ProgressHwnd $MixdogProgressBar'

  progressShowDone:
    Pop $7
    Pop $6
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  Function MixdogProgressComplete
    Push $0
    System::Call 'user32::IsWindow(p $MixdogProgressBar) i.r0'
    StrCmp $0 0 progressCompleteDone

    # Stop the hidden driver, read its last displayed value, and continue from
    # there to 100%. This prevents completion itself from causing a reset.
    System::Call 'user32::SetPropW(p $MixdogProgressBar, w "MixdogProgressComplete", p 1)'
    Sleep 80
    SendMessage $MixdogProgressBar 0x0408 0 0 $MixdogProgressDisplay
  progressCompleteStep:
    IntOp $MixdogProgressDisplay $MixdogProgressDisplay + 4
    ${If} $MixdogProgressDisplay > 1000
      StrCpy $MixdogProgressDisplay 1000
    ${EndIf}
    SendMessage $MixdogProgressBar 0x0402 $MixdogProgressDisplay 0
    Sleep 8
    ${If} $MixdogProgressDisplay < 1000
      Goto progressCompleteStep
    ${EndIf}
    Sleep 120

  progressCompleteDone:
    Pop $0
  FunctionEnd

  !macro customInstall
    Call MixdogProgressComplete
  !macroend

  !define MUI_PAGE_CUSTOMFUNCTION_PRE MixdogInstFilesPre
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW MixdogInstFilesShow
!endif
