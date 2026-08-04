$src=@"
using System;using System.Text;using System.Runtime.InteropServices;
public class WSnap{
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
 delegate bool EnumProc(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int m);
 [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int m);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int c);
 public struct RECT{public int L,T,R,B;}
 public static string Run(){
  var sb=new StringBuilder();
  EnumWindows((h,l)=>{
   bool vis=IsWindowVisible(h);
   int cloaked=0; DwmGetWindowAttribute(h,14,out cloaked,4);
   RECT r; GetWindowRect(h,out r);
   uint pid; GetWindowThreadProcessId(h,out pid);
   var c=new StringBuilder(128); GetClassName(h,c,128);
   var t=new StringBuilder(128); GetWindowText(h,t,128);
   sb.AppendFormat("{0}|{1}|{2}|{3}|{4}|{5},{6},{7},{8}\n",(long)h,pid,vis?1:0,cloaked,c+"~"+t,r.L,r.T,r.R,r.B);
   return true;
  },IntPtr.Zero);
  return sb.ToString();
 }
}
"@
Add-Type -TypeDefinition $src
$log='C:\Project\mixdog\.win-watch2.log'
"[start] $(Get-Date -Format HH:mm:ss.fff) cloak/visibility transition watcher" | Out-File $log -Encoding utf8
$prev=@{}
$end=(Get-Date).AddMinutes(35)
while((Get-Date) -lt $end){
  $cur=@{}
  foreach($line in ([WSnap]::Run() -split "`n")){
    if(-not $line){continue}
    $p=$line -split '\|'
    if($p.Count -lt 6){continue}
    $key=$p[0]
    # state = visible|cloaked
    $state="$($p[2])|$($p[3])"
    $cur[$key]=@{s=$state;pid=$p[1];ct=$p[4];r=$p[5]}
  }
  foreach($k in $cur.Keys){
    $n=$cur[$k]
    $shown = ($n.s -eq '1|0')
    if(-not $prev.ContainsKey($k)){
      if($shown -and $prev.Count -gt 0){
        $exe=(Get-Process -Id $n.pid -ErrorAction SilentlyContinue).ProcessName
        "[{0}] NEW-VISIBLE hwnd={1} pid={2} exe={3} {4} rect={5}" -f (Get-Date -Format HH:mm:ss.fff),$k,$n.pid,$exe,$n.ct,$n.r | Out-File $log -Append -Encoding utf8
      }
    } elseif($prev[$k].s -ne $n.s){
      $was=($prev[$k].s -eq '1|0')
      if($shown -and -not $was){
        $exe=(Get-Process -Id $n.pid -ErrorAction SilentlyContinue).ProcessName
        "[{0}] APPEARED({1}->{2}) hwnd={3} pid={4} exe={5} {6} rect={7}" -f (Get-Date -Format HH:mm:ss.fff),$prev[$k].s,$n.s,$k,$n.pid,$exe,$n.ct,$n.r | Out-File $log -Append -Encoding utf8
      } elseif($was -and -not $shown){
        "[{0}] GONE({1}->{2}) hwnd={3} pid={4} {5}" -f (Get-Date -Format HH:mm:ss.fff),$prev[$k].s,$n.s,$k,$n.pid,$n.ct | Out-File $log -Append -Encoding utf8
      }
    }
  }
  $prev=$cur
  Start-Sleep -Milliseconds 200
}
"[done] watcher2 finished $(Get-Date -Format HH:mm:ss.fff)" | Out-File $log -Append -Encoding utf8
