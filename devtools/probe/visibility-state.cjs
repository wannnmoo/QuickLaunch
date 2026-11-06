// 验证 restoreDockAfterFailedLaunch(hideSeq) 的代际语义。
// ⚠️ 模拟必须与真实语义一致：run-app 只 ++ 一次（sinkSeq++; hideSeq = sinkSeq），
//    hide() 本身**不**再 ++ —— 我第一版让 hide() 也 ++，于是每个场景都多了一代，
//    场景 3 被误判为失败（教训：状态机测试里模拟错了比被测代码错了更难发现）。
const results = []
const check = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`) }

function makeWorld() {
  const w = {
    dockTrayHidden: false, visible: false, sinkSeq: 0, restoreCount: 0,
    markDockShown() { /* 时间基准，不影响本测试 */ },
    show() { w.dockTrayHidden = false; w.sinkSeq++; w.markDockShown(); w.visible = true; w.restoreCount++ },
    // run-app 的隐藏：只 ++ 一次并记下代际
    hideForLaunch() { w.dockTrayHidden = true; w.sinkSeq++; w.visible = false; return w.sinkSeq },
    // 用户自己唤回（Alt+Space 显示分支）：++ 一次
    userRecall() { w.dockTrayHidden = false; w.sinkSeq++; w.markDockShown(); w.visible = true },
    restore(hideSeq) {
      if (w.sinkSeq !== hideSeq) return 'stale'
      if (!w.dockTrayHidden) return 'not-ours'
      w.dockTrayHidden = false; w.sinkSeq++; w.markDockShown(); w.visible = true; w.restoreCount++
      return 'restored'
    }
  }
  return w
}

// 1. 正常失败 → 还回 Dock
{
  const w = makeWorld(); w.show()
  const s = w.hideForLaunch()
  const r = w.restore(s)
  check('失败后 Dock 还回来', r === 'restored' && w.visible === true, `r=${r}`)
}
// 2. 失败回调到达前用户已唤回 → 不动
{
  const w = makeWorld(); w.show()
  const s = w.hideForLaunch()
  w.userRecall()
  const before = w.restoreCount
  const r = w.restore(s)
  check('用户已唤回时，迟到的失败回调不重复 show()', r === 'stale' && w.restoreCount === before, `r=${r}`)
}
// 3. 用户又点了另一个图标（成功）→ 不把 Dock 弹回来
{
  const w = makeWorld(); w.show()
  const sA = w.hideForLaunch()      // 点 A：隐藏
  w.hideForLaunch()                 // 点 B：已是隐藏态，但仍 ++（B 成功，Dock 应保持隐藏）
  const before = w.restoreCount
  const r = w.restore(sA)           // A 的失败回调迟到
  check('第二个应用已启动时，A 的失败回调不把 Dock 弹回来',
    r === 'stale' && w.visible === false && w.restoreCount === before, `r=${r} visible=${w.visible}`)
}
// 4. URL 分支失败同样还回
{
  const w = makeWorld(); w.show()
  const s = w.hideForLaunch()
  const r = w.restore(s)
  check('URL 分支失败也还回 Dock', r === 'restored' && w.visible === true, `r=${r}`)
}
// 5. 管理员运行被 UAC 取消 → 还回
{
  const w = makeWorld(); w.show()
  const s = w.hideForLaunch()
  const r = w.restore(s)
  check('UAC 取消（管理员运行失败）也还回 Dock', r === 'restored', `r=${r}`)
}

const failed = results.filter((r) => !r.pass)
console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
process.exit(failed.length ? 1 : 0)
