import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { MIXDOG_HOST_CSHARP } from './native-source.ts';

test('native window capture reads only its off-screen fixture surface and preserves foreground', {
  skip: process.platform !== 'win32', timeout: 40_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-window-surface-'));
  const harness = String.raw`
public sealed class SurfaceFixture : System.Windows.Forms.Form {
  public int Prints;
  public SurfaceFixture() {
    FormBorderStyle = System.Windows.Forms.FormBorderStyle.None;
    ClientSize = new System.Drawing.Size(160, 120);
    StartPosition = System.Windows.Forms.FormStartPosition.Manual;
    ShowInTaskbar = false;
    BackColor = System.Drawing.Color.FromArgb(40, 80, 120);
    var desktop = System.Windows.Forms.SystemInformation.VirtualScreen;
    Location = new System.Drawing.Point(desktop.Left - 400, desktop.Top - 400);
  }
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override System.Windows.Forms.CreateParams CreateParams {
    get {
      var parameters = base.CreateParams;
      parameters.ExStyle |= 0x08000080;
      return parameters;
    }
  }
  protected override void OnPaint(System.Windows.Forms.PaintEventArgs e) {
    base.OnPaint(e);
    e.Graphics.FillRectangle(System.Drawing.Brushes.Orange, 20, 20, 40, 30);
  }
  protected override void WndProc(ref System.Windows.Forms.Message message) {
    if (message.Msg == 0x0317 || message.Msg == 0x0318) {
      Prints++;
      using (var graphics = System.Drawing.Graphics.FromHdc(message.WParam)) {
        graphics.Clear(System.Drawing.Color.FromArgb(40, 80, 120));
        graphics.FillRectangle(System.Drawing.Brushes.Orange, 20, 20, 40, 30);
      }
      return;
    }
    base.WndProc(ref message);
  }
}
public static class SurfaceChecks {
  public static string Focus(string scenario) {
    var values = new System.Collections.Generic.List<System.Collections.Generic.KeyValuePair<System.IntPtr, int>>();
    values.Add(new System.Collections.Generic.KeyValuePair<System.IntPtr, int>(new System.IntPtr(2), 1));
    values.Add(new System.Collections.Generic.KeyValuePair<System.IntPtr, int>(new System.IntPtr(3), 1));
    if (scenario == "deepest") values.Add(new System.Collections.Generic.KeyValuePair<System.IntPtr, int>(new System.IntPtr(4), 2));
    try { return MixWin32.SelectDeepestKeyboardFocus(new System.IntPtr(1), values).ToString(); }
    catch (System.Exception error) { return error.Message; }
  }
}
`;
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Accessibility
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies @('System.dll','System.Core.dll','System.Drawing.dll','System.Windows.Forms.dll',
  [Accessibility.IAccessible].Assembly.Location) -TypeDefinition ([IO.File]::ReadAllText((Join-Path $env:SURFACE_FIXTURE 'native.cs')))
$window = [SurfaceFixture]::new()
$before = [MixWin32]::Foreground()
try {
  $window.Show()
  $window.Update()
  [Windows.Forms.Application]::DoEvents()
  $capture = [MixWin32]::CaptureWindowSurface($window.Handle)
  $memory = [IO.MemoryStream]::new([Convert]::FromBase64String($capture.PngBase64))
  $image = [Drawing.Bitmap]::new($memory)
  try {
    $pixel = $image.GetPixel(100, 90)
    $orange = $image.GetPixel(30, 30)
    $invalid = ''
    try { [MixWin32]::ValidateBackgroundInput([IntPtr]::Zero,[IntPtr]::Zero,'key','^s') } catch { $invalid = $_.Exception.GetBaseException().Message }
    @{
      off_screen=(-not $window.Bounds.IntersectsWith([Windows.Forms.SystemInformation]::VirtualScreen))
      size=@($capture.Width,$capture.Height); color=@($pixel.R,$pixel.G,$pixel.B)
      marker=@($orange.R,$orange.G,$orange.B); foreground_unchanged=($before -eq [MixWin32]::Foreground())
      deepest=[SurfaceChecks]::Focus('deepest'); ambiguous=[SurfaceChecks]::Focus('ambiguous')
      invalid_keys=$invalid
      chromium=[MixWin32]::SupportsBackgroundKeyboardClass('Chrome_WidgetWin_1')
      winui=[MixWin32]::SupportsBackgroundKeyboardClass('WinUIDesktopWin32WindowClass')
      edit=[MixWin32]::SupportsBackgroundKeyboardClass('Edit')
    } | ConvertTo-Json -Compress
  } finally { $image.Dispose(); $memory.Dispose() }
} finally { $window.Dispose() }
`;
  try {
    await writeFile(join(directory, 'native.cs'), MIXDOG_HOST_CSHARP + '\n' + harness);
    await writeFile(join(directory, 'check.ps1'), script);
    const { stdout } = await promisify(execFile)('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-File', join(directory, 'check.ps1')],
      { windowsHide: true, timeout: 30_000, env: { ...process.env, SURFACE_FIXTURE: directory } });
    const value = JSON.parse(stdout.trim());
    assert.equal(value.off_screen, true);
    assert.deepEqual(value.size, [160, 120]);
    assert.deepEqual(value.color, [40, 80, 120]);
    assert.deepEqual(value.marker, [255, 165, 0]);
    assert.equal(value.foreground_unchanged, true);
    assert.equal(value.deepest, '4');
    assert.match(value.ambiguous, /^background_target_ambiguous\|/);
    assert.match(value.invalid_keys, /^background_unsupported\|/);
    assert.equal(value.chromium, false);
    assert.equal(value.winui, false);
    assert.equal(value.edit, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
