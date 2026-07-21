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
  const [menuOpen, setMenuOpen] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; appId: number } | null>(null)

  const menuRef = useRef<HTMLDivElement>(null)
  const ctxRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const iconRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  // ─── Custom drag & drop ───────────────────────────────────────────────

  const dragRef = useRef<{ id: number; idx: number; startX: number; startY: number } | null>(null)
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
      dragRef.current = null // clear immediately so onClick sees no pending drag
      if (!drag) return

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
      if (!dragId && Math.abs(dx) < 5 && Math.abs(dy) < 5) return

      if (!dragId) setDragId(dragRef.current.id)
      setDropIdx(calcDropIndex(e.clientX))
    }

    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('mousemove', handleMouseMove)
    return () => {
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('mousemove', handleMouseMove)
    }
  }, [dragId, dropIdx, calcDropIndex])

  const handleIconMouseDown = useCallback((e: React.MouseEvent, id: number, idx: number) => {
    if (e.button !== 0) return // left-click only
    dragRef.current = { id, idx, startX: e.clientX, startY: e.clientY }
  }, [])

  // Close menus when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

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
      const maxExtra = 0.5
      if (dist < maxDist) {
        const s = 1 + (1 - dist / maxDist) * maxExtra
        const y = -(dist < maxDist * 0.6 ? (1 - dist / (maxDist * 0.6)) * 10 : 0)
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

  // ─── Add handlers ─────────────────────────────────────────────────────

  const pushEntry = (entry: Omit<AppEntry, 'id'>) =>
    setApps((prev) => [...prev, { ...entry, id: nextId++ }])

  async function doAdd<T>(fn: () => Promise<T | null>, map: (r: T) => Omit<AppEntry, 'id'>) {
    setMenuOpen(false)
    try {
      const result = await fn()
      if (result) pushEntry(map(result))
    } catch { /* ignore */ }
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
    // Only block if a drag actually started (moved >5px)
    if (dragId !== null) return
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

  // ─── Render helpers ───────────────────────────────────────────────────

  const getItemClass = (id: number) => {
    let cls = 'dock-item'
    if (dragId === id) cls += ' dragging'
    return cls
  }

  return (
    <div className="app">
      <div
        className="dock"
        ref={dockRef}
        onMouseMove={handleDockMouseMove}
        onMouseLeave={handleDockMouseLeave}
      >
        <div className="dock-inner">
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
          <div className="dock-item dock-add" ref={menuRef}>
            <div
              className="dock-icon-wrap dock-add-btn"
              onClick={() => setMenuOpen((v) => !v)}
            >
              <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                <line x1="14" y1="6" x2="14" y2="22" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                <line x1="6" y1="14" x2="22" y2="14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </div>
            <span className="dock-label">添加</span>

            {menuOpen && (
              <div className="dropdown-menu">
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
              </div>
            )}
          </div>
        </div>
      </div>

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
