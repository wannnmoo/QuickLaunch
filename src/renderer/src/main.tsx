import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ErrorBoundary from './ErrorBoundary'
import SettingsApp from './settings/SettingsApp'
import './App.css'
import './settings/settings.css'

// ─── 同一份产物，两种视图 ──────────────────────────────────────────────────
// 设置中心**不是**第二个 HTML 页面，而是本页的 `?view=settings` 视图。
//
// 为什么（改这里先读）：electron-vite 5.0.0 的 renderer 预设
// （node_modules/electron-vite/dist/chunks/lib-q6ns0vZr.js:526-543）会先算
// `defaultConfig.build.rollupOptions.input = findInput(root)`，而 findInput 返回的是
// **单个路径字符串**；随后 `mergeConfig(defaultConfig.build, config.build || {})` 合并，
// string 与 object 类型不匹配 → 配置文件里写的多页面 input 被丢掉。实测两种写法
// （写在 renderer.build 里 / 用一个 enforce:'post' 插件注入）产物都只有 index.html，
// `loadFile('settings.html')` 会静默白屏。既然入口只有一个，就用 query 分支：
//   - 渲染进程侧：`?view=settings` → 只挂 <SettingsApp/>，不挂 <App/>（Dock 的 DOM 根本不存在）
//   - 主进程侧：src/main/settingsWindow.ts 用 `loadFile(index.html, { query: { view: 'settings' } })`
// 代价是设置窗也会加载 Dock 的 CSS/JS（同一份 bundle）；settings.css 的全局规则
// 因此全部收在 `html[data-win='settings']` 下面，不会把 Dock 窗口刷成不透明。
const isSettingsView = ((): boolean => {
  try {
    const q = new URLSearchParams(window.location.search)
    if (q.get('view') === 'settings') return true
    // hash 兜底：手工用 #settings 打开（调试时方便）
    return window.location.hash === '#settings'
  } catch {
    return false
  }
})()

if (isSettingsView) {
  // 这个标记让 settings.css 里那几条 html/body 规则生效（Dock 窗口没有它）
  document.documentElement.dataset.win = 'settings'
}

// ─── 渲染端错误上报 ────────────────────────────────────────────────────────
// 打包版没有终端：React 里抛出的异常、失败的 Promise、资源加载错误，
// 用户只会看到「Dock 不动了」。这三条通道把它们送进主进程日志（main.log）。
// ⚠️ 不要在这里做「上报后重新 render」之类的自愈：错误可能来自渲染循环本身，
//    再 render 会把「一次报错」变成「每帧报错」，日志瞬间滚满、CPU 打满。
//    自愈由主进程的崩溃看门狗负责（render-process-gone → 重建窗口）。
const report = (message: string, stack?: string, source?: string): void => {
  try {
    window.api?.reportError({ message, stack, source })
  } catch {
    /* preload 还没就绪（极早期错误）：只能留在控制台 */
  }
}

window.addEventListener('error', (e) => {
  // 资源加载失败（img/script）也走这里，但 e.error 为空：照样记一行，看得出是哪个 URL
  report(
    e.error instanceof Error ? e.error.message : `resource error: ${e.message || 'unknown'}`,
    e.error instanceof Error ? e.error.stack : undefined,
    isSettingsView
      ? 'settings-window'
      : e.filename
        ? `${e.filename}:${e.lineno}:${e.colno}`
        : undefined
  )
})

window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason
  report(
    reason instanceof Error ? `unhandled rejection: ${reason.message}` : `unhandled rejection: ${String(reason)}`,
    reason instanceof Error ? reason.stack : undefined,
    isSettingsView ? 'settings-window' : undefined
  )
})

if (isSettingsView) {
  // Esc 关窗由 SettingsApp 自己处理（它需要知道当前窗口是不是设置窗）
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <SettingsApp />
    </React.StrictMode>
  )
} else {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  )
}
