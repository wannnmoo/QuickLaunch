import { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo } from 'react'

interface AppEntry {
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

let nextId = 0

// 桌面扫描去重：路径规范化（去尾部反斜杠 + 小写），Windows 路径大小写不敏感
const normPath = (p: string): string => (p || '').trim().replace(/\\+$/, '').toLowerCase()

// 顶层下标 → 扁平数组里的锚点 id（null = 追加到末尾）
// 拖拽排序的 dropIdx 是「顶层图标」下标空间，而 apps 是扁平数组（含组内成员），两者需要换算
const topAnchorId = (list: AppEntry[], idx: number | null): number | null => {
  const top = list.filter((a) => !a.groupId)
  if (idx === null || idx >= top.length) return null
  return top[idx].id
}

// 无归属（顶层）条目的合成 id：键盘导航能落到 Dock 末尾的「+」新增按钮上
// 它不属于 apps 列表，用一个负数哨兵 id 表示（nextId 从 0 起单调递增，不会冲突）
const ADD_BTN_ID = -1

// 拖拽边缘自动滚动：进入边缘 60px 内开始滚，越贴边越快（每帧最大 18px ≈ 1080px/s）
const EDGE_ZONE = 60
const EDGE_MAX_SPEED = 18

type DriveInfo = {
  name: string
  label: string
  type: string
  format: string
  total: number
  free: number
  ready: boolean
}

// 字节数格式化（用量条标签与悬停卡片共用）
const fmtSize = (bytes: number): string =>
  bytes >= 1024 ** 4
    ? `${(bytes / 1024 ** 4).toFixed(1)} TB`
    : `${Math.round(bytes / 1024 ** 3)} GB`

// 文件大小格式化（文件夹预览卡片右列：单个文件比磁盘小几个量级，按 B/KB/MB/GB 递进）
const fmtFileSize = (bytes: number): string => {
  if (bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

// 文件夹悬停预览卡片的状态：anchorX = 悬停图标中心的视口 X（卡片按它锚定并钳制在窗口内）
type FolderCardState = {
  path: string
  name: string
  anchorX: number
  /** null = 正在读取（卡片先出现，列表随后填入） */
  data: FolderListing | null
}

// 已用比例（0..1）；容量未知（网络盘/空光驱）返回 0
const usedRatio = (d: DriveInfo): number =>
  d.total > 0 ? Math.min(1, Math.max(0, (d.total - d.free) / d.total)) : 0

// 用量条配色：<70% 主题蓝、70–90% 琥珀、>90% 红
const usageColor = (ratio: number): string =>
  ratio >= 0.9 ? '#e0533d' : ratio >= 0.7 ? '#e0a33d' : '#3a7bd5'

// 驱动器类型的中文说明（卷标为空时显示）
const driveTypeText = (type: string): string =>
  type === 'Network' ? '网络驱动器'
    : type === 'CDRom' ? '光驱'
      : type === 'Removable' ? '可移动磁盘'
        : type === 'Ram' ? '内存盘'
          : '本地磁盘'

// 浮层贴边锚点的兜底值（拿不到 .dock-bg 实测值时用）：玻璃条高 76 + 8px 间隙 = 84，
// 上下两种停靠位置数值相同（浮层都贴在玻璃条外侧 8px）
const PANEL_FALLBACK = 84

// ─── 停靠位置（下 / 上 / 中间 / 左 / 右）──────────────────────────────
// 主进程创建窗口时通过 additionalArguments 传进来（preload 暴露为 window.api.dockEdge）作为
// 初始值；之后**可以在运行中变**——横向三档（下/上/中间）窗口尺寸相同，主进程用
// setBounds + `dock-edge-changed` 事件原地切换（不重建窗口，所以是瞬间的），
// 因此这里必须是 state 而不是模块常量。左/右竖排（尺寸不同）仍走重建窗口。
const EDGE_INITIAL: DockEdge = (window.api && window.api.dockEdge) || 'middle'
// 位置选择器的可选项。左/右竖排是下一阶段接上的部分，先把入口留在这里，
// 等布局与交互（纵向滚动、侧向浮层）都做完了再开启这两项。
// 「中间」= 悬浮在屏幕中央：布局与「下」完全相同（标签在上、浮层在上方），
// 只是窗口不贴边——好处是上下都有空间，悬停放大的幅度不会被屏幕边缘吃掉。
const DOCK_EDGE_CHOICES: { value: DockEdge; label: string }[] = [
  { value: 'middle', label: '中间' },
  { value: 'bottom', label: '下' },
  { value: 'top', label: '上' }
]
// 键盘选中框（蓝框）自动隐藏：停止按方向键/Enter 这么久后就收起（连状态一起退出导航）
const NAV_IDLE_MS = 5000
// 悬停标签钳制时距容器边缘保留的余量：必须大于 CSS 里 .dock-inner 两端溶解遮罩的宽度
// （40px），否则标签会被遮罩淡成半透明
const LABEL_CLAMP_PAD = 48
// 窗口高度（与主进程 createWindow 的 300 一致）。右键菜单不改变窗口尺寸
// 高度上限按这个基准算，超出时内部滚动——避免透明窗口 resize 的白闪
const BASE_WINDOW_H = 300

// ─── 文件夹图标：直接存真实 data URL（v1.12.2 撤掉了哨兵）───────────────────
// v1.12.0 为了省内存/磁盘，把文件夹条目的图标换成了一个短哨兵串，渲染与写盘时再换回
// 模块常量 `sharedFolderIcon`。**这个设计是错的**：`sharedFolderIcon` 只有一个赋值点
// （加载时从磁盘上找一个「带非空图标的文件夹条目」），于是
//   ① 全新机器上 shortcuts.json 不存在 / 没有任何带图标的文件夹条目 → 它一直是空串；
//   ② 唯一给文件夹条目写图标的路径（桌面扫描）又存的是哨兵、把主进程刚提取好的真图标丢了；
// 结果「哨兵 → 空串 → 落盘空串 → 下次加载还是空串」自锁，**首启即永久坏，重启不恢复**。
//
// 现在改成最直白的做法：文件夹条目就存主进程给的那份真实 data URL。
// 代价只是 renderer state 里多 N 份相同字符串（48px 的 PNG 约 2.5KB，几十个文件夹也就
// 几十 KB）——而 v1.12.0 把图标尺寸从 256px 降到 48px 省下的是它的 8 倍，
// 用一个「会自锁成空值」的中间态去省这点内存，完全不划算。
/** 主进程给的共享文件夹图标（一次提取、所有文件夹条目共用同一份）。
 *  只用来**修复**两种情况：历史坏数据（iconDataUrl 为空）与主进程没给图标的扫描结果。
 *  正常情况下根本不需要它 —— 每个条目自己就带着真图标。 */
let sharedFolderIcon = ''

const isFileDragEvent = (e: React.DragEvent): boolean =>
  Array.from(e.dataTransfer?.types ?? []).includes('Files')

// ─── Dock 几何缓存（放大效果 / 落点换算共用的热点）──────────────────────────
// 放大效果原来每个 mousemove 都对**每个**图标调一次 getBoundingClientRect，紧接着又写
// inline transform —— 读-写-读-写交替触发强制同步布局（layout thrashing），图标越多越
// 卡，几十个图标时单帧能到十几毫秒，鼠标移动肉眼可见掉帧。
// 这里改成：布局变化时（apps / 图标增删 / 换停靠边 / 换主题 / 容器尺寸变化）量一次
// 各图标中心点存成数字数组，之后每次鼠标移动只做算术 —— 零次布局读取（除了容器那一次
// getBoundingClientRect，它每帧只调一次且此时没有待处理的样式写入）。
// 走的是「中心点排序数组 + 影响范围」的写法：鼠标只影响左右各 140px 内的图标，
// 落到数组上就是从 lo 到 hi 的一小段，其余元素只在「上一帧被放大过」时才需要复位。
//
// ⚠️ **坐标系是这里唯一的坑（v1.12.1 修）**：容器是横向滚动容器，所以存下来的必须是
// **内容坐标**（= 视口坐标 + scrollLeft），命中也必须换算到同一个坐标系。
// v1.12.0 量的是「相对容器可见左缘」的视口坐标、命中算的却是 `clientX - container.left`
// （内容坐标），两者只在 scrollLeft === 0 时相等 —— 于是 Dock 一旦横向滚动，光标越往后
// （要滚动才能看到的那部分）放大效果就偏到左边 scrollLeft 像素的图标上，表现为
// 「鼠标移到后面的图标，动画却显示在前面的图标上」。Dock 图标多到需要滚动就会踩到。
type DockCenter = { id: number; cx: number; el: HTMLDivElement }

function measureCenters(
  refs: Map<number, HTMLDivElement>,
  container: HTMLElement | null
): DockCenter[] {
  if (!container) return []
  const box = container.getBoundingClientRect()
  const scroll = container.scrollLeft // 换算到内容坐标，详见上方坐标系说明
  const out: DockCenter[] = []
  refs.forEach((el, id) => {
    if (el.dataset.sep) return // 分隔线不参与放大
    const rect = el.getBoundingClientRect()
    out.push({ id, cx: rect.left - box.left + scroll + rect.width / 2, el })
  })
  out.sort((a, b) => a.cx - b.cx)
  return out
}

/** 把某个图标的放大状态落到 DOM 上。用 WeakMap 记住上一次写进去的值，
 *  值没变就完全不动 DOM —— 原来每帧对每个图标无条件写 transform/zIndex，
 *  即使数值与上一帧一模一样也会让浏览器重新做样式解析与合成。 */
const appliedZoom = new WeakMap<HTMLElement, number>()
function applyZoom(el: HTMLElement, scale: number, lift: number): void {
  const prev = appliedZoom.get(el)
  if (prev === scale) return
  if (scale <= 1) {
    el.style.transform = ''
    el.style.zIndex = ''
    appliedZoom.delete(el)
    return
  }
  el.style.transform = `scale(${scale}) translateY(${lift}px)`
  el.style.zIndex = '10'
  appliedZoom.set(el, scale)
}

const MAGNIFY_RANGE = 140
const MAGNIFY_EXTRA = 0.4

function App(): React.ReactElement {
  const [apps, setApps] = useState<AppEntry[]>([])
  // 新增按钮下拉菜单的锚点位置（按钮中心 x + 按钮顶部 y，视口坐标）；null 表示关闭。
  // 菜单渲染在 Dock 滚动容器之外（脱离 overflow 裁剪），否则会被滚动容器的 overflow 裁剪。
  const [menuPos, setMenuPos] = useState<{ cx: number; top: number } | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; appId: number } | null>(null)
  // 右键菜单编辑模式：editingId 非 null 时菜单切换为编辑表单（名称/参数/工作目录/图标）
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editFields, setEditFields] = useState({ description: '', arguments: '', workingDirectory: '' })
  const [editIconUrl, setEditIconUrl] = useState('')
  // 横向滚动边界状态：true 表示该侧还有图标未显示，用于显示渐隐提示
  const [scrollState, setScrollState] = useState({ left: false, right: false })
  // 桌面图标当前是否隐藏（决定菜单项文案「隐藏/显示桌面图标」）
  const [desktopIconsHidden, setDesktopIconsHidden] = useState(false)
  // 开机自启动是否开启（注册表 Run 登录项，菜单打开时从主进程读取）
  const [autoStart, setAutoStart] = useState(false)
  // 主题：黑夜（默认）/ 白天 / 透明（背景全透明，仅图标悬浮桌面），偏好持久化到 localStorage
  const [theme, setTheme] = useState<'dark' | 'light' | 'transparent'>(() => {
    const saved = localStorage.getItem('ql-theme')
    return saved === 'light' || saved === 'transparent' ? saved : 'dark'
  })
  // 停靠位置：横向三档由主进程 setBounds + 事件原地切换（不重建窗口 → 瞬间生效）
  const [edge, setEdge] = useState<DockEdge>(EDGE_INITIAL)
  // 切换停靠位置后用它补一帧渲染，让浮层锚点用新布局重新测量（详见 onDockEdgeChanged 那段）
  const [, setEdgeTick] = useState(0)
  const isTop = edge === 'top'

  useEffect(() => {
    // 主进程原地改了停靠位置：跟着翻布局即可（窗口尺寸没变，不需要重载页面）。
    // 末尾再触发一帧渲染：`data-edge` 是 commit 之后才生效的，而浮层锚点
    // （overlayAnchor 用 getBoundingClientRect 量 .dock-bg）在渲染期就算好了，
    // 不补这一帧的话，切位置那一帧量到的仍是旧布局
    const off = window.api.onDockEdgeChanged((next) => {
      setEdge(next)
      requestAnimationFrame(() => setEdgeTick((n) => n + 1))
    })
    // dockEdge（argv）只是建窗时的快照：页面重载后（dev HMR / Ctrl+R）
    // 主进程可能已经原地切到别的档，这里主动对齐一次
    window.api.getDockEdge().then((cur) => { if (cur) setEdge(cur) }).catch(() => {})
    return off
  }, [])

  const menuRef = useRef<HTMLDivElement>(null)
  const ctxRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const dockBgRef = useRef<HTMLDivElement>(null)
  const dockInnerRef = useRef<HTMLDivElement>(null)
  const addBtnRef = useRef<HTMLDivElement>(null)
  const iconRefs = useRef<Map<number, HTMLDivElement>>(new Map())  // 菜单打开期间用户是否已手动切换过开关：防止过期的异步读取（getAutoStart /
  // getDesktopIconsHidden）覆盖乐观更新的状态（陈旧响应竞态）
  const autoStartDirtyRef = useRef(false)
  const desktopIconsDirtyRef = useRef(false)

  // ─── Custom drag & drop ───────────────────────────────────────────────

  const dragRef = useRef<{ id: number; startX: number; startY: number } | null>(null)
  // 本次交互是否已越过 5px 阈值成为真实拖拽（同步 ref，不依赖 state 时序）
  const dragStartedRef = useRef(false)
  // 拖拽结束后吞掉紧随其后的 click，防止误启动图标
  const suppressClickRef = useRef(false)
  // 上一次「启动条目」的时刻：吸收启动瞬间的连点（Dock 隐藏前用户容易多点几下，
  // 每次点击都会真的 CreateProcess 开一个新实例）
  const lastRunAtRef = useRef(0)
  const [dragId, setDragId] = useState<number | null>(null)
  const [dropIdx, setDropIdx] = useState<number | null>(null)
  // 拖拽中命中的分组图标（高亮提示「松手即归入该组」）
  const [dragOverGroupId, setDragOverGroupId] = useState<number | null>(null)
  // mouseup 需要最新值：放 ref 里，避免把 dropIdx/dragOverGroupId 塞进 effect 依赖
  // 导致拖拽中每个 mousemove 都重挂 window 监听器
  const dropIdxRef = useRef<number | null>(null)
  const dragOverGroupRef = useRef<number | null>(null)

  // ─── 分组（Stack）─────────────────────────────────────────────────────
  // openGroupId 非 null 时在 Dock 上方弹出该分组的面板（迷你 Dock，宽度随内容伸缩
  // 高度固定 —— 所以完全不需要改变窗口尺寸，也就没有透明窗口 resize 的白闪）
  const [openGroupId, setOpenGroupId] = useState<number | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // 面板滚动容器 + 面板内图标的 ref（悬停放大与主 Dock 共用同一套算法）
  const panelInnerRef = useRef<HTMLDivElement>(null)
  const panelIconRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  // 新建分组后需要把 Dock 横向滚到末尾（待 apps 渲染完再执行）
  const scrollDockToEndRef = useRef(false)

  // ─── 文件夹悬停预览卡片 ───────────────────────────────────────────────
  // 与「此电脑」卡片同构：悬停 300ms 弹出全部子项（目录优先/最多 400 项），移开 150ms 后关
  // （宽限期让鼠标能移到卡片上继续滚动查看）。列表秒回、真图标由 folder-icons 事件补齐。
  const [folderCard, setFolderCard] = useState<FolderCardState | null>(null)
  const folderCardTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const folderCardRef = useRef<HTMLDivElement>(null)
  // 卡片水平位置：先按图标中心渲染，测量宽度后在 paint 前钳制进窗口（贴边缘时内收）
  const [folderCardLeft, setFolderCardLeft] = useState<number | null>(null)

  const closeFolderCard = useCallback(() => {
    if (folderCardTimer.current) { clearTimeout(folderCardTimer.current); folderCardTimer.current = null }
    setFolderCard(null)
  }, [])

  // 延迟关闭：鼠标从图标移到卡片上时会先离开图标，给 150ms 宽限（移到卡片即取消）
  const scheduleCloseFolderCard = useCallback(() => {
    if (folderCardTimer.current) clearTimeout(folderCardTimer.current)
    folderCardTimer.current = setTimeout(() => {
      folderCardTimer.current = null
      setFolderCard(null)
    }, 150)
  }, [])

  // openFolderCard 每次渲染都要变（依赖挂载时借来的 apps），但真正需要「新鲜 apps」的
  // 只有卡片打开时的名字兜底一项，所以把它放进 ref 里读——回调本身保持稳定引用，
  // 不会让 handleIconMouseDown 之类的下游 useCallback 每次渲染都失效
  const appsRef = useRef<AppEntry[]>([])
  const openFolderCard = useCallback((app: AppEntry, anchorX: number) => {
    if (folderCardTimer.current) clearTimeout(folderCardTimer.current)
    // 悬停即预取：鼠标刚碰到图标就开始列目录 + 提首批图标（主进程会缓存 5s，
    // 并对着同一目录的在途请求做去重），300ms 后卡片弹出时直接命中缓存
    window.api.listFolder(app.targetPath).catch(() => {})
    folderCardTimer.current = setTimeout(() => {
      folderCardTimer.current = null
      // 拖拽/拖入进行中不弹卡片（会挡住落点指示线）
      if (dragStartedRef.current || fileDragOverRef.current) return
      // 条目可能已经被删除/改名（桌面实时同步、右键编辑）：从最新列表里取，
      // 免得卡片标题停在旧名字上
      const fresh = appsRef.current.find((a) => a.id === app.id) ?? app
      const same = normPath(fresh.targetPath)
      // 同一目录且已加载完：保持内容只更新锚点（鼠标在 150ms 宽限里移出又移回时，
      // 不要清成「读取中」再重新加载——那会闪一下，缓存过期时还要整目录重扫）
      setFolderCard((prev) =>
        prev && prev.data && normPath(prev.path) === same
          ? { ...prev, anchorX }
          : { path: fresh.targetPath, name: fresh.description || fresh.targetPath.split('\\').pop() || '未命名', anchorX, data: null })
      // 无条件再取一次：命中主进程 5s 缓存时几乎零成本，同目录时正好把内容刷新回来
      window.api.listFolder(fresh.targetPath)
        .then((data) => setFolderCard((prev) =>
          (prev && normPath(prev.path) === same ? { ...prev, data } : prev)))
        .catch(() => {})
    }, 300)
  }, [])

  // 图标分批补齐事件：按路径就地替换（卡片已关 / 已换目录 / 本批没有命中项则原样返回）。
  // 每个目录的后台补图标会推好几批（每批 24 个），原来每批都对 400 行做一次
  // Object.entries + normPath + map 建新对象，其中绝大多数条目根本不在本批里 ——
  // 现在先把本批路径与当前卡片对齐（不同目录的批次直接整批丢弃），再只改动命中的几行。
  useEffect(() => window.api.onFolderIcons((p) => {
    setFolderCard((prev) => {
      const data = prev?.data
      if (!data || normPath(data.path) !== normPath(p.path)) return prev
      const icons: Record<string, string> = {}
      for (const [k, v] of Object.entries(p.icons)) icons[normPath(k)] = v
      let changed = false
      const items = data.items.map((it) => {
        const icon = icons[normPath(it.path)]
        if (!icon || icon === it.iconDataUrl) return it
        changed = true
        return { ...it, iconDataUrl: icon }
      })
      if (!changed) return prev // 没有任何一行命中：不产生新对象，React 直接 bail out
      return { ...prev!, data: { ...data, items } }
    })
  }), [])

  useEffect(() => () => {
    if (folderCardTimer.current) clearTimeout(folderCardTimer.current)
  }, [])

  // 卡片宽度测量后钳制水平位置（useLayoutEffect：在 paint 前落位，不会看到跳一下）
  useLayoutEffect(() => {
    const el = folderCardRef.current
    if (!el || !folderCard) return
    const half = el.offsetWidth / 2
    const min = half + 10
    const max = Math.max(min, window.innerWidth - half - 10)
    setFolderCardLeft(Math.min(Math.max(folderCard.anchorX, min), max))
  }, [folderCard])

  // 点卡片里的子项：按资源管理器双击的语义打开（文件夹 → 资源管理器；文件 → 关联程序）。
  // 走 open-path（shell.openPath / ShellExecuteEx），**不能**用 run-app——那条路径用 execFile
  // 直接 CreateProcess，对 .md/.txt/.png 这类非可执行文件必然失败，点了没反应。
  const openFolderChild = (item: FolderChild): void => {
    closeFolderCard()
    window.api.openPath(item.path)
  }

  // ─── 驱动器信息（「此电脑」悬停卡片 + 图标用量条） ─────────────────────
  const [drives, setDrives] = useState<DriveInfo[]>([])
  // 悬停「此电脑」N 毫秒后弹出的盘符卡片；移开（含移出卡片）即关
  const [showDrivesCard, setShowDrivesCard] = useState(false)
  const drivesCardTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadDrives = useCallback(() => {
    window.api.listDrives().then((list) => setDrives(list || [])).catch(() => {})
  }, [])

  // 启动时拉一次，之后每次打开卡片时再刷新（容量变化不常发生，无需轮询）
  useEffect(() => { loadDrives() }, [loadDrives])

  // 三个都用 useCallback 固定引用：它们会被 handleIconMouseDown / handleContextMenu 的
  // useCallback 依赖引用，每次渲染换新函数会让那些回调的缓存失效
  const openDrivesCard = useCallback(() => {
    if (drivesCardTimer.current) clearTimeout(drivesCardTimer.current)
    drivesCardTimer.current = setTimeout(() => {
      drivesCardTimer.current = null
      // 拖拽/拖入进行中不弹卡片（与文件夹卡片同一套守卫，避免卡片在拖动途中冒出来挡落点）
      if (dragStartedRef.current || fileDragOverRef.current) return
      loadDrives() // 打开时刷新，保证数字是当下的
      setShowDrivesCard(true)
    }, 300)
  }, [loadDrives])

  const closeDrivesCard = useCallback(() => {
    if (drivesCardTimer.current) { clearTimeout(drivesCardTimer.current); drivesCardTimer.current = null }
    setShowDrivesCard(false)
  }, [])

  // 延迟关闭：鼠标从图标移到卡片上时会先离开图标，给 150ms 宽限（移到卡片即取消）
  const scheduleCloseDrivesCard = useCallback(() => {
    if (drivesCardTimer.current) clearTimeout(drivesCardTimer.current)
    drivesCardTimer.current = setTimeout(() => {
      drivesCardTimer.current = null
      setShowDrivesCard(false)
    }, 150)
  }, [])

  useEffect(() => () => {
    if (drivesCardTimer.current) clearTimeout(drivesCardTimer.current)
  }, [])

  // 汇总（固定盘 + 移动盘，容量已知的才计入）：图标底部细条与标签数字用它
  const driveSummary = (() => {
    const known = drives.filter((d) => d.total > 0)
    const total = known.reduce((s, d) => s + d.total, 0)
    const free = known.reduce((s, d) => s + d.free, 0)
    return total > 0 ? { total, free, ratio: (total - free) / total } : null
  })()

  // ─── 键盘导航 ─────────────────────────────────────────────────────────
  // navId 非 null 表示处于导航模式：Alt+Space 唤出 Dock 时由主进程通知进入（自动选中
  // 第一个图标）；鼠标按下图标、启动条目、Esc 于主 Dock 层都会退出
  const [navId, setNavId] = useState<number | null>(null)
  // 上次的选中位置（持久化到 localStorage）：启动、Alt+Space 唤出、方向键唤醒都恢复到
  // 这里，而不是每次都跳回第一个图标。null = 还没有记忆，回落到第一个图标
  const navLastRef = useRef<number | null>((() => {
    const raw = localStorage.getItem('ql-nav-last')
    if (raw === null) return null
    const v = Number(raw)
    return Number.isFinite(v) ? v : null
  })())

  // ─── 从资源管理器拖入文件添加 ─────────────────────────────────────────
  // 仅 Dock 栏区域响应（.dock 上挂事件，子元素冒泡上来）；透明区/菜单上不接受
  // 但整窗都拦截默认行为（见下方 document 级 preventDefault），否则 Chromium
  // 会把窗口导航到 file:// 变成白屏
  const [fileDragOver, setFileDragOver] = useState(false)
  // 镜像 ref：rAF 的边缘自动滚动循环里要判断「当前是文件拖入」，不能读 state
  const fileDragOverRef = useRef(false)
  // 拖放结果提示（「已添加 2 个，跳过 1 个」等），2.4s 后自动消失
  const [dropHint, setDropHint] = useState<string | null>(null)
  const dropHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showDropHint = useCallback((msg: string) => {
    if (dropHintTimer.current) clearTimeout(dropHintTimer.current)
    setDropHint(msg)
    dropHintTimer.current = setTimeout(() => {
      dropHintTimer.current = null
      setDropHint(null)
    }, 2400)
  }, [])

  useEffect(() => () => {
    if (dropHintTimer.current) clearTimeout(dropHintTimer.current)
  }, [])

  // 兜底：拖到透明区/菜单上时不让 Chromium 执行「导航到文件」的默认行为（会白屏）
  // 同时把非 Dock 区域的 dropEffect 置 none —— 光标显示「禁止」，明确「只有 Dock 栏能放」
  useEffect(() => {
    const prevent = (e: DragEvent) => {
      e.preventDefault()
      const dock = dockRef.current
      if (e.dataTransfer && !(dock && dock.contains(e.target as Node))) {
        e.dataTransfer.dropEffect = 'none'
      }
    }
    document.addEventListener('dragover', prevent)
    document.addEventListener('drop', prevent)
    return () => {
      document.removeEventListener('dragover', prevent)
      document.removeEventListener('drop', prevent)
    }
  }, [])

  // ─── Dock 几何缓存 ─────────────────────────────────────────────────────
  // 几何在「apps / 主题 / 停靠边 / 面板开关」变化时都会变，但**不能只靠 ResizeObserver**：
  // 图标增删只是改变容器内容的排布，容器的盒子尺寸（clientWidth）不一定变 ——
  // 观察者不会回调，缓存就会留在旧的中心点，表现为「加了图标之后放大效果对不上位置」。
  // 所以用两条失效通道合起来：
  //   ① 显式的 layout effect（apps.length / theme / edge / openGroupId）——确定性失效；
  //   ② ResizeObserver——兜住「尺寸变了但依赖没变」的情况（DPI 缩放、字体、面板撑宽）。
  //
  // 两个实现细节：
  //   * 观察者挂在 **ref 回调**里（useEffect 在 ref 回调之后才跑，挂载那一帧会漏掉）；
  //   * 观察者就绪时**先主动测一次**：ResizeObserver 只在「观察之后尺寸发生变化」时
  //     回调，光挂上去没有初始通知，不补这一刀启动后第一次悬停会没有放大效果。
  const [geometryTick, setGeometryTick] = useState(0)
  const geoSeq = useRef(0)
  const geoObservedSeq = useRef(-1)
  const geoObserver = useRef<ResizeObserver | null>(null)

  const setDockInnerRef = useCallback((el: HTMLDivElement | null) => {
    dockInnerRef.current = el
    geoObserver.current?.disconnect()
    geoObserver.current = null
    if (!el) return
    geoSeq.current += 1
    const ro = new ResizeObserver(() => {
      geoSeq.current += 1
      setGeometryTick(geoSeq.current)
    })
    ro.observe(el)
    geoObserver.current = ro
  }, [])

  // 卸载时断开观察者（StrictMode 双挂载下会重挂，观察者必须自己收掉，否则泄漏）
  useEffect(() => () => { geoObserver.current?.disconnect(); geoObserver.current = null }, [])

  /** 主 Dock 各图标的中心点（按 x 排序）。只在几何真的变了的那一次渲染里重新测量，
   *  其余渲染直接命中 ref 里的缓存 —— 不产生任何布局读取。 */
  const dockCenters = useRef<DockCenter[]>([])
  if (geoObservedSeq.current !== geoSeq.current) {
    geoObservedSeq.current = geoSeq.current
    dockCenters.current = measureCenters(iconRefs.current, dockInnerRef.current)
  }

  // 分组面板的同款缓存：只在「面板刚打开 / 换了分组 / 容器尺寸变了」时量一次。
  // 面板高度固定、宽度最多几百像素，不需要自己的 ResizeObserver。
  const panelCenters = useRef<DockCenter[]>([])
  const panelMeasuredKey = useRef('')
  const panelKey = `${openGroupId}:${geoSeq.current}`
  if (panelMeasuredKey.current !== panelKey) {
    panelMeasuredKey.current = panelKey
    panelCenters.current = measureCenters(panelIconRefs.current, panelInnerRef.current)
  }

  // 显式失效：这些依赖一变就让两处几何缓存全部重建（见上方注释 ①）
  useLayoutEffect(() => {
    geoSeq.current += 1
    setGeometryTick(geoSeq.current)
  }, [apps.length, theme, edge, openGroupId])

  // Calculate which insertion index the cursor is closest to
  // 返回的是「位置」（在渲染出来的顶层图标中排序后的下标），不是数组下标
  // 组内成员不在 Dock 里渲染，所以这里与 topAnchorId 的下标空间一致
  const calcDropIndex = useCallback((clientX: number): number => {
    const centers = dockCenters.current
    const el = dockInnerRef.current
    if (!el) return centers.length
    // 拖拽过程中图标会被放大 1.4×、还要给插入指示线腾位置，中心点与缓存有几像素偏差；
    // 但落点判定本来就只有「最近两个图标之间」的粒度，偏差不影响结果，
    // 而每帧重新量一遍全部图标才是真正的开销来源。
    // `mx` 必须换算到**内容坐标**（与缓存同一坐标系）——漏掉 scrollLeft 会让落点
    // 偏左 scrollLeft 像素，详见文件上方「坐标系是这里唯一的坑」。
    const mx = clientX - el.getBoundingClientRect().left + el.scrollLeft

    // Find where the cursor falls between/around icon centers
    for (let i = 0; i < centers.length; i++) {
      if (mx < centers[i].cx) return i
    }
    return centers.length
  }, [])

  // 横向滚动边界状态（两端渐隐提示）：拖拽自动滚动与键盘导航都会用到，故声明在此处
  const updateScrollState = useCallback(() => {
    const el = dockInnerRef.current
    if (!el) {
      setScrollState({ left: false, right: false })
      return
    }
    setScrollState({
      left: el.scrollLeft > 1,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    })
  }, [])

  // ─── 拖拽到两端自动滚动 ───────────────────────────────────────────────
  // 用 rAF 循环而不是只在 mousemove 里滚：鼠标停在边缘不动时也要「持续」滚动。
  // 速度随贴近程度线性递增；离开边缘区、松手、鼠标移出窗口都会停下。
  const edgeRafRef = useRef<number | null>(null)
  const edgeClientXRef = useRef(0) // 最近一次光标 x（rAF 里据此判定边缘并重算落点）

  const stopEdgeScroll = useCallback(() => {
    if (edgeRafRef.current !== null) {
      cancelAnimationFrame(edgeRafRef.current)
      edgeRafRef.current = null
    }
  }, [])

  // 卸载时收掉可能在跑的自动滚动帧循环（鼠标按着不放时组件被卸载/StrictMode 重挂，
  // 循环会一直排帧直到光标离开边缘区才自停）
  useEffect(() => stopEdgeScroll, [stopEdgeScroll])

  const stepEdgeScroll = useCallback(() => {
    const el = dockInnerRef.current
    if (!el) { edgeRafRef.current = null; return }
    const rect = el.getBoundingClientRect()
    const x = edgeClientXRef.current
    // 左右两侧的贴近程度（0 = 在边缘区外，1 = 贴到边上）。
    // 上下都要钳：光标跑到容器外（比如在 Dock 侧边留白或窗口外）时算出来会 >1，
    // 那样每帧步长就突破 EDGE_MAX_SPEED 的约定上限
    const left = Math.min(1, Math.max(0, 1 - (x - rect.left) / EDGE_ZONE))
    const right = Math.min(1, Math.max(0, 1 - (rect.right - x) / EDGE_ZONE))
    const strength = Math.max(left, right)
    if (strength <= 0) { edgeRafRef.current = null; return } // 已离开边缘区：停

    const before = el.scrollLeft
    el.scrollLeft = before + (right > left ? 1 : -1) * Math.ceil(strength * EDGE_MAX_SPEED)
    if (el.scrollLeft !== before) {
      updateScrollState()
      // 图标在光标下方移动了，落点要跟着重算（图标拖拽与拖入文件都适用）
      if (dragStartedRef.current || fileDragOverRef.current) {
        const idx = calcDropIndex(x)
        dropIdxRef.current = idx
        setDropIdx(idx)
      }
    }
    edgeRafRef.current = requestAnimationFrame(stepEdgeScroll)
  }, [calcDropIndex, updateScrollState])

  // 记录光标并确保循环在跑（已在跑则不重复启动）
  const pumpEdgeScroll = useCallback((clientX: number) => {
    edgeClientXRef.current = clientX
    if (edgeRafRef.current === null) edgeRafRef.current = requestAnimationFrame(stepEdgeScroll)
  }, [stepEdgeScroll])

  // 命中测试：坐标落在哪个「分组图标」上（排除被拖拽项自身；分组不能嵌套）
  const hitTestGroup = useCallback((x: number, y: number, excludeId: number): number | null => {
    for (const [id, el] of iconRefs.current) {
      if (id === excludeId) continue
      const app = appsRef.current.find((a) => a.id === id)
      if (!app?.isGroup) continue
      const r = el.getBoundingClientRect()
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return id
    }
    return null
  }, [])

  // Global mouseup to finalize drop (fires even outside the window)
  useEffect(() => {
    const handleMouseUp = (e: MouseEvent) => {
      const drag = dragRef.current
      dragRef.current = null
      if (!drag) return

      // 真实拖拽结束时，吞掉紧随其后的 click——click 在 mouseup 之后派发，
      // 此时 setDragId(null) 已生效，handleRun 的 dragId 判断不再可靠
      const wasDrag = dragStartedRef.current
      dragStartedRef.current = false
      if (wasDrag) suppressClickRef.current = true

      const draggedId = drag.id
      const overGroup = dragOverGroupRef.current
      const target = dropIdxRef.current
      // 「从面板拖出」必须在 Dock 区域内松手才算数：否则面板内的小幅拖动会把条目误踢出分组
      const dockRect = dockRef.current?.getBoundingClientRect()
      const inDockBand = !!dockRect && e.clientY >= dockRect.top && e.clientY <= dockRect.bottom

      setDragId(null)
      setDropIdx(null)
      setDragOverGroupId(null)
      dropIdxRef.current = null
      dragOverGroupRef.current = null
      stopEdgeScroll() // 拖拽结束：停掉边缘自动滚动
      if (!wasDrag) return

      setApps((prev) => {
        const from = prev.findIndex((a) => a.id === draggedId)
        if (from === -1) return prev
        const item = prev[from]

        // 1) 拖到分组图标上 → 归入该组（分组本身不参与归组）
        const groupOk =
          overGroup !== null && !item.isGroup && prev.some((a) => a.id === overGroup && a.isGroup)
        if (groupOk) {
          if (item.groupId === overGroup) return prev
          const without = prev.filter((a) => a.id !== draggedId)
          const gi = without.findIndex((a) => a.id === overGroup)
          // 插到该组现有成员之后，维持「成员紧跟在分组条目后面」的数组形态
          let at = gi + 1
          while (at < without.length && without[at].groupId === overGroup) at++
          return [...without.slice(0, at), { ...item, groupId: overGroup }, ...without.slice(at)]
        }

        // 2) 组内成员拖到 Dock 上 → 移出分组并落到落点（面板内松手则取消）
        if (item.groupId !== undefined) {
          if (!inDockBand) return prev
          const without = prev.filter((a) => a.id !== draggedId)
          const anchor = topAnchorId(without, target)
          const at = anchor === null ? without.length : without.findIndex((a) => a.id === anchor)
          const cleared = { ...item }
          delete cleared.groupId
          return [...without.slice(0, at), cleared, ...without.slice(at)]
        }

        // 3) 顶层条目重排（dropIdx 为顶层图标下标空间）
        if (target === null) return prev
        const anchor = topAnchorId(prev, target)
        if (anchor === draggedId) return prev
        const without = prev.filter((a) => a.id !== draggedId)
        if (anchor === null) return [...without, item]
        const at = without.findIndex((a) => a.id === anchor)
        return [...without.slice(0, at), item, ...without.slice(at)]
      })
    }

    const handleMouseMove = (e: MouseEvent) => {
      const drag = dragRef.current
      if (!drag) return
      // Start dragging after 5px threshold
      const dx = e.clientX - drag.startX
      const dy = e.clientY - drag.startY
      if (!dragStartedRef.current && Math.abs(dx) < 5 && Math.abs(dy) < 5) return

      if (!dragStartedRef.current) {
        dragStartedRef.current = true
        setDragId(drag.id)
      }
      // 悬停在分组图标上 → 高亮该组并隐藏插入线（松手即归组）
      const dragged = appsRef.current.find((a) => a.id === drag.id)
      const over = dragged && !dragged.isGroup ? hitTestGroup(e.clientX, e.clientY, drag.id) : null
      dragOverGroupRef.current = over
      setDragOverGroupId(over)
      const idx = over === null ? calcDropIndex(e.clientX) : null
      dropIdxRef.current = idx
      setDropIdx(idx)
      // 拖到两端自动滚动（鼠标停在边缘不动时也持续滚）
      if (over === null) pumpEdgeScroll(e.clientX)
      else stopEdgeScroll()
    }

    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseleave', stopEdgeScroll)
    return () => {
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseleave', stopEdgeScroll)
    }
  }, [calcDropIndex, hitTestGroup, pumpEdgeScroll, stopEdgeScroll])

  const handleIconMouseDown = useCallback((e: React.MouseEvent, id: number) => {
    if (e.button !== 0) return // left-click only
    dragRef.current = { id, startX: e.clientX, startY: e.clientY }
    // 新交互开始，清除上一次拖拽遗留的 click 抑制标记，避免误吞本次点击
    suppressClickRef.current = false
    // 鼠标接管 → 退出键盘导航
    setNavId(null)
    // 盘符卡片与文件夹卡片都是只读浮层：一旦开始操作就收起。
    // 必须用 closeDrivesCard（而不是 setShowDrivesCard(false)）——它还会清掉那支
    // 300ms 的「悬停开卡片」计时器，否则卡片会在按下鼠标后自己弹出来
    closeDrivesCard()
    closeFolderCard()
  }, [closeDrivesCard, closeFolderCard])

  // Close menus when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuPos(null)
      }
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // ─── 鼠标移出菜单区域时自动关闭（无需点击）─────────────────────────
  // 命中检测基于元素 DOM 包含关系：鼠标不在菜单（或下拉菜单宿主 + 按钮）区域内，
  // 延迟 120ms 后关闭；期间移回则取消。鼠标移出窗口立即关闭。
  //
  // menuHoveredRef：必须先真正进过菜单，才启用「移出即关」。右键菜单的底边锚在
  // Dock 栏上方，右键瞬间鼠标还停在图标上（离菜单几十像素），若一上来就判定，
  // 手稍慢菜单就被关掉——表现为「Dock 闪一下、菜单不出现」
  // 有了这道门控，移出就无需再留缓冲：鼠标一离开菜单立即关闭（分组面板同帧显示回来，
  // 不会出现「菜单还压在面板上」的空档）
  const menuHoveredRef = useRef(false)
  // 进入菜单的时刻：刚进菜单就移出（掠过底角/边缘）不应判定为「用户要离开」
  // 150ms 内不关，之后才启用「移出即关」
  const menuEnteredAtRef = useRef(0)
  useEffect(() => {
    menuHoveredRef.current = false
    menuEnteredAtRef.current = 0
  }, [menuPos, contextMenu])

  useEffect(() => {
    if (!menuPos && !contextMenu) return
    const closeMenus = () => {
      setMenuPos(null)
      setContextMenu(null)
    }
    // elementFromPoint 会强制一次样式/布局计算，而 mousemove 一秒能来几百条
    // （高刷鼠标/触控板），每条都算一次纯属浪费。用 rAF 合并成「每帧最多判定一次」，
    // 判定结果与逐条处理完全一致（关不关菜单只取决于光标当下在哪）。
    let raf = 0
    let last: MouseEvent | null = null
    const evaluate = () => {
      raf = 0
      const e = last
      last = null
      if (!e) return
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const inMenu = menuRef.current ? menuRef.current.contains(el) : false
      // 鼠标停在「添加」按钮上也保持菜单打开
      const inBtn = addBtnRef.current ? addBtnRef.current.contains(el) : false
      const inCtx = ctxRef.current ? ctxRef.current.contains(el) : false
      if (inMenu || inBtn || inCtx) {
        // 只有真正进过「菜单本体」才算 hovered；停在「+」按钮上不算 —— 从按钮到菜单
        // 之间还有一段路要走，若在按钮上就置位，鼠标一离开按钮立即被判定为「离开菜单」
        // 而秒关（表现为「鼠标刚离开 + 按钮，菜单立马消失」）
        if (inMenu || inCtx) {
          if (!menuHoveredRef.current) menuEnteredAtRef.current = Date.now()
          menuHoveredRef.current = true
        }
        return
      }
      // 进过菜单之后，鼠标一移出就立即关闭；两个例外：
      // 1) 刚进菜单 150ms 内的「掠过」不算离开；
      // 2) 菜单外扩 24px 的宽容区 —— 从图标移向菜单时要掠过菜单底角/边缘，
      //    贴着菜单走不算离开，避免半路被关掉（表现为「鼠标刚离开图标菜单就没了」）
      if (menuHoveredRef.current && Date.now() - menuEnteredAtRef.current > 150) {
        const near = (node: HTMLElement | null): boolean => {
          if (!node) return false
          const r = node.getBoundingClientRect()
          const m = 24
          return e.clientX >= r.left - m && e.clientX <= r.right + m &&
            e.clientY >= r.top - m && e.clientY <= r.bottom + m
        }
        if (!near(ctxRef.current) && !near(menuRef.current)) closeMenus()
      }
    }
    const handleMouseMove = (e: MouseEvent) => {
      last = e
      if (raf === 0) raf = requestAnimationFrame(evaluate)
    }
    const handleWindowLeave = () => {
      last = null
      if (raf !== 0) { cancelAnimationFrame(raf); raf = 0 }
      closeMenus()
    }
    document.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseleave', handleWindowLeave)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseleave', handleWindowLeave)
      if (raf !== 0) cancelAnimationFrame(raf)
    }
  }, [menuPos, contextMenu])

  // ─── Dock magnification（主 Dock 与分组面板共用：面板就是迷你 Dock） ───
  // 几何来自 measureCenters 的缓存（见文件上方「Dock 几何缓存」），每次鼠标移动只做
  // 算术：先二分定位光标落在中心点数组的哪一格，再只遍历左右各 140px 内的那一小段
  // （升序数组上就是从 lo 到 hi 的连续区间），区间外只有「上一帧刚被放大过」的元素
  // 才需要复位。整体是一次容器布局读取 + 少量样式写入，不再逐图标读写交替。

  /** 镜像 navId 供 mousemove 回调判断：鼠标一动就收起键盘选中框，但不想为了读一个
   *  布尔量把 navId 塞进回调依赖（那会让整套 window 监听在每次导航变化时重挂）。 */
  const navIdRef = useRef<number | null>(null)
  navIdRef.current = navId

  /** 上一次放大过的元素（只有它们可能需要复位，避免每帧遍历全部图标） */
  const magnified = useRef<Set<HTMLElement>>(new Set())

  const magnifyAt = useCallback((container: HTMLElement | null, centers: DockCenter[], clientX: number) => {
    const active = magnified.current
    if (!container || centers.length === 0) {
      active.forEach((el) => applyZoom(el, 1, 0))
      active.clear()
      return
    }
    // 光标同样换算到**内容坐标**：`centers` 存的是内容坐标，直接拿
    // `clientX - container.left` 比会在容器滚动后整体偏左 scrollLeft 像素
    // （详见文件上方「坐标系是这里唯一的坑」）
    const mx = clientX - container.getBoundingClientRect().left + container.scrollLeft

    // 升序中心点里找第一个 >= mx 的位置（二分：几十个图标也别线性扫）
    let lo = 0
    let hi = centers.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (centers[mid].cx < mx) lo = mid + 1
      else hi = mid
    }
    let start = lo
    while (start > 0 && mx - centers[start - 1].cx < MAGNIFY_RANGE) start--
    const next = new Set<HTMLElement>()
    for (let i = start; i < centers.length; i++) {
      const { cx, el } = centers[i]
      const dist = Math.abs(mx - cx)
      if (dist >= MAGNIFY_RANGE) break
      const s = 1 + (1 - dist / MAGNIFY_RANGE) * MAGNIFY_EXTRA
      // 上浮方向朝 Dock 外侧：底部 Dock 向上顶出玻璃条，顶部 Dock 向下顶出
      const liftRange = MAGNIFY_RANGE * 0.6
      const lift = dist < liftRange ? (1 - dist / liftRange) * 8 : 0
      applyZoom(el, s, isTop ? lift : -lift)
      next.add(el)
    }
    // 上一帧放大、这一帧不在范围内的图标复位
    active.forEach((el) => { if (!next.has(el)) applyZoom(el, 1, 0) })
    magnified.current = next
  }, [isTop])

  const clearMagnify = useCallback(() => {
    magnified.current.forEach((el) => applyZoom(el, 1, 0))
    magnified.current.clear()
  }, [])

  const handleDockMouseMove = useCallback((e: React.MouseEvent) => {
    // 鼠标一动就说明改用鼠标了：收起键盘选中框（看不见的选中项不该还能被 Enter 启动）。
    // 用 ref 判断，避免每次移动都调一次 setNavId —— 那会让整个 App（含全部图标与
    // 面板成员）跟着重渲染，是鼠标划过 Dock 时最大的一笔渲染开销。
    if (navIdRef.current !== null) setNavId(null)
    if (dragId !== null) return // disable magnification during drag
    magnifyAt(dockInnerRef.current, dockCenters.current, e.clientX)
  }, [dragId, magnifyAt])

  // 悬停标签横向钳制：标签是绝对定位居中悬浮在图标上方（完整显示不截断），靠边的图标
  // 会让标签伸出滚动容器、被 overflow 裁掉半截（「此电脑」的「此电脑 · 可用 …」就是如此）。
  // 悬停时量一次标签宽度，把溢出的部分用 --label-shift 推回来（CSS 里并入 translateX）。
  //
  // 两个坑：
  //  ① 悬停时图标已被放大（magnify 给 .dock-item 设了 scale），量到的矩形与写回的位移
  //     不在同一坐标系——写回的位移还会被父级 scale 再乘一次，所以要除以当前缩放。
  //  ② 钳制余量必须大于滚动容器两端遮罩（mask-image 的溶解区）宽度，否则标签正好落在
  //     渐隐区内，药丸会被淡成半透明。
  const clampDockLabel = useCallback((itemEl: HTMLElement | null) => {
    const label = itemEl?.querySelector<HTMLElement>('.dock-label')
    if (!label || !itemEl) return
    label.style.setProperty('--label-shift', '0px') // 先归零再量，否则会累积上一次的偏移
    const box = (itemEl.closest('.dock-inner') ?? itemEl.closest('.group-panel-inner'))
      ?.getBoundingClientRect()
    if (!box) return
    const r = label.getBoundingClientRect()
    // 用布局宽度换算当前缩放（offsetWidth 不受 transform 影响，比解析 transform 字符串可靠）
    const scale = itemEl.offsetWidth > 0 ? itemEl.getBoundingClientRect().width / itemEl.offsetWidth : 1
    const pad = LABEL_CLAMP_PAD
    let shift = 0
    if (r.left < box.left + pad) shift = (box.left + pad - r.left) / (scale || 1)
    else if (r.right > box.right - pad) shift = (box.right - pad - r.right) / (scale || 1)
    if (shift) label.style.setProperty('--label-shift', `${Math.round(shift)}px`)
  }, [])

  const handleDockMouseLeave = useCallback(() => {
    clearMagnify()
  }, [clearMagnify])

  const handlePanelMouseMove = useCallback((e: React.MouseEvent) => {
    // 与主 Dock 一致：鼠标接管就收起键盘选中框（同样先用 ref 拦一道，避免无谓重渲染）
    if (navIdRef.current !== null) setNavId(null)
    if (dragId !== null) return
    magnifyAt(panelInnerRef.current, panelCenters.current, e.clientX)
  }, [dragId, magnifyAt])

  const handlePanelMouseLeave = useCallback(() => {
    clearMagnify()
  }, [clearMagnify])

  // ─── Horizontal scroll (icon overflow) ──────────────────────────────
  // 图标超过 Dock 宽度时，滚动容器横向滚动，滚轮 / 触控板左右滑动查看。
  // 两端渐隐遮罩提示还有更多图标（可滚动的那一侧显示）。
  // 注：updateScrollState 声明在 calcDropIndex 之后（拖拽自动滚动也要用它）。

  // 必须用原生非被动监听：React 在 root 容器上以 `{ passive: true }` 注册 wheel
  // 在 onWheel 里调 preventDefault 是空操作（DevTools 还会报 passive 警告）
  useEffect(() => {
    const el = dockInnerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      // 取位移较大的轴，避免触控板斜向滚动时 deltaY+deltaX 双倍位移
      el.scrollLeft += Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // ─── 拖入文件添加（仅 Dock 栏区域响应） ───────────────────────────────

  const handleDockDragOver = (e: React.DragEvent) => {
    if (!isFileDragEvent(e)) return
    // 必须 preventDefault：否则浏览器不把这里当有效放置目标，drop 事件不会派发
    e.preventDefault()
    // 固定 'copy'，不要改成 'move'：Windows/OLE 拖放里 MOVE 的语义是「文件已被移走」，
    // 源（资源管理器）据此可能删除原文件；而本应用只读路径、不搬运文件
    e.dataTransfer.dropEffect = 'copy'
    if (!fileDragOver) setFileDragOver(true)
    if (!fileDragOverRef.current) fileDragOverRef.current = true
    // 落点指示线复用拖拽排序的 dropIdx（与内部拖拽不会同时发生）
    setDropIdx(calcDropIndex(e.clientX))
    pumpEdgeScroll(e.clientX) // 拖到两端同样自动滚动
  }

  const handleDockDragLeave = (e: React.DragEvent) => {
    if (!isFileDragEvent(e)) return
    // 在 Dock 内部子元素之间移动也会触发 dragleave，relatedTarget 仍在 Dock 内则忽略
    const next = e.relatedTarget as Node | null
    if (next && e.currentTarget.contains(next)) return
    fileDragOverRef.current = false
    setFileDragOver(false)
    setDropIdx(null)
    stopEdgeScroll()
  }

  const handleDockDrop = async (e: React.DragEvent) => {
    if (!isFileDragEvent(e)) return
    e.preventDefault()
    const at = calcDropIndex(e.clientX)
    fileDragOverRef.current = false
    setFileDragOver(false)
    setDropIdx(null)
    stopEdgeScroll()

    // Electron 32+ 移除了 File.path，路径只能由 preload 的 webUtils.getPathForFile 提供
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.api.getPathForFile(f))
      .filter((p) => !!p)
    if (paths.length === 0) {
      showDropHint('未能识别文件路径，添加失败')
      return
    }

    const result = await window.api.describePaths(paths).catch(() => null)
    if (!result) {
      showDropHint('解析失败，未添加')
      return
    }

    // 去重：已在 Dock 里的路径跳过（系统位置的 shell: 命令同样参与比较）
    const known = new Set(apps.map((a) => normPath(a.targetPath)))
    const accepted = result.accepted.filter((a) => !known.has(normPath(a.targetPath)))
    const skipped = paths.length - accepted.length

    if (accepted.length === 0) {
      showDropHint(`已跳过 ${skipped} 个（重复或格式不支持）`)
      return
    }

    // id 在 updater 外分配（StrictMode 双调用 updater 时无副作用）
    const entries: AppEntry[] = accepted.map((a) => ({
      id: nextId++,
      iconDataUrl: a.iconDataUrl,
      targetPath: a.targetPath,
      arguments: a.arguments,
      workingDirectory: a.workingDirectory,
      description: a.description
    }))
    setApps((prev) => {
      // 防御：与桌面扫描合并等并行变更竞态时按路径再过滤一次
      const have = new Set(prev.map((a) => normPath(a.targetPath)))
      const add = entries.filter((x) => !have.has(normPath(x.targetPath)))
      if (add.length === 0) return prev
      // calcDropIndex 给的是「顶层图标」下标（iconRefs 里只有顶层条目+分隔线），
      // 不能直接当扁平数组下标用——否则存在分组成员时插入位置会偏（落在分组之前），
      // 还会把顶层条目插进「成员紧跟分组」的区块中间。用锚点换算（与拖拽重排一致）。
      const anchor = topAnchorId(prev, at)
      if (anchor === null) return [...prev, ...add]
      const pos = prev.findIndex((a) => a.id === anchor)
      if (pos === -1) return [...prev, ...add]
      return [...prev.slice(0, pos), ...add, ...prev.slice(pos)]
    })
    showDropHint(skipped > 0 ? `已添加 ${accepted.length} 个，跳过 ${skipped} 个` : `已添加 ${accepted.length} 个`)
  }

  // ─── Add handlers ─────────────────────────────────────────────────────

  // 打开/关闭新增菜单，记录「添加」按钮的视口坐标作为菜单锚点
  const handleAddToggle = useCallback(() => {
    if (menuPos) {
      setMenuPos(null)
      return
    }
    const btn = addBtnRef.current
    if (!btn) return
    const rect = btn.getBoundingClientRect()
    setMenuPos({ cx: rect.left + rect.width / 2, top: rect.top })
    // 菜单打开时退出键盘导航（与右键菜单同理）：否则选中框被菜单盖住，
    // 按 Enter 会启动那个看不见的选中项
    setNavId(null)
    // 打开菜单时重置脏标记并同步状态（决定菜单项文案/开关）；若用户随后抢先点击，
    // 过期的读取结果会被脏标记拦截，不覆盖乐观更新
    autoStartDirtyRef.current = false
    desktopIconsDirtyRef.current = false
    window.api.getDesktopIconsHidden().then((v) => {
      if (!desktopIconsDirtyRef.current) setDesktopIconsHidden(v)
    }).catch(() => {})
    window.api.getAutoStart().then((v) => {
      if (!autoStartDirtyRef.current) setAutoStart(v)
    }).catch(() => {})
  }, [menuPos])

  // 切换桌面图标显隐（乐观更新：点击立即切换菜单文案，IPC 结果再校正）
  const handleToggleDesktopIcons = () => {
    const target = !desktopIconsHidden
    desktopIconsDirtyRef.current = true
    setDesktopIconsHidden(target)
    setMenuPos(null)
    window.api
      .toggleDesktopIcons()
      .then((next) => {
        if (next !== target) setDesktopIconsHidden(next)
      })
      .catch((err) => {
        console.error('[desktop-icons] toggle failed:', err)
        setDesktopIconsHidden(!target)
      })
  }

  // 切换主题（黑夜 → 白天 → 透明 → 黑夜 循环，偏好持久化到 localStorage）
  const applyTheme = (next: 'dark' | 'light' | 'transparent') => {
    localStorage.setItem('ql-theme', next)
    setTheme(next)
  }
  // 毛玻璃态下记忆所选子主题（黑夜/白天）：切去透明再切回时保持原选择
  const [glassPlan, setGlassPlan] = useState<'dark' | 'light'>(() =>
    localStorage.getItem('ql-theme') === 'light' ? 'light' : 'dark'
  )
  // 嵌套选择器选主题：菜单保持打开，可连续切换预览
  const handleThemePick = (next: 'dark' | 'light' | 'transparent') => {
    if (next === 'transparent') {
      applyTheme('transparent')
      return
    }
    setGlassPlan(next)
    applyTheme(next)
  }

  // 切换停靠位置：交给主进程「原地」应用（横向三档窗口尺寸相同 → setBounds + 事件翻布局，
  // 不重建窗口、不重载页面，约 60ms 生效；将来左/右竖排换了窗口形状才会走重建）。
  // 位置只由预设决定，所以这里不做短路，具体怎么切由主进程判断。
  const handleEdgePick = (next: DockEdge) => {
    setMenuPos(null)
    setContextMenu(null)
    window.api.setDockEdge(next).catch(() => {})
  }

  // 切换开机自启动（乐观更新：先切开关，IPC 返回后校正；写注册表 Run 登录项）。
  // 注意：与其他菜单项不同，这里**不关闭菜单**——开关类控件切换后菜单保持打开，
  // 用户可立即看到状态翻转并连续切换（与系统设置中的开关交互一致）。
  const handleToggleAutoStart = () => {
    const target = !autoStart
    autoStartDirtyRef.current = true
    setAutoStart(target)
    window.api
      .setAutoStart(target)
      .then((next) => {
        if (next !== target) setAutoStart(next)
      })
      .catch((err) => {
        console.error('[auto-start] toggle failed:', err)
        setAutoStart(!target)
      })
  }

  // 添加快捷方式：支持一次多选（Windows 对话框 multiSelections），逐个生成条目
  const handleAdd = async () => {
    setMenuPos(null)
    try {
      const shortcuts = await window.api.parseLnk()
      if (shortcuts && shortcuts.length > 0) {
        // id 在 updater 外分配（StrictMode 双调用 updater 时无副作用）
        const entries = shortcuts.map((r) => ({
          id: nextId++,
          iconDataUrl: r.iconDataUrl,
          targetPath: r.targetPath,
          arguments: r.arguments,
          workingDirectory: r.workingDirectory,
          description: r.description
        }))
        setApps((prev) => [...prev, ...entries])
      }
    } catch { /* ignore */ }
  }

  // 添加文件夹：支持一次多选（Windows 对话框 multiSelections），逐个生成条目
  const handleAddFolder = async () => {
    setMenuPos(null)
    try {
      const folders = await window.api.selectFolder()
      if (folders && folders.length > 0) {
        const entries = folders.map((r) => ({
          id: nextId++,
          iconDataUrl: r.iconDataUrl,
          targetPath: r.path,
          arguments: '',
          workingDirectory: '',
          description: r.name,
          isFolder: true
        }))
        setApps((prev) => [...prev, ...entries])
      }
    } catch { /* ignore */ }
  }

  // ─── Run / context menu ───────────────────────────────────────────────

  // 收起分组面板：只置空 openGroupId（面板是固定高度的迷你 Dock，不涉及窗口尺寸）。
  // 另外：面板收起后若导航选中项还停在组内成员上，选中框会无处渲染（← 也会变死键），
  // 所以把「停在成员上」的选中一并复位。导航自己的 Esc / ← 走的是直接 setOpenGroupId
  // 并把选中显式移回分组图标，不经过这里，行为不受影响。
  const closeGroupPanel = useCallback(() => {
    setOpenGroupId(null)
    setNavId((cur) => {
      if (cur === null || cur === ADD_BTN_ID) return cur
      const hit = appsRef.current.find((a) => a.id === cur)
      return hit && hit.groupId !== undefined ? null : cur
    })
  }, [])

  const handleRun = useCallback((app: AppEntry) => {
    // 拖拽进行中，禁止点击启动
    if (dragId !== null) return
    // 拖拽刚结束（mouseup 后的 click）：吞掉本次点击，避免误启动
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    // 分组条目：点击切换面板展开/收起，不启动
    if (app.isGroup) {
      if (openGroupId === app.id) closeGroupPanel()
      else setOpenGroupId(app.id)
      return
    }
    // 分隔符：不启动任何东西（点击/Enter 均无效）
    if (app.isSeparator) return
    // 防连点：启动是「先隐藏 Dock 再 CreateProcess」，Dock 隐藏前用户很可能又点了两下，
    // 那会真的把程序开成三份。用一个短窗口吸收这段时间内的重复点击。
    const now = Date.now()
    if (now - lastRunAtRef.current < 700) return
    lastRunAtRef.current = now
    // 失败时给一句提示：主进程会把 Dock 显示回来（见 restoreDockAfterFailedLaunch），
    // 用户看到 Dock 回来却没有任何说明，会以为是「点了没反应」
    window.api.runApp(app.targetPath, app.arguments, app.workingDirectory)
      .then((ok) => { if (ok === false) showDropHint('启动失败：目标不存在或无法运行') })
      .catch(() => showDropHint('启动失败：目标不存在或无法运行'))
  }, [dragId, openGroupId, closeGroupPanel, showDropHint])

  // 右键条目：stopPropagation 防止冒泡到 .dock 的空白区菜单（否则两个菜单状态互相覆盖）
  const handleContextMenu = (e: React.MouseEvent, id: number) => {
    e.preventDefault()
    e.stopPropagation()
    setEditingId(null)
    // 菜单打开时退出键盘导航：否则「选中框」还在（只是被菜单遮住/浮层盖住），
    // 此时按 Enter 会启动那个看不见的选中项
    setNavId(null)
    // 与右键菜单互斥（closeDrivesCard 会一并清掉悬停开卡片的计时器，否则卡片会在
    // 右键菜单弹出后自己冒出来）
    closeDrivesCard()
    closeFolderCard()
    setContextMenu({ x: e.clientX, y: e.clientY, appId: id })
  }

  // 右键 Dock 空白处：不做任何事（分组用图标右键菜单的「新建分组」创建）

  // 打开编辑表单：填入当前条目字段（名称/参数/工作目录/图标）
  const handleEdit = (app: AppEntry) => {
    setEditFields({
      description: app.description,
      arguments: app.arguments,
      workingDirectory: app.workingDirectory
    })
    setEditIconUrl(app.iconDataUrl)
    setEditingId(app.id)
  }

  // 更换图标：系统对话框选择 exe/dll/ico/png → 主进程提取图标 → 表单内预览
  const handlePickIcon = async () => {
    try {
      const picked = await window.api.pickIcon()
      if (picked && picked.iconDataUrl) setEditIconUrl(picked.iconDataUrl)
    } catch { /* ignore */ }
  }

  const handleSaveEdit = () => {
    if (editingId === null) return
    const id = editingId
    setApps((prev) => prev.map((a) =>
      a.id === id
        ? {
            ...a,
            description: editFields.description.trim() || a.description,
            arguments: editFields.arguments,
            workingDirectory: editFields.workingDirectory,
            iconDataUrl: editIconUrl || a.iconDataUrl
          }
        : a
    ))
    setEditingId(null)
    setContextMenu(null)
  }

  const handleCancelEdit = () => setEditingId(null)

  const handleDelete = (id: number) => {
    setContextMenu(null)
    setApps((prev) => prev.filter((a) => a.id !== id))
  }

  // ─── 分组（Stack）：新建 / 解散 / 面板尺寸 ─────────────────────────────

  // 新建分组：空组追加到 Dock 末尾，并横向滚动到末尾让新分组可见
  // 不自动展开面板——面板会占满 Dock 上方，反而挡住刚建好（且滚出可视区）的分组图标
  const handleCreateGroup = () => {
    setContextMenu(null)
    setMenuPos(null)
    const id = nextId++ // id 在 updater 外分配（StrictMode 双调用 updater 时无副作用）
    setApps((prev) => [
      ...prev,
      {
        id,
        iconDataUrl: '',
        targetPath: '',
        arguments: '',
        workingDirectory: '',
        description: `分组 ${prev.filter((a) => a.isGroup).length + 1}`,
        isGroup: true
      }
    ])
    scrollDockToEndRef.current = true
    showDropHint('已新建分组：把图标拖到分组图标上即可加入')
  }

  // 解散分组：成员回到顶层（保持在原相对位置），分组条目本身移除
  const handleDissolveGroup = (groupId: number) => {
    setContextMenu(null)
    closeGroupPanel()
    setApps((prev) =>
      prev
        .filter((a) => a.id !== groupId)
        .map((a) => {
          if (a.groupId !== groupId) return a
          const cleared = { ...a }
          delete cleared.groupId
          return cleared
        })
    )
  }

  // 浮层贴边锚点：分组面板 / 右键菜单 / 两种卡片都贴在 Dock 毛玻璃条外侧 8px。
  // 底部 Dock 用 overlayBottom（距窗口底边），顶部 Dock 用 overlayTop（距窗口顶边）——
  // 都用实测的 .dock-bg 位置算，布局改动后自动跟随
  const overlayBottom = useCallback(() => {
    const barTop = dockBgRef.current?.getBoundingClientRect().top
    return barTop === undefined ? PANEL_FALLBACK : window.innerHeight - barTop + 8
  }, [])

  const overlayTop = useCallback(() => {
    const barBottom = dockBgRef.current?.getBoundingClientRect().bottom
    return barBottom === undefined ? PANEL_FALLBACK : barBottom + 8
  }, [])

  // 面板滚轮 → 横向滚动（与主 Dock 一致：原生非被动监听，否则 preventDefault 无效）
  useEffect(() => {
    const el = panelInnerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      el.scrollLeft += Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [openGroupId])

  // 面板关闭路径：分组被删 / Esc / 点击别处 / 鼠标移出窗口 / 窗口失焦
  useEffect(() => {
    if (openGroupId === null) return
    const onKeyDown = (e: KeyboardEvent) => {
      // 导航模式下 Esc 由键盘导航接管（返回主 Dock 而不是直接收起面板）
      if (e.key === 'Escape' && navId === null) closeGroupPanel()
    }
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (panelRef.current?.contains(t)) return
      // 分组图标自身的点击由 handleRun 切换，不算「点击别处」
      if (iconRefs.current.get(openGroupId)?.contains(t)) return
      closeGroupPanel()
    }
    const onLeave = () => closeGroupPanel()
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mouseleave', onLeave)
    window.addEventListener('blur', onLeave)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mouseleave', onLeave)
      window.removeEventListener('blur', onLeave)
    }
  }, [openGroupId, closeGroupPanel, navId])

  // 打开中的分组被删除（如解散、右键删除）时收起面板
  useEffect(() => {
    if (openGroupId !== null && !apps.some((a) => a.id === openGroupId)) closeGroupPanel()
  }, [apps, openGroupId, closeGroupPanel])

  // ─── 键盘导航（Alt+Space 唤出 Dock → 进入导航模式） ────────────────────
  // 选中项 navId 可以在主 Dock，也可以在展开的面板里；→ 进入分组，← / Esc 返回主 Dock

  // 统一入口：恢复上次选中的位置（不存在则回落第一个图标）
  // 上次若在分组面板里选中某个成员，则恢复到它所属的分组图标（面板默认不展开）
  // 注意：必须由调用方传入「新鲜的」列表 —— 启动初始化时 appsRef 的镜像 effect
  // 声明在本 effect 之后，同一 commit 内读 ref 只会拿到上一轮的 []，会让启动选中失效
  const resumeNavId = useCallback((list: AppEntry[]): number | null => {
    const top = list.filter((a) => !a.groupId && !a.isSeparator) // 分隔符不参与导航
    const last = navLastRef.current
    if (last === ADD_BTN_ID) return ADD_BTN_ID
    if (last !== null) {
      const hit = list.find((a) => a.id === last)
      // 记忆里若是不参与导航的分隔符（历史脏数据），跳过它走下一级回落
      if (hit && !hit.isSeparator) {
        if (hit.groupId !== undefined) {
          if (top.some((a) => a.id === hit.groupId)) return hit.groupId
        } else {
          return hit.id
        }
      }
    }
    return top[0]?.id ?? null
  }, [])

  // 主进程通知：Alt+Space 唤出 Dock（托盘点击等鼠标路径不会触发）
  // 唤出不直接画选中框——按用户要求：只有按 ←/→ 才亮；这里顺手清掉上一次的残留选中
  useEffect(() => {
    const unsubscribe = window.api.onNavEnter(() => {
      closeGroupPanel() // 回到主 Dock 层
      setNavId(null)
    })
    return unsubscribe
  }, [closeGroupPanel])

  // 启动**不**选中任何条目：导航模式只在按 ←/→ 时进入（见 keydown 里的唤醒分支）。
  // 之前这里是「启动即恢复到上次位置」，会让 Dock 一启动就挂着一个蓝框。

  // 选中框自动隐藏：停止操作 NAV_IDLE_MS 后连状态一起退出导航——框看不见了就不该还能
  // 被 Enter 启动（避免「盲按 Enter 启动了上次选中的程序」）。任何方向键/Enter 重新计时
  const navIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const armNavIdle = useCallback(() => {
    if (navIdleTimer.current) clearTimeout(navIdleTimer.current)
    navIdleTimer.current = setTimeout(() => {
      navIdleTimer.current = null
      setNavId(null)
    }, NAV_IDLE_MS)
  }, [])

  useEffect(() => {
    if (navId === null) {
      if (navIdleTimer.current) { clearTimeout(navIdleTimer.current); navIdleTimer.current = null }
      return
    }
    armNavIdle()
  }, [navId, armNavIdle])

  useEffect(() => () => {
    if (navIdleTimer.current) clearTimeout(navIdleTimer.current)
  }, [])

  // 选中的条目被删除（右键删除 / 解散分组 / 桌面清理）时退出导航
  useEffect(() => {
    if (navId === null || navId === ADD_BTN_ID) return
    if (!apps.some((a) => a.id === navId)) setNavId(null)
  }, [apps, navId])

  // 选中项滚入可视区（图标多时 Dock / 面板都是横向滚动的）
  useEffect(() => {
    if (navId === null) return
    navLastRef.current = navId
    localStorage.setItem('ql-nav-last', String(navId)) // 记忆位置：重启后仍从这里恢复
    const el = navId === ADD_BTN_ID
      ? addBtnRef.current
      : iconRefs.current.get(navId) ?? panelIconRefs.current.get(navId)
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [navId, openGroupId])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      // 编辑表单的输入框里正常打字，不参与导航
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return

      // 导航列表排除分隔符（方向键直接跳过它们）
      const list = openGroupId === null
        ? appsRef.current.filter((a) => !a.groupId && !a.isSeparator)
        : appsRef.current.filter((a) => a.groupId === openGroupId && !a.isSeparator)

      // 未处于导航模式：按 ←/→ 直接「唤醒」选中框（Esc / 鼠标点击退出后仍可随时唤起）
      // 恢复到上次选中的条目；菜单打开时不抢占方向键
      if (navId === null) {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        if (contextMenu || menuPos) return
        const resume = resumeNavId(appsRef.current)
        if (resume === null) return
        e.preventDefault()
        setNavId(resume)
        return
      }

      // 已进入导航模式：任何方向键/Enter 都重置自动隐藏计时（含「按了但位置没变」的情况）
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Enter') armNavIdle()

      // 「+」新增按钮（Dock 末尾的合成目标，不属于 apps）：← 回到最后一个图标，Enter 打开菜单
      if (navId === ADD_BTN_ID) {
        if (e.key === 'ArrowLeft') {
          e.preventDefault()
          const last = list[list.length - 1]
          if (last) setNavId(last.id)
        } else if (e.key === 'Enter') {
          e.preventDefault()
          handleAddToggle()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          setNavId(null)
        }
        return
      }

      const current = appsRef.current.find((a) => a.id === navId)
      const idx = list.findIndex((a) => a.id === navId)

      switch (e.key) {
        case 'ArrowRight': {
          e.preventDefault()
          // 分组：→ 进入面板并把选中移到第一个成员（分隔线不参与导航，必须排除）
          if (current?.isGroup) {
            setOpenGroupId(current.id)
            const first = appsRef.current.find((a) => a.groupId === current.id && !a.isSeparator)
            if (first) setNavId(first.id)
            return
          }
          const next = list[idx + 1]
          if (next) { setNavId(next.id); return }
          // 已经在最右：再往右落到 Dock 末尾的「+」新增按钮（面板里没有 + 按钮）
          if (openGroupId === null) setNavId(ADD_BTN_ID)
          return
        }
        case 'ArrowLeft': {
          e.preventDefault()
          // 面板里：← 返回主 Dock 并选中该分组
          if (openGroupId !== null) {
            setOpenGroupId(null)
            setNavId(openGroupId)
            return
          }
          const prev = list[idx - 1]
          if (prev) setNavId(prev.id)
          return
        }
        case 'Enter': {
          e.preventDefault()
          // 菜单打开时不响应 Enter：选中框可能被菜单/浮层盖住，启动会显得无缘无故
          if (contextMenu || menuPos) return
          if (!current) return
          if (current.isGroup) {
            setOpenGroupId(current.id)
            const first = appsRef.current.find((a) => a.groupId === current.id && !a.isSeparator)
            if (first) setNavId(first.id)
            return
          }
          // 启动后 Dock 自动隐藏到托盘，导航随之结束
          window.api.runApp(current.targetPath, current.arguments, current.workingDirectory)
          setNavId(null)
          return
        }
        case 'Escape': {
          e.preventDefault()
          if (contextMenu || menuPos) { setContextMenu(null); setMenuPos(null); return }
          if (openGroupId !== null) {
            // 面板里：Esc 返回主 Dock（仍处于导航模式）
            setOpenGroupId(null)
            setNavId(openGroupId)
            return
          }
          setNavId(null)
          return
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [navId, openGroupId, contextMenu, menuPos, closeGroupPanel, handleAddToggle, armNavIdle])

  // ─── 分隔线 ───────────────────────────────────────────────────────────
  // 分隔线是一种特殊条目（isSeparator: true）：因此天然参与拖拽排序与持久化
  // 而启动、桌面扫描去重、缺失清理、键盘导航都会跳过它

  // beforeId 为 null 表示追加到末尾；插到分组成员之前时跟随该成员的分组归属
  const handleInsertSeparator = (beforeId: number | null) => {
    setContextMenu(null)
    setMenuPos(null)
    const id = nextId++ // id 在 updater 外分配（StrictMode 双调用 updater 时无副作用）
    setApps((prev) => {
      const entry: AppEntry = {
        id,
        iconDataUrl: '',
        targetPath: '',
        arguments: '',
        workingDirectory: '',
        description: '分隔线',
        isSeparator: true
      }
      if (beforeId === null) return [...prev, entry]
      const at = prev.findIndex((a) => a.id === beforeId)
      if (at === -1) return [...prev, entry]
      const target = prev[at]
      if (target.groupId !== undefined) entry.groupId = target.groupId
      return [...prev.slice(0, at), entry, ...prev.slice(at)]
    })
  }

  // 右键菜单（非编辑态）动作可见性判断
  const isUrlTarget = (p: string): boolean => /^(https?|ftp|steam):\/\/|^mailto:/i.test(p)
  const isFileSystemPath = (app: AppEntry): boolean =>
    !!app.targetPath &&
    !app.targetPath.startsWith('shell:') &&
    !app.targetPath.startsWith('::') &&
    !isUrlTarget(app.targetPath)

  const handleRunAdmin = (app: AppEntry) => {
    setContextMenu(null)
    window.api.runAsAdmin(app.targetPath, app.arguments, app.workingDirectory)
  }

  const handleOpenLocation = (app: AppEntry) => {
    setContextMenu(null)
    window.api.openFileLocation(app.targetPath)
  }

  const handleCopyPath = (app: AppEntry) => {
    setContextMenu(null)
    window.api.copyText(app.targetPath)
  }

  // ─── Persistence ──────────────────────────────────────────────────────

  // 保存守卫：初始加载完成前禁止保存。否则挂载时保存 effect 会用 apps=[] 覆盖磁盘文件，
  // 且 React.StrictMode 双挂载下第二次 load 会读到被清空的文件（load#1 在 save([]) 之前
  // 读旧数据但结果被 cancelled 丢弃），导致已保存条目永久丢失——只剩启动扫描的文件夹
  // 能靠重新扫描"复活"，手动添加的程序快捷方式则彻底消失。
  const loadedRef = useRef(false)

  // ─── 桌面文件夹同步：清理缺失 + 扫描合并（启动与实时事件共用）───────────

  // appsRef 已在上面声明（openFolderCard 需要读最新列表）。这里只做镜像更新——
  // 用 useLayoutEffect 而不是 useEffect：提交后立刻同步，fs.watch 回调与键盘导航
  // 读到的都已经是本轮的值
  useLayoutEffect(() => { appsRef.current = apps }, [apps])
  // 清理/扫描进行中时跳过重复事件（debounce 只聚合了 watch 事件，扫描自身耗时可更长）
  const desktopSyncBusyRef = useRef(false)

  // 合并扫描结果：新增的桌面文件夹 / 指向文件夹的 .lnk / 「此电脑」「回收站」加入 Dock。
  // baseline 用于去重（启动时为已加载列表，实时事件时为当前列表）。去重、排序、id 分配
  // 都在 updater 外完成——StrictMode 双调用 updater 时无副作用；updater 内仍有防御性去重。
  const mergeDesktopScan = useCallback((baseline: AppEntry[]) => {
    return window.api.scanDesktopFolders().then((found) => {
      if (!found || found.length === 0) return
      // 记住主进程给的共享文件夹图标：**它同时也是坏数据的修复源**。
      // 只在为空时记（主进程每次扫描都会返回同一张图，没必要反复覆盖）
      for (const f of found) {
        if (!f.specialType && f.iconDataUrl) { sharedFolderIcon = f.iconDataUrl; break }
      }
      const existing = new Set(baseline.map((a) => normPath(a.targetPath)))
      const fresh = found.filter((f) => !existing.has(normPath(f.path)))
      if (fresh.length === 0) return
      // 固定顺序：此电脑 → 回收站 → 文件夹（其余保持扫描顺序）
      const rank = (f: { specialType?: 'this-pc' | 'recycle-bin' }): number =>
        f.specialType === 'this-pc' ? 0 : f.specialType === 'recycle-bin' ? 1 : 2
      fresh.sort((a, b) => rank(a) - rank(b))
      // 显式标注 AppEntry[]：否则 map 推断出「带 specialType」/「带 isFolder」两个对象形状的
      // 联合类型，下面 add.filter((e) => e.specialType) 会在缺该字段的分支上报 TS2339
      const entries: AppEntry[] = fresh.map((f) => ({
        id: nextId++,
        // **直接用主进程扫描返回的真实图标**。v1.12.0 这里曾写成哨兵（想省内存），
        // 结果把唯一一份真图标丢掉了、哨兵又解析成空串 → 首次安装后文件夹图标永久空白。
        // 现在每条自帶真图标；万一主进程没给（提取失败），才回落到共享的那一枚。
        iconDataUrl: f.iconDataUrl || sharedFolderIcon,
        targetPath: f.path,
        arguments: '',
        workingDirectory: '',
        description: f.name,
        // 系统位置（此电脑/回收站）保留 specialType；桌面文件夹标 isFolder
        ...(f.specialType
          ? { specialType: f.specialType as 'this-pc' | 'recycle-bin' }
          : { isFolder: true })
      }))
      setApps((prev) => {
        // 纯合并（无任何副作用）：
        // - 防御：prev 中已存在的路径不再加入（防止与手动添加/并行合并竞态）
        const have = new Set(prev.map((a) => normPath(a.targetPath)))
        const add = entries.filter((e) => !have.has(normPath(e.targetPath)))
        if (add.length === 0) return prev
        // - 系统位置区块（此电脑 → 回收站，稳定排序保持相对顺序）+ 新文件夹 + 其余。
        //   保证 Dock 前部固定为 此电脑 → 回收站 → 文件夹；若用户手动拖动过系统位置，
        //   本次合并会把它们归位到区块前部（与固定顺序设计一致）
        const spRank = (e: AppEntry): number => (e.specialType === 'this-pc' ? 0 : 1)
        const specialBlock = [...prev.filter((a) => a.specialType), ...add.filter((e) => e.specialType)]
          .sort((a, b) => spRank(a) - spRank(b))
        const newFolders = add.filter((e) => !e.specialType)
        const rest = prev.filter((a) => !a.specialType)
        return [...specialBlock, ...newFolders, ...rest]
      })
    }).catch(() => {})
  }, [])

  // 清理已不存在的文件夹条目：桌面文件夹被删除/移动 → 从 Dock 移除（与扫描合并互补）。
  // 存在性由主进程纯 fs 检查（无 PowerShell）；系统位置（shell: 命令）不参与。
  // 注意：外部硬盘/网络盘未连接时其文件夹条目也会被移除（重新连接后桌面文件夹会由扫描恢复）
  const pruneMissingFolders = useCallback((baseline: AppEntry[]) => {
    const paths = [...new Set(
      baseline.filter((a) => a.isFolder && a.targetPath).map((a) => a.targetPath)
    )]
    if (paths.length === 0) return Promise.resolve()
    return window.api.checkMissingFolders(paths).then((missing) => {
      if (!missing || missing.length === 0) return
      const gone = new Set(missing)
      setApps((prev) => {
        const next = prev.filter((a) => !(a.isFolder && a.targetPath && gone.has(a.targetPath)))
        return next.length === prev.length ? prev : next
      })
    }).catch(() => {})
  }, [])

  // 修复历史坏数据：v1.12.0/v1.12.1 的哨兵设计会把文件夹条目的 iconDataUrl 写盘成
  // **空串**（见文件顶部「文件夹图标」那段说明），而且永远自愈不了。
  // 这里在启动同步结束后统一回填——只动空值条目，有效图标一个都不碰；回填后由防抖保存
  // 自动写回磁盘，**用户不需要删配置、也不需要重装**。
  const repairEmptyFolderIcons = useCallback(() => {
    if (!sharedFolderIcon) return
    const icon = sharedFolderIcon
    setApps((prev) => {
      let changed = false
      const next = prev.map((a) => {
        if (!a.isFolder || a.iconDataUrl) return a
        changed = true
        return { ...a, iconDataUrl: icon }
      })
      return changed ? next : prev
    })
  }, [])

  // 启动：先加载已保存的快捷方式，加载完成后解锁保存，再清理缺失文件夹 + 扫描合并。
  // 顺序（load → prune → scan）链式执行避免竞态——若并行，扫描结果可能被 setApps 覆盖丢失。
  useEffect(() => {
    let cancelled = false
    window.api.loadShortcuts().then((saved) => {
      if (cancelled) return
      if (saved && saved.length > 0) {
        // 认下主进程给的那份共享文件夹图标（所有文件夹条目都是同一张图），
        // 它是下面「修复空图标」的数据源。自己在带图标的文件夹条目上取一份也行
        const withIcon = saved.find((a) => a.isFolder && a.iconDataUrl)
        if (withIcon) sharedFolderIcon = withIcon.iconDataUrl
        setApps(saved)
        nextId = Math.max(-1, ...saved.map((a) => a.id)) + 1
      }
      // 加载完成即解锁保存（不等同步结束，启动早期用户操作也能正常持久化）
      loadedRef.current = true
      desktopSyncBusyRef.current = true
      const sync = async () => {
        try {
          await pruneMissingFolders(saved || [])
          if (cancelled) return
          // 注意顺序：mergeDesktopScan 内部会把主进程这次扫描回来的共享图标记进
          // sharedFolderIcon，所以「修复空图标」必须排在它后面（数据源先就位）
          await mergeDesktopScan(saved || [])
          if (cancelled) return
          repairEmptyFolderIcons()
        } finally {
          desktopSyncBusyRef.current = false
        }
      }
      sync()
    }).catch(() => {
      // 加载失败也解锁保存（不阻塞后续持久化）
      if (!cancelled) loadedRef.current = true
    })
    return () => { cancelled = true }
  }, [pruneMissingFolders, mergeDesktopScan, repairEmptyFolderIcons])

  // 实时同步：主进程 fs.watch 桌面目录（debounce 1s）→ 重新「清理缺失 + 扫描合并」。
  // 桌面新增文件夹即时入 Dock、删除即时移除；清理/扫描进行中跳过重复事件。
  useEffect(() => {
    const unsubscribe = window.api.onDesktopChanged(() => {
      if (desktopSyncBusyRef.current) return
      desktopSyncBusyRef.current = true
      const sync = async () => {
        try {
          await pruneMissingFolders(appsRef.current)
          await mergeDesktopScan(appsRef.current)
        } finally {
          desktopSyncBusyRef.current = false
        }
      }
      sync()
    })
    return unsubscribe
  }, [pruneMissingFolders, mergeDesktopScan])

  // 保存：**必须防抖**。拖动排序每帧都会产生一次 apps 变更，原来每次都立刻
  // `saveShortcuts(apps)` —— 整个数组（含全部图标 data URL）被结构化克隆跨进程传一遍，
  // 主进程再 JSON.stringify 整个数组写盘一次。拖一次图标就是几十次全量序列化 +
  // 几十次磁盘写入，是「拖动时卡顿 + 磁盘 io 尖峰」的主要来源之一。
  // 400ms 内合并成一次；退出时由主进程的 flush-pending-save 兜底，不会丢数据。
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSave = useRef<AppEntry[] | null>(null)

  /** 把一份列表写盘。v1.12.2 起状态里存的就是真实 data URL，这里不需要再做任何换算。
   *  （v1.12.0 曾在这里把哨兵换成共享常量——共享常量为空时就把空串写进了磁盘，
   *   是那个「永久坏、重启不恢复」bug 的最后一环。） */
  const writeShortcuts = useCallback((data: AppEntry[]): void => {
    window.api.saveShortcuts(data)
  }, [])

  /** 立刻把待保存的列表写盘（退出前由主进程的 flush-pending-save 触发）。 */
  const flushSave = useCallback((): void => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    const data = pendingSave.current
    pendingSave.current = null
    if (data) writeShortcuts(data)
  }, [writeShortcuts])

  useEffect(() => {
    // 初始加载完成前不保存（见 loadedRef 注释：防止挂载时 save([]) 清空磁盘数据）
    if (!loadedRef.current) return
    pendingSave.current = apps
    if (saveTimer.current) return
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      const data = pendingSave.current
      pendingSave.current = null
      if (data) writeShortcuts(data)
    }, 400)
  }, [apps, writeShortcuts])

  // 主进程在退出前通知：把还在防抖窗口里的最后一次变更立刻落盘
  useEffect(() => window.api.onFlushPendingSave(flushSave), [flushSave])

  // 组件卸载（页面重载 / 窗口重建）时也不能丢：能发就发一次
  useEffect(() => () => { flushSave() }, [flushSave])

  // 图标增删 / 初始加载后刷新两侧渐隐提示（此时 DOM 已更新，scrollWidth 可用）
  // 顺带处理「新建分组后滚动到末尾」的待办标记
  useEffect(() => {
    const el = dockInnerRef.current
    if (scrollDockToEndRef.current) {
      scrollDockToEndRef.current = false
      if (el) el.scrollLeft = el.scrollWidth
    }
    updateScrollState()
  }, [apps, updateScrollState])

  // ─── Render helpers ───────────────────────────────────────────────────

  const getItemClass = (id: number) => {
    let cls = 'dock-item'
    if (dragId === id) cls += ' dragging'
    return cls
  }

  // 右键菜单对应的条目
  const ctxApp = contextMenu ? apps.find((a) => a.id === contextMenu.appId) : undefined
  // Dock 顶层图标（组内成员只在面板里渲染）+ 当前展开分组的成员
  const topLevel = useMemo(() => apps.filter((a) => !a.groupId), [apps])
  const openGroupMembers = useMemo(
    () => (openGroupId === null ? [] : apps.filter((a) => a.groupId === openGroupId)),
    [apps, openGroupId]
  )
  const openGroup = openGroupId === null ? undefined : apps.find((a) => a.id === openGroupId)
  // 浮层的贴边锚点与可用空间，渲染时算一次。方向感知：底部 Dock 贴上方（bottom），
  // 顶部 Dock 贴下方（top）——五个浮层（此电脑卡片 / 文件夹卡片 / 「+」菜单 / 右键菜单 /
  // 分组面板）共用这一份几何。
  // 注意：**两轴都要显式写**（另一个写 auto）。这些浮层的 CSS 里留着历史兜底
  // （.dropdown-menu 的 bottom: calc(100% + 8px)、.group-panel 的 bottom: 154px），
  // 若只设 top，兜底的 bottom 仍在生效 → 高度 auto 的元素被算成
  // height = 容器高 - top - bottom（负数）→ 只剩内边距，菜单被压成一条白线。
  const overlayBottomOffset = overlayBottom()
  const overlayTopOffset = overlayTop()
  const overlayAvail = Math.max(120, BASE_WINDOW_H - (isTop ? overlayTopOffset : overlayBottomOffset) - 8)
  const overlayAnchor: React.CSSProperties = isTop
    ? { top: overlayTopOffset, bottom: 'auto', maxHeight: overlayAvail, height: 'auto' }
    : { bottom: overlayBottomOffset, top: 'auto', maxHeight: overlayAvail, height: 'auto' }
  // 分组 → 可显示成员（排除分隔线）：分组图标的缩略拼图与数量徽标用它，
  // 否则分隔线会占掉一个拼图格子（空破图）并让计数偏大。
  // （面板渲染用的是 openGroupMembers，不需要另建一份含分隔线的表）
  // useMemo：每次渲染都重建这张 Map 会随着图标数量线性变贵，而 App 的渲染次数
  // 在鼠标划过 Dock 时会明显增加（放大、选中、菜单命中判定都会 setState）
  const groupIconMembersById = useMemo(() => {
    const map = new Map<number, AppEntry[]>()
    for (const a of apps) {
      if (a.groupId === undefined) continue
      if (a.isSeparator) continue
      const iconList = map.get(a.groupId)
      if (iconList) iconList.push(a)
      else map.set(a.groupId, [a])
    }
    return map
  }, [apps])
  // 渲染直接用 apps：v1.12.2 起状态里存的就是真实 data URL，不再需要「哨兵 → 共享常量」
  // 这一层转换（那一层就是把空值放大成「空白图标」的地方，且它的结果不在任何依赖数组里，
  // 属于隐性耦合——见文件顶部「文件夹图标」那段）
  const viewApps = apps
  const viewById = null
  const viewOf = (a: AppEntry): AppEntry => a
  const viewTopLevel = useMemo(() => topLevel.map(viewOf), [topLevel])
  const viewGroupMembers = useMemo(() => openGroupMembers.map(viewOf), [openGroupMembers])
  const viewOpenGroup = openGroup
  const viewCtxApp = ctxApp

  return (
    <div
      className={(theme === 'light' ? 'app theme-light' : theme === 'transparent' ? 'app theme-transparent' : 'app')
        // 悬停卡片打开时加标记类：CSS 用它压掉图标悬浮标签（否则会透过半透明卡片叠字）
        + (folderCard || showDrivesCard ? ' card-open' : '')}
      // 停靠边：CSS 用它切换整套布局方向（顶部 Dock = 整套几何垂直镜像）
      data-edge={edge}
      onMouseEnter={() => window.api.dockPointer(true)}
    >
      <div
        className={'dock' + (fileDragOver ? ' drop-active' : '')}
        ref={dockRef}
        onMouseMove={handleDockMouseMove}
        onMouseLeave={handleDockMouseLeave}
        onDragOver={handleDockDragOver}
        onDragLeave={handleDockDragLeave}
        onDrop={handleDockDrop}
      >
        {/* 毛玻璃背景独立层：只覆盖图标区（图标在其中垂直居中，上下间距小）。
            顶部放大留白区是透明的，hover 放大时图标会顶出背景之上（类似 macOS）。 */}
        <div className="dock-bg" ref={dockBgRef} />
        <div
          // 两端还有图标可滚时加标记类：CSS 用遮罩让边缘的图标「溶解」而不是被硬切一刀
          // （硬切的半个图标压在圆角边缘上，看着像探出了 Dock 轮廓）
          className={'dock-inner' + (scrollState.left ? ' edge-left' : '') + (scrollState.right ? ' edge-right' : '')}
          ref={setDockInnerRef}
          onScroll={updateScrollState}
        >
          {dropIdx === 0 && <div className="drop-indicator" />}

          {viewTopLevel.map((app, idx) => (
            <div key={app.id} style={{ display: 'contents' }}>
              {app.isSeparator ? (
                // 分隔线：不参与悬停放大（data-sep），可拖拽、可右键
                <div
                  className={'dock-sep' + (dragId === app.id ? ' dragging' : '')}
                  data-sep="1"
                  ref={(el) => {
                    if (el) iconRefs.current.set(app.id, el)
                    else iconRefs.current.delete(app.id)
                  }}
                  onMouseDown={(e) => handleIconMouseDown(e, app.id)}
                  onContextMenu={(e) => handleContextMenu(e, app.id)}
                />
              ) : (
              <div
                className={
                  getItemClass(app.id) +
                  (dragOverGroupId === app.id ? ' drop-target' : '') +
                  (navId === app.id ? ' selected' : '')
                }
                ref={(el) => {
                  if (el) iconRefs.current.set(app.id, el)
                  else iconRefs.current.delete(app.id)
                }}
                onMouseDown={(e) => handleIconMouseDown(e, app.id)}
                onClick={() => handleRun(app)}
                onContextMenu={(e) => handleContextMenu(e, app.id)}
                // 「此电脑」：悬停 300ms 弹出盘符卡片（移开 150ms 后关，方便移到卡片上继续看）
                // 文件夹条目：同一套时序弹出子项预览卡片（锚在该图标中心）
                // 两者都先做一次标签钳制，保证贴边图标的悬浮标签不被容器裁掉
                onMouseEnter={(e) => {
                  clampDockLabel(e.currentTarget as HTMLElement)
                  if (app.specialType === 'this-pc') {
                    openDrivesCard()
                  } else if (app.isFolder && app.targetPath) {
                    const r = e.currentTarget.getBoundingClientRect()
                    openFolderCard(app, r.left + r.width / 2)
                  }
                }}
                onMouseLeave={app.specialType === 'this-pc'
                  ? scheduleCloseDrivesCard
                  : app.isFolder && app.targetPath ? scheduleCloseFolderCard : undefined}
                // 不设 title：App 自己有胶囊悬浮标签，再叠加系统的原生 tooltip 会变成
                // 光标下方多出一个灰色提示框（与标签重复，观感也差）
              >
                <div className="dock-icon-wrap">
                  {app.isGroup && !app.iconDataUrl ? (
                    // 分组图标：默认用组内前 4 个图标的缩略拼图（macOS 堆叠观感），
                    // 空组回退 2×2 网格图标；用户手动换过图标则走下面的 <img>
                    (() => {
                      // 用「可显示成员」（排除分隔线）做拼图，避免空破图格子
                      const members = groupIconMembersById.get(app.id) ?? []
                      if (members.length === 0) {
                        return (
                          <div className="dock-icon group-glyph">
                            <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
                              <rect x="3" y="3" width="7.6" height="7.6" rx="2.2" fill="currentColor" opacity="0.9" />
                              <rect x="13.4" y="3" width="7.6" height="7.6" rx="2.2" fill="currentColor" opacity="0.55" />
                              <rect x="3" y="13.4" width="7.6" height="7.6" rx="2.2" fill="currentColor" opacity="0.55" />
                              <rect x="13.4" y="13.4" width="7.6" height="7.6" rx="2.2" fill="currentColor" opacity="0.9" />
                            </svg>
                          </div>
                        )
                      }
                      return (
                        <div className={'dock-group-preview' + (members.length === 1 ? ' single' : '')}>
                          {members.slice(0, 4).map((m) => (
                            <img key={m.id} src={m.iconDataUrl} alt="" draggable={false} />
                          ))}
                        </div>
                      )
                    })()
                  ) : (
                    <img className="dock-icon" src={app.iconDataUrl} alt="" draggable={false} />
                  )}
                  {app.isGroup && (groupIconMembersById.get(app.id)?.length ?? 0) > 0 && (
                    <span className="dock-badge">{groupIconMembersById.get(app.id)!.length}</span>
                  )}
                  {/* 「此电脑」：所有盘符的汇总用量细条（贴在图标框底部内侧） */}
                  {app.specialType === 'this-pc' && driveSummary && (
                    <span className="dock-usage" aria-hidden="true">
                      <span
                        className="dock-usage-fill"
                        style={{
                          width: `${Math.round(driveSummary.ratio * 100)}%`,
                          background: usageColor(driveSummary.ratio)
                        }}
                      />
                    </span>
                  )}
                </div>
                <span className="dock-label">
                  {app.specialType === 'this-pc' && driveSummary
                    ? `此电脑 · 可用 ${fmtSize(driveSummary.free)} / ${fmtSize(driveSummary.total)}`
                    : (app.description || '未命名')}
                </span>
              </div>
              )}
              {dropIdx === idx + 1 && dragId !== app.id && (
                <div className="drop-indicator" />
              )}
            </div>
          ))}

          {/* Add button（键盘导航可落到这里：Enter 打开菜单） */}
          <div className={'dock-item dock-add' + (navId === ADD_BTN_ID ? ' selected' : '')} ref={addBtnRef}>
            <div
              className="dock-icon-wrap dock-add-btn"
              onClick={handleAddToggle}
            >
              <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                <line x1="14" y1="6" x2="14" y2="22" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                <line x1="6" y1="14" x2="22" y2="14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </div>
            <span className="dock-label">添加</span>
          </div>
        </div>

        {/* 两端渐隐提示：那一侧还有图标可滚动查看 */}
        <div className={`dock-edge left${scrollState.left ? ' show' : ''}`} />
        <div className={`dock-edge right${scrollState.right ? ' show' : ''}`} />
      </div>

      {/* 分组面板：主 Dock 同构的迷你 Dock —— 图标尺寸/悬停放大/悬浮标签全部复用
          .dock-item 系列的样式，宽度随图标数量伸缩，超出窗口时横向滚动；高度固定。
          因此不改变窗口尺寸（无 resize 白闪）。 */}
      {viewOpenGroup && (
        <div
          className="group-panel"
          ref={panelRef}
          style={{
            // 两轴都写：.group-panel 的 CSS 兜底 bottom: 154px 若仍生效，只设 top 会把面板压扁
            ...(isTop ? { top: overlayTopOffset, bottom: 'auto' } : { bottom: overlayBottomOffset, top: 'auto' }),
            // 右键菜单锚在 Dock 栏外侧、与面板同处一条带（窗口只有 300px 高，面板另一侧
            // 只剩十几像素，无法再叠）——菜单打开期间藏起面板；菜单一关闭（鼠标移出即关，
            // 见菜单自动关闭 effect）面板同帧显示回来，不会出现重叠空档
            visibility: contextMenu ? 'hidden' : 'visible'
          }}
        >
          <div className="group-panel-bg" />
          <div
            className="group-panel-inner"
            ref={panelInnerRef}
            onMouseMove={handlePanelMouseMove}
            onMouseLeave={handlePanelMouseLeave}
          >
            {viewGroupMembers.map((m) => (
              m.isSeparator ? (
                <div
                  key={m.id}
                  className={'dock-sep' + (dragId === m.id ? ' dragging' : '')}
                  data-sep="1"
                  ref={(el) => {
                    if (el) panelIconRefs.current.set(m.id, el)
                    else panelIconRefs.current.delete(m.id)
                  }}
                  onMouseDown={(e) => handleIconMouseDown(e, m.id)}
                  onContextMenu={(e) => handleContextMenu(e, m.id)}
                />
              ) : (
              <div
                key={m.id}
                className={'dock-item' + (dragId === m.id ? ' dragging' : '') + (navId === m.id ? ' selected' : '')}
                ref={(el) => {
                  if (el) panelIconRefs.current.set(m.id, el)
                  else panelIconRefs.current.delete(m.id)
                }}
                onMouseDown={(e) => handleIconMouseDown(e, m.id)}
                onClick={() => handleRun(m)}
                onContextMenu={(e) => handleContextMenu(e, m.id)}
                onMouseEnter={(e) => clampDockLabel(e.currentTarget as HTMLElement)}
                // 同主 Dock：不设 title，避免系统原生 tooltip 与胶囊标签重复
              >
                <div className="dock-icon-wrap">
                  <img className="dock-icon" src={m.iconDataUrl} alt="" draggable={false} />
                </div>
                <span className="dock-label">{m.description || '未命名'}</span>
              </div>
              )
            ))}
            {viewGroupMembers.length === 0 && (
              <div className="group-panel-empty">
                {/* 线性图标与整体风格（细描边、圆头）一致；直接内联，不引图标库 */}
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7.5" height="7.5" rx="2" />
                  <rect x="13.5" y="3" width="7.5" height="7.5" rx="2" />
                  <rect x="3" y="13.5" width="7.5" height="7.5" rx="2" />
                  <line x1="14" y1="17.2" x2="21" y2="17.2" />
                  <line x1="17.5" y1="13.7" x2="17.5" y2="20.7" />
                </svg>
                <span className="es-main">空分组</span>
                <span className="es-sub">把图标拖到分组图标上即可加入</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 「此电脑」悬停卡片：列出各盘符与用量条。复用面板/菜单的浮层几何
          （贴在 Dock 毛玻璃条外侧，高度上限 = 可用空间），不改变窗口尺寸 */}
      {showDrivesCard && (
        <div
          className="drives-card"
          style={{
            ...overlayAnchor,
            // 浮层互斥：五块浮层（两张卡片 / 「+」菜单 / 右键菜单 / 分组面板）同处 Dock 外侧
            // 一条带，窗口只有 300px 高叠不开。卡片 z-index 最高（200 > 面板 150 > 菜单 100），
            // 不做互斥就会盖住菜单项/面板成员并抢走点击
            visibility: menuPos || contextMenu || openGroup ? 'hidden' : 'visible'
          }}
          onMouseEnter={() => {
            // 鼠标移进卡片：取消正在计时的关闭/打开，保持展开
            if (drivesCardTimer.current) { clearTimeout(drivesCardTimer.current); drivesCardTimer.current = null }
          }}
          onMouseLeave={closeDrivesCard}
        >
          <div className="drives-card-title">
            此电脑 · 驱动器{driveSummary ? `（可用 ${fmtSize(driveSummary.free)}）` : ''}
          </div>
          {drives.length === 0 && (
            <div className="drives-empty">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3.5" width="18" height="8" rx="2" />
                <rect x="3" y="12.5" width="18" height="8" rx="2" />
                <line x1="7" y1="7.5" x2="7.01" y2="7.5" />
                <line x1="7" y1="16.5" x2="7.01" y2="16.5" />
              </svg>
              <span className="es-main">未检测到驱动器</span>
            </div>
          )}
          {drives.map((d) => {
            const ratio = usedRatio(d)
            return (
              <div className="drive-row" key={d.name}>
                <div className="drive-row-head">
                  <span className="drive-name">{d.name}</span>
                  <span className="drive-type">{d.label || driveTypeText(d.type)}</span>
                  <span className="drive-nums">
                    {d.total > 0 ? `${fmtSize(d.free)} 可用 / ${fmtSize(d.total)}` : '容量未知'}
                  </span>
                </div>
                <span className="drive-bar">
                  <span
                    className="drive-bar-fill"
                    style={{ width: `${Math.round(ratio * 100)}%`, background: usageColor(ratio) }}
                  />
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* 文件夹悬停预览卡片：与「此电脑」卡片同一套浮层几何与玻璃观感（复用 .drives-card），
          水平锚在悬停图标中心并钳制在窗口内；内容超出可用高度时卡片内部滚动（可见滚动条） */}
      {folderCard && (
        <div
          ref={folderCardRef}
          className="drives-card folder-card"
          style={{
            left: folderCardLeft ?? folderCard.anchorX,
            ...overlayAnchor,
            // 与「+」菜单 / 右键菜单 / 分组面板互斥（同一条带，窗口只有 300px 高，叠不开）
            visibility: menuPos || contextMenu || openGroup ? 'hidden' : 'visible'
          }}
          onMouseEnter={() => {
            if (folderCardTimer.current) { clearTimeout(folderCardTimer.current); folderCardTimer.current = null }
          }}
          onMouseLeave={closeFolderCard}
        >
          <div className="folder-card-head">
            <div className="folder-card-title">
              <span className="folder-card-name">{folderCard.name}</span>
              <span className="folder-card-path" title={folderCard.path}>{folderCard.path}</span>
            </div>
            <div
              className="folder-card-open"
              title="在资源管理器中打开"
              onClick={() => {
                closeFolderCard()
                window.api.openPath(folderCard.path)
              }}
            >
              打开
            </div>
          </div>
          {!folderCard.data && (
            <>
              <div className="folder-loading">
                <svg className="spinner" width="13" height="13" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                  <path d="M12 3a9 9 0 1 0 9 9" />
                </svg>
                读取中…
              </div>
              {/* 骨架行：和 .folder-row 同高（26px），真列表填入时不会跳动 */}
              <div className="folder-loading"><span className="skeleton" style={{ width: '58%' }} /></div>
              <div className="folder-loading"><span className="skeleton" style={{ width: '74%' }} /></div>
              <div className="folder-loading"><span className="skeleton" style={{ width: '46%' }} /></div>
            </>
          )}
          {folderCard.data?.error && (
            <div className="drives-empty">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <line x1="12" y1="7.5" x2="12" y2="13" />
                <line x1="12" y1="16.5" x2="12.01" y2="16.5" />
              </svg>
              <span className="es-main">
                {folderCard.data.error === 'missing' ? '文件夹不存在（可能已删除或移动）'
                  : folderCard.data.error === 'denied' ? '无法读取（权限不足）'
                    : '这不是一个文件夹'}
              </span>
            </div>
          )}
          {folderCard.data && !folderCard.data.error && (
            <>
              <div className="folder-card-sub">
                {folderCard.data.folders} 个文件夹 · {folderCard.data.files} 个文件
              </div>
              {folderCard.data.items.length === 0 && (
                <div className="drives-empty">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 7.5a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  </svg>
                  <span className="es-main">空文件夹</span>
                </div>
              )}
              {folderCard.data.items.map((it) => (
                <div
                  className={'folder-row' + (it.isDir ? ' dir' : '')}
                  key={it.path}
                  title={it.name}
                  onClick={() => openFolderChild(it)}
                >
                  <span className="folder-row-icon">
                    {it.iconDataUrl
                      ? <img src={it.iconDataUrl} alt="" draggable={false} />
                      : <span className="folder-row-glyph" />}
                  </span>
                  <span className="folder-row-name">{it.name}</span>
                  <span className="folder-row-meta">
                    {it.isDir ? '文件夹' : (fmtFileSize(it.size) || '文件')}
                  </span>
                </div>
              ))}
              {folderCard.data.truncated > 0 && (
                <div className="folder-card-more">
                  还有 {folderCard.data.truncated} 项未列出（打开文件夹查看）
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* 拖入提示 / 拖放结果提示：脱离滚动容器定位在 Dock 外侧（不被裁剪） */}
      {(fileDragOver || dropHint) && (
        <div className={`drop-hint${fileDragOver ? ' active' : ''}`}>
          {fileDragOver ? '松开即添加' : dropHint}
        </div>
      )}

      {/* 新增按钮下拉菜单：渲染在滚动容器之外（脱离 overflow 裁剪）。
          锚点：水平居中对齐「添加」按钮，菜单底边在按钮上方 8px。 */}
      {menuPos && (
        <div
          ref={menuRef}
          className="dropdown-menu"
          style={{
            // 水平钳制在窗口内：菜单以按钮中心为锚点居中，若按钮靠近窗口右缘，
            // 菜单会伸出窗口被裁掉右角（圆角变直角）。钳到距边缘 100px 内保证完整。
            left: Math.min(Math.max(menuPos.cx, 100), window.innerWidth - 100),
            // 贴边锚点与右键菜单一致（Dock 毛玻璃条外侧 8px）——若锚在「+」按钮内侧，
            // 菜单边会正好贴在玻璃条边上，看起来完全没有间距
            ...overlayAnchor,
            transform: 'translateX(-50%)'
          }}
        >
          <button className="dropdown-item" onClick={handleAdd}>
            添加快捷方式
          </button>
          <button className="dropdown-item" onClick={handleAddFolder}>
            添加文件夹
          </button>
          <div className="dropdown-divider" />
          <button className="dropdown-item" onClick={handleToggleDesktopIcons}>
            {desktopIconsHidden ? '显示桌面图标' : '隐藏桌面图标'}
          </button>
          <button className="dropdown-item" onClick={handleToggleAutoStart}>
            <span>开机自启动</span>
            {/* 开关指示器：开=绿色轨道+圆球在右，关=灰色轨道+圆球在左；纯展示，点击整个菜单项切换 */}
            <span className={`item-switch${autoStart ? ' on' : ''}`} />
          </button>
          <div className="dropdown-divider" />
          {/* 停靠位置分段选择器（中间 / 下 / 上）：切换由主进程原地应用
              （横向三档尺寸相同 → setBounds + 布局事件，约 60ms、不重载页面）；
              位置只由预设决定，点哪一档就归到那一档的标准位置 */}
          <div className="theme-seg" role="group" aria-label="Dock 停靠位置">
            {DOCK_EDGE_CHOICES.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                className={'theme-seg-btn' + (edge === value ? ' active' : '')}
                onClick={() => handleEdgePick(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="dropdown-divider" />
          {/* 主题分段选择器（纯 flex 分段控件，无绝对定位）：主行 透明|毛玻璃，
              毛玻璃激活时下方展开 黑夜|白天 子行；选择后菜单保持打开可连续预览 */}
          <div className="theme-seg" role="group" aria-label="主题背景">
            <button
              type="button"
              className={'theme-seg-btn' + (theme === 'transparent' ? ' active' : '')}
              onClick={() => handleThemePick('transparent')}
            >
              透明
            </button>
            <button
              type="button"
              className={'theme-seg-btn' + (theme !== 'transparent' ? ' active' : '')}
              onClick={() => handleThemePick(glassPlan)}
            >
              毛玻璃
            </button>
          </div>
          <div
            className={'theme-seg-sub' + (theme === 'transparent' ? ' hidden' : '')}
            role="radiogroup"
            aria-label="毛玻璃子主题"
          >
            <button
              type="button"
              className={'theme-seg-btn' + (glassPlan === 'dark' ? ' active' : '')}
              onClick={() => handleThemePick('dark')}
            >
              黑夜
            </button>
            <button
              type="button"
              className={'theme-seg-btn' + (glassPlan === 'light' ? ' active' : '')}
              onClick={() => handleThemePick('light')}
            >
              白天
            </button>
          </div>
        </div>
      )}

      {contextMenu && (
        <div
          ref={ctxRef}
          className="context-menu"
          style={{
            // 定位：默认在光标右侧展开，但让**光标落在菜单内侧 8px**（left: x - 8）
            // 这样「鼠标垂直往上移」就能直接进入菜单；原先 left: x + 4 让光标停在菜单左缘
            // 之外，必须向右偏一点才进得去，一偏一收就触发「移出即关」而秒关
            // 靠近窗口右缘时翻转为贴右缘向左展开（同样让光标落在内侧 8px）
            ...(contextMenu.x + 4 + (editingId === contextMenu.appId ? 280 : 170) > window.innerWidth
              ? { right: Math.max(8, window.innerWidth - contextMenu.x - 8) }
              : { left: Math.max(4, contextMenu.x - 8) }),
            // 朝 Dock 外侧弹出，贴边贴在玻璃栏外侧 8px（锚在光标上的话，光标位于图标内部，
            // 菜单边会压进 Dock 栏里）；高度上限按「未加高」的窗口算（右键菜单不做 resize，
            // 避免透明窗口白闪），菜单项多时内部滚动
            ...overlayAnchor
          }}
        >
          {viewCtxApp?.isSeparator ? (
            // 分隔线自己的菜单：只有删除
            <button className="context-menu-item" onClick={() => handleDelete(viewCtxApp.id)}>删除</button>
          ) : editingId === contextMenu.appId && viewCtxApp ? (
            <>
              <div className="edit-fields">
                <label className="edit-label">
                  名称
                  <input
                    className="edit-input"
                    value={editFields.description}
                    onChange={(e) => setEditFields({ ...editFields, description: e.target.value })}
                    placeholder={viewCtxApp.description || '名称'}
                  />
                </label>
                {/* 分组没有启动参数/工作目录，表单只留名称 + 图标 */}
                {!viewCtxApp.isGroup && (
                  <>
                    <label className="edit-label">
                      参数
                      <input
                        className="edit-input"
                        value={editFields.arguments}
                        onChange={(e) => setEditFields({ ...editFields, arguments: e.target.value })}
                        placeholder="启动参数（可留空）"
                      />
                    </label>
                    <label className="edit-label">
                      工作目录
                      <input
                        className="edit-input"
                        value={editFields.workingDirectory}
                        onChange={(e) => setEditFields({ ...editFields, workingDirectory: e.target.value })}
                        placeholder="工作目录（可留空）"
                      />
                    </label>
                  </>
                )}
              </div>
              <div className="edit-actions">
                <button className="context-menu-item edit-action" onClick={handlePickIcon}>更换图标</button>
                <button className="context-menu-item edit-action" onClick={handleSaveEdit}>保存</button>
                <button className="context-menu-item edit-action" onClick={handleCancelEdit}>取消</button>
              </div>
            </>
          ) : viewCtxApp?.isGroup ? (
            <>
              <button className="context-menu-item" onClick={() => handleEdit(viewCtxApp)}>编辑</button>
              <div className="context-menu-divider" />
              <button className="context-menu-item" onClick={() => handleDissolveGroup(viewCtxApp.id)}>解散分组</button>
            </>
          ) : (
            <>
              {viewCtxApp && (
                <>
                  <button className="context-menu-item" onClick={() => handleEdit(viewCtxApp)}>编辑</button>
                  {isFileSystemPath(viewCtxApp) && (
                    <button className="context-menu-item" onClick={() => handleOpenLocation(viewCtxApp)}>打开文件位置</button>
                  )}
                  {!viewCtxApp.isFolder && !viewCtxApp.specialType && isFileSystemPath(viewCtxApp) && (
                    <button className="context-menu-item" onClick={() => handleRunAdmin(viewCtxApp)}>以管理员身份运行</button>
                  )}
                  {viewCtxApp.targetPath && (
                    <button className="context-menu-item" onClick={() => handleCopyPath(viewCtxApp)}>复制路径</button>
                  )}
                  <button className="context-menu-item" onClick={handleCreateGroup}>新建分组</button>
                  <button className="context-menu-item" onClick={() => handleInsertSeparator(viewCtxApp.id)}>在此之前插入分隔线</button>
                  <div className="context-menu-divider" />
                </>
              )}
              <button className="context-menu-item" onClick={() => handleDelete(contextMenu.appId!)}>删除</button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default App
