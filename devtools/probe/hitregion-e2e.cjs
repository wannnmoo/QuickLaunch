// Regression: the transparent window's hit region must match the real glass bar.
//
// Launches the dev build with a CDP port, reads `.dock-bar` geometry from the renderer,
// then asks Win32 for the actual window region (GetWindowRgn) and compares.
// Covers: default state, overlay open (menu must free the whole window), overlay closed,
// and the `top` edge that mirrors the geometry vertically.
//
//   node devtools/probe/hitregion-e2e.cjs
//
// Exit code 0 = all scenarios pass.

const { spawn, spawnSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const ROOT = path.resolve(__dirname, '..', '..')
const PORT = process.env.QL_CDP_PORT ?? '9222'
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const REGION_PS1 = path.join(__dirname, 'region-probe.ps1')
const TOL = 2

const failures = []
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    console.log(`  FAIL ${name} :: ${detail}`)
    failures.push(name)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForCdp(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page
    } catch {
      /* not up yet */
    }
    await sleep(300)
  }
  throw new Error('CDP target never appeared')
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let id = 0
    const pending = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id)
        pending.delete(msg.id)
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
      }
    })
    ws.addEventListener('open', () =>
      resolve({
        eval: (expression) => {
          const n = ++id
          ws.send(
            JSON.stringify({
              id: n,
              method: 'Runtime.evaluate',
              params: { expression, returnByValue: true, awaitPromise: true, userGesture: true }
            })
          )
          return new Promise((res, rej) => pending.set(n, { res, rej })).then((r) => {
            if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
            return r.result?.value
          })
        },
        close: () => ws.close()
      })
    )
    ws.addEventListener('error', reject, { once: true })
  })
}

// 刚启动/刚 build 完时窗口还没调过 setShape，GetWindowRgn 返回 ERROR(0)、脚本不打印 region box。
// 这里自带重试，避免把「还没上报」当成「region 全错」的假失败（verify 里偶发过）。
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function readRegion(tries = 8) {
  for (let i = 0; i < tries; i++) {
    const r = readRegionOnce()
    if (r) return r
    sleepSync(250)
  }
  return null
}

function readRegionOnce() {
  const out = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', REGION_PS1], {
    encoding: 'utf8'
  }).stdout
  const m = /region box type=(\d+) rel=\((-?\d+),(-?\d+)\)-\((-?\d+),(-?\d+)\)/.exec(out)
  if (!m) return null
  return {
    type: Number(m[1]),
    x: Number(m[2]),
    y: Number(m[3]),
    right: Number(m[4]),
    bottom: Number(m[5]),
    width: Number(m[4]) - Number(m[2]),
    height: Number(m[5]) - Number(m[3])
  }
}

async function barRect(client) {
  return client.eval(
    "(() => { const b = document.querySelector('.dock-bar').getBoundingClientRect(); return {x:b.x,y:b.y,w:b.width,h:b.height,iw:window.innerWidth,ih:window.innerHeight}; })()"
  )
}

// 与 src/main/index.ts 的 DOCK_HIT_INSET 保持一致：玻璃条靠内容那侧的 82px 透明放大区里，
// 只有靠近玻璃条的那 20px 还要留住（悬浮标签顶边在 barTop+24.6、放大图标顶边在 barTop+54.8），
// 剩下的空白内缩掉、让给下层窗口。
const INSET = 20

function expectBarRegion(label, rect, region, { clipBottom = true } = {}) {
  if (!region) {
    check(`${label}: region readable`, false, 'GetWindowRgn produced no box')
    return
  }
  // 放大区/悬浮标签在玻璃条背离窗口贴边侧的那一边：bar 在窗口下半 → 在上方（bottom/middle 档），
  // bar 在窗口上半 → 在下方（top 档）。
  const growUp = rect.y + rect.h / 2 > rect.ih / 2
  const wantTop = growUp ? Math.max(0, Math.round(rect.y + INSET)) : Math.max(0, Math.round(rect.y - 8))
  const wantBottom = growUp
    ? Math.min(rect.ih, Math.round(rect.y + rect.h + 8))
    : Math.min(rect.ih, Math.round(rect.y + rect.h - INSET))
  check(`${label}: region left = bar.x - 8`, Math.abs(region.x - Math.max(0, Math.round(rect.x - 8))) <= TOL, JSON.stringify(region))
  check(
    `${label}: region top = bar.y ${growUp ? '+ 20 (放大区空白内缩)' : '- 8'}`,
    Math.abs(region.y - wantTop) <= TOL,
    JSON.stringify(region)
  )
  check(
    `${label}: region right = bar.right + 8`,
    Math.abs(region.right - Math.min(rect.iw, Math.round(rect.x + rect.w + 8))) <= TOL,
    JSON.stringify(region)
  )
  check(
    `${label}: region bottom = bar.bottom ${growUp ? '+ 8' : '- 20'}`,
    Math.abs(region.bottom - wantBottom) <= TOL && (clipBottom ? region.bottom <= rect.ih + 4 : true),
    JSON.stringify(region)
  )
  // 关键不变量：内缩只能吃透明空白，玻璃条本体（bar 里 82px 之后的 76px）必须整块在 region 内，
  // 否则 SetWindowRgn 会把玻璃条本身裁掉一截。改 INSET 时这一条会先红。
  const glassTop = growUp ? rect.y + 82 : rect.y
  const glassBottom = growUp ? rect.y + rect.h : rect.y + rect.h - 82
  check(
    `${label}: region covers the glass bar itself`,
    region.y <= Math.round(glassTop) + TOL && region.bottom >= Math.round(glassBottom) - TOL,
    JSON.stringify(region)
  )
}

;(async () => {
  if (!fs.existsSync(ELECTRON)) {
    console.error(`electron not found: ${ELECTRON} — run npm install first`)
    process.exit(2)
  }

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  // ⚠️ 单实例锁：如果已经有一份 QuickLaunch/electron 在跑，spawn 出来的这份会立刻退出，
  //    而 waitForCdp() 会连到**旧实例**的窗口上 —— 测的是一份来路不明的窗口（可能还开着
  //    设置中心，region 读到的就是它，表现为「region 全是整窗」的一堆假失败）。
  //    这里不替用户杀进程，直接拒绝运行并说清原因。
  const running = spawnSync('powershell', [
    '-NoProfile',
    '-Command',
    // 注意不要写成 `@(pipeline).Count` —— 那是「把 Measure-Object 的输出包成数组再取长度」，
    // 永远得 1（踩过一次：没有进程也报「有 1 个实例在跑」）。
    '(Get-Process QuickLaunch,electron -ErrorAction SilentlyContinue | Measure-Object).Count'
  ], { encoding: 'utf8' })
  const liveCount = Number(String(running.stdout || '0').trim()) || 0
  if (liveCount > 0) {
    console.error(`another QuickLaunch/electron instance is running (${liveCount} process(es)).`)
    console.error('close it first — otherwise this probe attaches to the stale window:')
    console.error('  Get-Process QuickLaunch,electron -ErrorAction SilentlyContinue | Stop-Process -Force')
    process.exit(2)
  }

  const app = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    env,
    stdio: 'ignore',
    detached: false
  })

  let client
  /** 轮询 region 直到满足 pred（最多 20 × 250ms）。整窗 region 与玻璃条 region 只差 1px，
   *  死等一段时间再断言在忙机器上会偶发红——见场景 1 那段注释。 */
  async function waitForRegion(pred, label, tries = 20) {
    let r = null
    for (let i = 0; i < tries; i++) {
      r = readRegion()
      if (r && pred(r)) return r
      await sleep(250)
    }
    console.log(`  … ${label}: region 在超时前仍未达到预期，最后一次 ${JSON.stringify(r)}`)
    return r
  }

  /** 轮询渲染进程表达式直到返回真值（用于等 React 把 DOM 画出来） */
  async function waitForEval(expr, label, tries = 20) {
    let v = null
    for (let i = 0; i < tries; i++) {
      v = await client.eval(expr)
      if (v) return v
      await sleep(250)
    }
    console.log(`  … ${label}: 表达式在超时前一直为假`)
    return v
  }

  try {
    const page = await waitForCdp()
    client = await connect(page.webSocketDebuggerUrl)
    await sleep(1200)

    console.log('scenario 1: default (glass bar only)')
    // ⚠️ 不能只靠固定 sleep 就断言：`npm run verify` 先在同一个仓库里跑 build，
    //   机器忙时 renderer 首帧 + 上报 region 会晚到几百毫秒，期间窗口还是整窗 region
    //   （= 还没收到 'dock-hit-region'）。实测过一次「default 的 left/top/right 全红、
    //   而 bottom 恰好落在 1px 容差内通过」——整窗 region 与玻璃条 region 只在底边差 1px。
    //   所以这里轮询到「不再是整窗」再断言。
    let rect = await barRect(client)
    for (let i = 0; i < 15; i++) {
      const r = readRegion()
      if (r && r.x > 0) break
      // 每隔几轮主动催一次上报（等价于窗口尺寸变化时 renderer 的那条通道）。
      // 若催了还没效果，说明主进程根本没收到 'dock-hit-region'，是真问题。
      if (i === 4 || i === 9) await client.eval("window.dispatchEvent(new Event('resize')), true")
      console.log(`  … default: 等 region 上报（第 ${i + 1} 次）region=${JSON.stringify(r)} bar=${JSON.stringify(rect)}`)
      await sleep(300)
      rect = await barRect(client)
    }
    expectBarRegion('default', rect, readRegion())

    // 场景 2/3：文件拖入时 `.drop-hint`（position: fixed; bottom: 168px）画在玻璃条
    // **上方**那条透明带里。region 不放开的话 SetWindowRgn 会连绘制一起裁掉它，
    // 用户看到「点了没反应也没解释」。这条断言钉住 overlayOpen 里的
    // `fileDragOver || dropHint` 两项，别让人顺手删了。
    //
    // ⚠️ 合成事件必须带真的 File：`isFileDragEvent()`（App.tsx:147）按
    //    `dataTransfer.types.includes('Files')` 判，空 DataTransfer 会被它直接挡掉，
    //    于是「dragleave 清不掉 fileDragOver」——这不是产品 bug，是造假事件造得不完整。
    // ⚠️ dispatch 之后必须跨一次事件循环再查 DOM：React 18 在事件处理器内批量 flush，
    //    dispatchEvent 同步返回时还没重新渲染，当场 querySelector('.drop-hint') 一定是 null。
    const dropFixture = (type) => `(() => {
      const dt = new DataTransfer()
      dt.items.add(new File(['x'], 'a.lnk', { type: 'application/x-ms-shortcut' }))
      const bar = document.querySelector('.dock-bar')
      const r = bar.getBoundingClientRect()
      bar.dispatchEvent(new DragEvent(${JSON.stringify(type)}, {
        bubbles: true, cancelable: true,
        clientX: r.x + r.width / 2, clientY: r.y + r.height - 40,
        dataTransfer: dt
      }))
      return true
    })()`

    console.log('scenario 2: file drag over the bar frees the whole window (.drop-hint)')
    await client.eval(dropFixture('dragover'))
    // 轮询而不是死等：机器忙时 React 的状态更新 + region 上报都可能晚几百毫秒，
    // 固定 sleep 会在 CI/刚 build 完的机器上偶发红（真实踩过一次 6 项假失败）。
    const hintRect = await waitForEval(`(() => {
      const h = document.querySelector('.drop-hint')
      if (!h) return null
      const r = h.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height, text: h.textContent }
    })()`, '.drop-hint')
    const dragRegion = await waitForRegion((r) => r.x === 0 && r.y === 0, 'drag')
    check('drag: .drop-hint actually rendered', !!hintRect, 'no .drop-hint element after dragover')
    check('drag: region starts at 0,0', !!dragRegion && dragRegion.x === 0 && dragRegion.y === 0, JSON.stringify(dragRegion))
    check(
      'drag: region covers .drop-hint',
      !!dragRegion && !!hintRect && dragRegion.y <= hintRect.y && dragRegion.bottom >= hintRect.y + hintRect.h,
      `${JSON.stringify(dragRegion)} hint=${JSON.stringify(hintRect)}`
    )

    console.log('scenario 3: dropping a bogus shortcut keeps the window open, then closes after the hint')
    await client.eval(dropFixture('drop'))
    // 合成 File 拿不到真实路径 → `showDropHint('未能识别文件路径，添加失败')`，
    // 这条比「松开即添加」更值得测：它是**拖拽结束后**才亮起的纯 `dropHint` 分支。
    const dropHintText = await waitForEval("document.querySelector('.drop-hint')?.textContent ?? null", 'drop hint')
    const afterDropRegion = await waitForRegion((r) => r.x === 0 && r.y === 0, 'drop')
    check('drop: .drop-hint still shown after drop', !!dropHintText, String(dropHintText))
    check('drop: region stays full window while the hint is up', !!afterDropRegion && afterDropRegion.x === 0 && afterDropRegion.y === 0, JSON.stringify(afterDropRegion))
    // `.drop-hint` 自带 2500ms 定时器，等它自己收（真实用户路径上的时间常数）
    let hintGoneAt = 0
    for (let i = 0; i < 24; i++) {
      const left = await client.eval("document.querySelector('.drop-hint')?.textContent ?? null")
      if (!left) {
        hintGoneAt = i
        break
      }
      await sleep(250)
    }
    rect = await barRect(client)
    check('drop: .drop-hint gone after the timer', hintGoneAt > 0 || (await client.eval("document.querySelector('.drop-hint')?.textContent ?? null")) === null, 'hint still present')
    expectBarRegion('hint gone', rect, await waitForRegion((r) => r.x > 0, 'hint gone'))

    console.log('scenario 4: "+" menu open frees the whole window')
    await client.eval("document.querySelector('.dock-add-btn').click()")
    const openRegion = await waitForRegion((r) => r.x === 0 && r.y === 0, 'menu')
    check('menu: region starts at 0,0', !!openRegion && openRegion.x === 0 && openRegion.y === 0, JSON.stringify(openRegion))
    check(
      'menu: region covers the full content box',
      !!openRegion && openRegion.width >= rect.iw - 4 && openRegion.height >= Math.min(300, rect.ih) - 4,
      JSON.stringify(openRegion)
    )

    console.log('scenario 5: closing the menu restores the bar region')
    await client.eval("document.body.dispatchEvent(new MouseEvent('mousedown', {bubbles:true}))")
    rect = await barRect(client)
    expectBarRegion('menu closed', rect, await waitForRegion((r) => r.x > 0, 'menu closed'))

    console.log('scenario 6: `top` edge mirrors the region')
    await client.eval("window.api.setDockEdge('top')")
    rect = await barRect(client)
    const topRegion = await waitForRegion((r) => r.y <= TOL, 'top edge')
    expectBarRegion('top edge', rect, topRegion, { clipBottom: false })
    check('top edge: region hugs the window top', !!topRegion && topRegion.y <= TOL, JSON.stringify(topRegion))

    console.log('scenario 7: back to `middle`')
    await client.eval("window.api.setDockEdge('middle')")
    rect = await barRect(client)
    expectBarRegion('restored', rect, await waitForRegion((r) => r.y > TOL, 'restored'))
  } catch (err) {
    console.error('ERROR:', err.message)
    failures.push('harness')
  } finally {
    if (client) client.close()
    if (!app.killed) {
      app.kill()
      await sleep(400)
      try {
        spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' })
      } catch {
        /* already gone */
      }
    }
  }

  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`)
    process.exit(1)
  }
  console.log('\nall hit-region checks passed')
})()
