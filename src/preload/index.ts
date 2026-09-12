import { contextBridge, ipcRenderer, webUtils } from 'electron'
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
  /** 分组（Stack）：点击展开面板而不启动；targetPath 为空 */
  isGroup?: boolean
  /** 所属分组的 id（无此字段 = Dock 顶层图标） */
  groupId?: number
  /** 分隔线：不启动、不参与统计与桌面扫描；靠右键图标「在此之前插入分隔线」创建 */
  isSeparator?: boolean
}

/** 文件夹子项（悬停预览卡片用） */
export interface FolderChild {
  name: string
  path: string
  isDir: boolean
  /** 文件字节数；目录恒为 -1（不递归统计） */
  size: number
  iconDataUrl: string
}

export interface FolderListing {
  path: string
  name: string
  folders: number
  files: number
  items: FolderChild[]
  /** 超出列举上限（400）未列出的条目数 */
  truncated: number
  error?: 'missing' | 'denied' | 'notdir'
}

/** 图标分批补齐事件负载：列表先返回，图标分批提取完后就地替换（只含本批取到的路径） */
export interface FolderIconsPayload {
  path: string
  /** 路径 → data:image/png;base64,… */
  icons: Record<string, string>
}

/** 停靠位置：bottom = 底部横条；top = 顶部横条；middle = 悬浮屏幕中央；
 *  left / right = 侧边竖排（下一阶段） */
export type DockEdge = 'bottom' | 'top' | 'left' | 'right' | 'middle'

// 停靠位置（主进程通过 additionalArguments 传进来，首帧即可用）。
// 兜底值必须与主进程的 DEFAULT_EDGE 一致（中间），否则参数缺失时会出现
// 「主进程按中间摆窗口、渲染端按底部画布局」的错配
const dockEdgeFromArgv = (): DockEdge => {
  const arg = process.argv.find((a) => a.startsWith('--ql-edge='))
  const v = arg?.slice('--ql-edge='.length)
  return v === 'top' || v === 'left' || v === 'right' || v === 'bottom' ? v : 'middle'
}

// Custom APIs for renderer
const api = {
  /** 当前停靠边（'bottom' | 'top' | 'left' | 'right'）：渲染端据此决定布局方向。 */
  dockEdge: dockEdgeFromArgv(),
  /** 订阅「停靠位置被原地切换」事件（横向三档尺寸相同，主进程用 setBounds + 本事件切换，
   *  不重建窗口，所以是瞬间的），返回取消订阅函数。 */
  onDockEdgeChanged: (callback: (edge: DockEdge) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, edge: DockEdge): void => callback(edge)
    ipcRenderer.on('dock-edge-changed', listener)
    return () => { ipcRenderer.removeListener('dock-edge-changed', listener) }
  },
  /** 读取当前停靠位置：`dockEdge` 是建窗那一刻的快照，而横向三档是原地切换不重建窗口，
   *  所以页面重载（dev HMR / Ctrl+R）后要用它对齐。 */
  getDockEdge: (): Promise<DockEdge> =>
    ipcRenderer.invoke('get-dock-edge'),
  /** 切换停靠位置（下/上/左/右/中间）：横向三档原地切换，竖排会销毁并按新形状重建窗口。 */
  setDockEdge: (edge: DockEdge): Promise<boolean> =>
    ipcRenderer.invoke('set-dock-edge', edge),
  /** Parse one or more .lnk shortcut files. Pass a path, or omit to open a multi-select file dialog. */
  parseLnk: (filePath?: string): Promise<LnkInfo[]> =>
    ipcRenderer.invoke('parse-lnk', filePath),
  /** Launch an executable with optional args and working directory. */
  runApp: (targetPath: string, args: string, workingDir: string): Promise<boolean> =>
    ipcRenderer.invoke('run-app', targetPath, args, workingDir),
  /** 为条目更换图标：选择 exe/dll/ico/png 并提取图标，返回 { path, iconDataUrl } 或 null（取消）。 */
  pickIcon: (): Promise<{ path: string; iconDataUrl: string } | null> =>
    ipcRenderer.invoke('pick-icon'),
  /** 拖放添加：把 DataTransfer 里的 File 转成真实文件路径（Electron 32+ 已移除 File.path）。 */
  getPathForFile: (file: unknown): string => {
    try {
      return webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0])
    } catch { return '' }
  },
  /** 拖放添加：解析拖入的文件路径，返回可添加的条目与不支持的路径。 */
  describePaths: (paths: string[]): Promise<{
    accepted: { targetPath: string; arguments: string; workingDirectory: string; description: string; iconDataUrl: string }[]
    rejected: string[]
  }> => ipcRenderer.invoke('describe-paths', paths),
  /** 枚举驱动器（「此电脑」悬停卡片与图标用量条用）：单次 PowerShell 返回盘符/卷标/类型/容量。 */
  listDrives: (): Promise<{
    name: string
    label: string
    type: string
    format: string
    total: number
    free: number
    ready: boolean
  }[]> => ipcRenderer.invoke('list-drives'),
  /** 列出文件夹子项（文件夹条目悬停预览卡片）：目录优先 + 名称自然序，最多 400 项。
   *  图标先用通用图标秒回，真图标由 `folder-icons` 事件随后补齐。 */
  listFolder: (dir: string): Promise<FolderListing> =>
    ipcRenderer.invoke('list-folder', dir),
  /** 订阅「真图标补齐」事件（exe/lnk/url 的真实图标后台提取完后推送），返回取消订阅函数。 */
  onFolderIcons: (callback: (payload: FolderIconsPayload) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: FolderIconsPayload): void => callback(payload)
    ipcRenderer.on('folder-icons', listener)
    return () => { ipcRenderer.removeListener('folder-icons', listener) }
  },
  /** 以管理员身份运行目标（Start-Process -Verb RunAs → UAC 提权）。 */
  runAsAdmin: (targetPath: string, args: string, workingDir: string): Promise<boolean> =>
    ipcRenderer.invoke('run-as-admin', targetPath, args, workingDir),
  /** 在资源管理器中定位目标文件/文件夹。 */
  openFileLocation: (targetPath: string): Promise<void> =>
    ipcRenderer.invoke('open-file-location', targetPath),
  /** 按资源管理器双击的语义打开任意路径（目录开资源管理器，文件交给关联程序）。 */
  openPath: (targetPath: string): Promise<boolean> =>
    ipcRenderer.invoke('open-path', targetPath),
  /** 复制文本到剪贴板（如条目路径）。 */
  copyText: (text: string): Promise<void> =>
    ipcRenderer.invoke('copy-text', text),
  /** Load persisted shortcuts from disk. */
  loadShortcuts: (): Promise<AppEntry[]> =>
    ipcRenderer.invoke('load-shortcuts'),
  /** Save shortcuts to disk for persistence across restarts. */
  saveShortcuts: (data: AppEntry[]): Promise<void> =>
    ipcRenderer.invoke('save-shortcuts', data),
  /** Select one or more folders, returning each one's path, name, and system icon. */
  selectFolder: (): Promise<{ path: string; name: string; iconDataUrl: string }[]> =>
    ipcRenderer.invoke('select-folder'),
  /** 扫描桌面上的文件夹和指向文件夹的 .lnk 快捷方式，并固定附加「此电脑」「回收站」系统位置（启动时自动合并，renderer 端去重）。 */
  scanDesktopFolders: (): Promise<{ path: string; name: string; iconDataUrl: string; specialType?: 'this-pc' | 'recycle-bin' }[]> =>
    ipcRenderer.invoke('scan-desktop-folders'),
  /** 检查哪些文件夹路径已不存在（用于清理被删除的桌面文件夹条目），返回不存在的子集。 */
  checkMissingFolders: (paths: string[]): Promise<string[]> =>
    ipcRenderer.invoke('check-folders-missing', paths),
  /** 订阅桌面文件夹变化事件（fs.watch + debounce 后推送），返回取消订阅函数。 */
  onDesktopChanged: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('desktop-changed', listener)
    return () => { ipcRenderer.removeListener('desktop-changed', listener) }
  },
  /** 订阅「退出前立刻落盘」事件：renderer 的保存有 400ms 防抖，退出时主进程会推这条
   *  事件让未落盘的改动立刻写入（收到后同步 invoke save-shortcuts 即可）。 */
  onFlushPendingSave: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('flush-pending-save', listener)
    return () => { ipcRenderer.removeListener('flush-pending-save', listener) }
  },
  /** 订阅「进入键盘导航」事件（Alt+Space 唤出 Dock 时由主进程推送），返回取消订阅函数。 */
  onNavEnter: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('nav-enter', listener)
    return () => { ipcRenderer.removeListener('nav-enter', listener) }
  },
  /** Get whether desktop icons are currently hidden (registry HideIcons). */
  getDesktopIconsHidden: (): Promise<boolean> =>
    ipcRenderer.invoke('get-desktop-icons-hidden'),
  /** Toggle desktop icon visibility (registry + shell refresh); returns new state. */
  toggleDesktopIcons: (): Promise<boolean> =>
    ipcRenderer.invoke('toggle-desktop-icons'),
  /** 开机自启动当前是否开启（注册表 Run 登录项）。 */
  getAutoStart: (): Promise<boolean> =>
    ipcRenderer.invoke('get-auto-start'),
  /** 开启/关闭开机自启动（写注册表 Run 登录项），返回切换后实际状态。 */
  setAutoStart: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('set-auto-start', enabled),
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
