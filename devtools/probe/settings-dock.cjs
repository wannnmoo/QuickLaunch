/**
 * 设置窗 ↔ Dock 让位联动（e2e）。
 *
 * 验收用户要求：「打开设置我希望 DOCK 栏自动隐藏，关闭设置 DOCK 栏自动显示」。
 *
 * 判定信号用渲染进程的 `document.visibilityState`：
 *   BrowserWindow.hide() 会让页面进入 'hidden'，show() 回到 'visible'。
 *   比从外部枚举窗口可靠（多个 BrowserWindow 共享一个进程，MainWindowTitle 不可靠）。
 *
 * 用法：
 *   Remove-Item Env:ELECTRON_RUN_AS_NODE
 *   & .\node_modules\electron\dist\electron.exe devtools/probe/settings-dock.cjs
 * 退出码 0 = 全过。
 */
const { spawn, execFileSync } = require('child_process')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = 9451
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ps = (cmd) => {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
      windowsHide: true,
      encoding: 'utf8'
    }).trim()
  } catch (e) {
    return 'ERR:' + e.message
  }
}
const killApp = () =>
  ps('Get-Process electron,QuickLaunch -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; exit 0')

const results = []
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond })
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`)
}

async function listTargets() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      if (list.length) return list
    } catch {}
    await sleep(400)
  }
  return []
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const ready = new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
  const evaluate = (expression) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, (msg) => {
        const r = msg.result && msg.result.result
        res(r && r.value !== undefined ? r.value : null)
      })
      ws.send(
        JSON.stringify({
          id: i,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true }
        })
      )
    })
  return { ready, evaluate, close: () => ws.close() }
}

/** 等某一类页面出现（dock = 无 query；settings = ?view=settings） */
async function waitFor(kind, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const list = await listTargets()
    const hit = list.find((t) =>
      kind === 'settings' ? t.url.includes('view=settings') : t.type === 'page' && !t.url.includes('view=settings')
    )
    if (hit) return hit
    await sleep(300)
  }
  return null
}

;(async () => {
  killApp()
  await sleep(600)

  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    stdio: 'ignore',
    detached: false
  })

  const dockTarget = await waitFor('dock')
  if (!dockTarget) {
    console.log('FAIL 找不到 Dock 渲染进程（应用没起来？）')
    killApp()
    process.exit(1)
  }

  const dock = cdp(dockTarget.webSocketDebuggerUrl)
  await dock.ready
  await sleep(1500)

  const before = await dock.evaluate('document.visibilityState')
  check('打开前 Dock 可见', before === 'visible', `visibilityState=${before}`)

  const opened = await dock.evaluate('window.api.openSettings()')
  check('openSettings() 返回 true', opened === true, `ret=${opened}`)

  const settingsTarget = await waitFor('settings')
  check('设置窗真的开出来了', !!settingsTarget, settingsTarget ? settingsTarget.url : 'not found')

  await sleep(900)
  const hidden = await dock.evaluate('document.visibilityState')
  check('打开设置后 Dock 自动隐藏', hidden === 'hidden', `visibilityState=${hidden}`)

  if (settingsTarget) {
    const st = cdp(settingsTarget.webSocketDebuggerUrl)
    await st.ready
    const stVisible = await st.evaluate('document.visibilityState')
    check('设置窗自己是可见的', stVisible === 'visible', `visibilityState=${stVisible}`)

    const closed = await st.evaluate('window.api.closeSettings(), true')
    check('closeSettings() 调用成功', closed === true, `ret=${closed}`)
    st.close()
  }

  await sleep(1400)
  const back = await dock.evaluate('document.visibilityState')
  check('关闭设置后 Dock 自动显示回来', back === 'visible', `visibilityState=${back}`)

  dock.close()
  killApp()
  await sleep(300)

  const failed = results.filter((r) => !r.pass)
  console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
  process.exit(failed.length ? 1 : 0)
})().catch((err) => {
  console.log('FAIL 探针异常：', err && err.message)
  killApp()
  process.exit(1)
})
