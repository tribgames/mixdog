# Drives the installer-owned progress control without creating any window.
param(
  [long]$InstallerHwnd,
  [long]$PrimaryHwnd,
  [long]$ProgressHwnd
)

$ErrorActionPreference = 'SilentlyContinue'

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class MixdogProgressDriver {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }

  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern int MapWindowPoints(IntPtr from, IntPtr to, ref RECT rect, int points);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, int message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hwnd, int index, int value);
  [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint color, byte alpha, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetProp(IntPtr hwnd, string name);

  public static IntPtr FindProgress(IntPtr root, int id) {
    IntPtr result = IntPtr.Zero;
    EnumChildWindows(root, (hwnd, _) => {
      var name = new StringBuilder(64);
      GetClassName(hwnd, name, name.Capacity);
      if (name.ToString() == "msctls_progress32" && GetDlgCtrlID(hwnd) == id) {
        result = hwnd;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
"@

$installer = [IntPtr]$InstallerHwnd
$primary = [IntPtr]$PrimaryHwnd
$progress = [IntPtr]$ProgressHwnd
$source = [IntPtr]::Zero
$phase = 0
$lastNorm = 0.0
$display = 0.0

for ($attempt = 0; $attempt -lt 200 -and $source -eq [IntPtr]::Zero; $attempt++) {
  if (-not [MixdogProgressDriver]::IsWindow($installer) -or
      -not [MixdogProgressDriver]::IsWindow($progress)) { exit }
  $source = [MixdogProgressDriver]::FindProgress($installer, 1001)
  if ($source -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 10 }
}
if ($source -eq [IntPtr]::Zero) { exit }

# Match the final SpiderBanner bar before swapping controls.
$rect = New-Object MixdogProgressDriver+RECT
if (-not [MixdogProgressDriver]::GetWindowRect($source, [ref]$rect)) { exit }
[void][MixdogProgressDriver]::MapWindowPoints([IntPtr]::Zero, $installer, [ref]$rect, 2)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
[void][MixdogProgressDriver]::SetWindowPos(
  $progress, [IntPtr]::Zero, $rect.Left, $rect.Top, $width, $height, 0x0010)

# Seed only the source baseline. The installer is still fully transparent, so
# reveal the replacement at a true 0% and let it catch up smoothly.
$position = [MixdogProgressDriver]::SendMessage($source, 0x0408, [IntPtr]::Zero, [IntPtr]::Zero).ToInt64()
$low = [MixdogProgressDriver]::SendMessage($source, 0x0407, [IntPtr]1, [IntPtr]::Zero).ToInt64()
$high = [MixdogProgressDriver]::SendMessage($source, 0x0407, [IntPtr]::Zero, [IntPtr]::Zero).ToInt64()
$span = $high - $low
if ($span -gt 0) {
  $lastNorm = [Math]::Min(1.0, [Math]::Max(0.0, ($position - $low) / $span))
}
[void][MixdogProgressDriver]::SetWindowPos(
  $source, [IntPtr]::Zero, -32000, -32000, 0, 0, 0x0015)
[void][MixdogProgressDriver]::ShowWindow($progress, 4) # SW_SHOWNOACTIVATE

# Reveal only the final centred 387x156 shell with its aligned 0% bar.
[void][MixdogProgressDriver]::SetLayeredWindowAttributes($installer, 0, 255, 2)
$extendedStyle = [MixdogProgressDriver]::GetWindowLong($installer, -20)
[void][MixdogProgressDriver]::SetWindowLong($installer, -20, ($extendedStyle -band (-bnot 0x00080000)))
[void][MixdogProgressDriver]::ShowWindow($installer, 4)
Start-Sleep -Milliseconds 120

while ([MixdogProgressDriver]::IsWindow($installer) -and
       [MixdogProgressDriver]::IsWindow($progress) -and
       [MixdogProgressDriver]::GetProp($progress, 'MixdogProgressComplete') -eq [IntPtr]::Zero) {
  $position = [MixdogProgressDriver]::SendMessage($source, 0x0408, [IntPtr]::Zero, [IntPtr]::Zero).ToInt64()
  $low = [MixdogProgressDriver]::SendMessage($source, 0x0407, [IntPtr]1, [IntPtr]::Zero).ToInt64()
  $high = [MixdogProgressDriver]::SendMessage($source, 0x0407, [IntPtr]::Zero, [IntPtr]::Zero).ToInt64()
  $span = $high - $low
  $norm = if ($span -gt 0) {
    [Math]::Min(1.0, [Math]::Max(0.0, ($position - $low) / $span))
  } else {
    $lastNorm
  }

  $drop = $lastNorm - $norm
  if (($norm -lt 0.15 -and $drop -gt 0.25) -or $drop -gt 0.35) {
    if ($phase -lt 2) { $phase++ }
  }
  $lastNorm = $norm

  $target = switch ($phase) {
    0 { [Math]::Min(0.75, ($norm / 0.57) * 0.75) }
    1 { 0.75 + [Math]::Min(0.20, $norm * 0.20) }
    default { 0.95 + $norm * 0.05 }
  }
  if ($target -gt $display) {
    $display = [Math]::Min($target, $display + 0.025)
    [void][MixdogProgressDriver]::SendMessage(
      $progress, 0x0402, [IntPtr]([int]($display * 1000)), [IntPtr]::Zero)
  }
  Start-Sleep -Milliseconds 25
}
