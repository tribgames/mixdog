import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { PS_SESSION } from './ps-session.ts';
import { MIXDOG_HOST_CSHARP } from './native-source.ts';
import { PS_WINDOW_CAPTURE } from './ps-runtime.ts';
import { NATIVE_CAPTURE_WORK_MS } from '../shared/capture-attempts.ts';
import { probeWindowsGraphicsCapture } from './fixtures/wgc-capability.mjs';

test('WGC captures a covered fixture without foreign pixels, preserves foreground and rejects changed geometry', {
  skip: process.platform !== 'win32', timeout: 120_000,
}, async (t) => {
  // Everything below needs an OS that can actually hand out a capture item and
  // a compositor frame. Where it can, the whole assertion set stays enforced;
  // where the probe proves it cannot (hosted CI desktops), the capability is
  // named instead of failing as a product defect.
  const capability = await probeWindowsGraphicsCapture();
  if (!capability.available) {
    t.skip(`WGC capability probe reported Windows.Graphics.Capture unavailable on this host: ${capability.reason}`);
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-wgc-'));
  const fixture = String.raw`
public sealed class WgcFixture : System.Windows.Forms.Form {
  [System.Runtime.InteropServices.DllImport("user32.dll")]
  public static extern System.IntPtr WindowFromPoint(System.Drawing.Point point);
  public WgcFixture() {
    FormBorderStyle = System.Windows.Forms.FormBorderStyle.None;
    ClientSize = new System.Drawing.Size(160, 120);
    StartPosition = System.Windows.Forms.FormStartPosition.Manual;
    ShowInTaskbar = false;
    BackColor = System.Drawing.Color.FromArgb(40, 80, 120);
    var desktop = System.Windows.Forms.Screen.PrimaryScreen.WorkingArea;
    Location = new System.Drawing.Point(desktop.Right - 184, desktop.Bottom - 144);
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
}
`;
  const program = '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n' + PS_SESSION
    .replace(MIXDOG_HOST_CSHARP, MIXDOG_HOST_CSHARP + '\n' + fixture)
    .replace("'System.Drawing.dll',$AccessibilityAssemblyPath", "'System.Drawing.dll','System.Windows.Forms.dll',$AccessibilityAssemblyPath")
    + '\n' + PS_WINDOW_CAPTURE + String.raw`
$window = [WgcFixture]::new()
$cover = [WgcFixture]::new()
$cover.BackColor = [Drawing.Color]::Lime
$before = [MixWin32]::Foreground()
try {
  $window.Show()
  $window.Update()
  [Windows.Forms.Application]::DoEvents()
  $cover.Show()
  $cover.Update()
  [Windows.Forms.Application]::DoEvents()
  $covered = [WgcFixture]::WindowFromPoint([Drawing.Point]::new($window.Left + 100, $window.Top + 90)) -eq $cover.Handle
  $capture = Get-WindowGraphicsCapture $window.Handle
  $second = Get-WindowGraphicsCapture $window.Handle
  $memory = [IO.MemoryStream]::new([Convert]::FromBase64String($capture.PngBase64))
  $image = [Drawing.Bitmap]::new($memory)
  try {
    $pixel = $image.GetPixel(100, 90)
    $marker = $image.GetPixel(30, 30)
    $target = [MixWin32]::BeginWindowCapture($window.Handle, $true)
    $window.Left = $window.Left - 10
    $changed = ''
    try { [MixWin32]::AssertWindowCaptureStable($target) } catch { $changed = $_.Exception.GetBaseException().Message }
    $invalid = ''
    try { Get-WindowGraphicsCapture ([IntPtr]::Zero) } catch { $invalid = $_.Exception.GetBaseException().Message }
    $buffer = [Windows.Storage.Streams.Buffer]::new(4)
    $buffer.Length = 4
    $reader = [Windows.Storage.Streams.DataReader]::FromBuffer($buffer)
    $reader.ReadBytes([byte[]]::new(1))
    $cleanup = Close-WindowCaptureResources @([Object]::new(), $reader) $null
    $closedAfterFailure = $false
    try { $reader.ReadBytes([byte[]]::new(1)) } catch { $closedAfterFailure = $true }
    $deadlineError = ''
    try { Get-WindowCaptureRemaining ([pscustomobject]@{ElapsedMilliseconds=[int]::MaxValue}) }
      catch { $deadlineError = $_.Exception.GetBaseException().Message }
    @{
      size=@($capture.Width,$capture.Height); color=@($pixel.R,$pixel.G,$pixel.B)
      marker=@($marker.R,$marker.G,$marker.B)
      covered=$covered; repeat_pixels_identical=($capture.PngBase64 -eq $second.PngBase64)
      foreground_unchanged=($before -eq [MixWin32]::Foreground())
      changed=$changed; invalid=$invalid
      cleanup=$cleanup.status; closed_after_failure=$closedAfterFailure
      work_budget=(Get-WindowCaptureRemaining ([pscustomobject]@{ElapsedMilliseconds=0}))
      deadline=$deadlineError
    } | ConvertTo-Json -Compress
  } finally { $image.Dispose(); $memory.Dispose() }
} finally { $cover.Dispose(); $window.Dispose() }
`;
  try {
    await writeFile(join(directory, 'check.ps1'), program);
    const { stdout } = await promisify(execFile)('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-File', join(directory, 'check.ps1')],
      // Cold `Add-Type` of the host C# on a loaded hosted runner takes ~10s, so
      // this budget bounds a hung capture only, never a slow-but-healthy host.
      { windowsHide: true, timeout: 60_000, env: { ...process.env,
        MIXDOG_COMPUTER_HOST_CACHE: '', MIXDOG_COMPUTER_HOST_BUILD: '' } });
    const value = JSON.parse(stdout.trim());
    assert.equal(value.covered, true);
    assert.deepEqual(value.size, [160, 120]);
    assert.deepEqual(value.color, [40, 80, 120]);
    assert.deepEqual(value.marker, [255, 165, 0]);
    assert.equal(value.foreground_unchanged, true);
    assert.equal(value.repeat_pixels_identical, true);
    assert.match(value.changed, /^capture_geometry_changed\|/);
    assert.match(value.invalid, /capture_source_unavailable\|/);
    assert.equal(value.cleanup, 'failed');
    assert.equal(value.closed_after_failure, true);
    assert.equal(value.work_budget, NATIVE_CAPTURE_WORK_MS);
    assert.match(value.deadline, /^capture_timeout\|/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
