# Dot-sourced by the recorder's scratch copy of office-com-session-host.ps1 (record-office-com.mjs puts one dot-source of
# this file at the front of the line `$state = $null`, after the host's function definitions and so before its main
# loop, without moving any line number). hook.ps1 is already loaded by then, through office-com-host.ps1, so New-Object
# -ComObject (Open-SessionState's path to a new application) and Active-Application already answer proxies; this file
# covers what the session host adds: the running-object-table lookup of an open document.
#
# Find-RunningDocumentExact gets its document from [MixdogOfficeInterop]::TryGetRunningFile (a static method of the
# host's own C# type, so it cannot be replaced) or from Find-OpenDocument on a proxied application. Its answer is made a
# proxy, and Same-DocumentPath, which reads FullName on the raw object the table gave, reads it through a proxy so that
# read is recorded too. The proxy of one identity is one proxy whichever way the object arrived.

if ($env:MIXDOG_COM_RECORDER_LOG) {
    $script:MixdogRecorderSamePath = ${function:Same-DocumentPath}
    function Same-DocumentPath($document, [string]$path) {
        & $script:MixdogRecorderSamePath (Convert-ToRecordedObject $document) $path
    }

    $script:MixdogRecorderFindRunning = ${function:Find-RunningDocumentExact}
    function Find-RunningDocumentExact([string]$format, [string]$path) {
        & $script:MixdogRecorderFindRunning $format $path | ForEach-Object { Convert-ToRecordedObject $_ -ReleaseSource }
    }
}
