# Bring the Dock to the front and grab its rect once, without moving the cursor
# (moving it would cancel any hover state set up through CDP). ASCII only.
param([string]$Name = 'shot.png')

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public struct NRECT { public int Left, Top, Right, Bottom; }
public class QLShot2 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out NRECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  public delegate bool EnumProc(IntPtr h, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  public static IntPtr FindDock(uint pid) {
    IntPtr found = IntPtr.Zero; int best = 0;
    EnumWindows(delegate(IntPtr h, IntPtr lp) {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid) return true;
      var cls = new StringBuilder(256); GetClassName(h, cls, 256);
      if (cls.ToString() != "Chrome_WidgetWin_1") return true;
      NRECT r; GetWindowRect(h, out r);
      int w = r.Right - r.Left, hh = r.Bottom - r.Top;
      if (w < 400 || hh < 100) return true;
      if (w * hh > best) { best = w * hh; found = h; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static void Focus(IntPtr h) {
    IntPtr fg = GetForegroundWindow(); uint fgPid;
    uint fgThread = GetWindowThreadProcessId(fg, out fgPid); uint me = GetCurrentThreadId();
    bool att = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
    SetForegroundWindow(h);
    if (att) AttachThreadInput(me, fgThread, false);
  }
}
'@

$procs = @(Get-Process QuickLaunch,electron -ErrorAction SilentlyContinue)
$dock = [IntPtr]::Zero
foreach ($p in $procs) { $h = [QLShot2]::FindDock([uint32]$p.Id); if ($h -ne [IntPtr]::Zero) { $dock = $h; break } }
if ($dock -eq [IntPtr]::Zero) { Write-Output 'dock not found'; exit 1 }

[QLShot2]::Focus($dock)
Start-Sleep -Milliseconds 500
Write-Output ("focus done; exstyle now 0x{0:X6}" -f [QLShot2]::GetWindowLong($dock, -20))

$r = New-Object NRECT
[void][QLShot2]::GetWindowRect($dock, [ref]$r)
$W = $r.Right - $r.Left; $H = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size $W, $H))
$g.Dispose()
$out = Join-Path 'D:\QuickLaunch\devtools\probe\hittest-out' $Name
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("saved {0} ({1}x{2})" -f $out, $W, $H)
