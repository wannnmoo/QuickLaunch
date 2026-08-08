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

function App(): React.ReactElement {
  const [apps, setApps] = useState<AppEntry[]>([])
  // 新增按钮下拉菜单的锚点位置（按钮中心 x + 按钮顶部 y，视口坐标）；null 表示关闭。
  // 菜单渲染在 Dock 滚动容器之外（fixed 定位），否则会被滚动容器的 overflow 裁剪。
  const [menuPos, setMenuPos] = useState<{ cx: number; top: number } | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; appId: number } | null>(null)
  // 横向滚动边界状态：true 表示该侧还有图标未显示，用于显示渐隐提示
  const [scrollState, setScrollState] = useState({ left: false, right: false })
  // 桌面图标当前是否隐藏（决定菜单项文案「隐藏/显示桌面图标」）
  const [desktopIconsHidden, setDesktopIconsHidden] = useState(false)

  const menuRef = useRef<HTMLDivElement>(null)
  const ctxRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const dockInnerRef = useRef<HTMLDivElement>(null)
  const addBtnRef = useRef<HTMLDivElement>(null)
  const iconRefs = useRef<Map<number, HTMLDivElement>>(new Map())

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
    el.scrollLeft += e.deltaY + e.deltaX
  }

  // ─── Add handlers ─────────────────────────────────────────────────────

  const pushEntry = (entry: Omit<AppEntry, 'id'>) =>
    setApps((prev) => [...prev, { ...entry, id: nextId++ }])

  async function doAdd<T>(fn: () => Promise<T | null>, map: (r: T) => Omit<AppEntry, 'id'>) {
    setMenuPos(null)
    try {
      const result = await fn()
      if (result) pushEntry(map(result))
    } catch { /* ignore */ }
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
    // 打开菜单时同步桌面图标当前状态（决定菜单项文案）
    window.api.getDesktopIconsHidden().then(setDesktopIconsHidden).catch(() => {})
  }

  // 切换桌面图标显隐（方案 1：写注册表 HideIcons + SHChangeNotify 刷新）
  const handleToggleDesktopIcons = () => {
    // 乐观更新：点击立即切换菜单文案，避免"点了没反应"的观感；IPC 结果再校正
    const target = !desktopIconsHidden
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

  const handleAdd = () => doAdd(
    () => window.api.parseLnk(),
    (r) => ({ iconDataUrl: r.iconDataUrl, targetPath: r.targetPath, arguments: r.arguments, workingDirectory: r.workingDirectory, description: r.description })
  )

  const handleAddFolder = () => doAdd(
    () => window.api.selectFolder(),
    (r) => ({ iconDataUrl: r.iconDataUrl, targetPath: r.path, arguments: '', workingDirectory: '', description: r.name, isFolder: true })
  )

  const handleAddSpecial = (type: 'this-pc' | 'recycle-bin') => doAdd(
    () => window.api.addSpecialItem(type),
    (r) => ({ iconDataUrl: r.iconDataUrl, targetPath: r.path, arguments: '', workingDirectory: '', description: r.name, specialType: r.specialType as 'this-pc' | 'recycle-bin' })
  )

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
    setContextMenu({ x: e.clientX, y: e.clientY, appId: id })
  }

  const handleDelete = (id: number) => {
    setContextMenu(null)
    setApps((prev) => prev.filter((a) => a.id !== id))
  }

  // ─── Persistence ──────────────────────────────────────────────────────

  useEffect(() => {
    window.api.loadShortcuts().then((saved) => {
      if (saved && saved.length > 0) {
        setApps(saved)
        nextId = Math.max(-1, ...saved.map((a) => a.id)) + 1
      }
    })
  }, [])

  useEffect(() => {
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

  return (
    <div
      className="app"
      onMouseEnter={() => window.api.dockPointer(true)}
      onMouseLeave={() => window.api.dockPointer(false)}
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
            left: menuPos.cx,
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
          <button className="dropdown-item" onClick={() => handleAddSpecial('this-pc')}>
            此电脑
          </button>
          <button className="dropdown-item" onClick={() => handleAddSpecial('recycle-bin')}>
            回收站
          </button>
          <div className="dropdown-divider" />
          <button className="dropdown-item" onClick={handleToggleDesktopIcons}>
            {desktopIconsHidden ? '显示桌面图标' : '隐藏桌面图标'}
          </button>
        </div>
      )}

      {apps.length === 0 && (
        <p className="hint">点击 + 添加</p>
      )}

      {contextMenu && (
        <div
          ref={ctxRef}
          className="context-menu"
          style={{ left: contextMenu.x + 4, top: contextMenu.y - 8 }}
        >
          <button className="context-menu-item" onClick={() => handleDelete(contextMenu.appId)}>
            删除
          </button>
        </div>
      )}
    </div>
  )
}

export default App
