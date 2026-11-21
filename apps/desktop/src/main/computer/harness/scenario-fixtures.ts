import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BrowserWindow, screen } from 'electron';
import { progress, profile } from './scenario-runtime';
import { windowIdByTitle, windowIdWhere } from './window-listing';
import {
  fixtureHtml,
  koreanFixtureHtml,
  clutterFixtureHtml,
  blackFixtureHtml,
  whiteFixtureHtml,
  denseFixtureHtml,
} from './scenario-fixture-html';

export async function createDenseFixture(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 900,
    height: 640,
    show: true,
    title: 'Mixdog Dense Accessibility Fixture',
    backgroundColor: '#f8fafc',
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true },
  });
  await window.loadURL(`data:text/html;base64,${Buffer.from(denseFixtureHtml).toString('base64')}`);
  window.showInactive();
  return window;
}

/** A native WinForms window whose Ctrl+O opens a real shell file dialog. */
export function spawnNativeDialogFixture(): ChildProcess {
  const fixtureScriptPath = join(profile, 'native-dialog-fixture.ps1');
  writeFileSync(
    fixtureScriptPath,
    `
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Mixdog Native Dialog Fixture'
$form.Width = 640
$form.Height = 420
$form.KeyPreview = $true
$form.Add_KeyDown({
  if ($_.Control -and $_.KeyCode -eq [System.Windows.Forms.Keys]::O) {
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.Title = 'Mixdog Native Open Dialog'
    [void]$dialog.ShowDialog($form)
    $_.Handled = $true
  }
})
[System.Windows.Forms.Application]::Run($form)
`,
    'utf8'
  );
  return spawn(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', fixtureScriptPath],
    {
      stdio: 'ignore',
      windowsHide: false,
    }
  );
}

const WIN32_HELPER_TYPES = `
Add-Type -Namespace Mixdog -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
[DllImport("imm32.dll")] public static extern IntPtr ImmGetDefaultIMEWnd(IntPtr hWnd);
'@
`;

const execFileAsync = promisify(execFile);

/** Runs one PowerShell snippet in a helper process and returns its trimmed stdout.
 *  It never blocks this process: the fixture windows live on its UI thread, and a
 *  helper that sends them a message waits for that thread to answer. */
async function runWin32Helper(script: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `${WIN32_HELPER_TYPES}\n${script}`],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 }
  );
  return stdout.trim();
}

export function nativeHwnd(window: BrowserWindow): bigint {
  const handle = window.getNativeWindowHandle();
  return handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
}

export async function foregroundHwnd(): Promise<bigint> {
  return BigInt(await runWin32Helper('[Mixdog.Native]::GetForegroundWindow().ToInt64()'));
}

/** Reads the IME conversion mode of a window's default IME window; `set` writes one first. Returns the mode read back. */
export async function imeConversionMode(hwnd: bigint, set?: number): Promise<number> {
  const write =
    set === undefined ? '' : `[void][Mixdog.Native]::SendMessage($ime, 0x0283, [IntPtr]2, [IntPtr]${set})\n`;
  return Number(
    await runWin32Helper(
      `$ime = [Mixdog.Native]::ImmGetDefaultIMEWnd([IntPtr]${hwnd})\n${write}[Mixdog.Native]::SendMessage($ime, 0x0283, [IntPtr]1, [IntPtr]0).ToInt64()`
    )
  );
}

export async function createScenarioFixtureWindows(windows: BrowserWindow[]): Promise<{
  fixture: BrowserWindow;
  displayPlacement: string;
}> {
  const fixture = new BrowserWindow({
    width: 820,
    height: 620,
    show: true,
    title: 'Mixdog Scenario Renderer',
    backgroundColor: '#f5f7fb',
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  windows.push(fixture);
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  // Placement is an explicit input, not a fact of the machine: a secondary
  // display exercises off-origin geometry, while forcing primary isolates
  // whether a failure belongs to the code or to that geometry.
  const secondary =
    process.env.MIXDOG_COMPUTER_SCENARIO_DISPLAY === 'primary'
      ? undefined
      : displays.find((display) => display.id !== primary.id);
  let displayPlacement = '';
  if (secondary) {
    fixture.setBounds({
      x: secondary.workArea.x + 50,
      y: secondary.workArea.y + 50,
      width: 820,
      height: 620,
    });
    displayPlacement = 'secondary_display';
  } else {
    fixture.setBounds({
      x: primary.workArea.x - 160,
      y: primary.workArea.y + 50,
      width: 820,
      height: 620,
    });
    displayPlacement = 'partially_offscreen';
  }
  await fixture.loadURL(`data:text/html;base64,${Buffer.from(fixtureHtml).toString('base64')}`);
  fixture.showInactive();
  progress('SETUP primary fixture ready');

  const koreanFixture = new BrowserWindow({
    width: 680,
    height: 420,
    show: true,
    title: 'Mixdog Korean OCR Fixture',
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true },
  });
  windows.push(koreanFixture);
  await koreanFixture.loadURL(`data:text/html;base64,${Buffer.from(koreanFixtureHtml).toString('base64')}`);
  koreanFixture.showInactive();
  progress('SETUP Korean fixture ready');

  const clutterFixture = new BrowserWindow({
    width: 820,
    height: 580,
    show: true,
    title: 'Mixdog OCR Clutter Fixture',
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true },
  });
  windows.push(clutterFixture);
  await clutterFixture.loadURL(`data:text/html;base64,${Buffer.from(clutterFixtureHtml).toString('base64')}`);
  clutterFixture.showInactive();
  progress('SETUP clutter fixture ready');

  for (const [title, html, backgroundColor] of [
    ['Mixdog Black Frame Fixture', blackFixtureHtml, '#000000'],
    ['Mixdog White Frame Fixture', whiteFixtureHtml, '#ffffff'],
  ] as const) {
    const blank = new BrowserWindow({
      width: 480,
      height: 320,
      show: true,
      frame: false,
      title,
      backgroundColor,
      webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true },
    });
    windows.push(blank);
    await blank.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
    blank.showInactive();
    progress(`SETUP ${title} ready`);
  }
  return { fixture, displayPlacement };
}

/** Exact window ids for the fixture titles, read off one list_windows report. */
export function fixtureWindowIds(listing: string): {
  fixture: string;
  korean: string;
  clutter: string;
  black: string;
  white: string;
  dense: string;
  mixdog?: string;
  chrome?: string;
} {
  return {
    fixture: windowIdByTitle(listing, 'Mixdog Scenario Renderer'),
    korean: windowIdByTitle(listing, 'Mixdog Korean OCR Fixture'),
    clutter: windowIdByTitle(listing, 'Mixdog OCR Clutter Fixture'),
    black: windowIdByTitle(listing, 'Mixdog Black Frame Fixture'),
    white: windowIdByTitle(listing, 'Mixdog White Frame Fixture'),
    dense: windowIdByTitle(listing, 'Mixdog Dense Accessibility Fixture'),
    mixdog: windowIdWhere(listing, (line) => /\|\s+app=Mixdog\b/i.test(line) && line.includes('"Mixdog"')) || undefined,
    chrome: windowIdWhere(listing, (line) => /\|\s+app=(?:chrome|msedge)\b/i.test(line)) || undefined,
  };
}
