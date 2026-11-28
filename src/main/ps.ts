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

/**
 * 音频设备（Core Audio）—— 枚举 + 切换系统默认设备。
 *
 * 用到的两个 COM 面：
 *  - `IMMDeviceEnumerator`（公开文档）枚举 render/capture 端点、读友好名与形态；
 *  - `IPolicyConfigVista`（**未文档化但 Win7→Win11 一直有效**）设默认设备。
 *
 * ⚠️ CLSID 有两个，**必须按顺序试**（本机实测只在第二个上存在）：
 *  - `{870AF99C-171D-4F9E-AF0D-E64A4906EA05}` = CPolicyConfigClient（Win7 时代常用，
 *    但在本机 Win11 上 **REGDB_E_CLASSNOTREG**，注册表里根本没有这一项）；
 *  - `{294935CE-F637-4E7C-A41B-AB255460B862}` = CPolicyConfigVistaClient，指向
 *    `AudioSes.dll`，本机注册表里只有它。
 *  所以 C# 里先试 Vista 的，失败再回退，避免换台机器又哑掉。
 *
 * ⚠️ vtable 顺序错了会抛 `NullReferenceException`（不是 HRESULT）：`IMMDeviceEnumerator`
 *  的第 1 个槽位是 `EnumAudioEndpoints`，**不是** `GetDefaultAudioEndpoint`。
 *  第一版就写成了后者在前，表现为「枚举时 NRE」——排查了一轮才定位。
 *
 * ⚠️ 角色（ERole）：0=eConsole（系统默认）、1=eMultimedia（多媒体）、
 *  2=eCommunications（通话，Discord/Teams/微信语音走这个）。只设 Console 会出现
 *  「系统切了、语音还在旧设备」，所以默认三个一起设。
 *
 * 调用约定：本块只定义类型与静态方法，**不打印任何东西**；调用方自己在末尾拼
 * `Write-Output 'AUDIOLIST=...'` 这类带标记的输出（见 audio.ts），
 * 避免 v1.13.8 那种「stdout 多一行就把整段解析打死」的事故。
 *
 * ⚠️ 首行 `[Console]::OutputEncoding = UTF8` 不能省（v1.19 修）：`execFile` 按 UTF-8
 *  解码 stdout，而 powershell.exe 在**没有控制台**的进程里（Electron 主进程 spawn 的
 *  子进程就是）默认按 OEM 代码页（中文 Windows = 936）输出 —— 设备名里的中文会变成一串
 *  U+FFFD，用户看到的是「耳机 (ZhuAudio ZG3)」显示成「���� (ZhuAudio ZG3)」。
 *  实测：同一段脚本在带 UTF-8 控制台的终端里跑完全正常，所以在开发机上很容易漏掉。
 */
export const AUDIO_CS = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$null = Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator
{
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection ppDevices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
    [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string pwstrId, out IMMDevice ppDevice);
    [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr pClient);
    [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr pClient);
}

[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceCollection
{
    [PreserveSig] int GetCount(out int pcDevices);
    [PreserveSig] int Item(int nDevice, out IMMDevice ppDevice);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice
{
    [PreserveSig] int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, out IntPtr ppInterface);
    [PreserveSig] int OpenPropertyStore(int stgmAccess, out IPropertyStore ppProperties);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
    [PreserveSig] int GetState(out int pdwState);
}

[ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyStore
{
    [PreserveSig] int GetCount(out int cProps);
    [PreserveSig] int GetAt(int iProp, out PROPERTYKEY pkey);
    [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
    [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT propvar);
    [PreserveSig] int Commit();
}

[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioEndpointVolume
{
    [PreserveSig] int RegisterControlChangeNotify(IntPtr pNotify);
    [PreserveSig] int UnregisterControlChangeNotify(IntPtr pNotify);
    [PreserveSig] int GetChannelCount(out uint pnChannelCount);
    [PreserveSig] int SetMasterVolumeLevel(float fLevelDB, IntPtr pguidEventContext);
    [PreserveSig] int SetMasterVolumeLevelScalar(float fLevel, IntPtr pguidEventContext);
    [PreserveSig] int GetMasterVolumeLevel(out float pfLevelDB);
    [PreserveSig] int GetMasterVolumeLevelScalar(out float pfLevel);
    [PreserveSig] int SetChannelVolumeLevel(uint nChannel, float fLevelDB, IntPtr pguidEventContext);
    [PreserveSig] int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, IntPtr pguidEventContext);
    [PreserveSig] int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
    [PreserveSig] int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, IntPtr pguidEventContext);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
    [PreserveSig] int GetVolumeStepInfo(out uint pnStep, out uint pnStepCount);
    [PreserveSig] int VolumeStepUp(IntPtr pguidEventContext);
    [PreserveSig] int VolumeStepDown(IntPtr pguidEventContext);
    [PreserveSig] int QueryHardwareSupport(out uint pdwHardwareSupportMask);
    [PreserveSig] int GetVolumeRange(out float pflVolumeMindB, out float pflVolumeMaxdB, out float pflVolumeIncrementdB);
}

public struct PROPERTYKEY { public Guid fmtid; public int pid; }

[StructLayout(LayoutKind.Explicit)]
public struct PROPVARIANT
{
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr ptr;
    [FieldOffset(8)] public uint uintVal;
}

[ComImport, Guid("568b9108-44bf-40b4-9006-86afe5b5a620"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPolicyConfigVista
{
    [PreserveSig] int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, out IntPtr ppFormat);
    [PreserveSig] int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, bool bDefault, out IntPtr ppFormat);
    [PreserveSig] int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, IntPtr pEndpointFormat, IntPtr mixFormat);
    [PreserveSig] int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, bool bDefault, out long pmftDefaultPeriod, out long pmftMinimumPeriod);
    [PreserveSig] int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, ref long pmftPeriod);
    [PreserveSig] int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, out IntPtr pMode);
    [PreserveSig] int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, IntPtr mode);
    [PreserveSig] int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, bool bFxStore, ref PROPERTYKEY key, out PROPVARIANT pv);
    [PreserveSig] int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, bool bFxStore, ref PROPERTYKEY key, ref PROPVARIANT pv);
    [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, int eRole);
    [PreserveSig] int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, bool bVisible);
}

public class AudioDev
{
    public string id;
    public string name;
    public string adapter;
    public string flow;
    public int formFactor;
    public bool isDefault;
    public bool isCommDefault;
}

public static class QLAudio
{
    [DllImport("ole32.dll", PreserveSig = true)]
    static extern int PropVariantClear(ref PROPVARIANT pv);

    static readonly PROPERTYKEY PKEY_FriendlyName = new PROPERTYKEY { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
    static readonly PROPERTYKEY PKEY_DeviceInterface = new PROPERTYKEY { fmtid = new Guid("026e516e-b814-414b-83cd-856d6fef4822"), pid = 2 };
    static readonly PROPERTYKEY PKEY_FormFactor = new PROPERTYKEY { fmtid = new Guid("1da5d803-d492-4edd-8c23-e0c0ffee7f0e"), pid = 0 };

    static string GetStr(IPropertyStore store, PROPERTYKEY key)
    {
        PROPVARIANT pv;
        if (store.GetValue(ref key, out pv) != 0) return "";
        try
        {
            if (pv.vt == 31 && pv.ptr != IntPtr.Zero) return Marshal.PtrToStringUni(pv.ptr) ?? "";
            if (pv.vt == 19) return pv.uintVal.ToString();
            return "";
        }
        finally { PropVariantClear(ref pv); }
    }

    public static IMMDeviceEnumerator NewEnumerator()
    {
        var t = Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"));
        return (IMMDeviceEnumerator)Activator.CreateInstance(t);
    }

    public static string DefaultId(IMMDeviceEnumerator en, int flow, int role)
    {
        IMMDevice dev;
        if (en.GetDefaultAudioEndpoint(flow, role, out dev) != 0 || dev == null) return "";
        string id;
        dev.GetId(out id);
        return id ?? "";
    }

    public static AudioDev[] List()
    {
        var en = NewEnumerator();
        var outList = new List<AudioDev>();
        for (int flow = 0; flow <= 1; flow++)
        {
            string defId = DefaultId(en, flow, 0);
            string commId = DefaultId(en, flow, 2);
            IMMDeviceCollection col;
            if (en.EnumAudioEndpoints(flow, 1, out col) != 0 || col == null) continue;
            int n;
            col.GetCount(out n);
            for (int i = 0; i < n; i++)
            {
                IMMDevice dev;
                if (col.Item(i, out dev) != 0 || dev == null) continue;
                string id;
                dev.GetId(out id);
                IPropertyStore ps;
                string name = "";
                string adapter = "";
                int formFactor = 0;
                if (dev.OpenPropertyStore(0, out ps) == 0 && ps != null)
                {
                    name = GetStr(ps, PKEY_FriendlyName);
                    adapter = GetStr(ps, PKEY_DeviceInterface);
                    int ff;
                    int.TryParse(GetStr(ps, PKEY_FormFactor), out ff);
                    formFactor = ff;
                }
                var d = new AudioDev();
                d.id = id ?? "";
                d.name = name;
                d.adapter = adapter;
                d.flow = flow == 0 ? "render" : "capture";
                d.formFactor = formFactor;
                d.isDefault = d.id == defId && defId != "";
                d.isCommDefault = d.id == commId && commId != "";
                outList.Add(d);
            }
        }
        return outList.ToArray();
    }

    static IPolicyConfigVista NewPolicyConfig()
    {
        string[] clsid = new string[] {
            "294935ce-f637-4e7c-a41b-ab255460b862",
            "870af99c-171d-4f9e-af0d-e64a4906ea05"
        };
        Exception last = null;
        for (int i = 0; i < clsid.Length; i++)
        {
            try
            {
                var t = Type.GetTypeFromCLSID(new Guid(clsid[i]));
                return (IPolicyConfigVista)Activator.CreateInstance(t);
            }
            catch (Exception ex) { last = ex; }
        }
        throw last ?? new Exception("no PolicyConfig CLSID registered");
    }

    public static int SetDefault(string deviceId, int role)
    {
        return NewPolicyConfig().SetDefaultEndpoint(deviceId, role);
    }

    // ---- 音量 / 静音（v1.19.5）：IAudioEndpointVolume ----------------------------------
    // ⚠️ vtable 顺序必须与 native 一致（缺一个 [PreserveSig] 方法就会整条错位，
    //    表现是「一调用就 AccessViolation 或返回值全是垃圾」）。方法的先后顺序就是
    //    IAudioEndpointVolume 的声明顺序，别调换。
    // ⚠️ 事件上下文参数用 IntPtr 而不是 Guid：native 收的是 LPCGUID（指针），
    //    按 Guid 传会被 marshal 成「按值」，栈上语义不对；传 IntPtr.Zero 才是 NULL。
    static IAudioEndpointVolume GetVolume(out string err)
    {
        err = null;
        try
        {
            var en = (IMMDeviceEnumerator)Activator.CreateInstance(
                Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")));
            IMMDevice dev;
            // 0 = eRender, 1 = eMultimedia（与「切默认设备」用的主角色一致）
            int hr = en.GetDefaultAudioEndpoint(0, 1, out dev);
            if (hr != 0 || dev == null) { err = "nodevice"; return null; }
            Guid iid = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
            IntPtr p;
            hr = dev.Activate(ref iid, 23 /* CLSCTX_ALL */, IntPtr.Zero, out p);
            if (hr != 0 || p == IntPtr.Zero) { err = "noactivate"; return null; }
            var vol = (IAudioEndpointVolume)Marshal.GetObjectForIUnknown(p);
            Marshal.Release(p);
            return vol;
        }
        catch (Exception ex) { err = ex.Message; return null; }
    }

    /// "VOL=<0-100>;MUTE=<0|1>"；出错时 "VOLERR=<原因>"
    public static string VolumeInfo()
    {
        string err;
        var v = GetVolume(out err);
        if (v == null) return "VOLERR=" + err;
        float level;
        v.GetMasterVolumeLevelScalar(out level);
        bool mute;
        v.GetMute(out mute);
        return "VOL=" + (int)Math.Round(level * 100f) + ";MUTE=" + (mute ? 1 : 0);
    }

    public static int SetVolume(int percent)
    {
        string err;
        var v = GetVolume(out err);
        if (v == null) return -1;
        if (percent < 0) percent = 0;
        if (percent > 100) percent = 100;
        return v.SetMasterVolumeLevelScalar(percent / 100f, IntPtr.Zero);
    }

    public static int SetMute(int mute)
    {
        string err;
        var v = GetVolume(out err);
        if (v == null) return -1;
        return v.SetMute(mute != 0, IntPtr.Zero);
    }
}
'@`

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
  // ⚠️ `windowsHide` 必须显式给：Node 的默认值是 **false**，而本进程是 GUI 子系统
  //    （打包后没有控制台），spawn 一个控制台程序会让 Windows 给它新建一个控制台窗口 ——
  //    每次调用都闪一下黑框。全项目其它 5 处子进程（一次性探询 / 托盘点击 / 激活助手 /
  //    任务栏还原）都传了它，只有这个「唯一入口」漏了。音频枚举、盘符、桌面扫描、
  //    图标提取、沉底兜底全走这里，一次交互可能连开好几个。
  execFile(
    'powershell',
    [...PS_ARGS, psScript],
    { timeout, maxBuffer: PS_MAX_BUFFER, windowsHide: true },
    (err, stdout, stderr) => {
      done({ err, stdout, stderr })
    }
  )
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
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
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

    // Window rank: 3 = on screen, 2 = minimized (can restore), 1 = hidden (likely tray).
    // Some apps (WeChat 4.x, Chromium-based) create several TITLED windows, most of them
    // hidden helpers. Picking the first one enumerated randomly lands on a hidden window
    // and the target gets misreported as "in tray" even though its main window is open.
    // Animations: restoring a minimized window normally plays the "zoom out of the taskbar"
    // animation; that looks jarring when the window was summoned from a Dock, so we switch
    // it off for that single call and restore the caller's own setting right afterwards.
    [StructLayout(LayoutKind.Sequential)] public struct ANIMATIONINFO { public int cbSize; public int iMinAnimate; }
    // Needed by AnimationsOff / AnimationsRestore (SPI_GETANIMATION / SPI_SETANIMATION).
    // The RECT overload that the removed taskbar code used is gone with it.
    [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint param, ref ANIMATIONINFO info, uint winIni);

    /// Previous "minimize animations" setting, captured on the first AnimationsOff().
    /// -1 = not captured. Without this the app turned animations back ON for users who
    /// had them OFF system-wide (AnimationsRestore always wrote 1).
    static int animSaved = -1;

    static int AnimationsOff()
    {
        ANIMATIONINFO a = new ANIMATIONINFO();
        a.cbSize = Marshal.SizeOf(typeof(ANIMATIONINFO));
        if (animSaved < 0)
        {
            ANIMATIONINFO cur = new ANIMATIONINFO();
            cur.cbSize = a.cbSize;
            animSaved = SystemParametersInfo(0x0048 /* SPI_GETANIMATION */, 0, ref cur, 0) ? cur.iMinAnimate : 1;
        }
        a.iMinAnimate = 0;
        SystemParametersInfo(0x0049 /* SPI_SETANIMATION */, 0, ref a, 0);
        return 1;
    }

    static int AnimationsRestore()
    {
        ANIMATIONINFO a = new ANIMATIONINFO();
        a.cbSize = Marshal.SizeOf(typeof(ANIMATIONINFO));
        a.iMinAnimate = animSaved < 0 ? 1 : animSaved;
        SystemParametersInfo(0x0049, 0, ref a, 0);
        animSaved = -1;
        return 1;
    }
    static int RankWindow(IntPtr h)
    {
        if (IsIconic(h)) return 2;
        if (IsWindowVisible(h)) return 3;
        return 1;
    }

    static IntPtr FindWindowIn(HashSet<int> pids)
    {
        IntPtr found = IntPtr.Zero;
        int best = -1;
        EnumWindows((h, l) =>
        {
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (!pids.Contains((int)pid)) return true;
            var t = new StringBuilder(256); GetWindowText(h, t, 256);
            var c = new StringBuilder(256); GetClassName(h, c, 256);
            if (t.Length == 0) return true;
            if (c.ToString().IndexOf("IME", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            // Keep scanning: the best (most visible) candidate may come later.
            // Same rank: prefer a real main window over a tool/owned helper. WeChat 4 keeps
            // several hidden titled windows (e.g. "Weixin" = Qt QWindowToolSaveBits); picking
            // one of those by enumeration order would restore a tooltip instead of the app.
            int rank = RankWindow(h) * 10 + (IsHelperWindow(h) ? 0 : 1);
            if (rank > best) { best = rank; found = h; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    /// Windows that must never be mistaken for "the app's main window": tool windows
    /// (tray tooltips, IME hosts, Qt helper windows) and owned windows (dialogs/popups).
    static bool IsHelperWindow(IntPtr h)
    {
        long ex = GetWindowLong(h, -20 /* GWL_EXSTYLE */);
        if ((ex & 0x00000080 /* WS_EX_TOOLWINDOW */) != 0) return true;
        if (GetWindow(h, 4 /* GW_OWNER */) != IntPtr.Zero) return true;
        return false;
    }

    /// Bring a window to the front and try to give it focus, walking the usual fallbacks:
    /// attach to the foreground thread -> synthetic Alt (satisfies the "last input" rule)
    /// -> TOPMOST bounce -> plain raise. Focus may still be refused; callers treat the
    /// window as successfully restored because launching again would duplicate the app.
    static void RaiseAndFocus(IntPtr target)
    {
        IntPtr fg = GetForegroundWindow();
        uint fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, IntPtr.Zero);
        uint me = GetCurrentThreadId();
        bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
        bool ok;
        try { ok = SetForegroundWindow(target); }
        finally { if (attached) AttachThreadInput(me, fgThread, false); }
        // Foreground lock often refuses a plain SetForegroundWindow from a background process.
        // The classic way out: bounce the window through TOPMOST (always allowed), which makes
        // it the active window, then drop TOPMOST again so it behaves normally.
        if (!ok)
        {
            keybd_event(0x12, 0, 0, IntPtr.Zero);
            keybd_event(0x12, 0, 2 /* KEYEVENTF_KEYUP */, IntPtr.Zero);
            SetWindowPos(target, (IntPtr)(-1) /* HWND_TOPMOST */, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            ok = SetForegroundWindow(target);
            SetWindowPos(target, (IntPtr)(-2) /* HWND_NOTOPMOST */, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
        }
        if (!ok)
        {
            // Foreground lock refused the focus request. Still raise the window so the
            // user sees it, and report 1: the app IS running, launching again would
            // create a duplicate.
            SetWindowPos(target, IntPtr.Zero, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            BringWindowToTop(target);
        }
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
        // 1 = hidden: the app really has no visible/minimized window (tray-only state).
        if (RankWindow(target) == 1) return -1;

        bool wasIconic = IsIconic(target);
        if (wasIconic)
        {
            AnimationsOff();                      // no "fly out of the taskbar" animation
            ShowWindow(target, SW_RESTORE);
        }
        RaiseAndFocus(target);
        if (wasIconic) AnimationsRestore();
        return 1;
    }

    /// Legacy 3-code view kept for the regression probes (1 = done, 0 = nothing, -1 = tray).
    public static int Activate(string exePath)
    {
        int r = Probe(exePath);
        return r == 2 ? 0 : (r == 0 ? 0 : r);
    }

    /// Push OUR OWN window to the bottom of the z-order (Dock "retreat").
    /// Must be paired with setAlwaysOnTop(false) on the Electron side: SetWindowPos(HWND_BOTTOM)
    /// on a TOPMOST window only sinks it to the bottom of the topmost band, still above every
    /// normal window -- that is why "sink" looked like a no-op.
    /// Called through the resident helper, so this is a ~20ms round trip instead of a
    /// fresh powershell start (~700ms) -- the difference between "Dock gets out of the way
    /// immediately" and "Dock hangs over the app you just opened, then disappears".
    public static int Sink(string hwndHex)
    {
        IntPtr h = (IntPtr)Convert.ToInt64(hwndHex, 16);
        // HWND_BOTTOM=1, SWP_NOSIZE|SWP_NOMOVE|SWP_NOACTIVATE
        bool ok = SetWindowPos(h, (IntPtr)1, 0, 0, 0, 0, 0x0002 | 0x0001 | 0x0010);
        return ok ? 1 : 0;
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
