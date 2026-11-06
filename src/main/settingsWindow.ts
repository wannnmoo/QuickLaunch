/**
 * 设置中心（独立窗口 480×340）。
 *
 * 为什么必须是独立窗口，而不是继续往「+」菜单里塞：
 *   Dock 窗口只有 300px 高、`resizable: false`、`transparent: true`——透明窗口 resize 会白闪
 *   （见 CLAUDE.md「窗口不可自由拖动」那段）。「+」菜单的可用高度因此只有约 200px，
 *   而设置项已经有 7 组，靠 `.dropdown-scroll` 硬撑的结果是：
 *     · 每一项都被挤成一行（label + 三段），「标准」这类两字标签在 28px 高的胶囊里贴边；
 *     · 用户想连改三项，得在 200px 的滚动区里反复滚，改完还看不见全貌。
 *   独立窗口给到 480×340（最初 760×560 → 720×508 → 现在再收三分之一，用户两次要求更紧凑），
 *   左栏分类 + 右侧表单 + 底部「重置本节」，主菜单顺势瘦回「动作」。
 *
 * 窗口是**透明 + 毛玻璃**（与 Dock 同材质，用户明确要求观感一致）：
 *   - `transparent: true` + `backgroundColor: '#00000000'`，CSS 侧 `.st` 用
 *     `backdrop-filter: blur()`；四角圆角靠 CSS 的 `border-radius`（DWM 不补阴影，故 hasShadow: false）；
 *   - `frame: false` 自绘标题栏，`resizable: true` —— 普通窗口放大缩小不会白闪，没有理由禁；
 *   - 打开时让 Dock 隐藏、关闭时让 Dock 回来（钩子由主进程注入，见 onOpened / onClosed）；
 *   - 加载的是**同一个 index.html**，靠 `?view=settings` 让渲染端只挂 <SettingsApp/>。
 *     ⚠️ 不要试图给这里配一个 settings.html 独立入口：electron-vite 5.0.0 的 renderer 预设
 *     会把 `build.rollupOptions.input` 覆盖回单个 index.html 字符串（配置文件与普通插件都输给它，
 *     只有 `enforce: 'post'` 的插件才拦得住，实测仍不可靠），多页产物出不来会静默白屏。
 *
 * 生命周期：单例。重复打开只聚焦已有窗口；关闭即销毁（不常驻，省内存也省「后台还有个窗」的困惑）。
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { logInfo, logWarn } from './logger'

const SETTINGS_WIN_W = 480
const SETTINGS_WIN_H = 308

let settingsWindow: BrowserWindow | null = null

/** 开/关窗口时通知 Dock 让位/回来（用户要求：开设置时 Dock 自动隐藏，关掉自动显示）。
 *  用模块级钩子而不是解构参数，是因为 `closed` 事件在 buildWindow 里注册、那时 opts 还没传进来。 */
let onOpenedHook: (() => void) | null = null
let onClosedHook: (() => void) | null = null

function buildWindow(iconPath: string, preloadPath: string): BrowserWindow {
  const win = new BrowserWindow({
    width: SETTINGS_WIN_W,
    height: SETTINGS_WIN_H,
    minWidth: 420,
    minHeight: 300,
    show: false,
    frame: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    // ⚠️ 必须是透明窗：设置页要和 Dock 一样是毛玻璃/透明材质（用户要求「风格一致」）。
    //    backgroundColor 用全透明而不是某个深色——不透明底会把 CSS 的 backdrop-filter
    //    挡在自己这一层里，外面什么都透不进来。
    //    代价：窗口四角由 CSS 的 border-radius 负责，DWM 不会补系统阴影。
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    title: '设置 · 快捷方式面板',
    icon: iconPath,
    webPreferences: {
      preload: preloadPath,
      sandbox: false
    }
  })

  win.setMenuBarVisibility(false)
  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })
  win.on('closed', () => {
    if (settingsWindow === win) settingsWindow = null
    // 关掉设置窗 → Dock 回来。放在 closed 而不是 close，是因为 close 可以被阻止
    // （将来若加「未保存确认」），那种情况下不该提前把 Dock 弹出来。
    try {
      onClosedHook?.()
    } catch (err) {
      logWarn('settings-window', '恢复 Dock 失败', err)
    }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    void win.loadURL(`${devUrl}/index.html?view=settings`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query: { view: 'settings' } })
  }
  return win
}

/** 打开（或聚焦）设置窗口。返回 true = 如今有一扇可见的设置窗。 */
export function openSettingsWindow(iconPath: string, preloadPath: string): boolean {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore()
    settingsWindow.show()
    settingsWindow.focus()
    return true
  }
  try {
    // 先让 Dock 让位再建窗：反过来的话新窗会被 Dock 的置顶抢焦点（Dock 是 alwaysOnTop）
    try {
      onOpenedHook?.()
    } catch (err) {
      logWarn('settings-window', '隐藏 Dock 失败', err)
    }
    settingsWindow = buildWindow(iconPath, preloadPath)
    logInfo('settings-window', '创建设置中心窗口')
    return true
  } catch (err) {
    logWarn('settings-window', '设置窗口创建失败', err)
    settingsWindow = null
    return false
  }
}

export function closeSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close()
}

/**
 * 注册窗口自身的 IPC：
 *   - `open-settings`      Dock 的「+」菜单 → 在这里开窗（Dock 自己是 transparent 窗，不能长高）
 *   - `settings-minimize`  自绘标题栏最小化
 *   - `settings-close`     自绘标题栏关闭（也是 Esc 的落点）
 *   - `settings-data-dir`  数据目录（shortcuts.json / icons / logs 都在这里）
 */
export function registerSettingsWindowIpc(opts: {
  iconPath: string
  preloadPath: string
  dataDir: string
  /** Dock 让位（开设置窗时）。主进程注入，这里不碰任何 Dock 状态。 */
  onOpened?: () => void
  /** Dock 回来（设置窗销毁时）。 */
  onClosed?: () => void
}): void {
  onOpenedHook = opts.onOpened ?? null
  onClosedHook = opts.onClosed ?? null

  ipcMain.handle('open-settings', () => openSettingsWindow(opts.iconPath, opts.preloadPath))

  // ⚠️ 必须确认 sender 就是设置窗本身：这两条 IPC 在 preload 里是**全局**暴露的，
  //    Dock 的渲染进程也能调。不校验的话「关设置」会关掉 Dock、「最小化」会最小化 Dock。
  ipcMain.on('settings-minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && win === settingsWindow) win.minimize()
  })

  ipcMain.on('settings-close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && win === settingsWindow) win.close()
  })

  ipcMain.handle('settings-data-dir', async () => {
    const err = await shell.openPath(opts.dataDir)
    return err === ''
  })
}
