function Get-WindowCaptureRemaining($clock) {
  $remaining = @@MIXDOG_CAPTURE_WORK_MS@@ - $clock.ElapsedMilliseconds
  if ($remaining -le 0) { throw [TimeoutException]::new('capture_timeout|window capture exhausted its work budget') }
  return [int]$remaining
}

function Close-WindowCaptureResources($resources, $cancellation) {
  $cleanup = @{ status = 'confirmed' }
  if ($cancellation) {
    $cleanup.cancellation = $cancellation
    if ($cancellation -ne 'settled') { $cleanup.status = 'unconfirmed' }
  }
  foreach ($resource in $resources) {
    if ($null -eq $resource) { continue }
    try { [MixWindowGraphicsCapture]::Close($resource) } catch { $cleanup.status = 'failed' }
  }
  return $cleanup
}

function Get-WindowGraphicsCapture([IntPtr]$handle) {
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $target = [MixWin32]::BeginWindowCapture($handle, $true)
  $device = $pool = $session = $frame = $bitmap = $reader = $null
  $failure = $null
  $result = $null
  $cancellation = $null
  try {
    $itemType = [Windows.Graphics.Capture.GraphicsCaptureItem,Windows.Graphics.Capture,ContentType=WindowsRuntime]
    $poolType = [Windows.Graphics.Capture.Direct3D11CaptureFramePool,Windows.Graphics.Capture,ContentType=WindowsRuntime]
    $sessionType = [Windows.Graphics.Capture.GraphicsCaptureSession,Windows.Graphics.Capture,ContentType=WindowsRuntime]
    if (-not $sessionType::IsSupported()) { throw 'capture_wgc_unavailable|Windows graphics capture is not supported' }
    $factory = [Runtime.InteropServices.WindowsRuntime.WindowsRuntimeMarshal]::GetActivationFactory($itemType)
    $item = [MixWindowGraphicsCapture]::CreateItem($factory, $handle)
    $size = $item.Size
    if ($size.Width -ne $target.Width -or $size.Height -ne $target.Height) {
      throw 'capture_geometry_changed|compositor dimensions do not match the exact visible window bounds'
    }
    $device = [MixWindowGraphicsCapture]::CreateDevice()
    [void](Get-WindowCaptureRemaining $clock)
    $format = [Windows.Graphics.DirectX.DirectXPixelFormat,Windows.Graphics.DirectX,ContentType=WindowsRuntime]::B8G8R8A8UIntNormalized
    # Reflection lets the CLR query the WinRT device interface; PowerShell's
    # argument converter cannot cast interface-only COM wrappers.
    $pool = $poolType.GetMethod('CreateFreeThreaded').Invoke($null, @($device, $format, [int]2, $size))
    $session = $pool.CreateCaptureSession($item)
    # Keep the OS capture indicator. Never request borderless capture permission.
    $api = [Windows.Foundation.Metadata.ApiInformation,Windows.Foundation,ContentType=WindowsRuntime]
    if ($api::IsPropertyPresent('Windows.Graphics.Capture.GraphicsCaptureSession', 'IsCursorCaptureEnabled')) {
      $session.IsCursorCaptureEnabled = $false
    }
    $session.StartCapture()
    while ($null -eq $frame) {
      $remaining = Get-WindowCaptureRemaining $clock
      $frame = $pool.TryGetNextFrame()
      if ($null -eq $frame) { Start-Sleep -Milliseconds ([Math]::Min(20, $remaining)) }
    }
    if ($frame.ContentSize.Width -ne $target.Width -or $frame.ContentSize.Height -ne $target.Height) {
      throw 'capture_geometry_changed|window resized while awaiting its compositor frame'
    }
    $bitmapType = [Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
    $surfaceType = [Windows.Graphics.DirectX.Direct3D11.IDirect3DSurface,Windows.Graphics.DirectX,ContentType=WindowsRuntime]
    $copySurface = $bitmapType.GetMethod('CreateCopyFromSurfaceAsync', [Type[]]@($surfaceType))
    $remaining = Get-WindowCaptureRemaining $clock
    $bitmap = Await-WinRt ($copySurface.Invoke($null, @($frame.Surface))) $bitmapType $remaining
    if ($bitmap.PixelWidth -ne $target.Width -or $bitmap.PixelHeight -ne $target.Height) {
      throw 'capture_geometry_changed|compositor texture dimensions changed'
    }
    $buffer = [Windows.Storage.Streams.Buffer,Windows.Storage.Streams,ContentType=WindowsRuntime]::new(
      [uint32]($target.Width * $target.Height * 4))
    $bitmap.CopyToBuffer($buffer)
    $reader = [Windows.Storage.Streams.DataReader,Windows.Storage.Streams,ContentType=WindowsRuntime]::FromBuffer($buffer)
    $pixels = New-Object byte[] $buffer.Length
    $reader.ReadBytes($pixels)
    [MixWin32]::AssertWindowCaptureStable($target)
    $result = $target.Result([MixWindowGraphicsCapture]::EncodePixels($pixels, $target.Width, $target.Height))
    [void](Get-WindowCaptureRemaining $clock)
  } catch {
    $cause = $_.Exception.GetBaseException()
    $cancellation = $cause.Data['WinRtCancellation']
    $failure = if ($cause.Message -match '^capture_[a-z_]+\|') { $cause.Message }
      elseif ($cause -is [TimeoutException]) { 'capture_timeout|GPU copy exceeded the remaining capture budget' }
      elseif ($cause.HResult -eq -2147024891) { 'capture_denied|Windows denied capture of the selected window' }
      else { 'capture_wgc_unavailable|' + $cause.Message }
  } finally {
    $cleanup = Close-WindowCaptureResources @($reader, $bitmap, $frame, $session, $pool, $device) $cancellation
    if (-not $failure -and $cleanup.status -ne 'confirmed') {
      $failure = 'capture_cleanup_failed|window capture resources did not all close'
    }
  }
  if ($failure) {
    $exception = [InvalidOperationException]::new($failure)
    $exception.Data['CaptureCleanup'] = $cleanup
    throw $exception
  }
  return $result
}
