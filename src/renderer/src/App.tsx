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
}

let nextId = 0

// 桌面扫描去重：路径规范化（去尾部反斜杠 + 小写），Windows 路径大小写不敏感
const normPath = (p: string): string => (p || '').trim().replace(/\\+$/, '').toLowerCase()

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
  const dockInnerRef = useRef<HTMLDivElement>(null)
  const addBtnRef = useRef<HTMLDivElement>(null)
  const iconRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  // 菜单打开期间用户是否已手动切换过开关：防止过期的异步读取（getAutoStart /
  // getDesktopIconsHidden）覆盖乐观更新的状态（陈旧响应竞态）
  const autoStartDirtyRef = useRef(false)
  const desktopIconsDirtyRef = useRef(false)

  // ─── Custom drag & drop ───────────────────────────────────────────────

  const dragRef = useRef<{ id: number; idx: number; startX: number; startY: number } | null>(null)
  // 本次交互是否已越过 5px 阈值成为真实拖拽（同步 ref，不依赖 state 时序）
  const dragStartedRef = useRef(false)
  // 拖拽结束后吞掉紧随其后的 click，防止误启动图标
  const suppressClickRef = useRef(false)
  const [dragId, setDragId] = useState<number | null>(null)
  const [dropIdx, setDropIdx] = useState<number | null>(null)

  // Calculate which insertion index the cursor is closest to
  const calcDropIndex = useCallback((clientX: number): number => {
    const dock = dockRef.current
    if (!dock) return apps.length
    const dockRect = dock.getBoundingClientRect()
    const mx = clientX - dockRect.left

    // Build sorted list of icon centers paired with their array index
    const centers: { idx: number; cx: number }[] = []
    iconRefs.current.forEach((el, id) => {
      const rect = el.getBoundingClientRect()
      const cx = rect.left - dockRect.left + rect.width / 2
      const found = apps.findIndex((a) => a.id === id)
      if (found !== -1) centers.push({ idx: found, cx })
    })
    centers.sort((a, b) => a.cx - b.cx)

    // Find where the cursor falls between/around icon centers
    for (let i = 0; i < centers.length; i++) {
      if (mx < centers[i].cx) return i
    }
    return centers.length
  }, [apps])

  // Global mouseup to finalize drop (fires even outside the window)
  useEffect(() => {
    const handleMouseUp = () => {
      const drag = dragRef.current
      dragRef.current = null
      if (!drag) return

      // 真实拖拽结束时，吞掉紧随其后的 click——click 在 mouseup 之后派发，
      // 此时 setDragId(null) 已生效，handleRun 的 dragId 判断不再可靠
      if (dragStartedRef.current) {
        suppressClickRef.current = true
        dragStartedRef.current = false
      }

      const { idx } = drag
      const target = dropIdx

      if (target !== null && target !== idx) {
        setApps((prev) => {
          const items = [...prev]
          let to = target
          if (idx < to) to--
          const [removed] = items.splice(idx, 1)
          items.splice(to, 0, removed)
          return items
        })
      }

      setDragId(null)
      setDropIdx(null)
    }

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return
      // Start dragging after 5px threshold
      const dx = e.clientX - dragRef.current.startX
      const dy = e.clientY - dragRef.current.startY
      if (!dragStartedRef.current && Math.abs(dx) < 5 && Math.abs(dy) < 5) return

      if (!dragStartedRef.current) {
        dragStartedRef.current = true
        setDragId(dragRef.current.id)
      }
      setDropIdx(calcDropIndex(e.clientX))
    }

    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('mousemove', handleMouseMove)
    return () => {
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('mousemove', handleMouseMove)
    }
  }, [dropIdx, calcDropIndex])

  const handleIconMouseDown = useCallback((e: React.MouseEvent, id: number, idx: number) => {
    if (e.button !== 0) return // left-click only
    dragRef.current = { id, idx, startX: e.clientX, startY: e.clientY }
    // 新交互开始，清除上一次拖拽遗留的 click 抑制标记，避免误吞本次点击
    suppressClickRef.current = false
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
  useEffect(() => {
    if (!menuPos && !contextMenu) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const clear = () => {
      if (timer) { clearTimeout(timer); timer = undefined }
    }
    const scheduleClose = () => {
      clear()
      timer = setTimeout(() => {
        setMenuPos(null)
        setContextMenu(null)
      }, 120)
    }
    const handleMouseMove = (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const inMenu = menuRef.current ? menuRef.current.contains(el) : false
      // 鼠标停在「添加」按钮上也保持菜单打开
      const inBtn = addBtnRef.current ? addBtnRef.current.contains(el) : false
      const inCtx = ctxRef.current ? ctxRef.current.contains(el) : false
      if (inMenu || inBtn || inCtx) clear()
      else scheduleClose()
    }
    const handleWindowLeave = () => {
      clear()
      setMenuPos(null)
      setContextMenu(null)
    }
    document.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseleave', handleWindowLeave)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseleave', handleWindowLeave)
      clear()
    }
  }, [menuPos, contextMenu])

  // ─── Dock magnification ───────────────────────────────────────────────

  const handleDockMouseMove = useCallback((e: React.MouseEvent) => {
    if (dragId !== null) return // disable magnification during drag
    const dock = dockRef.current
    if (!dock) return
    const dockRect = dock.getBoundingClientRect()
    const mx = e.clientX - dockRect.left

    iconRefs.current.forEach((el) => {
      const rect = el.getBoundingClientRect()
      const cx = rect.left - dockRect.left + rect.width / 2
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
  }, [dragId])

  const handleDockMouseLeave = useCallback(() => {
    iconRefs.current.forEach((el) => {
      el.style.transform = ''
      el.style.zIndex = ''
    })
  }, [])

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

  const handleDockWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = dockInnerRef.current
    if (!el) return
    e.preventDefault()
    // 取位移较大的轴，避免触控板斜向滚动时 deltaY+deltaX 双倍位移
    el.scrollLeft += Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX
  }

  // ─── Add handlers ─────────────────────────────────────────────────────

  // id 在 updater 外分配：React.StrictMode 会双调用 updater 检测副作用，
  // 若在 updater 内 nextId++ 会被执行两次（跳号，虽无功能影响但属不纯写法）
  const pushEntry = (entry: Omit<AppEntry, 'id'>) => {
    const id = nextId++
    setApps((prev) => [...prev, { ...entry, id }])
  }

  // 打开/关闭新增菜单，记录「添加」按钮的视口坐标作为菜单锚点
  const handleAddToggle = () => {
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
  }

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

  const handleRun = useCallback((app: AppEntry) => {
    // 拖拽进行中，禁止点击启动
    if (dragId !== null) return
    // 拖拽刚结束（mouseup 后的 click）：吞掉本次点击，避免误启动
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    window.api.runApp(app.targetPath, app.arguments, app.workingDirectory)
  }, [dragId])

  const handleContextMenu = (e: React.MouseEvent, id: number) => {
    e.preventDefault()
    setEditingId(null)
    setContextMenu({ x: e.clientX, y: e.clientY, appId: id })
  }

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
      const entries = fresh.map((f) => ({
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
  useEffect(() => {
    updateScrollState()
  }, [apps, updateScrollState])

  // ─── Render helpers ───────────────────────────────────────────────────

  const getItemClass = (id: number) => {
    let cls = 'dock-item'
    if (dragId === id) cls += ' dragging'
    return cls
  }

  // 右键菜单对应的条目（编辑表单与菜单动作共用）
  const ctxApp = contextMenu ? apps.find((a) => a.id === contextMenu.appId) : undefined

  return (
    <div
      className={theme === 'light' ? 'app theme-light' : theme === 'transparent' ? 'app theme-transparent' : 'app'}
      onMouseEnter={() => window.api.dockPointer(true)}
    >
      <div
        className="dock"
        ref={dockRef}
        onMouseMove={handleDockMouseMove}
        onMouseLeave={handleDockMouseLeave}
      >
        {/* 毛玻璃背景独立层：只覆盖图标区（图标在其中垂直居中，上下间距小）。
            顶部放大留白区是透明的，hover 放大时图标会顶出背景之上（类似 macOS）。 */}
        <div className="dock-bg" />
        <div
          className="dock-inner"
          ref={dockInnerRef}
          onWheel={handleDockWheel}
          onScroll={updateScrollState}
        >
          {dropIdx === 0 && <div className="drop-indicator" />}

          {apps.map((app, idx) => (
            <div key={app.id} style={{ display: 'contents' }}>
              <div
                className={getItemClass(app.id)}
                ref={(el) => {
                  if (el) iconRefs.current.set(app.id, el)
                  else iconRefs.current.delete(app.id)
                }}
                onMouseDown={(e) => handleIconMouseDown(e, app.id, idx)}
                onClick={() => handleRun(app)}
                onContextMenu={(e) => handleContextMenu(e, app.id)}
                title={app.description}
              >
                <div className="dock-icon-wrap">
                  <img className="dock-icon" src={app.iconDataUrl} alt="" draggable={false} />
                </div>
                <span className="dock-label">{app.description || '未命名'}</span>
              </div>
              {dropIdx === idx + 1 && dragId !== app.id && (
                <div className="drop-indicator" />
              )}
            </div>
          ))}

          {/* Add button */}
          <div className="dock-item dock-add" ref={addBtnRef}>
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
            bottom: window.innerHeight - menuPos.top + 8,
            transform: 'translateX(-50%)',
            // 菜单不超过「添加」按钮上方空间，否则顶部会超出 300px 窗口被裁掉
            maxHeight: menuPos.top - 8
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
            // 同样钳制在窗口内，防止右缘被裁掉圆角
            left: Math.min(Math.max(contextMenu.x + 4, 60), window.innerWidth - 60),
            // 参考「+」按钮下拉菜单：向上弹出（bottom 对齐光标上方 8px）——
            // 300px 窗口内 Dock 在底部，向下弹会被窗口下边界裁掉
            bottom: window.innerHeight - contextMenu.y + 8,
            // 菜单不超过光标上方空间，超出时内部滚动
            maxHeight: contextMenu.y - 8
          }}
        >
          {editingId === contextMenu.appId && ctxApp ? (
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
              </div>
              <div className="edit-actions">
                <button className="context-menu-item edit-action" onClick={handlePickIcon}>更换图标</button>
                <button className="context-menu-item edit-action" onClick={handleSaveEdit}>保存</button>
                <button className="context-menu-item edit-action" onClick={handleCancelEdit}>取消</button>
              </div>
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
                  <div className="context-menu-divider" />
                </>
              )}
              <button className="context-menu-item" onClick={() => handleDelete(contextMenu.appId)}>删除</button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default App
