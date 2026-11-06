// 三种显示模式（transparent / glass-dark / glass-light）逐一实拍 + 取关键配色值
const { app, BrowserWindow } = require('electron')
const { readFileSync, mkdirSync, writeFileSync } = require('fs')
const { join } = require('path')
const http = require('http')
const zlib = require('zlib')

const ROOT = join(__dirname, '..', '..')
const OUT = join(__dirname, 'out')
try { mkdirSync(OUT, { recursive: true }) } catch { /* ok */ }
app.setPath('userData', join(OUT, 'probe-profile'))
const TIMEOUT = setTimeout(() => { console.error('[超时]'); app.exit(3) }, 180000)

function crc32(buf) { let c, crc = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) { c = (crc ^ buf[i]) & 0xFF; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c } return (crc ^ 0xFFFFFFFF) >>> 0 }
function png(w, h, rgb) {
  const rows = []
  for (let y = 0; y < h; y++) { const row = [0]; for (let x = 0; x < w; x++) { const e = x < 2 || y < 2 || x >= w - 2 || y >= h - 2; row.push(e ? 250 : rgb[0], e ? 250 : rgb[1], e ? 250 : rgb[2], 255) } rows.push(Buffer.from(row)) }
  const ch = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]) }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ch('IHDR', ih), ch('IDAT', zlib.deflateSync(Buffer.concat(rows))), ch('IEND', Buffer.alloc(0))]).toString('base64')
}
const COLS = [[228, 86, 72], [86, 178, 106], [92, 132, 232], [236, 186, 72]]
const e = (id, name, extra = {}) => ({ id, iconDataUrl: png(48, 48, COLS[id % 4]), targetPath: `C:\\${name}.exe`,
  arguments: '', workingDirectory: '', description: name, ...extra })
const FX = [
  e(0, '此电脑', { targetPath: 'shell:MyComputerFolder', specialType: 'this-pc' }),
  e(1, '微信'),
  e(2, 'Steam'),
  { id: 900, iconDataUrl: '', targetPath: '', arguments: '', workingDirectory: '', description: '游戏', isGroup: true },
  e(901, 'A1', { groupId: 900 }), e(902, 'A2', { groupId: 900 }), e(903, 'A3', { groupId: 900 }), e(904, 'A4', { groupId: 900 }),
  e(3, '剪映专业版'),
  e(4, 'SEP', { isSeparator: true, targetPath: '' }),
  e(5, 'Visual Studio Code'),
  e(6, '文件夹', { isFolder: true, targetPath: 'D:\\Desktop\\项目' })
]
const srv = http.createServer((req, res) => {
  const u = (req.url || '/').split('?')[0]
  if (u === '/' || u === '/index.html') {
    const h = readFileSync(join(ROOT, 'out', 'renderer', 'index.html'), 'utf-8')
      // 桌面壁纸用彩色渐变，才能看出「透明」模式真的透出背景
      .replace('</head>', '<style>html,body{background:linear-gradient(135deg,#1e3a5f 0%,#7a3b5e 45%,#c98a3c 100%);}</style></head>')
      .replace('<head>', `<head><script>
window.api = new Proxy({}, { get: function (t, k) {
  if (k === 'dockEdge') return 'middle';
  if (k === 'loadShortcuts') return function () { return Promise.resolve({ entries: ${JSON.stringify(FX)}, corrupt: false, recovered: false }) };
  if (k === 'listDrives') return function () { return Promise.resolve([
    { name: 'C:', label: '系统', type: 'Fixed', format: 'NTFS', total: 512e9, free: 120e9, ready: true },
    { name: 'D:', label: '数据', type: 'Fixed', format: 'NTFS', total: 1e12, free: 640e9, ready: true }]) };
  if (k === 'scanDesktopFolders' || k === 'checkMissingFolders') return function () { return Promise.resolve([]) };
  if (String(k).startsWith('on')) return function () { return function () {} };
  return function () { return Promise.resolve(null) };
} });
</script>`)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(h); return
  }
  try { res.writeHead(200, { 'Content-Type': u.endsWith('.css') ? 'text/css' : 'text/javascript' }); res.end(readFileSync(join(ROOT, 'out', 'renderer', u.replace(/^\//, '')))) }
  catch { res.writeHead(404); res.end('nf') }
})
app.disableHardwareAcceleration()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const MODES = [
  { key: 'dark', label: '毛玻璃 · 黑夜' },
  { key: 'light', label: '毛玻璃 · 白天' },
  { key: 'transparent', label: '透明' }
]

srv.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port
  await app.whenReady()
  const win = new BrowserWindow({ width: 1200, height: 300, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } })
  const wc = win.webContents
  const rows = []
  for (const m of MODES) {
    await win.loadURL(`http://127.0.0.1:${port}/?t=${m.key}`)
    await wc.executeJavaScript(`localStorage.setItem('ql-theme', ${JSON.stringify(m.key)})`)
    await win.loadURL(`http://127.0.0.1:${port}/?t=${m.key}&r=1`)
    await sleep(1400)
    const info = await wc.executeJavaScript(`(() => {
      const app = document.querySelector('.app')
      const cs = getComputedStyle(app)
      const pick = (n) => cs.getPropertyValue(n).trim()
      const bg = getComputedStyle(document.querySelector('.dock-bg'))
      const label = getComputedStyle(document.querySelector('.dock-label'))
      const badge = getComputedStyle(document.querySelector('.dock-badge'))
      const bgImg = bg.backgroundImage
      // ⚠️ 别用正则切 background-image 的顶层逗号：正则里带括号/反引号很容易写坏
      //    （本次就写出过 SyntaxError，而**语法错的探针不会自行退出**，超时兜底也不生效，
      //    表现是 electron 进程挂着不动）。用最笨的办法：按深度切。
      const layers = []
      let depth = 0, cur = ''
      for (const ch of bgImg) {
        if (ch === '(') depth++
        else if (ch === ')') depth--
        if (ch === ',' && depth === 0) { layers.push(cur.trim()); cur = '' } else cur += ch
      }
      if (cur.trim()) layers.push(cur.trim())
      return {
        rootClass: app.className,
        // 视口/缩放自检：zoom 被污染时截图尺寸会变，肉眼比较会得出错误结论
        vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio,
        barH: Math.round(document.querySelector('.dock-bg').getBoundingClientRect().height),
        iconW: Math.round(document.querySelector('.dock-icon').getBoundingClientRect().width),
        // background-image 是多层叠加，**第一层是描边渐变、不是玻璃底色**
        // （之前截前 90 字符读到的就是描边层，误以为玻璃没变，踩过一次）
        bgLayers: layers.map((s, i) => 'L' + (i + 1) + ': ' + s.slice(0, 92)),
        glassFillVarTop: pick('--dock-bg-top'),
        glassFillVarBottom: pick('--dock-bg-bottom'),
        dockSheen: pick('--dock-sheen'),
        dockSat: pick('--dock-sat'),
        backdrop: bg.backdropFilter || bg.webkitBackdropFilter,
        dockBorder: bg.borderTopColor + ' / ' + bg.borderTopWidth,
        labelColor: label.color,
        labelPill: pick('--label-pill-bg') || '(无该变量)',
        labelStroke: label.webkitTextStrokeWidth + ' ' + label.webkitTextStrokeColor,
        labelShadow: label.textShadow === 'none' ? 'none' : label.textShadow.slice(0, 60),
        badgeBg: badge.backgroundColor,
        badgeColor: badge.color
      }
    })()`)
    rows.push({ mode: m.label, key: m.key, ...info })
    const tag = m.key
    writeFileSync(join(OUT, `theme-${tag}.png`), (await wc.capturePage()).toPNG())
  }
  console.log(JSON.stringify(rows, null, 1))
  writeFileSync(join(OUT, 'themes.json'), JSON.stringify(rows, null, 2), 'utf-8')
  clearTimeout(TIMEOUT); srv.close(); app.exit(0)
})
