// PowerShell 层：所有 C# 常量与调用入口都收在这里（D2 拆分自 main/index.ts）。
//
// ⚠️ 本文件里的 C# 代码块必须保持**纯 ASCII**：`powershell.exe -Command <文本>`
// 按系统 ANSI 代码页（中文 Windows = GBK/936）解码命令行，而本文件是 UTF-8。
// C# 里出现中文注释会被解错多字节序列、吃掉注释结尾的 `*/`，整段语法错误 →
// Add-Type 编译失败 → 功能静默失效（只表现为「没生效」，不报错）。
// 中文说明一律写在 TS 那一侧。
import { execFile } from 'child_process'

export const ICON_EXTRACTOR_CS = `
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies 'System.Drawing' -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class IconExtractor {
    [DllImport("shell32.dll", CharSet = CharSet.Auto)]
    static extern int SHDefExtractIcon(string pszIconFile, int iIndex, uint uFlags,
        out IntPtr phiconLarge, out IntPtr phiconSmall, uint nIconSize);

    [DllImport("user32.dll")]
    static extern bool DestroyIcon(IntPtr hIcon);

    public static string GetIconBase64(string filePath, int iconIndex, uint size) {
        IntPtr hLarge, hSmall;
        int hr = SHDefExtractIcon(filePath, iconIndex, 0, out hLarge, out hSmall, size);
        if (hr != 0 || hLarge == IntPtr.Zero)
            return "";
        try {
            using (Icon icon = Icon.FromHandle(hLarge)) {
                int s = icon.Width > 0 ? icon.Width : (int)size;
                using (Bitmap bmp = new Bitmap(s, s)) {
                    bmp.MakeTransparent();
                    using (Graphics g = Graphics.FromImage(bmp)) {
                        g.Clear(Color.Transparent);
                        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                        g.DrawIcon(icon, new Rectangle(0, 0, s, s));
                    }
                    using (MemoryStream ms = new MemoryStream()) {
                        bmp.Save(ms, ImageFormat.Png);
                        return Convert.ToBase64String(ms.ToArray());
                    }
                }
            }
        } catch {
            return "";
        } finally {
            if (hLarge != IntPtr.Zero) DestroyIcon(hLarge);
            if (hSmall != IntPtr.Zero) DestroyIcon(hSmall);
        }
    }
}
'@`

/** 抽取尺寸：Dock 图标 CSS 里只有 44px（分组拼图 26px、预览卡片 17px），
 *  256px 的 PNG 每个 2~10KB，而 64px 只有 1/4 左右。base64 数据要同时活在
 *  主进程状态、IPC 消息、renderer state 与 shortcuts.json 四处字符串里，
 *  每次保存还要重序列化一遍——尺寸降一档是这里性价比最高的省内存手段。 */
export const ICON_SIZE = 64
/** 文件夹图标（黄色文件夹）尺寸再小一档：卡片行只有 17px，Dock 上也是 44px 缩放显示 */
export const FOLDER_ICON_SIZE = 48
/** 「更换图标」选 png/jpg 时的最大边：原图直接转 base64 会把整张照片写进
 *  shortcuts.json（每次保存都重序列化），统一缩到图标尺寸 */
export const PICKED_IMAGE_MAX_EDGE = 256

export const PS_ARGS = ['-NoProfile', '-NonInteractive', '-Command'] as const
export type PSResult = { err: Error | null; stdout: string; stderr: string }
/** PowerShell stdout 上限（见 runPowerShell 注释：默认 1 MiB 会让批量图标提取静默失败） */
export const PS_MAX_BUFFER = 8 * 1024 * 1024

/** 统一的 PowerShell 调用入口：一次把参数拼装收口，避免每处手写（漏掉
 *  `-NonInteractive` 时脚本遇到任何交互式提示都会挂到超时，白占一个进程）。
 *
 *  ⚠️ `maxBuffer` 必须显式给：Node 默认 1 MiB，而 stdout 超限时子进程会被杀掉、
 *  err.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' —— 所有调用点都把 err 当成
 *  「没有结果」并返回空数组，于是失败是**完全静默**的。实测 `describe-paths` 那条
 *  批量路径每个 exe 带一枚 256px 图标（约 80 KB base64），**拖入 13 个 exe 就超 1 MiB**，
 *  整批被丢弃且只提示「已跳过 N 个（重复或格式不支持）」。给到 8 MiB 后同样的 20 个
 *  没问题（实测输出 1.6 MB）。 */
export function runPowerShell(psScript: string, timeout: number, done: (r: PSResult) => void): void {
  execFile('powershell', [...PS_ARGS, psScript], { timeout, maxBuffer: PS_MAX_BUFFER }, (err, stdout, stderr) => {
    done({ err, stdout, stderr })
  })
}

export const DESKTOP_ICONS_CS = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class DesktopIcons {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter, string lpszClass, string lpszWindow);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    public static IntPtr FindDefView() {
        IntPtr progman = FindWindow("Progman", null);
        IntPtr defView = FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
        if (defView == IntPtr.Zero) {
            IntPtr worker = IntPtr.Zero;
            while ((worker = FindWindowEx(IntPtr.Zero, worker, "WorkerW", null)) != IntPtr.Zero) {
                defView = FindWindowEx(worker, IntPtr.Zero, "SHELLDLL_DefView", null);
                if (defView != IntPtr.Zero) break;
            }
        }
        return defView;
    }

    public static IntPtr FindListView() {
        IntPtr dv = FindDefView();
        if (dv == IntPtr.Zero) return IntPtr.Zero;
        return FindWindowEx(dv, IntPtr.Zero, "SysListView32", "FolderView");
    }
}
'@
[Console]::OutputEncoding = [Text.Encoding]::UTF8`

export const ACTIVATE_CS = `
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class QLActivate
{
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

    const int SW_SHOW = 5;
    const int SW_RESTORE = 9;
    const uint SWP_NOSIZE = 0x0001;
    const uint SWP_NOMOVE = 0x0002;
    const uint SWP_SHOWWINDOW = 0x0040;

    /// Pids of the target app.
    /// Match by full exe path when readable; ALSO accept a match on the exe file
    /// NAME, because reading MainModule.FileName fails for elevated / protected
    /// processes (148 of 273 processes on the dev box). Without that fallback we
    /// would report "not running" for an app that IS running and start a second
    /// copy - which is exactly what this whole feature exists to prevent.
    /// preferPath gets the pids that matched the full path (used to pick a window).
    static HashSet<int> Pids(string exePath, out HashSet<int> preferPath)
    {
        string want = exePath.ToLowerInvariant();
        string wantName = Path.GetFileNameWithoutExtension(exePath).ToLowerInvariant();
        var all = new HashSet<int>();
        preferPath = new HashSet<int>();
        foreach (var p in Process.GetProcesses())
        {
            int id; string nm;
            try { id = p.Id; nm = p.ProcessName; } catch { continue; }
            if (nm == null || !string.Equals(nm.ToLowerInvariant(), wantName, StringComparison.Ordinal)) continue;
            try {
                string fn = p.MainModule.FileName;
                if (string.Equals(fn.ToLowerInvariant(), want, StringComparison.Ordinal)) { preferPath.Add(id); all.Add(id); }
                else all.Add(id);      // same name, different path: still counts as running
            } catch { all.Add(id); }   // path unreadable: trust the name (safe side)
        }
        return all;
    }

    static IntPtr FindWindowIn(HashSet<int> pids)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, l) =>
        {
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (!pids.Contains((int)pid)) return true;
            var t = new StringBuilder(256); GetWindowText(h, t, 256);
            var c = new StringBuilder(256); GetClassName(h, c, 256);
            if (t.Length == 0) return true;
            if (c.ToString().IndexOf("IME", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            found = h;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    /// Find the app's main window. Returns 0 if none. Does NOT change any state.
    /// Only titled windows are considered: Qt/Electron apps create many untitled
    /// helper windows (message-only, IME) which must never be foregrounded.
    public static IntPtr FindWindow(string exePath)
    {
        HashSet<int> prefer;
        var all = Pids(exePath, out prefer);
        if (all.Count == 0) return IntPtr.Zero;
        return FindWindowIn(prefer.Count > 0 ? prefer : all);
    }

    /// Decide what the caller should do. THE CODES MATTER - do not collapse them:
    ///   1 = process running, window visible/minimized: shown, raised, focus attempted
    ///  -1 = process running, window hidden (tray). Caller must NOT force-show it.
    ///   0 = process running but NO titled window found (maybe still starting up)
    ///   2 = no such process at all -> the only code that may start a new instance
    ///
    /// History: this used to return 0 both for "no window found" AND for
    /// "window found but SetForegroundWindow was rejected by the foreground lock".
    /// The caller reads 0 as "maybe still starting" and retries, so a running app
    /// whose focus request was refused ended up as "cannot determine" and the click
    /// did nothing at all. A window that exists must never look like "nothing".
    public static int Probe(string exePath)
    {
        HashSet<int> prefer;
        var all = Pids(exePath, out prefer);
        if (all.Count == 0) return 2;

        IntPtr target = FindWindowIn(prefer.Count > 0 ? prefer : all);
        if (target == IntPtr.Zero) return 0;
        if (!IsWindowVisible(target) && !IsIconic(target)) return -1;

        if (IsIconic(target)) ShowWindow(target, SW_RESTORE);
        IntPtr fg = GetForegroundWindow();
        uint fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, IntPtr.Zero);
        uint me = GetCurrentThreadId();
        bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
        bool ok;
        try { ok = SetForegroundWindow(target); }
        finally { if (attached) AttachThreadInput(me, fgThread, false); }
        if (!ok)
        {
            // Foreground lock refused the focus request. Still raise the window so the
            // user sees it, and report 1: the app IS running, launching again would
            // create a duplicate.
            SetWindowPos(target, IntPtr.Zero, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            BringWindowToTop(target);
        }
        return 1;
    }

    /// Legacy 3-code view kept for the regression probes (1 = done, 0 = nothing, -1 = tray).
    public static int Activate(string exePath)
    {
        int r = Probe(exePath);
        return r == 2 ? 0 : (r == 0 ? 0 : r);
    }
}
`

export const TRAY_CLICK_CS = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

public static class QLTray
{
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);

    const string TRAY_CLS = "Shell_TrayWnd";
    const string OVERFLOW_CLS = "TopLevelWindowForOverflowXamlIsland";

    static string NameOf(AutomationElement e) { try { return e.Current.Name ?? ""; } catch { return ""; } }
    static string ClassOf(AutomationElement e) { try { return e.Current.ClassName ?? ""; } catch { return ""; } }

    static AutomationElementCollection TopLevel()
    {
        try { return AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition); }
        catch { return null; }
    }

    static AutomationElement FindTopByClass(string cls)
    {
        var tops = TopLevel();
        if (tops == null) return null;
        foreach (AutomationElement e in tops) if (ClassOf(e) == cls) return e;
        return null;
    }

    // NOTE: FindAll(NameProperty, <localized string>) returns 0 on this system even though the
    // value arrives intact and the element exists (verified by dumping every name as codepoints).
    // Walking the subtree and comparing names in managed code works, so that is what we do.
    static void Walk(AutomationElement el, int depth, int maxDepth, string want, ref AutomationElement found)
    {
        if (found != null || depth > maxDepth) return;
        AutomationElementCollection kids;
        try { kids = el.FindAll(TreeScope.Children, Condition.TrueCondition); } catch { return; }
        foreach (AutomationElement k in kids)
        {
            if (NameOf(k) == want) { found = k; return; }
            Walk(k, depth + 1, maxDepth, want, ref found);
            if (found != null) return;
        }
    }

    static AutomationElement FindButton(string showHiddenName)
    {
        var tray = FindTopByClass(TRAY_CLS);
        if (tray == null) return null;
        AutomationElement found = null;
        Walk(tray, 0, 8, showHiddenName, ref found);
        return found;
    }

    static bool Click(AutomationElement el)
    {
        object p;
        if (el == null) return false;
        try
        {
            if (el.TryGetCurrentPattern(InvokePattern.Pattern, out p)) { ((InvokePattern)p).Invoke(); return true; }
            if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p))
            {
                var ep = (ExpandCollapsePattern)p;
                if (ep.Current.ExpandCollapseState == ExpandCollapseState.Collapsed) ep.Expand(); else ep.Collapse();
                return true;
            }
            if (el.TryGetCurrentPattern(TogglePattern.Pattern, out p)) { ((TogglePattern)p).Toggle(); return true; }
        }
        catch { }
        return false;
    }

    // Titles of the target's top-level windows, joined by '|'.
    // These are the tray-tooltip candidates: WeChat's window title equals its tray tooltip, while
    // Process.MainWindowTitle is EMPTY for a hidden window. That was the real bug - the candidate
    // list fell back to the exe name ("Weixin") and the tray icon ("WeChat-CN") never matched.
    // Returned as ONE string on purpose: a C# array would make the PowerShell caller iterate.
    public static string WindowTitles(string exePath)
    {
        string want = exePath.ToLowerInvariant();
        var pids = new HashSet<int>();
        foreach (var p in System.Diagnostics.Process.GetProcesses())
        {
            try { if (string.Equals(p.MainModule.FileName.ToLowerInvariant(), want, StringComparison.Ordinal)) pids.Add(p.Id); }
            catch { }
        }
        if (pids.Count == 0) return "";
        var found = new List<string>();
        EnumWindows((h, l) =>
        {
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (!pids.Contains((int)pid)) return true;
            var c = new StringBuilder(128); GetClassName(h, c, 128);
            string cls = c.ToString();
            if (cls.IndexOf("IME", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (cls.IndexOf("MessageWindow", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            var t = new StringBuilder(256); GetWindowText(h, t, 256);
            if (t.Length == 0) return true;
            string s = t.ToString();
            if (!found.Contains(s)) found.Add(s);
            return true;
        }, IntPtr.Zero);
        return string.Join("|", found.ToArray());
    }

    // Click the tray icon whose tooltip contains any candidate name.
    // Returns 1 = clicked, 0 = no matching icon (nothing clicked), -1 = tray panel unavailable.
    // The flyout is closed again afterwards so it is never left sitting on screen.
    public static int ClickTrayIcon(string showHiddenName, string[] candidates)
    {
        var btn = FindButton(showHiddenName);
        if (btn == null) return -1;

        bool openedHere = FindTopByClass(OVERFLOW_CLS) == null;
        if (openedHere && !Click(btn)) return -1;

        AutomationElement panel = null;
        // The flyout can close again quickly when focus changes, so poll fast.
        for (int i = 0; i < 45 && panel == null; i++)
        {
            Thread.Sleep(60);
            panel = FindTopByClass(OVERFLOW_CLS);
        }
        if (panel == null) return -1;

        AutomationElement target = null;
        AutomationElementCollection items;
        try
        {
            items = panel.FindAll(TreeScope.Descendants,
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button));
        }
        catch { items = null; }
        if (items != null)
        {
            foreach (AutomationElement b in items)
            {
                string n = NameOf(b);
                if (n.Length == 0) continue;
                foreach (string cand in candidates)
                {
                    if (string.IsNullOrEmpty(cand)) continue;
                    if (n.IndexOf(cand, StringComparison.OrdinalIgnoreCase) >= 0) { target = b; break; }
                }
                if (target != null) break;
            }
        }

        int rc = 0;
        if (target != null && Click(target)) { rc = 1; Thread.Sleep(700); }

        // never leave the flyout on screen
        if (openedHere && FindTopByClass(OVERFLOW_CLS) != null) Click(btn);
        return rc;
    }
}
`
