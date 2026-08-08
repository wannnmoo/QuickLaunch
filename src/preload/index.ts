import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

export interface LnkInfo {
  targetPath: string
  arguments: string
  workingDirectory: string
  windowStyle: number
  hotkey: string
  iconLocation: string
  description: string
  iconDataUrl: string
}

export interface AppEntry {
  id: number
  iconDataUrl: string
  targetPath: string
  arguments: string
  workingDirectory: string
  description: string
  isFolder?: boolean
  specialType?: 'this-pc' | 'recycle-bin'
}

// Custom APIs for renderer
const api = {
  /** Parse one or more .lnk shortcut files. Pass a path, or omit to open a multi-select file dialog. */
  parseLnk: (filePath?: string): Promise<LnkInfo[]> =>
    ipcRenderer.invoke('parse-lnk', filePath),
  /** Launch an executable with optional args and working directory. */
  runApp: (targetPath: string, args: string, workingDir: string): Promise<boolean> =>
    ipcRenderer.invoke('run-app', targetPath, args, workingDir),
  /** Load persisted shortcuts from disk. */
  loadShortcuts: (): Promise<AppEntry[]> =>
    ipcRenderer.invoke('load-shortcuts'),
  /** Save shortcuts to disk for persistence across restarts. */
  saveShortcuts: (data: AppEntry[]): Promise<void> =>
    ipcRenderer.invoke('save-shortcuts', data),
  /** Select one or more folders, returning each one's path, name, and system icon. */
  selectFolder: (): Promise<{ path: string; name: string; iconDataUrl: string }[]> =>
    ipcRenderer.invoke('select-folder'),
  /** Add a special system location (This PC or Recycle Bin). */
  addSpecialItem: (type: 'this-pc' | 'recycle-bin'): Promise<{
    path: string; name: string; iconDataUrl: string; specialType: string
  } | null> =>
    ipcRenderer.invoke('add-special-item', type),
  /** Get whether desktop icons are currently hidden (registry HideIcons). */
  getDesktopIconsHidden: (): Promise<boolean> =>
    ipcRenderer.invoke('get-desktop-icons-hidden'),
  /** Toggle desktop icon visibility (registry + shell refresh); returns new state. */
  toggleDesktopIcons: (): Promise<boolean> =>
    ipcRenderer.invoke('toggle-desktop-icons'),
  /** 通知主进程鼠标进入 Dock 窗口（inside=true）恢复置顶。
   *  沉底仅由点击其他软件（blur）触发——鼠标移出或在其他软件上滚动都不让位。 */
  dockPointer: (inside: boolean): void =>
    ipcRenderer.send('dock-pointer', inside)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
