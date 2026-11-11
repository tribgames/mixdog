// A native stand-in for an external program the product spawns by name (`llama-server.exe`, `nvidia-smi.exe`): the product starts a real
// executable with the real command line; this one hands its own path and its arguments, unchanged, to the scripted stand-in
// (standin.mjs) run by the recording Node (STANDIN_NODE, STANDIN_SCRIPT), inherits the standard output and error and exits with the child's code.
// Lifetimes are tied by events: the child runs in a kill-on-close job object (it cannot outlive this process) and reads a pipe this process holds
// open on its standard input (it ends when that pipe closes); the wait for the child ends with the recorder's deadline for the case
// (STANDIN_DEADLINE_MS), with a message on the standard error.
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

static class Launcher
{
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    static string Quote(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return arg;
        return "\"" + arg.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    static IntPtr KillOnCloseJob()
    {
        const int JobObjectExtendedLimitInformation = 9;
        const uint KillOnJobClose = 0x2000;
        var job = CreateJobObject(IntPtr.Zero, null);
        var limits = new ExtendedLimits();
        limits.Basic.LimitFlags = KillOnJobClose;
        var size = Marshal.SizeOf(typeof(ExtendedLimits));
        var buffer = Marshal.AllocHGlobal(size);
        Marshal.StructureToPtr(limits, buffer, false);
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size)) throw new InvalidOperationException("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());
        return job;
    }

    static int Main(string[] args)
    {
        var self = Process.GetCurrentProcess().MainModule.FileName;
        var line = new StringBuilder(Quote(Environment.GetEnvironmentVariable("STANDIN_SCRIPT"))).Append(' ').Append(Quote(self));
        foreach (var arg in args) line.Append(' ').Append(Quote(arg));
        var info = new ProcessStartInfo(Environment.GetEnvironmentVariable("STANDIN_NODE"), line.ToString()) { UseShellExecute = false, RedirectStandardInput = true };
        var job = KillOnCloseJob();
        using (var child = Process.Start(info))
        {
            if (!AssignProcessToJobObject(job, child.Handle)) throw new InvalidOperationException("AssignProcessToJobObject failed: " + Marshal.GetLastWin32Error());
            var deadline = int.Parse(Environment.GetEnvironmentVariable("STANDIN_DEADLINE_MS"));
            if (!child.WaitForExit(deadline))
            {
                Console.Error.WriteLine("stand-in " + self + ": the child did not exit within " + deadline + " ms (the recorder deadline for the case); it is killed");
                child.Kill();
                return 124;
            }
            return child.ExitCode;
        }
    }
}
