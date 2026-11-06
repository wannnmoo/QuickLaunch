// 宽度行为探测（HTTP 版）：用**真实构建产物**的 CSS，在真实 Chromium 里量 .dock-bar 宽度。
// 为什么要起一个本地 HTTP 服务：探针页与构建产物不在同一目录，file:// 下两者属于不同
// 不透明源，样式表会被判为跨源而**静默不生效**（第一版探针就栽在这里，量到的是"没有样式"
// 的 1202px 全宽）。同源 HTTP 才能让真实 CSS 生效。
// 跑法: node_modules/electron/dist/electron.exe devtools/probe/probe-main.cjs
const { app, BrowserWindow } = require('electron')
const { readdirSync, readFileSync } = require('fs')
const { join, extname } = require('path')
const http = require('http')

const ROOT = join(__dirname, '..', '..')
const assetsDir = join(ROOT, 'out', 'renderer', 'assets')
const cssFile = readdirSync(assetsDir).find((f) => f.endsWith('.css'))
if (!cssFile) { console.error('没找到构建产物 CSS，先跑 npm run build'); process.exit(1) }

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' }
const server = http.createServer((req, res) => {
  const url = req.url === '/' ? '/dock.html' : req.url
  // 依次在探针目录与构建产物目录里找（HMR 产物目录保持真实，不复制）
  const candidates = [join(__dirname, url), join(ROOT, 'out', 'renderer', url.replace(/^\//, ''))]
  for (const p of candidates) {
    try {
      const body = readFileSync(p)
      res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' })
      res.end(body)
      return
    } catch { /* 继续找下一个 */ }
  }
  res.writeHead(404); res.end('not found')
})

const WIN_W = 1200
const WIN_H = 300
const PAD = 24 // .dock 左右 padding

// 独立 userData：避免 Chromium 的 per-origin zoom 在探针之间互相污染（会让视口变成 400x100）
app.setPath('userData', require('path').join(__dirname, 'out', 'probe-profile'))

app.disableHardwareAcceleration()
server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port
  await app.whenReady()
  const win = new BrowserWindow({
    width: WIN_W, height: WIN_H, show: false, frame: false,
    webPreferences: { offscreen: true }
  })
  await win.loadURL(`http://127.0.0.1:${port}/dock.html`)

  // 把真实 CSS 路径注入，并等 hashed-css 真的 load（用一次性事件，不用注入 Promise——
  // 之前注入里 await 一个 load 事件，脚本一时不返回就把整个探测挂死了）
  const cssLoaded = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 8000)
    win.webContents.executeJavaScript(
      `(() => { const l = document.getElementById('real-css'); l.href = '/assets/${cssFile}';
                window.__cssOk = false;
                l.addEventListener('load', () => { window.__cssOk = true });
                l.addEventListener('error', () => { window.__cssOk = false });
                return true })()`
    ).catch(() => {})
    const poll = setInterval(async () => {
      try {
        const ok = await win.webContents.executeJavaScript('window.__cssOk === true')
        if (ok) { clearInterval(poll); clearTimeout(timer); resolve(true) }
      } catch { /* 页面还在加载，下一轮再试 */ }
    }, 150)
  })
  const ok = await cssLoaded
  console.log(`构建产物 CSS 注入: ${ok ? '成功' : '失败'} (${cssFile})`)
  if (!ok) { console.error('CSS 没加载上，探测结果无意义'); server.close(); app.exit(1); return }

  // 自检：确认新规则真的生效（.dock-bar 必须是 max-content 且 position: relative）
  const selfCheck = await win.webContents.executeJavaScript(`(() => {
    // 真应用的 renderer 会把 window.innerWidth 写进 --dock-vw（探针页没有 React，手动补上，
    // 否则量到的是 100vw 兜底值，测不出真实行为）
    document.getElementById('app').style.setProperty('--dock-vw', window.innerWidth + 'px')
    const cs = getComputedStyle(document.getElementById('bar'))
    return { width: cs.width, maxWidth: cs.maxWidth, position: cs.position, innerWidth: window.innerWidth }
  })()`)
  console.log('.dock-bar 计算样式:', JSON.stringify(selfCheck))
  if (selfCheck.maxWidth === 'none' || selfCheck.position !== 'relative') {
    console.error('✗ .dock-bar 规则没生效，探测结果无意义'); server.close(); app.exit(1); return
  }
  const VW = selfCheck.innerWidth
  const LIMIT = VW - PAD * 2
  console.log(`视口 ${VW}px → 期望上限 ${LIMIT}px`)

  const measure = (n) => win.webContents.executeJavaScript(`(() => {
    const inner = document.getElementById('inner')
    inner.querySelectorAll('.dock-item').forEach(el => el.remove())
    for (let i = 0; i < ${n}; i++) {
      const d = document.createElement('div')
      d.className = 'dock-item'
      d.innerHTML = '<div class="dock-icon-wrap"><img class="dock-icon" alt=""></div>'
      inner.appendChild(d)
    }
    void inner.offsetWidth
    const bar = document.getElementById('bar')
    const br = bar.getBoundingClientRect()
    const dock = document.getElementById('dock')
    const cs = getComputedStyle(bar)
    return {
      n: ${n},
      barW: Math.round(br.width * 100) / 100,
      widthStyle: cs.width, maxWidth: cs.maxWidth,
      dockW: Math.round(dock.getBoundingClientRect().width),
      innerClientW: inner.clientWidth,
      innerScrollW: inner.scrollWidth,
      scrollable: inner.scrollWidth > inner.clientWidth + 1,
      centered: Math.abs(br.left - (${WIN_W} - br.width) / 2) < 1.5
    }
  })()`)

  const rows = []
  for (const n of [0, 1, 2, 4, 8, 12, 14, 16, 20, 30]) rows.push(await measure(n))

  console.log(`\n窗口 ${WIN_W}x${WIN_H}，.dock-bar 上限应为 ${LIMIT}px\n`)
  console.log('图标数 |  bar 宽  | 上限内 | 可滚动 | inner 可视/内容 | 居中')
  console.log('-------|----------|--------|--------|-----------------|-----')
  let pass = true
  for (const r of rows) {
    console.log(
      `${String(r.n).padStart(6)} | ${String(r.barW).padStart(8)} | ${(r.barW <= LIMIT + 0.5 ? '  是  ' : '  否  ')} | ` +
      `${(r.scrollable ? '  是  ' : '  否  ')} | ${String(r.innerClientW).padStart(6)}/${String(r.innerScrollW).padStart(6)} | ${r.centered ? '是' : '否'}`
    )
    if (r.barW > LIMIT + 0.5) { console.log(`  ✗ 超出上限`); pass = false }
    if (!r.centered) { console.log('  ✗ 未居中'); pass = false }
  }
  const shrunk = rows.some(r => r.n > 0 && r.barW < LIMIT - 1)
  const scrolled = rows.some(r => r.scrollable)
  const capped = rows.filter(r => r.n >= 20).every(r => Math.abs(r.barW - LIMIT) < 1.5)
  const seq = rows.filter(r => r.n <= 16).map(r => r.barW)
  const mono = seq.every((v, i) => i === 0 || v >= seq[i - 1] - 0.5)

  console.log('')
  console.log(shrunk ? '✔ 图标少时收缩到内容宽度' : '✗ 没有收缩')
  console.log(mono ? '✔ 宽度随图标数量单调增长' : '✗ 宽度不单调')
  console.log(capped ? `✔ 到 ${LIMIT}px 封顶` : '✗ 没有在上限处封顶')
  console.log(scrolled ? '✔ 超出后出现横向滚动' : '✗ 超出后没有滚动')
  pass = pass && shrunk && mono && capped && scrolled
  console.log(pass ? '\n全部通过 ✔' : '\n存在失败项 ✗')
  server.close()
  app.exit(pass ? 0 : 1)
})
