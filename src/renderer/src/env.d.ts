/// <reference types="vite/client" />

// 类型真相源：src/shared/types.ts（renderer / preload / main 三边共享）。
// 这里用 import() 类型别名而不是顶层 import —— 顶层 import 会把本文件变成模块，
// 下面 `interface Window` 的全局声明就失效了。
type FolderChild = import('../../shared/types').FolderChild
type FolderListing = import('../../shared/types').FolderListing
type FolderIconsPayload = import('../../shared/types').FolderIconsPayload
type DockEdge = import('../../shared/types').DockEdge
type LnkInfo = import('../../shared/types').LnkInfo
type DriveInfo = import('../../shared/types').DriveInfo
type AppSettings = import('../../shared/types').AppSettings
/** 持久化条目形状（= 共享的 AppEntry） */
type ShortcutEntry = import('../../shared/types').AppEntry
type LoadShortcutsResult = import('../../shared/types').LoadShortcutsResult

interface Window {
  api: {
    dockEdge: DockEdge
    getDockEdge: () => Promise<DockEdge>
    setDockEdge: (edge: DockEdge) => Promise<boolean>
    onDockEdgeChanged: (callback: (edge: DockEdge) => void) => () => void
    parseLnk: (filePath?: string) => Promise<LnkInfo[]>
    // true / false / 'in-tray' —— 语义见 shared 的 RunAppResult
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
    listDrives: () => Promise<DriveInfo[]>
    pickIcon: () => Promise<{ path: string; iconDataUrl: string } | null>
    listFolder: (dir: string) => Promise<FolderListing>
    onFolderIcons: (callback: (payload: FolderIconsPayload) => void) => () => void
    runAsAdmin: (targetPath: string, args: string, workingDir: string) => Promise<boolean>
    openFileLocation: (targetPath: string) => Promise<void>
    openPath: (targetPath: string) => Promise<boolean>
    copyText: (text: string) => Promise<void>
    loadShortcuts: () => Promise<LoadShortcutsResult>
    /** 返回 false = 写盘失败（磁盘满/无权限），调用方必须提示 */
    saveShortcuts: (data: ShortcutEntry[]) => Promise<boolean>
    /** A1：把内联 base64 图标外置成 iconFile 文件名（落盘到 userData/icons/） */
    externalizeIcons: (
      data: ShortcutEntry[]
    ) => Promise<{ entries: ShortcutEntry[]; changed: boolean }>
    selectFolder: () => Promise<{ path: string; name: string; iconDataUrl: string }[]>
    scanDesktopFolders: () => Promise<{ path: string; name: string; iconDataUrl: string; specialType?: 'this-pc' | 'recycle-bin' }[]>
    checkMissingFolders: (paths: string[]) => Promise<string[]>
    onDesktopChanged: (callback: () => void) => () => void
    /** 退出前落盘：renderer 的保存有防抖，主进程退出时会推这条事件 */
    onFlushPendingSave: (callback: () => void) => () => void
    /** 退出前落盘的完成回执（B5）：写盘 Promise 落定之后再调 */
    flushSaveDone: () => void
    onNavEnter: (callback: () => void) => () => void
    /** null = 状态未知（读取失败），此时保持已知状态、不翻转文案 */
    getDesktopIconsHidden: () => Promise<boolean | null>
    /** 同步读取（sendSync）：用作 useState 初始值，保证首帧文案就是对的。null = 尚不知 */
    desktopIconsHiddenInitial: () => boolean | null
    toggleDesktopIcons: () => Promise<boolean | null>
    /** 应用版本号（显示在「+」菜单底部）。 */
    getAppVersion: () => Promise<string>
  checkUpdate: () => Promise<{
    status: 'dev' | 'latest' | 'available' | 'error'
    current: string
    latest?: string
    url?: string
    reason?: string
  }>
  openUpdatePage: (url: string) => Promise<boolean>
    getAutoStart: () => Promise<boolean>
    setAutoStart: (enabled: boolean) => Promise<boolean>
    dockPointer: (inside: boolean) => void
    /** 上报 `.dock-bar` 矩形 + 浮层状态，主进程用它算 `setShape()` 的命中区 */
    setDockHitRegion: (rect: {
      x: number
      y: number
      width: number
      height: number
      overlay: boolean
      /** 朝窗口内侧的内缩量（随图标尺寸缩放），不传 = 主进程默认 20 */
      inset?: number
    }) => void
    /** 渲染端未捕获错误上报（写进 userData/logs/main.log） */
    reportError: (payload: { message: string; stack?: string; source?: string }) => void
    openLogDir: () => Promise<boolean>
    /** 导出诊断包到桌面，返回 zip 路径；false = 失败 */
    exportDiagnostics: () => Promise<string | false>
    /** 用户设置：同步首读（sendSync），用作 useState 初始值避免首帧闪烁 */
    settingsInitial: () => AppSettings
    getSettings: () => Promise<AppSettings>
    /** 只传要改的字段，返回合并后的完整设置 */
    setSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
    onSettingsChanged: (callback: (settings: AppSettings) => void) => () => void
    /** 打开设置中心独立窗口（760×560），返回是否已打开 */
    openSettings: () => Promise<boolean>
    /** 关闭当前窗口（设置中心标题栏 × / Esc） */
    closeSettings: () => void
    /** 最小化当前窗口（设置中心标题栏 –） */
    minimizeSettings: () => void
    /** 打开数据目录（shortcuts.json / icons / logs） */
    openDataDir: () => Promise<boolean>
  }
}
