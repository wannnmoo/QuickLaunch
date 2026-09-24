import { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, globalShortcut, nativeImage, screen, clipboard } from 'electron'
import { join, basename, extname, dirname } from 'path'
import { readFileSync, writeFileSync, existsSync, statSync, watch, promises as fsp, type FSWatcher, type Dirent } from 'fs'
import { execFile, exec } from 'child_process'


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
  if (!mainWindow) return
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
      if (err || !stdout.trim()) { resolve(''); return }
      const b64 = stdout.trim()
      resolve(b64 ? 'data:image/png;base64,' + b64 : '')
    })
  })
}

// ─── IPC: parse .lnk shortcut file via PowerShell ──────────────────────────

// 新增文件/文件夹对话框的默认起始目录：优先用户重定向到 D 盘的桌面，回退系统桌面
function desktopPath(): string {
  return existsSync('D:\\Desktop') ? 'D:\\Desktop' : app.getPath('desktop')
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
 *  ② `disabled: mainWindow` 让对话框成为窗口的**真模态子窗口**——不仅挡住 Dock 的
 *     输入（避免用户在对话框开着时又点开菜单/右键菜单，把弹层状态搞乱），
 *     Windows 也会把对话框排进父窗口的 z-order 组，不再需要靠 setAlwaysOnTop 硬顶。 */
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
      .showOpenDialog(parent!, { ...options, ...(parent ? { disabled: true } : {}) })
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

/** 读当前桌面图标隐藏状态：ListView 不可见 = 图标隐藏；找不到 ListView 时回退读注册表。 */
function readDesktopIconsHidden(): Promise<boolean> {
  return new Promise((resolve) => {
    const psScript = `${DESKTOP_ICONS_CS}
$lv = [DesktopIcons]::FindListView()
if ($lv -eq [IntPtr]::Zero) {
  $v = (Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name HideIcons -ErrorAction SilentlyContinue).HideIcons
  if ($null -eq $v) { Write-Output '0' } else { Write-Output $v }
} else {
  if ([DesktopIcons]::IsWindowVisible($lv)) { Write-Output '0' } else { Write-Output '1' }
}`
    runPowerShell(psScript, 5000, ({ err, stdout }) => {
      if (err || !stdout.trim()) { resolve(false); return }
      resolve(stdout.trim() === '1')
    })
  })
}

ipcMain.handle('get-desktop-icons-hidden', () => readDesktopIconsHidden())

ipcMain.handle('toggle-desktop-icons', async () => {
  return new Promise<boolean>((resolve) => {
    const psScript = `${DESKTOP_ICONS_CS}
$dv = [DesktopIcons]::FindDefView()
if ($dv -eq [IntPtr]::Zero) {
  Write-Output '0'
} else {
  [DesktopIcons]::SendMessage($dv, 0x0111, [IntPtr]0x7402, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 500
  $lv = [DesktopIcons]::FindListView()
  if ($lv -eq [IntPtr]::Zero) {
    $v = (Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name HideIcons -ErrorAction SilentlyContinue).HideIcons
    if ($null -eq $v) { Write-Output '0' } else { Write-Output $v }
  } else {
    if ([DesktopIcons]::IsWindowVisible($lv)) { Write-Output '0' } else { Write-Output '1' }
  }
}`
    runPowerShell(psScript, 5000, ({ err, stdout, stderr }) => {
      if (err) {
        console.error('[desktop-icons] PS error:', err.message, '| stderr:', stderr?.slice(0, 300))
        resolve(false)
        return
      }
      resolve(stdout.trim() === '1')
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

ipcMain.handle('run-app', async (_event, targetPath: string, args: string, workingDir: string) => {
  if (!targetPath) return false

  // 启动目标后自动隐藏到托盘：用户点开图标后 Dock 彻底让出桌面（不再遮挡目标程序）。
  // 托盘左键 / Alt+Space / 托盘菜单「显示窗口」随时唤回——toggleWindow 按 dockTrayHidden
  // 意图状态判断，隐藏状态下任何唤回路径都会显示并恢复置顶。
  if (mainWindow && !mainWindow.isDestroyed()) {
    dockTrayHidden = true
    sinkSeq++ // 隐藏即作废在途沉底（hide() 引发的 blur 不该再起 PowerShell）
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
        restoreDockAfterFailedLaunch()
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
      restoreDockAfterFailedLaunch()
    })
    return true
  }

  // Executable
  execFile(targetPath, args ? splitArgs(args) : [], { cwd: workingDir || undefined }, (err) => {
    if (!err) return
    // 只有「子进程根本没起来」才算启动失败。err.code 是字符串时才是 spawn 级失败
    // （ENOENT / EACCES / EPERM / UNKNOWN…）；数字则是进程正常起来了、只是退出码非零
    // ——那种情况程序确实启动了，把 Dock 拽回来纯属帮倒忙
    // （很多应用/启动器带参数启动后会立刻以非零码退出）。
    const spawnFailed = typeof err.code === 'string'
    if (!spawnFailed) {
      console.log(`[launcher] 目标已启动但退出码非零 (${err.code}): ${targetPath}`)
      return
    }
    restoreDockAfterFailedLaunch()
    // spawn 被拒（EACCES/EPERM）：通常是程序需要管理员权限，或安全软件拦了裸的
    // CreateProcess。回退到系统 Shell 启动（ShellExecuteEx）——与资源管理器双击
    // 行为一致，会自动弹 UAC 提权。代价是丢弃启动参数。这是已处理的流程，不再打堆栈。
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      console.log(`[launcher] Direct spawn blocked (likely admin required); falling back to Shell: ${targetPath}`)
      shell.openPath(targetPath)
        .then((msg) => { if (msg) console.error('[launcher] Shell fallback also failed:', msg) })
        .catch((e) => console.error('[launcher] Shell fallback threw:', e instanceof Error ? e.message : String(e)))
      return
    }
    console.error('Failed to launch:', err)
  })
  return true
})

/** 启动失败后把 Dock 还给用户：点图标时已经先隐藏到托盘，若不还回来，
 *  用户看到的是「Dock 消失、什么都没启动」，只能靠 Alt+Space 找回。 */
function restoreDockAfterFailedLaunch(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
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

  for (let i = 0; i < list.length; i++) {
    const p = list[i]
    const ext = extname(p).toLowerCase()
    if (SHORTCUT_EXTS.has(ext)) {
      try {
        const info = await parseLnkFile(p)
        // 目标为空的坏快捷方式不入 Dock（点了也启动不了）
        if (!info.targetPath) { rejected.push(p); continue }
        slots[i] = {
          targetPath: info.targetPath,
          arguments: info.arguments || '',
          workingDirectory: info.workingDirectory || '',
          description: info.description || basename(p, ext),
          iconDataUrl: info.iconDataUrl || ''
        }
      } catch { rejected.push(p) }
    } else if (EXEC_EXTS.has(ext) && existsSync(p)) {
      execIdx.push(i)
    } else {
      rejected.push(p)
    }
  }

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
  if (mainWindow && !mainWindow.isDestroyed()) {
    dockTrayHidden = true
    sinkSeq++ // 隐藏即作废在途沉底
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
  runPowerShell(psScript, 10000, ({ err, stderr }) => {
    if (!err) return
    // UAC 被用户取消（The operation was canceled by the user）也走这里：
    // 此时同样要把 Dock 还给用户，否则「点了没反应 + Dock 消失」没有任何出路
    console.error('[launcher] run-as-admin failed:', err.message, '| stderr:', (stderr || '').slice(0, 300))
    restoreDockAfterFailedLaunch()
  })
  return true
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

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // 未获得单实例锁：本实例正在退出流程中，不初始化窗口/托盘
  if (!gotSingleInstanceLock) return

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
