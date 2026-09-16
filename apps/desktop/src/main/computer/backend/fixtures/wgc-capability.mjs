import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * Host capability probe for Windows.Graphics.Capture (WGC).
 *
 * A hosted `windows-latest` runner has a desktop session and DWM, but its
 * compositor refuses to hand out a capture item: release-gate run 35088208105
 * failed the WGC suite with
 * `capture_wgc_unavailable|The parameter is incorrect. Could not capture the
 * given window.` (E_INVALIDARG out of GraphicsCaptureItemInterop) while the
 * PrintWindow/GDI suite on the same runner passed. The WGC suite therefore
 * skips only where this probe proves the OS cannot capture, and stays fully
 * enforced everywhere it can.
 *
 * The probe deliberately re-declares its own WinRT interop instead of loading
 * MixWindowGraphicsCapture / Get-WindowGraphicsCapture: a regression in the
 * shipped capture bridge must fail the suite, never switch it off. It walks
 * the same OS gates the real capture walks — IsSupported, capture item for a
 * live window, D3D11 device, free-threaded frame pool, and one delivered
 * compositor frame — and reports the first gate that refuses.
 */

// Windows PowerShell plus a cold `Add-Type` compile takes ~10s on a loaded
// hosted runner (measured in the run above), so this budget only bounds a hung
// probe; it is never the thing that decides capability.
const PROBE_BUDGET_MS = 60_000;
const FRAME_BUDGET_MS = 3_000;

const PROBE_PROGRAM = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies @('System.dll','System.Core.dll','System.Drawing.dll','System.Windows.Forms.dll') -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WgcCapabilityProbe {
  [ComImport, Guid("3628e81b-3cac-4c60-b7f4-23ce0e0c3356"),
    InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ItemInterop {
    [PreserveSig] int CreateForWindow(IntPtr window, ref Guid iid, out IntPtr item);
    [PreserveSig] int CreateForMonitor(IntPtr monitor, ref Guid iid, out IntPtr item);
  }
  [DllImport("d3d11.dll", ExactSpelling = true)]
  static extern int D3D11CreateDevice(IntPtr adapter, int driver, IntPtr software,
    uint flags, IntPtr levels, uint levelCount, uint sdk, out IntPtr device,
    out int featureLevel, out IntPtr context);
  [DllImport("d3d11.dll", ExactSpelling = true)]
  static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgi, out IntPtr device);

  public static object CreateItem(object factory, IntPtr window) {
    Guid iid = new Guid("79c3f95b-31f7-4ec2-a464-632ef5d30760");
    IntPtr item = IntPtr.Zero;
    try {
      Marshal.ThrowExceptionForHR(((ItemInterop)factory).CreateForWindow(window, ref iid, out item));
      return Marshal.GetObjectForIUnknown(item);
    } finally { if (item != IntPtr.Zero) Marshal.Release(item); }
  }

  public static object CreateDevice() {
    IntPtr device = IntPtr.Zero, context = IntPtr.Zero, dxgi = IntPtr.Zero, wrapper = IntPtr.Zero;
    try {
      int feature;
      Marshal.ThrowExceptionForHR(D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero,
        0x20, IntPtr.Zero, 0, 7, out device, out feature, out context));
      Guid iid = new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
      Marshal.ThrowExceptionForHR(Marshal.QueryInterface(device, ref iid, out dxgi));
      Marshal.ThrowExceptionForHR(CreateDirect3D11DeviceFromDXGIDevice(dxgi, out wrapper));
      return Marshal.GetObjectForIUnknown(wrapper);
    } finally {
      if (wrapper != IntPtr.Zero) Marshal.Release(wrapper);
      if (dxgi != IntPtr.Zero) Marshal.Release(dxgi);
      if (context != IntPtr.Zero) Marshal.Release(context);
      if (device != IntPtr.Zero) Marshal.Release(device);
    }
  }
}
public sealed class WgcProbeWindow : System.Windows.Forms.Form {
  public WgcProbeWindow() {
    FormBorderStyle = System.Windows.Forms.FormBorderStyle.None;
    ClientSize = new System.Drawing.Size(160, 120);
    StartPosition = System.Windows.Forms.FormStartPosition.Manual;
    ShowInTaskbar = false;
    BackColor = System.Drawing.Color.FromArgb(40, 80, 120);
    var desktop = System.Windows.Forms.Screen.PrimaryScreen.WorkingArea;
    Location = new System.Drawing.Point(desktop.Right - 184, desktop.Bottom - 144);
  }
  // Never steal the signed-in user's foreground window for a capability check.
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override System.Windows.Forms.CreateParams CreateParams {
    get {
      var parameters = base.CreateParams;
      parameters.ExStyle |= 0x08000080;
      return parameters;
    }
  }
}
'@
$stage = 'WinRT capture type load'
$reason = $null
$window = $null
try {
  $itemType = [Windows.Graphics.Capture.GraphicsCaptureItem,Windows.Graphics.Capture,ContentType=WindowsRuntime]
  $poolType = [Windows.Graphics.Capture.Direct3D11CaptureFramePool,Windows.Graphics.Capture,ContentType=WindowsRuntime]
  $sessionType = [Windows.Graphics.Capture.GraphicsCaptureSession,Windows.Graphics.Capture,ContentType=WindowsRuntime]
  $stage = 'GraphicsCaptureSession::IsSupported'
  if (-not $sessionType::IsSupported()) {
    $reason = 'GraphicsCaptureSession::IsSupported() reported false'
  } else {
    $window = [WgcProbeWindow]::new()
    $window.Show()
    $window.Update()
    [Windows.Forms.Application]::DoEvents()
    $stage = 'GraphicsCaptureItem::CreateForWindow'
    $factory = [Runtime.InteropServices.WindowsRuntime.WindowsRuntimeMarshal]::GetActivationFactory($itemType)
    $item = [WgcCapabilityProbe]::CreateItem($factory, $window.Handle)
    $stage = 'Direct3D11 device creation'
    $device = [WgcCapabilityProbe]::CreateDevice()
    $stage = 'Direct3D11CaptureFramePool::CreateFreeThreaded'
    $format = [Windows.Graphics.DirectX.DirectXPixelFormat,Windows.Graphics.DirectX,ContentType=WindowsRuntime]::B8G8R8A8UIntNormalized
    # Reflection for the same reason the shipped capture needs it: PowerShell's
    # argument converter cannot cast interface-only COM wrappers.
    $pool = $poolType.GetMethod('CreateFreeThreaded').Invoke($null, @($device, $format, [int]2, $item.Size))
    $stage = 'GraphicsCaptureSession::StartCapture'
    $session = $pool.CreateCaptureSession($item)
    $session.StartCapture()
    $stage = 'compositor frame delivery'
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $frame = $null
    while ($null -eq $frame -and $clock.ElapsedMilliseconds -lt @@MIXDOG_FRAME_BUDGET_MS@@) {
      $frame = $pool.TryGetNextFrame()
      if ($null -eq $frame) { Start-Sleep -Milliseconds 20 }
    }
    if ($null -eq $frame) { $reason = 'no compositor frame arrived within @@MIXDOG_FRAME_BUDGET_MS@@ ms' }
  }
} catch {
  # One line: the reason is quoted verbatim in a node:test skip message, and
  # WinRT capture errors are multi-line ("The parameter is incorrect.\r\nCould
  # not capture the given window.").
  $reason = $stage + ' failed: ' + (($_.Exception.GetBaseException().Message -replace '\s+', ' ').Trim())
} finally {
  # Capture handles are owned by this short-lived process; its exit releases the
  # frame pool, session and device without a second interop surface here.
  if ($window) { $window.Dispose() }
}
@{ available = ($null -eq $reason); reason = [string]$reason } | ConvertTo-Json -Compress
`.replaceAll('@@MIXDOG_FRAME_BUDGET_MS@@', String(FRAME_BUDGET_MS));

async function runProbe() {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-wgc-probe-'));
  const path = join(directory, 'probe.ps1');
  try {
    await writeFile(path, PROBE_PROGRAM);
    const { stdout } = await promisify(execFile)('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-File', path],
      { windowsHide: true, timeout: PROBE_BUDGET_MS });
    const result = JSON.parse(stdout.trim());
    return { available: result.available === true, reason: result.reason || '' };
  } catch (error) {
    // A probe that cannot run is not an answer: fail loudly instead of
    // silently disabling every suite that asks it for permission.
    throw new Error(`WGC capability probe did not report a result: ${error.message}`, { cause: error });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

let pending;

/**
 * Resolves `{ available, reason }` once per test process; `reason` names the
 * exact OS gate that refused so a skip message can quote it.
 */
export function probeWindowsGraphicsCapture() {
  pending ??= runProbe();
  return pending;
}
