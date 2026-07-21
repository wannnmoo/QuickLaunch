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
    } | null>
    runApp: (targetPath: string, args: string, workingDir: string) => Promise<boolean>
    loadShortcuts: () => Promise<{ id: number; iconDataUrl: string; targetPath: string; arguments: string; workingDirectory: string; description: string; isFolder?: boolean; specialType?: 'this-pc' | 'recycle-bin' }[]>
    saveShortcuts: (data: { id: number; iconDataUrl: string; targetPath: string; arguments: string; workingDirectory: string; description: string; isFolder?: boolean; specialType?: 'this-pc' | 'recycle-bin' }[]) => Promise<void>
    selectFolder: () => Promise<{ path: string; name: string; iconDataUrl: string } | null>
    addSpecialItem: (type: 'this-pc' | 'recycle-bin') => Promise<{ path: string; name: string; iconDataUrl: string; specialType: string } | null>
  }
}
