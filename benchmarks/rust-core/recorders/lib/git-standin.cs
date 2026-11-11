using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

// A stand-in for git.exe that the recorder installs. Every start appends one JSON line to <exe>.log: the argv, the cwd and the
// environment block as the process received it, whole (hidden =X: entries included). It answers from <exe>.answers (lines
// `<last argument or *>\t<exit code>\t<stdout>\t<stderr>`, \n and \t escaped; the stdout `$ENV` prints the environment block, one
// NAME=value per line, as `env` does). With <exe>.wrapper (lines `SET NAME=value`, `PREPEND NAME=value`, `EXEC path`) it is the
// launcher: it sets those variables and starts EXEC with the same arguments, relaying its output and exit code.
static class StandIn {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetEnvironmentStringsW();
  [DllImport("kernel32.dll")] static extern bool FreeEnvironmentStringsW(IntPtr block);

  static List<string> Env() {
    var list = new List<string>();
    IntPtr block = GetEnvironmentStringsW();
    IntPtr at = block;
    while (true) {
      string entry = Marshal.PtrToStringUni(at);
      if (entry.Length == 0) break;
      list.Add(entry);
      at = IntPtr.Add(at, (entry.Length + 1) * 2);
    }
    FreeEnvironmentStringsW(block);
    return list;
  }

  static string Json(string s) {
    var b = new StringBuilder("\"");
    foreach (char c in s) {
      if (c == '"') b.Append("\\\"");
      else if (c == '\\') b.Append("\\\\");
      else if (c < 32) b.Append("\\u" + ((int)c).ToString("x4"));
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }

  static string Unescape(string s) { return s.Replace("\\n", "\n").Replace("\\t", "\t").Replace("\\\\", "\\"); }

  static string Quote(string a) { return a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0 ? a : "\"" + a.Replace("\"", "\\\"") + "\""; }

  static int Main(string[] args) {
    string exe = Assembly.GetExecutingAssembly().Location;
    var env = Env();
    var line = new StringBuilder("{\"argv\":[");
    for (int i = 0; i < args.Length; i++) line.Append(i > 0 ? "," : "").Append(Json(args[i]));
    line.Append("],\"cwd\":").Append(Json(Directory.GetCurrentDirectory())).Append(",\"env\":[");
    for (int i = 0; i < env.Count; i++) line.Append(i > 0 ? "," : "").Append(Json(env[i]));
    line.Append("]}\n");
    File.AppendAllText(exe + ".log", line.ToString());

    if (File.Exists(exe + ".wrapper")) {
      var psi = new ProcessStartInfo { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
      string target = null;
      foreach (string rule in File.ReadAllLines(exe + ".wrapper")) {
        if (rule.StartsWith("EXEC ")) target = rule.Substring(5);
        else if (rule.StartsWith("SET ")) { int eq = rule.IndexOf('='); psi.EnvironmentVariables[rule.Substring(4, eq - 4)] = rule.Substring(eq + 1); }
        else if (rule.StartsWith("PREPEND ")) { int eq = rule.IndexOf('='); string name = rule.Substring(8, eq - 8); string old = psi.EnvironmentVariables.ContainsKey(name) ? psi.EnvironmentVariables[name] : ""; psi.EnvironmentVariables[name] = rule.Substring(eq + 1) + old; }
      }
      psi.FileName = target;
      var quoted = new List<string>();
      foreach (string a in args) quoted.Add(Quote(a));
      psi.Arguments = string.Join(" ", quoted.ToArray());
      using (var child = Process.Start(psi)) {
        var outTask = child.StandardOutput.ReadToEndAsync();
        var errTask = child.StandardError.ReadToEndAsync();
        if (!child.WaitForExit(30000)) {
          try { child.Kill(); } catch (Exception) { }
          Console.Error.Write("git stand-in: the wrapped child " + target + " gave no answer within 30000 ms");
          return 124;
        }
        Console.Out.Write(outTask.Result);
        Console.Error.Write(errTask.Result);
        return child.ExitCode;
      }
    }

    string last = args.Length > 0 ? args[args.Length - 1] : "";
    foreach (string rule in File.ReadAllLines(exe + ".answers")) {
      string[] part = rule.Split('\t');
      if (part[0] != "*" && part[0] != last) continue;
      string stdout = part[2] == "$ENV" ? string.Join("\n", env.ToArray()) + "\n" : Unescape(part[2]);
      Console.Out.Write(stdout);
      Console.Error.Write(Unescape(part[3]));
      return int.Parse(part[1]);
    }
    return 1;
  }
}
