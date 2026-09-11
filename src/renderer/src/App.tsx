import { useState, useEffect, useRef, useCallback } from 'react'

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

// 分组面板底部间距：Dock 高度 146 + 8px 间隙
const PANEL_BOTTOM = 154
// 窗口高度（与主进程 createWindow 的 300 一致）。右键菜单不改变窗口尺寸
// 高度上限按这个基准算，超出时内部滚动——避免透明窗口 resize 的白闪
const BASE_WINDOW_H = 300

// 外部拖入的是「文件」而非页面内元素/文本：DataTransfer.types 里含 'Files'
const isFileDragEvent = (e: React.DragEvent): boolean =>
  Array.from(e.dataTransfer?.types ?? []).includes('Files')

function App(): React.ReactElement {
  const [apps, setApps] = useState<AppEntry[]>([])
  // 新增按钮下拉菜单的锚点位置（按钮中心 x + 按钮顶部 y，视口坐标）；null 表示关闭。
  // 菜单渲染在 Dock 滚动容器之外（fixed 定位），否则会被滚动容器的 overflow 裁剪。
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

  const menuRef = useRef<HTMLDivElement>(null)
  const ctxRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const dockBgRef = useRef<HTMLDivElement>(null)
  const dockInnerRef = useRef<HTMLDivElement>(null)
  const addBtnRef = useRef<HTMLDivElement>(null)
  const iconRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  // 菜单打开期间用户是否已手动切换过开关：防止过期的异步读取（getAutoStart /
  // getDesktopIconsHidden）覆盖乐观更新的状态（陈旧响应竞态）
  const autoStartDirtyRef = useRef(false)
  const desktopIconsDirtyRef = useRef(false)

  // ─── Custom drag & drop ───────────────────────────────────────────────

  const dragRef = useRef<{ id: number; startX: number; startY: number } | null>(null)
  // 本次交互是否已越过 5px 阈值成为真实拖拽（同步 ref，不依赖 state 时序）
  const dragStartedRef = useRef(false)
  // 拖拽结束后吞掉紧随其后的 click，防止误启动图标
  const suppressClickRef = useRef(false)
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

  // Calculate which insertion index the cursor is closest to
  // 返回的是「位置」（在渲染出来的顶层图标中排序后的下标），不是数组下标
  // 组内成员不在 Dock 里渲染，所以这里与 topAnchorId 的下标空间一致
  const calcDropIndex = useCallback((clientX: number): number => {
    const dock = dockRef.current
    if (!dock) return iconRefs.current.size
    const dockRect = dock.getBoundingClientRect()
    const mx = clientX - dockRect.left

    const centers: number[] = []
    iconRefs.current.forEach((el) => {
      const rect = el.getBoundingClientRect()
      centers.push(rect.left - dockRect.left + rect.width / 2)
    })
    centers.sort((a, b) => a - b)

    // Find where the cursor falls between/around icon centers
    for (let i = 0; i < centers.length; i++) {
      if (mx < centers[i]) return i
    }
    return centers.length
  }, [])

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
    }

    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('mousemove', handleMouseMove)
    return () => {
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('mousemove', handleMouseMove)
    }
  }, [calcDropIndex, hitTestGroup])

  const handleIconMouseDown = useCallback((e: React.MouseEvent, id: number) => {
    if (e.button !== 0) return // left-click only
    dragRef.current = { id, startX: e.clientX, startY: e.clientY }
    // 新交互开始，清除上一次拖拽遗留的 click 抑制标记，避免误吞本次点击
    suppressClickRef.current = false
    // 鼠标接管 → 退出键盘导航
    setNavId(null)
  }, [])

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
    const handleMouseMove = (e: MouseEvent) => {
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
    const handleWindowLeave = () => closeMenus()
    document.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseleave', handleWindowLeave)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseleave', handleWindowLeave)
    }
  }, [menuPos, contextMenu])

  // ─── Dock magnification（主 Dock 与分组面板共用：面板就是迷你 Dock） ───

  const magnify = useCallback((container: HTMLElement | null, refs: Map<number, HTMLDivElement>, clientX: number) => {
    if (!container) return
    const box = container.getBoundingClientRect()
    const mx = clientX - box.left
    refs.forEach((el) => {
      if (el.dataset.sep) return // 分隔线不参与放大
      const rect = el.getBoundingClientRect()
      const cx = rect.left - box.left + rect.width / 2
      const dist = Math.abs(mx - cx)
      const maxDist = 140
      const maxExtra = 0.4
      if (dist < maxDist) {
        const s = 1 + (1 - dist / maxDist) * maxExtra
        const y = -(dist < maxDist * 0.6 ? (1 - dist / (maxDist * 0.6)) * 8 : 0)
        el.style.transform = `scale(${s}) translateY(${y}px)`
        el.style.zIndex = '10'
      } else {
        el.style.transform = ''
        el.style.zIndex = ''
      }
    })
  }, [])

  const resetMagnify = useCallback((refs: Map<number, HTMLDivElement>) => {
    refs.forEach((el) => {
      el.style.transform = ''
      el.style.zIndex = ''
    })
  }, [])

  const handleDockMouseMove = useCallback((e: React.MouseEvent) => {
    if (dragId !== null) return // disable magnification during drag
    magnify(dockRef.current, iconRefs.current, e.clientX)
  }, [dragId, magnify])

  const handleDockMouseLeave = useCallback(() => {
    resetMagnify(iconRefs.current)
  }, [resetMagnify])

  const handlePanelMouseMove = useCallback((e: React.MouseEvent) => {
    if (dragId !== null) return
    magnify(panelInnerRef.current, panelIconRefs.current, e.clientX)
  }, [dragId, magnify])

  const handlePanelMouseLeave = useCallback(() => {
    resetMagnify(panelIconRefs.current)
  }, [resetMagnify])

  // ─── Horizontal scroll (icon overflow) ──────────────────────────────
  // 图标超过 Dock 宽度时，滚动容器横向滚动，滚轮 / 触控板左右滑动查看。
  // 两端渐隐遮罩提示还有更多图标（可滚动的那一侧显示）。

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
    // 落点指示线复用拖拽排序的 dropIdx（与内部拖拽不会同时发生）
    setDropIdx(calcDropIndex(e.clientX))
  }

  const handleDockDragLeave = (e: React.DragEvent) => {
    if (!isFileDragEvent(e)) return
    // 在 Dock 内部子元素之间移动也会触发 dragleave，relatedTarget 仍在 Dock 内则忽略
    const next = e.relatedTarget as Node | null
    if (next && e.currentTarget.contains(next)) return
    setFileDragOver(false)
    setDropIdx(null)
  }

  const handleDockDrop = async (e: React.DragEvent) => {
    if (!isFileDragEvent(e)) return
    e.preventDefault()
    const at = calcDropIndex(e.clientX)
    setFileDragOver(false)
    setDropIdx(null)

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

  // id 在 updater 外分配：React.StrictMode 会双调用 updater 检测副作用，
  // 若在 updater 内 nextId++ 会被执行两次（跳号，虽无功能影响但属不纯写法）
  const pushEntry = (entry: Omit<AppEntry, 'id'>) => {
    const id = nextId++
    setApps((prev) => [...prev, { ...entry, id }])
  }

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
    window.api.runApp(app.targetPath, app.arguments, app.workingDirectory)
  }, [dragId, openGroupId, closeGroupPanel])

  // 右键条目：stopPropagation 防止冒泡到 .dock 的空白区菜单（否则两个菜单状态互相覆盖）
  const handleContextMenu = (e: React.MouseEvent, id: number) => {
    e.preventDefault()
    e.stopPropagation()
    setEditingId(null)
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

  // 浮层底边锚点：分组面板与右键菜单都贴在 Dock 毛玻璃条上方 8px
  // 用实测的 .dock-bg 位置而非硬编码常量——布局改动后自动跟随
  const overlayBottom = useCallback(() => {
    const barTop = dockBgRef.current?.getBoundingClientRect().top
    return barTop === undefined ? PANEL_BOTTOM : window.innerHeight - barTop + 8
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
  useEffect(() => {
    const unsubscribe = window.api.onNavEnter(() => {
      closeGroupPanel() // 回到主 Dock 层
      setNavId(resumeNavId(appsRef.current))
    })
    return unsubscribe
  }, [closeGroupPanel, resumeNavId])

  // 启动即进入导航模式：恢复到上次的位置（首次运行则是第一个图标）
  // 名单可能来自 shortcuts.json，也可能首启时由桌面扫描补上，所以等第一个顶层条目出现再选
  const navInitRef = useRef(false)
  useEffect(() => {
    if (navInitRef.current) return
    const first = apps.find((a) => !a.groupId && !a.isSeparator)
    if (!first) return
    navInitRef.current = true
    // 传当前渲染的 apps（而非 appsRef）：此处镜像 effect 尚未跑过本轮数据
    setNavId(resumeNavId(apps))
  }, [apps, resumeNavId])

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
  }, [navId, openGroupId, contextMenu, menuPos, closeGroupPanel, handleAddToggle])

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

  // 最新列表镜像 ref：fs.watch 事件回调里避免读到过期闭包里的旧 apps
  const appsRef = useRef<AppEntry[]>([])
  useEffect(() => { appsRef.current = apps }, [apps])
  // 清理/扫描进行中时跳过重复事件（debounce 只聚合了 watch 事件，扫描自身耗时可更长）
  const desktopSyncBusyRef = useRef(false)

  // 合并扫描结果：新增的桌面文件夹 / 指向文件夹的 .lnk / 「此电脑」「回收站」加入 Dock。
  // baseline 用于去重（启动时为已加载列表，实时事件时为当前列表）。去重、排序、id 分配
  // 都在 updater 外完成——StrictMode 双调用 updater 时无副作用；updater 内仍有防御性去重。
  const mergeDesktopScan = useCallback((baseline: AppEntry[]) => {
    return window.api.scanDesktopFolders().then((found) => {
      if (!found || found.length === 0) return
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
        iconDataUrl: f.iconDataUrl,
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

  // 启动：先加载已保存的快捷方式，加载完成后解锁保存，再清理缺失文件夹 + 扫描合并。
  // 顺序（load → prune → scan）链式执行避免竞态——若并行，扫描结果可能被 setApps 覆盖丢失。
  useEffect(() => {
    let cancelled = false
    window.api.loadShortcuts().then((saved) => {
      if (cancelled) return
      if (saved && saved.length > 0) {
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
          await mergeDesktopScan(saved || [])
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
  }, [pruneMissingFolders, mergeDesktopScan])

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

  useEffect(() => {
    // 初始加载完成前不保存（见 loadedRef 注释：防止挂载时 save([]) 清空磁盘数据）
    if (!loadedRef.current) return
    window.api.saveShortcuts(apps)
  }, [apps])

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
  const topLevel = apps.filter((a) => !a.groupId)
  const openGroupMembers = openGroupId === null ? [] : apps.filter((a) => a.groupId === openGroupId)
  const openGroup = openGroupId === null ? undefined : apps.find((a) => a.id === openGroupId)
  // 浮层（面板 / 右键菜单）的底边锚点，渲染时算一次
  const overlayBottomOffset = overlayBottom()
  // 右键菜单的高度上限：Dock 栏上方可用空间（默认窗口高度下约 138px），超出时内部滚动
  const menuAvail = Math.max(120, BASE_WINDOW_H - overlayBottomOffset - 8)
  // 分组 → 成员列表（面板渲染用，含分隔线）
  const groupMembersById = new Map<number, AppEntry[]>()
  // 分组 → 可显示成员（排除分隔线）：分组图标的缩略拼图与数量徽标用它，
  // 否则分隔线会占掉一个拼图格子（空破图）并让计数偏大
  const groupIconMembersById = new Map<number, AppEntry[]>()
  for (const a of apps) {
    if (a.groupId === undefined) continue
    const list = groupMembersById.get(a.groupId)
    if (list) list.push(a)
    else groupMembersById.set(a.groupId, [a])
    if (a.isSeparator) continue
    const iconList = groupIconMembersById.get(a.groupId)
    if (iconList) iconList.push(a)
    else groupIconMembersById.set(a.groupId, [a])
  }

  return (
    <div
      className={theme === 'light' ? 'app theme-light' : theme === 'transparent' ? 'app theme-transparent' : 'app'}
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
          className="dock-inner"
          ref={dockInnerRef}
          onScroll={updateScrollState}
        >
          {dropIdx === 0 && <div className="drop-indicator" />}

          {topLevel.map((app, idx) => (
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
                  title={app.description}
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
                title={app.description}
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
                </div>
                <span className="dock-label">{app.description || '未命名'}</span>
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
      {openGroup && (
        <div
          className="group-panel"
          ref={panelRef}
          style={{
            bottom: overlayBottomOffset,
            // 右键菜单锚在 Dock 栏上方、与面板同处一条带（窗口只有 300px 高，面板上方
            // 只剩十几像素，无法再往上叠）——菜单打开期间藏起面板；菜单一关闭（鼠标移出即关
            // 即关，见菜单自动关闭 effect）面板同帧显示回来，不会出现重叠空档
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
            {openGroupMembers.map((m) => (
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
                  title={m.description}
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
                title={m.description}
              >
                <div className="dock-icon-wrap">
                  <img className="dock-icon" src={m.iconDataUrl} alt="" draggable={false} />
                </div>
                <span className="dock-label">{m.description || '未命名'}</span>
              </div>
              )
            ))}
            {openGroupMembers.length === 0 && (
              <div className="group-panel-empty">
                空分组 —— 把 Dock 上的图标拖到分组图标上即可加入
              </div>
            )}
          </div>
        </div>
      )}

      {/* 拖入提示 / 拖放结果提示：fixed 定位于 Dock 上方（脱离滚动容器，不被裁剪） */}
      {(fileDragOver || dropHint) && (
        <div className={`drop-hint${fileDragOver ? ' active' : ''}`}>
          {fileDragOver ? '松开即添加' : dropHint}
        </div>
      )}

      {/* 新增按钮下拉菜单：渲染在滚动容器之外（fixed 定位），避免被 overflow 裁剪。
          锚点：水平居中对齐「添加」按钮，菜单底边在按钮上方 8px。 */}
      {menuPos && (
        <div
          ref={menuRef}
          className="dropdown-menu"
          style={{
            // 水平钳制在窗口内：菜单以按钮中心为锚点居中，若按钮靠近窗口右缘，
            // 菜单会伸出窗口被裁掉右角（圆角变直角）。钳到距边缘 100px 内保证完整。
            left: Math.min(Math.max(menuPos.cx, 100), window.innerWidth - 100),
            // 底边用与右键菜单相同的锚点（Dock 毛玻璃条上方 8px）——若锚在「+」按钮顶部，
            // 菜单底边正好贴在玻璃条顶边上，看起来完全没有间距
            bottom: overlayBottomOffset,
            transform: 'translateX(-50%)',
            // 不超过 Dock 栏上方可用空间（与右键菜单一致），超出时内部滚动
            maxHeight: menuAvail
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
            // 向上弹出，底边贴在 Dock 毛玻璃栏上方 8px（锚在光标上的话，光标位于图标内部，
            // 菜单底边会压进 Dock 栏里）
            bottom: overlayBottomOffset,
            // 高度上限按「未加高」的窗口算（右键菜单不做 resize，避免透明窗口白闪）；
            // 菜单项多时内部滚动
            maxHeight: menuAvail
          }}
        >
          {ctxApp?.isSeparator ? (
            // 分隔线自己的菜单：只有删除
            <button className="context-menu-item" onClick={() => handleDelete(ctxApp.id)}>删除</button>
          ) : editingId === contextMenu.appId && ctxApp ? (
            <>
              <div className="edit-fields">
                <label className="edit-label">
                  名称
                  <input
                    className="edit-input"
                    value={editFields.description}
                    onChange={(e) => setEditFields({ ...editFields, description: e.target.value })}
                    placeholder={ctxApp.description || '名称'}
                  />
                </label>
                {/* 分组没有启动参数/工作目录，表单只留名称 + 图标 */}
                {!ctxApp.isGroup && (
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
          ) : ctxApp?.isGroup ? (
            <>
              <button className="context-menu-item" onClick={() => handleEdit(ctxApp)}>编辑</button>
              <div className="context-menu-divider" />
              <button className="context-menu-item" onClick={() => handleDissolveGroup(ctxApp.id)}>解散分组</button>
            </>
          ) : (
            <>
              {ctxApp && (
                <>
                  <button className="context-menu-item" onClick={() => handleEdit(ctxApp)}>编辑</button>
                  {isFileSystemPath(ctxApp) && (
                    <button className="context-menu-item" onClick={() => handleOpenLocation(ctxApp)}>打开文件位置</button>
                  )}
                  {!ctxApp.isFolder && !ctxApp.specialType && isFileSystemPath(ctxApp) && (
                    <button className="context-menu-item" onClick={() => handleRunAdmin(ctxApp)}>以管理员身份运行</button>
                  )}
                  {ctxApp.targetPath && (
                    <button className="context-menu-item" onClick={() => handleCopyPath(ctxApp)}>复制路径</button>
                  )}
                  <button className="context-menu-item" onClick={handleCreateGroup}>新建分组</button>
                  <button className="context-menu-item" onClick={() => handleInsertSeparator(ctxApp.id)}>在此之前插入分隔线</button>
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
