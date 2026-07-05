/**
 * standalone/folder-dialog.mjs — cross-platform native "choose folder" dialog.
 *
 * Spawns the OS-native directory picker and resolves with the selected absolute
 * path, or null when the user cancels / no dialog tool is available. The TUI
 * falls back to manual path typing when this returns { available:false }.
 *
 *   Windows : PowerShell IFileOpenDialog (Explorer-style folder picker)
 *   macOS   : osascript `choose folder`
 *   Linux   : zenity --file-selection --directory  (fallback: kdialog)
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

const DIALOG_TIMEOUT_MS = 5 * 60 * 1000;

/** Run a command, capture stdout, resolve { code, stdout }. Never rejects. */
function runCapture(cmd, args, { timeoutMs = DIALOG_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch (error) {
      resolve({ ok: false, code: -1, stdout: '', error });
      return;
    }
    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* ignore */ }
      resolve({ ok: false, code: -1, stdout: '', error: new Error('dialog timed out') });
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout: '', error });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout });
    });
  });
}

// Sentinel: runCapture sets code === -1 ONLY for spawn failures and timeouts
// (the dialog tool could not actually run). A clean non-zero exit (e.g. the
// user cancelling) keeps the real exit code, so callers can distinguish
// "tool unavailable / broken" from "user cancelled".
function spawnFailed(result) {
  return !!result && result.code === -1;
}

/** Whether a command exists on PATH (best-effort, non-blocking spawn probe). */
function commandExists(cmd) {
  return new Promise((resolve) => {
    const probe = process.platform === 'win32'
      ? spawn('where', [cmd], { stdio: 'ignore', windowsHide: true })
      : spawn('which', [cmd], { stdio: 'ignore' });
    probe.on('error', () => resolve(false));
    probe.on('close', (code) => resolve(code === 0));
  });
}

function psSingleQuoted(value) {
  return String(value ?? '').replace(/'/g, "''");
}

/** Absolute directory path for the Windows picker initial folder (best-effort). */
function resolveInitialPath(initialPath) {
  const trimmed = String(initialPath ?? '').trim();
  try {
    return path.win32.resolve(trimmed || process.cwd());
  } catch {
    return trimmed || process.cwd();
  }
}

function powershellScript(title, initialPath) {
  // Run STA so the COM file dialog works; print the selected path or nothing.
  const safeTitle = psSingleQuoted(title || 'Select a project folder');
  const safeInitialPath = psSingleQuoted(initialPath || '');
  return [
    // Force UTF-8 stdout so non-ASCII selected paths are not mangled by the
    // console's default code page (PowerShell 5.1 is not UTF-8 by default).
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    `$code = @'
using System;
using System.Runtime.InteropServices;

namespace Mixdog {
  public static class ExplorerFolderPicker {
    private const int ERROR_CANCELLED = unchecked((int)0x800704C7);

    [Flags]
    private enum FOS : uint {
      NOCHANGEDIR = 0x00000008,
      PICKFOLDERS = 0x00000020,
      FORCEFILESYSTEM = 0x00000040,
      PATHMUSTEXIST = 0x00000800,
      FILEMUSTEXIST = 0x00001000
    }

    private enum SIGDN : uint {
      FILESYSPATH = 0x80058000
    }

    [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    private class FileOpenDialog {}

    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileDialog {
      [PreserveSig] int Show(IntPtr parent);
      [PreserveSig] int SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
      [PreserveSig] int SetFileTypeIndex(uint iFileType);
      [PreserveSig] int GetFileTypeIndex(out uint piFileType);
      [PreserveSig] int Advise(IntPtr pfde, out uint pdwCookie);
      [PreserveSig] int Unadvise(uint dwCookie);
      [PreserveSig] int SetOptions(FOS fos);
      [PreserveSig] int GetOptions(out FOS pfos);
      [PreserveSig] int SetDefaultFolder(IShellItem psi);
      [PreserveSig] int SetFolder(IShellItem psi);
      [PreserveSig] int GetFolder(out IShellItem ppsi);
      [PreserveSig] int GetCurrentSelection(out IShellItem ppsi);
      [PreserveSig] int SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
      [PreserveSig] int GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
      [PreserveSig] int SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
      [PreserveSig] int SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
      [PreserveSig] int SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
      [PreserveSig] int GetResult(out IShellItem ppsi);
      [PreserveSig] int AddPlace(IShellItem psi, int fdap);
      [PreserveSig] int SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
      [PreserveSig] int Close(int hr);
      [PreserveSig] int SetClientGuid(ref Guid guid);
      [PreserveSig] int ClearClientData();
      [PreserveSig] int SetFilter(IntPtr pFilter);
    }

    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem {
      [PreserveSig] int BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
      [PreserveSig] int GetParent(out IShellItem ppsi);
      [PreserveSig] int GetDisplayName(SIGDN sigdnName, out IntPtr ppszName);
      [PreserveSig] int GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
      [PreserveSig] int Compare(IShellItem psi, uint hint, out int piOrder);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(
      [MarshalAs(UnmanagedType.LPWStr)] string pszPath,
      IntPtr pbc,
      ref Guid riid,
      out IShellItem ppv
    );

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT {
      public int Left;
      public int Top;
      public int Right;
      public int Bottom;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetConsoleWindow();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    public static int[] GetDialogOwnerCenter() {
      IntPtr hwnd = GetConsoleWindow();
      if (hwnd == IntPtr.Zero) hwnd = GetForegroundWindow();
      RECT rect;
      if (hwnd != IntPtr.Zero && GetWindowRect(hwnd, out rect)) {
        return new int[] { (rect.Left + rect.Right) / 2, (rect.Top + rect.Bottom) / 2 };
      }
      var area = System.Windows.Forms.Screen.PrimaryScreen.WorkingArea;
      return new int[] { area.Left + (area.Width / 2), area.Top + (area.Height / 2) };
    }

    public static string Pick(string title, string initialPath, IntPtr owner) {
      IFileDialog dialog = null;
      IShellItem item = null;
      IShellItem initialItem = null;
      IntPtr pathPtr = IntPtr.Zero;
      try {
        dialog = (IFileDialog)new FileOpenDialog();
        FOS options;
        ThrowIfFailed(dialog.GetOptions(out options));
        ThrowIfFailed(dialog.SetOptions(options | FOS.PICKFOLDERS | FOS.FORCEFILESYSTEM | FOS.PATHMUSTEXIST | FOS.FILEMUSTEXIST | FOS.NOCHANGEDIR));
        if (!String.IsNullOrEmpty(title)) ThrowIfFailed(dialog.SetTitle(title));
        if (!String.IsNullOrEmpty(initialPath) && System.IO.Directory.Exists(initialPath)) {
          try {
            Guid shellItemId = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
            SHCreateItemFromParsingName(initialPath, IntPtr.Zero, ref shellItemId, out initialItem);
            if (initialItem != null) {
              ThrowIfFailed(dialog.SetDefaultFolder(initialItem));
              ThrowIfFailed(dialog.SetFolder(initialItem));
            }
          } catch {
            // Initial folder is a convenience only; still show the picker.
          }
        }
        int hr = dialog.Show(owner);
        if (hr == ERROR_CANCELLED) return null;
        ThrowIfFailed(hr);
        ThrowIfFailed(dialog.GetResult(out item));
        ThrowIfFailed(item.GetDisplayName(SIGDN.FILESYSPATH, out pathPtr));
        return Marshal.PtrToStringUni(pathPtr);
      } finally {
        if (pathPtr != IntPtr.Zero) Marshal.FreeCoTaskMem(pathPtr);
        if (initialItem != null) Marshal.ReleaseComObject(initialItem);
        if (item != null) Marshal.ReleaseComObject(item);
        if (dialog != null) Marshal.ReleaseComObject(dialog);
      }
    }

    private static void ThrowIfFailed(int hr) {
      if (hr < 0) Marshal.ThrowExceptionForHR(hr);
    }
  }
}
'@`,
    'Add-Type -TypeDefinition $code -ReferencedAssemblies System.Windows.Forms | Out-Null',
    // Invisible TopMost owner anchored to the TUI console (or foreground window)
    // so IFileOpenDialog is modal, centered, and not detached on another monitor.
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$owner.ShowInTaskbar = $false',
    '$owner.FormBorderStyle = "None"',
    '$owner.StartPosition = "Manual"',
    '$owner.Width = 1',
    '$owner.Height = 1',
    '$owner.Opacity = 0',
    '$ownerCenter = [Mixdog.ExplorerFolderPicker]::GetDialogOwnerCenter()',
    '$owner.Left = [int]$ownerCenter[0]',
    '$owner.Top = [int]$ownerCenter[1]',
    '$owner.Show()',
    '$owner.Activate()',
    'try {',
    `  $path = [Mixdog.ExplorerFolderPicker]::Pick('${safeTitle}', '${safeInitialPath}', $owner.Handle)`,
    '  if ($path) { [Console]::Out.Write($path) }',
    '} finally {',
    '  $owner.Dispose()',
    '}',
  ].join('\n');
}

/**
 * Open the native folder picker.
 * @returns {Promise<{ available: boolean, path: string|null }>}
 *   available=false → no usable dialog tool; caller should fall back to typing.
 *   path=null with available=true → the user cancelled.
 */
export async function pickFolder({ title = 'Select a project folder', initialPath = '' } = {}) {
  const platform = process.platform;

  if (platform === 'win32') {
    const resolvedInitial = resolveInitialPath(initialPath);
    const result = await runCapture('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-STA',
      '-Command', powershellScript(title, resolvedInitial),
    ]);
    // Could not run PowerShell / Common File Dialog → fall back to manual typing.
    if (spawnFailed(result)) return { available: false, path: null };
    const path = String(result.stdout || '').trim();
    if (!result.ok && !path) return { available: false, path: null };
    return { available: true, path: path || null };
  }

  if (platform === 'darwin') {
    const safeTitle = String(title).replace(/"/g, '\\"');
    const script = `set f to choose folder with prompt "${safeTitle}"\nPOSIX path of f`;
    const result = await runCapture('osascript', ['-e', script]);
    // Could not run osascript (spawn failure / timeout) → manual fallback.
    if (spawnFailed(result)) return { available: false, path: null };
    // osascript exits non-zero (code 1) on user cancel; treat as cancel.
    const path = String(result.stdout || '').trim();
    return { available: true, path: path || null };
  }

  // Linux / other unix: prefer zenity, then kdialog.
  if (await commandExists('zenity')) {
    const result = await runCapture('zenity', [
      '--file-selection', '--directory', `--title=${title}`,
    ]);
    // Spawn failure / timeout (broken display, missing portal, etc.) → manual
    // fallback rather than silently looping back to the picker.
    if (spawnFailed(result)) return { available: false, path: null };
    const path = String(result.stdout || '').trim();
    if (!result.ok && !path) return { available: true, path: null }; // cancel
    return { available: true, path: path || null };
  }
  if (await commandExists('kdialog')) {
    const result = await runCapture('kdialog', ['--getexistingdirectory', '.']);
    if (spawnFailed(result)) return { available: false, path: null };
    const path = String(result.stdout || '').trim();
    if (!result.ok && !path) return { available: true, path: null };
    return { available: true, path: path || null };
  }

  return { available: false, path: null };
}
