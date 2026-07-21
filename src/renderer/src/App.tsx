import { useState, useEffect } from 'react'

interface AppEntry {
  id: number
  iconDataUrl: string
  targetPath: string
  arguments: string
  workingDirectory: string
  description: string
  isFolder?: boolean
}

let nextId = 0

function App(): React.ReactElement {
  const [apps, setApps] = useState<AppEntry[]>([])

  const handleAdd = async () => {
    try {
      const result = await window.api.parseLnk()
      if (!result) return
      setApps((prev) => [
        ...prev,
        {
          id: nextId++,
          iconDataUrl: result.iconDataUrl,
          targetPath: result.targetPath,
          arguments: result.arguments,
          workingDirectory: result.workingDirectory,
          description: result.description
        }
      ])
    } catch {
      // ignore
    }
  }

  const handleAddFolder = async () => {
    try {
      const result = await window.api.selectFolder()
      if (!result) return
      setApps((prev) => [
        ...prev,
        {
          id: nextId++,
          iconDataUrl: result.iconDataUrl,
          targetPath: result.path,
          arguments: '',
          workingDirectory: '',
          description: result.name,
          isFolder: true
        }
      ])
    } catch {
      // ignore
    }
  }

  const handleRun = (app: AppEntry) => {
    window.api.runApp(app.targetPath, app.arguments, app.workingDirectory)
  }

  const handleContextMenu = (e: React.MouseEvent, id: number) => {
    e.preventDefault()
    setApps((prev) => prev.filter((a) => a.id !== id))
  }

  // Load persisted shortcuts on startup
  useEffect(() => {
    window.api.loadShortcuts().then((saved) => {
      if (saved && saved.length > 0) {
        setApps(saved)
        nextId = Math.max(-1, ...saved.map((a) => a.id)) + 1
      }
    })
  }, [])

  // Auto-save whenever apps change
  useEffect(() => {
    window.api.saveShortcuts(apps)
  }, [apps])

  return (
    <div className="app">
      <header className="app-header">
        <h1>快捷方式面板</h1>
        <div className="header-buttons">
          <button className="btn" onClick={handleAdd}>
            + 添加快捷方式
          </button>
          <button className="btn btn-folder" onClick={handleAddFolder}>
            + 添加文件夹
          </button>
        </div>
      </header>

      {apps.length > 0 && (
        <div className="icon-grid">
          {apps.map((app) => (
            <div
              key={app.id}
              className="icon-card"
              title="左键启动 | 右键删除"
              onClick={() => handleRun(app)}
              onContextMenu={(e) => handleContextMenu(e, app.id)}
            >
              <img className="app-icon" src={app.iconDataUrl} alt="" />
              <span className="icon-label">{app.description || '未命名'}</span>
            </div>
          ))}
        </div>
      )}

      {apps.length === 0 && (
        <p className="hint">点击上方按钮添加一个快捷方式</p>
      )}
    </div>
  )
}

export default App
