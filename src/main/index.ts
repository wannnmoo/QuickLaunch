import { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, globalShortcut, nativeImage, screen, clipboard } from 'electron'
import { join, basename, extname, dirname } from 'path'
import { readFileSync, writeFileSync, rmSync, existsSync, statSync, watch, promises as fsp, type FSWatcher, type Dirent } from 'fs'
import { execFile, execFileSync, exec } from 'child_process'


let mainWindow: BrowserWindow | null = null
let forceQuit = false
let tray: Tray | null = null
// 系统文件/文件夹对话框打开期间禁止 Dock 沉底：模态对话框跟随父窗口层级，
// 若此时 blur/mouseleave 触发沉底，对话框会被连带压到其他软件下面
let dialogOpen = false

// 单实例锁：防止重复启动（开机自启已在运行、用户又手动启动 exe）时出现两个 Dock。
// 后启动的实例直接退出，并唤起已有实例的窗口。必须在 app ready 前调用。
// 开发模式下除了 electron.exe 实例，还可能出现 `electron-vite dev` 自己拉起的实例，
// 拿不到锁时静默退出会让人以为「点了没反应」，所以留一行日志说明。
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  console.log('[app] 已有实例在运行，本次启动退出')
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!mainWindow.isVisible()) mainWindow.show()
      dockTrayHidden = false
      sinkSeq++
      recoverDock(mainWindow)
      mainWindow.focus()
    }
  })
}

// Dock 是否隐藏到托盘（我们主动维护的打开/关闭意图状态）。
// 不依赖 isAlwaysOnTop() 判断：当桌面无其他窗口（前台被 Progman 桌面持有）时，
// show()+focus() 的激活会被前台锁拒绝——Dock 短暂获得焦点后约 500ms 被抢回，
// 触发一次虚假 blur 把 Dock 压到底部（仍可见）；此时若按键逻辑读置顶位，就会陷入
// 「显示→被压底→再次显示→再次被压底」的死循环，Alt+Space 永远无法隐藏（v1.7.1 修复）。
let dockTrayHidden = false

// ─── 沉底节流：绝不在「窗口刚露头」时起 PowerShell ──────────────────────────
// 实测（本机 PowerShell 5.1）：`powershell.exe -NoProfile -NonInteractive -Command <WinZ 脚本>`
// 单次 690~785ms CPU 时间——进程启动 ~450ms + .NET 运行时初始化 + Add-Type 编译 C# ~250ms，
// 每次还要额外占几十 MB 私有内存。而 blur 在以下场景里是「假让位」：显示器/DPI 变化重建
// 窗口、开机自启那一下、Dock 被唤回后系统把前台还给原来的窗口。这些都不是用户在点别的软件。
// 所以把「启动/唤回之后 2.5s 内」的 blur 一律忽略：这段时间里 Dock 本来就还没进入
// 稳定置顶态，沉底要么立刻被恢复逻辑撤销（白跑一个进程），要么把 Dock 压到底。
let dockShownAt = 0
/** 「刚显示出来」的沉底宽限期。
 *  ⚠️⚠️ **这个值必须 > `verifyDockOnTop()` 巡检链的最长寿命（5 次 × 250ms = 1250ms）**，
 *  这是一条没写在代码里的隐式耦合：`blur` 路径**不会** `sinkSeq++`，所以能拦住巡检把窗口
 *  重新置顶的只有宽限期。推理：任何合法的沉底都要求距最近一次 `markDockShown()` 已过
 *  2.5s，而那次 `markDockShown()` 启动的巡检链最多活 1.25s，必然早已结束 → 今天不冲突。
 *  **若把这里调到 ≤1250ms（比如为了「让位更跟手」）或加大巡检重试次数，巡检就会在沉底后
 *  重新 `setAlwaysOnTop(true) + moveTop()`，让位特性 100% 失效**（与 v1.13.1 那次回归同症状），
 *  而回归脚本 `sink-logic.cjs` 把 `canSinkNow()` 硬编码成 `return true`，**测不出来**。
 *  更彻底的解法是让 `blur` 也 `sinkSeq++`（代际守卫天然覆盖，不再依赖宽限期长度）。 */
const SINK_GRACE_MS = 2500

/** 记录一次「Dock 应该在上面」的显示时机：恢复置顶与显示窗口的所有路径都要调用它。
 *  它同时是沉底节流的时间基准（见 SINK_GRACE_MS）。 */
function markDockShown(): void {
  dockShownAt = Date.now()
}

/** 现在是否允许沉底：刚显示出来的 2.5s 内不沉（那段时间的 blur 都是焦点抖动）。
 *  这是**省资源**的守卫，不是正确性守卫——真正的正确性由 sinkSeq 代数保证。 */
function canSinkNow(): boolean {
  return Date.now() - dockShownAt > SINK_GRACE_MS
}

// ─── 沉底/恢复的意图代数（v1.11.0 竞态修复）─────────────────────────────
// 沉底不是同步的：blur 里先 setAlwaysOnTop(false)，再由 PowerShell（首次 Add-Type
// 要编译 C#，实测 200ms~1s）异步调 SetWindowPos(HWND_BOTTOM)。这段时间里任何
// 「把 Dock 拉回来」的操作（Alt+Space / 托盘 / 鼠标移回 / 启动失败恢复）都可能发生。
// 原实现只在 PS 回调里补一次 `isAlwaysOnTop()` 判断，但那只能挡住「已恢复置顶」这一种
// 情况——**挡不住 toggleWindow 的隐藏分支**：窗口被 hide() 后 PS 回调可能把 HWND_BOTTOM
// 钉在一个隐藏窗口上，之后再 show() 就埋在别的窗口底下（可见却不在前台的「卡住」状态，
// 只能靠最小化/回桌面才恢复）。改为单调递增的代数：任何「拉回/隐藏」都 ++，
// 沉底任务在启动前与回调里各比对一次，并对同一目标串行化。
let sinkSeq = 0
/** 目标窗口当前是否有沉底任务在跑（用于串行化，避免一次 blur 起一个 powershell.exe） */
let sinkState: { win: BrowserWindow; seq: number } | null = null

/** 把 Dock 拉回前台。统一入口：置顶 + moveTop，并在 120ms 后再补一次——
 *  Windows 的前台激活锁可能拒绝首次激活（尤其刚从 explorer.exe 交接时），
 *  一次性 moveTop 会被 Explorer 的窗口重排盖掉。 */
function recoverDock(win: BrowserWindow): void {
  markDockShown()
  win.setAlwaysOnTop(true)
  win.moveTop()
  setTimeout(() => {
    if (!win.isDestroyed() && win.isVisible()) win.moveTop()
  }, 120)
  // 兜底自愈：上面两步都是异步生效的（setAlwaysOnTop 走的是消息队列，moveTop 只把窗口
  // 提到「同一组内的顶部」，并不重新断言置顶位），而沉底那侧是一个滞后几百毫秒的
  // PowerShell。任何一次顺序错位都会留下「窗口可见、但不置顶、沉在别的窗口下面」的
  // 粘滞状态——用户看到的就是「快捷键怎么按都不出来，只有回桌面才恢复」。
  // 这里主动核实一次，详见 verifyDockOnTop。
  verifyDockOnTop(win, sinkSeq, 0)
}

/** 自愈巡检：窗口「可见、且没有收在托盘里」就应该置顶并持有焦点。
 *  判定用两个信号，缺一不可：
 *   ① dockTrayHidden —— 用户主动收起（Alt+Space / 关窗），不该拉回来；
 *   ② sinkSeq 未变 —— 期间没有发生新的「让位」意图。用户点了别的软件会触发 blur →
 *      sinkSeq++，此时绝不能把窗口拽回来（那就成了和用户对着干）。
 *  两者都满足却仍没拿到焦点，说明是竞态留下的错位状态：补一次置顶断言并复查，
 *  最多 4 次后放弃（永不无限重试）。 */
function verifyDockOnTop(win: BrowserWindow, startSeq: number, attempt: number): void {
  if (attempt > 4) return
  setTimeout(() => {
    if (win.isDestroyed() || win !== mainWindow) return
    if (dockTrayHidden || !win.isVisible()) return
    if (sinkSeq !== startSeq) return // 期间有更新的让位/唤回意图，交给那条路径
    if (win.isFocused() && win.isAlwaysOnTop()) return // 已经正常，收工
    win.setAlwaysOnTop(true)
    win.moveTop()
    verifyDockOnTop(win, startSeq, attempt + 1)
  }, 250)
}

/**
 * 显示/隐藏 Dock。fromKeyboard=true（Alt+Space）时，显示后额外通知 renderer 进入
 * 键盘导航模式（恢复到上次选中的位置，没有记忆则第一个图标）；托盘点击等鼠标路径不进入导航。
 */
function toggleWindow(fromKeyboard = false): void {
  // ⚠️ 必须连 isDestroyed() 一起判：退出序列里 mainWindow 仍指向已销毁的窗口，
  //    下面第一句 isVisible() 会抛 "Object has been destroyed"（全文件唯一漏点）。
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (dockTrayHidden || !mainWindow.isVisible()) {
    // 隐藏到托盘 / 不可见 → 唤回置顶显示
    dockTrayHidden = false
    sinkSeq++ // 声明意图：立刻作废在途的沉底（否则它迟到执行会把这扇刚显示的窗钉到底部）
    markDockShown() // 刚开始显示：接下来 2.5s 内的 blur 都是焦点抖动，不沉底
    mainWindow.show()
    recoverDock(mainWindow)
    mainWindow.focus()
    if (fromKeyboard && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('nav-enter')
    }
  } else {
    // 可见（置顶或被沉底）→ 隐藏到托盘
    dockTrayHidden = true
    sinkSeq++ // 隐藏同样作废在途沉底：不能让它去操作一扇已隐藏的窗口
    mainWindow.hide()
  }
}

// ─── Shared C# icon extractor (PowerShell + P/Invoke) ───────────────────────

const ICON_EXTRACTOR_CS = `
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
const ICON_SIZE = 64
/** 文件夹图标（黄色文件夹）尺寸再小一档：卡片行只有 17px，Dock 上也是 44px 缩放显示 */
const FOLDER_ICON_SIZE = 48

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-Command'] as const
type PSResult = { err: Error | null; stdout: string; stderr: string }
/** PowerShell stdout 上限（见 runPowerShell 注释：默认 1 MiB 会让批量图标提取静默失败） */
const PS_MAX_BUFFER = 8 * 1024 * 1024

/** 统一的 PowerShell 调用入口：一次把参数拼装收口，避免每处手写（漏掉
 *  `-NonInteractive` 时脚本遇到任何交互式提示都会挂到超时，白占一个进程）。
 *
 *  ⚠️ `maxBuffer` 必须显式给：Node 默认 1 MiB，而 stdout 超限时子进程会被杀掉、
 *  err.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' —— 所有调用点都把 err 当成
 *  「没有结果」并返回空数组，于是失败是**完全静默**的。实测 `describe-paths` 那条
 *  批量路径每个 exe 带一枚 256px 图标（约 80 KB base64），**拖入 13 个 exe 就超 1 MiB**，
 *  整批被丢弃且只提示「已跳过 N 个（重复或格式不支持）」。给到 8 MiB 后同样的 20 个
 *  没问题（实测输出 1.6 MB）。 */
function runPowerShell(psScript: string, timeout: number, done: (r: PSResult) => void): void {
  execFile('powershell', [...PS_ARGS, psScript], { timeout, maxBuffer: PS_MAX_BUFFER }, (err, stdout, stderr) => {
    done({ err, stdout, stderr })
  })
}

/** Run PowerShell to extract an icon from a DLL/EXE and return a data: URL. */function extractIcon(iconFile: string, iconIndex: number, size = ICON_SIZE): Promise<string> {
  return new Promise((resolve) => {
    const psScript = `${ICON_EXTRACTOR_CS}
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$b64 = [IconExtractor]::GetIconBase64('${iconFile.replace(/'/g, "''")}', ${iconIndex}, ${size})
Write-Output $b64`
    runPowerShell(psScript, 10000, ({ err, stdout }) => {
      // ⚠️ 只取**最后一行**：这个脚本里 `Add-Type` 编译、`[Console]::OutputEncoding`
      //    赋值以及将来任何新增的语句都可能往 stdout 漏一行（v1.13.8 就因为
      //    「未抑制的方法返回值」把桌面图标开关整条特性搞哑了）。base64 是最后写的，
      //    取最后一行即可，比「整段 trim 当载荷」稳得多（与 clickTrayIconFor 一致）。
      const lines = String(stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      const b64 = lines.length > 0 ? lines[lines.length - 1] : ''
      if (err || !b64) { resolve(''); return }
      resolve('data:image/png;base64,' + b64)
    })
  })
}

// ─── IPC: parse .lnk shortcut file via PowerShell ──────────────────────────

// 新增文件/文件夹对话框的默认起始目录 = 桌面。
// ⚠️ 不要写 `existsSync('D:\\Desktop') ? 'D:\\Desktop' : app.getPath('desktop')`：
//    这个值同时决定 `scan-desktop-folders` **扫哪个目录**、`startDesktopWatch` 用
//    `fs.watch` **盯哪个目录**、以及三个对话框的默认位置。桌面被重定向到 D:\Desktop 的
//    机器上 `app.getPath('desktop')` 本来就会返回 D:\Desktop；而在「D:\Desktop 恰好存在
//    但并不是桌面」的机器上，硬编码会让 Dock 把那个目录当成桌面（扫描/监听全错，真桌面
//    新增的文件夹永远不出现）。以系统 shell 文件夹为唯一真相源。
function desktopPath(): string {
  return app.getPath('desktop')
}
const DEFAULT_DIALOG_PATH = desktopPath()

// 解析单个 .lnk/.url/.pif 快捷方式文件，返回该文件的完整信息
function parseLnkFile(filePath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const psScript = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
${ICON_EXTRACTOR_CS}

$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${filePath.replace(/'/g, "''")}')
$targetPath = $s.TargetPath
$isUrl = ($targetPath -match '^(https?|ftp|steam)://|^mailto:')

# .url 文件是 INI 格式：WScript.Shell 读不到 TargetPath（实测为空），
# 需从 INI 解析 URL 字段，否则 isUrl 判定失败导致图标/名称全部丢失
$urlIni = @()
if ([System.IO.Path]::GetExtension('${filePath.replace(/'/g, "''")}').ToLowerInvariant() -eq '.url') {
  $urlIni = Get-Content '${filePath.replace(/'/g, "''")}' -Encoding Default -ErrorAction SilentlyContinue
  if (-not $targetPath) {
    foreach ($line in $urlIni) {
      if ($line -match '^URL\\s*=\\s*(.+)$') {
        $targetPath = $Matches[1].Trim()
        break
      }
    }
    $isUrl = ($targetPath -match '^(https?|ftp|steam)://|^mailto:')
  }
}

# Parse IconLocation: "path,index" -> icon file & index
$iconFile = $targetPath
$iconIdx = 0
$loc = $s.IconLocation
if ($loc -and $loc -match '(.+),(-?\\d+)$') {
    $parsedPath = $Matches[1].Trim()
    if ($parsedPath -and (Test-Path $parsedPath)) {
        $iconFile = $parsedPath
        $iconIdx = [int]$Matches[2]
    }
}

# For .url files: try to read IconFile from the raw INI contents
if ($isUrl -and $urlIni) {
  foreach ($line in $urlIni) {
    if ($line -match '^IconFile\\s*=\\s*(.+)$') {
      $iniIcon = $Matches[1].Trim()
      if ($iniIcon -match '^(https?|ftp)://') {
        # Download favicon to temp file
        try {
          $tmpIco = [System.IO.Path]::GetTempFileName() + '.ico'
          (New-Object System.Net.WebClient).DownloadFile($iniIcon, $tmpIco)
          if (Test-Path $tmpIco) {
            $raw = [System.IO.File]::ReadAllBytes($tmpIco)
            $iconBase64 = [Convert]::ToBase64String($raw)
            Remove-Item $tmpIco -Force
          }
        } catch {}
      } elseif (Test-Path $iniIcon) {
        $iconFile = $iniIcon
        # 逐行标量匹配（数组 -match 不会设置 $Matches，且值可能是空行）
        foreach ($iniLine in $urlIni) {
          if ($iniLine -match 'IconIndex\\s*=\\s*(\\d+)') { $iconIdx = [int]$Matches[1]; break }
        }
      }
      break
    }
  }
}

if (-not $iconBase64) {
  $iconBase64 = ''
  # 图标优先级（通用方案）：
  # 1) IconLocation 指定的图标文件，或快捷方式目标自身——是普通文件就提取（尊重自定义图标）
  if ($iconFile -and (Test-Path $iconFile -PathType Leaf)) {
    $iconBase64 = [IconExtractor]::GetIconBase64($iconFile, $iconIdx, ${ICON_SIZE})
  }
  # 2) 目标是文件夹：SHDefExtractIcon 对目录返回 E_FAIL 无法取图标，上面提取失败时
  #    统一回退系统黄色文件夹图标（与「添加文件夹」select-folder 一致）
  #    尺寸必须用 FOLDER_ICON_SIZE：写死 256 会让同一张黄色文件夹图标出现 256/48 两种
  #    base64 并存（磁盘更大、内存里也多一份无用的高清图）
  #    注意：JS 模板字符串里路径必须写双反斜杠 \\，单反斜杠会被当成转义吞掉
  if (-not $iconBase64 -and $targetPath -and (Test-Path $targetPath -PathType Container)) {
    $iconBase64 = [IconExtractor]::GetIconBase64('C:\\Windows\\System32\\shell32.dll', 4, ${FOLDER_ICON_SIZE})
  }

  # Fallback for URL shortcuts: use default browser icon
  if (-not $iconBase64 -and $isUrl) {
    $browserExe = (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice' -ErrorAction SilentlyContinue).ProgId
    if (-not $browserExe) { $browserExe = 'ChromeHTML' }
    $browserCmd = (Get-ItemProperty "HKLM:\\Software\\Classes\\$browserExe\\shell\\open\\command" -ErrorAction SilentlyContinue).'(Default)'
    if ($browserCmd -and $browserCmd -match '^"([^"]+)"') {
      $iconBase64 = [IconExtractor]::GetIconBase64($Matches[1], 0, ${ICON_SIZE})
    }
    # last resort: globe icon from shell32.dll
    if (-not $iconBase64) {
      $iconBase64 = [IconExtractor]::GetIconBase64('C:\\Windows\\System32\\shell32.dll', 13, ${ICON_SIZE})
    }
  }

  # 终极兜底：目标不存在/图标提取全部失败时给通用文档图标（shell32 index 1），避免 Dock 破图
  if (-not $iconBase64) {
    $iconBase64 = [IconExtractor]::GetIconBase64('C:\\Windows\\System32\\shell32.dll', 1, ${ICON_SIZE})
  }
}

# Extract display name —— 优先级：快捷方式自身描述 → 目标 exe 版本信息 → 快捷方式文件名 → 目标文件名。
# 描述放最前：wscript.exe 这类脚本宿主没有有意义的 FileDescription（会显示成 "Windows Script Host"），
# 而快捷方式自带的描述（如 "DeepSeek Harness"）才是用户在 Explorer 里看到的名称
$displayName = ''
if (-not $displayName) { $displayName = $s.Description }
if (-not $displayName -and -not $isUrl -and $targetPath -and (Test-Path $targetPath)) {
  try { $displayName = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($targetPath).FileDescription } catch {}
}
if (-not $displayName) {
  $displayName = [System.IO.Path]::GetFileNameWithoutExtension('${filePath.replace(/'/g, "''")}')
}
if (-not $displayName -and -not $isUrl -and $targetPath) {
  $displayName = [System.IO.Path]::GetFileNameWithoutExtension($targetPath)
}

@{
  targetPath = $targetPath
  arguments = $s.Arguments
  workingDirectory = $s.WorkingDirectory
  windowStyle = $s.WindowStyle
  hotkey = $s.Hotkey
  iconLocation = $s.IconLocation
  description = $displayName
  iconBase64 = $iconBase64
  isUrl = $isUrl
} | ConvertTo-Json -Compress
`
    runPowerShell(psScript, 10000, ({ err, stdout }) => {
      if (err) { reject(err); return }
      try {
        const data = JSON.parse(stdout.trim())
        if (data.iconBase64) {
          data.iconDataUrl = 'data:image/png;base64,' + data.iconBase64
        }
        delete data.iconBase64
        resolve(data)
      } catch {
        reject(new Error('Failed to parse .lnk file'))
      }
    })
  })
}

/** 弹系统文件/文件夹对话框（三个 IPC 共用）。
 *  ① 对话框打开期间置 dialogOpen + 把 Dock 顶到最前：模态对话框跟随父窗口层级，
 *     否则会被其他软件压下去；
 *  ② 把 `mainWindow` 作为 **parent** 传进去，对话框才是窗口的**真模态子窗口**——
 *     挡住 Dock 的输入（避免用户在对话框开着时又点开菜单/右键菜单，把弹层状态搞乱），
 *     Windows 也会把对话框排进父窗口的 z-order 组。
 *  ⚠️ 不要写 `disabled: true`：`OpenDialogOptions` **没有这个字段**（Electron 的
 *     showOpenDialog 选项只有 title/defaultPath/buttonLabel/filters/properties/message/
 *     securityScopedBookmarks），写进去是空操作；它能骗过 TS 只是因为它是通过
 *     `...(parent ? { disabled: true } : {})` 展开进去的（多余属性检查对展开不生效）。
 *     真正提供模态的是 parent 参数。 */
function showOpenDialogSafe(options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> {
  dialogOpen = true
  mainWindow?.setAlwaysOnTop(true)
  mainWindow?.moveTop()
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
  // ⚠️ 必须 try/finally 而不能只挂 .finally()：showOpenDialog 若**同步**抛错（父窗口状态
  // 异常等），`.finally()` 根本注册不上，dialogOpen 会永久停在 true —— 之后 blur 处理里的
  // `if (dialogOpen) return` 会让 Dock 再也不沉底（直到重启）。
  try {
    return dialog
      .showOpenDialog(parent!, options)
      .finally(() => { dialogOpen = false })
  } catch (err) {
    dialogOpen = false
    return Promise.reject(err)
  }
}

ipcMain.handle('parse-lnk', async (_event, filePath?: string) => {
  if (!filePath) {
    const result = await showOpenDialogSafe({
      title: '选择快捷方式文件',
      defaultPath: DEFAULT_DIALOG_PATH,
      filters: [
        { name: '所有快捷方式', extensions: ['lnk', 'url', 'pif'] },
        { name: '全部文件', extensions: ['*'] }
      ],
      // openFile + multiSelections：Win32 原生（IFileOpenDialog）支持多选
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return []
    // 多选：逐个解析快捷方式，单个解析失败不影响其余
    const parsed = await Promise.all(
      result.filePaths.map((p) => parseLnkFile(p).catch(() => null))
    )
    return parsed.filter(Boolean)
  }
  // 显式传路径时同样返回数组，保持返回类型一致（LnkInfo[]）。
  // 解析失败（文件坏、PS 超时、JSON 解析失败）时返回空数组而不是让 invoke 直接 reject ——
  // 与上面的对话框分支一致，调用方不必再包一层 try/catch
  try {
    return [await parseLnkFile(filePath)]
  } catch {
    return []
  }
})

// ─── IPC: persist shortcuts ─────────────────────────────────────────────────

const shortcutsPath = join(app.getPath('userData'), 'shortcuts.json')

// ─── 窗口停靠位置（下 / 中间 / 上，左/右竖排预留）─────────────────────────
// Dock **不支持自由拖动**：窗口位置完全由「位置」预设决定（下/上贴边居中、中间居中），
// 没有 app-region 拖动区、没有位置记忆。要挪位置就点菜单里的「位置」。
// 好处是位置永远确定（不会停在半空 / 拖出屏幕 / 与贴边吸附打架），
// 也省掉了整套拖动期间的位置补偿逻辑（那套在拖动中做不干净，会闪）。
// 左/右竖排的窗口形状与几何已预留在类型和 windowSizeFor/presetPosition 里。

/** 已经实现的停靠位置（左/右竖排还没做：类型里保留，但不接受写入也不需要重建窗口） */
const DOCK_EDGES = ['bottom', 'top', 'left', 'right', 'middle'] as const
type DockEdge = (typeof DOCK_EDGES)[number]
const IMPLEMENTED_EDGES: readonly DockEdge[] = ['bottom', 'top', 'middle']
const isImplementedEdge = (v: unknown): v is DockEdge =>
  typeof v === 'string' && IMPLEMENTED_EDGES.includes(v as DockEdge)
/** 横条 = 图标横向排列（下/上/中间）；竖条 = 图标纵向排列（左右边） */
const isVerticalDock = (edge: DockEdge): boolean => edge === 'left' || edge === 'right'
/** 玻璃条高度（与 CSS 里 .dock-bg 的 76px 一致，**不是** .dock 的 146px——
 *  146 含上方 70px 透明放大区）。「中间」位置用它把可见的玻璃条居中 */
const DOCK_GLASS_H = 76
/** 默认停靠位置：悬浮在屏幕中间（四周都有空间，悬停放大的幅度不受屏幕边缘影响） */
const DEFAULT_EDGE: DockEdge = 'middle'

/** 只存停靠位置（历史文件里的坐标字段会被忽略：不再有自由拖动） */
const layoutPath = join(app.getPath('userData'), 'window-position.json')

/** 当前停靠位置（窗口创建时从记忆里读，切换位置时原地应用或重建窗口） */
let dockEdge: DockEdge = DEFAULT_EDGE
/** 重建窗口期间抑制 window-all-closed 的退出（destroy 旧窗口会触发一次） */
let recreatingWindow = false

/** 读取记忆的停靠位置。只认已实现的三档：历史文件里若残留 left/right（竖排还没做），
 *  一律回落到默认值——否则会建出竖窗口却按横条布局画，选择器还会三档全不亮 */
function readDockEdge(): DockEdge {
  try {
    if (!existsSync(layoutPath)) return DEFAULT_EDGE
    const raw = JSON.parse(readFileSync(layoutPath, 'utf-8')) as Record<string, unknown>
    return isImplementedEdge(raw.edge) ? raw.edge : DEFAULT_EDGE
  } catch { return DEFAULT_EDGE }
}

function writeDockEdge(edge: DockEdge): void {
  try { writeFileSync(layoutPath, JSON.stringify({ edge }), 'utf-8') } catch {}
}

/** 停靠位置决定窗口形状：横条是「宽 85% × 高 300」（下/上/中间），竖条（下一阶段）是「宽 300 × 高 85%」 */
function windowSizeFor(edge: DockEdge): { w: number; h: number } {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  if (isVerticalDock(edge)) return { w: 300, h: Math.min(Math.round(height * 0.85), 1200) }
  return { w: Math.min(Math.round(width * 0.85), 1200), h: 300 }
}

/** 各停靠位置的窗口坐标（Dock 不支持自由拖动，位置只由这里决定）：
 *  - 下 / 上：水平居中、吸附到工作区下沿 / 上沿
 *  - 中间：水平居中，并让**可见的玻璃条**（76px，不是 .dock 的 146px）中心落在工作区中心
 *  - 左 / 右：垂直居中、吸附到左沿 / 右沿（竖排下一阶段） */
function presetPosition(edge: DockEdge, size: { w: number; h: number }, wa: Electron.Rectangle): { x: number; y: number } {
  const cx = Math.round(wa.x + (wa.width - size.w) / 2)
  const cy = Math.round(wa.y + (wa.height - size.h) / 2)
  if (edge === 'middle') return { x: cx, y: Math.round(wa.y + wa.height / 2 - size.h + DOCK_GLASS_H / 2) }
  if (isVerticalDock(edge)) return { y: cy, x: edge === 'left' ? wa.x : wa.x + wa.width - size.w }
  return { x: cx, y: edge === 'bottom' ? wa.y + wa.height - size.h : wa.y }
}

/** 目标位置对应的窗口坐标（主显示器工作区内，钳制一次防止分辨率变化后跑出屏幕） */
function positionForEdge(edge: DockEdge, size: { w: number; h: number }): { x: number; y: number } {
  const wa = screen.getPrimaryDisplay().workArea
  const preset = presetPosition(edge, size, wa)
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
  return {
    x: clamp(preset.x, wa.x, wa.x + Math.max(0, wa.width - size.w)),
    y: clamp(preset.y, wa.y, wa.y + Math.max(0, wa.height - size.h))
  }
}

/** 只做「销毁旧窗口 + 按指定位置重建」（竖排换窗口形状时用）。
 *  重建失败会留下「没有窗口」的死状态（Alt+Space 与托盘「显示窗口」都依赖 mainWindow），
 *  所以这里兜一次重试并把错误打出来，至少留下可诊断的痕迹 */
function recreateWindowForEdge(next: DockEdge, hidden: boolean): void {
  recreatingWindow = true
  const old = mainWindow
  mainWindow = null
  try { old?.destroy() } catch {}
  try {
    createWindow(next, hidden)
  } catch (err) {
    console.error('[window] 重建窗口失败，重试一次:', err)
    try { createWindow(next, hidden) } catch (err2) { console.error('[window] 重建窗口再次失败:', err2) }
  } finally {
    // try/finally：万一 createWindow 抛异常，标志位也必须复位，
    // 否则之后真正的「关掉最后一个窗口」会被吞掉，应用退不出去
    recreatingWindow = false
  }
}

/** 应用停靠位置（点菜单里的「位置」）。
 *  **横向三档（下 / 上 / 中间）窗口尺寸完全相同**，所以原地 `setBounds` + 通知渲染端换布局
 *  即可——瞬间生效，不用重建窗口。重建的代价是重跑一遍启动流程（读 shortcuts、PowerShell
 *  扫桌面文件夹、读驱动器），要 1~2 秒。
 *  只有尺寸真的变了（竖排左/右，下一阶段）才重建。
 *  位置只由预设决定：Dock 不支持自由拖动，所以这里不需要任何位置补偿逻辑。 */
function applyDockEdge(next: DockEdge): boolean {
  if (dockEdge !== next) writeDockEdge(next)
  const prev = dockEdge
  dockEdge = next
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow(next, dockTrayHidden)
    return true
  }
  const a = windowSizeFor(prev)
  const b = windowSizeFor(next)
  if (a.w !== b.w || a.h !== b.h) {
    recreateWindowForEdge(next, dockTrayHidden)
    return true
  }
  const pos = positionForEdge(next, { w: b.w, h: b.h })
  mainWindow.setBounds({ x: pos.x, y: pos.y, width: b.w, height: b.h })
  mainWindow.webContents.send('dock-edge-changed', next)
  return true
}

/** 切换停靠位置。已经在该位置的标准坐标上（±2px）也不早退而不发事件——
 *  渲染端可能是刚重载过的（dev HMR / Ctrl+R），它需要这条事件把布局对齐到真实位置 */
function setDockEdge(next: DockEdge): boolean {
  if (mainWindow && !mainWindow.isDestroyed() && next === dockEdge) {
    const preset = positionForEdge(next, windowSizeFor(next))
    const b = mainWindow.getBounds()
    if (Math.abs(b.x - preset.x) <= 2 && Math.abs(b.y - preset.y) <= 2) {
      // 位置已经对了：只需要把当前停靠位置同步给渲染端
      mainWindow.webContents.send('dock-edge-changed', next)
      return true
    }
  }
  return applyDockEdge(next)
}

ipcMain.handle('set-dock-edge', (_e, next: unknown) => {
  if (!isImplementedEdge(next)) return false // 左/右竖排未实现：拒绝写入，避免出现竖窗横布局
  return setDockEdge(next)
})

/** 读取当前停靠位置：渲染端挂载时用它对齐（argv 里的 `--ql-edge` 只是建窗那一刻的快照，
 *  而横向三档是原地切换、不重建窗口，所以页面重载后 argv 会过期） */
ipcMain.handle('get-dock-edge', () => dockEdge)

/** 显示器参数变化（分辨率/DPI/主屏切换/显示器增删）后重新归位：
 *  预设坐标与窗口尺寸都按当前工作区算，否则会出现「不再贴边/居中」甚至右端跑出屏幕。
 *  注意：`screen` 模块必须在 app ready 之后才能用，所以注册放在 whenReady 里 */
function reapplyDockEdgeOnDisplayChange(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  applyDockEdge(dockEdge)
}

ipcMain.handle('load-shortcuts', () => {
  try {
    if (!existsSync(shortcutsPath)) return []
    const raw: unknown = JSON.parse(readFileSync(shortcutsPath, 'utf-8'))
    // 形状校验：文件被外部改坏（合法 JSON 但不是数组）时返回空数组，
    // 否则 renderer 的 baseline.filter 会抛错并中断整轮加载/桌面扫描
    if (!Array.isArray(raw)) return []
    return raw
      // 元素级校验也不能省：`[1,"x",null]` 是合法 JSON，原样交给 renderer 会得到
      // 一堆没有 id/targetPath 的"条目"，在 normPath / 去重 / 渲染里到处是隐性地雷
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
      .map((e) => {
        // 兼容早期开发版的字段：separator: 'line' | 'gap' → isSeparator: boolean
        if (e.separator) {
          const { separator: _legacy, ...rest } = e
          return { ...rest, isSeparator: true }
        }
        return e
      })
  } catch {
    return []
  }
})

/** 写盘。v1.12.2 起 renderer 状态里存的就是真实 data URL，这里不再做任何换算。
 *  （v1.12.0/v1.12.1 曾在这里把哨兵串换成「最近见过的文件夹图标」，那个值为空时
 *   会把空串写进磁盘，是「文件夹图标永久空白」事故的最后一环。） */
function writeShortcuts(data: unknown[]): void {
  writeFileSync(shortcutsPath, JSON.stringify(data), 'utf-8')
}

ipcMain.handle('save-shortcuts', (_event, data: unknown) => {
  if (!Array.isArray(data)) return
  try { writeShortcuts(data) } catch {}
})

// ─── IPC: select a folder ───────────────────────────────────────────────────

ipcMain.handle('select-folder', async () => {
  const result = await showOpenDialogSafe({
    title: '选择文件夹',
    defaultPath: DEFAULT_DIALOG_PATH,
    // multiSelections + openDirectory：Win32 原生（IFileOpenDialog）支持文件夹多选
    properties: ['openDirectory', 'multiSelections']
  })
  if (result.canceled || result.filePaths.length === 0) return []

  // 每个选中的文件夹提取系统黄色文件夹图标。图标对所有文件夹都是同一个，
  // 所以复用常驻的那一枚（ensureFolderIcon 内部只提取一次）再让所有条目共用——
  // 原来是在 map 里逐个 await extractIcon，一次选 20 个文件夹就要起 20 个
  // powershell.exe（每个 ~500ms、几十 MB 内存）
  await ensureFolderIcon()
  const sharedIcon = folderIcon ?? ''
  return result.filePaths.map((folderPath) => ({
    path: folderPath,
    name: basename(folderPath),
    iconDataUrl: sharedIcon
  }))
})

// ─── IPC: 扫描桌面文件夹 + 系统位置（启动时自动合并） ─────────────────────
// 单次 PowerShell 调用完成全部工作（避免启动时拉起 6 个 powershell 进程）：
// 1) 枚举桌面文件夹 + 指向文件夹的 .lnk 快捷方式（WScript.Shell 解析目标，目标为目录才纳入）
// 2) 提取共享的黄色文件夹图标（shell32 index 4，失败回退通用文档图标 index 1）
// 3) 解析「此电脑」「回收站」注册表 CLSID 图标（失败逐级回退：黄色文件夹图标 → 通用文档图标）
// 返回 { path, name, iconBase64, specialType? }[]。去重由 renderer 完成。

ipcMain.handle('scan-desktop-folders', async () => {
  const desktop = desktopPath()
  return new Promise((resolve) => {
    const psScript = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
${ICON_EXTRACTOR_CS}

$desktop = '${desktop.replace(/'/g, "''")}'
$results = @()

# 1) 桌面文件夹 + 指向文件夹的 .lnk 快捷方式
if (Test-Path -LiteralPath $desktop) {
  Get-ChildItem -LiteralPath $desktop -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $results += @{ path = $_.FullName; name = $_.Name; specialType = $null }
  }
  $shell = New-Object -ComObject WScript.Shell
  Get-ChildItem -LiteralPath $desktop -Filter *.lnk -File -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $s = $shell.CreateShortcut($_.FullName)
      $target = $s.TargetPath
      if ($target -and (Test-Path -LiteralPath $target -PathType Container)) {
        $results += @{ path = $target; name = $_.BaseName; specialType = $null }
      }
    } catch {}
  }
}

# 2) 文件夹共享图标：黄色文件夹 → 通用文档兜底（只提取一次）
$folderIcon = [IconExtractor]::GetIconBase64('C:\\Windows\\System32\\shell32.dll', 4, ${FOLDER_ICON_SIZE})
if (-not $folderIcon) {
  $folderIcon = [IconExtractor]::GetIconBase64('C:\\Windows\\System32\\shell32.dll', 1, ${FOLDER_ICON_SIZE})
}

# 3) 系统位置：此电脑 / 回收站（注册表 CLSID 图标，失败逐级回退）
$specials = @(
  @{ type = 'this-pc'; clsid = '{20D04FE0-3AEA-1069-A2D8-08002B30309D}'; name = '此电脑'; shell = 'shell:MyComputerFolder' },
  @{ type = 'recycle-bin'; clsid = '{645FF040-5081-101B-9F08-00AA002F954E}'; name = '回收站'; shell = 'shell:RecycleBinFolder' }
)
foreach ($sp in $specials) {
  $iconPath = (Get-ItemProperty -Path "Registry::HKEY_CLASSES_ROOT\\CLSID\\$($sp.clsid)\\DefaultIcon" -Name '(Default)' -ErrorAction SilentlyContinue).'(Default)'
  $iconFile = 'C:\\Windows\\System32\\shell32.dll'
  $iconIdx = 15
  if ($sp.type -eq 'recycle-bin') { $iconIdx = 31 }
  if ($iconPath) {
    $expanded = [Environment]::ExpandEnvironmentVariables($iconPath)
    if ($expanded -match '^(.+?),(-?\\d+)$') {
      $iconFile = $Matches[1]
      $iconIdx = [int]$Matches[2]
    } else {
      $iconFile = $expanded
      $iconIdx = 0
    }
  }
  $iconB64 = [IconExtractor]::GetIconBase64($iconFile, $iconIdx, ${FOLDER_ICON_SIZE})
  if (-not $iconB64) { $iconB64 = $folderIcon }
  $results += @{ path = $sp.shell; name = $sp.name; specialType = $sp.type; iconBase64 = $iconB64 }
}

# 4) 文件夹条目统一附共享图标
foreach ($r in $results) {
  if (-not $r.iconBase64) { $r.iconBase64 = $folderIcon }
}

if ($results.Count -gt 0) {
  $results | ConvertTo-Json -Compress -Depth 3
}`
    runPowerShell(psScript, 20000, ({ err, stdout }) => {
      if (err || !stdout.trim()) { resolve([]); return }
      try {
        const items: { path: string; name: string; iconBase64?: string; specialType?: 'this-pc' | 'recycle-bin' }[] =
          JSON.parse(stdout.trim())
        resolve(items.map((it) => ({
          path: it.path,
          name: it.name,
          iconDataUrl: it.iconBase64 ? 'data:image/png;base64,' + it.iconBase64 : '',
          ...(it.specialType ? { specialType: it.specialType } : {})
        })))
      } catch { resolve([]) }
    })
  })
})

// ─── IPC: 文件夹条目存在性检查（实时清理被删除的桌面文件夹） ─────────────
// 纯 fs 检查（无 PowerShell）；返回传入路径中已不存在（被删除/移动/磁盘未挂载）的子集

ipcMain.handle('check-folders-missing', (_e, paths: unknown) => {
  if (!Array.isArray(paths)) return []
  return paths.filter((p): p is string => typeof p === 'string' && !!p && !existsSync(p))
})

// ─── 桌面目录实时监听（fs.watch + debounce）─────────────────────────────
// 桌面目录下任何文件/文件夹的增删改都会触发 'rename'/'change' 事件；debounce 1s
// 聚合后向 renderer 推送 desktop-changed，由 renderer 重新执行「清理缺失 + 扫描合并」：
// 桌面新增文件夹即时加入 Dock，被删除的即时移除（与启动扫描共用同一条合并逻辑）。
// 注意：非递归监听——只关心桌面的直接子项，文件夹内部文件变化不影响。

let desktopWatcher: FSWatcher | null = null
let desktopWatchTimer: ReturnType<typeof setTimeout> | null = null

function startDesktopWatch(): void {
  try {
    desktopWatcher = watch(desktopPath(), { persistent: true }, () => {
      if (desktopWatchTimer) clearTimeout(desktopWatchTimer)
      desktopWatchTimer = setTimeout(() => {
        desktopWatchTimer = null
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('desktop-changed')
        }
      }, 1000)
    })
    desktopWatcher.on('error', (err) => console.error('[desktop-watch] error:', err))
  } catch (err) {
    console.error('[desktop-watch] failed to start:', err)
  }
}

/** 收掉桌面监听与在途的 debounce 定时器。非持久化时留着 FSWatcher 只会在退出阶段
 *  多触发一次 flush 前的回调（此时窗口可能已经销毁），显式关闭更干净。 */
function stopDesktopWatch(): void {
  if (desktopWatchTimer) { clearTimeout(desktopWatchTimer); desktopWatchTimer = null }
  try { desktopWatcher?.close() } catch {}
  desktopWatcher = null
}

// ─── IPC: hide/show desktop icons ───────────────────────────────────────────
// 方案：向桌面 SHELLDLL_DefView 发送 WM_COMMAND 0x7402 —— 与 Windows
// 「右键桌面 → 查看 → 显示桌面图标」底层完全一致，不依赖 SHChangeNotify
// （该刷新在部分 Win11 系统上不生效）。0x7402 切换后 Explorer 会自动同步
// 注册表 HideIcons，状态由系统持久化。状态读取用 IsWindowVisible(ListView)，
// 比读注册表更贴近真实视觉状态。

const DESKTOP_ICONS_CS = `
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

/** 读「桌面图标是否隐藏」的 PowerShell 片段（probe 与 toggle 共用）。
 *
 *  读法顺序（v1.13.7 第三次修定下来的，别改回去）：
 *    ① **先读注册表 `HideIcons`**。它由 Explorer 维护、每次切换同步更新（实测
 *       WM_COMMAND 0x7402 之后注册表立刻从 0 变 1），是最可靠的来源；
 *       `IsWindowVisible(ListView)` 只是佐证，在自动化/无桌面的上下文里可能拿不到。
 *    ② 每个 `if` 都要有 `else`：原来写的是
 *         `if ($lv -eq 0) { 读注册表 } else { IsWindowVisible }`
 *       —— 一旦 FindListView 成功但 IsWindowVisible 不可靠，结果就偏了。
 *    ③ 两条路都拿不到 → 输出 `HIDEICONS=?`（= 状态未知），**不要**编一个 0 冒充「可见」。
 *
 *  ⚠️⚠️ 输出必须**带标记**（`HIDEICONS=<0|1>`），解析时只认标记（v1.13.8 修）：
 *    这里踩过一个把整个特性掩盖掉的坑 —— toggle 脚本里的
 *    `[DesktopIcons]::SendMessage(...)` **漏了 `[void]`**，而 PowerShell 会把
 *    **未赋值方法调用的返回值**（IntPtr 0）也写进 stdout，于是 stdout 变成两行
 *    `"0\n1"`；旧解析 `raw !== '0' && raw !== '1'` 把整段判成「读失败」→
 *    toggle 返回 null → 主进程缓存永不更新 → 菜单文案**永远卡在「隐藏桌面图标」**，
 *    而图标本身切换完全正常（用户报的就是「功能好、文案不动」）。
 *    标记式输出 = 「只扫自己那一行」，比「猜整段 stdout 长什么样」稳得多，
 *    以后任何往 stdout 漏东西的写法（Add-Type 警告、新加的方法调用……）都不会再中招。
 *    （同一类坑在托盘点击那条路径上早就有防线：那边用 `split(/\r?\n/).pop()` 取最后一行。） */
const DESKTOP_ICONS_READ_PS = `
$reg = (Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name HideIcons -ErrorAction SilentlyContinue).HideIcons
if ($null -ne $reg -and "$reg" -ne '') {
  Write-Output "HIDEICONS=$reg"
} else {
  $lv = [DesktopIcons]::FindListView()
  if ($lv -eq [IntPtr]::Zero) {
    Write-Output 'HIDEICONS=?'
  } elseif ([DesktopIcons]::IsWindowVisible($lv)) {
    Write-Output 'HIDEICONS=0'
  } else {
    Write-Output 'HIDEICONS=1'
  }
}`

/** 解析脚本 stdout 里的 `HIDEICONS=` 标记。
 *  找不到（脚本没跑完 / 两路都拿不到）返回 **null（状态未知）**，
 *  **不要**返回 false —— false 的语义是「图标可见」，把「读不到」当「可见」
 *  会让文案先渲染错值、再翻成对值（v1.13.7 踩过）。 */
function parseDesktopIconsHidden(stdout: string): boolean | null {
  const hits = String(stdout ?? '').match(/HIDEICONS=([01])/g)
  if (!hits || hits.length === 0) return null
  return hits[hits.length - 1].endsWith('1')
}

/** 真正去探测桌面图标是否隐藏（要起 PowerShell，异步）。结果写入缓存。
 *
 *  ⚠️ 返回 `boolean | null`：**探测失败时返回 null，不要返回 false**。
 *  返回 false 的语义是「图标可见」，而探测失败（超时 / PS 起不来 / 输出为空）时我们
 *  **根本不知道**真实状态。把两者混为一谈会让文案先渲染错值、再翻成对值。
 *
 *  ⚠️ 这个函数**只在启动时调用一次**（且被 await），用它把缓存填好，见 primeDesktopIconsHidden。
 *  不要在别处随手调用：它耗时 50~200ms，任何「菜单打开时再探测一次」都会让文案二次翻转。 */
function probeDesktopIconsHidden(): Promise<boolean | null> {
  return new Promise((resolve) => {
    const psScript = `${DESKTOP_ICONS_CS}${DESKTOP_ICONS_READ_PS}`
    runPowerShell(psScript, 5000, ({ stdout }) => {
      // 只认标记，不因为 err 就丢弃已经拿到的结果（PS 的非终止错误也会让退出码非零）
      const v = parseDesktopIconsHidden(stdout)
      if (v === null) {
        resolve(null)
        return
      }
      desktopIconsHiddenCache = v
      resolve(v)
    })
  })
}

/** 启动时**同步等**出第一份真值（在 createWindow 之前 await）。
 *
 *  ⚠️⚠️ 这里必须 await、不能「先建窗再异步预热」（v1.13.7 第二次踩）：
 *    renderer 用 `sendSync` 拿 useState 的初始值，那一刻缓存**必须已经填好**；
 *    否则初始值落回 false（= 图标可见），系统里其实是隐藏的 → 菜单先渲染「隐藏桌面图标」，
 *    等挂载后的异步读回来再翻成「显示桌面图标」—— 用户看到的正是这个（报障截图）。
 *    实测：缓存异步预热时同步读拿到 null，文案必然先错后翻。
 *    代价是启动多等约 50~200ms（一次 PowerShell），换文案从首帧就对，值得。 */
async function primeDesktopIconsHidden(): Promise<void> {
  await probeDesktopIconsHidden()
}

/** 读桌面图标隐藏状态 —— **只认缓存，不探测**。
 *
 *  这样「菜单打开时读一次」是零成本、且返回值与 useState 的初始值**必然一致**，
 *  文案不可能翻转。真值由启动时的 primeDesktopIconsHidden() 填、每次切换后写回。
 *  缓存为 null（启动探测失败）时返回 null，renderer 保持现状不翻转。
 *
 *  ⚠️ 不要改成「每次都去探测」：探测 50~200ms，菜单打开时读到的是旧值、
 *  等结果回来再覆盖 → 文案二次翻转（v1.13.7 踩过两次）。 */
function readDesktopIconsHidden(): Promise<boolean | null> {
  return Promise.resolve(desktopIconsHiddenCache)
}

ipcMain.handle('get-desktop-icons-hidden', () => readDesktopIconsHidden())

// 桌面图标隐藏状态的**缓存**：给「渲染进程首帧之前就要拿到真值」用。
// ⚠️ 必须缓存，不能用 sendSync + 异步读：sendSync 要求处理器**同步**设置 event.returnValue，
//    而探测要起 PowerShell、是异步的，在 .then 里赋值就已经晚了。
// ⚠️ 也必须**在 createWindow 之前填好**（见 primeDesktopIconsHidden）：否则首帧拿不到真值。
// 更新路径：① 启动时同步等一次（primeDesktopIconsHidden）② 每次切换后写回实际结果。
// 值为 null = 尚未知 / 探测失败，renderer 端保持默认且不翻转文案。
let desktopIconsHiddenCache: boolean | null = null


ipcMain.on('get-desktop-icons-hidden-sync', (event) => {
  event.returnValue = desktopIconsHiddenCache
})

// 版本号（给「+」菜单底部显示）。用 Electron 的 app.getVersion()：打包后读的是
// package.json 里的 version（electron-builder 写进 app 的 package.json），
// 开发模式读的也是同一个字段，两处一致。
ipcMain.handle('get-app-version', () => app.getVersion())


ipcMain.handle('toggle-desktop-icons', async () => {
  return new Promise<boolean | null>((resolve) => {
    const psScript = `${DESKTOP_ICONS_CS}
$dv = [DesktopIcons]::FindDefView()
if ($dv -eq [IntPtr]::Zero) {
  Write-Output 'TOGGLED=0'
  Write-Output 'HIDEICONS=?'
} else {
  # [void] is REQUIRED here: SendMessage returns an IntPtr which PowerShell would
  # otherwise write to stdout as an extra line (that stray line broke the parse,
  # see DESKTOP_ICONS_READ_PS). No Chinese here - embedded scripts stay ASCII.
  [void][DesktopIcons]::SendMessage($dv, 0x0111, [IntPtr]0x7402, [IntPtr]::Zero)
  Write-Output 'TOGGLED=1'
  Start-Sleep -Milliseconds 500
  ${DESKTOP_ICONS_READ_PS}
}`
    runPowerShell(psScript, 5000, ({ err, stdout, stderr }) => {
      const raw = String(stdout ?? '')
      const next = parseDesktopIconsHidden(raw)
      if (next !== null) {
        desktopIconsHiddenCache = next // 切换后同步缓存，供下次首帧同步读取
        resolve(next)
        return
      }
      console.error('[desktop-icons] toggle read failed:', err?.message, '| stdout:', JSON.stringify(raw.trim()), '| stderr:', stderr?.slice(0, 200))
      // 读不到结果时的兜底：0x7402 是**翻转**语义，只要命令真的发出去了
      // （TOGGLED=1），新状态必然是旧状态的反面。用它更新缓存，至少不会让缓存
      // 永远停在旧值上（那正是「文案卡住」的成因）。
      // 连缓存都没有（启动探测也失败）才返回 null，renderer 会保留自己的乐观值。
      if (/TOGGLED=1/.test(raw) && desktopIconsHiddenCache !== null) {
        desktopIconsHiddenCache = !desktopIconsHiddenCache
        resolve(desktopIconsHiddenCache)
        return
      }
      // ⚠️ 读不到就读不到，返回 null 表示「状态未知」——
      //    调用方（renderer）据此**保留自己的乐观值**，不要把它当成「图标可见」。
      resolve(null)
    })
  })
})

// ─── IPC: 开机自启动（注册表 HKCU\...\Run 登录项） ───────────────────────
// 用 Electron 原生 app.setLoginItemSettings，无需第三方依赖。
// 打包后 process.execPath 是 QuickLaunch.exe，直接带 --autostart 参数；
// 开发模式下 process.execPath 是 electron.exe，必须附带应用路径参数（第一个
// 非开关参数会被 Electron 当作 app 路径）才会启动本项目。Chromium 写注册表时
// 会自动给含空格的路径加引号，无需手动处理。

function autoStartArgs(): string[] {
  return app.isPackaged ? ['--autostart'] : ['--autostart', app.getAppPath()]
}

function getAutoStartSetting(): boolean {
  // getLoginItemSettings 需传入与 set 相同的 path/args 才能正确匹配注册表项
  return app.getLoginItemSettings({ path: process.execPath, args: autoStartArgs() }).openAtLogin
}

function setAutoStartSetting(enabled: boolean): boolean {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
    args: autoStartArgs()
  })
  return getAutoStartSetting()
}

ipcMain.handle('get-auto-start', () => getAutoStartSetting())
ipcMain.handle('set-auto-start', (_event, enabled: boolean) => setAutoStartSetting(!!enabled))

// 通过 Run 登录项（--autostart 参数）启动时，窗口默认隐藏到托盘，不打扰登录后的桌面；
// Alt+Space / 托盘图标随时唤出。
// 这里只在 whenReady 处读一次，不导出成模块常量：整进程常量会让「切位置重建窗口」
// 也以为自己是开机自启（dockTrayHidden 直接置真 → 新窗口永远不显示）。
const startHiddenAtLogin = process.argv.includes('--autostart')

// ─── IPC: launch an executable, URL, shell location, or open a folder ───────

// 拆分启动参数：逐字符解析（引号内空格不算分隔，引号本身剥离）——行为贴近
// CommandLineToArgvW。.lnk 的 Arguments 常常带引号（如 "E:\DSH\start-dsh.vbs"），
// 原样的 split(' ') 会把字面引号传给目标（wscript 收到 "\"路径\"" 导致
// "Windows Script Host 执行失败"）；同时支持含空格的带引号参数。
function splitArgs(input: string): string[] {
  const result: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '"') { inQuotes = !inQuotes; continue }
    if (ch === ' ' && !inQuotes) {
      if (cur) { result.push(cur); cur = '' }
      continue
    }
    cur += ch
  }
  if (cur) result.push(cur)
  return result
}

/** 点图标前是否先探询「目标是不是已经在运行」。
 *
 *  ⚠️⚠️ **v1.13.8 起默认 `false`（= 回到 v1.13.4 的启动逻辑：点图标一律直接启动）**。
 *  用户明确要求：今天新增的这套探询（v1.13.5 引入 / v1.13.6 扩成四态）在遇到
 *  「进程在、但连主窗口都还没有」的目标（Clash Verge 这类 Tauri 托盘应用）时会判成
 *  `failed`，而 `failed` 又拒绝启动 —— 结果就是**点了永远打不开**。改成 fail-open 之后
 *  仍然会先花 ~0.9s 探一次，用户要求干脆彻底回到「直接启动」。
 *
 *  == true== ：先探询（running→激活；tray→点托盘图标唤出；其余→启动）——
 *              好处是**不会**对已在运行的单实例应用（微信/QQ）多开一个进程，
 *              代价是点了要等约 1 秒、且极少数探不到窗口的目标要靠 fail-open 兜。
 *  == false== ：不探询，直接 spawn（v1.13.4 的行为）——点下去就是打开；
 *              代价是**微信/QQ 收在托盘时再点会多开一个实例（弹登录窗）**。
 *
 *  想切回去只改这一行；下面的探询代码与提示分支都完整保留着。 */
const PROBE_BEFORE_LAUNCH = false

ipcMain.handle('run-app', async (_event, targetPath: string, args: string, workingDir: string) => {
  if (!targetPath) return false

  // 先判断「目标是不是已经在运行」——是的话激活它的窗口，**绝不再开一个进程**。
  // 必须在隐藏 Dock 之前做：这一路是同步的（PowerShell 约 0.8s），若先隐藏、
  // 再发现只是激活了已有窗口，用户会看到 Dock 无谓地闪一下。
  //
  // 只对「无启动参数的本地 exe」这么做：带参数时用户要的多半是明确的新行为
  // （例如某些工具用参数开新窗口），不能替他改语义。
  if (PROBE_BEFORE_LAUNCH && !args) {
    const state = await probeTargetState(targetPath)
    if (state === 'running') {
      // 已经是用户想要的那个窗口在前台了。仍然把 Dock 收起来——
      // 与「启动成功」一致：用户是点图标切过去的，Dock 让出桌面。
      if (mainWindow && !mainWindow.isDestroyed()) {
        dockTrayHidden = true
        sinkSeq++
        mainWindow.hide()
      }
      return true
    }
    if (state === 'tray') {
      // 程序在运行、但窗口收在托盘里（微信/QQ 关到托盘就是这种状态）。
      // ⚠️ **绝不能启动新进程**：那会多开一个实例，微信会弹登录窗口 —— 用户报的正是这个。
      // ⚠️ 也**不能对隐藏窗口 ShowWindow 强行显示**：实测会「可见但失去响应」（卡死，踩过）。
      // 正确做法：用 UI Automation 点它的托盘图标，让应用自己走「从托盘恢复」的流程
      // （见 clickTrayIconFor；等价于用户自己点托盘图标，不碰它的窗口、不动鼠标）。
      const clicked = await clickTrayIconFor(targetPath)
      if (clicked) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          dockTrayHidden = true
          sinkSeq++
          mainWindow.hide()
        }
        return true // 已唤出，等同于启动成功
      }
      // UIA 不可用 / 没找到它的托盘图标：退回「提示用户自己点托盘图标」，
      // **依然不启动新进程**（多开出来的是登录窗口，比让用户多点一下糟得多）
      console.log('[launcher] 托盘图标未能点击，提示用户自行点击:', targetPath)
      return 'in-tray'
    }
    if (state === 'failed') {
      // ⚠️⚠️ v1.13.8 修：这里**不再拦**（fail-open），直接落到下面的启动流程。
      //
      // 为什么改成「放行」：`failed` 的真实含义是「进程在、但一个带标题的窗口都没有」
      // （3 次都没探到）。这类目标**恰恰是最需要启动**的 —— 典型就是 Clash Verge
      // 这类 Tauri 托盘型应用：空闲时它只有托盘窗口（`tao_system_tray_app`，隐藏）
      // 和「Tao Thread Event Target」（可见但无标题），**主窗口根本不存在**。
      // 实测（本机，Clash Verge 在托盘里）：
      //   pid=99776  cls=tao_system_tray_app    title=[] visible=False
      //   pid=99776  cls=Tao Thread Event Target title=[] visible=True
      //   pid=99776  cls=MSCTFIME UI / IME      ← 输入法辅助窗口
      // 于是任何版本的探询都只能给出 0，而「拦住不启动」的结果就是**用户永远点不开它**。
      // 既然连窗口都没有，启动它就是唯一能拿到窗口的办法（单实例应用会自己把窗口显示出来）。
      // 用户报的「点了 Clash Verge 只弹提示、打不开」正是这一条。
      //
      // 注意这不等于取消保护：`running`（有窗口 → 激活，绝不新开）与 `tray`
      // （窗口隐藏 → 点托盘图标唤出，绝不强行 ShowWindow）两条依旧照旧。
      console.log('[launcher] 进程在但探不到带标题的窗口，按「直接启动」处理（fail-open）:', targetPath)
    }
    // 'absent' = 确认没在运行（或探询给不出结论）→ 继续走下面的启动流程
  }

  // 启动目标后自动隐藏到托盘：用户点开图标后 Dock 彻底让出桌面（不再遮挡目标程序）。
  // 托盘左键 / Alt+Space / 托盘菜单「显示窗口」随时唤回——toggleWindow 按 dockTrayHidden
  // 意图状态判断，隐藏状态下任何唤回路径都会显示并恢复置顶。
  let hideSeq = sinkSeq
  if (mainWindow && !mainWindow.isDestroyed()) {
    dockTrayHidden = true
    sinkSeq++ // 隐藏即作废在途沉底（hide() 引发的 blur 不该再起 PowerShell）
    hideSeq = sinkSeq // 记下这次隐藏的代际：失败回滚只认这一代（见 restoreDockAfterFailedLaunch）
    mainWindow.hide()
  }

  // Windows shell: / CLSID → open via explorer (This PC, Recycle Bin, etc.)
  if (targetPath.startsWith('shell:') || targetPath.startsWith('::')) {
    // 必须给回调：execFile 不带回调就没人消费 'error' 事件，spawn 失败（PATH 里没有
    // explorer / EPERM）会在主进程抛未捕获异常
    execFile('explorer', [targetPath], (err) => {
      if (err && typeof err.code === 'string') console.error('[launcher] explorer failed:', err.message)
    })
    return true
  }

  // Open folder in Explorer：与 open-path 一致，await 之后才知道有没有打开成功
  // （原来直接 fire-and-forget，目标被删掉时用户看到的是「Dock 消失、什么都没打开」）
  try {
    if (statSync(targetPath).isDirectory()) {
      const msg = await shell.openPath(targetPath)
      if (msg) {
        console.error('[launcher] openPath (folder) failed:', msg)
        restoreDockAfterFailedLaunch(hideSeq)
        return false
      }
      return true
    }
  } catch {
    // not a filesystem path, continue
  }

  // URL
  if (/^(https?|ftp|steam):\/\/|^mailto:/i.test(targetPath)) {
    // openExternal 返回 Promise：没有注册的协议处理器（如未装客户端的 mailto:/steam:）会
    // reject，不接就是未处理 rejection
    void shell.openExternal(targetPath).catch((err) => {
      console.error('[launcher] openExternal failed:', err instanceof Error ? err.message : String(err))
      restoreDockAfterFailedLaunch(hideSeq)
    })
    return true
  }

  // Executable
  //
  // ⚠️ 这里**必须等 spawn 结果再返回**（v1.13.4 修）。原实现是
  //   execFile(target, args, cb)  然后**立刻** `return true` —— 而 spawn 失败是
  //   **异步**通知 cb 的。实测：目标不存在时 handler 在 ~1ms 就返回了 true，
  //   而 ENOENT 要到 ~400ms 后才在 cb 里到达。
  //   后果：renderer 那句 `if (ok === false) showDropHint('启动失败：…')` **永远不可能触发** ——
  //   Dock 约 0.4s 后自己弹回来、却一句解释都没有，正是那句提示想避免的体验。
  //   现在改为监听 'spawn' / 'error' 两个事件：'spawn' 表示进程真的起来了（立刻 resolve），
  //   'error' 表示没能起来（resolve false）——都不必等进程退出。
  //   ⚠️ 不能用 execFile 的完成回调来判成功：对 GUI 程序那个回调要等**程序关闭**才触发，
  //      挂在它上面会让这个 IPC 挂到用户关掉应用为止。
  const spawnOutcome = await new Promise<'ok' | 'spawn-failed'>((resolve) => {
    let settled = false
    const child = execFile(
      targetPath,
      args ? splitArgs(args) : [],
      { cwd: workingDir || undefined },
      // 完成回调只用于「起来了但退出码非零」的日志；成功/失败已由下面的事件定夺
      (err) => {
        if (!err) return
        if (typeof err.code === 'string') return // spawn 级失败已由 'error' 处理
        console.log(`[launcher] 目标已启动但退出码非零 (${err.code}): ${targetPath}`)
      }
    )
    child.once('spawn', () => {
      if (settled) return
      settled = true
      // 与子进程解绑：主进程不再关心它的生死（GUI 程序可能跑几小时），
      // 否则父进程会一直持有句柄、退出时还要等它
      child.unref?.()
      resolve('ok')
    })
    child.once('error', (err: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      const code = err.code
      // spawn 被拒（EACCES/EPERM）：通常是程序需要管理员权限，或安全软件拦了裸的
      // CreateProcess。回退到系统 Shell 启动（ShellExecuteEx）——与资源管理器双击
      // 行为一致，会自动弹 UAC 提权。代价是丢弃启动参数。这是已处理的流程，不再打堆栈。
      if (code === 'EACCES' || code === 'EPERM') {
        console.log(`[launcher] Direct spawn blocked (likely admin required); falling back to Shell: ${targetPath}`)
        shell.openPath(targetPath)
          .then((msg) => { if (msg) console.error('[launcher] Shell fallback also failed:', msg) })
          .catch((e) => console.error('[launcher] Shell fallback threw:', e instanceof Error ? e.message : String(e)))
        // 回退成功与否由 shell 侧日志兜底；对 renderer 报成功（Dock 保持隐藏，
        // 因为确实已经交给系统去启动了）
        resolve('ok')
        return
      }
      console.error('[launcher] Failed to launch:', err.message)
      resolve('spawn-failed')
    })
  })

  if (spawnOutcome === 'spawn-failed') {
    restoreDockAfterFailedLaunch(hideSeq)
    return false // renderer 据此提示「启动失败：目标不存在或无法运行」
  }
  return true
})


/** 启动失败后把 Dock 还给用户：点图标时已经先隐藏到托盘，若不还回来，
 *  用户看到的是「Dock 消失、什么都没启动」，只能靠 Alt+Space 找回。
 *
 *  ⚠️ `hideSeq` 必须传「**这次隐藏时**的 sinkSeq」，不能只看 `dockTrayHidden`
 *  （v1.13.4 修，这条是实测出来的）：
 *  spawn 失败是**异步**通知的（实测 ~400ms 后）。这段时间里用户完全可能
 *  ① 自己 Alt+Space 唤回，或 ② 又点了另一个图标并成功启动。
 *  那时 `dockTrayHidden` 的**值**可能凑巧又是 true（比如被第二次 run-app 重新置真），
 *  只比值就会把第二个应用刚启动的 Dock 又弹出来。比对**代际**才准确：
 *  代际不同 ⇒ 这次隐藏早已不是当前意图，什么也别做。 */
function restoreDockAfterFailedLaunch(hideSeq: number): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (sinkSeq !== hideSeq) return // 期间有更新的意图（唤回 / 又启动了一个）—— 不抢用户的操作
  if (!dockTrayHidden) return // 已经不是「我们藏起来」的状态了
  dockTrayHidden = false
  sinkSeq++ // 作废在途沉底：Dock 被还给用户后不能再被压到底部
  markDockShown()
  mainWindow.show()
  recoverDock(mainWindow)
}

// ─── IPC: 右键菜单扩展（编辑图标 / 管理员运行 / 打开位置 / 复制路径） ───────

// 为条目更换图标：选择 exe/dll/ico → SHDefExtractIcon 提取；png/jpg 直接读文件转 dataURL
ipcMain.handle('pick-icon', async () => {
  const result = await showOpenDialogSafe({
    title: '选择图标（exe / dll / ico / png）',
    defaultPath: DEFAULT_DIALOG_PATH,
    filters: [{ name: '图标文件', extensions: ['exe', 'dll', 'ico', 'png', 'jpg'] }],
    properties: ['openFile']
  })
  const file = result.canceled ? '' : result.filePaths[0]
  if (!file) return null
  if (/\.(png|jpe?g)$/i.test(file)) {
    try {
      const b64 = readFileSync(file).toString('base64')
      const mime = /\.png$/i.test(file) ? 'image/png' : 'image/jpeg'
      return { path: file, iconDataUrl: `data:${mime};base64,${b64}` }
    } catch { return null }
  }
  const iconDataUrl = await extractIcon(file, 0, ICON_SIZE)
  return iconDataUrl ? { path: file, iconDataUrl } : null
})

// ─── IPC: 拖放添加（解析拖入的文件路径） ────────────────────────────────────
// renderer 用 webUtils.getPathForFile 拿到拖入文件的真实路径（Electron 32+ 已移除
// File.path），这里按类型分派成可持久化的条目：
//   .lnk/.url/.pif → parseLnkFile（与「添加快捷方式」同一套解析 + 图标兜底链）
//   .exe/.com      → 单次 PowerShell 调用批量取 FileDescription + 图标（避免 N 个进程）
// 其余（文件夹、文档、其它扩展名、目标为空的坏快捷方式）归入 rejected，
// 由 renderer 汇总成「已跳过 N 个」提示。

const SHORTCUT_EXTS = new Set(['.lnk', '.url', '.pif'])
const EXEC_EXTS = new Set(['.exe', '.com'])

interface DroppedEntry {
  targetPath: string
  arguments: string
  workingDirectory: string
  description: string
  iconDataUrl: string
}

/** 批量取 exe/com 的显示名（FileDescription → 文件名）、图标与工作目录，单次 PowerShell 调用。 */
function describeExecutables(paths: string[]): Promise<{ path: string; name: string; iconDataUrl: string }[]> {
  return new Promise((resolve) => {
    // 路径统一单引号包裹（'' 转义），含空格/中文的路径不会被拆断
    const psList = paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(', ')
    const psScript = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
${ICON_EXTRACTOR_CS}
$out = @()
foreach ($p in @(${psList})) {
  $name = ''
  try { $name = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($p).FileDescription } catch {}
  if (-not $name) { $name = [System.IO.Path]::GetFileNameWithoutExtension($p) }
  $b64 = [IconExtractor]::GetIconBase64($p, 0, ${ICON_SIZE})
  # 提取不到图标时回退通用文档图标（shell32 index 1），避免 <img src=""> 出现破图
  if (-not $b64) { $b64 = [IconExtractor]::GetIconBase64('C:\\Windows\\System32\\shell32.dll', 1, ${ICON_SIZE}) }
  $out += @{ path = $p; name = $name; iconBase64 = $b64 }
}
if ($out.Count -gt 0) { $out | ConvertTo-Json -Compress -Depth 3 }`
    runPowerShell(psScript, 15000, ({ err, stdout }) => {
      if (err || !stdout.trim()) { resolve([]); return }
      try {
        const parsed = JSON.parse(stdout.trim())
        // 只有一个元素时 ConvertTo-Json 输出对象而非数组，这里统一成数组
        const items: { path: string; name: string; iconBase64?: string }[] =
          Array.isArray(parsed) ? parsed : [parsed]
        resolve(items.map((it) => ({
          path: it.path,
          name: it.name,
          iconDataUrl: it.iconBase64 ? 'data:image/png;base64,' + it.iconBase64 : ''
        })))
      } catch { resolve([]) }
    })
  })
}

ipcMain.handle('describe-paths', async (_e, paths: unknown) => {
  if (!Array.isArray(paths)) return { accepted: [], rejected: [] }
  const list = paths.filter((p): p is string => typeof p === 'string' && !!p)
  // 按输入下标占位，保证添加顺序与拖入顺序一致（快捷方式解析较慢也不会乱序）
  const slots: (DroppedEntry | null)[] = new Array(list.length).fill(null)
  const rejected: string[] = []
  const execIdx: number[] = []
  const lnkIdx: number[] = []

  for (let i = 0; i < list.length; i++) {
    const p = list[i]
    const ext = extname(p).toLowerCase()
    if (SHORTCUT_EXTS.has(ext)) {
      lnkIdx.push(i)
    } else if (EXEC_EXTS.has(ext) && existsSync(p)) {
      execIdx.push(i)
    } else {
      rejected.push(p)
    }
  }

  // 快捷方式：**限并发 4** 解析。每个 .lnk/.url 都要起一个 powershell.exe（实测 ~900ms
  // 含 Add-Type 编译），原来在循环里串行 await —— 一次拖 20 个就是 IPC 挂 ~18s、
  // renderer 只能干等（用户看到的是「拖进去了但半天没反应」）。
  // 顺序不受影响：结果按下标写进 slots；rejected 的先后顺序无关紧要。
  await forEachLimited(lnkIdx, 4, async (i) => {
    const p = list[i]
    try {
      const info = await parseLnkFile(p)
      // 目标为空的坏快捷方式不入 Dock（点了也启动不了）
      if (!info.targetPath) { rejected.push(p); return }
      slots[i] = {
        targetPath: info.targetPath,
        arguments: info.arguments || '',
        workingDirectory: info.workingDirectory || '',
        description: info.description || basename(p, extname(p).toLowerCase()),
        iconDataUrl: info.iconDataUrl || ''
      }
    } catch { rejected.push(p) }
  })

  if (execIdx.length > 0) {
    const metas = await describeExecutables(execIdx.map((i) => list[i]))
    // 按小写路径建索引再查：原来是每个条目 metas.find(...) 线性扫一遍（O(n²)），
    // 一次拖入上百个文件时纯属白烧 CPU
    const byPath = new Map(metas.map((m) => [m.path.toLowerCase(), m]))
    for (const i of execIdx) {
      const m = byPath.get(list[i].toLowerCase())
      if (!m) { rejected.push(list[i]); continue }
      slots[i] = {
        targetPath: list[i],
        arguments: '',
        // 工作目录取 exe 所在目录：留空会让子进程继承本应用的 cwd（仓库目录），
        // 与资源管理器双击（用 exe 所在目录）不一致，依赖相对路径找配置的程序会起不来
        workingDirectory: dirname(list[i]),
        description: m.name,
        iconDataUrl: m.iconDataUrl
      }
    }
  }

  return { accepted: slots.filter((s): s is DroppedEntry => s !== null), rejected }
})

// ─── IPC: 枚举驱动器（「此电脑」悬停卡片 + 图标用量条） ────────────────────
// GetDrives() 本身不产生 I/O；容量与卷标只对固定盘/移动盘查询——断开的网络盘上
// AvailableFreeSpace 会阻塞数秒，所以网络盘/光驱只列盘符不查容量。
ipcMain.handle('list-drives', () => new Promise((resolve) => {
  const psScript = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$out = @()
foreach ($d in [System.IO.DriveInfo]::GetDrives()) {
  $type = [string]$d.DriveType
  $label = ''
  $format = ''
  $total = [long]0
  $free = [long]0
  $ready = $true
  if ($type -eq 'Fixed' -or $type -eq 'Removable') {
    try {
      $ready = $d.IsReady
      if ($ready) {
        $label = [string]$d.VolumeLabel
        $format = [string]$d.DriveFormat
        $total = [long]$d.TotalSize
        $free = [long]$d.AvailableFreeSpace
      }
    } catch { $ready = $false }
  }
  $out += @{ name = $d.Name.TrimEnd('\\'); label = $label; type = $type; format = $format; total = $total; free = $free; ready = $ready }
}
if ($out.Count -gt 0) { $out | ConvertTo-Json -Compress -Depth 3 }`
  runPowerShell(psScript, 8000, ({ err, stdout }) => {
    if (err || !stdout.trim()) { resolve([]); return }
    try {
      const parsed = JSON.parse(stdout.trim())
      // 只有一个驱动器时 ConvertTo-Json 输出对象而非数组
      const items: { name: string; label: string; type: string; format: string; total: number; free: number; ready: boolean }[] =
        Array.isArray(parsed) ? parsed : [parsed]
      resolve(items.map((d) => ({
        name: String(d.name || ''),
        label: String(d.label || ''),
        type: String(d.type || ''),
        format: String(d.format || ''),
        total: Number(d.total) || 0,
        free: Number(d.free) || 0,
        ready: d.ready !== false
      })))
    } catch { resolve([]) }
  })
}))

// ─── IPC: 列出文件夹子项（文件夹条目悬停预览卡片） ────────────────────────
// 枚举走 fs、图标走 Electron 内置的 app.getFileIcon（进程内 shell 图标查询）——
// **全程不起 PowerShell**：实测 `powershell -NoProfile` 单是启动就 ~900ms，加上
// Add-Type 编译 ~250ms、每图标 ~12ms，一个文件夹要 1.3s 才换上真图标；
// app.getFileIcon 20 个文件共 284ms（首次）/ 36ms（之后，系统有缓存），快 5~40 倍。
// 返回分两段：首批 FOLDER_ICON_INLINE 个图标在返回前就填好（配合 renderer 的悬停预取，
// 卡片弹出时图标已就位），其余后台分批补并推 `folder-icons` 事件就地替换。
const FOLDER_LIST_LIMIT = 400
const FOLDER_LIST_TTL = 5000
// 缓存目录数上限。这是主进程里**最大的一块可变内存**：每个缓存项都带着它那批图标的
// data URL（上限见 FOLDER_ICON_LIMIT）。40 个目录 × 每目录上百个图标 ≈ 十 MB 量级常驻，
// 而用户实际只会来回看少数几个目录 → 24 足够，超出部分按「先清过期、再踢最旧」淘汰。
const FOLDER_CACHE_MAX = 24
const FOLDER_ICON_INLINE = 14 // 返回前就填好的首批（卡片首屏可见的那十几行）
const FOLDER_ICON_BATCH = 24 // 后台每批数量（每批推一次事件，卡片逐批换图标）
// 后台补图标的总上限。卡片一屏约 20 行，96 个已经够用户滚四屏以上；再多只是把内存
// 和 `folder-icons` 事件的传输量堆上去（每次推送都要把这一批 data URL 跨进程拷一遍）
const FOLDER_ICON_LIMIT = 96
// 资源管理器默认不显示的系统文件/目录：列出来只是噪音（每个文件夹都有 desktop.ini）
const FOLDER_BLOCKLIST = new Set(['desktop.ini', 'thumbs.db', '$recycle.bin', 'system volume information'])
const folderCollator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

interface FolderChild {
  name: string
  path: string
  isDir: boolean
  /** 文件字节数；目录恒为 -1（不递归统计——大文件夹会把卡片卡死） */
  size: number
  iconDataUrl: string
}
interface FolderListing {
  path: string
  name: string
  folders: number
  files: number
  items: FolderChild[]
  /** 超出列举上限、未列出的条目数（卡片底部提示一句，让用户去资源管理器看） */
  truncated: number
  /** 仅在失败时出现：missing=不存在 / denied=没权限 / notdir=不是文件夹 */
  error?: 'missing' | 'denied' | 'notdir'
}

const folderListCache = new Map<string, { at: number; data: FolderListing }>()
/** 正在枚举中的目录。`sender` 是**可变**的：渲染端会「悬停预取 + 卡片打开」请求两次，
 *  窗口重建后还会有新窗口来命中同一条在途 Promise，推送图标必须发给最新那个请求者
 *  （否则新窗口的卡片永远停在占位块）。 */
interface PendingFolderList {
  sender: Electron.WebContents
  job: Promise<FolderListing>
}
const folderListPending = new Map<string, PendingFolderList>()

/** 目录项批量处理的并发上限：一个 400 项的目录如果无脑 Promise.all(stat)，
 *  会同时把 400 个 fs 请求压进 libuv 线程池（默认只有 4 个线程），
 *  排队项连同它们的闭包一起堆在内存里，主进程内存曲线会明显起尖。
 *  按固定并发跑完再看下一个，总耗时几乎不变，峰值请求数却降一个量级。 */
const FS_CONCURRENCY = 16
async function forEachLimited<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      await work(items[i])
    }
  })
  await Promise.all(workers)
}

// 目录统一用标准黄色文件夹图标（shell32 index 4，与 Dock 上文件夹条目同源）。
// 不能对目录用 app.getFileIcon：实测它返回的是错图标（dist/node_modules 变成「磁盘」图标、
// .git/.dsh-* 变成白纸），只有对文件才是正确的 shell 类型图标。
// 提取一次（~0.3s 的 PowerShell）后常驻内存；启动即预热，首次悬停通常已经就绪。
let folderIcon: string | null = null
let folderIconLoading: Promise<void> | null = null
function ensureFolderIcon(): Promise<void> {
  if (folderIcon !== null) return Promise.resolve()
  if (!folderIconLoading) {
    // 尺寸跟 FOLDER_ICON_SIZE 一致（卡片行只显示 17px），payload 比 256px 小一个量级
    folderIconLoading = extractIcon('C:\\Windows\\System32\\shell32.dll', 4, FOLDER_ICON_SIZE)
      .then((url) => { folderIcon = url || '' })
      .catch(() => { folderIcon = '' })
      .then(() => {
        // ⚠️ 失败时**不要**把 '' 当成有效结果常驻：`folderIcon !== null` 会让后面每一次调用
        // 都直接返回，于是 select-folder 整个会话都发空图标（renderer 的 sharedFolderIcon 兜底
        // 只是把它掩盖住了）。这里把状态复位成 null，下次调用会重新提取一次。
        if (!folderIcon) { folderIcon = null; folderIconLoading = null }
      })
  }
  return folderIconLoading
}

/** 写入目录列表缓存。缓存里存的是**已经填过图标的对象引用**（分批补图标是就地改这些
 *  对象），所以容量控制必须同时做两件事：① 先踢掉已过 TTL 的条目（卡片的后台补图标
 *  每推一批都会刷新 at，所以「打开着的卡片」不会被误踢）；② 仍然超出上限时按插入序
 *  踢掉最旧的一条。原来的实现只做 ②，一旦长期没有新目录进来，过期条目会一直挂着
 *  ——每个 400 项目录带着上百个 base64 图标常驻内存，纯属白占。 */
function putFolderCache(dir: string, data: FolderListing): void {
  if (folderListCache.size >= FOLDER_CACHE_MAX) {
    const now = Date.now()
    for (const [key, entry] of folderListCache) {
      if (now - entry.at >= FOLDER_LIST_TTL) folderListCache.delete(key)
    }
    while (folderListCache.size >= FOLDER_CACHE_MAX) {
      const oldest = folderListCache.keys().next().value
      if (oldest === undefined) break
      folderListCache.delete(oldest)
    }
  }
  folderListCache.set(dir, { at: Date.now(), data })
}

ipcMain.handle('list-folder', async (event, dir: unknown) => {
  const empty = (path: string, error: FolderListing['error']): FolderListing =>
    ({ path, name: path ? basename(path) : '', folders: 0, files: 0, items: [], truncated: 0, error })
  if (typeof dir !== 'string' || !dir) return empty('', 'missing')

  const hit = folderListCache.get(dir)
  if (hit && Date.now() - hit.at < FOLDER_LIST_TTL) return hit.data
  // 同一目录正在枚举时复用同一个 Promise：渲染端会先「悬停预取」、300ms 后卡片打开时
  // 再请求一次，若不做去重，两次都会跑完整个枚举 + 图标提取（readdir/stat 双份、
  // 图标提取双份、folder-icons 事件也推两遍）。
  //
  // ⚠️ 复用的是**枚举本身**，但推送图标的目标（sender）必须跟着最新的请求者走：
  // 窗口被重建（切停靠位置 / dev HMR）后新窗口会命中这条在途 Promise，而它闭包里
  // 捕获的却是**旧**窗口的 sender —— 后台补图标全推给了旧 WebContents，新窗口的卡片
  // 永远停在占位块（旧的 sender.isDestroyed() 检查只在已销毁时才补救，且那一轮列表
  // 已经拿到空图标了）。所以 pending 记录是可变的，每次有请求进来就刷新 sender。
  const inflight = folderListPending.get(dir)
  if (inflight) {
    inflight.sender = event.sender
    return inflight.job
  }

  const pending: PendingFolderList = { sender: event.sender, job: null as unknown as Promise<FolderListing> }

  const job = (async (): Promise<FolderListing> => {
    let entries: Dirent[]
    try {
      const st = await fsp.stat(dir)
      if (!st.isDirectory()) return empty(dir, 'notdir')
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code
      return empty(dir, code === 'ENOENT' ? 'missing' : 'denied')
    }

    const all: { name: string; key: string; isDir: boolean }[] = []
    let folderCount = 0
    let fileCount = 0
    for (const it of entries) {
      if (FOLDER_BLOCKLIST.has(it.name.toLowerCase())) continue
      let isDir = it.isDirectory()
      // Windows 的目录联接/符号链接（pnpm 的 node_modules、用户目录里的 Application Data 等）
      // 在 Dirent 上是 isDirectory()=false + isSymbolicLink()=true，只有 stat 才知道真身。
      // 不识别的话它们会被当成文件：算进文件数、按文件排序、显示成字节大小、图标也不对
      if (!isDir && it.isSymbolicLink()) {
        try { isDir = (await fsp.stat(join(dir, it.name))).isDirectory() } catch { /* 断链当文件 */ }
      }
      if (isDir) folderCount++
      else fileCount++
      all.push({ name: it.name, key: it.name.toLowerCase(), isDir })
    }
    // 目录优先，其次按名称（中文/数字自然序，与资源管理器观感一致）。
    // 超大目录（几十万项）里 Intl.Collator 比较百万次会把主进程卡住好几秒，
    // 而卡片最多只显示 400 行——超过阈值就退回廉价的字符串比较
    const cheapSort = all.length > 4000
    all.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      if (cheapSort) return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
      return folderCollator.compare(a.name, b.name)
    })

    const shown = all.slice(0, FOLDER_LIST_LIMIT)
    const items: FolderChild[] = shown.map((s) => ({
      name: s.name,
      path: join(dir, s.name),
      isDir: s.isDir,
      size: -1,
      iconDataUrl: '' // 由下面的首批提取 / 后台分批填入
    }))

    // 文件大小：只 stat 文件（目录不递归），单个 stat 失败不影响整卡。
    // 用受限并发跑（见 FS_CONCURRENCY），别把 400 个 stat 一次性压进线程池
    await forEachLimited(items, FS_CONCURRENCY, async (it) => {
      if (it.isDir) return
      try { it.size = (await fsp.stat(it.path)).size } catch { it.size = -1 }
    })

    const data: FolderListing = {
      path: dir,
      name: basename(dir),
      folders: folderCount,
      files: fileCount,
      items,
      truncated: all.length - shown.length
    }

    // 首批图标（卡片首屏可见的前十几行）**在返回前就填好**——配合 renderer 的悬停预取
    // （鼠标刚碰到图标就开始列目录），卡片弹出时图标已经就位，看不到「先占位块再换」的过程。
    // 目录用缓存的标准黄色文件夹图标（不 await：预热没完成时先留空，由后台补批填上）
    await forEachLimited(items.slice(0, FOLDER_ICON_INLINE), 8, async (it) => {
      it.iconDataUrl = it.isDir ? (folderIcon ?? '') : await fileIconDataUrl(it.path)
    })

    putFolderCache(dir, data)

    // 其余图标后台分批补（每批推一次事件，卡片逐批换），不阻塞卡片出现。
    // 传 pending 而不是 event.sender：推送目标要跟着「最新一次请求者」走（见上方注释）
    void fillFolderIcons(items, dir, pending, data)

    return data
  })()

  pending.job = job
  folderListPending.set(dir, pending)
  try {
    return await job
  } finally {
    folderListPending.delete(dir)
  }
})

/** 单文件 shell 图标 → data URL（失败返回空串，renderer 用中性占位块）。 */
async function fileIconDataUrl(targetPath: string): Promise<string> {
  try {
    const img = await app.getFileIcon(targetPath, { size: 'normal' })
    return img.isEmpty() ? '' : img.toDataURL()
  } catch { return '' }
}

/** 后台补图标：每批完成后推一次 `folder-icons`，renderer 按路径就地替换。
 *  sender **从 pending 记录里实时取**（不是建 job 那一刻的快照）：窗口被重建后
 *  新窗口复用同一条在途 Promise，若继续用旧 WebContents，补批全推给了已经离开的窗口。
 *  目标确实拿不到时（已销毁）**把这个缓存项删掉**，否则列表里剩下没图标的项会在 TTL 内
 *  被当成「已完成的缓存」返回，卡片只能显示占位块，且没有任何补批会再来。 */
async function fillFolderIcons(
  items: FolderChild[],
  dir: string,
  pending: PendingFolderList,
  data: FolderListing
): Promise<void> {
  const targets = items.filter((it) => !it.iconDataUrl).slice(0, FOLDER_ICON_LIMIT)
  if (targets.length === 0) return
  // 目录要用到那枚缓存的文件夹图标，先把预热等完（通常早就好了）
  if (targets.some((it) => it.isDir)) await ensureFolderIcon()
  const dropCacheIfOurs = (): void => {
    // 只删自己那一次枚举写进去的缓存（可能已被更新的枚举替换）
    if (folderListCache.get(dir)?.data === data) folderListCache.delete(dir)
  }
  for (let i = 0; i < targets.length; i += FOLDER_ICON_BATCH) {
    const batch = targets.slice(i, i + FOLDER_ICON_BATCH)
    // 每批同样走受限并发：一批 24 个 getFileIcon 并发是安全的，但配上 stat 的
    // 线程池占用时仍要留出余量，避免与用户其他操作抢 I/O
    await forEachLimited(batch, 8, async (it) => {
      it.iconDataUrl = it.isDir ? (folderIcon ?? '') : await fileIconDataUrl(it.path)
    })
    // 每批都取一次当前 sender（期间可能有新窗口接管）
    const sender = pending.sender
    // sender 失效（窗口被重建/页面重载）就先删缓存再返回：缓存里的对象**已经被就地
    // 改了图标**，留着它会让下一次 list-folder 命中「半截图标」的旧数据而不再补批。
    // 原实现是「先 send 再检查」，对已销毁的 WebContents 调 send 本身就会抛错。
    if (!sender || sender.isDestroyed()) { dropCacheIfOurs(); return }
    const icons: Record<string, string> = {}
    for (const it of batch) if (it.iconDataUrl) icons[it.path] = it.iconDataUrl
    if (Object.keys(icons).length === 0) continue
    try {
      sender.send('folder-icons', { path: dir, icons })
    } catch {
      // send 仍然可能抛（sender 在 isDestroyed 检查之后才销毁）：这个函数是 void 掉的，
      // 不捕获就会变成主进程的未处理 rejection
      dropCacheIfOurs()
      return
    }
    // 卡片还开着就继续刷新保鲜期（每批一次），这样第二次悬停仍能命中缓存
    const entry = folderListCache.get(dir)
    if (entry?.data === data) entry.at = Date.now()
  }
}

// 打开任意路径（文件夹预览卡片点条目/「打开」按钮用）：shell.openPath 走 ShellExecuteEx，
// 即资源管理器双击的语义——目录开资源管理器，文档/图片/快捷方式交给关联程序。
// 不能复用 run-app：那条路径用 execFile 直接 CreateProcess，对 .md/.txt/.png 这类非可执行
// 文件必然失败（ERR ENOEXEC，且原代码只在 EACCES/EPERM 时回退 shell），所以点了没反应。
ipcMain.handle('open-path', async (_e, targetPath: unknown) => {
  if (typeof targetPath !== 'string' || !targetPath) return false
  // 先确认真的打开了再隐藏 Dock：目标已被删除/没有关联程序时，shell.openPath 会返回错误串，
  // 此时若已经把 Dock 藏起来，用户就是「点了没反应、Dock 还消失了」，只能靠 Alt+Space 找回
  const err = await shell.openPath(targetPath)
  if (err) {
    console.error('[launcher] openPath failed:', err)
    return false
  }
  // 与点 Dock 图标一致：打开成功后 Dock 让出桌面
  if (mainWindow && !mainWindow.isDestroyed()) {
    dockTrayHidden = true
    sinkSeq++ // 隐藏即作废在途沉底
    mainWindow.hide()
  }
  return true
})

// 启动预热：① 标准黄色文件夹图标（目录行用，提取一次常驻）② 一次 getFileIcon 让 shell
// 图像列表初始化（首次调用有 ~110ms 冷启动），用户第一次悬停文件夹时就不会撞上这个尖峰
void app.whenReady().then(() => {
  // 抢不到单实例锁的进程正在退出流程里，别白起一个 powershell.exe（whenReady 与 quit 是竞速的）
  if (!gotSingleInstanceLock) return
  void ensureFolderIcon()
  void fileIconDataUrl(process.execPath)
})

// 以管理员身份运行（Start-Process -Verb RunAs → UAC 提权，与资源管理器「以管理员身份运行」一致）
ipcMain.handle('run-as-admin', (_e, targetPath: string, args: string, workingDir: string) => {
  if (!targetPath) return false
  let hideSeq = sinkSeq
  if (mainWindow && !mainWindow.isDestroyed()) {
    dockTrayHidden = true
    sinkSeq++ // 隐藏即作废在途沉底
    hideSeq = sinkSeq // 记下代际：UAC 取消/失败的回滚只认这一代
    mainWindow.hide()
  }
  // ⚠️ `Start-Process` 的 -ArgumentList / -WorkingDirectory 都是 [ValidateNotNullOrEmpty]：
  // 传空串会**先**在校验阶段抛错（实测 PS 5.1：Cannot validate argument on parameter
  // 'ArgumentList'. The argument is null or empty），根本走不到创建进程那一步。
  // 而「没有启动参数」正是绝大多数条目的常态 —— 原来的写法让这个菜单项对它们 100% 失败，
  // 且因为 Dock 已经先隐藏、err 又只打日志、IPC 还返回 true，用户看到的是
  // 「Dock 消失、没有 UAC、什么都没发生」。
  // 修法：用参数哈希表拼装，空值一律**不传**该参数（PowerShell 侧判断，避免 JS 侧再拼一次命令）。
  const psScript = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$p = @{ FilePath = '${targetPath.replace(/'/g, "''")}'; Verb = 'RunAs' }
$argStr = '${(args || '').replace(/'/g, "''")}'
$wdStr = '${(workingDir || '').replace(/'/g, "''")}'
if ($argStr) { $p['ArgumentList'] = $argStr }
if ($wdStr) { $p['WorkingDirectory'] = $wdStr }
Start-Process @p`
  // ⚠️ 必须把**真实结果**返回给 renderer：原来无论成败都 `return true`，于是
  //    「UAC 被取消」时用户只看到「Dock 藏起来又回来、什么都没发生」，没有任何说明
  //    （run-app 早就做到返回真值了，这里漏了一处）。
  return new Promise<boolean>((resolve) => {
    runPowerShell(psScript, 10000, ({ err, stderr }) => {
      if (!err) { resolve(true); return }
      // UAC 被用户取消（The operation was canceled by the user）也走这里：
      // 此时同样要把 Dock 还给用户，否则「点了没反应 + Dock 消失」没有任何出路
      console.error('[launcher] run-as-admin failed:', err.message, '| stderr:', (stderr || '').slice(0, 300))
      restoreDockAfterFailedLaunch(hideSeq)
      resolve(false)
    })
  })
})

// 在资源管理器中定位目标（文件夹在父目录中选中该文件夹；文件直接选中）
ipcMain.handle('open-file-location', (_e, targetPath: string) => {
  if (!targetPath || targetPath.startsWith('shell:') || targetPath.startsWith('::')) return
  // 这条走的是 exec（拼接命令行，见下方原因），因此必须先挡掉 cmd 元字符：
  // 真实路径不含这些字符，但 shortcuts.json 可手改、IPC 也能传任意串
  if (/["&|^<>%\r\n]/.test(targetPath)) {
    console.error('[launcher] open-file-location: refused path with cmd metacharacters')
    return
  }
  try {
    // explorer 的参数解析很挑剔：execFile 自动转义内嵌引号（\"）后 /select 会被
    // Explorer 忽略并回退到默认位置（文档）。必须用 exec 传原始命令行
    // （cmd 原样透传双引号）——与资源管理器地址栏手动输入完全一致。
    exec(`explorer.exe /select,"${targetPath}"`, (err) => {
      // explorer 成功打开窗口后也常以非零退出码结束（交接给已运行的实例），
      // 只有 spawn 类失败（err.code 为字符串）才值得记录
      if (err && typeof err.code === 'string') {
        console.error('[launcher] open-file-location failed:', err.message)
      }
    })
  } catch {}
})

// 复制文本到剪贴板（复制路径）
ipcMain.handle('copy-text', (_e, text: unknown) => {
  if (typeof text === 'string' && text) clipboard.writeText(text)
})

// ─── Window & tray ──────────────────────────────────────────────────────────

function resolveResource(filename: string): string {
  const devPath = join(__dirname, '../../resources', filename)
  return existsSync(devPath) ? devPath : join(app.getAppPath(), '..', filename)
}

// 鼠标进入 Dock 窗口：恢复置顶（沉底后鼠标移回 Dock 即拉回）。
// 鼠标移出 / 在其他软件上滚动不再沉底——用户可自由移动鼠标，
// 只有点击其他软件（blur）才让出置顶。
// 鼠标进入 Dock 窗口：恢复置顶并抢回焦点。必须 focus——否则 Dock 保持「置顶但无焦点」，
// 之后点击其他软件不会触发 blur，Dock 无法沉底（违背「只有点击其他软件才让位」的设计）。
ipcMain.on('dock-pointer', (_e, inside: boolean) => {
  if (!mainWindow || mainWindow.isDestroyed() || !inside) return
  dockTrayHidden = false
  sinkSeq++ // 作废在途沉底：鼠标已经回到 Dock 上，不该再被压到底部
  recoverDock(mainWindow)
  mainWindow.focus()
})

// ─── 「已在运行的目标 = 激活它的窗口」而不是再开一个（v1.13.5）────────────────
// 背景：点 Dock 图标是 execFile → CreateProcess，对**单实例/托盘型**应用（微信、
// QQ、各类 IM）不会去激活已有实例，而是**又开一个进程**。实测（本机微信 4.1）：
//   execFile        → 新增 1 个进程
//   Start-Process   → 新增 1 个进程
// 也就是说这**不是**启动方式的问题（换 ShellExecuteEx 也一样），
// 必须由我们主动把已有窗口提到前台。
//
// ⚠️ 实测过两次「第一次调用返回 NONE」：应用刚启动时进程/窗口枚举还没就绪，
//    此时若直接掉到「启动新进程」就会**多开一个登录窗口**（用户报的正是这个）。
//    对策：FindWindow 阶段做**短轮询重试**（见 findTargetWindow），不要一次失败就放弃。
//
// ⚠️⚠️ 下面这段 C# **必须是纯 ASCII，一个中文注释都不能有**（踩过一次，很隐蔽）：
//   powershell.exe -Command <脚本文本> 是按**系统 ANSI 代码页**解码命令行的（中文 Windows
//   是 GBK/936），而我们的脚本是 UTF-8。C# 里出现中文注释时，GBK 解码会把多字节序列解错，
//   把注释的结尾 `*/` 吃掉 → **整段源码语法错误** → Add-Type 编译失败 →
//   FindPid 永远返回 0，"激活"功能静默失效（表面看只是"没生效"，不报错）。
//   本项目其它 C# 常量（ICON_EXTRACTOR_CS / DESKTOP_ICONS_CS / WinZ）实测都是 0 个非 ASCII
//   字符 —— 那不是巧合，是这条约定在撑着。改这里请保持纯 ASCII，说明写在 TS 这一侧。
const ACTIVATE_CS = `
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

/** 判断目标程序当前处于哪种状态，决定「激活 / 提示 / 启动」。
 *
 *  ⚠️ **方向是「宁可多开一次，也不要让用户点不开」**（v1.13.8 修正，此前是反的）。
 *  这条特性存在的理由：`execFile` / `Start-Process` 对单实例应用（微信、QQ 等）
 *  **都会新开一个进程**，所以「已经在运行就别再启动」必须由我们主动判断。
 *  但判断**不出来的那部分不能拿来拦住用户** —— 被拦住的代价是「点了永远没反应」。
 *
 *  四态与各自的处置（处置在 run-app 里）：
 *    running  有可见/最小化窗口     → 置前，不启动
 *    tray     进程在、窗口隐藏      → 点托盘图标唤出；点不动才提示用户自己点，不启动
 *    absent   确认没这个进程        → 启动
 *    failed   进程在、但没有带标题的窗口（3 次都没探到）→ **照旧启动**（fail-open）
 *
 *  ⚠️ `failed` 为什么必须放行：Clash Verge 这类 **Tauri 托盘型应用**空闲时
 *  **根本不存在主窗口**，只有托盘窗口（`tao_system_tray_app`，隐藏）和一个
 *  无标题的 `Tao Thread Event Target`。实测本机（应用收在托盘）：
 *    pid=99776  cls=tao_system_tray_app     title=[] visible=False
 *    pid=99776  cls=Tao Thread Event Target title=[] visible=True
 *    pid=99776  cls=MSCTFIME UI / IME
 *  任何探询都只能给出 0。如果因此拦住不启动，用户就**永远点不开它**（报障原话：
 *  「点了只弹『没能确认是否已在运行』」）。既然连窗口都没有，启动它是唯一能拿到窗口的办法。
 *
 *  为什么要重试：实测应用刚启动时**第一次调用会返回 0**（进程/窗口枚举尚未就绪），
 *  重试能把这种「正在启动」与「真的没有窗口」区分开一部分。 */
async function probeTargetState(targetPath: string): Promise<'running' | 'tray' | 'absent' | 'failed'> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = activateRunningInstance(targetPath, 3000)
    if (r !== 'retry') return r
    if (attempt < 2) {
      // 小睡 260ms 再试：应用刚启动时第一次枚举常常还没就绪，立刻判「没在运行」就会多开。
      // ⚠️ 必须是 **await**，不能写成 `while (Date.now() < until) {}` 那种同步忙等：
      //    忙等会**阻塞主进程事件循环** 520ms（本项目「execFileSync 卡死整个 Dock」同族问题），
      //    而且这段探询一旦被开关打开（PROBE_BEFORE_LAUNCH=true），
      //    最坏路径 = 3×(execFileSync ~0.9s + 忙等 0.26s) ≈ 3.5s 主进程假死。
      await new Promise((resolve) => setTimeout(resolve, 260))
    }
  }
  return 'failed'
}

/** 解析探询脚本的 `STATE=<code>` 标记（**只认标记**，不要对整段 stdout 做等值判断 ——
 *  见 DESKTOP_ICONS_READ_PS 那段注释：漏出来的方法返回值曾把整条特性搞失效）。
 *  取最后一行标记；找不到返回 NaN（= 探询失败，按「retry」处理，绝不启动新进程）。 */
function parseProbeState(stdout: string): number {
  const lines = String(stdout ?? '').split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*STATE=(-?\d+)\s*$/.exec(lines[i])
    if (m) return Number(m[1])
  }
  return NaN
}

/** 单次探测/激活。'retry' 表示这次没能得到结论、值得重试。 */
function activateRunningInstance(targetPath: string, timeoutMs: number): 'running' | 'tray' | 'absent' | 'retry' {
  // 非本地可执行文件（shell: / URL / 无扩展名）没有进程可匹配，直接走启动流程
  if (!/\.(exe|com)$/i.test(targetPath)) return 'absent'
  if (!existsSync(targetPath)) return 'absent'
  try {
    const escaped = targetPath.replace(/'/g, "''")
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
${ACTIVATE_CS}
'@
$r = [QLActivate]::Probe('${escaped}')
Write-Output "STATE=$r"`],
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true }
    )
    switch (parseProbeState(String(out))) {
      case 1: console.log('[launcher] 已激活运行中的实例:', targetPath); return 'running'
      case -1: console.log('[launcher] 目标在运行但窗口收在托盘里:', targetPath); return 'tray'
      // ⚠️⚠️ 2 = **根本没有这个进程** —— 这是唯一允许去启动新实例的返回值。
      //    在此之前 `absent` 对「exe 存在但没在运行」是**不可达**的：C# 把
      //    「没这个进程」和「进程在但没建窗」都返回 0，上层一律当 retry，
      //    3 次之后判 failed → **一个没在运行的程序永远点不开**，只弹
      //    「没能确认是否已在运行…请再点一次」。用户报的「有的图标点开就这样」即此。
      case 2: return 'absent'
      // 0 = 进程在、但还没找到带标题的窗口（多半是刚启动还没建窗）→ 值得重试
      case 0: return 'retry'
      default:
        console.log('[launcher] 探询输出无法解析（按 retry 处理，不启动）:', JSON.stringify(String(out).trim().slice(0, 120)))
        return 'retry'
    }
  } catch (err) {
    console.log('[launcher] activate probe failed:', err instanceof Error ? err.message : String(err))
    return 'retry'
  }
}

// ─── 用 UI Automation 点托盘图标，把「收在托盘里」的窗口唤出来（v1.13.7）──────
// 为什么需要它：单实例/托盘型应用（微信、QQ）关到托盘后，**没有别的安全办法**能让
// 它把窗口显示出来 ——
//   • execFile / Start-Process 都会新开一个进程（微信就是弹登录窗，用户报的正是这个）
//   • 对隐藏窗口调 ShowWindow 强行显示，实测有概率让它「可见但失去响应」（卡死，踩过）
//   • 模拟鼠标点托盘图标：Win11 的托盘图标在溢出面板里，跨进程读它的位置需要注入内存
// UI Automation 是正路：托盘图标本身就是 UIA 元素、有 Invoke 模式 ——
// 等价于用户自己点它，而**不碰应用的窗口**、不开进程、不动鼠标。
//
// 实测（本机 Win11 + 微信 4.1）：打开隐藏图标面板 → 面板里点「微信」→
// 窗口 visible=False → True、前台切过去、进程数不变、未响应 0 个、面板自动收起。
//
// ⚠️⚠️ 这段 C# 必须纯 ASCII，而且**不能含反斜杠转义序列**：
//   ① 纯 ASCII —— powershell.exe -Command 按系统 ANSI 代码页解码命令行，UTF-8 的中文注释
//      会把源码解坏 → Add-Type 编译失败 → 功能静默失效。
//   ② 无反斜杠 —— 这段 C# 嵌在 TS 的模板字符串里，写 "\n" 会被 JS 解成真换行、
//      把 C# 字符串常量截断（踩过两次）。检查脚本见 .dsh-vision-toolkit/probe/cs-escapes.cjs。
//   所有中文（按钮名、面板名、目标名）都由 TS 侧以**参数**传进来。
const TRAY_CLICK_CS = `
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

// 托盘相关的中文名（UIA 元素的 Name 是中文）。放 TS 侧，C# 保持纯 ASCII。
// 溢出面板用**类名** TopLevelWindowForOverflowXamlIsland 定位（C# 里），它的中文 Name
// 在不同系统语言下会变，所以不靠名字。这个按钮的名字是稳定的。
const TRAY_SHOW_HIDDEN_NAME = '显示隐藏的图标'

/** 目标程序收在托盘时，用 UIA 点它的托盘图标把它唤出来。
 *  返回 true = 已点击（调用方按「已唤出」处理）。
 *
 *  ⚠️⚠️ 脚本必须写成**带 UTF-8 BOM 的 .ps1 再 `-File` 执行，不能用 `-Command` 传文本**
 *  （这条是踩出来的，非常隐蔽）：`-Command` 的文本要经过**系统 ANSI 代码页**解码，
 *  脚本里的中文会被截成半个字符 —— 实测报
 *  `[QLTray]::ClickTrayIcon('显示隐藏的图�?, …) 字符串缺少终止符`，
 *  整条 PowerShell 解析失败、又因为 stdout 已被消费而**看不到任何输出**，
 *  表现就是「调用方静默死住」。带 BOM 的 .ps1 由 PowerShell 按 UTF-8 读，编码有确定保证，
 *  也不再依赖系统区域设置（中文 Win 是 GBK，其它语言机器会直接坏掉）。
 *  实测：`-Command` 失败 / BOM+.ps1 `-File` 连续两次成功。 */
function clickTrayIconFor(targetPath: string): Promise<boolean> {
  const exeName = basename(targetPath).replace(/\.[^.]+$/, '') // Weixin.exe → Weixin
  const scriptPath = join(app.getPath('temp'), `ql-tray-${process.pid}.ps1`)
  try {
    const escaped = targetPath.replace(/'/g, "''")
    const script = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$wpf = Join-Path $env:WINDIR 'Microsoft.NET\\Framework64\\v4.0.30319\\WPF'
Add-Type -ReferencedAssemblies @("$wpf\\UIAutomationClient.dll", "$wpf\\UIAutomationTypes.dll", "$wpf\\WindowsBase.dll") -TypeDefinition @'
${TRAY_CLICK_CS}
'@
# 候选名 = 该程序所有顶层窗口的标题（微信的托盘 tooltip 就是它的窗口标题「微信」）+ exe 名兜底。
# ⚠️ 不能用 $_.MainWindowTitle：窗口**隐藏**时它是空的（实测），候选会退化成 exe 名而永远匹配不上。
$cands = New-Object System.Collections.Generic.List[string]
foreach ($t in ([QLTray]::WindowTitles('${escaped}') -split '\\|')) { if ($t) { [void]$cands.Add($t) } }
[void]$cands.Add('${exeName}')
[QLTray]::ClickTrayIcon('${TRAY_SHOW_HIDDEN_NAME}', $cands.ToArray())`
    // BOM 不能省：没有它 PowerShell 5.1 会按 ANSI 代码页读文件，中文同样会坏
    writeFileSync(scriptPath, '\ufeff' + script, 'utf8')

    // ⚠️ 必须异步 + 超时，不能用 execFileSync：
    //   实测在完整应用里 UIA 的 Invoke 那一步会卡住不返回（最小 Electron 应用里同样的脚本却正常），
    //   而 execFileSync 会**阻塞主进程事件循环** —— 表现为整个 Dock 卡死、连 app.exit 都执行不了。
    //   改成子进程 + 回调，卡住也只是一个 8s 超时的后台任务，主进程始终活着。
    return new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (v: boolean): void => {
        if (settled) return
        settled = true
        try { rmSync(scriptPath, { force: true }) } catch { /* ignore */ }
        resolve(v)
      }
      const child = execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { timeout: 8000, windowsHide: true, maxBuffer: 1 << 20 },
        (err, stdout) => {
          if (err) {
            console.log('[launcher] tray click failed:', err.message)
            finish(false)
            return
          }
          const n = Number(String(stdout).trim().split(/\r?\n/).pop())
          if (n === 1) { console.log('[launcher] 已通过托盘图标唤出:', targetPath); finish(true) }
          else { console.log('[launcher] 托盘图标未点击（返回值 ' + String(stdout).trim() + '）:', targetPath); finish(false) }
        }
      )
      // 兜底：execFile 的 timeout 只杀子进程，回调理论上会来；但万一子进程杀不掉也不拖着 run-app
      setTimeout(() => {
        if (settled) return
        console.log('[launcher] tray click 超时，按未点击处理:', targetPath)
        try { child.kill() } catch { /* ignore */ }
        finish(false)
      }, 9000)
    })
  } catch (err) {
    console.log('[launcher] tray click setup failed:', err instanceof Error ? err.message : String(err))
    try { rmSync(scriptPath, { force: true }) } catch { /* ignore */ }
    return Promise.resolve(false)
  }
}

// 把 Dock 窗口压到 z-order 最底（HWND_BOTTOM）。Electron 没有 moveBottom()，
// 只能通过 SetWindowPos 调 Windows API 实现真正沉底。
//
// 注意这条路径的**时间尺度**：每次都要起一个新的 powershell.exe，加上
// `-TypeDefinition` 触发的一次性 C# 编译（首次约 200ms~1s），真正落地的
// SetWindowPos 往往在 blur 之后近一秒才执行。这就是下面整套代数校验存在的原因。
function sendToBottom(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const startSeq = sinkSeq
  // 同一扇窗口已有沉底任务在跑：不重复起进程（每次都是一个新的 powershell.exe）。
  // 延迟重试（180ms）而不是直接放弃——谁后到谁说了算，最后一次 blur 的意图必须被满足。
  //
  // ⚠️ 重试的守卫**不能**写成 `sinkState?.win === win`：上一轮任务完成时会把 sinkState
  // 置回 null，于是这个守卫恒假、重试永远什么都不做（第二次让位意图被静默吞掉）。
  // 正确的守卫是「意图还成立吗」——没被更晚的唤回作废、窗口还在、可见、没收托盘、没拿到焦点。
  if (sinkState && sinkState.win === win) {
    setTimeout(() => {
      if (sinkSeq !== startSeq) return // 期间有更新的意图，交给那条路径
      if (!win.isDestroyed() && win.isVisible() && !win.isFocused() && !dockTrayHidden && canSinkNow()) {
        sendToBottom(win)
      }
    }, 180)
    return
  }

  const buf = win.getNativeWindowHandle()
  const hwnd = buf.length >= 8
    ? `0x${buf.readBigUInt64LE(0).toString(16)}`
    : `0x${buf.readUInt32LE(0).toString(16)}`
  const psScript = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WinZ {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
'@
# HWND_BOTTOM=1, SWP_NOSIZE|SWP_NOMOVE|SWP_NOACTIVATE
[WinZ]::SetWindowPos([IntPtr]::new(${hwnd}), [IntPtr]::new(1), 0, 0, 0, 0, 0x0002 -bor 0x0001 -bor 0x0010) | Out-Null`

  sinkState = { win, seq: startSeq }

  runPowerShell(psScript, 4000, ({ err }) => {
    // ⚠️ 必须先捕获「这次沉底是不是我们自己的、还是否仍然成立」，**再**清 sinkState。
    // 原实现先清 sinkState 再调 stillWanted()，而 stillWanted() 的第一个条件正是
    // `sinkState?.win === win` —— 于是它恒为 false，紧跟的 `if (!visible) recoverDock()`
    // 在**每一次成功的沉底之后**都会执行，把刚沉下去的 Dock 又拉回置顶
    // （并顺带 markDockShown() 重置 2.5s 宽限期，让下一次 blur 也被吞掉）。
    // 表现：「点击别的软件后 Dock 让位」100% 被撤销。
    const ours = sinkState?.win === win && sinkState.seq === startSeq
    if (sinkState?.win === win) sinkState = null
    if (err) {
      console.error('[dock] sendToBottom failed:', err.message)
      return
    }
    // 这次沉底仍然有效（期间没有任何更晚的「拉回/隐藏」意图，窗口也还在原位）→ 什么都不做
    if (ours && sinkSeq === startSeq && !win.isDestroyed() && win.isVisible() &&
        !win.isFocused() && !dockTrayHidden) {
      return
    }
    // 迟到的 HWND_BOTTOM 补偿：PS 执行期间用户可能已经把 Dock 拉回来了
    // （Alt+Space 唤回 / 托盘 / 鼠标移回 / 启动失败恢复）。这里不能再用
    // isAlwaysOnTop() 判断——恢复路径会把它设回 true，原写法恒真、形同虚设。
    if (!win.isDestroyed() && win.isVisible()) recoverDock(win)
  })
}

/** 创建 Dock 窗口。
 *  edge 显式传入（**不再从磁盘回读**）：切换位置的写入万一失败，也不会出现
 *  「窗口已重建、方向却退回旧值」的错位；dockEdge 与窗口始终一致。
 *  startHidden 决定建好后是否显示——由调用方给出「原本是显示还是收在托盘里」，
 *  不能再拿 startedAtLogin 判断：那是整进程常量，开机自启会话里永远为真，
 *  切位置重建的窗口会一直不显示（Dock 直接消失进托盘）。 */
function createWindow(edge: DockEdge, startHidden: boolean): void {
  const iconPath = resolveResource('icon.ico')
  dockEdge = edge
  const { w: winW, h: winH } = windowSizeFor(edge)
  const pos = positionForEdge(edge, { w: winW, h: winH })

  mainWindow = new BrowserWindow({
    width: winW,
    height: winH,
    x: pos.x,
    y: pos.y,
    show: false,
    frame: false,
    transparent: true,
    // 显式给全透明背景色：Electron 默认背景是白色（#FFF），透明窗口一旦发生
    // setBounds 重绘就会先糊一层白底（表现为整窗白闪）。当前已取消所有程序化
    // resize（面板/菜单都改成固定高度浮层），保留此项作为兜底。
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // 把停靠边同步传给渲染端（preload 直接读 argv 暴露成常量）：首帧就能按方向布局，
      // 不走 IPC 异步取，避免启动瞬间先画一次底部 Dock 再翻上去
      additionalArguments: [`--ql-edge=${dockEdge}`]
    }
  })

  // 注：这里不再监听 move/moved，也没有位置巡检——Dock 不支持自由拖动，
  // 窗口位置只由「位置」预设决定（见 positionForEdge / applyDockEdge）。

  mainWindow.on('ready-to-show', () => {
    // 是否显示只看 startHidden（调用方给出的「原本显示 / 原本收在托盘里」）。
    // 曾经这里还判断 startedAtLogin，那是整进程常量：开机自启会话里永远为真，
    // 于是切位置重建出来的窗口一律不显示——Dock 会直接消失进托盘。
    if (!startHidden) {
      mainWindow?.show()
      markDockShown() // 启动/重建后刚显示：这段时间的 blur 是焦点抖动，不触发沉底
      // 首次显示后核实一次 z-order：启动瞬间终端/资源管理器正在抢前台，
      // 只依赖 show() + focus() 有概率停在「可见但不在最前」（v1.11.0 自愈）
      if (mainWindow && !mainWindow.isDestroyed()) verifyDockOnTop(mainWindow, sinkSeq, 0)
    } else {
      dockTrayHidden = true
      // 收在托盘里：不能算「刚显示过」，否则之后第一次唤回+点击别的软件会落在
      // 宽限期里被吞掉（唤醒路径自己会重新 markDockShown，见 toggleWindow）
      dockShownAt = 0
    }
  })

  // Hide to tray instead of closing
  mainWindow.on('close', (event) => {
    if (!forceQuit) {
      event.preventDefault()
      dockTrayHidden = true
      sinkSeq++ // 隐藏同样作废在途沉底（与其它四条隐藏路径一致）：不能让它去操作一扇已隐藏的窗口
      mainWindow?.hide()
    }
  })

  // 点击其他软件时让出置顶：Dock 沉到普通窗口下方，不再遮挡正在使用的应用。
  // 点击 Dock / Alt+Space / 托盘唤出时由 focus 事件恢复置顶。
  // 注意：setAlwaysOnTop(false) 只从置顶层降级（HWND_NOTOPMOST），z-order 仍停在
  // 非置顶组顶部——Explorer 也是非置顶窗口，Dock 依然排在它之上。必须再调
  // SetWindowPos(HWND_BOTTOM) 把 z-order 压到最底，Dock 才会真正沉到其他窗口下方。
  mainWindow.on('blur', () => {
    // 系统文件对话框打开期间不沉底：对话框是模态的，会抢走焦点触发 blur，
    // 此时沉底会连带把对话框压到其他软件下面（模态对话框跟随父窗口层级）
    if (dialogOpen) return
    // 窗口已隐藏（如 run-app 启动后自动隐藏到托盘，hide() 会触发 blur）：不可见窗口无需沉底
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return
    // 已经收在托盘里：不需要为一次由隐藏引起的 blur 再起一个 PowerShell 进程
    if (dockTrayHidden) return
    // 刚显示出来（启动 / 重建窗口 / Alt+Space 唤回）：焦点抖动一律不沉底。
    // 这一条直接省掉一个 700ms 的 powershell.exe（见 SINK_GRACE_MS 注释）
    if (!canSinkNow()) return
    const startSeq = sinkSeq
    // blur 与「用户真的点了别的软件」之间存在噪声：首次启动、切换停靠位置重建窗口等
    // 都会伴随一次焦点抖动。延迟一拍再确认——期间若焦点已回到 Dock（或用户按了
    // Alt+Space 唤回、窗口被隐藏），就整条取消。这一拍也是留给「真的点了别的软件」
    // 的判定窗口：用户点击别的窗口后焦点不会在 120ms 内回到 Dock。
    setTimeout(() => {
      if (sinkSeq !== startSeq) return
      const win = mainWindow
      // 复核时把「窗口还在、可见、没收托盘、没拿到焦点、不在宽限期」一次判完：
      // 任何一条不满足都说明这次让位已经过时，不能白起一个 PowerShell 进程
      if (!win || win.isDestroyed() || !win.isVisible()) return
      if (dockTrayHidden || win.isFocused() || !canSinkNow()) return
      win.setAlwaysOnTop(false)
      sendToBottom(win)
    }, 120)
  })

  // 获得焦点（点击 Dock / Alt+Space / 托盘唤出）时恢复置顶。
  // run-app 启动后窗口隐藏到托盘，唤回时由这里恢复置顶并拉回顶层。
  mainWindow.on('focus', () => {
    dockTrayHidden = false
    sinkSeq++ // 拿到焦点就是最明确的「我要它在上面」信号，作废在途沉底
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) recoverDock(mainWindow)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url).catch((err) => {
      console.error('[window] openExternal failed:', err instanceof Error ? err.message : String(err))
    })
    return { action: 'deny' }
  })
  // ⚠️ 第二道防线：renderer 目前靠 document 级 `dragover`/`drop` 的 preventDefault 挡
  //    「把文件拖到窗口上 → Chromium 导航到 file:// → 白屏」，但那只在 renderer 生效
  //    （脚本出错/新窗口/页面重载瞬间都可能有空档）。主进程这里直接拒绝任何导航：
  //    Dock 窗口只加载一次页面，之后不应该再发生任何 top-level 导航。
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl && url.startsWith(devUrl)) return // 开发模式 HMR 重载用
    event.preventDefault()
    console.error('[window] blocked navigation:', url.slice(0, 200))
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  // 未获得单实例锁：本实例正在退出流程中，不初始化窗口/托盘
  if (!gotSingleInstanceLock) return

  // ⚠️ 必须先 await 填好「桌面图标是否隐藏」的缓存，**再**建窗：
  //    renderer 用 sendSync 在首帧之前读它，缓存没填好就会落回 false（=图标可见），
  //    系统里其实是隐藏的 → 菜单先渲染「隐藏桌面图标」、随后翻成「显示桌面图标」。
  //    代价约 50~200ms（一次 PowerShell），换文案从首帧就对。
  await primeDesktopIconsHidden()

  // 启动：位置取记忆里的停靠位置；是否显示由「是否开机自启」决定（--autostart 时收在托盘）
  createWindow(readDockEdge(), startHiddenAtLogin)
  // 显示器参数变化后重新归位（screen 模块必须等 ready，所以在这里注册）
  screen.on('display-metrics-changed', reapplyDockEdgeOnDisplayChange)
  screen.on('display-added', reapplyDockEdgeOnDisplayChange)
  screen.on('display-removed', reapplyDockEdgeOnDisplayChange)
  // 桌面目录实时监听：文件夹新增/删除时通知 renderer 同步 Dock 图标
  startDesktopWatch()

  // System tray
  // 用多尺寸 ICO 而不是 16×16 的 PNG：显示器缩放 125% 时托盘需要 20 物理像素、
  // 150% 需要 24、200% 需要 32，单尺寸 PNG 会被系统拉伸成模糊（实测原 16px 图标
  // 在 125% 下必然发虚）。ICO 里 16/20/24/32 都是原生绘制，由外壳按当前 DPI 挑。
  const trayIcon = nativeImage.createFromPath(resolveResource('tray-icon.ico'))
  tray = new Tray(trayIcon)
  tray.setToolTip('快捷方式面板')
  tray.on('click', () => toggleWindow())

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) return
        // 与 toggleWindow 的显示分支保持一致（三个动作缺一不可）：
        // ① sinkSeq++ 作废在途沉底——否则迟到的 SetWindowPos(HWND_BOTTOM) 会把刚显示的
        //    窗口钉到底部；② recoverDock 统一置顶入口；③ focus 由 recoverDock 的巡检兜住。
        // 原来只做 show()+focus()：一旦 Windows 前台锁拒绝这次激活（CLAUDE.md 里记过这个
        // 场景），窗口就停在「可见但不置顶」，而且没有任何宽限期保护
        dockTrayHidden = false
        sinkSeq++
        mainWindow.show()
        recoverDock(mainWindow)
        mainWindow.focus()
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        forceQuit = true
        app.quit()
      }
    }
  ])
  tray.setContextMenu(contextMenu)

  // Global shortcut to toggle window. Prefer Alt+Space (verified working);
  // fall back to Ctrl+Alt+Space only if it fails to register. Note: Ctrl+Alt
  // is treated as AltGr on Windows and can be grabbed by IME/keyboard layouts,
  // which is why Alt+Space is tried first.
  let shortcutRegistered = false
  for (const combo of ['Alt+Space', 'Ctrl+Alt+Space']) {
    if (globalShortcut.register(combo, () => toggleWindow(true))) {
      shortcutRegistered = true
      console.log(`Registered global shortcut: ${combo}`)
      break
    }
  }
  if (!shortcutRegistered) {
    console.warn('Failed to register any global toggle shortcut')
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      // 重新建窗：沿用当前方向，并直接显示（用户主动激活）
      createWindow(dockEdge, false)
    }
  })
})

// 退出前落盘：renderer 的保存是 400ms 防抖的，退出那一刻可能还有一次改动没写盘。
// 用 before-quit（窗口还活着、IPC 双向可用）推一条 flush-pending-save，并给 200ms
// 让 renderer 的 save-shortcuts 回来 —— 只延迟一次，quit 重入直接放行。
let quitFlushed = false
app.on('before-quit', (event) => {
  if (quitFlushed || !forceQuit) return
  if (!mainWindow || mainWindow.isDestroyed()) return
  quitFlushed = true
  event.preventDefault()
  try { mainWindow.webContents.send('flush-pending-save') } catch {}
  // 200ms 足够 renderer 把 invoke('save-shortcuts') 发回来（同步落盘、无异步等待）；
  // 之后再次 quit，quitFlushed 已置位，直接放行
  setTimeout(() => app.quit(), 200)
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  stopDesktopWatch()
})

app.on('window-all-closed', () => {
  // 切换停靠边时会 destroy 旧窗口再建新的：这一瞬间没有窗口，不能当成「用户关掉了应用」
  if (recreatingWindow) return
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
