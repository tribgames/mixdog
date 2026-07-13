$src=@"
using System; using System.Text; using System.Runtime.InteropServices; using System.IO;
public class Hooker {
 public delegate void WinEventDelegate(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
 [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventDelegate cb, uint pid, uint tid, uint flags);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int m);
 [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int m);
 [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint f);
 public struct RECT { public int L,T,R,B; }
 static WinEventDelegate keep;
 static string logPath;
 public static void Start(string path){
  logPath = path;
  keep = new WinEventDelegate(Callback);
  SetWinEventHook(0x8000, 0x8018, IntPtr.Zero, keep, 0, 0, 2);
  File.AppendAllText(logPath, "[hook] installed " + DateTime.Now.ToString("HH:mm:ss.fff") + "\n");
 }
 static void Callback(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time){
  try{
   if(idObject != 0) return;
   if(ev != 0x8000 && ev != 0x8002 && ev != 0x8018 && ev != 0x8003 && ev != 0x8017) return;
   RECT r; GetWindowRect(hwnd, out r);
   int w = r.R-r.L, h = r.B-r.T;
   bool top = GetAncestor(hwnd, 2) == hwnd;
   if(ev == 0x8000 && !top) return;
   if(!top && (w < 200 || h < 120)) return;
   if(top && ev != 0x8000 && (w < 40 || h < 25)) return;
   uint pid; GetWindowThreadProcessId(hwnd, out pid);
   var c = new StringBuilder(128); GetClassName(hwnd, c, 128);
   var t = new StringBuilder(128); GetWindowText(hwnd, t, 128);
   string exe = "";
   try { exe = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch {}
   string name = ev==0x8000?"CREATE":ev==0x8002?"SHOW":ev==0x8003?"HIDE":ev==0x8017?"CLOAK":"UNCLOAK";
   File.AppendAllText(logPath, string.Format("[{0}] {1} hwnd={2} pid={3} exe={4} top={5} class={6} title='{7}' rect=({8},{9})-({10},{11})\n",
     DateTime.Now.ToString("HH:mm:ss.fff"), name, hwnd, pid, exe, top?1:0, c, t, r.L, r.T, r.R, r.B));
  } catch {}
 }
}
"@
Add-Type -TypeDefinition $src
$log='C:\Project\mixdog\.win-watch3.log'
"[start] event-hook watcher $(Get-Date -Format HH:mm:ss.fff)" | Out-File $log -Encoding utf8
[Hooker]::Start($log)
Add-Type -AssemblyName System.Windows.Forms
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2400000
$timer.Add_Tick({ [System.Windows.Forms.Application]::Exit() })
$timer.Start()
[System.Windows.Forms.Application]::Run()
"[done] watcher3 finished $(Get-Date -Format HH:mm:ss.fff)" | Out-File $log -Append -Encoding utf8
