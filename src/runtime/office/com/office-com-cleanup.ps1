# Document ownership and application ownership are different: an owned document
# may live in an existing user's application. Never quit that shared application.
function Close-OfficeDocument($document, [string]$format) {
  if ($null -eq $document) { return }
  switch ($format) {
    'pptx' { $document.Close() }
    'docx' { $document.Close(0) }
    'xlsx' { $document.Close($false) }
    default { throw "Unsupported Office close format: $format" }
  }
}

function Release-OfficeObject($value) {
  if ($null -ne $value -and [System.Runtime.InteropServices.Marshal]::IsComObject($value)) {
    [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($value)
  }
}

function Office-DocumentCount($app, [string]$format) {
  $collection = $null
  try {
    switch ($format) {
      'docx' { $collection = $app.Documents }
      'xlsx' { $collection = $app.Workbooks }
      'pptx' { $collection = $app.Presentations }
      default { throw "Unsupported Office collection: $format" }
    }
    return [int]$collection.Count
  } finally {
    if ($null -ne $collection -and [System.Runtime.InteropServices.Marshal]::IsComObject($collection)) {
      [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($collection)
    }
  }
}

function Office-ProcessStartTicks([int]$processId) {
  $process = $null
  try {
    $process = [System.Diagnostics.Process]::GetProcessById($processId)
    return $process.StartTime.ToUniversalTime().Ticks
  } catch { return 0 }
  finally { if ($null -ne $process) { $process.Dispose() } }
}

function Close-SessionState($state, [bool]$save) {
  if ($save) { Save-Document $state.Document $state.Format }
  $errors = New-Object 'System.Collections.Generic.List[string]'
  $result = [ordered]@{
    ok = $false
    documentClosed = $null -eq $state.Document
    detached = $state.Ownership -ne 'owned'
    applicationQuit = $false
    applicationRetained = $false
    processExited = $null
    forcedProcessCleanup = $false
    errors = @()
  }
  if ($state.Ownership -eq 'owned' -and $null -ne $state.Document) {
    try {
      Close-OfficeDocument $state.Document $state.Format
      $result.documentClosed = $true
    } catch { $errors.Add("Document close failed: $($_.Exception.Message)") }
  }
  # Keep a failed document reference available for an explicit retry.
  if ($result.documentClosed -or $result.detached) {
    try { Release-OfficeObject $state.Document } catch { $errors.Add("Document release failed: $($_.Exception.Message)") }
    $state.Document = $null
  }
  $ownsApplication = $state.Ownership -eq 'owned' -and [bool]$state.OwnsApplication
  $empty = $false
  if ($ownsApplication -and $null -ne $state.App) {
    try { $empty = (Office-DocumentCount $state.App $state.Format) -eq 0 }
    catch { $errors.Add("Application document count unavailable: $($_.Exception.Message)") }
  }
  if ($ownsApplication -and $empty -and $null -ne $state.App) {
    try {
      $state.App.Quit()
      $result.applicationQuit = $true
    } catch { $errors.Add("Application quit failed: $($_.Exception.Message)") }
  } elseif ($null -ne $state.App) {
    $result.applicationRetained = $true
  }
  if (($result.documentClosed -or $result.detached) -and (-not $ownsApplication -or -not $empty -or $result.applicationQuit)) {
    try { Release-OfficeObject $state.App } catch { $errors.Add("Application release failed: $($_.Exception.Message)") }
    $state.App = $null
  }
  if ($state.Format -eq 'pptx' -and (Get-Command Close-PowerPointChartExcelApplications -ErrorAction SilentlyContinue)) {
    try {
      $null = Close-PowerPointChartExcelApplications ($ownsApplication -and $empty)
    } catch { $errors.Add("Chart application cleanup failed: $($_.Exception.Message)") }
  }
  if ($ownsApplication -and $empty -and [int]$state.AppPid -gt 0) {
    $process = $null
    try { $process = [System.Diagnostics.Process]::GetProcessById([int]$state.AppPid) } catch {}
    if ($null -eq $process) {
      $result.processExited = $true
    } else {
      try {
        $sameProcess = [long]$state.AppStartTicks -gt 0 -and $process.StartTime.ToUniversalTime().Ticks -eq [long]$state.AppStartTicks
        if (-not $sameProcess) {
          $errors.Add('Application process identity changed; forced cleanup refused.')
        } else {
          $result.processExited = [bool]$process.WaitForExit(1000)
          if (-not $result.processExited -and $result.applicationQuit -and $state.Mode -eq 'background') {
            # Only an isolated, empty, identity-matched application is eligible.
            $process.Kill()
            $result.forcedProcessCleanup = $true
            $result.processExited = [bool]$process.WaitForExit(1000)
          }
          if (-not $result.processExited) { $errors.Add('Owned Office application is still running after cleanup.') }
        }
      } catch { $errors.Add("Application exit confirmation failed: $($_.Exception.Message)") }
      finally { $process.Dispose() }
    }
    if ($result.processExited) { $state.AppPid = 0 }
  }
  $result.errors = @($errors.ToArray())
  $result.ok = $errors.Count -eq 0 -and ($result.documentClosed -or $result.detached)
  return $result
}

function Write-OfficeCleanupFailure($cleanup) {
  if (-not $cleanup.ok) {
    [Console]::Error.WriteLine('MIXDOG_OFFICE_CLEANUP ' + ($cleanup | ConvertTo-Json -Depth 8 -Compress))
  }
}
