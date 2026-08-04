' Windowless launcher for progress-driver.ps1. powershell.exe is a console
' subsystem binary, so NSIS Exec flashed a console for a frame BEFORE the
' (still alpha-0) installer dialog revealed. wscript.exe is a GUI-subsystem
' host: it creates no console, and Run(...,0,False) starts PowerShell hidden.
Set shell = CreateObject("WScript.Shell")
cmd = """" & WScript.Arguments(0) & """ -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & WScript.Arguments(1) & """" & _
  " -InstallerHwnd " & WScript.Arguments(2) & _
  " -PrimaryHwnd " & WScript.Arguments(3) & _
  " -ProgressHwnd " & WScript.Arguments(4)
shell.Run cmd, 0, False
