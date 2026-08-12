import { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, globalShortcut, nativeImage, screen } from 'electron'
import { join, basename } from 'path'
import { readFileSync, writeFileSync, existsSync, statSync } from 'fs'
import { execFile } from 'child_process'


let mainWindow: BrowserWindow | null = null
let forceQuit = false
let tray: Tray | null = null
// 系统文件/文件夹对话框打开期间禁止 Dock 沉底：模态对话框跟随父窗口层级，
// 若此时 blur/mouseleave 触发沉底，对话框会被连带压到其他软件下面
let dialogOpen = false

function toggleWindow(): void {
  if (!mainWindow) return
  // 正在置顶显示 → 隐藏；沉底或已隐藏 → 唤回置顶
  if (mainWindow.isVisible() && mainWindow.isAlwaysOnTop()) {
    mainWindow.hide()
  } else {
    mainWindow.show()
    mainWindow.setAlwaysOnTop(true)
    mainWindow.moveTop()
    mainWindow.focus()
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

/** Run PowerShell to extract an icon from a DLL/EXE and return a data: URL. */
function extractIcon(iconFile: string, iconIndex: number, size = 256): Promise<string> {
  return new Promise((resolve) => {
    const psScript = `${ICON_EXTRACTOR_CS}
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$b64 = [IconExtractor]::GetIconBase64('${iconFile.replace(/'/g, "''")}', ${iconIndex}, ${size})
Write-Output $b64`
    execFile('powershell', ['-NoProfile', '-Command', psScript], { timeout: 10000 }, (err, stdout) => {
      if (err || !stdout.trim()) { resolve(''); return }
      const b64 = stdout.trim()
      resolve(b64 ? 'data:image/png;base64,' + b64 : '')
    })
  })
}

// ─── IPC: parse .lnk shortcut file via PowerShell ──────────────────────────

// 新增文件/文件夹对话框的默认起始目录：优先用户重定向到 D 盘的桌面，回退系统桌面
const DEFAULT_DIALOG_PATH = existsSync('D:\\Desktop') ? 'D:\\Desktop' : app.getPath('desktop')

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
    $iconBase64 = [IconExtractor]::GetIconBase64($iconFile, $iconIdx, 256)
  }
  # 2) 目标是文件夹：SHDefExtractIcon 对目录返回 E_FAIL 无法取图标，上面提取失败时
  #    统一回退系统黄色文件夹图标（与「添加文件夹」select-folder 一致）
  #    注意：JS 模板字符串里路径必须写双反斜杠 \\，单反斜杠会被当成转义吞掉
  if (-not $iconBase64 -and $targetPath -and (Test-Path $targetPath -PathType Container)) {
    $iconBase64 = [IconExtractor]::GetIconBase64('C:\\Windows\\System32\\shell32.dll', 4, 256)
  }

  # Fallback for URL shortcuts: use default browser icon
  if (-not $iconBase64 -and $isUrl) {
    $browserExe = (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice' -ErrorAction SilentlyContinue).ProgId
    if (-not $browserExe) { $browserExe = 'ChromeHTML' }
    $browserCmd = (Get-ItemProperty "HKLM:\\Software\\Classes\\$browserExe\\shell\\open\\command" -ErrorAction SilentlyContinue).'(Default)'
    if ($browserCmd -and $browserCmd -match '^"([^"]+)"') {
      $iconBase64 = [IconExtractor]::GetIconBase64($Matches[1], 0, 256)
    }
    # last resort: globe icon from shell32.dll
    if (-not $iconBase64) {
      $iconBase64 = [IconExtractor]::GetIconBase64('C:\\Windows\\System32\\shell32.dll', 13, 256)
    }
  }

  # 终极兜底：目标不存在/图标提取全部失败时给通用文档图标（shell32 index 1），避免 Dock 破图
  if (-not $iconBase64) {
    $iconBase64 = [IconExtractor]::GetIconBase64('C:\\Windows\\System32\\shell32.dll', 1, 256)
  }
}

# Extract display name
$displayName = ''
if (-not $isUrl -and $targetPath -and (Test-Path $targetPath)) {
  try { $displayName = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($targetPath).FileDescription } catch {}
}
if (-not $displayName) { $displayName = $s.Description }
if (-not $displayName) {
  if ($isUrl) {
    $displayName = [System.IO.Path]::GetFileNameWithoutExtension('${filePath.replace(/'/g, "''")}')
  } else {
    $displayName = [System.IO.Path]::GetFileNameWithoutExtension($targetPath)
  }
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
    execFile('powershell', ['-NoProfile', '-Command', psScript], { timeout: 10000 }, (err, stdout) => {
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

ipcMain.handle('parse-lnk', async (_event, filePath?: string) => {
  if (!filePath) {
    // 对话框打开期间保持 Dock 置顶（模态对话框跟随父窗口层级，否则会被压到其他软件下面）
    dialogOpen = true
    mainWindow?.setAlwaysOnTop(true)
    mainWindow?.moveTop()
    let result: Electron.OpenDialogReturnValue
    try {
      result = await dialog.showOpenDialog(mainWindow!, {
        title: '选择快捷方式文件',
        defaultPath: DEFAULT_DIALOG_PATH,
        filters: [
          { name: '所有快捷方式', extensions: ['lnk', 'url', 'pif'] },
          { name: '全部文件', extensions: ['*'] }
        ],
        // openFile + multiSelections：Win32 原生（IFileOpenDialog）支持多选
        properties: ['openFile', 'multiSelections']
      })
    } finally {
      dialogOpen = false
    }
    if (result.canceled || result.filePaths.length === 0) return []
    // 多选：逐个解析快捷方式，单个解析失败不影响其余
    const parsed = await Promise.all(
      result.filePaths.map((p) => parseLnkFile(p).catch(() => null))
    )
    return parsed.filter(Boolean)
  }
  // 显式传路径时同样返回数组，保持返回类型一致（LnkInfo[]）
  return [await parseLnkFile(filePath)]
})

// ─── IPC: persist shortcuts ─────────────────────────────────────────────────

const shortcutsPath = join(app.getPath('userData'), 'shortcuts.json')

ipcMain.handle('load-shortcuts', () => {
  try {
    return existsSync(shortcutsPath) ? JSON.parse(readFileSync(shortcutsPath, 'utf-8')) : []
  } catch {
    return []
  }
})

ipcMain.handle('save-shortcuts', (_event, data: unknown) => {
  if (!Array.isArray(data)) return
  try { writeFileSync(shortcutsPath, JSON.stringify(data), 'utf-8') } catch {}
})

// ─── IPC: select a folder ───────────────────────────────────────────────────

ipcMain.handle('select-folder', async () => {
  dialogOpen = true
  mainWindow?.setAlwaysOnTop(true)
  mainWindow?.moveTop()
  let result: Electron.OpenDialogReturnValue
  try {
    result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择文件夹',
      defaultPath: DEFAULT_DIALOG_PATH,
      // multiSelections + openDirectory：Win32 原生（IFileOpenDialog）支持文件夹多选
      properties: ['openDirectory', 'multiSelections']
    })
  } finally {
    dialogOpen = false
  }
  if (result.canceled || result.filePaths.length === 0) return []

  // 每个选中的文件夹提取系统黄色文件夹图标
  return Promise.all(result.filePaths.map(async (folderPath) => {
    const iconDataUrl = await extractIcon('C:\\Windows\\System32\\shell32.dll', 4, 256)
    return { path: folderPath, name: basename(folderPath), iconDataUrl }
  }))
})

// ─── IPC: add special system folder (This PC / Recycle Bin) ─────────────────

const SPECIAL_ITEMS: Record<string, { clsid: string; fallbackDll: string; fallbackIndex: number; name: string; shellCommand: string }> = {
  'this-pc': {
    clsid: '{20D04FE0-3AEA-1069-A2D8-08002B30309D}',
    fallbackDll: 'C:\\Windows\\System32\\shell32.dll',
    fallbackIndex: 15,
    name: '此电脑',
    shellCommand: 'shell:MyComputerFolder'
  },
  'recycle-bin': {
    clsid: '{645FF040-5081-101B-9F08-00AA002F954E}',
    fallbackDll: 'C:\\Windows\\System32\\shell32.dll',
    fallbackIndex: 31,
    name: '回收站',
    shellCommand: 'shell:RecycleBinFolder'
  }
}

/** Resolve the actual icon file path and index for a CLSID from the Windows Registry. */
function resolveClsidIcon(clsid: string): Promise<{ dll: string; index: number }> {
  return new Promise((resolve) => {
    const psScript = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$iconPath = (Get-ItemProperty -Path "Registry::HKEY_CLASSES_ROOT\\CLSID\\${clsid}\\DefaultIcon" -Name '(Default)' -ErrorAction SilentlyContinue).'(Default)'
if ($iconPath) {
  Write-Output ([Environment]::ExpandEnvironmentVariables($iconPath))
}
`
    execFile('powershell', ['-NoProfile', '-Command', psScript], { timeout: 5000 }, (err, stdout) => {
      if (err || !stdout.trim()) { resolve({ dll: '', index: 0 }); return }
      const raw = stdout.trim()
      // Format: "C:\path\to.dll,-109" or "C:\path\to.dll,15" or just "C:\path\to.dll"
      const match = raw.match(/^(.+?),(-?\d+)$/)
      if (match) {
        resolve({ dll: match[1], index: parseInt(match[2], 10) })
      } else {
        resolve({ dll: raw, index: 0 })
      }
    })
  })
}

ipcMain.handle('add-special-item', async (_event, type: string) => {
  const item = SPECIAL_ITEMS[type]
  if (!item) return null

  // Try registry resolution first, fall back to hardcoded values
  const { dll, index } = await resolveClsidIcon(item.clsid)
  const iconFile = dll || item.fallbackDll
  const iconIndex = dll ? index : item.fallbackIndex

  const iconDataUrl = await extractIcon(iconFile, iconIndex, 256)
  return {
    path: item.shellCommand,
    name: item.name,
    iconDataUrl,
    specialType: type
  }
})

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
    execFile('powershell', ['-NoProfile', '-Command', psScript], { timeout: 5000 }, (err, stdout) => {
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
    execFile('powershell', ['-NoProfile', '-Command', psScript], { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('[desktop-icons] PS error:', err.message, '| stderr:', stderr?.slice(0, 300))
        resolve(false)
        return
      }
      resolve(stdout.trim() === '1')
    })
  })
})

// ─── IPC: launch an executable, URL, shell location, or open a folder ───────

ipcMain.handle('run-app', async (_event, targetPath: string, args: string, workingDir: string) => {
  if (!targetPath) return false

  // 启动目标前让出置顶：新程序窗口是普通层级，可浮到 Dock 之上不被遮挡。
  // Dock 在下次获得焦点（点击 / Alt+Space / 托盘唤出）时由 focus 事件恢复置顶。
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(false)
  }

  // Windows shell: / CLSID → open via explorer (This PC, Recycle Bin, etc.)
  if (targetPath.startsWith('shell:') || targetPath.startsWith('::')) {
    execFile('explorer', [targetPath])
    return true
  }

  // Open folder in Explorer
  try {
    if (statSync(targetPath).isDirectory()) {
      shell.openPath(targetPath)
      return true
    }
  } catch {
    // not a filesystem path, continue
  }

  // URL
  if (/^(https?|ftp|steam):\/\/|^mailto:/i.test(targetPath)) {
    shell.openExternal(targetPath)
    return true
  }

  // Executable
  execFile(targetPath, args ? args.split(' ') : [], { cwd: workingDir || undefined }, (err) => {
    if (!err) return
    // spawn 被拒（EACCES/EPERM）：通常是程序需要管理员权限，或安全软件拦了裸的
    // CreateProcess。回退到系统 Shell 启动（ShellExecuteEx）——与资源管理器双击
    // 行为一致，会自动弹 UAC 提权。代价是丢弃启动参数。这是已处理的流程，不再打堆栈。
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      console.log(`[launcher] Direct spawn blocked (likely admin required); falling back to Shell: ${targetPath}`)
      shell.openPath(targetPath).then((msg) => {
        if (msg) console.error('[launcher] Shell fallback also failed:', msg)
      })
      return
    }
    console.error('Failed to launch:', err)
  })
  return true
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
  mainWindow.setAlwaysOnTop(true)
  mainWindow.moveTop()
  mainWindow.focus()
})

// 把 Dock 窗口压到 z-order 最底（HWND_BOTTOM）。Electron 没有 moveBottom()，
// 只能通过 SetWindowPos 调 Windows API 实现真正沉底。
function sendToBottom(win: BrowserWindow): void {
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
  execFile('powershell', ['-NoProfile', '-Command', psScript], { timeout: 5000 }, (err) => {
    if (err) {
      console.error('[dock] sendToBottom failed:', err.message)
      return
    }
    // PS 异步执行 HWND_BOTTOM 有延迟：若期间用户已通过 dock-pointer/focus 恢复置顶，
    // 迟到的 SetWindowPos(HWND_BOTTOM) 会把 Dock 压底，这里检测到置顶态则 moveTop() 拉回抵消
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isAlwaysOnTop()) {
      mainWindow.moveTop()
    }
  })
}

function createWindow(): void {
  const iconPath = resolveResource('icon.ico')
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize
  const winW = Math.min(Math.round(screenW * 0.85), 1200)
  const winH = 300

  mainWindow = new BrowserWindow({
    width: winW,
    height: winH,
    x: Math.round((screenW - winW) / 2),
    y: Math.round((screenH - winH) / 2),
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // Hide to tray instead of closing
  mainWindow.on('close', (event) => {
    if (!forceQuit) {
      event.preventDefault()
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
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(false)
      sendToBottom(mainWindow)
    }
  })

  // 获得焦点（点击 Dock / Alt+Space / 托盘唤出）时恢复置顶。
  // run-app 会临时让出置顶让新程序窗口浮到 Dock 之上，这里负责重新拉回。
  mainWindow.on('focus', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(true)
      mainWindow.moveTop()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()

  // System tray
  const trayIcon = nativeImage.createFromPath(resolveResource('tray-icon.png'))
  tray = new Tray(trayIcon)
  tray.setToolTip('快捷方式面板')
  tray.on('click', () => toggleWindow())

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        if (mainWindow) {
          mainWindow.show()
          mainWindow.focus()
        }
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
    if (globalShortcut.register(combo, () => toggleWindow())) {
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
      createWindow()
    }
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
