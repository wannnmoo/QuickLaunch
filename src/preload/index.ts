import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  AppEntry,
  AppSettings,
  DockEdge,
  FolderIconsPayload,
  FolderListing,
  LnkInfo,
  LoadShortcutsResult,
  RunAppResult
} from '../shared/types'

// 类型的唯一真相源在 src/shared/types.ts（renderer / preload / main 三边共享）。
// 这里只 re-export，保持 `import type { AppEntry } from '../preload'` 这类既有写法不断。
export type {
  AppEntry,
  DockEdge,
  FolderChild,
  FolderIconsPayload,
  FolderListing,
  LnkInfo,
  LoadShortcutsResult,
  RunAppResult
} from '../shared/types'

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
  /** Launch an executable with optional args and working directory.
   *  返回 true / false / 'in-tray'，语义见 RunAppResult。 */
  runApp: (targetPath: string, args: string, workingDir: string): Promise<RunAppResult> =>
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
  /** Load persisted shortcuts from disk. 损坏时返回 corrupt=true（不 throw）。 */
  loadShortcuts: (): Promise<LoadShortcutsResult> =>
    ipcRenderer.invoke('load-shortcuts'),
  /** Save shortcuts to disk. 返回 false = 写盘失败（磁盘满/无权限），调用方必须提示。 */
  saveShortcuts: (data: AppEntry[]): Promise<boolean> =>
    ipcRenderer.invoke('save-shortcuts', data),
  /** A1：把条目上的内联 base64 图标外置成 `iconFile`（落盘到 userData/icons/）。
   *  返回新数组，`changed = false` 时 entries 与入参等价（可以直接沿用旧 state）。 */
  externalizeIcons: (data: AppEntry[]): Promise<{ entries: AppEntry[]; changed: boolean }> =>
    ipcRenderer.invoke('externalize-icons', data),
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
  /** 退出前落盘完成的回执（B5）：主进程收到后才真正退出，最多等 800ms。
   *  renderer 必须在 save-shortcuts 的 Promise 落定之后才调它 —— 提前调等于没等。 */
  flushSaveDone: (): void => ipcRenderer.send('flush-save-done'),
  /** 订阅「进入键盘导航」事件（Alt+Space 唤出 Dock 时由主进程推送），返回取消订阅函数。 */
  onNavEnter: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('nav-enter', listener)
    return () => { ipcRenderer.removeListener('nav-enter', listener) }
  },
  /** 桌面图标当前是否隐藏。**读失败时是 null（状态未知）**，不是 false ——
   *  见主进程 readDesktopIconsHidden 的注释：把「读失败」当成「图标可见」
   *  会让菜单文案先显示一个错的值、再翻成对的，用户看到闪烁。 */
  getDesktopIconsHidden: (): Promise<boolean | null> =>
    ipcRenderer.invoke('get-desktop-icons-hidden'),
  /** 桌面图标隐藏状态的**同步**读取（sendSync）：renderer 用它做 useState 的初始值，
   *  这样首帧就是对的，不会「先渲染错的、再翻成对的」。
   *  主进程侧读的是启动时预热好的缓存，不会阻塞；返回 null = 尚不知/读失败。 */
  desktopIconsHiddenInitial: (): boolean | null =>
    ipcRenderer.sendSync('get-desktop-icons-hidden-sync') as boolean | null,
  /** Toggle desktop icon visibility (registry + shell refresh); returns new state. */
  toggleDesktopIcons: (): Promise<boolean | null> =>
    ipcRenderer.invoke('toggle-desktop-icons'),
  /** 应用版本号（显示在「+」菜单底部）。 */
  getAppVersion: (): Promise<string> =>
    ipcRenderer.invoke('get-app-version'),
  /** 检查更新（F1）：读 latest.yml 比对版本。永不 reject，失败以 status:'error' 返回。 */
  checkUpdate: (): Promise<{
    status: 'dev' | 'latest' | 'available' | 'error'
    current: string
    latest?: string
    url?: string
    reason?: string
  }> => ipcRenderer.invoke('check-update'),
  /** 打开更新下载页（只接受 http/https）。 */
  openUpdatePage: (url: string): Promise<boolean> =>
    ipcRenderer.invoke('open-update-page', url),
  /** 开机自启动当前是否开启（注册表 Run 登录项）。 */
  getAutoStart: (): Promise<boolean> =>
    ipcRenderer.invoke('get-auto-start'),
  /** 开启/关闭开机自启动（写注册表 Run 登录项），返回切换后实际状态。 */
  setAutoStart: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('set-auto-start', enabled),
  /** 通知主进程鼠标进入 Dock 窗口（inside=true）恢复置顶。
   *  沉底仅由点击其他软件（blur）触发——鼠标移出或在其他软件上滚动都不让位。 */
  dockPointer: (inside: boolean): void =>
    ipcRenderer.send('dock-pointer', inside),
  /** 上报玻璃条（`.dock-bar`）当前矩形与「有没有浮层开着」，主进程据此调用
   *  `win.setShape()` 把窗口的**命中区**裁成只有玻璃条那一条（+ 8px 阴影余量），
   *  上方 134px 透明区与玻璃条左右两侧的留白彻底交给桌面。
   *  ⚠️ 透明窗口在 Windows 上没有 per-pixel 命中测试（窗口是 WS_EX_NOREDIRECTIONBITMAP，
   *     不是 WS_EX_LAYERED）：`transparent: true` 只影响绘制，整块矩形照样吃鼠标。
   *  ⚠️ 浮层（「+」菜单 / 右键菜单 / 盘符卡片 / 文件夹卡片 / 分组面板）全是
   *     `position: fixed` 向上弹出、画在玻璃条**上方**的透明区里，`overlay: true`
   *     期间主进程会把 region 放开成整窗，否则它们会被 region 裁掉、根本看不见。 */
  setDockHitRegion: (rect: {
    /** 窗口坐标（= CSS px = DIP），相对视口左上角 */
    x: number
    y: number
    width: number
    height: number
    /** true = 有浮层开着，命中区临时放开成整个窗口 */
    overlay: boolean
    /** 朝窗口内侧内缩多少 px（E1：随图标尺寸缩放，60px 档 = 20）。
     *  不传则主进程用默认 20 —— 老版本 renderer 上报的 payload 里没有这个字段。 */
    inset?: number
  }): void => ipcRenderer.send('dock-hit-region', rect),
  /** 渲染端未捕获错误上报（落进 userData/logs/main.log）。打包版里没有终端，
   *  这是 renderer 唯一能被事后看到的通道。 */
  reportError: (payload: { message: string; stack?: string; source?: string }): void =>
    ipcRenderer.send('report-renderer-error', payload),
  /** 在资源管理器里打开日志目录 */
  openLogDir: (): Promise<boolean> =>
    ipcRenderer.invoke('open-log-dir'),
  /** 导出诊断包（日志 + 配置 + 环境信息）到桌面，返回 zip 路径；false = 失败 */
  exportDiagnostics: (): Promise<string | false> =>
    ipcRenderer.invoke('export-diagnostics'),
  /** 用户设置：**同步**首读（sendSync）。renderer 把它当 useState 初始值，
   *  这样首帧的主题/图标尺寸/玻璃强度就是对的，不会「先画默认、再翻成用户值」。 */
  settingsInitial: (): AppSettings =>
    ipcRenderer.sendSync('get-settings-sync') as AppSettings,
  /** 用户设置（异步读取，用于窗口重建后重新同步）。 */
  getSettings: (): Promise<AppSettings> =>
    ipcRenderer.invoke('get-settings'),
  /** 改设置：只传要改的字段（partial patch），返回合并后的完整设置。 */
  setSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('set-settings', patch),
  /** 订阅设置变更（主进程写盘后广播给所有窗口），返回取消订阅函数。 */
  onSettingsChanged: (callback: (settings: AppSettings) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, s: AppSettings): void => callback(s)
    ipcRenderer.on('settings-changed', listener)
    return () => { ipcRenderer.removeListener('settings-changed', listener) }
  },
  /** 打开设置中心（独立窗口 760×560）。Dock 只有 300px 高、透明窗不能 resize，
   *  所以设置表单不在菜单里，而是在自己的窗口里。 */
  openSettings: (): Promise<boolean> =>
    ipcRenderer.invoke('open-settings'),
  /** 关闭当前窗口（设置中心的标题栏 × 与 Esc 都走这条）。 */
  closeSettings: (): void => ipcRenderer.send('settings-close'),
  /** 最小化当前窗口（设置中心标题栏 –）。 */
  minimizeSettings: (): void => ipcRenderer.send('settings-minimize'),
  /** 打开数据目录（shortcuts.json / icons / logs 所在的 userData）。 */
  openDataDir: (): Promise<boolean> =>
    ipcRenderer.invoke('settings-data-dir')
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    // contextBridge 失败意味着 window.api 根本没挂上，renderer 会立刻在调用处报错；
    // 主进程侧由 render-process-gone / 看门狗兜底，这里只需保证异常不外泄打断 preload 执行。
    void error
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
