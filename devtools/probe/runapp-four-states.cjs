// 回归：v1.13.5~v1.13.8 的「四态探询」行为。
// ⚠️ v1.13.8 起主进程里 `PROBE_BEFORE_LAUNCH = false`（用户要求回到 v1.13.4：点图标一律直接启动），
//    整套探询会被打包器静态消除 —— 那时本套件**不适用**，直接跳过（退出码 0）。
//    想跑它：把 `src/main/index.ts` 里那一行改成 true、`npm run build`，再跑本脚本。
const { spawn, execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')

const ROOT = path.join(__dirname, '..', '..')
const BUILT_MAIN = path.join(ROOT, 'out', 'main', 'index.js')
if (!/probeTargetState|PROBE_BEFORE_LAUNCH/.test(fs.readFileSync(BUILT_MAIN, 'utf8'))) {
  console.log('⏭ 主进程构建产物里没有探询代码（PROBE_BEFORE_LAUNCH = false，= v1.13.4 的启动逻辑）')
  console.log('   本套件验证的是 v1.13.5+ 的四态行为，已跳过。想跑它请先把开关改回 true 并重新 build。')
  process.exit(0)
}

const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = 9444
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ps = (cmd) => { try { return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, encoding: 'utf8' }).trim() } catch (e) { return 'ERR:' + e.message } }
const killApp = () => ps('Get-Process electron,QuickLaunch -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; exit 0')
const killTarget = () => ps('Get-Process charmap -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; exit 0')
const count = () => Number(ps("(Get-Process charmap -ErrorAction SilentlyContinue | Measure-Object).Count") || 0)

const EXE = 'C:\\Windows\\System32\\charmap.exe'

async function getTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {}
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
    pending.set(i, (msg) => {
      const r = msg.result && msg.result.result
      res(r && r.value !== undefined ? r.value : null)
    })
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
  return { ready, evaluate, close: () => ws.close() }
}

const results = []
const check = (name, ok, detail) => { results.push(ok); console.log(`  ${ok ? '✔' : '✘'} ${name}${detail ? '  — ' + detail : ''}`) }

/** 轮询等待条件成立（不要用固定 sleep：冷启动/杀软扫描会让它偶尔超时 → 假失败） */
async function waitFor(fn, timeoutMs = 8000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (fn()) return true
    await sleep(200)
  }
  return fn()
}

;(async () => {
  killApp(); killTarget()
  // 等到「目标进程真的没了」再开始：上一轮/上一个探针留下的 charmap 会让 [A] 的进程数断言假失败
  await waitFor(() => count() === 0, 8000)
  await sleep(900)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env })
  const logs = []
  child.stdout.on('data', (d) => logs.push(d.toString()))
  child.stderr.on('data', (d) => logs.push(d.toString()))

  const run = async (c, label, target, args) => {
    const before = count()
    const t0 = Date.now()
    const r = await c.evaluate(`window.api.runApp(${JSON.stringify(target)}, ${JSON.stringify(args)}, '')`)
    const ms = Date.now() - t0
    await sleep(500)
    const after = count()
    console.log(`  ${label}\n     → ${JSON.stringify(r)}  ${ms}ms  charmap 进程 ${before} → ${after}`)
    return { r, before, after, ms }
  }

  try {
    const page = await getTarget()
    if (!page) { console.log('✘ 拿不到 CDP target'); process.exit(1) }
    const c = cdp(page.webSocketDebuggerUrl)
    await c.ready
    await sleep(2500)

    console.log('\n[A] 没在运行 + 无参数（绝大多数 Dock 图标）')
    const a = await run(c, 'charmap.exe / args=""', EXE, '')
    await waitFor(() => count() > 0, 8000) // 冷启动可能慢几秒，轮询而不是死等
    check('真的把它启动了（不再是 probe-failed）', a.r === true && count() > 0, `返回 ${JSON.stringify(a.r)}，进程 ${count()}`)
    killTarget(); await sleep(900)

    console.log('\n[B] 已在运行 + 无参数')
    ps(`Start-Process '${EXE}'`)
    await waitFor(() => count() > 0, 8000)
    const b = await run(c, 'charmap.exe / args=""（已在运行）', EXE, '')
    check('判定为已在运行（返回 true，不弹提示）', b.r === true, `返回 ${JSON.stringify(b.r)}`)
    check('没有多开进程', b.after === b.before, `进程 ${b.before} → ${b.after}`)
    killTarget(); await sleep(900)

    console.log('\n[C] 没在运行 + 带参数（quark / WPS / 钉钉 / GamePP 这类）')
    const cRes = await run(c, 'charmap.exe / args="/?"', EXE, '/?')
    await waitFor(() => count() > 0, 8000)
    check('跳过探询、直接启动', cRes.r === true, `返回 ${JSON.stringify(cRes.r)}，进程 ${count()}`)
    killTarget(); await sleep(900)

    console.log('\n[D] 文件夹路径')
    const d = await c.evaluate(`window.api.runApp('D:\\\\QuickLaunch', '', '')`)
    console.log(`     → ${JSON.stringify(d)}（true = 交给资源管理器打开）`)
    check('文件夹不被四态探询拦住', d === true, `返回 ${JSON.stringify(d)}`)

    console.log('\n=== 主进程 launcher 日志 ===')
    const lin = logs.join('').split('\n').filter((l) => l.includes('[launcher]'))
    console.log(lin.length ? lin.join('\n') : '(无)')
    c.close()
  } finally {
    try { child.kill() } catch {}
    await sleep(600)
    killApp(); killTarget()
  }

  const bad = results.filter((x) => !x).length
  console.log(`\n=== ${bad === 0 ? '✔ 全部通过' : '✘ ' + bad + ' 项失败'} (${results.length - bad}/${results.length}) ===`)
  process.exit(bad === 0 ? 0 : 1)
})()
