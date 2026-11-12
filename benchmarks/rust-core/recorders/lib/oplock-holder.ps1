# Holds batch oplocks on files, for a recorder: an open of such a file for its data by another handle waits until the
# oplock is released (the open breaks the oplock and the break is never acknowledged), so a search's open of it holds
# that search. Commands on stdin, one per line; answers on stdout:
#   hold <n> <path>   request the oplock on <path>       -> "held <n>"
#                     an open that breaks it later      -> "broken <n>"
#   release <n>       close the handle: the open goes on -> "released <n>"
# The process ends at the end of its stdin, which closes every handle.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class OplockHolder {
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DeviceIoControl(IntPtr handle, uint code, IntPtr input, uint inputSize, IntPtr output, uint outputSize, IntPtr returned, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateEventW(IntPtr security, bool manualReset, bool initialState, IntPtr name);
    [DllImport("kernel32.dll")]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    const uint GENERIC_READ = 0x80000000;
    const uint SHARE_ALL = 7;
    const uint OPEN_EXISTING = 3;
    const uint FILE_FLAG_OVERLAPPED = 0x40000000;
    const uint FSCTL_REQUEST_BATCH_OPLOCK = 0x00090008;
    const int ERROR_IO_PENDING = 997;

    // The handle holding the oplock; the event its break sets (the OVERLAPPED stays allocated while the handle is open).
    public static IntPtr Hold(int n, string path) {
        IntPtr handle = CreateFileW(path, GENERIC_READ, SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, IntPtr.Zero);
        if (handle == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception();
        IntPtr evt = CreateEventW(IntPtr.Zero, true, false, IntPtr.Zero);
        IntPtr overlapped = Marshal.AllocHGlobal(32);
        for (int i = 0; i < 32; i++) Marshal.WriteByte(overlapped, i, 0);
        Marshal.WriteIntPtr(overlapped, 24, evt);
        bool done = DeviceIoControl(handle, FSCTL_REQUEST_BATCH_OPLOCK, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero, overlapped);
        int error = Marshal.GetLastWin32Error();
        if (done || error != ERROR_IO_PENDING) throw new Exception("batch oplock not granted on " + path + ": " + error);
        Thread watch = new Thread(() => {
            WaitForSingleObject(evt, 0xFFFFFFFF);
            lock (Console.Out) { Console.Out.WriteLine("broken " + n); Console.Out.Flush(); }
        });
        watch.IsBackground = true;
        watch.Start();
        return handle;
    }

    public static void Release(IntPtr handle) {
        CloseHandle(handle);
    }
}
'@
$handles = @{}
while ($null -ne ($line = [Console]::In.ReadLine())) {
    $parts = $line.Split(' ', 3)
    switch ($parts[0]) {
        'hold' {
            $handles[$parts[1]] = [OplockHolder]::Hold([int]$parts[1], $parts[2])
            [Console]::Out.WriteLine("held $($parts[1])")
        }
        'release' {
            [OplockHolder]::Release($handles[$parts[1]])
            [Console]::Out.WriteLine("released $($parts[1])")
        }
    }
    [Console]::Out.Flush()
}
