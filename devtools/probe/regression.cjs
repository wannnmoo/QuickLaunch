// 本次修复的**回归总测**：一个脚本覆盖全部关键修复点，替代之前分散的临时探针。
// 跑法: node_modules/electron/dist/electron.exe devtools/probe/regression.cjs
//
// 覆盖：
//   1  分隔线落点错位（拖到 B 右半边，顺序必须不变，指示线必须落在光标附近）
//   2  拖入分组：specialType 清除，文件夹保留 isFolder（可继续当文件夹用）
//   3  Dock 玻璃条几何（bar 146 / bg 76 / 图标底边贴窗口底）
//   4  拖拽后几何缓存新鲜（悬停放大跟随光标）
//   5  真实点击能打开「+」菜单，且菜单在窗口内、贴玻璃条外侧 8px
//   6  面板打开但选中框在主 Dock 时，→ 不被面板吸走（键盘导航层级判断）
const { app, BrowserWindow } = require('electron')
const { readFileSync, mkdirSync, writeFileSync } = require('fs')
const { join } = require('path')
const http = require('http')

const ROOT = join(__dirname, '..', '..')
const OUT = join(__dirname, 'out')
try { mkdirSync(OUT, { recursive: true }) } catch { /* ok */ }
const TIMEOUT = setTimeout(() => { console.error('[总超时]'); app.exit(3) }, 240000)

// ⚠️⚠️ 用**独立的 userData**，别用默认目录（踩过一次，非常隐蔽）：
// Chromium 会把 per-origin zoom **持久化到 userData**，并在**加载时应用**。
// 之前某个探针设过 zoomFactor:3，之后所有同源（127.0.0.1）探针都以 300% 加载 ——
// 视口变 400×100、devicePixelRatio=3，表现为「菜单跑到窗口外」「分组拼图不渲染」
// 等一串**假 bug**（clearStorageData 也清不掉，因为它在别处持久化）。
// 换独立 userData 后每个探针都从干净的 profile 开始。
app.setPath('userData', join(OUT, 'probe-profile'))

const DOT = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const RED = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const e = (id, name, extra = {}) => ({ id, iconDataUrl: DOT, targetPath: `C:\\Apps\\${name}.exe`,
  arguments: '', workingDirectory: '', description: name, ...extra })
const G = 900
const FX = [
  e(1, 'AAA'),
  e(2, 'SEP', { isSeparator: true, targetPath: '' }),
  e(3, 'BBB'),
  e(4, 'CCC'),
  e(5, 'DDD'),
  { id: G, iconDataUrl: '', targetPath: '', arguments: '', workingDirectory: '', description: '我的分组', isGroup: true },
  // 4 个成员 → 拼图铺满 2×2，徽标原来会压住第 4 张
  // ⚠️ 注意 e() 的签名是 (id, name, extra)——第三参才是附加字段，写成 e(901,'M1',G) 会得到
  //    `group: 'M1'` 这种废字段（踩过：导致徽标显示 1、第 8 组断言永远失败）
  e(901, 'M1', { groupId: G }), e(902, 'M2', { groupId: G }),
  e(903, 'M3', { groupId: G }), e(904, 'M4', { groupId: G }),
  e(6, '此电脑', { targetPath: 'shell:MyComputerFolder', specialType: 'this-pc', iconDataUrl: RED }),
  // 文件夹入组：`isFolder` 必须保留（面板预览/右键语义），只有 `specialType` 要抹掉
  e(7, '文件夹A', { isFolder: true, targetPath: 'C:\\Desktop\\FolderA' }),
  // 再补 24 个凑到 31 个，把 Dock 撑到必须横向滚动（回归「滚不到最前面」那个 bug）
  ...Array.from({ length: 24 }, (_, i) => e(200 + i, `应用${String(i + 1).padStart(2, '0')}`))
]

const srv = http.createServer((req, res) => {
  const u = (req.url || '/').split('?')[0]
  if (u === '/' || u === '/index.html') {
    const h = readFileSync(join(ROOT, 'out', 'renderer', 'index.html'), 'utf-8')
      .replace('<head>', `<head><script>
window.__saved = null;
window.api = new Proxy({}, { get: function (t, k) {
  if (k === 'dockEdge') return 'middle';
  if (k === 'loadShortcuts') return function () { return Promise.resolve({ entries: ${JSON.stringify(FX)}, corrupt: false, recovered: false }) };
  if (k === 'saveShortcuts') return function (d) { window.__saved = JSON.parse(JSON.stringify(d)); return Promise.resolve(true) };
  if (k === 'listDrives') return function () { return Promise.resolve([]) };
  if (k === 'scanDesktopFolders') return function () { return Promise.resolve([]) };
  if (k === 'checkMissingFolders') return function () { return Promise.resolve([]) };
  if (k === 'listFolder') return function (p) {
    if (String(p).indexOf('FolderA') >= 0) return Promise.resolve({ path: p, name: 'FolderA', folders: 1, files: 0,
      items: [{ name: 'Child', path: p + '\\\\Child', isDir: true }], truncated: 0 });
    return Promise.resolve({ path: '', name: '', folders: 0, files: 0, items: [], truncated: 0 }) };
  if (k === 'openPath') return function (p) { window.__openedPath = p; return Promise.resolve(true) };
  if (String(k).startsWith('on')) return function () { return function () {} };
  return function () { return Promise.resolve(null) };
} });
window.__fire = function (key) { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: key, bubbles: true, cancelable: true })) };
window.__item = function (label) {
  return [].slice.call(document.querySelectorAll('.dock-inner .dock-item'))
    .filter(function (el) { var l = el.querySelector('.dock-label'); return l && l.textContent.indexOf(label) >= 0 })[0] };
</script>`)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(h); return
  }
  try {
    res.writeHead(200, { 'Content-Type': u.endsWith('.css') ? 'text/css' : 'text/javascript' })
    res.end(readFileSync(join(ROOT, 'out', 'renderer', u.replace(/^\//, ''))))
  } catch { res.writeHead(404); res.end('nf') }
})

app.disableHardwareAcceleration()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (n, pass, d) => { results.push({ n, pass, d }); console.log(`${pass ? '  ok  ' : ' FAIL '} ${n}${d ? '\n         ' + d : ''}`) }

srv.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port
  await app.whenReady()
  const win = new BrowserWindow({ width: 1200, height: 300, show: false, frame: false, transparent: true,
    webPreferences: { offscreen: true } })
  const wc = win.webContents
  wc.on('render-process-gone', (_e, d) => console.error('[renderer gone]', JSON.stringify(d)))
  wc.on('unresponsive', () => console.error('[renderer unresponsive]'))
  wc.on('console-message', (_e, level, message) => console.log(`[renderer:${level}] ${message}`))
  const js = (c) => wc.executeJavaScript(`(async () => { ${c} })()`).catch((err) => ({ __err: String(err && err.message || err) }))
  await win.loadURL(`http://127.0.0.1:${port}/`)
  await sleep(1500)

  // ⚠️ 视口自检：缩放被污染时所有几何断言都会给出误导性结论，宁可当场失败
  const vp = await js(`return { vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio }`)
  console.log(`视口自检: ${JSON.stringify(vp)}（应 ≈ 1200×302，dpr 1）`)
  if (vp.vw < 1000 || vp.vh < 250) {
    console.error('✘ 视口被缩放污染，几何断言全部不可信 —— 检查是否有探针设过 zoomFactor')
    process.exitCode = 1
    clearTimeout(TIMEOUT); srv.close(); app.exit(1); return
  }

  // ── 1. 分隔线落点 ──────────────────────────────────────────────────
  console.log('\n=== 1) 分隔线落点（v1.13.1 修复：三个下标空间混用）===')
  const t1 = await js(`
    const inner = document.querySelector('.dock-inner')
    const nodes = () => [...inner.querySelectorAll(':scope > div > .dock-item, :scope > div > .dock-sep')]
    const label = el => el.classList.contains('dock-sep') ? '|' : el.querySelector('.dock-label').textContent
    const order = () => nodes().map(label)
    const elOf = n => nodes().find(x => label(x) === n)
    const rect = el => { const q = el.getBoundingClientRect(); return { left: q.left, right: q.right, cx: q.left + q.width / 2 } }
    const before = order()
    const c = elOf('CCC'), b = elOf('BBB')
    const cc = rect(c), bc = rect(b)
    c.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: cc.cx, clientY: 200, button: 0 }))
    for (let i = 1; i <= 8; i++) {
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cc.cx + (bc.right - 4 - cc.cx) * i / 8, clientY: 200 }))
      await new Promise(r => setTimeout(r, 25))
    }
    const ind = document.querySelector('.drop-indicator')
    const indLeft = ind ? Math.round(ind.getBoundingClientRect().left) : null
    const cursorX = Math.round(bc.right - 4)
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: bc.right - 4, clientY: 200 }))
    await new Promise(r => setTimeout(r, 400))
    return { before: before.join(' '), after: order().join(' '), indLeft, cursorX }
  `)
  console.log('   ', JSON.stringify(t1))
  check('把 CCC 拖到 BBB 右半边 → 顺序不变（v1.13.1 前会插到 BBB 左边）',
    t1.__err ? false : t1.before === t1.after, `${t1.before} → ${t1.after}${t1.__err ? ' ERR ' + t1.__err : ''}`)
  check('插入指示线落在光标附近（不是偏左两格）',
    t1.__err ? false : Math.abs(t1.indLeft - t1.cursorX) <= 12, `指示线 x=${t1.indLeft}，光标 x=${t1.cursorX}`)

  // ── 2. 拖入分组不残留顶层标记 ───────────────────────────────────────
  console.log('\n=== 2) 把「此电脑」拖进分组（v1.13.1 修复：字段污染）===')
  const t2 = await js(`
    const items = () => [...document.querySelectorAll('.dock-inner .dock-item')]
    const byLabel = n => items().find(el => ((el.querySelector('.dock-label') || {}).textContent || '').indexOf(n) >= 0)
    const src = byLabel('此电脑'), grp = byLabel('我的分组')
    const sr = src.getBoundingClientRect(), gr = grp.getBoundingClientRect()
    src.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: sr.left + sr.width/2, clientY: sr.top + sr.height/2, button: 0 }))
    console.log('t2: mousedown done')
    for (let i = 1; i <= 12; i++) {
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true,
        clientX: sr.left + sr.width/2 + (gr.left + gr.width/2 - sr.left - sr.width/2) * i / 12,
        clientY: sr.top + sr.height/2 + (gr.top + gr.height/2 - sr.top - sr.height/2) * i / 12 }))
      await new Promise(r => setTimeout(r, 20))
    }
    console.log('t2: moves done')
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: gr.left + gr.width/2, clientY: gr.top + gr.height/2 }))
    console.log('t2: mouseup done')
    await new Promise(r => setTimeout(r, 600))
    console.log('t2: waited')
    const saved = window.__saved || []
    const member = saved.find(x => x.groupId === 900 && String(x.description).indexOf('此电脑') >= 0) || saved.find(x => x.groupId === 900 && x.targetPath && x.targetPath.indexOf('shell:') === 0)
    console.log('t2: saved=' + JSON.stringify(saved.map(x => [x.id, x.groupId, x.specialType, x.description])))
    // 打开面板看用量条是否还渲染：先确认面板当前是开还是关，避免点成"切换关闭"
    const groupBtn = byLabel('我的分组')
    const wasOpen = !!document.querySelector('.group-panel')
    if (!wasOpen) { groupBtn.click(); await new Promise(r => setTimeout(r, 450)) }
    const panel = document.querySelector('.group-panel')
    const usageBars = panel ? panel.querySelectorAll('.dock-usage').length : -1
    const panelLabels = panel ? [...panel.querySelectorAll('.dock-label')].map(x => x.textContent) : null
    if (panel) { groupBtn.click(); await new Promise(r => setTimeout(r, 300)) }
    return { member: member || null, usageBars, panelLabels, wasOpen }
  `)
  console.log('   ', JSON.stringify(t2))
  const m = t2.member || {}
  check('分组成员不再残留 specialType',
    t2.__err ? false : (!!m.targetPath && m.targetPath.indexOf('shell:') === 0 ? !m.specialType : true),
    `member=${JSON.stringify(m)}`)
  check('分组成员不再残留 isFolder', t2.__err ? false : !m.isFolder, JSON.stringify(m))
  check('分组面板里不再渲染「此电脑」用量细条（成员已不携带 specialType）',
    t2.usageBars === 0 || (t2.usageBars === -1 && !!t2.member),
    `usage bars=${t2.usageBars}，面板标签=${JSON.stringify(t2.panelLabels)}（-1 表示面板未打开；关键判据是上面两条字段污染）`)

  // ── 2b. 文件夹进组：保留 isFolder，面板里仍能弹预览卡片 ─────────────
  console.log('\n=== 2b) 把「文件夹A」拖进分组（保留 isFolder）===')
  const t2b = await js(`
    const items = () => [...document.querySelectorAll('.dock-inner .dock-item')]
    const byLabel = n => items().find(el => ((el.querySelector('.dock-label') || {}).textContent || '').indexOf(n) >= 0)
    const src = byLabel('文件夹A'), grp = byLabel('我的分组')
    if (!src || !grp) return { __err: 'missing source/group' }
    const sr = src.getBoundingClientRect(), gr = grp.getBoundingClientRect()
    src.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: sr.left + sr.width/2, clientY: sr.top + sr.height/2, button: 0 }))
    for (let i = 1; i <= 12; i++) {
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true,
        clientX: sr.left + sr.width/2 + (gr.left + gr.width/2 - sr.left - sr.width/2) * i / 12,
        clientY: sr.top + sr.height/2 + (gr.top + gr.height/2 - sr.top - sr.height/2) * i / 12 }))
      await new Promise(r => setTimeout(r, 20))
    }
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: gr.left + gr.width/2, clientY: gr.top + gr.height/2 }))
    await new Promise(r => setTimeout(r, 700))
    const saved = window.__saved || []
    const member = saved.find(x => x.groupId === 900 && x.description === '文件夹A') || null
    const groupBtn = byLabel('我的分组')
    if (!document.querySelector('.group-panel')) {
      // 拖拽结束会置 suppressClickRef 吞掉紧随其后的 click（防误启动），
      // 而 groupBtn.click() 只有 click、没有 mousedown —— 先补一次按下-抬起，
      // 让 suppressClickRef 在新 mousedown 里被清掉，再点开面板。
      const gr2 = groupBtn.getBoundingClientRect()
      groupBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: gr2.left + gr2.width/2, clientY: gr2.top + gr2.height/2 }))
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: gr2.left + gr2.width/2, clientY: gr2.top + gr2.height/2 }))
      groupBtn.click()
      await new Promise(r => setTimeout(r, 500))
    }
    const panel = document.querySelector('.group-panel')
    const row = panel ? [...panel.querySelectorAll('.dock-item')].find(el => ((el.querySelector('.dock-label') || {}).textContent || '').indexOf('文件夹A') >= 0) : null
    if (row) {
      row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      await new Promise(r => setTimeout(r, 500))
    }
    const cardEl = document.querySelector('.folder-card')
    const card = !!cardEl
    const cardVisible = cardEl ? getComputedStyle(cardEl).visibility : null
    const cr = cardEl ? cardEl.getBoundingClientRect() : null
    const cardBox = cr ? { top: Math.round(cr.top), bottom: Math.round(cr.bottom), left: Math.round(cr.left), right: Math.round(cr.right) } : null
    const panelRect = panel ? panel.getBoundingClientRect() : null
    const groupRect = groupBtn.getBoundingClientRect()
    const panelCenter = panelRect ? Math.round(panelRect.left + panelRect.width/2) : null
    const groupCenter = Math.round(groupRect.left + groupRect.width/2)
    if (panel) { groupBtn.click(); await new Promise(r => setTimeout(r, 300)) }
    return { member, card, cardVisible, cardBox, rowFound: !!row, panelCenter, groupCenter }
  `)
  console.log('   ', JSON.stringify(t2b))
  const fm = t2b.member || {}
  check('文件夹进组后仍保留 isFolder', t2b.__err ? false : fm.isFolder === true, JSON.stringify(fm))
  check('文件夹成员在面板里能弹出预览卡片（不是 hidden）', t2b.__err ? false : (t2b.rowFound && t2b.card === true && t2b.cardVisible === 'visible'),
    `row=${t2b.rowFound} card=${t2b.card} visibility=${t2b.cardVisible}`)
  check('面板内预览卡片完整留在窗口内（不被顶部裁断）', t2b.__err ? false : !!t2b.cardBox && t2b.cardBox.top >= 0 && t2b.cardBox.bottom <= 300,
    JSON.stringify(t2b.cardBox))
  check('分组面板水平中心对齐分组图标', t2b.__err ? false : (Math.abs(t2b.panelCenter - t2b.groupCenter) <= 2),
    `panel=${t2b.panelCenter} group=${t2b.groupCenter}`)

  // ── 3. Dock 几何 ───────────────────────────────────────────────────
  console.log('\n=== 3) Dock 玻璃条几何 + 图标居中 ===')
  const t3 = await js(`
    const g = s => { const r = document.querySelector(s).getBoundingClientRect(); return { y: Math.round(r.y), h: Math.round(r.height), bottom: Math.round(r.bottom), top: +r.top.toFixed(1) } }
    const dockEl = document.querySelector('.dock')
    const padB = parseFloat(getComputedStyle(dockEl).paddingBottom)
    const bg = g('.dock-bg'), wrap = g('.dock-icon-wrap'), icon = g('.dock-icon')
    return { bar: g('.dock-bar'), bg, inner: g('.dock-inner'), item: g('.dock-item'), wrap, icon,
      vh: innerHeight, expectedBottom: innerHeight - padB,
      padAboveTile: +(wrap.top - bg.top).toFixed(1), padBelowTile: +(bg.bottom - wrap.bottom).toFixed(1),
      padAboveIcon: +(icon.top - bg.top).toFixed(1), padBelowIcon: +(bg.bottom - icon.bottom).toFixed(1) }
  `)
  console.log('   ', JSON.stringify(t3))
  check('玻璃条本体高 158px（86 透明放大区 + 60 衬底 + 上下各 8 玻璃内边距 − 2）',
    t3.bar.h === 158, `bar.h=${t3.bar.h}`)
  check('毛玻璃背景层高 76px（v1.13.1 前只有 60）', t3.bg.h === 76, `bg.h=${t3.bg.h}`)
  check('.dock-inner 撑满玻璃条（height: 100%）', t3.inner.h === 158, `inner.h=${t3.inner.h}`)
  check('图标衬底在玻璃条内上下等距（各 8px）—— 用户反馈的「上面间距比下面大」',
    t3.padAboveTile === 8 && t3.padBelowTile === 8,
    `上 ${t3.padAboveTile}px / 下 ${t3.padBelowTile}px（v1.13.1 前是 16 / 0）`)
  check('图标图像在玻璃条内上下等距（各 16px）',
    t3.padAboveIcon === 16 && t3.padBelowIcon === 16,
    `上 ${t3.padAboveIcon}px / 下 ${t3.padBelowIcon}px`)
  check('玻璃条下沿距窗口底 8px（= .dock 的下内边距，衬底不再贴边）',
    Math.abs(t3.expectedBottom - t3.bg.bottom) <= 1,
    `glass.bottom=${t3.bg.bottom} 期望 ${t3.expectedBottom}`)

  // ── 4. 拖拽后几何缓存 ──────────────────────────────────────────────
  console.log('\n=== 4) 拖拽重排后几何缓存新鲜度 ===')
  const t4 = await js(`
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await new Promise(r => setTimeout(r, 250))
    const inner = document.querySelector('.dock-inner')
    const items = () => [...inner.querySelectorAll('.dock-item')]
    const name = el => el.querySelector('.dock-label').textContent
    const elOf = n => items().find(x => name(x).indexOf(n) >= 0)
    const cx = n => { const q = elOf(n).getBoundingClientRect(); return q.left + q.width / 2 }
    // 把第一个图标拖到最右
    const a = elOf('AAA'), t = items()[items().length - 1]
    const ar = a.getBoundingClientRect(), tr = t.getBoundingClientRect()
    a.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: ar.left + ar.width/2, clientY: ar.top + ar.height/2, button: 0 }))
    for (let i = 1; i <= 10; i++) {
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true,
        clientX: ar.left + ar.width/2 + (tr.right + 30 - ar.left - ar.width/2) * i / 10, clientY: ar.top + ar.height/2 }))
      await new Promise(r => setTimeout(r, 20))
    }
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: tr.right + 30, clientY: ar.top + ar.height/2 }))
    await new Promise(r => setTimeout(r, 450))
    const after = items().map(name)
    items().forEach(el => { el.style.transform = ''; el.style.zIndex = '' })
    const leftmost = after[0]
    const lx = cx(leftmost)
    inner.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: lx, clientY: 200 }))
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
    return { leftmost, lx: Math.round(lx), zoomed: items().filter(el => el.style.transform).map(name) }
  `)
  console.log('   ', JSON.stringify(t4))
  check('重排后悬停放大跟随光标（几何缓存已刷新）',
    t4.__err ? false : t4.zoomed.includes(t4.leftmost),
    `悬停「${t4.leftmost}」@${t4.lx} → 放大 [${(t4.zoomed || []).join(', ')}]`)

  // ── 5. 「+」菜单 ────────────────────────────────────────────────────
  console.log('\n=== 5) 「+」菜单几何（真实点击序列）===')
  const t5 = await js(`
    const btn = document.querySelector('.dock-add-btn')
    const r = btn.getBoundingClientRect()
    const o = { bubbles: true, cancelable: true, clientX: r.left + r.width/2, clientY: r.top + r.height/2, button: 0 }
    btn.dispatchEvent(new MouseEvent('mousedown', o))
    btn.dispatchEvent(new MouseEvent('mouseup', o))
    btn.dispatchEvent(new MouseEvent('click', o))
    await new Promise(r2 => setTimeout(r2, 500))
    const menu = document.querySelector('.dropdown-menu')
    if (!menu) return { none: true }
    const mr = menu.getBoundingClientRect()
    const bg = document.querySelector('.dock-bg').getBoundingClientRect()
    const items = [...menu.querySelectorAll('.dropdown-item')].map(x => x.textContent.trim())
    const segs = [...menu.querySelectorAll('.theme-seg-btn')].map(x => x.textContent.trim())
    return { inWindow: mr.top >= 0 && mr.bottom <= innerHeight && mr.left >= 0 && mr.right <= innerWidth,
      gapToBar: Math.round(bg.top - mr.bottom), items, segs }
  `)
  console.log('   ', JSON.stringify(t5))
  check('菜单打开、在窗口内、底边贴玻璃条外侧 8px',
    t5.none !== true && t5.inWindow === true && Math.abs(t5.gapToBar - 8) <= 1, JSON.stringify(t5))
  // 菜单结构随版本变化，所以断言按「必须包含」写，不锁总数 —— 锁总数会让每次加菜单项
  // 都得改探针，而探针真正要守的是「该有的入口都在」。
  // ⚠️ v1.17 起所有配置项（停靠位置 / 主题 / 图标大小 / 放大 / 玻璃 / 延迟 / 点击后行为）
  //    搬到了独立设置窗口，菜单只剩「动作 + 设置入口 + 诊断」，所以不再断分段控件。
  const REQUIRED_ITEMS = ['添加快捷方式', '添加文件夹', '隐藏桌面图标', '开机自启动',
    '设置', '检查更新', '打开日志目录', '导出诊断包']
  const missing = REQUIRED_ITEMS.filter((t) => !t5.items || !t5.items.some((it) => it.startsWith(t)))
  check('菜单项齐全（快捷方式/文件夹/桌面图标/自启动/设置/更新/日志/诊断）',
    missing.length === 0, `missing=${JSON.stringify(missing)} items=${JSON.stringify(t5.items)}`)
  // 配置项已迁出菜单：菜单里不该再出现分段控件（出现了说明有人又往这儿堆配置）
  check('菜单里不再有配置项分段控件（已迁到设置中心）',
    !t5.segs || t5.segs.length === 0, JSON.stringify(t5.segs))

  // ── 6. 导航层级（面板开着但选中框在主 Dock）──────────────────────────
  console.log('\n=== 6) 面板打开时 → 不被面板吸走（v1.13.1 修复）===')
  const t6 = await js(`
    try {
    // 关菜单
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await new Promise(r => setTimeout(r, 250))
    const sel = () => { const el = document.querySelector('.dock-item.selected'); return el ? (el.querySelector('.dock-label') || {}).textContent : null }
    localStorage.removeItem('ql-nav-last')
    window.__fire('Escape'); await new Promise(r => setTimeout(r, 200))
    window.__fire('ArrowRight'); await new Promise(r => setTimeout(r, 300))
    const start = sel()
    const groupBtn = window.__item('我的分组')
    const alreadyOpen = !!document.querySelector('.group-panel')
    const diag = { found: !!groupBtn, hasItem: typeof window.__item, hasFire: typeof window.__fire }
    if (groupBtn) {
      const gr = groupBtn.getBoundingClientRect()
      const o = { bubbles: true, cancelable: true, clientX: gr.left + gr.width / 2, clientY: gr.top + gr.height / 2, button: 0 }
      groupBtn.dispatchEvent(new MouseEvent('mousedown', o))
      groupBtn.dispatchEvent(new MouseEvent('mouseup', o))
      groupBtn.dispatchEvent(new MouseEvent('click', o))
      await new Promise(r => setTimeout(r, 500))
    }
    diag.afterOpen = !!document.querySelector('.group-panel')
    const panelOpen = diag.afterOpen
    // 点分组图标本身会清掉 navId（handleIconMouseDown），所以先按一次 → 重新建立选中框，
    // 此时的状态才是"面板开着 + 选中框在主 Dock"
    window.__fire('ArrowRight'); await new Promise(r => setTimeout(r, 300))
    const selBefore = sel()
    const panelStillOpenBefore = !!document.querySelector('.group-panel')
    // 关键断言：再按 → 必须沿主 Dock 前进，而不是跳进面板第一个成员
    window.__fire('ArrowRight'); await new Promise(r => setTimeout(r, 350))
    const after1 = sel()
    return { start, alreadyOpen, panelOpen, selBefore, after1, panelStillOpenBefore,
      panelStillOpen: !!document.querySelector('.group-panel'), diag }
    } catch (err) { return { caught: String(err && err.message || err), stack: String(err && err.stack || '').slice(0, 300) } }
  `)
  console.log('   ', JSON.stringify(t6))
  check('面板开着但选中框在主 Dock 时，→ 沿主 Dock 前进（不被面板吸走）',
    t6.__err || t6.caught ? false
      : (t6.panelOpen === true && t6.panelStillOpenBefore === true &&
         t6.selBefore !== null && t6.after1 !== t6.selBefore && t6.after1 !== 'M1'),
    JSON.stringify(t6))

  // ── 7. 横向滚动的可达性 ────────────────────────────────────────────
  console.log('\n=== 7) 横向滚动：最前面的图标必须滚得到（v1.13.1 修复）===')
  const t7 = await js(`
    const inner = document.querySelector('.dock-inner')
    const first = document.querySelector('.dock-inner .dock-item')
    const firstLabel = first.querySelector('.dock-label').textContent
    const scrollable = inner.scrollWidth > inner.clientWidth + 1
    // ① scrollLeft=0 时第一个图标必须在容器内（不是被推到左侧屏幕外）
    inner.scrollLeft = 0
    const ir0 = inner.getBoundingClientRect(), fr0 = first.getBoundingClientRect()
    const atZero = { firstLeft: Math.round(fr0.left), innerLeft: Math.round(ir0.left),
      visible: fr0.left >= ir0.left - 1 && fr0.right <= ir0.right + 1 }
    // ② scrollWidth 不能小于内容跨度（居中溢出时浏览器会漏算左侧那半 —— 那时
    //    scrollWidth 只有 1582 而内容已达 2012）。用「最后一个右缘 − 第一个左缘」量内容跨度，
    //    再要求 scrollWidth >= 它减去「第一个元素左缘到 padding 边的距离」。
    //    注意别去按 60px 乘个数累加：分隔线是 9px 宽 + 自带 margin（上面那版就差了 14px）
    const kids = [...inner.querySelectorAll('.dock-item, .dock-sep')]
    const padL = parseFloat(getComputedStyle(inner).paddingLeft)
    const contentBoxLeft = inner.getBoundingClientRect().left + padL
    const firstL = kids[0].getBoundingClientRect().left
    const lastR = kids[kids.length - 1].getBoundingClientRect().right
    const contentSpan = lastR - firstL          // 首尾元素跨距
    const leftSlack = firstL - contentBoxLeft   // 首元素自带的 margin
    const actualScrollW = inner.scrollWidth
    // 允许 ±2px 的亚像素舍入
    const scrollWCoversContent = actualScrollW >= Math.round(contentSpan + leftSlack + 16) - 2
    // ③ 滚到最右再用滚轮一路往左，必须能回到第一个图标
    inner.scrollLeft = inner.scrollWidth
    await new Promise(r => setTimeout(r, 150))
    const atEnd = inner.scrollLeft
    for (let i = 0; i < 60; i++) {
      inner.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -150, deltaMode: 0 }))
      await new Promise(r => setTimeout(r, 25))
    }
    await new Promise(r => setTimeout(r, 200))
    const fr1 = first.getBoundingClientRect(), ir1 = inner.getBoundingClientRect()
    return { scrollable, firstLabel, atZero, actualScrollW, contentSpan, leftSlack, scrollWCoversContent,
      atEnd, backToZero: inner.scrollLeft,
      backVisible: fr1.left >= ir1.left - 1 && fr1.right <= ir1.right + 1,
      backLeft: Math.round(fr1.left) }
  `)
  console.log('   ', JSON.stringify(t7))
  check('31 个图标时 Dock 确实需要横向滚动', t7.scrollable === true, `scrollable=${t7.scrollable}`)
  check('scrollLeft=0 时第一个图标完整可见（v1.13.1 前它被推到 x=−390）',
    t7.__err ? false : t7.atZero.visible === true,
    `「${t7.firstLabel}」left=${t7.atZero.firstLeft}，容器 left=${t7.atZero.innerLeft}`)
  check('scrollWidth 覆盖全部内容（居中溢出会让浏览器漏算左侧那半）',
    t7.__err ? false : t7.scrollWCoversContent === true,
    `scrollWidth=${t7.actualScrollW}，内容跨度=${t7.contentSpan} + 首元素 margin ${t7.leftSlack}`)
  check('从最右用滚轮一路向左能回到第一个图标',
    t7.__err ? false : t7.backToZero === 0 && t7.backVisible === true,
    `scrollLeft=${t7.backToZero}，第一个图标 left=${t7.backLeft}`)

  // ── 8. 分组图标：徽标不得盖住缩略图 ──────────────────────────────────
  console.log('\n=== 8) 分组「缩略拼图 + 数量徽标」不重叠（v1.13.2 修复）===')
  const t8 = await js(`
    const R = el => el.getBoundingClientRect()
    const out = []
    for (const item of document.querySelectorAll('.dock-inner .dock-item')) {
      const prev = item.querySelector('.dock-group-preview')
      const badge = item.querySelector('.dock-badge')
      if (!prev || !badge) continue
      const br = R(badge)
      let worst = 0
      for (const img of prev.querySelectorAll('img')) {
        const ir = R(img)
        const ox = Math.max(0, Math.min(br.right, ir.right) - Math.max(br.left, ir.left))
        const oy = Math.max(0, Math.min(br.bottom, ir.bottom) - Math.max(br.top, ir.top))
        worst = Math.max(worst, ox * oy)
      }
      out.push({
        label: item.querySelector('.dock-label').textContent,
        n: item.querySelectorAll('.dock-group-preview img').length,
        badge: badge.textContent,
        worstOverlapPx2: Math.round(worst),
        // 只关心「成员 >= 2」的分组：单成员时徽标与那张大图相切属可接受
        imgs: prev.querySelectorAll('img').length
      })
    }
    return out
  `)
  console.log('   ', JSON.stringify(t8))
  const multi = (Array.isArray(t8) ? t8 : []).filter((g) => g.n >= 2)
  check('多成员分组的徽标不再盖住缩略图（v1.13.2 前盖住 25%）',
    multi.length > 0 && multi.every((g) => g.worstOverlapPx2 <= 8),
    multi.map((g) => `${g.label}(${g.n}个): ${g.worstOverlapPx2}px²`).join('，'))

  // 调试截图（默认不写；QL_SHOT=文件名 时抓当前视口）
  if (process.env.QL_SHOT) {
    const shot = await win.webContents.capturePage()
    writeFileSync(join(OUT, process.env.QL_SHOT), shot.toPNG())
  }

  console.log('\n=== 9) 分组子 Dock：移出自动收起 / 点成员启动后收起 ===')
  const t9 = await js(`
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const group = [...document.querySelectorAll('.dock-inner .dock-item')]
      .find(el => (el.querySelector('.dock-label') || {}).textContent === '我的分组')
    if (!group) return { err: 'group not found' }
    // 先把上一组测试可能留下的面板关掉
    if (document.querySelector('.group-panel')) { group.click(); await wait(150) }
    group.click(); await wait(150)
    const p1 = document.querySelector('.group-panel')
    if (!p1) return { err: 'panel not open' }
    // 指针移出面板（React onMouseLeave 由 mouseout 合成）
    p1.querySelector('.group-panel-inner').dispatchEvent(
      new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
    await wait(320)
    const closedByLeave = !document.querySelector('.group-panel')

    group.click(); await wait(150)
    const p2 = document.querySelector('.group-panel')
    if (!p2) return { closedByLeave, err: 'panel not reopen' }
    const member = p2.querySelector('.dock-item')
    member.click(); await wait(120)
    const closedByRun = !document.querySelector('.group-panel')
    return { closedByLeave, closedByRun }
  `)
  console.log('   ', JSON.stringify(t9))
  check('指针移出子 Dock 后自动收起（180ms 宽限）', t9.closedByLeave === true, JSON.stringify(t9))
  check('点击面板成员启动后子 Dock 收起', t9.closedByRun === true, JSON.stringify(t9))

  // ── 10. 分组面板内拖拽排序（v1.15.1）────────────────────────────────
  console.log('\n=== 10) 子 Dock 图标拖拽排序 ===')
  const t10 = await js(`
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const group = [...document.querySelectorAll('.dock-inner .dock-item')]
      .find(el => (el.querySelector('.dock-label') || {}).textContent === '我的分组')
    if (!group) return { err: 'group not found' }
    if (document.querySelector('.group-panel')) { group.click(); await wait(150) }
    group.click(); await wait(150)
    const panel = document.querySelector('.group-panel')
    if (!panel) return { err: 'panel not open' }
    const items = () => [...panel.querySelectorAll('.dock-item')]
    const label = el => (el.querySelector('.dock-label') || {}).textContent
    const order = () => items().map(label)
    const before = order()
    const m1 = items().find(x => label(x) === 'M1')
    const m4 = items().find(x => label(x) === 'M4')
    if (!m1 || !m4) return { err: 'members missing', before }
    const a = m1.getBoundingClientRect(), b = m4.getBoundingClientRect()
    m1.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: a.left + a.width / 2, clientY: a.top + a.height / 2, button: 0 }))
    await wait(30)
    panel.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: b.left + 2, clientY: b.top + b.height / 2, button: 0 }))
    await wait(60)
    const indicator = !!document.querySelector('.group-panel .drop-indicator')
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: b.left + 2, clientY: b.top + b.height / 2, button: 0 }))
    await wait(520)
    const after = order()
    const savedAll = Array.isArray(window.__saved) ? window.__saved : ((window.__saved || {}).entries || [])
    const saved = savedAll
      .filter(x => x.groupId === ${G}).map(x => x.description)
    return { before, after, saved, indicator, panelOpen: !!document.querySelector('.group-panel') }
  `)
  console.log('   ', JSON.stringify(t10))
  check('子 Dock 内拖拽 M1 到 M4 前，顺序变为 M2/M3/M1/M4',
    t10.__err ? false : JSON.stringify((t10.after || []).slice(0, 4)) === JSON.stringify(['M2', 'M3', 'M1', 'M4']), JSON.stringify(t10))
  check('子 Dock 拖拽结果已持久化且面板保持打开',
    t10.__err ? false : JSON.stringify((t10.saved || []).slice(0, 4)) === JSON.stringify(['M2', 'M3', 'M1', 'M4']) && t10.panelOpen === true,
    `saved=${JSON.stringify(t10.saved)} panelOpen=${t10.panelOpen}`)
  check('子 Dock 拖拽时显示落点指示线', t10.__err ? false : t10.indicator === true, `indicator=${t10.indicator}`)

  // ── 11. 分组面板里文件夹预览卡片：点击子项必须真的打开 ──────────────
  console.log('\n=== 11) 子 Dock 文件夹预览卡片点击 ===')
  const t11 = await js(`
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    let panel = document.querySelector('.group-panel')
    if (!panel) {
      const group = [...document.querySelectorAll('.dock-inner .dock-item')]
        .find(el => (el.querySelector('.dock-label') || {}).textContent === '我的分组')
      if (!group) return { err: 'group not found' }
      group.click(); await wait(150); panel = document.querySelector('.group-panel')
    }
    if (!panel) return { err: 'panel not open' }
    const folder = [...panel.querySelectorAll('.dock-item')]
      .find(el => (el.querySelector('.dock-label') || {}).textContent === '文件夹A')
    if (!folder) return { err: 'folder member not found' }
    folder.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }))
    await wait(500)
    const card = document.querySelector('.drives-card.folder-card')
    if (!card) return { err: 'folder card not open' }
    const row = card.querySelector('.folder-row')
    if (!row) return { err: 'folder row missing', text: card.textContent }
    const rr = row.getBoundingClientRect()
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: rr.left + 8, clientY: rr.top + 8, button: 0 }))
    await wait(90)
    const survivedMousedown = !!document.querySelector('.drives-card.folder-card')
    row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: rr.left + 8, clientY: rr.top + 8, button: 0 }))
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rr.left + 8, clientY: rr.top + 8, button: 0 }))
    await wait(200)
    return { survivedMousedown, opened: window.__openedPath, cardGone: !document.querySelector('.drives-card.folder-card') }
  `)
  console.log('   ', JSON.stringify(t11))
  check('点击卡片行时卡片不被 mousedown 提前关闭', t11.__err ? false : t11.survivedMousedown === true, JSON.stringify(t11))
  check('点击卡片里的子文件夹会调用 openPath 并关闭卡片',
    t11.__err ? false : t11.opened === 'C:\\Desktop\\FolderA\\Child' && t11.cardGone === true,
    `opened=${JSON.stringify(t11.opened)} cardGone=${t11.cardGone}`)

  console.log('\n================ 汇总 ================')
  const failed = results.filter((r) => !r.pass)
  console.log(`共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
  for (const f of failed) console.log(` FAIL: ${f.n} — ${f.d || ''}`)
  writeFileSync(join(OUT, 'regression.json'), JSON.stringify({ t1, t2, t3, t4, t5, t6, results }, null, 2), 'utf-8')
  clearTimeout(TIMEOUT); srv.close(); app.exit(failed.length ? 1 : 0)
})
