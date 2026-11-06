/**
 * 设置中心截图探针（视觉回归用，一次性）。
 *
 * 为什么不用 regression.cjs：那个探针注入的是**假 DOM 假 api**，看得到结构看不到排版；
 * 而这次要验收的恰恰是排版（「标准」两个字是否还贴边、左栏/表单是否对齐）。
 *
 * 做法：真 Electron 窗口 + 真 preload + 真构建产物（out/renderer/index.html?view=settings），
 * 只把主进程的 settings IPC 用最小桩接上（正常运行时由 src/main/settings.ts 提供）。
 *
 * 用法：
 *   & .\node_modules\electron\dist\electron.exe devtools/probe/settings-shot.cjs dark
 *   & .\node_modules\electron\dist\electron.exe devtools/probe/settings-shot.cjs light
 * 产物：devtools/probe/out/settings-<theme>.png
 * ⚠️ 跑之前先 Remove-Item Env:ELECTRON_RUN_AS_NODE（否则 electron 走纯 node 模式直接崩）
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const { join } = require('path')
const fs = require('fs')

const THEME = ['light', 'transparent'].includes(process.argv[2]) ? process.argv[2] : 'dark'
// 第二个参数选页：general = 通用（看系统集成 + 快捷键两行），默认外观（分段控件最密的页）
const SECTION = process.argv[3] === 'general' ? '通用' : '外观'
const OUT = join(__dirname, 'out')
fs.mkdirSync(OUT, { recursive: true })

const SETTINGS = {
  theme: THEME,
  glassPlan: THEME,
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

app.disableHardwareAcceleration()
app.setPath('userData', join(OUT, 'settings-profile'))
app.whenReady().then(async () => {
  // 主进程侧的最小桩：真实现见 src/main/settings.ts（坏字段归一化等逻辑这里不需要）
  ipcMain.on('get-settings-sync', (e) => {
    e.returnValue = SETTINGS
  })
  ipcMain.handle('get-settings', () => SETTINGS)
  ipcMain.handle('set-settings', (_e, patch) => Object.assign(SETTINGS, patch))
  ipcMain.handle('get-auto-start', () => false)
  ipcMain.handle('get-app-version', () => '1.17.0-probe')
  ipcMain.handle('load-shortcuts', () => ({ entries: [{ id: 1 }, { id: 2 }, { id: 3 }], corrupt: false, recovered: false }))
  ipcMain.handle('desktop-icons-hidden-init', () => false)
  ipcMain.on('settings-minimize', () => {})
  ipcMain.on('settings-close', () => {})

  const win = new BrowserWindow({
    // 与 src/main/settingsWindow.ts 的 SETTINGS_WIN_W/H 保持一致（改一处要改两处）
    width: 480,
    height: 308,
    show: false,
    frame: false,
    // 透明窗 + 全透明底：只有这样 CSS 的 backdrop-filter 才啃得到「桌面」
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../../out/preload/index.js'),
      sandbox: false,
      // offscreen：每帧都通过 'paint' 事件交出来。普通隐藏窗口只合成首帧，
      // 之后的 React 更新不会重绘，capturePage() 会一直返回点击前那一帧（踩过）。
      offscreen: true
    }
  })
  let lastFrame = null
  win.webContents.on('paint', (_e, _dirty, image) => {
    lastFrame = image
  })
  win.webContents.setFrameRate(30)
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) console.log('[renderer]', msg)
  })
  await win.loadFile(join(__dirname, '../../out/renderer/index.html'), { query: { view: 'settings' } })
  await new Promise((r) => setTimeout(r, 900))

  // 透明窗截图要有一张「桌面」垫在下面，才看得出来毛玻璃：
  // 注入一块渐变壁纸（fixed / z-index 0），`.st` 提到它上面，backdrop-filter 采样到的就是它。
  // 只影响截图观感，不影响任何断言——真实运行时采样的是用户壁纸。
  await win.webContents.executeJavaScript(`(() => {
    const bg = document.createElement('div')
    bg.id = 'probe-desktop'
    bg.style.cssText = 'position:fixed;inset:0;z-index:0;background:' +
      'radial-gradient(1200px 620px at 16% 10%, rgba(84,138,224,0.60), transparent 62%),' +
      'radial-gradient(900px 520px at 88% 82%, rgba(196,118,200,0.46), transparent 64%),' +
      'linear-gradient(140deg, #1b2333 0%, #2a3550 46%, #101624 100%)'
    document.body.insertBefore(bg, document.body.firstChild)
    const st = document.querySelector('.st')
    if (st) { st.style.position = 'relative'; st.style.zIndex = '1' }
  })()`)

  // 切到「外观」页：设置里最容易拥挤的就是这一页（材质/图标大小/放大/玻璃/停靠位置全是分段控件）
  await win.webContents.executeJavaScript(`(() => {
    const nav = [...document.querySelectorAll('.st-nav-item')].find(n => n.textContent.trim() === ${JSON.stringify(SECTION)})
    if (nav) nav.click()
  })()`)
  await new Promise((r) => setTimeout(r, 220))
  // 再等一拍：capturePage 取的是「最近一帧已合成画面」，React 的状态更新与绘制之间
  // 可能还差一帧（实测不等的话会截到点击前的样子）
  await new Promise((r) => setTimeout(r, 400))

  // 量一下排版：胶囊按钮是否比文字宽（「贴边」的直接判据）
  const metrics = await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('.st-seg-btn')].find(b => b.textContent.trim() === '标准')
    const row = document.querySelector('.st-row')
    const pane = document.querySelector('.st-pane')
    const r = btn ? btn.getBoundingClientRect() : null
    return {
      title: document.title,
      hasWinFlag: document.documentElement.dataset.win === 'settings',
      navItems: [...document.querySelectorAll('.st-nav-item')].map(n => n.textContent),
      activeNav: [...document.querySelectorAll('.st-nav-item.active')].map(n => n.textContent),
      navBgs: [...document.querySelectorAll('.st-nav-item')].map(n => n.textContent + ':' + getComputedStyle(n).backgroundColor + ':' + n.className),
      currentNav: [...document.querySelectorAll('.st-nav-item[aria-current]')].map(n => n.textContent),
      segBtn: r ? { w: Math.round(r.width), h: Math.round(r.height), text: btn.textContent } : null,
      // 「贴边」判据：按钮左右各应有 ≥ 12px 富余（padding 0 14px，字宽 ~34px）
      segBtnSlack: r ? Math.round(r.width - btn.scrollWidth) : null,
      navWidth: document.querySelector('.st-nav')?.getBoundingClientRect().width,
      titleBarH: document.querySelector('.st-titlebar')?.getBoundingClientRect().height,
      rowCols: row ? getComputedStyle(row).gridTemplateColumns : null,
      paneScroll: pane ? { h: pane.clientHeight, scroll: pane.scrollHeight } : null,
      hasScrollbarDiv: !!document.querySelector('.dock-scrollbar'),
      // 毛玻璃是否真的生效：backdrop-filter 必须非 none，body 必须全透明
      // （body 一旦有不透明背景，窗口看起来就是块死色板，与 Dock 材质对不上）
      backdrop: (() => { const s = getComputedStyle(document.querySelector('.st')); return s.backdropFilter || s.webkitBackdropFilter })(),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      stRadius: getComputedStyle(document.querySelector('.st')).borderRadius,
      winSize: { w: window.innerWidth, h: window.innerHeight },
      keysRow: document.querySelectorAll('.st-keys').length
    }
  })()`)

  // offscreen 模式：用 'paint' 交出来的最后一帧（capturePage 在隐藏窗口上会返回首帧）
  const shot = lastFrame || (await win.webContents.capturePage())
  const file = join(OUT, `settings-${THEME}${process.argv[3] === 'general' ? '-general' : ''}.png`)
  fs.writeFileSync(file, shot.toPNG())
  console.log(JSON.stringify(metrics, null, 2))
  console.log('SHOT=' + file)
  win.destroy()
  app.quit()
})
