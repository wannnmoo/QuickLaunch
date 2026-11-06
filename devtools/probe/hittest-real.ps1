# Real-window hit test: temporarily raises the Dock window to the top of the z-order
# (it sinks itself after losing focus by design), then asks the OS who owns each point
# across the whole window rect. Read-only apart from that transient z-order bump.
# ASCII only.

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public struct HP { public int X, Y; }
public struct HRECT { public int Left, Top, Right, Bottom; }

public class QLReal {
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(HP p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out HRECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  public delegate bool EnumProc(IntPtr h, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);

  public static IntPtr[] TopWindows(uint pid) {
    List<IntPtr> list = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr lp) {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid) list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list.ToArray();
  }
  public static string ClassOf(IntPtr h) {
    var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString();
  }
  [DllImport("user32.dll", EntryPoint="SetWindowPos", SetLastError=true)] static extern bool SetWindowPosRaw(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  // Give the Dock real foreground focus. That is what actually raises it: the app's own
  // `focus` handler runs recoverDock() (setAlwaysOnTop + moveTop). A bare
  // SetWindowPos(HWND_TOPMOST) from outside reports success yet leaves WS_EX_TOPMOST off,
  // so it never wins the hit test.
  public static bool Focus(IntPtr h) {
    IntPtr fg = GetForegroundWindow();
    uint fgPid;
    uint fgThread = GetWindowThreadProcessId(fg, out fgPid);
    uint me = GetCurrentThreadId();
    bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
    bool ok = SetForegroundWindow(h);
    BringWindowToTop(h);
    if (attached) AttachThreadInput(me, fgThread, false);
    return ok;
  }
}
'@

$procs = @(Get-Process QuickLaunch,electron -ErrorAction SilentlyContinue)
if (-not $procs) { Write-Output 'QuickLaunch not running'; exit 1 }

$dock = [IntPtr]::Zero
$bestArea = 0
foreach ($proc in $procs) {
  foreach ($h in [QLReal]::TopWindows([uint32]$proc.Id)) {
    if ([QLReal]::ClassOf($h) -ne 'Chrome_WidgetWin_1') { continue }
    $rr = New-Object HRECT
    [void][QLReal]::GetWindowRect($h, [ref]$rr)
    $ww = $rr.Right - $rr.Left; $hh = $rr.Bottom - $rr.Top
    if ($ww -lt 400 -or $hh -lt 100) { continue }
    $area = $ww * $hh
    if ($area -gt $bestArea) { $bestArea = $area; $dock = $h }
  }
}
if ($dock -eq [IntPtr]::Zero) { Write-Output 'dock window not found'; exit 1 }

# Raise it through the app's own path: give it foreground focus, then let its
# `focus` handler call recoverDock() (setAlwaysOnTop + moveTop).
$okFocus = [QLReal]::Focus($dock)
Start-Sleep -Milliseconds 400
Write-Output ("focus -> {0}; exstyle now 0x{1:X6}" -f $okFocus, [QLReal]::GetWindowLong($dock, -20))

$rect = New-Object HRECT
[void][QLReal]::GetWindowRect($dock, [ref]$rect)
$W = $rect.Right - $rect.Left; $H = $rect.Bottom - $rect.Top
Write-Output ("dock 0x{0:X} rect=({1},{2}) {3}x{4}" -f $dock.ToInt64(), $rect.Left, $rect.Top, $W, $H)

function Was($x, $y) {
  $p = New-Object HP; $p.X = $x; $p.Y = $y
  $h = [QLReal]::WindowFromPoint($p)
  if ($h -eq [IntPtr]::Zero) { return '?' }
  $root = [QLReal]::GetAncestor($h, 2)
  if ($root -eq $dock) { return 'D' }
  return '.'
}

Write-Output ''
Write-Output '--- column at x = centre, step 10px (D = dock hit, . = passes through) ---'
$cx = $rect.Left + [int]($W / 2)
$col = ''
for ($y = 0; $y -lt $H; $y += 10) { $col += (Was $cx ($rect.Top + $y)) }
Write-Output $col

Write-Output ''
Write-Output '--- row at y = H-40 (inside glass bar), step 40px ---'
$row = ''
for ($x = 5; $x -lt $W; $x += 40) { $row += (Was ($rect.Left + $x) ($rect.Top + $H - 40)) }
Write-Output $row

Write-Output ''
Write-Output '--- row at y = 60 (top transparent band), step 40px ---'
$row2 = ''
for ($x = 5; $x -lt $W; $x += 40) { $row2 += (Was ($rect.Left + $x) ($rect.Top + 60)) }
Write-Output $row2

Write-Output ''
$tot = 0; $hit = 0
for ($y = 0; $y -lt $H; $y += 10) {
  for ($x = 0; $x -lt $W; $x += 10) {
    $tot++
    if ((Was ($rect.Left + $x) ($rect.Top + $y)) -eq 'D') { $hit++ }
  }
}
Write-Output ("grid 10px: {0}/{1} = {2:N1}% of the window rect still swallows clicks" -f $hit, $tot, (100.0 * $hit / $tot))
