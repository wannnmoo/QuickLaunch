// sendToBottom 补偿逻辑验证 —— **与修复后的 src/main/index.ts 逐行对应**（每行标注源文件行号）。
// 只把 PowerShell 调用替换为可手动触发的回调，控制流完全一致。
// 任何一行逻辑被改动，本探针的结论都会跟着变。
const r = { sinkSeq: 0, sinkState: null, dockTrayHidden: false, events: [], retries: 0 }
let psCallbacks = []
let retryQueue = []

const win = {
  name: 'mainWindow', destroyed: false, visible: true, focused: false,
  isDestroyed() { return this.destroyed },
  isVisible() { return this.visible },
  isFocused() { return this.focused }
}
function recoverDock(w) { r.events.push(`recoverDock(${w.name})`) }
function runPowerShell(_s, _t, done) { psCallbacks.push(done) }
function canSinkNow() { return true }
function setTimeoutStub(fn) { retryQueue.push(fn) }

function sendToBottom(w) {
  if (w.isDestroyed()) return                                      // 1513
  const startSeq = r.sinkSeq                                       // 1514
  if (r.sinkState && r.sinkState.win === w) {                      // 1522
    r.retries += 1
    setTimeoutStub(() => {                                         // 1523
      if (r.sinkSeq !== startSeq) return                           // 1524
      if (!w.isDestroyed() && w.isVisible() && !w.isFocused() && !r.dockTrayHidden && canSinkNow()) {
        sendToBottom(w)                                            // 1526
      }
    })
    return
  }
  r.sinkState = { win: w, seq: startSeq }                          // 1544
  runPowerShell('PS', 4000, ({ err }) => {                         // 1551
    const ours = r.sinkState?.win === w && r.sinkState.seq === startSeq   // 1561
    if (r.sinkState?.win === w) r.sinkState = null                 // 1562
    if (err) { r.events.push('PS 失败，仅日志'); return }            // 1563-1566
    if (ours && r.sinkSeq === startSeq && !w.isDestroyed() && w.isVisible() &&
        !w.isFocused() && !r.dockTrayHidden) {                     // 1568-1571
      return                                                       // 1572
    }
    if (!w.isDestroyed() && w.isVisible()) recoverDock(w)          // 1576
  })
}

function scenario(name, mutate, opts = {}) {
  r.sinkSeq = 1; r.sinkState = null; r.dockTrayHidden = false; r.events = []; r.retries = 0
  psCallbacks = []; retryQueue = []
  win.destroyed = false; win.visible = true; win.focused = false
  sendToBottom(win)
  if (mutate) mutate()
  const cb = psCallbacks.shift()
  if (!cb) { console.log(` FAIL  ${name} —— 没有捕获到 PowerShell 回调`); return false }
  cb({ err: opts.psErr ? new Error('timeout') : null, stdout: '', stderr: '' })
  const recovered = r.events.includes(`recoverDock(${win.name})`)
  const ok = recovered === !!opts.expectRecover
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}`)
  console.log(`        事件=${JSON.stringify(r.events)}  期望 recoverDock=${!!opts.expectRecover}`)
  return ok
}

console.log('=== sendToBottom 补偿逻辑（sinkSeq=1，窗口可见、未获焦点、未收托盘）===\n')
let all = true
// 关键场景：整段时间没有任何「拉回」意图 → 沉底必须保留，绝不能 recoverDock
all = scenario('A 正常沉底（无人拉回）→ 保留沉底、不 recoverDock', null, { expectRecover: false }) && all
all = scenario('B 沉底途中用户唤回（sinkSeq++）→ recoverDock 补偿',
  () => { r.sinkSeq += 1 }, { expectRecover: true }) && all
all = scenario('C 沉底途中隐藏到托盘 → 不 recoverDock 到隐藏窗',
  () => { r.dockTrayHidden = true; win.visible = false }, { expectRecover: false }) && all
all = scenario('D PowerShell 失败 → 不 recoverDock，仅日志', null, { psErr: true, expectRecover: false }) && all
all = scenario('E 沉底途中窗口被销毁 → 不 recoverDock',
  () => { win.destroyed = true }, { expectRecover: false }) && all

console.log('\n=== 串行化重试路径（1517-1527）===')
r.sinkSeq = 1; r.sinkState = null; r.events = []; r.retries = 0; psCallbacks = []; retryQueue = []
win.destroyed = false; win.visible = true; win.focused = false; r.dockTrayHidden = false
sendToBottom(win)                       // 第一次：起 PS
sendToBottom(win)                       // 第二次：进重试分支
console.log(`  第二次调用进入重试分支：${r.retries === 1}`)
const first = psCallbacks.shift()
first({ err: null })                    // 第一次完成 → sinkState 置回 null
console.log(`  第一次完成后 sinkState = ${JSON.stringify(r.sinkState)}`)
console.log(`  待触发的重试数：${retryQueue.length}`)
retryQueue.shift()()                    // 触发重试
const retried = psCallbacks.length > 0
console.log(`  重试是否真的重新发起了沉底：${retried ? '是 ✔' : '否 ✘（第二次让位意图被丢弃）'}`)
if (!retried) all = false

console.log('\n=====================================')
console.log(all ? '全部场景符合预期 ✔' : '存在不符预期的场景（见上方 FAIL）')
process.exitCode = all ? 0 : 1
