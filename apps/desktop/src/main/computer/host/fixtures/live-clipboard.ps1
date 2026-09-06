[Console]::Error.WriteLine('probe:live-clipboard')
$originalClipboard = $null
$clipboardOk = $false
$clipboardError = ''
try {
  $originalClipboard = [System.Windows.Forms.Clipboard]::GetDataObject()
  $clipboardMarker = 'mixdog-clipboard-probe-' + $PID
  $clipboardResult = Do-ClipboardWrite $clipboardMarker
  $clipboardOk = $clipboardResult.verified -eq $true -and [System.Windows.Forms.Clipboard]::GetText() -eq $clipboardMarker
} catch {
  $clipboardError = [string]$_.Exception.Message
} finally {
  try {
    if ($null -eq $originalClipboard) { [System.Windows.Forms.Clipboard]::Clear() }
    else { [System.Windows.Forms.Clipboard]::SetDataObject($originalClipboard, $true) }
  } catch {
    $clipboardOk = $false
    $clipboardError = ('restore failed: ' + [string]$_.Exception.Message)
  }
}
[void]$probeResults.Add(@{ name = 'clipboard-write-readback-restore'; ok = $clipboardOk; error = $clipboardError })
