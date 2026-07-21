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
    loadShortcuts: () => Promise<{ id: number; iconDataUrl: string; targetPath: string; arguments: string; workingDirectory: string; description: string }[]>
    saveShortcuts: (data: { id: number; iconDataUrl: string; targetPath: string; arguments: string; workingDirectory: string; description: string }[]) => Promise<void>
    selectFolder: () => Promise<{ path: string; name: string; iconDataUrl: string } | null>
  }
}
