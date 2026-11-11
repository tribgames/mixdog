// A native stand-in for an external program the product spawns by name (`llama-server.exe`, `nvidia-smi.exe`): the product starts a real
// executable with the real command line; this one hands its own path and its arguments, unchanged, to the scripted stand-in
// (standin.mjs) run by the recording Node (STANDIN_NODE, STANDIN_SCRIPT), inherits the standard streams and exits with its code.
using System;
using System.Diagnostics;
using System.Text;

static class Launcher
{
    static string Quote(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return arg;
        return "\"" + arg.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    static int Main(string[] args)
    {
        var self = Process.GetCurrentProcess().MainModule.FileName;
        var line = new StringBuilder(Quote(Environment.GetEnvironmentVariable("STANDIN_SCRIPT"))).Append(' ').Append(Quote(self));
        foreach (var arg in args) line.Append(' ').Append(Quote(arg));
        var info = new ProcessStartInfo(Environment.GetEnvironmentVariable("STANDIN_NODE"), line.ToString()) { UseShellExecute = false };
        using (var child = Process.Start(info))
        {
            child.WaitForExit();
            return child.ExitCode;
        }
    }
}
