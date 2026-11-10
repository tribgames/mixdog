// The `git` a recorded world's daemon finds first on its PATH (compiled to git.exe by record-new-task-quit.mjs). It asks the
// recorder whether to go on (one line with its arguments to MIXDOG_QUIT_GIT_PORT on loopback, one line back), then runs the real
// git (MIXDOG_QUIT_REAL_GIT) with the same arguments and standard streams and exits with its code. A held command is one the
// recorder answers late; nothing here waits on a clock.
using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Text;

static class GitShim {
    static string Quote(string arg) {
        if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return arg;
        var sb = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in arg) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { sb.Append('\\', slashes * 2 + 1); sb.Append('"'); slashes = 0; continue; }
            sb.Append('\\', slashes); slashes = 0; sb.Append(c);
        }
        sb.Append('\\', slashes * 2);
        sb.Append('"');
        return sb.ToString();
    }

    static int Main(string[] args) {
        string port = Environment.GetEnvironmentVariable("MIXDOG_QUIT_GIT_PORT");
        string real = Environment.GetEnvironmentVariable("MIXDOG_QUIT_REAL_GIT");
        if (string.IsNullOrEmpty(port) || string.IsNullOrEmpty(real)) {
            Console.Error.WriteLine("git shim: MIXDOG_QUIT_GIT_PORT and MIXDOG_QUIT_REAL_GIT are required");
            return 128;
        }
        var quoted = new string[args.Length];
        for (int i = 0; i < args.Length; i++) quoted[i] = Quote(args[i]);
        string line = String.Join(" ", quoted);
        using (var client = new TcpClient("127.0.0.1", int.Parse(port))) {
            var stream = client.GetStream();
            byte[] ask = Encoding.UTF8.GetBytes(Environment.CurrentDirectory + "\t" + line + "\n");
            stream.Write(ask, 0, ask.Length);
            var reader = new StreamReader(stream, Encoding.UTF8);
            string answer = reader.ReadLine();
            if (answer != "go") {
                Console.Error.WriteLine("git shim: the recorder did not let `git " + line + "` run: " + (answer ?? "(connection closed)"));
                return 128;
            }
        }
        var info = new ProcessStartInfo(real, line) { UseShellExecute = false };
        using (var child = Process.Start(info)) {
            child.WaitForExit();
            return child.ExitCode;
        }
    }
}
