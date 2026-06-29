/**
 * standalone/folder-dialog.mjs — cross-platform native "choose folder" dialog.
 *
 * Spawns the OS-native directory picker and resolves with the selected absolute
 * path, or null when the user cancels / no dialog tool is available. The TUI
 * falls back to manual path typing when this returns { available:false }.
 *
 *   Windows : PowerShell System.Windows.Forms.FolderBrowserDialog
 *   macOS   : osascript `choose folder`
 *   Linux   : zenity --file-selection --directory  (fallback: kdialog)
 */
import { spawn } from 'node:child_process';

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

function powershellScript(title) {
  // Run STA so the WinForms dialog works; print the selected path or nothing.
  const safeTitle = String(title || 'Select a project folder').replace(/'/g, "''");
  return [
    // Force UTF-8 stdout so non-ASCII selected paths are not mangled by the
    // console's default code page (PowerShell 5.1 is not UTF-8 by default).
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    // A TopMost owner form forces the dialog to surface IN FRONT of the
    // terminal instead of opening behind it (FolderBrowserDialog has no
    // TopMost of its own). The owner stays invisible and is disposed after.
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$owner.ShowInTaskbar = $false',
    '$owner.WindowState = "Minimized"',
    '$owner.Show(); $owner.Hide()',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$d.Description = '${safeTitle}'`,
    '$d.ShowNewFolderButton = $true',
    'if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }',
    '$owner.Dispose()',
  ].join('; ');
}

/**
 * Open the native folder picker.
 * @returns {Promise<{ available: boolean, path: string|null }>}
 *   available=false → no usable dialog tool; caller should fall back to typing.
 *   path=null with available=true → the user cancelled.
 */
export async function pickFolder({ title = 'Select a project folder' } = {}) {
  const platform = process.platform;

  if (platform === 'win32') {
    const result = await runCapture('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-STA',
      '-Command', powershellScript(title),
    ]);
    // Could not even run PowerShell → fall back to manual typing.
    if (spawnFailed(result)) return { available: false, path: null };
    const path = String(result.stdout || '').trim();
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
