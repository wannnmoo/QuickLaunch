import { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, globalShortcut, nativeImage, screen } from 'electron'
import { join, basename } from 'path'
import { readFileSync, writeFileSync, existsSync, statSync } from 'fs'
import { execFile } from 'child_process'


let mainWindow: BrowserWindow | null = null
let forceQuit = false
let tray: Tray | null = null

function toggleWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isVisible()) {
    mainWindow.hide()
  } else {
    mainWindow.show()
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

ipcMain.handle('parse-lnk', async (_event, filePath?: string) => {
  if (!filePath) {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择快捷方式文件',
      filters: [
        { name: '所有快捷方式', extensions: ['lnk', 'url', 'pif'] },
        { name: '全部文件', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    filePath = result.filePaths[0]
  }

  return new Promise((resolve, reject) => {
    const psScript = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
${ICON_EXTRACTOR_CS}

$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${filePath.replace(/'/g, "''")}')
$targetPath = $s.TargetPath
$isUrl = ($targetPath -match '^(https?|ftp|mailto|steam)://')

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
if ($isUrl) {
  $urlIni = Get-Content '${filePath.replace(/'/g, "''")}' -Encoding Default -ErrorAction SilentlyContinue
  if ($urlIni) {
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
          if ($urlIni -match 'IconIndex\\s*=\\s*(\\d+)') { $iconIdx = [int]$Matches[1] }
        }
        break
      }
    }
  }
}

if (-not $iconBase64) {
  $iconBase64 = ''
  if ($iconFile -and (Test-Path $iconFile)) {
    $iconBase64 = [IconExtractor]::GetIconBase64($iconFile, $iconIdx, 256)
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
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: '选择文件夹',
    properties: ['openDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return null

  const folderPath = result.filePaths[0]
  const name = basename(folderPath)
  const iconDataUrl = await extractIcon('C:\\Windows\\System32\\shell32.dll', 4, 256)

  return { path: folderPath, name, iconDataUrl }
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

// ─── IPC: launch an executable, URL, shell location, or open a folder ───────

ipcMain.handle('run-app', async (_event, targetPath: string, args: string, workingDir: string) => {
  if (!targetPath) return false

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
  if (/^(https?|ftp|mailto|steam):\/\//i.test(targetPath)) {
    shell.openExternal(targetPath)
    return true
  }

  // Executable
  execFile(targetPath, args ? args.split(' ') : [], { cwd: workingDir || undefined }, (err) => {
    if (err) console.error('Failed to launch:', err)
  })
  return true
})

// ─── Window & tray ──────────────────────────────────────────────────────────

function resolveResource(filename: string): string {
  const devPath = join(__dirname, '../../resources', filename)
  return existsSync(devPath) ? devPath : join(app.getAppPath(), '..', filename)
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

  // Global shortcut: Alt+Space to toggle window
  globalShortcut.register('Alt+Space', () => {
    toggleWindow()
  })

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
