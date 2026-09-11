/// <reference types="vite/client" />

interface Window {
  api: {
    parseLnk: (filePath?: string) => Promise<{
      targetPath: string
      arguments: string
      workingDirectory: string
      windowStyle: number
      hotkey: string
      iconLocation: string
      description: string
      iconDataUrl: string
    }[]>
    runApp: (targetPath: string, args: string, workingDir: string) => Promise<boolean>
    getPathForFile: (file: File) => string
    describePaths: (paths: string[]) => Promise<{
      accepted: { targetPath: string; arguments: string; workingDirectory: string; description: string; iconDataUrl: string }[]
      rejected: string[]
    }>
    pickIcon: () => Promise<{ path: string; iconDataUrl: string } | null>
    runAsAdmin: (targetPath: string, args: string, workingDir: string) => Promise<boolean>
    openFileLocation: (targetPath: string) => Promise<void>
    copyText: (text: string) => Promise<void>
    loadShortcuts: () => Promise<{ id: number; iconDataUrl: string; targetPath: string; arguments: string; workingDirectory: string; description: string; isFolder?: boolean; specialType?: 'this-pc' | 'recycle-bin'; isGroup?: boolean; groupId?: number; isSeparator?: boolean }[]>
    saveShortcuts: (data: { id: number; iconDataUrl: string; targetPath: string; arguments: string; workingDirectory: string; description: string; isFolder?: boolean; specialType?: 'this-pc' | 'recycle-bin'; isGroup?: boolean; groupId?: number; isSeparator?: boolean }[]) => Promise<void>
    selectFolder: () => Promise<{ path: string; name: string; iconDataUrl: string }[]>
    scanDesktopFolders: () => Promise<{ path: string; name: string; iconDataUrl: string; specialType?: 'this-pc' | 'recycle-bin' }[]>
    checkMissingFolders: (paths: string[]) => Promise<string[]>
    onDesktopChanged: (callback: () => void) => () => void
    onNavEnter: (callback: () => void) => () => void
    getDesktopIconsHidden: () => Promise<boolean>
    toggleDesktopIcons: () => Promise<boolean>
    getAutoStart: () => Promise<boolean>
    setAutoStart: (enabled: boolean) => Promise<boolean>
    dockPointer: (inside: boolean) => void
  }
}
