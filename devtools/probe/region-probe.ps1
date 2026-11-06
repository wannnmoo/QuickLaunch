# Read-only: print the window region (SetWindowRgn result) of the Dock window.
# `win.setShape()` is implemented on Windows via SetWindowRgn, so this tells us
# exactly what rectangle the OS thinks the window occupies.
# ASCII only.

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public struct RP { public int X, Y; }
public struct RRECT { public int Left, Top, Right, Bottom; }

public class QLRegion {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RRECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowRgn(IntPtr h, IntPtr hRgn);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int a, int b, int c, int d);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o);
  [DllImport("gdi32.dll")] public static extern int GetRgnBox(IntPtr hRgn, out RRECT r);
  [DllImport("gdi32.dll")] public static extern int CombineRgn(IntPtr dst, IntPtr a, IntPtr b, int mode);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(RP p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
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
  public static string TitleOf(IntPtr h) {
    var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString();
  }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public static string ClassOf(IntPtr h) {
    var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString();
  }
}
'@

$procs = @(Get-Process QuickLaunch,electron -ErrorAction SilentlyContinue)
if (-not $procs) { Write-Output 'QuickLaunch not running'; exit 1 }

# Match by class + geometry (never by the Chinese title: this file is read as ANSI by
# PowerShell 5.1, so a non-ASCII literal would be mojibake and never compare equal).
$dock = [IntPtr]::Zero
$bestArea = 0
foreach ($proc in $procs) {
  foreach ($h in [QLRegion]::TopWindows([uint32]$proc.Id)) {
    if ([QLRegion]::ClassOf($h) -ne 'Chrome_WidgetWin_1') { continue }
    $rr = New-Object RRECT
    [void][QLRegion]::GetWindowRect($h, [ref]$rr)
    $ww = $rr.Right - $rr.Left; $hh = $rr.Bottom - $rr.Top
    # Dock 窗口恒为 1200x300（85% 屏宽 x 300）。设置中心是 720x510 的另一扇
    # Chrome_WidgetWin_1 窗口，面积比 Dock 还大 —— 只按「面积最大」会选错窗口，
    # 读到一个没设 region 的窗口（= 整窗矩形），表现为「region 全是整窗」的假失败。
    if ($ww -lt 400 -or $hh -lt 100 -or $hh -gt 400) { continue }
    $area = $ww * $hh
    if ($area -gt $bestArea) { $bestArea = $area; $dock = $h }
  }
}
if ($dock -eq [IntPtr]::Zero) { Write-Output 'dock window not found'; exit 1 }

$r = New-Object RRECT
[void][QLRegion]::GetWindowRect($dock, [ref]$r)
$W = $r.Right - $r.Left; $H = $r.Bottom - $r.Top
Write-Output ("window 0x{0:X} rect=({1},{2}) {3}x{4} visible={5}" -f $dock.ToInt64(), $r.Left, $r.Top, $W, $H, [QLRegion]::IsWindowVisible($dock))

$rgn = [QLRegion]::CreateRectRgn(0,0,0,0)
$type = [QLRegion]::GetWindowRgn($dock, $rgn)
# 0 = ERROR, 1 = NULLREGION, 2 = SIMPLEREGION, 3 = COMPLEXREGION
$names = @{0='ERROR';1='NULLREGION(empty!)';2='SIMPLEREGION';3='COMPLEXREGION'}
Write-Output ("GetWindowRgn -> {0} ({1})" -f $type, $names[[int]$type])
if ($type -ne 0 -and $type -ne 1) {
  $box = New-Object RRECT
  $bt = [QLRegion]::GetRgnBox($rgn, [ref]$box)
  Write-Output ("region box type={0} rel=({1},{2})-({3},{4}) size={5}x{6}" -f $bt, $box.Left, $box.Top, $box.Right, $box.Bottom, ($box.Right-$box.Left), ($box.Bottom-$box.Top))
  Write-Output ("region box in screen coords=({0},{1})-({2},{3})" -f ($r.Left+$box.Left), ($r.Top+$box.Top), ($r.Left+$box.Right), ($r.Top+$box.Bottom))
}
[void][QLRegion]::DeleteObject($rgn)

# probe a few points straight away
function Who($x, $y) {
  $p = New-Object RP; $p.X = $x; $p.Y = $y
  $h = [QLRegion]::WindowFromPoint($p)
  if ($h -eq [IntPtr]::Zero) { return '?' }
  $root = [QLRegion]::GetAncestor($h, 2)
  if ($root -eq $dock) { return 'DOCK' }
  return ('other 0x{0:X}' -f $root.ToInt64())
}
$cy = $r.Top + [int]($H * 0.75)
Write-Output ("centre-bottom ({0},{1}) -> {2}" -f ($r.Left + [int]($W/2)), $cy, (Who ($r.Left + [int]($W/2)) $cy))
$ty = $r.Top + 40
Write-Output ("top-transparent ({0},{1}) -> {2}" -f ($r.Left + [int]($W/2)), $ty, (Who ($r.Left + [int]($W/2)) $ty))
