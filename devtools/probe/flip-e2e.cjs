// 回归验证：**真实应用**里，「隐藏/显示桌面图标」菜单文案是否跟着系统真值翻转。
//
// 为什么必须起真实应用：v1.13.7 的 `flip-test.cjs` 用**模拟的 IPC**（`ipcMain.on(...)`
// 直接返回 true/false）验证了「首帧文案正确」，于是漏掉了真正出问题的地方 ——
// **主进程那段 PowerShell 的 stdout 解析**。v1.13.8 修的 bug 就藏在那里：
// `[DesktopIcons]::SendMessage(...)` 漏了 `[void]`，返回值 IntPtr 被写进 stdout，
// 整段 stdout 变成 "0\n1"，旧解析判成「读失败」→ 缓存永不更新 →
// 菜单文案**永远卡在「隐藏桌面图标」**，而图标本身切换完全正常（用户报的就是这个）。
// 结论：凡是「PowerShell 输出解析」这类 bug，模拟 IPC 的探针**测不出来**，
// 必须跑真实 main + 真实 preload + 真实 renderer，并从外部读注册表当真值对照。
//
// 用法：node devtools/probe/flip-e2e.cjs   （退出码 0 = 通过）
const { spawn, execFileSync } = require('child_process')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = 9222
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ps = (cmd) => {
  try { return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, encoding: 'utf8' }).trim() } catch { return 'ERR' }
}
const regHideIcons = () => ps("(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name HideIcons -ErrorAction SilentlyContinue).HideIcons")
const killAll = () => ps('Get-Process electron,QuickLaunch -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; exit 0')

const TOGGLE_DESKTOP_PS = `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class F {
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c,string n);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p,IntPtr a,string c,string n);
 [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 public static IntPtr DV(){ IntPtr pm=FindWindow("Progman",null); IntPtr dv=FindWindowEx(pm,IntPtr.Zero,"SHELLDLL_DefView",null);
  if(dv==IntPtr.Zero){IntPtr w=IntPtr.Zero; while((w=FindWindowEx(IntPtr.Zero,w,"WorkerW",null))!=IntPtr.Zero){dv=FindWindowEx(w,IntPtr.Zero,"SHELLDLL_DefView",null); if(dv!=IntPtr.Zero)break;}} return dv; } }
'@
$dv=[F]::DV(); if($dv -ne [IntPtr]::Zero){ [void][F]::SendMessage($dv,0x0111,[IntPtr]0x7402,[IntPtr]::Zero); Start-Sleep -Milliseconds 800 }
Write-Output ((Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name HideIcons -ErrorAction SilentlyContinue).HideIcons)`

const OPEN_MENU = `(() => { const b = document.querySelector('.dock-add-btn'); if (!b) return 'no-add-btn'; b.dispatchEvent(new MouseEvent('click', { bubbles: true })); return 'ok' })()`
const READ_LABEL = `(() => { const b = [...document.querySelectorAll('.dropdown-item')].find(x => x.textContent.includes('桌面图标')); return b ? b.textContent.trim() : 'MENU-NOT-OPEN' })()`
const CLICK_ITEM = `(() => { const b = [...document.querySelectorAll('.dropdown-item')].find(x => x.textContent.includes('桌面图标')); if (!b) return 'no-item'; b.dispatchEvent(new MouseEvent('click', { bubbles: true })); return 'ok' })()`
const CLOSE_MENU = `(() => { const b = document.querySelector('.dock-add-btn'); if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true })); return 'ok' })()`

/** 图标可见 → 菜单应提供「隐藏桌面图标」；图标已隐藏 → 应提供「显示桌面图标」 */
const labelFor = (reg) => (reg === '1' ? '显示桌面图标' : '隐藏桌面图标')

async function getTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch { /* 端口还没起来 */ }
    await sleep(400)
  }
  return null
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  }
  const evaluate = (expression) => new Promise((res) => {
    const i = ++id
    pending.set(i, (msg) => res(msg.result && msg.result.result ? msg.result.result.value : null))
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
  return { ready, evaluate, close: () => ws.close() }
}

const results = []
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`  ${ok ? '✔' : '✘'} ${name}${detail ? '  — ' + detail : ''}`) }

;(async () => {
  const baseline = regHideIcons()
  console.log(`系统基线：注册表 HideIcons = ${baseline}（0=图标可见 / 1=图标隐藏）`)
  if (baseline !== '0' && baseline !== '1') { console.log('✘ 读不到注册表，环境异常，放弃'); process.exit(2) }

  killAll(); await sleep(800)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE // 本机环境里可能带了它，会让 electron.exe 退化成 node
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env })
  const logs = []
  child.stdout.on('data', (d) => logs.push(d.toString()))
  child.stderr.on('data', (d) => logs.push(d.toString()))

  try {
    const page = await getTarget()
    if (!page) { console.log('✘ 拿不到 CDP target'); process.exit(1) }
    const c = cdp(page.webSocketDebuggerUrl)
    await c.ready
    await sleep(2500)

    const menuLabel = async () => {
      await c.evaluate(OPEN_MENU); await sleep(250)
      const label = await c.evaluate(READ_LABEL)
      await c.evaluate(CLOSE_MENU); await sleep(150)
      return label
    }
    const clickItem = async () => {
      await c.evaluate(OPEN_MENU); await sleep(250)
      await c.evaluate(CLICK_ITEM); await sleep(2000)
    }

    console.log('\n[1] 启动后的首帧文案（不点任何东西）')
    const l0 = await menuLabel()
    check('文案与系统真值一致', l0 === labelFor(baseline), `文案「${l0}」/ 期望「${labelFor(baseline)}」`)

    console.log('\n[2] 点一次：图标状态与文案必须一起翻')
    await clickItem()
    const r1 = regHideIcons()
    const l1 = await menuLabel()
    check('系统图标状态确实翻转过', r1 !== baseline, `注册表 ${baseline} → ${r1}`)
    check('文案跟着翻转', l1 === labelFor(r1), `文案「${l1}」/ 期望「${labelFor(r1)}」`)
    check('文案与点击前不同（不是卡住）', l1 !== l0, `${l0} → ${l1}`)

    console.log('\n[3] 再点一次：恢复原状，文案也要跟着回来')
    await clickItem()
    const r2 = regHideIcons()
    const l2 = await menuLabel()
    check('图标状态回到基线', r2 === baseline, `注册表 ${r1} → ${r2}`)
    check('文案回到基线', l2 === labelFor(r2), `文案「${l2}」/ 期望「${labelFor(r2)}」`)

    console.log('\n[4] 主进程没报「读失败」（stdout 解析坏了会在这里现形）')
    const all = logs.join('')
    check('无 "[desktop-icons] toggle read failed"', !all.includes('toggle read failed'))

    c.close()
  } finally {
    try { child.kill() } catch {}
    await sleep(600)
    killAll()
    if (regHideIcons() !== baseline) {
      console.log('\n恢复桌面图标到基线…')
      ps(TOGGLE_DESKTOP_PS)
    }
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== ${failed.length === 0 ? '✔ 全部通过' : '✘ ' + failed.length + ' 项失败'} (${results.length - failed.length}/${results.length}) ===`)
  process.exit(failed.length === 0 ? 0 : 1)
})()
