// 键盘导航的**确定性**验证（真实输入事件 + 每步先复位状态 + 不依赖上一段的残留）
const { app, BrowserWindow } = require('electron')
const { readFileSync } = require('fs')
const { join } = require('path')
const http = require('http')

const ROOT = join(__dirname, '..', '..')
const DOT = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const e = (id, name, extra = {}) => ({ id, iconDataUrl: DOT, targetPath: 'C:\\Apps\\' + name + '.exe',
  arguments: '', workingDirectory: '', description: name, ...extra })
const G = 900
// 顶层顺序：此电脑(0) 回收站(1) 项目文件夹(2) 开发工具(3) App1(4) App2(5)
const FX = [
  e(1, '此电脑', { targetPath: 'shell:MyComputerFolder', specialType: 'this-pc' }),
  e(2, '回收站', { targetPath: 'shell:RecycleBinFolder', specialType: 'recycle-bin' }),
  e(3, '项目文件夹', { isFolder: true, targetPath: 'D:\\Projects' }),
  e(G, '开发工具', { isGroup: true, targetPath: '' }),
  e(901, 'VSCode', { groupId: G }), e(902, 'Terminal', { groupId: G }), e(903, 'Docker', { groupId: G }),
  e(10, 'App1'), e(11, 'App2')
]

const srv = http.createServer((req, res) => {
  const u = (req.url || '/').split('?')[0]
  if (u === '/' || u === '/index.html') {
    const h = readFileSync(join(ROOT, 'out', 'renderer', 'index.html'), 'utf-8')
      .replace('<head>', `<head><script>
window.api = new Proxy({}, { get: function (t, k) {
  if (k === 'dockEdge') return 'middle';
  if (k === 'loadShortcuts') return function () { return Promise.resolve({ entries: ${JSON.stringify(FX)}, corrupt: false, recovered: false }) };
  if (k === 'listDrives') return function () { return Promise.resolve([]) };
  if (k === 'scanDesktopFolders') return function () { return Promise.resolve([]) };
  if (k === 'checkMissingFolders') return function () { return Promise.resolve([]) };
  if (k === 'listFolder') return function () { return Promise.resolve({ path: '', name: '', folders: 0, files: 0, items: [], truncated: 0 }) };
  if (String(k).startsWith('on')) return function () { return function () {} };
  return function () { return Promise.resolve(null) };
} });
</script>`)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(h); return
  }
  try {
    res.writeHead(200, { 'Content-Type': u.endsWith('.css') ? 'text/css' : 'text/javascript' })
    res.end(readFileSync(join(ROOT, 'out', 'renderer', u.replace(/^\//, ''))))
  } catch { res.writeHead(404); res.end('nf') }
})

// 独立 userData：避免 Chromium 的 per-origin zoom 在探针之间互相污染（会让视口变成 400x100）
app.setPath('userData', require('path').join(__dirname, 'out', 'probe-profile'))

app.disableHardwareAcceleration()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

srv.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port
  await app.whenReady()
  const win = new BrowserWindow({ width: 1200, height: 300, show: true, frame: false, transparent: true,
    webPreferences: { offscreen: true } })
  const wc = win.webContents
  await win.loadURL(`http://127.0.0.1:${port}/`)
  await sleep(1500)
  win.focus(); await sleep(200)

  const results = []
  const check = (n, pass, d) => { results.push({ n, pass, d }); console.log(`${pass ? '  ok  ' : ' FAIL '} ${n}${d ? '  — ' + d : ''}`) }

  const state = () => wc.executeJavaScript(`(() => {
    const el = document.querySelector('.dock-item.selected') || document.querySelector('.dock-add.selected')
    return { sel: el ? ((el.querySelector('.dock-label') || {}).textContent || '(+)') : null,
      addSel: !!document.querySelector('.dock-add.selected'),
      panel: !!document.querySelector('.group-panel'),
      menu: !!document.querySelector('.dropdown-menu') }
  })()`)
  const key = async (k, times = 1, gap = 70) => {
    for (let i = 0; i < times; i++) {
      wc.sendInputEvent({ type: 'keyDown', keyCode: k })
      wc.sendInputEvent({ type: 'keyUp', keyCode: k })
      await sleep(gap)
    }
  }
  /** 按键后**等状态稳定**再读：固定 sleep 会读到 React 还没提交的中间态（本轮踩过）。 */
  const keyAndSettle = async (k, settleMs = 500) => {
    const before = JSON.stringify(await state())
    wc.sendInputEvent({ type: 'keyDown', keyCode: k })
    wc.sendInputEvent({ type: 'keyUp', keyCode: k })
    const deadline = Date.now() + settleMs
    let cur = before
    while (Date.now() < deadline) {
      await sleep(60)
      cur = JSON.stringify(await state())
      if (cur !== before) {
        // 变了之后再确认一次没继续变（React 可能分两帧提交）
        await sleep(120)
        const again = JSON.stringify(await state())
        if (again === cur) return JSON.parse(again)
        cur = again
      }
    }
    return JSON.parse(cur)
  }
  // 复位：清掉选中框、面板与菜单。**还要清掉 localStorage 里的「上次选中位置」**——
  // resumeNavId 会在按方向键时恢复到那里，于是下一段测试的起点不是第一个图标
  // （本探针第一版就因此把起点当成「此电脑」，实际起点是上次留下的「开发工具」）。
  const reset = async (hard = false) => {
    await key('Escape', 3, 120)
    await wc.executeJavaScript(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
    await sleep(200)
    if (hard) {
      await wc.executeJavaScript(`localStorage.removeItem('ql-nav-last')`)
      await wc.reload()
      await sleep(1500)
      win.focus(); await sleep(150)
    }
  }

  console.log('=== 1) 主 Dock 方向键全序列（每步都断言）===')
  await reset()
  const seq = []
  await key('Right')
  seq.push((await state()).sel)
  for (let i = 0; i < 12; i++) { await key('Right', 1, 60); seq.push((await state()).sel) }
  console.log('   → 序列:', JSON.stringify(seq))
  const last = await state()
  check('一路 → 能走到末尾「+」（未被分组面板拦住前，至少覆盖全部顶层）',
    seq.slice(0, 6).join('|') === '此电脑|回收站|项目文件夹|开发工具|VSCode|Terminal',
    `实际 ${JSON.stringify(seq.slice(0, 7))}`)
  check('在分组内继续 → 走到最后一个成员为止', seq[6] === 'Docker', `seq[6]=${seq[6]}`)
  check('分组内再按 → 不再移动（需 ←/Esc 退出面板）', seq[7] === 'Docker', `seq[7]=${seq[7]}`)

  console.log('\n=== 2) 面板打开但选中框在主 Dock：→ 不被面板吸走 ===')
  await reset(true)                          // 清掉「上次选中位置」，起点才能确定
  const s0 = await keyAndSettle('Right')      // 从干净状态起：应选中第一个图标「此电脑」
  console.log('   起点:', JSON.stringify(s0))
  check('干净状态下 → 选中第一个图标', s0.sel === '此电脑', JSON.stringify(s0))
  await wc.executeJavaScript(`(() => { [...document.querySelectorAll('.dock-inner .dock-item')]
    .forEach(el => { if ((el.querySelector('.dock-label') || {}).textContent === '开发工具') el.click() }) })()`)
  await sleep(400)
  const opened = await state()
  check('鼠标点开分组面板', opened.panel === true, JSON.stringify(opened))
  const a1 = await keyAndSettle('Right')
  const a2 = await keyAndSettle('Right')
  const a3 = await keyAndSettle('Right')
  const a4 = await keyAndSettle('Right')
  check('→ 按主 Dock 前进（回收站）', a1.sel === '回收站', JSON.stringify(a1))
  check('→ 再前进（项目文件夹）', a2.sel === '项目文件夹', JSON.stringify(a2))
  check('→ 到分组图标并展开面板、选中第一个成员', a3.sel === '开发工具' || a3.sel === 'VSCode', JSON.stringify(a3))
  check('面板全程保持打开（方向键没有悄悄收起它）', a1.panel && a2.panel && a3.panel, JSON.stringify([a1.panel, a2.panel, a3.panel]))
  console.log('   第 4 次 →:', JSON.stringify(a4))
  await key('Escape', 3, 150)
  const afterEsc = await state()
  check('Esc 收起面板并退出导航', afterEsc.panel === false && afterEsc.sel === null, JSON.stringify(afterEsc))

  console.log('\n=== 3) 面板内导航（→ 进入 / ← 返回 / Esc 返回）===')
  await reset(true)
  // 从干净状态数：→×1 此电脑、×2 回收站、×3 项目文件夹、×4 开发工具（分组图标）
  const g1 = await keyAndSettle('Right')
  const g2 = await keyAndSettle('Right')
  const g3 = await keyAndSettle('Right')
  const g4 = await keyAndSettle('Right')
  console.log('   逐步 →:', JSON.stringify([g1.sel, g2.sel, g3.sel, g4.sel]))
  check('→×4 走到分组图标', g4.sel === '开发工具' && g4.panel === false, JSON.stringify(g4))
  const inPanel = await keyAndSettle('Right')
  check('→ 展开面板并选中第一个成员', inPanel.panel === true && inPanel.sel === 'VSCode', JSON.stringify(inPanel))
  const back = await keyAndSettle('Left')
  check('← 收起面板并回到分组图标', back.panel === false && back.sel === '开发工具', JSON.stringify(back))
  await keyAndSettle('Right')
  const escBack = await keyAndSettle('Escape')
  check('Esc 从面板返回分组图标', escBack.panel === false && escBack.sel === '开发工具', JSON.stringify(escBack))

  console.log('\n=== 4) 重启后恢复上次选中位置 ===')
  await wc.reload()
  await sleep(1500)
  const afterReload = await state()
  check('重载后不自动挂选中框（导航只在按方向键时才亮）', afterReload.sel === null, JSON.stringify(afterReload))
  await key('Right', 1, 200)
  const resumed = await state()
  check('按 → 恢复到上次位置（开发工具）', resumed.sel === '开发工具', JSON.stringify(resumed))

  console.log('\n=== 汇总 ===')
  const failed = results.filter((r) => !r.pass)
  console.log(`共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
  for (const f of failed) console.log(` FAIL: ${f.n} — ${f.d || ''}`)
  srv.close(); app.exit(failed.length ? 1 : 0)
})
