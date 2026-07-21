import { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, globalShortcut, nativeImage } from 'electron'
import { join, basename } from 'path'
import { readFileSync, writeFileSync, existsSync, statSync } from 'fs'
import { execFile } from 'child_process'
import { is } from '@electron-toolkit/utils'

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

// IPC: parse .lnk shortcut file via PowerShell
ipcMain.handle('parse-lnk', async (_event, filePath?: string) => {
  // If no path provided, open file dialog
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
    // Use C# P/Invoke ExtractIconEx to get the LARGE icon from the exe
    const psScript = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing

# Win32 P/Invoke: SHDefExtractIcon requests icon at a specific size (256px)
Add-Type -ReferencedAssemblies 'System.Drawing' -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class LargeIconExtractor {
    [DllImport("shell32.dll", CharSet = CharSet.Auto)]
    static extern int SHDefExtractIcon(string pszIconFile, int iIndex, uint uFlags,
        out IntPtr phiconLarge, out IntPtr phiconSmall, uint nIconSize);

    [DllImport("user32.dll")]
    static extern bool DestroyIcon(IntPtr hIcon);

    public static string GetIconBase64(string filePath, int iconIndex) {
        IntPtr hLarge, hSmall;
        int hr = SHDefExtractIcon(filePath, iconIndex, 0, out hLarge, out hSmall, 256);
        if (hr != 0 || hLarge == IntPtr.Zero)
            return "";
        try {
            using (Icon icon = Icon.FromHandle(hLarge)) {
                int size = icon.Width > 0 ? icon.Width : 256;
                using (Bitmap bmp = new Bitmap(size, size)) {
                    bmp.MakeTransparent();
                    using (Graphics g = Graphics.FromImage(bmp)) {
                        g.Clear(Color.Transparent);
                        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                        g.DrawIcon(icon, new Rectangle(0, 0, size, size));
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
'@

$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${filePath.replace(/'/g, "''")}')
$targetPath = $s.TargetPath
$isUrl = ($targetPath -match '^(https?|ftp|mailto|steam)://')

# Parse IconLocation: "path,index" -> icon file & index
$iconFile = $targetPath
$iconIdx = 0
$loc = $s.IconLocation
if ($loc -and $loc -match '(.+),(-?\d+)$') {
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
      if ($line -match '^IconFile\s*=\s*(.+)$') {
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
          if ($urlIni -match 'IconIndex\s*=\s*(\d+)') { $iconIdx = [int]$Matches[1] }
        }
        break
      }
    }
  }
}

if (-not $iconBase64) {
  $iconBase64 = ''
  if ($iconFile -and (Test-Path $iconFile)) {
    $iconBase64 = [LargeIconExtractor]::GetIconBase64($iconFile, $iconIdx)
  }

  # Fallback for URL shortcuts: use default browser icon
  if (-not $iconBase64 -and $isUrl) {
    $browserExe = (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice' -ErrorAction SilentlyContinue).ProgId
    if (-not $browserExe) { $browserExe = 'ChromeHTML' }
    $browserCmd = (Get-ItemProperty "HKLM:\\Software\\Classes\\$browserExe\\shell\\open\\command" -ErrorAction SilentlyContinue).'(Default)'
    if ($browserCmd -and $browserCmd -match '^"([^"]+)"') {
      $iconBase64 = [LargeIconExtractor]::GetIconBase64($Matches[1], 0)
    }
    # last resort: globe icon from shell32.dll
    if (-not $iconBase64) {
      $iconBase64 = [LargeIconExtractor]::GetIconBase64('C:\\Windows\\System32\\shell32.dll', 13)
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

// IPC: persist shortcuts to user data directory
const shortcutsPath = join(app.getPath('userData'), 'shortcuts.json')

ipcMain.handle('load-shortcuts', () => {
  try {
    if (existsSync(shortcutsPath)) {
      const raw = readFileSync(shortcutsPath, 'utf-8')
      return JSON.parse(raw)
    }
  } catch {
    // corrupted file, ignore and return empty
  }
  return []
})

ipcMain.handle('save-shortcuts', (_event, data: unknown) => {
  if (!Array.isArray(data)) return
  try {
    writeFileSync(shortcutsPath, JSON.stringify(data), 'utf-8')
  } catch (e) {
    console.error('Failed to save shortcuts:', e)
  }
})

// IPC: select a folder and return the classic Windows folder icon
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: '选择文件夹',
    properties: ['openDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return null

  const folderPath = result.filePaths[0]
  const name = basename(folderPath)

  // Extract Windows classic yellow folder icon from shell32.dll (index 4)
  const iconDataUrl = await new Promise<string>((resolve) => {
    const psScript = `
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies 'System.Drawing' -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class FolderIconExtractor {
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
'@
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$b64 = [FolderIconExtractor]::GetIconBase64('C:\\Windows\\System32\\shell32.dll', 4, 256)
Write-Output $b64
`
    execFile('powershell', ['-NoProfile', '-Command', psScript], { timeout: 10000 }, (err, stdout) => {
      if (err || !stdout.trim()) {
        resolve('')
        return
      }
      const b64 = stdout.trim()
      resolve(b64 ? 'data:image/png;base64,' + b64 : '')
    })
  })

  return { path: folderPath, name, iconDataUrl }
})

// IPC: launch an executable, URL, or open a folder
ipcMain.handle('run-app', async (_event, targetPath: string, args: string, workingDir: string) => {
  if (!targetPath) return false

  // Open folder in Explorer
  try {
    const st = statSync(targetPath)
    if (st.isDirectory()) {
      shell.openPath(targetPath)
      return true
    }
  } catch {
    // not a filesystem path, continue
  }

  const isUrl = /^(https?|ftp|mailto|steam):\/\//i.test(targetPath)
  if (isUrl) {
    shell.openExternal(targetPath)
    return true
  }
  execFile(targetPath, args ? args.split(' ') : [], { cwd: workingDir || undefined }, (err) => {
    if (err) console.error('Failed to launch:', err)
  })
  return true
})

function getIconPath(): string {
  // Development: <project>/resources/icon.ico
  const devPath = join(__dirname, '../../resources/icon.ico')
  if (existsSync(devPath)) return devPath
  // Production (extraResources): <install>/resources/icon.ico
  const prodPath = join(app.getAppPath(), '../icon.ico')
  if (existsSync(prodPath)) return prodPath
  return devPath
}

function createWindow(): void {
  const iconPath = getIconPath()

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    frame: false,
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

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()

  // System tray — 16x16 PNG with solid background
  const devTrayPath = join(__dirname, '../../resources/tray-icon.png')
  const prodTrayPath = join(app.getAppPath(), '../tray-icon.png')
  const trayIconPath = existsSync(devTrayPath) ? devTrayPath : prodTrayPath
  const trayIcon = nativeImage.createFromPath(trayIconPath)
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
