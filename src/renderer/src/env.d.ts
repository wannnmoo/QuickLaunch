/// <reference types="vite/client" />

/** 文件夹子项（文件夹条目悬停预览卡片；主进程 list-folder 返回） */
interface FolderChild {
  name: string
  path: string
  isDir: boolean
  /** 文件字节数；目录恒为 -1（不递归统计） */
  size: number
  iconDataUrl: string
}

interface FolderListing {
  path: string
  name: string
  folders: number
  files: number
  items: FolderChild[]
  /** 超出列举上限（400）未列出的条目数 */
  truncated: number
  error?: 'missing' | 'denied' | 'notdir'
}

interface FolderIconsPayload {
  path: string
  /** 路径 → data:image/png;base64,…（只含本批取到图标的项） */
  icons: Record<string, string>
}

/** 停靠位置：bottom = 底部横条；top = 顶部横条；middle = 悬浮屏幕中央；left / right = 侧边竖排 */
type DockEdge = 'bottom' | 'top' | 'left' | 'right' | 'middle'

interface Window {
  api: {
    dockEdge: DockEdge
    getDockEdge: () => Promise<DockEdge>
    setDockEdge: (edge: DockEdge) => Promise<boolean>
    onDockEdgeChanged: (callback: (edge: DockEdge) => void) => () => void
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
    // true / false / 'in-tray' —— 语义见 preload 的 RunAppResult
    // （v1.13.8 起不再有 'probe-failed'：探不出结论时一律直接启动，fail-open）
    runApp: (
      targetPath: string,
      args: string,
      workingDir: string
    ) => Promise<true | false | 'in-tray'>
    getPathForFile: (file: File) => string
    describePaths: (paths: string[]) => Promise<{
      accepted: { targetPath: string; arguments: string; workingDirectory: string; description: string; iconDataUrl: string }[]
      rejected: string[]
    }>
    listDrives: () => Promise<{
      name: string
      label: string
      type: string
      format: string
      total: number
      free: number
      ready: boolean
    }[]>
    pickIcon: () => Promise<{ path: string; iconDataUrl: string } | null>
    listFolder: (dir: string) => Promise<FolderListing>
    onFolderIcons: (callback: (payload: FolderIconsPayload) => void) => () => void
    runAsAdmin: (targetPath: string, args: string, workingDir: string) => Promise<boolean>
    openFileLocation: (targetPath: string) => Promise<void>
    openPath: (targetPath: string) => Promise<boolean>
    copyText: (text: string) => Promise<void>
    loadShortcuts: () => Promise<{ id: number; iconDataUrl: string; targetPath: string; arguments: string; workingDirectory: string; description: string; isFolder?: boolean; specialType?: 'this-pc' | 'recycle-bin'; isGroup?: boolean; groupId?: number; isSeparator?: boolean }[]>
    saveShortcuts: (data: { id: number; iconDataUrl: string; targetPath: string; arguments: string; workingDirectory: string; description: string; isFolder?: boolean; specialType?: 'this-pc' | 'recycle-bin'; isGroup?: boolean; groupId?: number; isSeparator?: boolean }[]) => Promise<void>
    selectFolder: () => Promise<{ path: string; name: string; iconDataUrl: string }[]>
    scanDesktopFolders: () => Promise<{ path: string; name: string; iconDataUrl: string; specialType?: 'this-pc' | 'recycle-bin' }[]>
    checkMissingFolders: (paths: string[]) => Promise<string[]>
    onDesktopChanged: (callback: () => void) => () => void
    /** 退出前落盘：renderer 的保存有防抖，主进程退出时会推这条事件 */
    onFlushPendingSave: (callback: () => void) => () => void
    onNavEnter: (callback: () => void) => () => void
    /** null = 状态未知（读取失败），此时保持已知状态、不翻转文案 */
    getDesktopIconsHidden: () => Promise<boolean | null>
    /** 同步读取（sendSync）：用作 useState 初始值，保证首帧文案就是对的。null = 尚不知 */
    desktopIconsHiddenInitial: () => boolean | null
    toggleDesktopIcons: () => Promise<boolean | null>
    /** 应用版本号（显示在「+」菜单底部）。 */
    getAppVersion: () => Promise<string>
    getAutoStart: () => Promise<boolean>
    setAutoStart: (enabled: boolean) => Promise<boolean>
    dockPointer: (inside: boolean) => void
  }
}
