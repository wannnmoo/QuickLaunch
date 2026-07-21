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
  /** Parse a .lnk shortcut file. Pass a path, or omit to open a file dialog. */
  parseLnk: (filePath?: string): Promise<LnkInfo | null> =>
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
  /** Select a folder and return its path, name, and system icon. */
  selectFolder: (): Promise<{ path: string; name: string; iconDataUrl: string } | null> =>
    ipcRenderer.invoke('select-folder'),
  /** Add a special system location (This PC or Recycle Bin). */
  addSpecialItem: (type: 'this-pc' | 'recycle-bin'): Promise<{
    path: string; name: string; iconDataUrl: string; specialType: string
  } | null> =>
    ipcRenderer.invoke('add-special-item', type)
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
