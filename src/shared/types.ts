/**
 * 跨进程共享类型 —— **唯一真相源**。
 *
 * 之前 `AppEntry` 在三处各写一份（renderer 的 App.tsx、preload、main 的 sanitize），
 * `DockEdge` 在 preload 与 main 各写一份，`FolderListing` 在 preload 与
 * renderer 的 env.d.ts 各写一份。字段一改就要记得同步三处，漏一处就是运行时
 * 静默丢字段（sanitize 会把不认识的形状删掉）。
 *
 * 约定：
 * - 这里只放**纯类型**，不放运行时代码（renderer / main / preload 三边都要能 import）。
 * - 新增字段一律可选，且必须在 `sanitizeShortcutEntries`（src/main/index.ts）里
 *   补一条类型校验，否则手改 JSON 写进来的脏值会被透传到 renderer。
 */

/** 停靠位置：bottom = 底部横条；top = 顶部横条；middle = 悬浮屏幕中央；
 *  left / right = 侧边竖排（IMPLEMENTED_EDGES 尚未放行，属下一阶段） */
export type DockEdge = 'bottom' | 'top' | 'left' | 'right' | 'middle'

/** 横向三档（窗口尺寸相同，原地 setBounds 切换，不重建窗口） */
export type HorizontalDockEdge = 'bottom' | 'top' | 'middle'

/** 主 Dock 里一个条目的形状（持久化到 shortcuts.json 的就是它，不额外包一层） */
export interface AppEntry {
  id: number
  /** 图标 data URL。图标外置成 `iconFile` 之后这里会缺失（图标在磁盘上，由 ql-icon://
   *  协议提供）—— 渲染一律走 App.tsx 的 `iconSrc()`，不要直接读这个字段。 */
  iconDataUrl?: string
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
  /** 分页（多 Dock）：缺省 = 第 0 页。只在顶层条目上有意义 */
  page?: number
  /** 图标文件化之后的文件名（相对 {userData}/icons/）；有它时优先于 iconDataUrl */
  iconFile?: string
  /** 用户为单个条目绑定的全局快捷键，如 "Ctrl+Alt+W"；空/缺省 = 不绑定 */
  hotkey?: string
  /** 累计启动次数（「按使用频率排序」用） */
  runCount?: number
  /** 最后一次启动的时间戳（毫秒），用于「最近使用」排序 */
  lastRunAt?: number
}

/** `.lnk` / `.url` / `.pif` 解析结果（PowerShell 侧采集的原样字段） */
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

/** `load-shortcuts` 的返回：条目 + 配置是否损坏 + 是否从 `.bak` 恢复。
 *  不能只返回数组——解析失败返回空数组会让 renderer 把整份配置当成「用户清空了」
 *  再保存回磁盘，静默覆盖掉原文件。 */
export interface LoadShortcutsResult {
  entries: AppEntry[]
  /** true = 原文件读不出来（JSON 损坏/读失败）；renderer 必须提示用户 */
  corrupt: boolean
  /** true = entries 来自 `shortcuts.json.bak` */
  recovered: boolean
}

/** `run-app` 的返回值。
 *  - `true`       已启动，或「已在运行且窗口已激活/置前」
 *  - `false`      启动失败（目标不存在 / 无法运行 / UAC 被取消）
 *  - `'in-tray'`  目标已在运行、窗口收在托盘里，且没能用 UI Automation 点开托盘图标
 *  ⚠️ 不要简化回 boolean：`'in-tray'` 必须能和「失败」区分，否则用户看到的是「点了没反应」。
 *  ⚠️ `'probe-failed'` 已在 v1.13.8 删除（探不出结论时 fail-open 直接启动）。 */
export type RunAppResult = true | false | 'in-tray'

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

/** 盘符（`list-drives`） */
export interface DriveInfo {
  name: string
  label: string
  type: string
  format: string
  total: number
  free: number
  ready: boolean
}

/** renderer 上报给主进程的命中区矩形（DIP，相对窗口内容区） */
export interface DockHitRegionRect {
  x: number
  y: number
  width: number
  height: number
  /** true = 有浮层打开，region 放开整窗 */
  overlay: boolean
}

/** 用户设置（{userData}/settings.json）。所有字段都有默认值，缺省即默认。 */
export interface AppSettings {
  /** 界面主题 */
  theme: 'dark' | 'light' | 'transparent'
  /** 夜间/日间玻璃亮度：跟随 theme 还是由 user */
  glassPlan: 'dark' | 'light'
  /** 停靠位置（与 window-position.json 同步，读写都走它） */
  dockEdge: DockEdge
  /** 图标衬底尺寸（px）：48 / 60 / 72 三档 */
  iconSize: 48 | 60 | 72
  /** 悬停放大倍数（1.0 ~ 1.6） */
  magnify: number
  /** 玻璃模糊强度（px）与饱和度 */
  glassBlur: number
  glassSaturate: number
  /** 文件夹预览卡片：悬停多久弹出（ms） */
  folderCardDelay: number
  /** 分组面板：鼠标离开后多久收起（ms） */
  panelCloseDelay: number
  /** 启动目标后的行为 */
  afterLaunch: 'hide' | 'keep' | 'sink'
  /** 点图标前先探询是否已在运行（微信/QQ 收托盘时点图标不重复开实例） */
  probeBeforeLaunch: boolean
  /** 键盘唤出后可直接输入，进入搜索 */
  searchEnabled: boolean
  /** 主题跟随系统（覆盖 theme 的 dark/light，transparent 不受影响） */
  followSystemTheme: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  glassPlan: 'dark',
  dockEdge: 'middle',
  iconSize: 60,
  magnify: 1.4,
  glassBlur: 36,
  glassSaturate: 1.7,
  folderCardDelay: 300,
  panelCloseDelay: 180,
  afterLaunch: 'hide',
  probeBeforeLaunch: false,
  searchEnabled: true,
  followSystemTheme: false
}
