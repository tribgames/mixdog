# Dot-sourced by the recorder's scratch copy of office-com-host.ps1 (record-office-com.mjs puts one dot-source of this
# file at the front of the line `if ($env:MIXDOG_OFFICE_HOST_LIBRARY -eq '1') { return }`, so no line number of the host
# moves). The host itself is not edited: this file makes every Office object it holds a proxy of the recorder DLL
# (mixdog_office_com_recorder.dll, next to this file), which logs each call to the file MIXDOG_COM_RECORDER_LOG names
# (a variable only this test tool reads), and writes boundary markers with the operation JSON so a log can be cut per
# operation. Without that variable the file defines nothing and the host runs as it always does.

if ($env:MIXDOG_COM_RECORDER_LOG) {
    if (-not ('MixdogComRecorder' -as [type])) {
        $recorderDll = Join-Path $PSScriptRoot 'mixdog_office_com_recorder.dll'
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class MixdogComRecorder
{
    [DllImport(@"$recorderDll", CallingConvention = CallingConvention.Winapi)]
    public static extern IntPtr mixdog_com_recorder_wrap(IntPtr unknown);

    [DllImport(@"$recorderDll", CallingConvention = CallingConvention.Winapi, CharSet = CharSet.Unicode)]
    public static extern void mixdog_com_recorder_boundary(
        [MarshalAs(UnmanagedType.LPWStr)] string kind,
        [MarshalAs(UnmanagedType.LPWStr)] string name,
        [MarshalAs(UnmanagedType.LPWStr)] string payload);
}
"@
    }

    # An object the host got from Office, as the proxy of its COM identity (the same proxy for the same identity, so
    # [object]::ReferenceEquals and RuntimeHelpers.GetHashCode behave as unhooked). Anything that is not a COM object,
    # and an object the DLL declines, is returned as it came. Every answer leaves with the unary comma, so a collection
    # (a List, an object[,] from New-Object) comes back whole instead of being unrolled by the function's output.
    # -ReleaseSource gives back the reference the raw wrapper took when the object was just acquired (New-Object,
    # GetActiveObject, the running-object table): the host's own ReleaseComObject then reaches the proxy, and Office
    # holds one reference for the host, as unhooked. An object that already is a proxy comes back as it came.
    function Convert-ToRecordedObject($object, [switch]$ReleaseSource) {
        if ($null -eq $object) { return $null }
        $base = if ($object -is [System.Management.Automation.PSObject]) { $object.psobject.BaseObject } else { $object }
        if ($null -eq $base -or -not [System.Runtime.InteropServices.Marshal]::IsComObject($base)) { return , $object }
        $unknown = [IntPtr]::Zero
        $proxy = [IntPtr]::Zero
        try {
            $unknown = [System.Runtime.InteropServices.Marshal]::GetIUnknownForObject($base)
            $proxy = [MixdogComRecorder]::mixdog_com_recorder_wrap($unknown)
            if ($proxy -eq [IntPtr]::Zero -or $proxy -eq $unknown) { return , $object }
            $recorded = [System.Runtime.InteropServices.Marshal]::GetObjectForIUnknown($proxy)
            if ($ReleaseSource) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($base) }
            return , $recorded
        }
        finally {
            if ($unknown -ne [IntPtr]::Zero) { [void][System.Runtime.InteropServices.Marshal]::Release($unknown) }
            if ($proxy -ne [IntPtr]::Zero) { [void][System.Runtime.InteropServices.Marshal]::Release($proxy) }
        }
    }

    function Write-RecorderBoundary([string]$kind, [string]$name, $payload) {
        $json = ''
        if ($null -ne $payload) {
            try { $json = [string]($payload | ConvertTo-Json -Depth 32 -Compress) } catch { $json = '' }
        }
        [MixdogComRecorder]::mixdog_com_recorder_boundary($kind, $name, $json)
    }

    # New-Object -ComObject answers the proxy; every other call (a .NET type, an array) goes to the real cmdlet and comes
    # back as it was (the one-element array keeps a collection from being unrolled by the function's output).
    function New-Object {
        $created = Microsoft.PowerShell.Utility\New-Object @args
        return , (Convert-ToRecordedObject $created -ReleaseSource)
    }

    $script:MixdogRecorderActiveApplication = ${function:Active-Application}
    function Active-Application([string]$progId) {
        $application = & $script:MixdogRecorderActiveApplication $progId
        if ($null -eq $application) { return $null }
        return Convert-ToRecordedObject $application -ReleaseSource
    }

    # One marker per operation, snapshot and issues call, each with what the host was given; the call goes through to
    # the host's own function with the arguments as they came.
    $script:MixdogRecorderWord = ${function:Apply-WordOperation}
    function Apply-WordOperation {
        Write-RecorderBoundary 'operation' ([string]$args[1].op) $args[1]
        & $script:MixdogRecorderWord @args
    }
    $script:MixdogRecorderExcel = ${function:Apply-ExcelOperation}
    function Apply-ExcelOperation {
        Write-RecorderBoundary 'operation' ([string]$args[1].op) $args[1]
        & $script:MixdogRecorderExcel @args
    }
    $script:MixdogRecorderPowerPoint = ${function:Apply-PowerPointOperation}
    function Apply-PowerPointOperation {
        Write-RecorderBoundary 'operation' ([string]$args[1].op) $args[1]
        & $script:MixdogRecorderPowerPoint @args
    }
    $script:MixdogRecorderSnapshot = ${function:Snapshot-Document}
    function Snapshot-Document {
        Write-RecorderBoundary 'snapshot' ([string]$args[1]) $args[2]
        & $script:MixdogRecorderSnapshot @args
    }
    $script:MixdogRecorderSelection = ${function:Snapshot-Selection}
    function Snapshot-Selection {
        Write-RecorderBoundary 'snapshot' ([string]$args[1]) $null
        & $script:MixdogRecorderSelection @args
    }
    $script:MixdogRecorderIssues = ${function:Issues-Document}
    function Issues-Document {
        Write-RecorderBoundary 'issues' ([string]$args[1]) $args[2]
        & $script:MixdogRecorderIssues @args
    }
}
