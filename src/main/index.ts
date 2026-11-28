import { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, globalShortcut, nativeImage, screen, clipboard } from 'electron'
import { join, basename, extname, dirname, parse } from 'path'
import { readFileSync, writeFileSync, rmSync, existsSync, statSync, watch, copyFileSync, promises as fsp, type FSWatcher, type Dirent } from 'fs'
import { execFile, spawn, type ChildProcess } from 'child_process'
import type {
  AppEntry,
  AppSettings,
  DockEdge,
  FolderChild,
  FolderIconsPayload,
  FolderListing
} from '../shared/types'
import { initLogger, logError, logInfo, logWarn, getLogDir, readRecentLog } from './logger'
import { writeFileAtomic } from './persist'
import { initSettings, registerSettingsIpc, getSettingsCache, flushSettingsWrite } from './settings'
import { externalizeIcons, pruneIcons, registerIconProtocol, registerIconScheme } from './iconStore'
// PowerShell 层（D2 拆分）：所有 C# 常量和统一调用入口都在 ps.ts —— 那里的注释说明了
// 「C# 必须纯 ASCII」的原因，改脚本前先读。
import {
  ACTIVATE_CS,
  DESKTOP_ICONS_CS,
  FOLDER_ICON_SIZE,
  ICON_EXTRACTOR_CS,
  ICON_SIZE,
  PICKED_IMAGE_MAX_EDGE,
  runPowerShell,
  TRAY_CLICK_CS
} from './ps'
// shortcuts.json 持久化层（D2 拆分）：读写/校验/迁移 + load/save/externalize-icons 三个 IPC
// 都在那里，这里只需要在启动时注册一次。
import { registerShortcutsIpc } from './shortcutsStore'
// 音频设备（Core Audio）：枚举 / 切默认。C# 互操作在 ps.ts 的 AUDIO_CS。
import { getAudioSnapshot, setDefaultAudioDevice, getAudioVolume, setAudioVolume, setAudioMute } from './audio'
import { registerSettingsWindowIpc } from './settingsWindow'
import { checkForUpdates, openUpdatePage, scheduleSilentUpdateCheck } from './updater'

// ⚠️ 必须在 app ready **之前**执行：自定义 scheme 的特权只能在 ready 前注册，
//    ready 之后调用会直接抛错（而且这行是模块导入期副作用，import 位置别乱动）。
registerIconScheme()


let mainWindow: BrowserWindow | null = null

/** 向渲染端发一条事件，**任何一步不成立都静默跳过**。
 *
 *  ⚠️ 「窗口还活着」不等于「webContents 还能 send」：渲染进程崩溃后（
 *  `render-process-gone`）窗口对象还在、`mainWindow` 也非 null，但 webContents 已经废了，
 *  对它调 `send()` 会抛错。而崩溃看门狗在限流到上限后会**放弃重建**（crashGaveUp），
 *  这种「窗口在、渲染没了」的状态会一直留到用户重启 —— 期间任何一次改分辨率
 *  （`display-metrics-changed` → `applyDockEdge`）、桌面增删（fs.watch → desktop-changed）
 *  都会撞上它。项目里 `list-folder` 那侧早就为同一类调用写过这道防线，这里补齐。 */
function safeSend(win: BrowserWindow | null, channel: string, ...args: unknown[]): void {
  if (!win || win.isDestroyed()) return
  const wc = win.webContents
  if (!wc || wc.isDestroyed()) return
  try {
    wc.send(channel, ...args)
  } catch (err) {
    logWarn('ipc', `发送 ${channel} 失败（窗口正在销毁）`, err instanceof Error ? err.message : String(err))
  }
}
let forceQuit = false
/** second-instance 到达时窗口还没建好（启动中 / 重建窗口的间隙）：记下来，建好窗口后补一次唤回，
 *  否则用户双击图标启动第二个实例时，这个请求会被静默丢掉（看起来像点了没反应）。 */
let pendingSecondInstanceShow = false
let tray: Tray | null = null
// 系统文件/文件夹对话框打开期间禁止 Dock 沉底：模态对话框跟随父窗口层级，
// 若此时 blur/mouseleave 触发沉底，对话框会被连带压到其他软件下面
let dialogOpen = false

// 单实例锁：防止重复启动（开机自启已在运行、用户又手动启动 exe）时出现两个 Dock。
// 后启动的实例直接退出，并唤起已有实例的窗口。必须在 app ready 前调用。
// 开发模式下除了 electron.exe 实例，还可能出现 `electron-vite dev` 自己拉起的实例，
// 拿不到锁时静默退出会让人以为「点了没反应」，所以留一行日志说明。
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  console.log('[app] 已有实例在运行，本次启动退出')
  app.quit()
} else {
  // 日志必须尽早就绪：后面所有「偶发、只在用户机器上出现」的问题都靠它留痕。
  // 放在单实例锁之后（拿不到锁的进程立刻退出，没必要建日志目录）
  initLogger()
  logInfo('app', `启动 v${app.getVersion()} | electron ${process.versions.electron} | ${process.platform} ${process.arch} | packaged=${app.isPackaged}`)
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!mainWindow.isVisible()) mainWindow.show()
      clearLaunchHide() // 用户又在启动栏上点了第二次：取消可能还在等的那次隐藏
      dockTrayHidden = false
      sinkSeq++
      markDockShown() // 与其它显示路径一致：刚唤回时的 blur 是焦点抖动
      recoverDock(mainWindow)
      mainWindow.focus()
      return
    }
    // 窗口还没建好（whenReady 之前 / recreateWindowForEdge 的间隙）：先记账，
    // whenReady 里 createWindow 之后补做显示 + 恢复置顶；否则这次唤回被静默丢弃。
    pendingSecondInstanceShow = true
  })
}

// Dock 是否隐藏到托盘（我们主动维护的打开/关闭意图状态）。
// 不依赖 isAlwaysOnTop() 判断：当桌面无其他窗口（前台被 Progman 桌面持有）时，
// show()+focus() 的激活会被前台锁拒绝——Dock 短暂获得焦点后约 500ms 被抢回，
// 触发一次虚假 blur 把 Dock 压到底部（仍可见）；此时若按键逻辑读置顶位，就会陷入
// 「显示→被压底→再次显示→再次被压底」的死循环，Alt+Space 永远无法隐藏（v1.7.1 修复）。
let dockTrayHidden = false

// ─── 沉底节流：绝不在「窗口刚露头」时起 PowerShell ──────────────────────────
// 实测（本机 PowerShell 5.1）：`powershell.exe -NoProfile -NonInteractive -Command <WinZ 脚本>`
// 单次 690~785ms CPU 时间——进程启动 ~450ms + .NET 运行时初始化 + Add-Type 编译 C# ~250ms，
// 每次还要额外占几十 MB 私有内存。而 blur 在以下场景里是「假让位」：显示器/DPI 变化重建
// 窗口、开机自启那一下、Dock 被唤回后系统把前台还给原来的窗口。这些都不是用户在点别的软件。
// 所以把「启动/唤回之后 2.5s 内」的 blur 一律忽略：这段时间里 Dock 本来就还没进入
// 稳定置顶态，沉底要么立刻被恢复逻辑撤销（白跑一个进程），要么把 Dock 压到底。
let dockShownAt = 0
/** 「刚显示出来」的沉底宽限期。
 *  ⚠️⚠️ **这个值必须 > `verifyDockOnTop()` 巡检链的最长寿命（5 次 × 250ms = 1250ms）**，
 *  这是一条没写在代码里的隐式耦合：`blur` 路径**不会** `sinkSeq++`，所以能拦住巡检把窗口
 *  重新置顶的只有宽限期。推理：任何合法的沉底都要求距最近一次 `markDockShown()` 已过
 *  2.5s，而那次 `markDockShown()` 启动的巡检链最多活 1.25s，必然早已结束 → 今天不冲突。
 *  **若把这里调到 ≤1250ms（比如为了「让位更跟手」）或加大巡检重试次数，巡检就会在沉底后
 *  重新 `setAlwaysOnTop(true) + moveTop()`，让位特性 100% 失效**（与 v1.13.1 那次回归同症状），
 *  而回归脚本 `sink-logic.cjs` 把 `canSinkNow()` 硬编码成 `return true`，**测不出来**。
 *  更彻底的解法是让 `blur` 也 `sinkSeq++`（代际守卫天然覆盖，不再依赖宽限期长度）。 */
const SINK_GRACE_MS = 2500

/** 记录一次「Dock 应该在上面」的显示时机：恢复置顶与显示窗口的所有路径都要调用它。
 *  它同时是沉底节流的时间基准（见 SINK_GRACE_MS）。 */
function markDockShown(): void {
  dockShownAt = Date.now()
}

/** 现在是否允许沉底：刚显示出来的 2.5s 内不沉（那段时间的 blur 都是焦点抖动）。
 *  这是**省资源**的守卫，不是正确性守卫——真正的正确性由 sinkSeq 代数保证。 */
function canSinkNow(): boolean {
  return Date.now() - dockShownAt > SINK_GRACE_MS
}

// ─── 沉底/恢复的意图代数（v1.11.0 竞态修复）─────────────────────────────
// 沉底不是同步的：blur 里先 setAlwaysOnTop(false)，再由 PowerShell（首次 Add-Type
// 要编译 C#，实测 200ms~1s）异步调 SetWindowPos(HWND_BOTTOM)。这段时间里任何
// 「把 Dock 拉回来」的操作（Alt+Space / 托盘 / 鼠标移回 / 启动失败恢复）都可能发生。
// 原实现只在 PS 回调里补一次 `isAlwaysOnTop()` 判断，但那只能挡住「已恢复置顶」这一种
// 情况——**挡不住 toggleWindow 的隐藏分支**：窗口被 hide() 后 PS 回调可能把 HWND_BOTTOM
// 钉在一个隐藏窗口上，之后再 show() 就埋在别的窗口底下（可见却不在前台的「卡住」状态，
// 只能靠最小化/回桌面才恢复）。改为单调递增的代数：任何「拉回/隐藏」都 ++，
// 沉底任务在启动前与回调里各比对一次，并对同一目标串行化。
let sinkSeq = 0
/** 目标窗口当前是否有沉底任务在跑（用于串行化，避免一次 blur 起一个 powershell.exe） */
let sinkState: { win: BrowserWindow; seq: number; strict: boolean } | null = null
/** 最近一次「发起沉底」的时间戳（不论成功失败）。
 *  `verifyDockOnTop()` 的那条置顶巡检链要靠它让路：巡检每 250ms 断言一次置顶、最长 1.25s，
 *  而沉底要走一个 ~700ms 的 PowerShell —— 巡检晚到一拍就会把刚沉下去的窗口又拉回顶部。
 *  以前靠 `canSinkNow()` 的 2.5s 宽限期错开（巡检链必然早结束），但 watchdog 与
 *  「悬停过 Dock 之后立刻点别的软件」这两条路都不一定在宽限期外，所以再加这条硬闸。 */
let lastSinkAt = 0
/** 最近一次沉底**失败**的时间戳：失败后窗口会被恢复置顶，而 watchdog 下一拍就会再次
 *  判定「该沉底」→ 每 500ms 起一个 powershell.exe 的死循环（每次 ~700ms CPU 时间）。
 *  失败即退避，见 finishSink / sinkWatchdogTick。 */
let lastSinkFailAt = 0

/** 指针是否停在 Dock 窗口上（renderer 的 `dock-pointer` 上报，true/false 都要记）。
 *  ⚠️ 沉底 watchdog 必须看它：悬浮在「中间」档的 Dock 不会因为鼠标移上去就拿到焦点
 *  （前台锁会拒绝），只按 `isFocused()` 判断会把用户正在操作的 Dock 自己沉下去。 */
let dockPointerInside = false
/** 是否是 watchdog 自己把 Dock 沉下去的（不是用户点别的软件触发的 blur）。
 *  只在「可见但被我们压到底」时需要特殊处理：Alt+Space / 托盘再按一次应当是**唤回**，
 *  而不是「隐藏到托盘」——否则用户得按两次才见得着（见 toggleWindow）。 */
let dockAutoSunk = false
/** 用户最后一次在 Dock 窗口里动手（mousemove / keydown / wheel / 按下），renderer 侧节流上报。
 *  只给 `sendToBottom` 的迟到补偿用：PS 要跑 ~700ms，这期间用户若已经把鼠标移回 Dock，
 *  那次沉底就该作废（不能用 `isFocused()` 判：本机焦点状态不可信，见 sinkWatchdogTick）。 */
let lastDockActivityAt = 0

// ─── 启动反馈（V6，v1.18）────────────────────────────────────────────────
// 点图标后先把「起跳」动画播完再把 Dock 收进托盘，否则窗口在 4~10ms 后就消失，
// 动画一帧都看不到（用户只看到 Dock 一闪没了，分不清"点到了"还是"点空了"）。
// 渲染端 `.dock-item.launching .dock-icon` 的动画是 380ms，这里留 300ms：
// 用户看到最夸张的那一段（35% 处起跳最高点已是 133ms），窗口在落回途中收起。
const LAUNCH_HIDE_DELAY_MS = 300
let launchHideTimer: ReturnType<typeof setTimeout> | null = null

/** 取消「延迟隐藏」。任何**用户主动显示**的路径都必须先调它 ——
 *  否则迟到的 hide 会把刚唤回的 Dock 又藏起来（与 sinkSeq 那套是同一种竞态）。 */
function clearLaunchHide(): void {
  if (launchHideTimer) {
    clearTimeout(launchHideTimer)
    launchHideTimer = null
  }
}

/** 把 Dock 拉回前台。统一入口：置顶 + moveTop，并在 120ms 后再补一次——
 *  Windows 的前台激活锁可能拒绝首次激活（尤其刚从 explorer.exe 交接时），
 *  一次性 moveTop 会被 Explorer 的窗口重排盖掉。 */
function recoverDock(win: BrowserWindow): void {
  // ⚠️ 不在这里 markDockShown()：focus / dock-pointer 每次都会走本函数，重置宽限期
  // 会让「点一下 Dock、再点其他软件」的 blur 被 canSinkNow() 吞掉（2.5s 内不让位）。
  // 真正需要宽限期的「显示」路径（toggleWindow 显示分支 / ready-to-show / 托盘显示 /
  // 启动失败恢复）都在调用本函数前显式 markDockShown()。
  logInfo('dock', `recoverDock seq=${sinkSeq} visible=${win.isVisible()} top=${win.isAlwaysOnTop()}`)
  win.setAlwaysOnTop(true)
  win.moveTop()
  setTimeout(() => {
    if (!win.isDestroyed() && win.isVisible()) win.moveTop()
  }, 120)
  // 兜底自愈：上面两步都是异步生效的（setAlwaysOnTop 走的是消息队列，moveTop 只把窗口
  // 提到「同一组内的顶部」，并不重新断言置顶位），而沉底那侧是一个滞后几百毫秒的
  // PowerShell。任何一次顺序错位都会留下「窗口可见、但不置顶、沉在别的窗口下面」的
  // 粘滞状态——用户看到的就是「快捷键怎么按都不出来，只有回桌面才恢复」。
  // 这里主动核实一次，详见 verifyDockOnTop。
  verifyDockOnTop(win, sinkSeq, 0)
}

/** 自愈巡检：窗口「可见、且没有收在托盘里」就应该置顶并持有焦点。
 *  判定用两个信号，缺一不可：
 *   ① dockTrayHidden —— 用户主动收起（Alt+Space / 关窗），不该拉回来；
 *   ② sinkSeq 未变 —— 期间没有发生新的「让位」意图。用户点了别的软件会触发 blur →
 *      sinkSeq++，此时绝不能把窗口拽回来（那就成了和用户对着干）。
 *  两者都满足却仍没拿到焦点，说明是竞态留下的错位状态：补一次置顶断言并复查，
 *  最多 4 次后放弃（永不无限重试）。 */
function verifyDockOnTop(win: BrowserWindow, startSeq: number, attempt: number): void {
  if (attempt > 4) return
  setTimeout(() => {
    if (win.isDestroyed() || win !== mainWindow) return
    if (dockTrayHidden || !win.isVisible()) return
    if (sinkSeq !== startSeq) return // 期间有更新的让位/唤回意图，交给那条路径
    // 刚发起过沉底：巡检链（250ms/次）比沉底的 PowerShell（~700ms）快，再断言置顶就等于
    // 把刚沉下去的窗口重新拉回来。这条守卫只在「沉底后 3s 内」生效，不影响正常自愈。
    if (Date.now() - lastSinkAt < 3000) return
    if (win.isFocused() && win.isAlwaysOnTop()) return // 已经正常，收工
    win.setAlwaysOnTop(true)
    win.moveTop()
    verifyDockOnTop(win, startSeq, attempt + 1)
  }, 250)
}

/**
 * 显示/隐藏 Dock。fromKeyboard=true（Alt+Space）时，显示后额外通知 renderer 进入
 * 键盘导航模式（恢复到上次选中的位置，没有记忆则第一个图标）；托盘点击等鼠标路径不进入导航。
 */
function toggleWindow(fromKeyboard = false): void {
  // ⚠️ 必须连 isDestroyed() 一起判：退出序列里 mainWindow 仍指向已销毁的窗口，
  //    下面第一句 isVisible() 会抛 "Object has been destroyed"（全文件唯一漏点）。
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (dockTrayHidden || !mainWindow.isVisible()) {
    // 隐藏到托盘 / 不可见 → 唤回置顶显示
    clearLaunchHide() // 刚刚点了别的图标还没收起：用户要把它叫回来，取消那次延迟隐藏
    dockTrayHidden = false
    dockAutoSunk = false
    sinkSeq++ // 声明意图：立刻作废在途的沉底（否则它迟到执行会把这扇刚显示的窗钉到底部）
    markDockShown() // 刚开始显示：接下来 2.5s 内的 blur 都是焦点抖动，不沉底
    mainWindow.show()
    recoverDock(mainWindow)
    mainWindow.focus()
    if (fromKeyboard && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('nav-enter')
    }
  } else if (dockAutoSunk) {
    // watchdog 把它压到底之后（可见，但被视频/编辑器盖住）：
    // 这一次 Alt+Space / 托盘点击应当是**唤回**，而不是「隐藏到托盘」——
    // 否则窗口明明看不见，用户还要按两次才见得着。
    // ⚠️ 只在 `dockAutoSunk` 时有这个分支：普通「置顶但被沉底」仍按老规则隐藏，
    //    否则会重新落进 v1.7.1 那个「显示→被压底→再显示」的死循环。
    clearLaunchHide()
    dockAutoSunk = false
    sinkSeq++
    markDockShown()
    mainWindow.setAlwaysOnTop(true)
    recoverDock(mainWindow)
    mainWindow.focus()
    if (fromKeyboard && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('nav-enter')
    }
  } else {
    // 可见（置顶或被沉底）→ 隐藏到托盘
    clearLaunchHide() // 用户自己按下隐藏：不需要那条延迟隐藏再来收一次
    dockAutoSunk = false
    dockTrayHidden = true
    sinkSeq++ // 隐藏同样作废在途沉底：不能让它去操作一扇已隐藏的窗口
    mainWindow.hide()
  }
}

// ─── Shared C# icon extractor (PowerShell + P/Invoke) ───────────────────────


/** Run PowerShell to extract an icon from a DLL/EXE and return a data: URL. */function extractIcon(iconFile: string, iconIndex: number, size = ICON_SIZE): Promise<string> {
  return new Promise((resolve) => {
    const psScript = `${ICON_EXTRACTOR_CS}
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$b64 = [IconExtractor]::GetIconBase64('${iconFile.replace(/'/g, "''")}', ${iconIndex}, ${size})
Write-Output $b64`
    runPowerShell(psScript, 10000, ({ err, stdout }) => {
      // ⚠️ 只取**最后一行**：这个脚本里 `Add-Type` 编译、`[Console]::OutputEncoding`
      //    赋值以及将来任何新增的语句都可能往 stdout 漏一行（v1.13.8 就因为
      //    「未抑制的方法返回值」把桌面图标开关整条特性搞哑了）。base64 是最后写的，
      //    取最后一行即可，比「整段 trim 当载荷」稳得多（与 clickTrayIconFor 一致）。
      const lines = String(stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      const b64 = lines.length > 0 ? lines[lines.length - 1] : ''
      if (err || !b64) { resolve(''); return }
      resolve('data:image/png;base64,' + b64)
    })
  })
}

// ─── IPC: parse .lnk shortcut file via PowerShell ──────────────────────────

// 新增文件/文件夹对话框的默认起始目录 = 桌面。
// ⚠️ 不要写 `existsSync('D:\\Desktop') ? 'D:\\Desktop' : app.getPath('desktop')`：
//    这个值同时决定 `scan-desktop-folders` **扫哪个目录**、`startDesktopWatch` 用
//    `fs.watch` **盯哪个目录**、以及三个对话框的默认位置。桌面被重定向到 D:\Desktop 的
//    机器上 `app.getPath('desktop')` 本来就会返回 D:\Desktop；而在「D:\Desktop 恰好存在
//    但并不是桌面」的机器上，硬编码会让 Dock 把那个目录当成桌面（扫描/监听全错，真桌面
//    新增的文件夹永远不出现）。以系统 shell 文件夹为唯一真相源。
function desktopPath(): string {
  return app.getPath('desktop')
}
const DEFAULT_DIALOG_PATH = desktopPath()

// 解析单个 .lnk/.url/.pif 快捷方式文件，返回该文件的完整信息
function parseLnkFile(filePath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const psScript = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
${ICON_EXTRACTOR_CS}

$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${filePath.replace(/'/g, "''")}')
$targetPath = $s.TargetPath
$isUrl = ($targetPath -match '^(https?|ftp|steam)://|^mailto:')

# .url 文件是 INI 格式：WScript.Shell 读不到 TargetPath（实测为空），
# 需从 INI 解析 URL 字段，否则 isUrl 判定失败导致图标/名称全部丢失
$urlIni = @()
if ([System.IO.Path]::GetExtension('${filePath.replace(/'/g, "''")}').ToLowerInvariant() -eq '.url') {
  $urlIni = Get-Content '${filePath.replace(/'/g, "''")}' -Encoding Default -ErrorAction SilentlyContinue
  if (-not $targetPath) {
    foreach ($line in $urlIni) {
      if ($line -match '^URL\\s*=\\s*(.+)$') {
        $targetPath = $Matches[1].Trim()
        break
      }
    }
    $isUrl = ($targetPath -match '^(https?|ftp|steam)://|^mailto:')
  }
}

# Parse IconLocation: "path,index" -> icon file & index
$iconFile = $targetPath
$iconIdx = 0
$loc = $s.IconLocation
if ($loc -and $loc -match '(.+),(-?\\d+)$') {
    $parsedPath = $Matches[1].Trim()
    if ($parsedPath -and (Test-Path $parsedPath)) {
        $iconFile = $parsedPath
        $iconIdx = [int]$Matches[2]
    }
}

# For .url files: try to read IconFile from the raw INI contents
if ($isUrl -and $urlIni) {
  foreach ($line in $urlIni) {
    if ($line -match '^IconFile\\s*=\\s*(.+)$') {
      $iniIcon = $Matches[1].Trim()
      if ($iniIcon -match '^(https?|ftp)://') {
        # Download favicon to temp file
        try {
          $tmpIco = [System.IO.Path]::GetTempFileName() + '.ico'
          (New-Object System.Net.WebClient).DownloadFile($iniIcon, $tmpIco)
          if (Test-Path $tmpIco) {
            $raw = [System.IO.File]::ReadAllBytes($tmpIco)
            $iconBase64 = [Convert]::ToBase64String($raw)
            Remove-Item $tmpIco -Force
          }
        } catch {}
      } elseif (Test-Path $iniIcon) {
        $iconFile = $iniIcon
        # 逐行标量匹配（数组 -match 不会设置 $Matches，且值可能是空行）
        foreach ($iniLine in $urlIni) {
          if ($iniLine -match 'IconIndex\\s*=\\s*(\\d+)') { $iconIdx = [int]$Matches[1]; break }
        }
      }
      break
    }
  }
}

if (-not $iconBase64) {
  $iconBase64 = ''
  # 图标优先级（通用方案）：
  # 1) IconLocation 指定的图标文件，或快捷方式目标自身——是普通文件就提取（尊重自定义图标）
  if ($iconFile -and (Test-Path $iconFile -PathType Leaf)) {
    $iconBase64 = [IconExtractor]::GetIconBase64($iconFile, $iconIdx, ${ICON_SIZE})
  }
  # 2) 目标是文件夹：SHDefExtractIcon 对目录返回 E_FAIL 无法取图标，上面提取失败时
  #    统一回退系统黄色文件夹图标（与「添加文件夹」select-folder 一致）
  #    尺寸必须用 FOLDER_ICON_SIZE：写死 256 会让同一张黄色文件夹图标出现 256/48 两种
  #    base64 并存（磁盘更大、内存里也多一份无用的高清图）
  #    注意：JS 模板字符串里路径必须写双反斜杠 \\，单反斜杠会被当成转义吞掉
  if (-not $iconBase64 -and $targetPath -and (Test-Path $targetPath -PathType Container)) {
    $iconBase64 = [IconExtractor]::GetIconBase64('C:\\Windows\\System32\\shell32.dll', 4, ${FOLDER_ICON_SIZE})
  }

  # Fallback for URL shortcuts: use default browser icon
  if (-not $iconBase64 -and $isUrl) {
    $browserExe = (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice' -ErrorAction SilentlyContinue).ProgId
    if (-not $browserExe) { $browserExe = 'ChromeHTML' }
    $browserCmd = (Get-ItemProperty "HKLM:\\Software\\Classes\\$browserExe\\shell\\open\\command" -ErrorAction SilentlyContinue).'(Default)'
    if ($browserCmd -and $browserCmd -match '^"([^"]+)"') {
      $iconBase64 = [IconExtractor]::GetIconBase64($Matches[1], 0, ${ICON_SIZE})
    }
    # last resort: globe icon from shell32.dll
    if (-not $iconBase64) {
      $iconBase64 = [IconExtractor]::GetIconBase64('C:\\Windows\\System32\\shell32.dll', 13, ${ICON_SIZE})
    }
  }

  # 终极兜底：目标不存在/图标提取全部失败时给通用文档图标（shell32 index 1），避免 Dock 破图
  if (-not $iconBase64) {
    $iconBase64 = [IconExtractor]::GetIconBase64('C:\\Windows\\System32\\shell32.dll', 1, ${ICON_SIZE})
  }
}

# Extract display name —— 优先级：快捷方式自身描述 → 目标 exe 版本信息 → 快捷方式文件名 → 目标文件名。
# 描述放最前：wscript.exe 这类脚本宿主没有有意义的 FileDescription（会显示成 "Windows Script Host"），
# 而快捷方式自带的描述（如 "DeepSeek Harness"）才是用户在 Explorer 里看到的名称
$displayName = ''
if (-not $displayName) { $displayName = $s.Description }
if (-not $displayName -and -not $isUrl -and $targetPath -and (Test-Path $targetPath)) {
  try { $displayName = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($targetPath).FileDescription } catch {}
}
if (-not $displayName) {
  $displayName = [System.IO.Path]::GetFileNameWithoutExtension('${filePath.replace(/'/g, "''")}')
}
if (-not $displayName -and -not $isUrl -and $targetPath) {
  $displayName = [System.IO.Path]::GetFileNameWithoutExtension($targetPath)
}

@{
  targetPath = $targetPath
  arguments = $s.Arguments
  workingDirectory = $s.WorkingDirectory
  windowStyle = $s.WindowStyle
  hotkey = $s.Hotkey
  iconLocation = $s.IconLocation
  description = $displayName
  iconBase64 = $iconBase64
  isUrl = $isUrl
} | ConvertTo-Json -Compress
`
    runPowerShell(psScript, 10000, ({ err, stdout }) => {
      if (err) { reject(err); return }
      try {
        const data = JSON.parse(stdout.trim())
        if (data.iconBase64) {
          data.iconDataUrl = 'data:image/png;base64,' + data.iconBase64
        }
        delete data.iconBase64
        resolve(data)
      } catch {
        reject(new Error('Failed to parse .lnk file'))
      }
    })
  })
}

/** 弹系统文件/文件夹对话框（三个 IPC 共用）。
 *  ① 对话框打开期间置 dialogOpen + 把 Dock 顶到最前：模态对话框跟随父窗口层级，
 *     否则会被其他软件压下去；
 *  ② 把 `mainWindow` 作为 **parent** 传进去，对话框才是窗口的**真模态子窗口**——
 *     挡住 Dock 的输入（避免用户在对话框开着时又点开菜单/右键菜单，把弹层状态搞乱），
 *     Windows 也会把对话框排进父窗口的 z-order 组。
 *  ⚠️ 不要写 `disabled: true`：`OpenDialogOptions` **没有这个字段**（Electron 的
 *     showOpenDialog 选项只有 title/defaultPath/buttonLabel/filters/properties/message/
 *     securityScopedBookmarks），写进去是空操作；它能骗过 TS 只是因为它是通过
 *     `...(parent ? { disabled: true } : {})` 展开进去的（多余属性检查对展开不生效）。
 *     真正提供模态的是 parent 参数。 */
async function showOpenDialogSafe(options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> {
  dialogOpen = true
  try {
    const win = mainWindow
    if (win && !win.isDestroyed()) {
      // 模态子窗口：挡住 Dock 输入，Windows 也会把对话框排进父窗口的 z-order 组
      win.setAlwaysOnTop(true)
      win.moveTop()
      return await dialog.showOpenDialog(win, options)
    }
    // 窗口还没建好 / 正在重建：退回「无父窗口」重载，不要传 parent!
    return await dialog.showOpenDialog(options)
  } finally {
    // 任何路径（含同步抛错）都必须复位，否则 blur 沉底逻辑会被永久跳过
    dialogOpen = false
  }
}

ipcMain.handle('parse-lnk', async (_event, filePath?: string) => {
  if (!filePath) {
    const result = await showOpenDialogSafe({
      title: '选择快捷方式文件',
      defaultPath: DEFAULT_DIALOG_PATH,
      filters: [
        { name: '所有快捷方式', extensions: ['lnk', 'url', 'pif'] },
        { name: '全部文件', extensions: ['*'] }
      ],
      // openFile + multiSelections：Win32 原生（IFileOpenDialog）支持多选
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return []
    // 多选：逐个解析快捷方式，单个解析失败不影响其余
    const parsed = await Promise.all(
      result.filePaths.map((p) => parseLnkFile(p).catch(() => null))
    )
    return parsed.filter(Boolean)
  }
  // 显式传路径时同样返回数组，保持返回类型一致（LnkInfo[]）。
  // 解析失败（文件坏、PS 超时、JSON 解析失败）时返回空数组而不是让 invoke 直接 reject ——
  // 与上面的对话框分支一致，调用方不必再包一层 try/catch
  try {
    return [await parseLnkFile(filePath)]
  } catch {
    return []
  }
})

// ─── 窗口停靠位置（下 / 中间 / 上，左/右竖排预留）─────────────────────────
// Dock **不支持自由拖动**：窗口位置完全由「位置」预设决定（下/上贴边居中、中间居中），
// 没有 app-region 拖动区、没有位置记忆。要挪位置就点菜单里的「位置」。
// 好处是位置永远确定（不会停在半空 / 拖出屏幕 / 与贴边吸附打架），
// 也省掉了整套拖动期间的位置补偿逻辑（那套在拖动中做不干净，会闪）。
// 左/右竖排的窗口形状与几何已预留在类型和 windowSizeFor/presetPosition 里。

/** 已经实现的停靠位置（左/右竖排还没做：类型里保留，但不接受写入也不需要重建窗口） */
const DOCK_EDGES = ['bottom', 'top', 'left', 'right', 'middle'] as const
// DockEdge 的真相源在 src/shared/types.ts（renderer 的 env.d.ts 也从那里取）
const IMPLEMENTED_EDGES: readonly DockEdge[] = ['bottom', 'top', 'middle']
const isImplementedEdge = (v: unknown): v is DockEdge =>
  typeof v === 'string' && IMPLEMENTED_EDGES.includes(v as DockEdge)
/** 横条 = 图标横向排列（下/上/中间）；竖条 = 图标纵向排列（左右边） */
const isVerticalDock = (edge: DockEdge): boolean => edge === 'left' || edge === 'right'
/** 玻璃条高度（与 CSS 里 .dock-bg 的 76px 一致，**不是** .dock 的 146px——
 *  146 含上方 70px 透明放大区）。「中间」位置用它把可见的玻璃条居中 */
const DOCK_GLASS_H = 76
/** 默认停靠位置：悬浮在屏幕中间（四周都有空间，悬停放大的幅度不受屏幕边缘影响） */
const DEFAULT_EDGE: DockEdge = 'middle'

/** 只存停靠位置（历史文件里的坐标字段会被忽略：不再有自由拖动） */
const layoutPath = join(app.getPath('userData'), 'window-position.json')

/** 当前停靠位置（窗口创建时从记忆里读，切换位置时原地应用或重建窗口） */
let dockEdge: DockEdge = DEFAULT_EDGE
/** 重建窗口期间抑制 window-all-closed 的退出（destroy 旧窗口会触发一次） */
let recreatingWindow = false

/** 读取记忆的停靠位置。只认已实现的三档：历史文件里若残留 left/right（竖排还没做），
 *  一律回落到默认值——否则会建出竖窗口却按横条布局画，选择器还会三档全不亮 */
function readDockEdge(): DockEdge {
  try {
    if (!existsSync(layoutPath)) return DEFAULT_EDGE
    const raw = JSON.parse(readFileSync(layoutPath, 'utf-8')) as Record<string, unknown>
    return isImplementedEdge(raw.edge) ? raw.edge : DEFAULT_EDGE
  } catch { return DEFAULT_EDGE }
}

function writeDockEdge(edge: DockEdge): void {
  try {
    writeFileAtomic(layoutPath, JSON.stringify({ edge }))
  } catch (err) {
    logError('dock-edge', `持久化停靠位置失败: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 停靠位置决定窗口形状：横条是「宽 85% × 高 300」（下/上/中间），竖条（下一阶段）是「宽 300 × 高 85%」 */
function windowSizeFor(edge: DockEdge): { w: number; h: number } {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  if (isVerticalDock(edge)) return { w: 300, h: Math.min(Math.round(height * 0.85), 1200) }
  return { w: Math.min(Math.round(width * 0.85), 1200), h: 300 }
}

/** 各停靠位置的窗口坐标（Dock 不支持自由拖动，位置只由这里决定）：
 *  - 下 / 上：水平居中、吸附到工作区下沿 / 上沿
 *  - 中间：水平居中，并让**可见的玻璃条**（76px，不是 .dock 的 146px）中心落在工作区中心
 *  - 左 / 右：垂直居中、吸附到左沿 / 右沿（竖排下一阶段） */
function presetPosition(edge: DockEdge, size: { w: number; h: number }, wa: Electron.Rectangle): { x: number; y: number } {
  const cx = Math.round(wa.x + (wa.width - size.w) / 2)
  const cy = Math.round(wa.y + (wa.height - size.h) / 2)
  if (edge === 'middle') return { x: cx, y: Math.round(wa.y + wa.height / 2 - size.h + DOCK_GLASS_H / 2) }
  if (isVerticalDock(edge)) return { y: cy, x: edge === 'left' ? wa.x : wa.x + wa.width - size.w }
  return { x: cx, y: edge === 'bottom' ? wa.y + wa.height - size.h : wa.y }
}

/** 目标位置对应的窗口坐标（主显示器工作区内，钳制一次防止分辨率变化后跑出屏幕） */
function positionForEdge(edge: DockEdge, size: { w: number; h: number }): { x: number; y: number } {
  const wa = screen.getPrimaryDisplay().workArea
  const preset = presetPosition(edge, size, wa)
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
  return {
    x: clamp(preset.x, wa.x, wa.x + Math.max(0, wa.width - size.w)),
    y: clamp(preset.y, wa.y, wa.y + Math.max(0, wa.height - size.h))
  }
}

/** 只做「销毁旧窗口 + 按指定位置重建」（竖排换窗口形状时用）。
 *  重建失败会留下「没有窗口」的死状态（Alt+Space 与托盘「显示窗口」都依赖 mainWindow），
 *  所以这里兜一次重试并把错误打出来，至少留下可诊断的痕迹 */
function recreateWindowForEdge(next: DockEdge, hidden: boolean): void {
  recreatingWindow = true
  const old = mainWindow
  mainWindow = null
  try { old?.destroy() } catch {}
  try {
    createWindow(next, hidden)
  } catch (err) {
    logError('window', '重建窗口失败，重试一次', err)
    try { createWindow(next, hidden) } catch (err2) { logError('window', '重建窗口再次失败', err2) }
  } finally {
    // try/finally：万一 createWindow 抛异常，标志位也必须复位，
    // 否则之后真正的「关掉最后一个窗口」会被吞掉，应用退不出去
    recreatingWindow = false
  }
}

/** 应用停靠位置（点菜单里的「位置」）。
 *  **横向三档（下 / 上 / 中间）窗口尺寸完全相同**，所以原地 `setBounds` + 通知渲染端换布局
 *  即可——瞬间生效，不用重建窗口。重建的代价是重跑一遍启动流程（读 shortcuts、PowerShell
 *  扫桌面文件夹、读驱动器），要 1~2 秒。
 *  只有尺寸真的变了（竖排左/右，下一阶段）才重建。
 *  位置只由预设决定：Dock 不支持自由拖动，所以这里不需要任何位置补偿逻辑。 */
function applyDockEdge(next: DockEdge): boolean {
  if (dockEdge !== next) writeDockEdge(next)
  const prev = dockEdge
  dockEdge = next
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow(next, dockTrayHidden)
    return true
  }
  const a = windowSizeFor(prev)
  const b = windowSizeFor(next)
  if (a.w !== b.w || a.h !== b.h) {
    recreateWindowForEdge(next, dockTrayHidden)
    return true
  }
  const pos = positionForEdge(next, { w: b.w, h: b.h })
  mainWindow.setBounds({ x: pos.x, y: pos.y, width: b.w, height: b.h })
  safeSend(mainWindow, 'dock-edge-changed', next)
  return true
}

/** 切换停靠位置。已经在该位置的标准坐标上（±2px）也不早退而不发事件——
 *  渲染端可能是刚重载过的（dev HMR / Ctrl+R），它需要这条事件把布局对齐到真实位置 */
function setDockEdge(next: DockEdge): boolean {
  if (mainWindow && !mainWindow.isDestroyed() && next === dockEdge) {
    const preset = positionForEdge(next, windowSizeFor(next))
    const b = mainWindow.getBounds()
    if (Math.abs(b.x - preset.x) <= 2 && Math.abs(b.y - preset.y) <= 2) {
      // 位置已经对了：只需要把当前停靠位置同步给渲染端
      safeSend(mainWindow, 'dock-edge-changed', next)
      return true
    }
  }
  return applyDockEdge(next)
}

ipcMain.handle('set-dock-edge', (_e, next: unknown) => {
  if (!isImplementedEdge(next)) return false // 左/右竖排未实现：拒绝写入，避免出现竖窗横布局
  return setDockEdge(next)
})

/** 读取当前停靠位置：渲染端挂载时用它对齐（argv 里的 `--ql-edge` 只是建窗那一刻的快照，
 *  而横向三档是原地切换、不重建窗口，所以页面重载后 argv 会过期） */
ipcMain.handle('get-dock-edge', () => dockEdge)

/** 显示器参数变化（分辨率/DPI/主屏切换/显示器增删）后重新归位：
 *  预设坐标与窗口尺寸都按当前工作区算，否则会出现「不再贴边/居中」甚至右端跑出屏幕。
 *  注意：`screen` 模块必须在 app ready 之后才能用，所以注册放在 whenReady 里 */
function reapplyDockEdgeOnDisplayChange(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  applyDockEdge(dockEdge)
  // DPI / 缩放变化后必须**强制**重设一次命中区：`setShape` 收的是 DIP，Electron 内部再
  // 按当前 scale factor 换算成物理像素交给 `SetWindowRgn`。缩放一变，同一份 DIP 矩形对应
  // 的物理 region 就变了，而这时 renderer 未必收到 resize（窗口 DIP 尺寸没变）、去重 key
  // 也没变 —— 不主动清空 key，region 就会一直停在按旧缩放算出来的物理尺寸上，
  // 表现是「改了显示缩放后，玻璃条边缘能点到透明区 / 边缘一段点不到」。
  dockShapeApplied = ''
  applyDockHitRegion()
}

/** 逐条校验持久化条目：只保留形状可用的条目，避免把脏数据喂给 renderer。
 *  - 必须是普通对象（数组 / null / 基本类型丢弃）
 *  - `id` 必须是有限数字；`targetPath` 必须是字符串（分组 / 分隔线存的就是空串）
 *  - `isGroup` / `isSeparator` 只保留 boolean（缺省不补字段）
 *  - `id` 去重，保留第一个
 *  另外兼容早期开发版的字段：separator: 'line' | 'gap' → isSeparator: true。 */
// ─── IPC: select a folder ───────────────────────────────────────────────────

ipcMain.handle('select-folder', async () => {
  const result = await showOpenDialogSafe({
    title: '选择文件夹',
    defaultPath: DEFAULT_DIALOG_PATH,
    // multiSelections + openDirectory：Win32 原生（IFileOpenDialog）支持文件夹多选
    properties: ['openDirectory', 'multiSelections']
  })
  if (result.canceled || result.filePaths.length === 0) return []

  // 每个选中的文件夹提取系统黄色文件夹图标。图标对所有文件夹都是同一个，
  // 所以复用常驻的那一枚（ensureFolderIcon 内部只提取一次）再让所有条目共用——
  // 原来是在 map 里逐个 await extractIcon，一次选 20 个文件夹就要起 20 个
  // powershell.exe（每个 ~500ms、几十 MB 内存）
  await ensureFolderIcon()
  const sharedIcon = folderIcon ?? ''
  return result.filePaths.map((folderPath) => ({
    path: folderPath,
    name: basename(folderPath),
    iconDataUrl: sharedIcon
  }))
})

// ─── IPC: 扫描桌面文件夹 + 系统位置（启动时自动合并） ─────────────────────
// 单次 PowerShell 调用完成全部工作（避免启动时拉起 6 个 powershell 进程）：
// 1) 枚举桌面文件夹 + 指向文件夹的 .lnk 快捷方式（WScript.Shell 解析目标，目标为目录才纳入）
// 2) 提取共享的黄色文件夹图标（shell32 index 4，失败回退通用文档图标 index 1）
// 3) 解析「此电脑」「回收站」注册表 CLSID 图标（失败逐级回退：黄色文件夹图标 → 通用文档图标）
// 返回 { path, name, iconBase64, specialType? }[]。去重由 renderer 完成。

/** 系统位置的显示名留在 TS 侧：PowerShell 命令行按系统 ANSI 代码页解码，
 *  C#/PS 里出现非 ASCII 会让脚本静默编译失败（详见 ACTIVATE_CS 上方说明）。 */
const SPECIAL_LOCATION_NAMES = {
  'this-pc': '此电脑',
  'recycle-bin': '回收站'
} as const

/** 音频切换器：**虚拟条目**（没有真实路径、没有图标文件）。
 *  `targetPath` 只作为 renderer 去重用的稳定 key；图标由渲染端按当前默认设备的
 *  形态现画（耳机 / 扬声器 / HDMI），点开的是设备切换卡片而不是启动进程。
 *  ⚠️ 它由主进程在每次桌面扫描时补进来（与「此电脑」「回收站」同一批），
 *  所以用户删掉后下次桌面变化会回来 —— 与系统位置条目一致，属既定行为。 */
const AUDIO_ENTRY_NAME = '音频'
const AUDIO_ENTRY_PATH = 'ql:audio'

/** 快捷设置：同样是虚拟条目，点开的是贴在 Dock 上方的「快捷设置」卡片
 *  （6 项高频设置 + 「完整设置…」入口），完整表单仍在独立窗口里。 */
const SETTINGS_ENTRY_NAME = '设置'
const SETTINGS_ENTRY_PATH = 'ql:settings'

ipcMain.handle('scan-desktop-folders', async () => {
  const desktop = desktopPath()
  return new Promise((resolve) => {
    const psScript = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
${ICON_EXTRACTOR_CS}

$desktop = '${desktop.replace(/'/g, "''")}'
$results = @()

# 1) Desktop folders plus .lnk shortcuts that point at folders
if (Test-Path -LiteralPath $desktop) {
  Get-ChildItem -LiteralPath $desktop -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $results += @{ path = $_.FullName; name = $_.Name; specialType = $null }
  }
  $shell = New-Object -ComObject WScript.Shell
  Get-ChildItem -LiteralPath $desktop -Filter *.lnk -File -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $s = $shell.CreateShortcut($_.FullName)
      $target = $s.TargetPath
      if ($target -and (Test-Path -LiteralPath $target -PathType Container)) {
        $results += @{ path = $target; name = $_.BaseName; specialType = $null }
      }
    } catch {}
  }
}

# 2) Shared folder icon: yellow folder, fallback to the generic document icon (extracted once)
$folderIcon = [IconExtractor]::GetIconBase64('C:\\Windows\\System32\\shell32.dll', 4, ${FOLDER_ICON_SIZE})
if (-not $folderIcon) {
  $folderIcon = [IconExtractor]::GetIconBase64('C:\\Windows\\System32\\shell32.dll', 1, ${FOLDER_ICON_SIZE})
}

# 3) System locations: This PC / Recycle Bin (CLSID icons from the registry, with fallbacks)
# Display names live on the TypeScript side: the command line is decoded with the
# system ANSI code page, so non-ASCII text must never appear in this script.
$specials = @(
  @{ type = 'this-pc'; clsid = '{20D04FE0-3AEA-1069-A2D8-08002B30309D}'; shell = 'shell:MyComputerFolder' },
  @{ type = 'recycle-bin'; clsid = '{645FF040-5081-101B-9F08-00AA002F954E}'; shell = 'shell:RecycleBinFolder' }
)
foreach ($sp in $specials) {
  $iconPath = (Get-ItemProperty -Path "Registry::HKEY_CLASSES_ROOT\\CLSID\\$($sp.clsid)\\DefaultIcon" -Name '(Default)' -ErrorAction SilentlyContinue).'(Default)'
  $iconFile = 'C:\\Windows\\System32\\shell32.dll'
  $iconIdx = 15
  if ($sp.type -eq 'recycle-bin') { $iconIdx = 31 }
  if ($iconPath) {
    $expanded = [Environment]::ExpandEnvironmentVariables($iconPath)
    if ($expanded -match '^(.+?),(-?\\d+)$') {
      $iconFile = $Matches[1]
      $iconIdx = [int]$Matches[2]
    } else {
      $iconFile = $expanded
      $iconIdx = 0
    }
  }
  $iconB64 = [IconExtractor]::GetIconBase64($iconFile, $iconIdx, ${FOLDER_ICON_SIZE})
  if (-not $iconB64) { $iconB64 = $folderIcon }
  $results += @{ path = $sp.shell; specialType = $sp.type; iconBase64 = $iconB64 }
}

# 4) Attach the shared icon to entries that have none
foreach ($r in $results) {
  if (-not $r.iconBase64) { $r.iconBase64 = $folderIcon }
}

if ($results.Count -gt 0) {
  $results | ConvertTo-Json -Compress -Depth 3
}`
    runPowerShell(psScript, 20000, ({ err, stdout }) => {
      // 音频切换器 / 快捷设置：虚拟条目，**扫描失败也要下发** —— 它们不依赖任何
      // 文件系统信息，而 PowerShell 偶发失败（超时/被杀）不该让这两个入口整条消失。
      const virtualItems = [
        { path: AUDIO_ENTRY_PATH, name: AUDIO_ENTRY_NAME, iconDataUrl: '', specialType: 'audio' as const },
        { path: SETTINGS_ENTRY_PATH, name: SETTINGS_ENTRY_NAME, iconDataUrl: '', specialType: 'settings' as const }
      ]
      if (err || !stdout.trim()) { resolve(virtualItems); return }
      try {
        const items: {
          path: string
          name?: string
          iconBase64?: string
          specialType?: 'this-pc' | 'recycle-bin'
        }[] = JSON.parse(stdout.trim())
        resolve([
          ...items.map((it) => {
            const specialName = it.specialType ? SPECIAL_LOCATION_NAMES[it.specialType] : undefined
            return {
              path: it.path,
              name: specialName ?? it.name ?? '',
              iconDataUrl: it.iconBase64 ? 'data:image/png;base64,' + it.iconBase64 : '',
              ...(it.specialType ? { specialType: it.specialType } : {})
            }
          }),
          ...virtualItems
        ])
      } catch { resolve(virtualItems) }
    })
  })
})

// ─── IPC: 文件夹条目存在性检查（实时清理被删除的桌面文件夹） ─────────────
// 纯 fs 检查（无 PowerShell）；返回传入路径中已不存在（被删除/移动/磁盘未挂载）的子集

ipcMain.handle('check-folders-missing', async (_e, paths: unknown) => {
  if (!Array.isArray(paths)) return []
  const list = paths.filter((p): p is string => typeof p === 'string' && !!p)
  const missing = new Set<string>()
  // 并发上限 16：这些路径最多也就几十条，但逐个 await 会在网络盘上串成一条长队
  await forEachLimited(list, 16, async (p) => {
    try {
      await fsp.access(p)
      return
    } catch {
      // 路径不存在：可能真的被删了，也可能整个卷 / 共享当前不可用（U 盘拔出、
      // 网络盘离线）。后者报「缺失」会让 renderer 把用户手动添加的文件夹条目
      // 永久删掉并落盘，所以先确认根（卷 / 共享）还在。
      const root = parse(p).root
      if (!root) return
      try {
        await fsp.access(root)
      } catch {
        return // 卷 / 共享不可用：不当作「已删除」
      }
      missing.add(p)
    }
  })
  // 按入参顺序返回，行为对 renderer 稳定（内部是并发完成的）
  return list.filter((p) => missing.has(p))
})

// ─── 桌面目录实时监听（fs.watch + debounce）─────────────────────────────
// 桌面目录下任何文件/文件夹的增删改都会触发 'rename'/'change' 事件；debounce 1s
// 聚合后向 renderer 推送 desktop-changed，由 renderer 重新执行「清理缺失 + 扫描合并」：
// 桌面新增文件夹即时加入 Dock，被删除的即时移除（与启动扫描共用同一条合并逻辑）。
// 注意：非递归监听——只关心桌面的直接子项，文件夹内部文件变化不影响。

let desktopWatcher: FSWatcher | null = null
let desktopWatchTimer: ReturnType<typeof setTimeout> | null = null
/** watcher 出错后延迟重建的定时器（桌面监听失效不能永久停更） */
let desktopWatchRetryTimer: ReturnType<typeof setTimeout> | null = null

function startDesktopWatch(): void {
  if (desktopWatchRetryTimer) { clearTimeout(desktopWatchRetryTimer); desktopWatchRetryTimer = null }
  try {
    desktopWatcher = watch(desktopPath(), { persistent: true }, () => {
      if (desktopWatchTimer) clearTimeout(desktopWatchTimer)
      desktopWatchTimer = setTimeout(() => {
        desktopWatchTimer = null
        if (mainWindow && !mainWindow.isDestroyed()) {
          safeSend(mainWindow, 'desktop-changed')
        }
      }, 1000)
    })
    desktopWatcher.on('error', (err) => {
      logError('desktop-watch', '监听出错，3s 后重试', err)
      // 监听器出错后不会自愈：关掉旧的、3s 后重建，否则桌面增删会永久停更
      try { desktopWatcher?.close() } catch {}
      desktopWatcher = null
      if (desktopWatchTimer) { clearTimeout(desktopWatchTimer); desktopWatchTimer = null }
      if (!desktopWatchRetryTimer) {
        desktopWatchRetryTimer = setTimeout(() => {
          desktopWatchRetryTimer = null
          startDesktopWatch()
        }, 3000)
      }
    })
  } catch (err) {
    logError('desktop-watch', '桌面目录监听启动失败', err)
  }
}

/** 收掉桌面监听与在途的 debounce 定时器。非持久化时留着 FSWatcher 只会在退出阶段
 *  多触发一次 flush 前的回调（此时窗口可能已经销毁），显式关闭更干净。 */
function stopDesktopWatch(): void {
  if (desktopWatchRetryTimer) { clearTimeout(desktopWatchRetryTimer); desktopWatchRetryTimer = null }
  if (desktopWatchTimer) { clearTimeout(desktopWatchTimer); desktopWatchTimer = null }
  try { desktopWatcher?.close() } catch {}
  desktopWatcher = null
}

// ─── IPC: hide/show desktop icons ───────────────────────────────────────────
// 方案：向桌面 SHELLDLL_DefView 发送 WM_COMMAND 0x7402 —— 与 Windows
// 「右键桌面 → 查看 → 显示桌面图标」底层完全一致，不依赖 SHChangeNotify
// （该刷新在部分 Win11 系统上不生效）。0x7402 切换后 Explorer 会自动同步
// 注册表 HideIcons，状态由系统持久化。状态读取用 IsWindowVisible(ListView)，
// 比读注册表更贴近真实视觉状态。

/** 读「桌面图标是否隐藏」的 PowerShell 片段（probe 与 toggle 共用）。
 *
 *  读法顺序（v1.13.7 第三次修定下来的，别改回去）：
 *    ① **先读注册表 `HideIcons`**。它由 Explorer 维护、每次切换同步更新（实测
 *       WM_COMMAND 0x7402 之后注册表立刻从 0 变 1），是最可靠的来源；
 *       `IsWindowVisible(ListView)` 只是佐证，在自动化/无桌面的上下文里可能拿不到。
 *    ② 每个 `if` 都要有 `else`：原来写的是
 *         `if ($lv -eq 0) { 读注册表 } else { IsWindowVisible }`
 *       —— 一旦 FindListView 成功但 IsWindowVisible 不可靠，结果就偏了。
 *    ③ 两条路都拿不到 → 输出 `HIDEICONS=?`（= 状态未知），**不要**编一个 0 冒充「可见」。
 *
 *  ⚠️⚠️ 输出必须**带标记**（`HIDEICONS=<0|1>`），解析时只认标记（v1.13.8 修）：
 *    这里踩过一个把整个特性掩盖掉的坑 —— toggle 脚本里的
 *    `[DesktopIcons]::SendMessage(...)` **漏了 `[void]`**，而 PowerShell 会把
 *    **未赋值方法调用的返回值**（IntPtr 0）也写进 stdout，于是 stdout 变成两行
 *    `"0\n1"`；旧解析 `raw !== '0' && raw !== '1'` 把整段判成「读失败」→
 *    toggle 返回 null → 主进程缓存永不更新 → 菜单文案**永远卡在「隐藏桌面图标」**，
 *    而图标本身切换完全正常（用户报的就是「功能好、文案不动」）。
 *    标记式输出 = 「只扫自己那一行」，比「猜整段 stdout 长什么样」稳得多，
 *    以后任何往 stdout 漏东西的写法（Add-Type 警告、新加的方法调用……）都不会再中招。
 *    （同一类坑在托盘点击那条路径上早就有防线：那边用 `split(/\r?\n/).pop()` 取最后一行。） */
const DESKTOP_ICONS_READ_PS = `
$reg = (Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name HideIcons -ErrorAction SilentlyContinue).HideIcons
if ($null -ne $reg -and "$reg" -ne '') {
  Write-Output "HIDEICONS=$reg"
} else {
  $lv = [DesktopIcons]::FindListView()
  if ($lv -eq [IntPtr]::Zero) {
    Write-Output 'HIDEICONS=?'
  } elseif ([DesktopIcons]::IsWindowVisible($lv)) {
    Write-Output 'HIDEICONS=0'
  } else {
    Write-Output 'HIDEICONS=1'
  }
}`

/** 解析脚本 stdout 里的 `HIDEICONS=` 标记。
 *  找不到（脚本没跑完 / 两路都拿不到）返回 **null（状态未知）**，
 *  **不要**返回 false —— false 的语义是「图标可见」，把「读不到」当「可见」
 *  会让文案先渲染错值、再翻成对值（v1.13.7 踩过）。 */
function parseDesktopIconsHidden(stdout: string): boolean | null {
  const hits = String(stdout ?? '').match(/HIDEICONS=([01])/g)
  if (!hits || hits.length === 0) return null
  return hits[hits.length - 1].endsWith('1')
}

/** 真正去探测桌面图标是否隐藏（要起 PowerShell，异步）。结果写入缓存。
 *
 *  ⚠️ 返回 `boolean | null`：**探测失败时返回 null，不要返回 false**。
 *  返回 false 的语义是「图标可见」，而探测失败（超时 / PS 起不来 / 输出为空）时我们
 *  **根本不知道**真实状态。把两者混为一谈会让文案先渲染错值、再翻成对值。
 *
 *  ⚠️ 这个函数**只在启动时调用一次**（且被 await），用它把缓存填好，见 primeDesktopIconsHidden。
 *  不要在别处随手调用：它耗时 50~200ms，任何「菜单打开时再探测一次」都会让文案二次翻转。 */
function probeDesktopIconsHidden(): Promise<boolean | null> {
  return new Promise((resolve) => {
    const psScript = `${DESKTOP_ICONS_CS}${DESKTOP_ICONS_READ_PS}`
    // ⚠️ 超时不能给 5s：这个探测在 `createWindow` **之前**被 await（见 whenReady），
    //    超时多长，用户双击图标后就多久看不到任何东西（窗口、托盘、Alt+Space 都还没建）。
    //    正常冷启动 50~200ms，2s 已经是「慢得离谱」的量级；探测失败时缓存留 null，
    //    渲染端本来就有「不翻转文案」的兜底。
    runPowerShell(psScript, 2000, ({ stdout }) => {
      // 只认标记，不因为 err 就丢弃已经拿到的结果（PS 的非终止错误也会让退出码非零）
      const v = parseDesktopIconsHidden(stdout)
      if (v === null) {
        resolve(null)
        return
      }
      desktopIconsHiddenCache = v
      resolve(v)
    })
  })
}

/** 启动时**同步等**出第一份真值（在 createWindow 之前 await）。
 *
 *  ⚠️⚠️ 这里必须 await、不能「先建窗再异步预热」（v1.13.7 第二次踩）：
 *    renderer 用 `sendSync` 拿 useState 的初始值，那一刻缓存**必须已经填好**；
 *    否则初始值落回 false（= 图标可见），系统里其实是隐藏的 → 菜单先渲染「隐藏桌面图标」，
 *    等挂载后的异步读回来再翻成「显示桌面图标」—— 用户看到的正是这个（报障截图）。
 *    实测：缓存异步预热时同步读拿到 null，文案必然先错后翻。
 *    代价是启动多等约 50~200ms（一次 PowerShell），换文案从首帧就对，值得。 */
async function primeDesktopIconsHidden(): Promise<void> {
  await probeDesktopIconsHidden()
}

/** 读桌面图标隐藏状态 —— **只认缓存，不探测**。
 *
 *  这样「菜单打开时读一次」是零成本、且返回值与 useState 的初始值**必然一致**，
 *  文案不可能翻转。真值由启动时的 primeDesktopIconsHidden() 填、每次切换后写回。
 *  缓存为 null（启动探测失败）时返回 null，renderer 保持现状不翻转。
 *
 *  ⚠️ 不要改成「每次都去探测」：探测 50~200ms，菜单打开时读到的是旧值、
 *  等结果回来再覆盖 → 文案二次翻转（v1.13.7 踩过两次）。 */
function readDesktopIconsHidden(): Promise<boolean | null> {
  return Promise.resolve(desktopIconsHiddenCache)
}

ipcMain.handle('get-desktop-icons-hidden', () => readDesktopIconsHidden())

// 桌面图标隐藏状态的**缓存**：给「渲染进程首帧之前就要拿到真值」用。
// ⚠️ 必须缓存，不能用 sendSync + 异步读：sendSync 要求处理器**同步**设置 event.returnValue，
//    而探测要起 PowerShell、是异步的，在 .then 里赋值就已经晚了。
// ⚠️ 也必须**在 createWindow 之前填好**（见 primeDesktopIconsHidden）：否则首帧拿不到真值。
// 更新路径：① 启动时同步等一次（primeDesktopIconsHidden）② 每次切换后写回实际结果。
// 值为 null = 尚未知 / 探测失败，renderer 端保持默认且不翻转文案。
let desktopIconsHiddenCache: boolean | null = null


ipcMain.on('get-desktop-icons-hidden-sync', (event) => {
  event.returnValue = desktopIconsHiddenCache
})

// 版本号（给「+」菜单底部显示）。用 Electron 的 app.getVersion()：打包后读的是
// package.json 里的 version（electron-builder 写进 app 的 package.json），
// 开发模式读的也是同一个字段，两处一致。
ipcMain.handle('get-app-version', () => app.getVersion())

// ── 更新检查（F1）────────────────────────────────────────────────────────
// 手动检查：菜单「检查更新」→ renderer 拿到结果自己提示（这里不弹窗，避免遮住 Dock）。
ipcMain.handle('check-update', () => checkForUpdates())
ipcMain.handle('open-update-page', (_e, url: unknown) =>
  typeof url === 'string' && /^https?:\/\//i.test(url) ? openUpdatePage(url) : Promise.resolve(false)
)


ipcMain.handle('toggle-desktop-icons', async () => {
  return new Promise<boolean | null>((resolve) => {
    const psScript = `${DESKTOP_ICONS_CS}
$dv = [DesktopIcons]::FindDefView()
if ($dv -eq [IntPtr]::Zero) {
  Write-Output 'TOGGLED=0'
  Write-Output 'HIDEICONS=?'
} else {
  # [void] is REQUIRED here: SendMessage returns an IntPtr which PowerShell would
  # otherwise write to stdout as an extra line (that stray line broke the parse,
  # see DESKTOP_ICONS_READ_PS). No Chinese here - embedded scripts stay ASCII.
  [void][DesktopIcons]::SendMessage($dv, 0x0111, [IntPtr]0x7402, [IntPtr]::Zero)
  Write-Output 'TOGGLED=1'
  Start-Sleep -Milliseconds 500
  ${DESKTOP_ICONS_READ_PS}
}`
    runPowerShell(psScript, 5000, ({ err, stdout, stderr }) => {
      const raw = String(stdout ?? '')
      const next = parseDesktopIconsHidden(raw)
      if (next !== null) {
        desktopIconsHiddenCache = next // 切换后同步缓存，供下次首帧同步读取
        resolve(next)
        return
      }
      logError('desktop-icons', `toggle 读回失败: ${err?.message ?? ''} | stdout=${JSON.stringify(raw.trim())} | stderr=${String(stderr ?? '').slice(0, 200)}`)
      // 读不到结果时的兜底：0x7402 是**翻转**语义，只要命令真的发出去了
      // （TOGGLED=1），新状态必然是旧状态的反面。用它更新缓存，至少不会让缓存
      // 永远停在旧值上（那正是「文案卡住」的成因）。
      // 连缓存都没有（启动探测也失败）才返回 null，renderer 会保留自己的乐观值。
      if (/TOGGLED=1/.test(raw) && desktopIconsHiddenCache !== null) {
        desktopIconsHiddenCache = !desktopIconsHiddenCache
        resolve(desktopIconsHiddenCache)
        return
      }
      // ⚠️ 读不到就读不到，返回 null 表示「状态未知」——
      //    调用方（renderer）据此**保留自己的乐观值**，不要把它当成「图标可见」。
      resolve(null)
    })
  })
})

// ─── IPC: 开机自启动（注册表 HKCU\...\Run 登录项） ───────────────────────
// 用 Electron 原生 app.setLoginItemSettings，无需第三方依赖。
// 打包后 process.execPath 是 QuickLaunch.exe，直接带 --autostart 参数；
// 开发模式下 process.execPath 是 electron.exe，必须附带应用路径参数（第一个
// 非开关参数会被 Electron 当作 app 路径）才会启动本项目。Chromium 写注册表时
// 会自动给含空格的路径加引号，无需手动处理。

function autoStartArgs(): string[] {
  return app.isPackaged ? ['--autostart'] : ['--autostart', app.getAppPath()]
}

function getAutoStartSetting(): boolean {
  // getLoginItemSettings 需传入与 set 相同的 path/args 才能正确匹配注册表项
  return app.getLoginItemSettings({ path: process.execPath, args: autoStartArgs() }).openAtLogin
}

function setAutoStartSetting(enabled: boolean): boolean {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
    args: autoStartArgs()
  })
  return getAutoStartSetting()
}

ipcMain.handle('get-auto-start', () => getAutoStartSetting())
ipcMain.handle('set-auto-start', (_event, enabled: boolean) => setAutoStartSetting(!!enabled))

// 通过 Run 登录项（--autostart 参数）启动时，窗口默认隐藏到托盘，不打扰登录后的桌面；
// Alt+Space / 托盘图标随时唤出。
// 这里只在 whenReady 处读一次，不导出成模块常量：整进程常量会让「切位置重建窗口」
// 也以为自己是开机自启（dockTrayHidden 直接置真 → 新窗口永远不显示）。
const startHiddenAtLogin = process.argv.includes('--autostart')

// ─── IPC: launch an executable, URL, shell location, or open a folder ───────

// 拆分启动参数：按 CommandLineToArgvW 的规则解析——引号内空格不算分隔、引号本身剥离，
// 并处理「反斜杠 + 引号」的奇偶规则（`\\"` 是字面反斜杠 + 引号，`\"` 是转义引号）。
// .lnk 的 Arguments 常常带引号（如 "E:\DSH\start-dsh.vbs"），原样的 split(' ')
// 会把字面引号传给目标（wscript 收到 "\"路径\"" 导致 "Windows Script Host 执行失败"）；
// 同时支持含空格的带引号参数、以及路径末尾的反斜杠（如 "C:\Program Files\"）。
function splitArgs(input: string): string[] {
  const result: string[] = []
  let cur = ''
  let inQuotes = false
  let hasToken = false
  const pushToken = (): void => {
    if (!hasToken) return
    result.push(cur)
    cur = ''
    hasToken = false
  }
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '\\') {
      // 连续 n 个反斜杠后跟引号：前 n/2 个是字面量；n 为奇数时后面的引号是字面引号，
      // 偶数时引号用于开/闭引号段（这里不消费，交给下一轮按引号处理）
      let n = 0
      while (i < input.length && input[i] === '\\') { n++; i++ }
      if (i < input.length && input[i] === '"') {
        cur += '\\'.repeat(n >> 1)
        hasToken = true
        if (n % 2 === 1) { cur += '"'; i++ }
      } else {
        cur += '\\'.repeat(n)
        hasToken = true
      }
      continue
    }
    if (ch === '"') {
      // 引号段内的 "" 是转义的字面量引号
      if (inQuotes && input[i + 1] === '"') { cur += '"'; hasToken = true; i++; continue }
      inQuotes = !inQuotes
      hasToken = true
      continue
    }
    if (!inQuotes && (ch === ' ' || ch === '\t')) {
      pushToken()
      continue
    }
    cur += ch
    hasToken = true
  }
  pushToken()
  return result
}

/** 点图标前是否先探询「目标是不是已经在运行」。
 *
 *  ✅ **v1.19.2 起改为 `true`**：用户报障「微信已经登录了，点图标又弹登录窗；Edge 也开不出已有窗口」——
 *  那正是这里为 `false` 的代价（直接 spawn → 单实例应用多开一个进程 → 微信弹登录窗）。
 *  配套做了两件事，避免回到当年「点了要等 1 秒 / Dock 卡住」：
 *    ① `probeTargetState()` 先花 ~60ms 用 `tasklist` 问一句「这个 exe 的进程在不在」，
 *       **没在运行就直接启动**（绝大多数点击都是这条快路），不再为它付 PowerShell 冷启动；
 *    ② 探询从 `execFileSync` 改成**异步** `execFile` —— 原来那版会在主进程里同步等
 *       ~0.9s（最坏 3.5s），期间 Dock 整个假死（悬停放大、光标动画全停）。
 *
 *  == true== ：先探询（running→激活；tray→点托盘图标唤出；其余→启动）
 *  == false== ：不探询，直接 spawn——微信/QQ 已登录时再点会多开一个实例（弹登录窗） */
const PROBE_BEFORE_LAUNCH = true

ipcMain.handle('run-app', async (_event, targetPath: string, args: string, workingDir: string) => {
  if (!targetPath) return false
  logInfo('launcher', `run-app target=${targetPath}${args ? ` args=${args}` : ''}${workingDir ? ` cwd=${workingDir}` : ''}`)

  // 先判断「目标是不是已经在运行」——是的话激活它的窗口，**绝不再开一个进程**。
  // 必须在隐藏 Dock 之前做：这一路是同步的（PowerShell 约 0.8s），若先隐藏、
  // 再发现只是激活了已有窗口，用户会看到 Dock 无谓地闪一下。
  //
  // 只对「无启动参数的本地 exe」这么做：带参数时用户要的多半是明确的新行为
  // （例如某些工具用参数开新窗口），不能替他改语义。
  if (PROBE_BEFORE_LAUNCH && !args) {
    // 探询/激活走**常驻助手**（预热后每次 ~20ms，见 ensureActivateHelper）。
    // 它内部就是原来那套 C# 判定：running → 激活；tray → UIA 点托盘图标；
    // absent → 启动；failed → fail-open 启动。助手没起来时 probeTargetState 自己退回慢路。
    const state = await probeTargetState(targetPath)
    if (state === 'running') {
      // 已经是用户想要的那个窗口在前台了。按「启动后行为」让出桌面（默认与启动成功一致）
      hideDockAfterLaunch()
      return true
    }
    if (state === 'tray') {
      // 程序在运行、但窗口收在托盘里（微信/QQ 关到托盘就是这种状态）。
      // ⚠️ **绝不能启动新进程**：那会多开一个实例，微信会弹登录窗口 —— 用户报的正是这个。
      // ✅ 正确做法：用 UI Automation 点**它自己的**托盘图标，让应用走自己的恢复流程
      //    （见 clickTrayIconFor；等价于用户自己点托盘图标，不碰它的窗口、不动鼠标）。
      // ⚠️ 也**不要试图直接 `ShowWindow` 把隐藏窗口显示出来**（v1.21 实测踩过）：
      //    微信 4 是 Chromium 应用，躲进托盘时渲染表面已销毁，强行显示只会得到一个
      //    「窗口可见、点哪都没反应」的假窗口。细节见 CLAUDE.md 同名条目。
      const clicked = await clickTrayIconFor(targetPath)
      if (clicked) {
        // ⚠️ 「点到了图标」≠「应用真的把窗口显示出来了」（v1.21.1 修，WeGame 实测）：
        //    WeGame 的托盘图标能点中（`ClickTrayIcon` 返回 1），但它的窗口不会出现 ——
        //    单点 / 真实鼠标单击 / 真实双击 / 再启一次 exe 全都试过，一律无效（进程数保持 1，
        //    说明单实例接管了，只是它自己不建窗）。那种状态下 `clicked === true` 会让上层
        //    以为成功、什么都不提示，用户看到的就是「点了没反应」。
        //    所以这里**复核**：确实出现了可见/最小化窗口才算成功（微信约 1s 才出窗，要轮询）。
        const shown = await waitForWindowShown(targetPath)
        if (shown) {
          hideDockAfterLaunch()
          return true // 已唤出，等同于启动成功
        }
        logWarn('launcher', `已点中托盘图标但目标仍未显示窗口: ${targetPath}`)
        return 'in-tray'
      }
      // UIA 不可用 / 没找到它的托盘图标：退回「提示用户自己点托盘图标」，
      // **依然不启动新进程**（多开出来的是登录窗口，比让用户多点一下糟得多）
      console.log('[launcher] 托盘图标未能点击，提示用户自行点击:', targetPath)
      return 'in-tray'
    }
    if (state === 'failed') {
      // ⚠️⚠️ v1.13.8 修：这里**不再拦**（fail-open），直接落到下面的启动流程。
      //
      // 为什么改成「放行」：`failed` 的真实含义是「进程在、但一个带标题的窗口都没有」
      // （3 次都没探到）。这类目标**恰恰是最需要启动**的 —— 典型就是 Clash Verge
      // 这类 Tauri 托盘型应用：空闲时它只有托盘窗口（`tao_system_tray_app`，隐藏）
      // 和「Tao Thread Event Target」（可见但无标题），**主窗口根本不存在**。
      // 实测（本机，Clash Verge 在托盘里）：
      //   pid=99776  cls=tao_system_tray_app    title=[] visible=False
      //   pid=99776  cls=Tao Thread Event Target title=[] visible=True
      //   pid=99776  cls=MSCTFIME UI / IME      ← 输入法辅助窗口
      // 于是任何版本的探询都只能给出 0，而「拦住不启动」的结果就是**用户永远点不开它**。
      // 既然连窗口都没有，启动它就是唯一能拿到窗口的办法（单实例应用会自己把窗口显示出来）。
      // 用户报的「点了 Clash Verge 只弹提示、打不开」正是这一条。
      //
      // 注意这不等于取消保护：`running`（有窗口 → 激活，绝不新开）与 `tray`
      // （窗口隐藏 → 点托盘图标唤出，绝不强行 ShowWindow）两条依旧照旧。
      console.log('[launcher] 进程在但探不到带标题的窗口，按「直接启动」处理（fail-open）:', targetPath)
    }
  }
  // 'absent' / 进程查询失败 → 继续走下面的启动流程（直接 spawn）

  // 启动目标后按设置里的「启动后行为」让出桌面（默认：隐藏到托盘）：
  // 托盘左键 / Alt+Space / 托盘菜单「显示窗口」随时唤回——toggleWindow 按 dockTrayHidden
  // 意图状态判断，隐藏状态下任何唤回路径都会显示并恢复置顶。
  const hideState = hideDockAfterLaunch()

  // Windows shell: / CLSID → open via explorer (This PC, Recycle Bin, etc.)
  if (targetPath.startsWith('shell:') || targetPath.startsWith('::')) {
    const opened = await new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (ok: boolean): void => {
        if (settled) return
        settled = true
        resolve(ok)
      }
      try {
        // 必须给回调：execFile 不带回调就没人消费 'error' 事件，spawn 失败（PATH 里
        // 没有 explorer / EPERM）会在主进程抛未捕获异常
        execFile('explorer', [targetPath], (err) => {
          // explorer 成功交接给已运行实例后也常以非零码退出；只有 spawn 级失败
          // （err.code 为字符串）才算「没打开」。1.5s 内已按成功返回时，这里只记日志。
          if (err && typeof err.code === 'string') {
            logError('launcher', 'explorer /select 失败', err)
            finish(false)
          }
        })
      } catch (err) {
        logError('launcher', 'explorer 无法启动', err)
        finish(false)
        return
      }
      // explorer 往往把请求转交出去后自身长时间不退出，不能等它退出才返回
      setTimeout(() => finish(true), 1500)
    })
    if (!opened) {
      restoreDockAfterFailedLaunch(hideState)
      return false
    }
    return true
  }

  // Open folder / ordinary file via ShellExecuteEx：与 open-path 一致，await 之后
  // 才知道有没有打开成功（原来直接 fire-and-forget，目标被删掉时用户看到的是
  // 「Dock 消失、什么都没打开」）。
  try {
    const stat = statSync(targetPath)
    if (stat.isDirectory()) {
      const msg = await shell.openPath(targetPath)
      if (msg) {
        logError('launcher', '打开文件夹失败（shell.openPath 返回错误）', msg)
        restoreDockAfterFailedLaunch(hideState)
        return false
      }
      return true
    }
    // 已存在但不是 exe/com 的文件：execFile 只对 PE 有效（.bat/.cmd 甚至无法直接
    // CreateProcess），交给系统按文件关联打开 —— .lnk/.url/.pif、文档、脚本、msi
    // 都走这里，与资源管理器双击一致。
    if (stat.isFile()) {
      const ext = extname(targetPath).toLowerCase()
      if (ext !== '.exe' && ext !== '.com') {
        const msg = await shell.openPath(targetPath)
        if (msg) {
          logError('launcher', '打开文件失败（shell.openPath 返回错误）', msg)
          restoreDockAfterFailedLaunch(hideState)
          return false
        }
        return true
      }
    }
  } catch {
    // not a filesystem path, continue
  }

  // URL
  if (/^(https?|ftp|steam):\/\/|^mailto:/i.test(targetPath)) {
    // openExternal 返回 Promise：没有注册的协议处理器（如未装客户端的 mailto:/steam:）
    // 会 reject。必须 await 并把失败如实回报，否则 renderer 先收到 true、Dock 却
    // 在之后偷偷弹回来，用户看不到任何提示。
    try {
      await shell.openExternal(targetPath)
      return true
    } catch (err) {
      logError('launcher', 'shell.openExternal 失败', err)
      restoreDockAfterFailedLaunch(hideState)
      return false
    }
  }

  // Executable
  //
  // ⚠️ 这里**必须等 spawn 结果再返回**（v1.13.4 修）。原实现是
  //   execFile(target, args, cb)  然后**立刻** `return true` —— 而 spawn 失败是
  //   **异步**通知 cb 的。实测：目标不存在时 handler 在 ~1ms 就返回了 true，
  //   而 ENOENT 要到 ~400ms 后才在 cb 里到达。
  //   后果：renderer 那句 `if (ok === false) showDropHint('启动失败：…')` **永远不可能触发** ——
  //   Dock 约 0.4s 后自己弹回来、却一句解释都没有，正是那句提示想避免的体验。
  //   现在改为监听 'spawn' / 'error' 两个事件：'spawn' 表示进程真的起来了（立刻 resolve），
  //   'error' 表示没能起来（resolve false）——都不必等进程退出。
  //   ⚠️ 不能用 execFile 的完成回调来判成功：对 GUI 程序那个回调要等**程序关闭**才触发，
  //      挂在它上面会让这个 IPC 挂到用户关掉应用为止。
  const spawnOutcome = await new Promise<'ok' | 'spawn-failed'>((resolve) => {
    let settled = false
    let child: ReturnType<typeof execFile> | null = null
    try {
      child = execFile(
        targetPath,
        args ? splitArgs(args) : [],
        { cwd: workingDir || undefined },
        // 完成回调只用于「起来了但退出码非零」的日志；成功/失败已由下面的事件定夺
        (err) => {
          if (!err) return
          if (typeof err.code === 'string') return // spawn 级失败已由 'error' 处理
          console.log(`[launcher] 目标已启动但退出码非零 (${err.code}): ${targetPath}`)
        }
      )
    } catch (err) {
      // execFile 对非法参数等会同步抛错，不是所有失败都会走 'error' 事件
      logError('launcher', 'execFile 抛异常', err)
      resolve('spawn-failed')
      return
    }
    if (!child) {
      resolve('spawn-failed')
      return
    }
    const proc = child
    proc.once('spawn', () => {
      if (settled) return
      settled = true
      // 与子进程解绑：主进程不再关心它的生死（GUI 程序可能跑几小时），
      // 否则父进程会一直持有句柄、退出时还要等它
      proc.unref?.()
      resolve('ok')
    })
    proc.once('error', (err: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      const code = err.code
      // spawn 被拒（EACCES/EPERM）：通常是程序需要管理员权限，或安全软件拦了裸的
      // CreateProcess。回退到系统 Shell 启动（ShellExecuteEx）——与资源管理器双击
      // 行为一致，会自动弹 UAC 提权。代价是丢弃启动参数。这是已处理的流程，不再打堆栈。
      if (code === 'EACCES' || code === 'EPERM') {
        console.log(`[launcher] Direct spawn blocked (likely admin required); falling back to Shell: ${targetPath}`)
        // ⚠️ 回退结果必须如实回报：openPath 返回非空错误串说明 UAC 被拒 / 没有关联
        // 程序，此时 Dock 要弹回来并提示失败（旧实现无条件 resolve('ok')，用户只看到
        // 「点了没反应 + Dock 消失」）。
        void (async () => {
          try {
            const msg = await shell.openPath(targetPath)
            if (msg) {
              logError('launcher', 'ShellExecute 兜底也失败', msg)
              resolve('spawn-failed')
              return
            }
            resolve('ok')
          } catch (e) {
            logError('launcher', 'ShellExecute 兜底抛异常', e)
            resolve('spawn-failed')
          }
        })()
        return
      }
      logError('launcher', '启动失败', err)
      resolve('spawn-failed')
    })
  })

  if (spawnOutcome === 'spawn-failed') {
    logWarn('launcher', `run-app spawn 失败，Dock 回滚: ${targetPath}`)
    restoreDockAfterFailedLaunch(hideState)
    return false // renderer 据此提示「启动失败：目标不存在或无法运行」
  }
  logInfo('launcher', `run-app 已启动: ${targetPath}`)
  return true
})


// ─── 设置中心打开期间的 Dock 让位（开设置自动藏、关掉自动回来）──────────────
// 与下面的 hideDockAfterLaunch 是两套语义：那条按用户设置的三态走（hide / keep / sink），
// 这条是**固定行为**——设置窗是普通窗口，而 Dock 是 alwaysOnTop，两者叠在一起时
// 设置窗的标题栏会被 Dock 压住，用户根本拖不动窗口。
//
// 用独立布尔记「这一次是我们藏的」而不是复用 dockTrayHidden：用户可能在此之前
// 就把 Dock 收在托盘里了（那种情况下开设置不该「顺便」改变关窗后的状态）。
let dockHiddenBySettings = false

function hideDockForSettings(): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  if (!win.isVisible()) return // 本来就在托盘里 —— 不动，也不记账
  dockHiddenBySettings = true
  dockTrayHidden = true
  sinkSeq++ // 作废在途沉底：不能让它去操作一扇即将隐藏的窗口
  win.hide()
  logInfo('dock', '设置中心打开，Dock 让位')
}

function showDockAfterSettings(): void {
  if (!dockHiddenBySettings) return
  dockHiddenBySettings = false
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  dockTrayHidden = false
  sinkSeq++ // 作废在途沉底
  markDockShown() // 刚显示：2.5s 内的 blur 都是焦点抖动，别立刻让位
  win.show()
  recoverDock(win)
  logInfo('dock', '设置中心关闭，Dock 回来')
}

/** 一次「启动后让位」的结果：模式 + 当时 sinkSeq 代际（回滚只认这一代）。 */
type LaunchHideState = { mode: 'hide' | 'keep' | 'sink'; seq: number }

/**
 * 启动目标后如何处理 Dock（设置里的「启动后行为」三态）：
 * - `hide`（默认）：收进托盘，把整块桌面让出来；托盘 / Alt+Space 随时唤回。
 * - `keep`：什么都不做，Dock 留在原地（用户习惯把 Dock 当常驻工具条）。
 * - `sink`：不收托盘，但沉到 z-order 最底让位；鼠标移回或点它即恢复置顶。
 *
 * 三种模式都要 `sinkSeq++`（除了 keep 那种「什么都不改」的语义）——
 * 隐藏与沉底在异步落地的过程中，任何后续唤回都必须能作废它们。
 */
function hideDockAfterLaunch(): LaunchHideState {
  const win = mainWindow
  const mode = getSettingsCache().afterLaunch
  // 连点两个图标时只保留最后一条延迟隐藏（旧的那条若还在跑，会把第二次启动的窗口提前藏掉）
  clearLaunchHide()
  if (!win || win.isDestroyed() || mode === 'keep') {
    return { mode: 'keep', seq: sinkSeq }
  }
  if (mode === 'sink') {
    sinkSeq++
    // ⚠️ 必须先 `setAlwaysOnTop(false)` 再 `sendToBottom()`（v1.19.3 修）：
    // `SetWindowPos(HWND_BOTTOM)` 对**置顶窗口**只是把它沉到「置顶层内部的最底」，
    // 依然盖在所有普通窗口上面 —— 于是「让位沉底」看起来毫无效果（用户报障：
    // 「点了应用 Dock 还挡着，不会退到后台」）。降级置顶 + 真正沉底两步缺一不可，
    // 与 blur / watchdog 两条让位路径保持一致。
    win.setAlwaysOnTop(false)
    // strict：这一次沉底不许被「指针还在玻璃条上」撤销（点图标必然如此，见 sendToBottom 的注释）
    sendToBottom(win, true)
    // 被我们主动压到底之后，Alt+Space / 托盘按一次应当是「唤回」而不是「隐藏到托盘」
    dockAutoSunk = true
    return { mode: 'sink', seq: sinkSeq }
  }
  dockTrayHidden = true
  sinkSeq++
  const seq = sinkSeq
  // V6：延迟 LAUNCH_HIDE_DELAY_MS 再真的 hide()，把渲染端的起跳动画放完。
  // ⚠️ 这个定时器有两条必须守住的约束：
  //   ① 代际守卫（sinkSeq !== seq）——期间用户按 Alt+Space / 托盘唤回、或又点了
  //      另一个图标，本次隐藏意图就该作废，不能把刚显示的窗口再藏起来；
  //   ② `dockTrayHidden` 在这里**立刻**置真（而不是等定时器里再置）：这 300ms 内
  //      窗口仍然可见，若 blur 先到，`dockTrayHidden` 已能让让位逻辑跳过，
  //      也不会让 verifyDockOnTop 把窗口重新置顶（那一支同样看这个标志）。
  launchHideTimer = setTimeout(() => {
    launchHideTimer = null
    if (sinkSeq !== seq) return
    const w = mainWindow
    if (!w || w.isDestroyed() || !dockTrayHidden) return
    w.hide()
  }, LAUNCH_HIDE_DELAY_MS)
  return { mode: 'hide', seq }
}

/** 启动失败后把 Dock 还给用户：点图标时已经先让位，若不还回来，
 *  用户看到的是「Dock 消失、什么都没启动」，只能靠 Alt+Space 找回。
 *
 *  ⚠️ 必须传**这次让位时**的 state（含 sinkSeq 代际），不能只看 `dockTrayHidden`
 *  （v1.13.4 修，这条是实测出来的）：
 *  spawn 失败是**异步**通知的（实测 ~400ms 后）。这段时间里用户完全可能
 *  ① 自己 Alt+Space 唤回，或 ② 又点了另一个图标并成功启动。
 *  那时 `dockTrayHidden` 的**值**可能凑巧又是 true（比如被第二次 run-app 重新置真），
 *  只比值就会把第二个应用刚启动的 Dock 又弹出来。比对**代际**才准确：
 *  代际不同 ⇒ 这次让位早已不是当前意图，什么也别做。 */
function restoreDockAfterFailedLaunch(state: LaunchHideState): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (sinkSeq !== state.seq) return // 期间有更新的意图（唤回 / 又启动了一个）—— 不抢用户的操作
  if (state.mode === 'keep') return // Dock 本来就没动过
  // 失败通知可能早于那条 300ms 的延迟隐藏（V6）：先撤掉它，否则它会在恢复之后再藏一次
  clearLaunchHide()
  if (state.mode === 'sink') {
    sinkSeq++ // 作废在途沉底
    // 启动后那次沉底会把 dockAutoSunk 置真（「可见但压在底下」）。失败恢复已经把窗口
    // 拉回置顶层了，标记必须一起清 —— 否则下一次 Alt+Space / 托盘点击命中
    // toggleWindow 的「唤回」分支（位置本来就在顶上）→ 按一下**毫无反应**。
    dockAutoSunk = false
    recoverDock(mainWindow)
    return
  }
  if (!dockTrayHidden) return // 已经不是「我们藏起来」的状态了
  dockTrayHidden = false
  sinkSeq++ // 作废在途沉底：Dock 被还给用户后不能再被压到底部
  markDockShown()
  mainWindow.show()
  recoverDock(mainWindow)
}

// ─── IPC: 右键菜单扩展（编辑图标 / 管理员运行 / 打开位置 / 复制路径） ───────

// 为条目更换图标：选择 exe/dll/ico → SHDefExtractIcon 提取；png/jpg 直接读文件转 dataURL
ipcMain.handle('pick-icon', async () => {
  const result = await showOpenDialogSafe({
    title: '选择图标（exe / dll / ico / png）',
    defaultPath: DEFAULT_DIALOG_PATH,
    filters: [{ name: '图标文件', extensions: ['exe', 'dll', 'ico', 'png', 'jpg'] }],
    properties: ['openFile']
  })
  const file = result.canceled ? '' : result.filePaths[0]
  if (!file) return null
  if (/\.(png|jpe?g)$/i.test(file)) {
    try {
      // 不直接 readFileSync + base64：原图可能几 MB，会把整张照片塞进
      // shortcuts.json（每次保存都跨进程克隆 + 重序列化）。走 nativeImage 统一缩到图标尺寸。
      const img = nativeImage.createFromPath(file)
      if (img.isEmpty()) return null
      const { width, height } = img.getSize()
      const maxEdge = Math.max(width, height)
      const icon = maxEdge > PICKED_IMAGE_MAX_EDGE
        ? (width >= height
            ? img.resize({ width: PICKED_IMAGE_MAX_EDGE })
            : img.resize({ height: PICKED_IMAGE_MAX_EDGE }))
        : img
      return { path: file, iconDataUrl: icon.toDataURL() }
    } catch { return null }
  }
  const iconDataUrl = await extractIcon(file, 0, ICON_SIZE)
  return iconDataUrl ? { path: file, iconDataUrl } : null
})

// ─── IPC: 拖放添加（解析拖入的文件路径） ────────────────────────────────────
// renderer 用 webUtils.getPathForFile 拿到拖入文件的真实路径（Electron 32+ 已移除
// File.path），这里按类型分派成可持久化的条目：
//   .lnk/.url/.pif → parseLnkFile（与「添加快捷方式」同一套解析 + 图标兜底链）
//   .exe/.com      → 单次 PowerShell 调用批量取 FileDescription + 图标（避免 N 个进程）
// 其余（文件夹、文档、其它扩展名、目标为空的坏快捷方式）归入 rejected，
// 由 renderer 汇总成「已跳过 N 个」提示。

const SHORTCUT_EXTS = new Set(['.lnk', '.url', '.pif'])
const EXEC_EXTS = new Set(['.exe', '.com'])

interface DroppedEntry {
  targetPath: string
  arguments: string
  workingDirectory: string
  description: string
  iconDataUrl: string
}

/** 批量取 exe/com 的显示名（FileDescription → 文件名）、图标与工作目录，单次 PowerShell 调用。 */
function describeExecutables(paths: string[]): Promise<{ path: string; name: string; iconDataUrl: string }[]> {
  return new Promise((resolve) => {
    // 路径统一单引号包裹（'' 转义），含空格/中文的路径不会被拆断
    const psList = paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(', ')
    const psScript = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
${ICON_EXTRACTOR_CS}
$out = @()
foreach ($p in @(${psList})) {
  $name = ''
  try { $name = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($p).FileDescription } catch {}
  if (-not $name) { $name = [System.IO.Path]::GetFileNameWithoutExtension($p) }
  $b64 = [IconExtractor]::GetIconBase64($p, 0, ${ICON_SIZE})
# Fallback to the generic document icon (shell32 index 1) when extraction fails
  if (-not $b64) { $b64 = [IconExtractor]::GetIconBase64('C:\\Windows\\System32\\shell32.dll', 1, ${ICON_SIZE}) }
  $out += @{ path = $p; name = $name; iconBase64 = $b64 }
}
if ($out.Count -gt 0) { $out | ConvertTo-Json -Compress -Depth 3 }`
    runPowerShell(psScript, 15000, ({ err, stdout }) => {
      if (err || !stdout.trim()) { resolve([]); return }
      try {
        const parsed = JSON.parse(stdout.trim())
        // 只有一个元素时 ConvertTo-Json 输出对象而非数组，这里统一成数组
        const items: { path: string; name: string; iconBase64?: string }[] =
          Array.isArray(parsed) ? parsed : [parsed]
        resolve(items.map((it) => ({
          path: it.path,
          name: it.name,
          iconDataUrl: it.iconBase64 ? 'data:image/png;base64,' + it.iconBase64 : ''
        })))
      } catch { resolve([]) }
    })
  })
}

ipcMain.handle('describe-paths', async (_e, paths: unknown) => {
  if (!Array.isArray(paths)) return { accepted: [], rejected: [] }
  const list = paths.filter((p): p is string => typeof p === 'string' && !!p)
  // 按输入下标占位，保证添加顺序与拖入顺序一致（快捷方式解析较慢也不会乱序）
  const slots: (DroppedEntry | null)[] = new Array(list.length).fill(null)
  const rejected: string[] = []
  const execIdx: number[] = []
  const lnkIdx: number[] = []

  for (let i = 0; i < list.length; i++) {
    const p = list[i]
    const ext = extname(p).toLowerCase()
    if (SHORTCUT_EXTS.has(ext)) {
      lnkIdx.push(i)
    } else if (EXEC_EXTS.has(ext) && existsSync(p)) {
      execIdx.push(i)
    } else {
      rejected.push(p)
    }
  }

  // 快捷方式：**限并发 4** 解析。每个 .lnk/.url 都要起一个 powershell.exe（实测 ~900ms
  // 含 Add-Type 编译），原来在循环里串行 await —— 一次拖 20 个就是 IPC 挂 ~18s、
  // renderer 只能干等（用户看到的是「拖进去了但半天没反应」）。
  // 顺序不受影响：结果按下标写进 slots；rejected 的先后顺序无关紧要。
  await forEachLimited(lnkIdx, 4, async (i) => {
    const p = list[i]
    try {
      const info = await parseLnkFile(p)
      // 目标为空的坏快捷方式不入 Dock（点了也启动不了）
      if (!info.targetPath) { rejected.push(p); return }
      slots[i] = {
        targetPath: info.targetPath,
        arguments: info.arguments || '',
        workingDirectory: info.workingDirectory || '',
        description: info.description || basename(p, extname(p).toLowerCase()),
        iconDataUrl: info.iconDataUrl || ''
      }
    } catch { rejected.push(p) }
  })

  if (execIdx.length > 0) {
    const metas = await describeExecutables(execIdx.map((i) => list[i]))
    // 按小写路径建索引再查：原来是每个条目 metas.find(...) 线性扫一遍（O(n²)），
    // 一次拖入上百个文件时纯属白烧 CPU
    const byPath = new Map(metas.map((m) => [m.path.toLowerCase(), m]))
    for (const i of execIdx) {
      const m = byPath.get(list[i].toLowerCase())
      if (!m) { rejected.push(list[i]); continue }
      slots[i] = {
        targetPath: list[i],
        arguments: '',
        // 工作目录取 exe 所在目录：留空会让子进程继承本应用的 cwd（仓库目录），
        // 与资源管理器双击（用 exe 所在目录）不一致，依赖相对路径找配置的程序会起不来
        workingDirectory: dirname(list[i]),
        description: m.name,
        iconDataUrl: m.iconDataUrl
      }
    }
  }

  return { accepted: slots.filter((s): s is DroppedEntry => s !== null), rejected }
})

// ─── IPC: 枚举驱动器（「此电脑」悬停卡片 + 图标用量条） ────────────────────
// GetDrives() 本身不产生 I/O；容量与卷标只对固定盘/移动盘查询——断开的网络盘上
// AvailableFreeSpace 会阻塞数秒，所以网络盘/光驱只列盘符不查容量。
type DriveRow = {
  name: string; label: string; type: string; format: string
  total: number; free: number; ready: boolean
}

/** 盘符列表的缓存与请求合并。
 *  ⚠️ 为什么必须加：`openDrivesCard` 每次悬停「此电脑」都会刷新一次，而这个调用要起一个
 *  `powershell.exe`（冷启动 0.3~0.6s）。鼠标在图标上来回划几下就是好几个进程并发，
 *  与音频枚举、桌面扫描抢同一个 CPU。3s TTL 够「拔掉 U 盘后重开卡片就能看到」，
 *  又不会反复起进程；在途请求合并成一次，不会因为两次悬停叠出两个进程。 */
const DRIVES_TTL_MS = 3000
let drivesCache: { at: number; data: DriveRow[] } | null = null
let drivesInflight: Promise<DriveRow[]> | null = null

function runListDrives(): Promise<DriveRow[]> {
  return new Promise((resolve) => {
    const psScript = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$out = @()
foreach ($d in [System.IO.DriveInfo]::GetDrives()) {
  $type = [string]$d.DriveType
  $label = ''
  $format = ''
  $total = [long]0
  $free = [long]0
  $ready = $true
  if ($type -eq 'Fixed' -or $type -eq 'Removable') {
    try {
      $ready = $d.IsReady
      if ($ready) {
        $label = [string]$d.VolumeLabel
        $format = [string]$d.DriveFormat
        $total = [long]$d.TotalSize
        $free = [long]$d.AvailableFreeSpace
      }
    } catch { $ready = $false }
  }
  $out += @{ name = $d.Name.TrimEnd('\\'); label = $label; type = $type; format = $format; total = $total; free = $free; ready = $ready }
}
if ($out.Count -gt 0) { $out | ConvertTo-Json -Compress -Depth 3 }`
    runPowerShell(psScript, 8000, ({ err, stdout }) => {
      if (err || !stdout.trim()) { resolve([]); return }
      try {
        const parsed = JSON.parse(stdout.trim())
        // 只有一个驱动器时 ConvertTo-Json 输出对象而非数组
        const items: DriveRow[] = Array.isArray(parsed) ? parsed : [parsed]
        resolve(items.map((d) => ({
          name: String(d.name || ''),
          label: String(d.label || ''),
          type: String(d.type || ''),
          format: String(d.format || ''),
          total: Number(d.total) || 0,
          free: Number(d.free) || 0,
          ready: d.ready !== false
        })))
      } catch { resolve([]) }
    })
  })
}

ipcMain.handle('list-drives', (): DriveRow[] | Promise<DriveRow[]> => {
  if (drivesCache && Date.now() - drivesCache.at < DRIVES_TTL_MS) return drivesCache.data
  if (drivesInflight) return drivesInflight
  drivesInflight = runListDrives()
    .then((data) => {
      // 空表不缓存：枚举失败时不要把「没有驱动器」记 3 秒
      if (data.length > 0) drivesCache = { at: Date.now(), data }
      return data
    })
    .finally(() => { drivesInflight = null })
  return drivesInflight
})

// 打开系统「声音」设置页：`ms-settings:sound` 是 URI 不是文件路径，不能走 open-path
// （shell.openPath 走 ShellExecute 的路径语义，对 URI 会失败）。
// 成功后才按「启动后行为」三态让位 —— 与点 Dock 图标启动一个程序保持一致。
ipcMain.handle('open-sound-settings', async () => {
  try {
    await shell.openExternal('ms-settings:sound')
  } catch (err) {
    logError('audio', '打开系统声音设置失败', err)
    return false
  }
  hideDockAfterLaunch()
  return true
})

// ─── IPC: 音频设备（枚举 / 切默认） ───────────────────────────────────────
// 一个 PowerShell 调用 ≈ 0.7~1s（进程冷启动 + Add-Type 编译 C#），所以列表在
// audio.ts 里带 3s 缓存与请求合并；切换动作本身不做缓存，但要 invalidate。
// `force = true` 用于「切换成功后刷新」与卡片上的手动刷新。
ipcMain.handle('list-audio-devices', (_e, force: unknown) => getAudioSnapshot(force === true))
ipcMain.handle('set-default-audio-device', async (_e, id: unknown, roles: unknown) => {
  if (typeof id !== 'string' || !id) return false
  const roleList = Array.isArray(roles)
    ? roles.filter((r): r is number => typeof r === 'number' && (r === 0 || r === 1 || r === 2))
    : [0, 1, 2]
  const failed = await setDefaultAudioDevice(id, roleList.length > 0 ? roleList : [0, 1, 2])
  // null = PowerShell 没跑起来（无法判断，按失败处理，让 UI 回滚并提示）；
  // [] = 全部成功；非空 = 有角色失败（例如设备刚被拔掉，ID 已失效）
  return failed !== null && failed.length === 0
})

// ─── IPC: 音量 / 静音（v1.19.5，UI 在「音频」卡片的顶部） ────────────────────
// 作用对象是**当前默认输出设备**（eMultimedia 角色），与上面切默认设备同一套 Core Audio。
// 数值范围 0-100 整数；renderer 是乐观更新（拖滑块立刻回显），失败再回滚。
ipcMain.handle('get-audio-volume', (_e, force: unknown) => getAudioVolume(force === true))
ipcMain.handle('set-audio-volume', (_e, level: unknown) => {
  const n = Number(level)
  if (!Number.isFinite(n)) return false
  return setAudioVolume(n)
})
ipcMain.handle('set-audio-mute', (_e, mute: unknown) => setAudioMute(mute === true))

// ─── IPC: 列出文件夹子项（文件夹条目悬停预览卡片） ────────────────────────
// 枚举走 fs、图标走 Electron 内置的 app.getFileIcon（进程内 shell 图标查询）——
// **全程不起 PowerShell**：实测 `powershell -NoProfile` 单是启动就 ~900ms，加上
// Add-Type 编译 ~250ms、每图标 ~12ms，一个文件夹要 1.3s 才换上真图标；
// app.getFileIcon 20 个文件共 284ms（首次）/ 36ms（之后，系统有缓存），快 5~40 倍。
// 返回分两段：首批 FOLDER_ICON_INLINE 个图标在返回前就填好（配合 renderer 的悬停预取，
// 卡片弹出时图标已就位），其余后台分批补并推 `folder-icons` 事件就地替换。
const FOLDER_LIST_LIMIT = 400
const FOLDER_LIST_TTL = 5000
// 缓存目录数上限。这是主进程里**最大的一块可变内存**：每个缓存项都带着它那批图标的
// data URL（上限见 FOLDER_ICON_LIMIT）。40 个目录 × 每目录上百个图标 ≈ 十 MB 量级常驻，
// 而用户实际只会来回看少数几个目录 → 24 足够，超出部分按「先清过期、再踢最旧」淘汰。
const FOLDER_CACHE_MAX = 24
const FOLDER_ICON_INLINE = 14 // 返回前就填好的首批（卡片首屏可见的那十几行）
const FOLDER_ICON_BATCH = 24 // 后台每批数量（每批推一次事件，卡片逐批换图标）
// 后台补图标的总上限。卡片一屏约 20 行，96 个已经够用户滚四屏以上；再多只是把内存
// 和 `folder-icons` 事件的传输量堆上去（每次推送都要把这一批 data URL 跨进程拷一遍）
const FOLDER_ICON_LIMIT = 96
// 资源管理器默认不显示的系统文件/目录：列出来只是噪音（每个文件夹都有 desktop.ini）
const FOLDER_BLOCKLIST = new Set(['desktop.ini', 'thumbs.db', '$recycle.bin', 'system volume information'])
const folderCollator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

// FolderChild / FolderListing 的真相源在 src/shared/types.ts（renderer 的 env.d.ts 同源）

const folderListCache = new Map<string, { at: number; data: FolderListing }>()
/** 正在枚举中的目录。`sender` 是**可变**的：渲染端会「悬停预取 + 卡片打开」请求两次，
 *  窗口重建后还会有新窗口来命中同一条在途 Promise，推送图标必须发给最新那个请求者
 *  （否则新窗口的卡片永远停在占位块）。 */
interface PendingFolderList {
  sender: Electron.WebContents
  job: Promise<FolderListing>
}
const folderListPending = new Map<string, PendingFolderList>()

/** 目录项批量处理的并发上限：一个 400 项的目录如果无脑 Promise.all(stat)，
 *  会同时把 400 个 fs 请求压进 libuv 线程池（默认只有 4 个线程），
 *  排队项连同它们的闭包一起堆在内存里，主进程内存曲线会明显起尖。
 *  按固定并发跑完再看下一个，总耗时几乎不变，峰值请求数却降一个量级。 */
const FS_CONCURRENCY = 16
async function forEachLimited<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      await work(items[i])
    }
  })
  await Promise.all(workers)
}

// 目录统一用标准黄色文件夹图标（shell32 index 4，与 Dock 上文件夹条目同源）。
// 不能对目录用 app.getFileIcon：实测它返回的是错图标（dist/node_modules 变成「磁盘」图标、
// .git/.dsh-* 变成白纸），只有对文件才是正确的 shell 类型图标。
// 提取一次（~0.3s 的 PowerShell）后常驻内存；启动即预热，首次悬停通常已经就绪。
let folderIcon: string | null = null
let folderIconLoading: Promise<void> | null = null
function ensureFolderIcon(): Promise<void> {
  if (folderIcon !== null) return Promise.resolve()
  if (!folderIconLoading) {
    // 尺寸跟 FOLDER_ICON_SIZE 一致（卡片行只显示 17px），payload 比 256px 小一个量级
    folderIconLoading = extractIcon('C:\\Windows\\System32\\shell32.dll', 4, FOLDER_ICON_SIZE)
      .then((url) => { folderIcon = url || '' })
      .catch(() => { folderIcon = '' })
      .then(() => {
        // ⚠️ 失败时**不要**把 '' 当成有效结果常驻：`folderIcon !== null` 会让后面每一次调用
        // 都直接返回，于是 select-folder 整个会话都发空图标（renderer 的 sharedFolderIcon 兜底
        // 只是把它掩盖住了）。这里把状态复位成 null，下次调用会重新提取一次。
        if (!folderIcon) { folderIcon = null; folderIconLoading = null }
      })
  }
  return folderIconLoading
}

/** 写入目录列表缓存。缓存里存的是**已经填过图标的对象引用**（分批补图标是就地改这些
 *  对象），所以容量控制必须同时做两件事：① 先踢掉已过 TTL 的条目（卡片的后台补图标
 *  每推一批都会刷新 at，所以「打开着的卡片」不会被误踢）；② 仍然超出上限时按插入序
 *  踢掉最旧的一条。原来的实现只做 ②，一旦长期没有新目录进来，过期条目会一直挂着
 *  ——每个 400 项目录带着上百个 base64 图标常驻内存，纯属白占。 */
function putFolderCache(dir: string, data: FolderListing): void {
  if (folderListCache.size >= FOLDER_CACHE_MAX) {
    const now = Date.now()
    for (const [key, entry] of folderListCache) {
      if (now - entry.at >= FOLDER_LIST_TTL) folderListCache.delete(key)
    }
    while (folderListCache.size >= FOLDER_CACHE_MAX) {
      const oldest = folderListCache.keys().next().value
      if (oldest === undefined) break
      folderListCache.delete(oldest)
    }
  }
  folderListCache.set(dir, { at: Date.now(), data })
}

ipcMain.handle('list-folder', async (event, dir: unknown) => {
  const empty = (path: string, error: FolderListing['error']): FolderListing =>
    ({ path, name: path ? basename(path) : '', folders: 0, files: 0, items: [], truncated: 0, error })
  if (typeof dir !== 'string' || !dir) return empty('', 'missing')

  const hit = folderListCache.get(dir)
  if (hit && Date.now() - hit.at < FOLDER_LIST_TTL) return hit.data
  // 同一目录正在枚举时复用同一个 Promise：渲染端会先「悬停预取」、300ms 后卡片打开时
  // 再请求一次，若不做去重，两次都会跑完整个枚举 + 图标提取（readdir/stat 双份、
  // 图标提取双份、folder-icons 事件也推两遍）。
  //
  // ⚠️ 复用的是**枚举本身**，但推送图标的目标（sender）必须跟着最新的请求者走：
  // 窗口被重建（切停靠位置 / dev HMR）后新窗口会命中这条在途 Promise，而它闭包里
  // 捕获的却是**旧**窗口的 sender —— 后台补图标全推给了旧 WebContents，新窗口的卡片
  // 永远停在占位块（旧的 sender.isDestroyed() 检查只在已销毁时才补救，且那一轮列表
  // 已经拿到空图标了）。所以 pending 记录是可变的，每次有请求进来就刷新 sender。
  const inflight = folderListPending.get(dir)
  if (inflight) {
    inflight.sender = event.sender
    return inflight.job
  }

  const pending: PendingFolderList = { sender: event.sender, job: null as unknown as Promise<FolderListing> }

  const job = (async (): Promise<FolderListing> => {
    let entries: Dirent[]
    try {
      const st = await fsp.stat(dir)
      if (!st.isDirectory()) return empty(dir, 'notdir')
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code
      return empty(dir, code === 'ENOENT' ? 'missing' : 'denied')
    }

    const all: { name: string; key: string; isDir: boolean }[] = []
    let folderCount = 0
    let fileCount = 0
    for (const it of entries) {
      if (FOLDER_BLOCKLIST.has(it.name.toLowerCase())) continue
      let isDir = it.isDirectory()
      // Windows 的目录联接/符号链接（pnpm 的 node_modules、用户目录里的 Application Data 等）
      // 在 Dirent 上是 isDirectory()=false + isSymbolicLink()=true，只有 stat 才知道真身。
      // 不识别的话它们会被当成文件：算进文件数、按文件排序、显示成字节大小、图标也不对
      if (!isDir && it.isSymbolicLink()) {
        try { isDir = (await fsp.stat(join(dir, it.name))).isDirectory() } catch { /* 断链当文件 */ }
      }
      if (isDir) folderCount++
      else fileCount++
      all.push({ name: it.name, key: it.name.toLowerCase(), isDir })
    }
    // 目录优先，其次按名称（中文/数字自然序，与资源管理器观感一致）。
    // 超大目录（几十万项）里 Intl.Collator 比较百万次会把主进程卡住好几秒，
    // 而卡片最多只显示 400 行——超过阈值就退回廉价的字符串比较
    const cheapSort = all.length > 4000
    all.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      if (cheapSort) return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
      return folderCollator.compare(a.name, b.name)
    })

    const shown = all.slice(0, FOLDER_LIST_LIMIT)
    const items: FolderChild[] = shown.map((s) => ({
      name: s.name,
      path: join(dir, s.name),
      isDir: s.isDir,
      size: -1,
      iconDataUrl: '' // 由下面的首批提取 / 后台分批填入
    }))

    // 文件大小：只 stat 文件（目录不递归），单个 stat 失败不影响整卡。
    // 用受限并发跑（见 FS_CONCURRENCY），别把 400 个 stat 一次性压进线程池
    await forEachLimited(items, FS_CONCURRENCY, async (it) => {
      if (it.isDir) return
      try { it.size = (await fsp.stat(it.path)).size } catch { it.size = -1 }
    })

    const data: FolderListing = {
      path: dir,
      name: basename(dir),
      folders: folderCount,
      files: fileCount,
      items,
      truncated: all.length - shown.length
    }

    // 首批图标（卡片首屏可见的前十几行）**在返回前就填好**——配合 renderer 的悬停预取
    // （鼠标刚碰到图标就开始列目录），卡片弹出时图标已经就位，看不到「先占位块再换」的过程。
    // 目录用缓存的标准黄色文件夹图标（不 await：预热没完成时先留空，由后台补批填上）
    await forEachLimited(items.slice(0, FOLDER_ICON_INLINE), 8, async (it) => {
      it.iconDataUrl = it.isDir ? (folderIcon ?? '') : await fileIconDataUrl(it.path)
    })

    putFolderCache(dir, data)

    // 其余图标后台分批补（每批推一次事件，卡片逐批换），不阻塞卡片出现。
    // 传 pending 而不是 event.sender：推送目标要跟着「最新一次请求者」走（见上方注释）
    void fillFolderIcons(items, dir, pending, data)

    return data
  })()

  pending.job = job
  folderListPending.set(dir, pending)
  try {
    return await job
  } finally {
    folderListPending.delete(dir)
  }
})

/** 单文件 shell 图标 → data URL（失败返回空串，renderer 用中性占位块）。 */
async function fileIconDataUrl(targetPath: string): Promise<string> {
  try {
    const img = await app.getFileIcon(targetPath, { size: 'normal' })
    return img.isEmpty() ? '' : img.toDataURL()
  } catch { return '' }
}

/** 后台补图标：每批完成后推一次 `folder-icons`，renderer 按路径就地替换。
 *  sender **从 pending 记录里实时取**（不是建 job 那一刻的快照）：窗口被重建后
 *  新窗口复用同一条在途 Promise，若继续用旧 WebContents，补批全推给了已经离开的窗口。
 *  目标确实拿不到时（已销毁）**把这个缓存项删掉**，否则列表里剩下没图标的项会在 TTL 内
 *  被当成「已完成的缓存」返回，卡片只能显示占位块，且没有任何补批会再来。 */
async function fillFolderIcons(
  items: FolderChild[],
  dir: string,
  pending: PendingFolderList,
  data: FolderListing
): Promise<void> {
  const targets = items.filter((it) => !it.iconDataUrl).slice(0, FOLDER_ICON_LIMIT)
  if (targets.length === 0) return
  // 目录要用到那枚缓存的文件夹图标，先把预热等完（通常早就好了）
  if (targets.some((it) => it.isDir)) await ensureFolderIcon()
  const dropCacheIfOurs = (): void => {
    // 只删自己那一次枚举写进去的缓存（可能已被更新的枚举替换）
    if (folderListCache.get(dir)?.data === data) folderListCache.delete(dir)
  }
  for (let i = 0; i < targets.length; i += FOLDER_ICON_BATCH) {
    const batch = targets.slice(i, i + FOLDER_ICON_BATCH)
    // 每批同样走受限并发：一批 24 个 getFileIcon 并发是安全的，但配上 stat 的
    // 线程池占用时仍要留出余量，避免与用户其他操作抢 I/O
    await forEachLimited(batch, 8, async (it) => {
      it.iconDataUrl = it.isDir ? (folderIcon ?? '') : await fileIconDataUrl(it.path)
    })
    // 每批都取一次当前 sender（期间可能有新窗口接管）
    const sender = pending.sender
    // sender 失效（窗口被重建/页面重载）就先删缓存再返回：缓存里的对象**已经被就地
    // 改了图标**，留着它会让下一次 list-folder 命中「半截图标」的旧数据而不再补批。
    // 原实现是「先 send 再检查」，对已销毁的 WebContents 调 send 本身就会抛错。
    if (!sender || sender.isDestroyed()) { dropCacheIfOurs(); return }
    const icons: Record<string, string> = {}
    for (const it of batch) if (it.iconDataUrl) icons[it.path] = it.iconDataUrl
    if (Object.keys(icons).length === 0) continue
    try {
      sender.send('folder-icons', { path: dir, icons })
    } catch {
      // send 仍然可能抛（sender 在 isDestroyed 检查之后才销毁）：这个函数是 void 掉的，
      // 不捕获就会变成主进程的未处理 rejection
      dropCacheIfOurs()
      return
    }
    // 卡片还开着就继续刷新保鲜期（每批一次），这样第二次悬停仍能命中缓存
    const entry = folderListCache.get(dir)
    if (entry?.data === data) entry.at = Date.now()
  }
}

// 打开任意路径（文件夹预览卡片点条目/「打开」按钮用）：shell.openPath 走 ShellExecuteEx，
// 即资源管理器双击的语义——目录开资源管理器，文档/图片/快捷方式交给关联程序。
// 不能复用 run-app：那条路径用 execFile 直接 CreateProcess，对 .md/.txt/.png 这类非可执行
// 文件必然失败（ERR ENOEXEC，且原代码只在 EACCES/EPERM 时回退 shell），所以点了没反应。
ipcMain.handle('open-path', async (_e, targetPath: unknown) => {
  if (typeof targetPath !== 'string' || !targetPath) return false
  // 先确认真的打开了再隐藏 Dock：目标已被删除/没有关联程序时，shell.openPath 会返回错误串，
  // 此时若已经把 Dock 藏起来，用户就是「点了没反应、Dock 还消失了」，只能靠 Alt+Space 找回
  const err = await shell.openPath(targetPath)
  if (err) {
    logError('launcher', 'shell.openPath 失败', err)
    return false
  }
  // 与点 Dock 图标一致：打开成功后 Dock 让出桌面
  if (mainWindow && !mainWindow.isDestroyed()) {
    dockTrayHidden = true
    sinkSeq++ // 隐藏即作废在途沉底
    mainWindow.hide()
  }
  return true
})

// 启动预热：① 标准黄色文件夹图标（目录行用，提取一次常驻）② 一次 getFileIcon 让 shell
// 图像列表初始化（首次调用有 ~110ms 冷启动），用户第一次悬停文件夹时就不会撞上这个尖峰
void app.whenReady().then(() => {
  // 抢不到单实例锁的进程正在退出流程里，别白起一个 powershell.exe（whenReady 与 quit 是竞速的）
  if (!gotSingleInstanceLock) return
  void ensureFolderIcon()
  void fileIconDataUrl(process.execPath)
})

// 以管理员身份运行（Start-Process -Verb RunAs → UAC 提权，与资源管理器「以管理员身份运行」一致）
ipcMain.handle('run-as-admin', (_e, targetPath: string, args: string, workingDir: string) => {
  if (!targetPath) return false
  // 与 run-app 一致：按「启动后行为」三态让位（UAC 取消/失败时按同一 state 回滚）
  const hideState = hideDockAfterLaunch()
  // ⚠️ `Start-Process` 的 -ArgumentList / -WorkingDirectory 都是 [ValidateNotNullOrEmpty]：
  // 传空串会**先**在校验阶段抛错（实测 PS 5.1：Cannot validate argument on parameter
  // 'ArgumentList'. The argument is null or empty），根本走不到创建进程那一步。
  // 而「没有启动参数」正是绝大多数条目的常态 —— 原来的写法让这个菜单项对它们 100% 失败，
  // 且因为 Dock 已经先隐藏、err 又只打日志、IPC 还返回 true，用户看到的是
  // 「Dock 消失、没有 UAC、什么都没发生」。
  // 修法：用参数哈希表拼装，空值一律**不传**该参数（PowerShell 侧判断，避免 JS 侧再拼一次命令）。
  const psScript = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$p = @{ FilePath = '${targetPath.replace(/'/g, "''")}'; Verb = 'RunAs' }
$argStr = '${(args || '').replace(/'/g, "''")}'
$wdStr = '${(workingDir || '').replace(/'/g, "''")}'
if ($argStr) { $p['ArgumentList'] = $argStr }
if ($wdStr) { $p['WorkingDirectory'] = $wdStr }
Start-Process @p`
  // ⚠️ 必须把**真实结果**返回给 renderer：原来无论成败都 `return true`，于是
  //    「UAC 被取消」时用户只看到「Dock 藏起来又回来、什么都没发生」，没有任何说明
  //    （run-app 早就做到返回真值了，这里漏了一处）。
  return new Promise<boolean>((resolve) => {
    runPowerShell(psScript, 10000, ({ err, stderr }) => {
      if (!err) { resolve(true); return }
      // UAC 被用户取消（The operation was canceled by the user）也走这里：
      // 此时同样要把 Dock 还给用户，否则「点了没反应 + Dock 消失」没有任何出路
      logError('launcher', `以管理员运行失败: ${err.message} | stderr=${String(stderr ?? '').slice(0, 300)}`)
      restoreDockAfterFailedLaunch(hideState)
      resolve(false)
    })
  })
})

// 在资源管理器中定位目标（文件夹在父目录中选中该文件夹；文件直接选中）
ipcMain.handle('open-file-location', (_e, targetPath: unknown) => {
  if (typeof targetPath !== 'string' || !targetPath) return
  if (targetPath.startsWith('shell:') || targetPath.startsWith('::')) return
  // URL 没有「文件位置」可定位（菜单里也不显示这一项）
  if (/^(https?|ftp|steam):\/\/|^mailto:/i.test(targetPath)) return
  // Shell API 不拼命令行：路径里的 & | ^ % 等字符不再有注入面，也不用再维护黑名单。
  // 目标不存在时 showItemInFolder 会静默失败，这里先挡掉，避免打开一个空的资源管理器。
  try {
    if (!existsSync(targetPath)) return
    shell.showItemInFolder(targetPath)
  } catch (err) {
    logError('launcher', '在资源管理器中定位失败', err)
  }
})

// 复制文本到剪贴板（复制路径）
ipcMain.handle('copy-text', (_e, text: unknown) => {
  if (typeof text === 'string' && text) clipboard.writeText(text)
})

// ─── Window & tray ──────────────────────────────────────────────────────────

function resolveResource(filename: string): string {
  const devPath = join(__dirname, '../../resources', filename)
  return existsSync(devPath) ? devPath : join(app.getAppPath(), '..', filename)
}

// 鼠标进入 Dock 窗口：恢复置顶（沉底后鼠标移回 Dock 即拉回）。
// 鼠标移出 / 在其他软件上滚动不再沉底——用户可自由移动鼠标，
// 只有点击其他软件（blur）才让出置顶。
// 鼠标进入 Dock 窗口：恢复置顶并抢回焦点。必须 focus——否则 Dock 保持「置顶但无焦点」，
// 之后点击其他软件不会触发 blur，Dock 无法沉底（违背「只有点击其他软件才让位」的设计）。
ipcMain.on('dock-pointer', (_e, inside: boolean) => {
  // 两个方向都要记：false 是「鼠标离开」，沉底 watchdog 靠它判断「用户已经去别处了」
  dockPointerInside = inside === true
  if (!inside) return
  if (!mainWindow || mainWindow.isDestroyed()) return
  dockTrayHidden = false
  sinkSeq++ // 作废在途沉底：鼠标已经回到 Dock 上，不该再被压到底部
  dockAutoSunk = false
  recoverDock(mainWindow)
  // ⚠️ 这里**不要**再调 `mainWindow.focus()`（v1.19.1 删掉，改这块先读）。
  // 旧注释说「不 focus 就永远收不到 blur」，实测恰恰相反：悬停时 `focus()` 会被前台锁
  // 拒绝激活、却仍然把键盘焦点拿到本线程（`GetFocus()==hwnd`），于是
  // `win.isFocused()` / `document.hasFocus()` **永久卡在 true**，而 Windows 之后再也不会
  // 发 WM_KILLFOCUS → blur 永不触发 → 点别的软件不让位（用户 2026-11-28 报障）。
  // 真实点击图标时系统会自己给焦点，那时 blur 是正常的；纯悬停本来也不该抢焦点。
})

// 用户在这扇窗里动手了（mousemove / keydown / wheel / pointerdown，renderer 侧已节流）。
// ⚠️ 这条通道是「Dock 正在被使用」的唯一可靠证据 —— 见 sinkWatchdogTick 的注释。
ipcMain.on('dock-activity', () => {
  lastDockActivityAt = Date.now()
})

// ─── 透明窗口命中区（方案 B：setShape 静态矩形）─────────────────────────────
// 背景（实测过，别再用别的思路覆盖）：Windows 上透明窗口拿的是
// WS_EX_NOREDIRECTIONBITMAP（不是 WS_EX_LAYERED），系统因此**不做 per-pixel 命中测试** ——
// `transparent: true` 只让窗口画得透明，整个矩形（1200×302）照样吃鼠标。
// 于是玻璃条上方 134px 的纯透明区、玻璃条左右两侧的留白全都挡住下面的桌面/资源管理器。
// 探针实测（devtools/probe/hittest-*）：
//   * setIgnoreMouseEvents(true) 是**整窗开关**，无法按区域；且 { forward: true } 在
//     Electron 43 + Windows 上**不向 renderer 转发 mousemove** → 靠 DOM hover 判断光标
//     回来的路走不通；改成主进程轮询则实测**丢首击**（瞬移后立即点击失败，15ms 后才成功）。
//   * setShape([rect]) 精确生效：region 外穿透到桌面、region 内正常命中，零轮询、零首击丢失。
// ⚠️ region 是**绘制与命中共用**的裁剪：region 外的内容不会被画出来。所以浮层（全部
//    position: fixed 向上弹出、画在玻璃条上方的透明区里）必须有 overlay 放开这一档，
//    否则菜单/卡片/面板会整块消失。

/** 总开关：置 false 即回到「整窗吃鼠标」的老行为（完全不调 setShape）。
 *  万一 setShape 在某台机器上有兼容问题，改这一行 + 重新构建即可回退，不必回滚其它改动。 */
const DOCK_HIT_SHAPE = true

/** region 相对 `.dock-bar` 实测矩形的外扩量。玻璃条的 box-shadow 与 24px 圆角
 *  会画到元素盒子外，不外扩就会被 region 硬切出直边。8px 与 `.dock` 的 padding 一致，
 *  加上后也不会越过窗口边界（下面有 clamp）。 */
const DOCK_HIT_PAD = 8

/** 玻璃条**靠内容那侧的透明区**要内缩多少（单位 DIP）。
 *  `.dock-bar` 高 158，其中 82px 是「放大 + 悬浮标签」的透明 padding —— 这 82px 里
 *  真正有内容的只有靠上的一段，剩下的空白不该继续挡下面的窗口。
 *  实测（middle 档 `barTop=137.2`，窗口高 303）：悬浮标签 rect 顶边 `161.8`（= barTop+24.6）、
 *  放大 1.4× 后的图标顶边 `192`（= barTop+54.8）。取 20 给标签留 4.6px 余量，两点都裁不到。
 *  ⚠️ 不要调到 ≥24：`SetWindowRgn` 连绘制一起裁，会把悬浮标签的顶边切掉一截。 */
const DOCK_HIT_INSET = 20

/** 当前生效的内缩量。默认等于 DOCK_HIT_INSET（60px 图标档），renderer 上报时会带上
 *  随图标尺寸缩放后的值（E1：48px 档 → 16，72px 档 → 24），这里只做 clamp。
 *  以 renderer 为准是必要的：内缩量取决于**玻璃条里内容的实际位置**，而那由 CSS 变量
 *  `--dock-icon` / `--dock-pad` 决定，主进程看不见。 */
let dockHitInset = DOCK_HIT_INSET

/** 排查用：置 true 后每次真正生效的 region 都打一行日志（默认关，别在发布版打开）。 */
const DOCK_HIT_DEBUG = false

/** renderer 上报的 `.dock-bar` 矩形（窗口坐标 / DIP，与 CSS px 1:1，无需按 DPI 换算）。 */
let dockBarRect: { x: number; y: number; width: number; height: number } | null = null
/** 是否有浮层开着（「+」菜单 / 右键菜单 / 盘符卡片 / 文件夹卡片 / 分组面板）。 */
let dockOverlayOpen = false
/** 上一次真正生效的 region（"x,y,w,h"）。上报是高频通道、React 也会重复报同值，
 *  相同的 region 不再调 setShape——避免无意义的 SetWindowRgn 引起重绘闪烁。 */
let dockShapeApplied = ''

/** setShape 抛错只记一次日志（避免每次上报都刷屏）。 */
let dockShapeErrorLogged = false

/** 按当前状态重设窗口命中区。窗口重建、浮层开合、图标增删（玻璃条宽度变化）后都要调。 */
function applyDockHitRegion(win: BrowserWindow | null = mainWindow): void {
  if (!DOCK_HIT_SHAPE) return
  if (!win || win.isDestroyed()) return
  const { width: cw, height: ch } = win.getContentBounds()
  if (cw <= 0 || ch <= 0) return
  const apply = (x: number, y: number, width: number, height: number): void => {
    // 空 region = 窗口彻底不可见且不可点：宁可保持原样也不要传进去
    if (width <= 0 || height <= 0) return
    const key = `${x},${y},${width},${height}`
    if (key === dockShapeApplied) return
    dockShapeApplied = key
    try {
      win.setShape([{ x, y, width, height }])
      if (DOCK_HIT_DEBUG) console.log('[dock-hit-region] applied', key)
    } catch (err) {
      // setShape 是实验性 API（`@experimental`，仅 win32/linux）。它一旦抛错，
      // 后续每次上报都会重试并重复刷屏，所以这里把 key 回滚、让下一次上报还能再试，
      // 同时只记一次错误。**绝不能让它把主进程打崩**：region 只是个优化，
      // 失败的正确降级就是「整窗吃鼠标」（= 这个特性上线前的行为）。
      dockShapeApplied = ''
      if (!dockShapeErrorLogged) {
        dockShapeErrorLogged = true
        logError('hit-region', 'setShape 失败，降级为整窗命中（功能不受影响）', err)
      }
    }
  }
  // 浮层期间 / 还没拿到第一次上报：放开整窗。
  // 「还没上报」也放开是刻意的——宁可启动后那几十毫秒不穿透，也不能让首帧的玻璃条
  // 因为 region 算错而整块不可见（用户会以为 Dock 挂了）。
  if (dockOverlayOpen || !dockBarRect) {
    apply(0, 0, cw, ch)
    return
  }
  const x = Math.max(0, Math.floor(dockBarRect.x - DOCK_HIT_PAD))
  const right = Math.min(cw, Math.ceil(dockBarRect.x + dockBarRect.width + DOCK_HIT_PAD))
  const barTop = dockBarRect.y
  const barBottom = dockBarRect.y + dockBarRect.height
  // 放大区与悬浮标签永远在玻璃条**背离窗口贴边侧**的那一边：bottom/middle 档在 bar 上方，
  // top 档整套几何垂直镜像、在 bar 下方。所以只内缩那一侧，贴边侧照旧外扩 8px。
  const growUp = dockEdge !== 'top'
  const y = growUp
    ? Math.max(0, Math.floor(barTop + dockHitInset))
    : Math.max(0, Math.floor(barTop - DOCK_HIT_PAD))
  const bottom = growUp
    ? Math.min(ch, Math.ceil(barBottom + DOCK_HIT_PAD))
    : Math.min(ch, Math.ceil(barBottom - dockHitInset))
  apply(x, y, right - x, bottom - y)
}

// renderer 上报玻璃条几何 + 浮层状态（高频通道，用 send 不用 invoke：
// ResizeObserver 在拖入/滚动时会连着来几发，不该让 renderer 等 Promise）
ipcMain.on('dock-hit-region', (_e, payload: unknown) => {
  if (!payload || typeof payload !== 'object') return
  const p = payload as Record<string, unknown>
  const overlay = p.overlay === true
  const x = Number(p.x)
  const y = Number(p.y)
  const width = Number(p.width)
  const height = Number(p.height)
  const shaped = [x, y, width, height].every((n) => Number.isFinite(n)) && width > 0 && height > 0
  if (shaped) dockBarRect = { x, y, width, height }
  // E1：内缩量随图标尺寸缩放。clamp 到 0..40 —— 上报值来自 renderer 的算术，别让它
  // 用一个荒谬的值把 region 算成空（空 region 会被 apply() 直接丢掉，表现为「整窗吃鼠标」）。
  const inset = Number(p.inset)
  if (Number.isFinite(inset)) dockHitInset = Math.max(0, Math.min(40, Math.round(inset)))
  // 形状不可用（元素还没布局 / 窗口刚重建）时只更新 overlay —— 保留上一次可用矩形，
  // 不要用 NaN/0 覆盖成「整窗放开」，否则一次瞬时上报就会让穿透失效好一会儿
  dockOverlayOpen = overlay
  applyDockHitRegion()
})

// ─── 「已在运行的目标 = 激活它的窗口」而不是再开一个（v1.13.5）────────────────
// 背景：点 Dock 图标是 execFile → CreateProcess，对**单实例/托盘型**应用（微信、
// QQ、各类 IM）不会去激活已有实例，而是**又开一个进程**。实测（本机微信 4.1）：
//   execFile        → 新增 1 个进程
//   Start-Process   → 新增 1 个进程
// 也就是说这**不是**启动方式的问题（换 ShellExecuteEx 也一样），
// 必须由我们主动把已有窗口提到前台。
//
// ⚠️ 实测过两次「第一次调用返回 NONE」：应用刚启动时进程/窗口枚举还没就绪，
//    此时若直接掉到「启动新进程」就会**多开一个登录窗口**（用户报的正是这个）。
//    对策：FindWindow 阶段做**短轮询重试**（见 findTargetWindow），不要一次失败就放弃。
//
// ⚠️⚠️ 下面这段 C# **必须是纯 ASCII，一个中文注释都不能有**（踩过一次，很隐蔽）：
//   powershell.exe -Command <脚本文本> 是按**系统 ANSI 代码页**解码命令行的（中文 Windows
//   是 GBK/936），而我们的脚本是 UTF-8。C# 里出现中文注释时，GBK 解码会把多字节序列解错，
//   把注释的结尾 `*/` 吃掉 → **整段源码语法错误** → Add-Type 编译失败 →
//   FindPid 永远返回 0，"激活"功能静默失效（表面看只是"没生效"，不报错）。
//   本项目其它 C# 常量（ICON_EXTRACTOR_CS / DESKTOP_ICONS_CS / WinZ）实测都是 0 个非 ASCII
//   字符 —— 那不是巧合，是这条约定在撑着。改这里请保持纯 ASCII，说明写在 TS 这一侧。
/** 判断目标程序当前处于哪种状态，决定「激活 / 提示 / 启动」。
 *
 *  ⚠️ **方向是「宁可多开一次，也不要让用户点不开」**（v1.13.8 修正，此前是反的）。
 *  这条特性存在的理由：`execFile` / `Start-Process` 对单实例应用（微信、QQ 等）
 *  **都会新开一个进程**，所以「已经在运行就别再启动」必须由我们主动判断。
 *  但判断**不出来的那部分不能拿来拦住用户** —— 被拦住的代价是「点了永远没反应」。
 *
 *  四态与各自的处置（处置在 run-app 里）：
 *    running  有可见/最小化窗口     → 置前，不启动
 *    tray     进程在、窗口隐藏      → 点托盘图标唤出；点不动才提示用户自己点，不启动
 *    absent   确认没这个进程        → 启动
 *    failed   进程在、但没有带标题的窗口（3 次都没探到）→ **照旧启动**（fail-open）
 *
 *  ⚠️ `failed` 为什么必须放行：Clash Verge 这类 **Tauri 托盘型应用**空闲时
 *  **根本不存在主窗口**，只有托盘窗口（`tao_system_tray_app`，隐藏）和一个
 *  无标题的 `Tao Thread Event Target`。实测本机（应用收在托盘）：
 *    pid=99776  cls=tao_system_tray_app     title=[] visible=False
 *    pid=99776  cls=Tao Thread Event Target title=[] visible=True
 *    pid=99776  cls=MSCTFIME UI / IME
 *  任何探询都只能给出 0。如果因此拦住不启动，用户就**永远点不开它**（报障原话：
 *  「点了只弹『没能确认是否已在运行』」）。既然连窗口都没有，启动它是唯一能拿到窗口的办法。
 *
 *  为什么要重试：实测应用刚启动时**第一次调用会返回 0**（进程/窗口枚举尚未就绪），
 *  重试能把这种「正在启动」与「真的没有窗口」区分开一部分。 */
async function probeTargetState(targetPath: string): Promise<'running' | 'tray' | 'absent' | 'failed'> {
  // ① 助手**已预热**（应用启动 5s 后就是）→ 直接问它：连「没在运行」也只要 ~20ms，
  //    比 `tasklist` 的 ~70ms 还快，所以这一档不再查进程。
  // ② 助手还没起来（刚启动的头几秒 / 被策略拦 / 没有 PowerShell）→ 先用 `tasklist` 快路
  //    排除「没在运行」这一最常见的情况，免得为它付一次 PowerShell 冷启动（604ms 起）。
  if (!activateHelperReady) {
    const pids = await imagePids(targetPath)
    if (pids && pids.length === 0) return 'absent'
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await activateRunningInstance(targetPath, 3000)
    if (r !== 'retry') return r
    if (attempt < 2) {
      // 小睡 260ms 再试：应用刚启动时第一次枚举常常还没就绪，立刻判「没在运行」就会多开。
      // ⚠️ 必须是 **await**：同步忙等会阻塞主进程事件循环（Dock 假死）。
      await new Promise((resolve) => setTimeout(resolve, 260))
    }
  }
  return 'failed'
}

/** 查「这个 exe 现在有哪些 pid」——`tasklist` 一次约 70ms（**异步**，不阻塞主进程）。
 *
 *  这是点图标主路径上的第一跳：返回空数组就说明没在运行，可以立刻去 spawn，
 *  不必为一次 PowerShell 冷启动（实测 **604ms**，加上 `Add-Type` 是 **869ms**）付钱。
 *
 *  返回 `null` = 查询本身失败（tasklist 缺失 / 超时）→ 上层按「可能在运行」处理，
 *  宁可多走一次慢路，也不要因为查询失败就多开一个实例。 */
async function imagePids(targetPath: string): Promise<number[] | null> {
  if (!/\.(exe|com)$/i.test(targetPath)) return [] // 不是本地 exe，没有进程可匹配
  const image = targetPath.split(/[\\/]/).pop() ?? ''
  if (!image) return null
  return new Promise<number[] | null>((resolve) => {
    execFile(
      'tasklist',
      ['/FI', `IMAGENAME eq ${image}`, '/NH', '/FO', 'CSV'],
      { windowsHide: true, timeout: 3000 },
      (err, stdout) => {
        if (err) {
          resolve(null) // 查不了 → 上层走慢路
          return
        }
        // 命中行形如 `"Weixin.exe","35884","Console","1","300,000 K"`；
        // 没命中是本地化提示行（中文系统上「信息: 没有运行的任务…」），不含文件名。
        const pids: number[] = []
        for (const line of String(stdout).split(/\r?\n/)) {
          if (!line.toLowerCase().includes(image.toLowerCase())) continue
          const m = /"(\d+)"/g
          let hit: RegExpExecArray | null
          while ((hit = m.exec(line)) !== null) {
            const n = Number(hit[1])
            if (Number.isFinite(n) && n > 0) pids.push(n)
          }
        }
        resolve(Array.from(new Set(pids)))
      }
    )
  })
}

// ─── 常驻激活助手（v1.19.3：把「已在运行 → 激活」从 ~0.9s 压到 ~20ms）──────────
// 问题：每次点图标都起一个 powershell.exe 做探询 —— 冷启动 604ms、加 Add-Type 编译 869ms，
// 用户感受就是「点了要等一下才出来」。而 cscript/WSH 的 AppActivate 虽然只要 44ms，
// 但它内部就是 SetForegroundWindow：窗口不是前台时直接被前台锁拒（实测微信退化成 3s），
// 而且它不认最小化窗口、不认托盘。
//
// 解法：**开一个常驻的 PowerShell**，用 `-Command` 把 ACTIVATE_CS 编译一次，然后循环读 stdin：
//   `RUN <base64(目标路径)>` → `STATE=<码>`
// 之后每次点图标只剩一次管道往返（实测请求-响应 ~10-30ms），而判定逻辑仍是那套
// 「按可见度挑窗口 / SW_RESTORE / 前台锁兜底抬升」的原生代码，语义一点没退。
//
// 生命周期：应用启动后 5s 预热（不占启动时间）；10 分钟没人用就退出（省内存）；
// 退出/崩溃时下一次请求会重新拉起；应用退出时 kill 掉。
const ACTIVATE_IDLE_MS = 10 * 60 * 1000

/** 助手脚本：先编译 C#、打一行 READY，再逐行处理请求。路径走 base64，避免 stdin 编码踩坑。 */
function activateHelperScript(): string {
  return `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${ACTIVATE_CS}
'@
Write-Output 'READY'
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq 'EXIT') { break }
  if ($line.StartsWith('SINK ')) {
    try { $r = [QLActivate]::Sink($line.Substring(5)) } catch { $r = 0 }
    Write-Output "SINKED=$r"
    [Console]::Out.Flush()
    continue
  }
  if (-not $line.StartsWith('RUN ')) { continue }
  try {
    $path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Substring(4)))
    $r = [QLActivate]::Probe($path)
  } catch {
    $r = 0
  }
  Write-Output "STATE=$r"
  [Console]::Out.Flush()
}
`
}

let activateHelper: ChildProcess | null = null
let activateHelperReady = false
let activateHelperStarting: Promise<boolean> | null = null
let activateHelperIdleTimer: NodeJS.Timeout | null = null
/** 请求串行化：stdout 是一条流，两个请求并发会读串行（互抢 STATE 行）。 */
let activateQueue: Promise<unknown> = Promise.resolve()

function stopActivateHelper(): void {
  if (activateHelperIdleTimer) {
    clearTimeout(activateHelperIdleTimer)
    activateHelperIdleTimer = null
  }
  const child = activateHelper
  activateHelper = null
  activateHelperReady = false
  activateHelperStarting = null
  if (child) {
    try {
      child.stdin?.write('EXIT\n')
      child.kill()
    } catch {
      /* 已经退了 */
    }
  }
}

function touchActivateHelperIdle(): void {
  if (activateHelperIdleTimer) clearTimeout(activateHelperIdleTimer)
  activateHelperIdleTimer = setTimeout(() => stopActivateHelper(), ACTIVATE_IDLE_MS)
  activateHelperIdleTimer.unref?.()
}

/** 起助手并等它把 C# 编译完（首行 READY）。失败返回 false，调用方退回一次性 PowerShell。 */
function ensureActivateHelper(): Promise<boolean> {
  if (activateHelperReady && activateHelper) return Promise.resolve(true)
  if (activateHelperStarting) return activateHelperStarting
  activateHelperStarting = new Promise<boolean>((resolve) => {
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    let child: ChildProcess
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore']
      })
    } catch (err) {
      logWarn('launcher', '激活助手启动失败', err instanceof Error ? err.message : String(err))
      done(false)
      // ⚠️ 不能在 executor 里直接写 `activateHelperStarting = null`：
      //    外层那句 `activateHelperStarting = new Promise(...)` 要等 executor **返回之后**
      //    才执行，同步置空会被它覆盖掉 → 留下一个永久失效的 Promise。
      //    排到微任务里（本轮同步执行之后）才安全。
      queueMicrotask(() => { if (!activateHelperReady) activateHelperStarting = null })
      return
    }
    activateHelper = child
    let buf = ''
    const onData = (d: Buffer): void => {
      // ⚠️ 拿到 READY 之后这条监听器就该摘掉：旧写法在 ready 之后仍然无条件
      //    `buf += …`，助手活多久这份字符串就长多久（每次请求的响应 10~20B 永久堆积，
      //    而且 `buf.includes()` 是 O(n)）。它只是「等 READY」用的，不参与请求应答。
      if (activateHelperReady) return
      buf += String(d)
      if (!buf.includes('READY')) return
      activateHelperReady = true
      child.stdout?.off('data', onData)
      buf = ''
      touchActivateHelperIdle()
      done(true)
    }
    child.stdout?.on('data', onData)
    child.on('error', () => {
      if (activateHelper === child) stopActivateHelper()
      done(false)
    })
    child.on('exit', () => {
      if (activateHelper === child) {
        activateHelper = null
        activateHelperReady = false
        // ⚠️ 必须连「正在启动」的那个 Promise 一起复位。它是**已 resolve(true) 的旧值**，
        //    留着会让 ensureActivateHelper() 的 `if (activateHelperStarting) return ...`
        //    永远返回它 → 助手死后再也拉不起来：之后每次点图标都退回 ~0.9s 的一次性
        //    PowerShell（探询恒 retry，连「已在运行就不多开」都失效，微信会被开出第二个
        //    登录窗），「隐藏/显示任务栏」也会全部静默失败。
        activateHelperStarting = null
      }
      done(false) // 还没 READY 就退 → 这次算失败，下次重试
    })
    child.stdin?.write(activateHelperScript())
    child.stdin?.write('\n')
    // 编译 + 冷启动一般 <1.2s；4s 还没 READY 就认为这条路不可用。
    // ⚠️ 超时未就绪时必须**把子进程收掉**并复位 starting：否则那个没编译完的
    //    powershell.exe 会作为孤儿常驻内存，而 starting 停在已 resolve 的 false 上，
    //    助手路径从此永久失效。
    setTimeout(() => {
      const ok = activateHelperReady
      if (!ok) stopActivateHelper() // 内部会复位 starting / ready / handle
      done(ok)
    }, 4000)
  })
  return activateHelperStarting
}

/** 让助手对目标做一次「探询 / 激活」，返回与 `probeTargetState` 相同的四态。 */
function helperProbeOnce(targetPath: string): Promise<'running' | 'tray' | 'absent' | 'retry'> {
  const run = async (): Promise<'running' | 'tray' | 'absent' | 'retry'> => {
    const ok = await ensureActivateHelper()
    const child = activateHelper
    if (!ok || !child || !child.stdin || !child.stdout) return 'retry'

    return new Promise<'running' | 'tray' | 'absent' | 'retry'>((resolve) => {
      const b64 = Buffer.from(targetPath, 'utf8').toString('base64')
      let acc = ''
      let finished = false
      const finish = (v: 'running' | 'tray' | 'absent' | 'retry'): void => {
        if (finished) return
        finished = true
        child.stdout?.off('data', onData)
        clearTimeout(timer)
        resolve(v)
      }
      const onData = (d: Buffer): void => {
        acc += String(d)
        const m = /STATE=(-?\d+)/.exec(acc)
        if (!m) return
        acc = ''
        switch (Number(m[1])) {
          case 1: finish('running'); return
          case -1: finish('tray'); return
          case 2: finish('absent'); return
          case 0: finish('retry'); return
          default: finish('retry')
        }
      }
      const timer = setTimeout(() => finish('retry'), 3000)
      const out = child.stdout
      const stdin = child.stdin
      if (!out || !stdin) {
        finish('retry')
        return
      }
      touchActivateHelperIdle() // 每次真正用到都续命，别在「正用着」的时候被空闲计时收走
      out.on('data', onData)
      try {
        stdin.write(`RUN ${b64}\n`)
      } catch {
        finish('retry')
      }
    })
  }
  const queued = activateQueue.then(run, run)
  activateQueue = queued.catch(() => undefined)
  return queued
}

/** 让常驻助手把**我们自己的 Dock 窗口**压到 z-order 最底（实测 ~20ms，见 ps.ts 的 `QLActivate.Sink`）。
 *
 *  为什么必须走助手：`sendToBottom` 原来每次起一个 powershell，落地要 ~700ms。点开应用后
 *  新窗口早就弹出来了、Dock 还挂在上面的观感就是「闪一下、过一会儿才退到后台」。
 *  助手已预热时这里只剩一次管道往返，Dock 基本在应用窗口出现前就退开了。
 *  助手不可用 → 返回 false，调用方退回一次性 PowerShell。 */

function helperSink(hwnd: string): Promise<boolean> {
  const run = async (): Promise<boolean> => {
    const ok = await ensureActivateHelper()
    const child = activateHelper
    if (!ok || !child || !child.stdin || !child.stdout) return false
    return new Promise<boolean>((resolve) => {
      const out = child.stdout
      const stdin = child.stdin
      if (!out || !stdin) {
        resolve(false)
        return
      }
      let acc = ''
      let finished = false
      const finish = (v: boolean): void => {
        if (finished) return
        finished = true
        out.off('data', onData)
        clearTimeout(timer)
        resolve(v)
      }
      const onData = (d: Buffer): void => {
        acc += String(d)
        const m = /SINKED=(\d)/.exec(acc)
        if (m) finish(m[1] === '1')
      }
      const timer = setTimeout(() => finish(false), 2000)
      touchActivateHelperIdle()
      out.on('data', onData)
      try {
        stdin.write(`SINK ${hwnd}\n`)
      } catch {
        finish(false)
      }
    })
  }
  const queued = activateQueue.then(run, run)
  activateQueue = queued.catch(() => undefined)
  return queued
}

/** 解析探询脚本的 `STATE=<code>` 标记（**只认标记**，不要对整段 stdout 做等值判断 ——
 *  见 DESKTOP_ICONS_READ_PS 那段注释：漏出来的方法返回值曾把整条特性搞失效）。
 *  取最后一行标记；找不到返回 NaN（= 探询失败，按「retry」处理，绝不启动新进程）。 */
function parseProbeState(stdout: string): number {
  const lines = String(stdout ?? '').split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*STATE=(-?\d+)\s*$/.exec(lines[i])
    if (m) return Number(m[1])
  }
  return NaN
}

/** 单次探测/激活：**优先走常驻助手**（预热后每次 ~20ms），助手起不来才退回一次性 PowerShell。
 *
 *  ⚠️ 别再改回「每次 spawn 一个 powershell 做探询」：冷启动 604ms + `Add-Type` 编译 869ms，
 *  点图标就会一直有 ~1s 的延迟（用户 2026-11-28 报障：「点击要有延迟，能不能秒启动」）。
 *  助手在一开始就把 C# 编译好，之后只做 stdin/stdout 往返。 */
async function activateRunningInstance(
  targetPath: string,
  timeoutMs: number
): Promise<'running' | 'tray' | 'absent' | 'retry'> {
  // 非本地可执行文件（shell: / URL / 无扩展名）没有进程可匹配，直接走启动流程
  if (!/\.(exe|com)$/i.test(targetPath)) return 'absent'
  if (!existsSync(targetPath)) return 'absent'

  const viaHelper = await helperProbeOnce(targetPath)
  if (viaHelper !== 'retry') {
    const label = viaHelper === 'running' ? '已激活运行中的实例' : viaHelper === 'tray' ? '目标在运行但窗口收在托盘里' : '确认为未运行'
    logInfo('launcher', `${label}（助手）: ${targetPath}`)
    return viaHelper
  }
  return oneShotProbe(targetPath, timeoutMs)
}

/** 兜底：一次性 PowerShell 探询（~0.9s）。只在常驻助手起不来时才会走到。 */
function oneShotProbe(
  targetPath: string,
  timeoutMs: number
): Promise<'running' | 'tray' | 'absent' | 'retry'> {
  if (!/\.(exe|com)$/i.test(targetPath)) return Promise.resolve('absent')
  if (!existsSync(targetPath)) return Promise.resolve('absent')

  const escaped = targetPath.replace(/'/g, "''")
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
${ACTIVATE_CS}
'@
$r = [QLActivate]::Probe('${escaped}')
Write-Output "STATE=$r"`],
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true },
      (err, stdout) => {
        if (err && !stdout) {
          console.log('[launcher] 探询进程失败（按 retry 处理，不启动）:', err.message)
          resolve('retry')
          return
        }
        switch (parseProbeState(String(stdout))) {
          case 1: console.log('[launcher] 已激活运行中的实例:', targetPath); resolve('running'); return
          case -1: console.log('[launcher] 目标在运行但窗口收在托盘里:', targetPath); resolve('tray'); return
          // ⚠️⚠️ 2 = **根本没有这个进程** —— 这是唯一允许去启动新实例的返回值。
          //    在此之前 `absent` 对「exe 存在但没在运行」是**不可达**的：C# 把
          //    「没这个进程」和「进程在但没建窗」都返回 0，上层一律当 retry，
          //    3 次之后判 failed → **一个没在运行的程序永远点不开**，只弹
          //    「没能确认是否已在运行…请再点一次」。用户报的「有的图标点开就这样」即此。
          case 2: resolve('absent'); return
          // 0 = 进程在、但还没找到带标题的窗口（多半是刚启动还没建窗）→ 值得重试
          case 0: resolve('retry'); return
          default:
            console.log('[launcher] 探询输出无法解析（按 retry 处理，不启动）:', JSON.stringify(String(stdout ?? '').trim().slice(0, 120)))
            resolve('retry')
        }
      }
    )
  })
}

// ─── 用 UI Automation 点托盘图标，把「收在托盘里」的窗口唤出来（v1.13.7）──────
// 为什么需要它：单实例/托盘型应用（微信、QQ）关到托盘后，**没有别的安全办法**能让
// 它把窗口显示出来 ——
//   • execFile / Start-Process 都会新开一个进程（微信就是弹登录窗，用户报的正是这个）
//   • 对隐藏窗口调 ShowWindow 强行显示，实测有概率让它「可见但失去响应」（卡死，踩过）
//   • 模拟鼠标点托盘图标：Win11 的托盘图标在溢出面板里，跨进程读它的位置需要注入内存
// UI Automation 是正路：托盘图标本身就是 UIA 元素、有 Invoke 模式 ——
// 等价于用户自己点它，而**不碰应用的窗口**、不开进程、不动鼠标。
//
// 实测（本机 Win11 + 微信 4.1）：打开隐藏图标面板 → 面板里点「微信」→
// 窗口 visible=False → True、前台切过去、进程数不变、未响应 0 个、面板自动收起。
//
// ⚠️⚠️ 这段 C# 必须纯 ASCII，而且**不能含反斜杠转义序列**：
//   ① 纯 ASCII —— powershell.exe -Command 按系统 ANSI 代码页解码命令行，UTF-8 的中文注释
//      会把源码解坏 → Add-Type 编译失败 → 功能静默失效。
//   ② 无反斜杠 —— 这段 C# 嵌在 TS 的模板字符串里，写 "\n" 会被 JS 解成真换行、
//      把 C# 字符串常量截断（踩过两次）。检查脚本见 devtools/probe/cs-escapes.cjs。
//   所有中文（按钮名、面板名、目标名）都由 TS 侧以**参数**传进来。
// 托盘相关的中文名（UIA 元素的 Name 是中文）。放 TS 侧，C# 保持纯 ASCII。
// 溢出面板用**类名** TopLevelWindowForOverflowXamlIsland 定位（C# 里），它的中文 Name
// 在不同系统语言下会变，所以不靠名字。这个按钮的名字是稳定的。
const TRAY_SHOW_HIDDEN_NAME = '显示隐藏的图标'

/** 目标程序收在托盘时，用 UIA 点它的托盘图标把它唤出来。
 *  返回 true = 已点击（调用方按「已唤出」处理）。
 *
 *  ⚠️⚠️ 脚本必须写成**带 UTF-8 BOM 的 .ps1 再 `-File` 执行，不能用 `-Command` 传文本**
 *  （这条是踩出来的，非常隐蔽）：`-Command` 的文本要经过**系统 ANSI 代码页**解码，
 *  脚本里的中文会被截成半个字符 —— 实测报
 *  `[QLTray]::ClickTrayIcon('显示隐藏的图�?, …) 字符串缺少终止符`，
 *  整条 PowerShell 解析失败、又因为 stdout 已被消费而**看不到任何输出**，
 *  表现就是「调用方静默死住」。带 BOM 的 .ps1 由 PowerShell 按 UTF-8 读，编码有确定保证，
 *  也不再依赖系统区域设置（中文 Win 是 GBK，其它语言机器会直接坏掉）。
 *  实测：`-Command` 失败 / BOM+.ps1 `-File` 连续两次成功。 */
function clickTrayIconFor(targetPath: string): Promise<boolean> {
  const exeName = basename(targetPath).replace(/\.[^.]+$/, '') // Weixin.exe → Weixin
  // ⚠️ 文件名必须**每次唯一**（原来只带 pid）：600ms 内点两个不同的托盘型应用时，
  //    第二次 writeFileSync 会覆盖同一路径，而第一次结束时 `rmSync` 删掉的正是第二次
  //    还没被 PowerShell 读到的脚本 → 第二次静默失败（只留一行日志）。
  //    渲染端的防连点是按 targetPath 分别计时的，拦不住这种「连点两个不同图标」。
  const uniq = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const scriptPath = join(app.getPath('temp'), `ql-tray-${process.pid}-${uniq}.ps1`)
  try {
    const escaped = targetPath.replace(/'/g, "''")
    const script = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$wpf = Join-Path $env:WINDIR 'Microsoft.NET\\Framework64\\v4.0.30319\\WPF'
Add-Type -ReferencedAssemblies @("$wpf\\UIAutomationClient.dll", "$wpf\\UIAutomationTypes.dll", "$wpf\\WindowsBase.dll") -TypeDefinition @'
${TRAY_CLICK_CS}
'@
# 候选名 = 该程序所有顶层窗口的标题（微信的托盘 tooltip 就是它的窗口标题「微信」）+ exe 名兜底。
# ⚠️ 不能用 $_.MainWindowTitle：窗口**隐藏**时它是空的（实测），候选会退化成 exe 名而永远匹配不上。
$cands = New-Object System.Collections.Generic.List[string]
foreach ($t in ([QLTray]::WindowTitles('${escaped}') -split '\\|')) { if ($t) { [void]$cands.Add($t) } }
[void]$cands.Add('${exeName}')
# ⚠️ 只有「窗口标题 + exe 名」不够：微信 4 的托盘图标 UIA 名是 **WeChat-CN**，
#    跟「微信」「Weixin」互不包含 → 永远匹配不上，点托盘必然失败（用户报障「微信打不开」）。
#    再从 exe 版本信息里取产品名（WeChat / 微信 …）进候选；匹配是「包含」判断，后缀 -CN 无所谓。
try {
  $vi = (Get-Item -LiteralPath '${escaped}').VersionInfo
  foreach ($v in @($vi.FileDescription, $vi.ProductName, $vi.InternalName)) {
    if ($v) { [void]$cands.Add($v); [void]$cands.Add(($v -replace '\\s', '')) }
  }
} catch { }
[QLTray]::ClickTrayIcon('${TRAY_SHOW_HIDDEN_NAME}', $cands.ToArray())`
    // BOM 不能省：没有它 PowerShell 5.1 会按 ANSI 代码页读文件，中文同样会坏
    writeFileSync(scriptPath, '\ufeff' + script, 'utf8')

    // ⚠️ 必须异步 + 超时，不能用 execFileSync：
    //   实测在完整应用里 UIA 的 Invoke 那一步会卡住不返回（最小 Electron 应用里同样的脚本却正常），
    //   而 execFileSync 会**阻塞主进程事件循环** —— 表现为整个 Dock 卡死、连 app.exit 都执行不了。
    //   改成子进程 + 回调，卡住也只是一个 8s 超时的后台任务，主进程始终活着。
    return new Promise<boolean>((resolve) => {
      let settled = false
      let killTimer: ReturnType<typeof setTimeout> | null = null
      const finish = (v: boolean): void => {
        if (settled) return
        settled = true
        if (killTimer) { clearTimeout(killTimer); killTimer = null }
        try { rmSync(scriptPath, { force: true }) } catch { /* ignore */ }
        resolve(v)
      }
      const child = execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { timeout: 8000, windowsHide: true, maxBuffer: 1 << 20 },
        (err, stdout, stderr) => {
          if (err) {
            console.log('[launcher] tray click failed:', err.message)
            logWarn('launcher', `托盘点击子进程失败: ${err.message} | stderr=${String(stderr ?? '').trim().slice(0, 300)}`)
            finish(false)
            return
          }
          logInfo('launcher', `托盘点击输出: ${String(stdout ?? '').trim().replace(/[\r\n]+/g, ' ').slice(0, 200)}`)
          const n = Number(String(stdout).trim().split(/\r?\n/).pop())
          if (n === 1) { console.log('[launcher] 已通过托盘图标唤出:', targetPath); finish(true) }
          else { console.log('[launcher] 托盘图标未点击（返回值 ' + String(stdout).trim() + '）:', targetPath); finish(false) }
        }
      )
      // 兜底：execFile 的 timeout 只杀子进程，回调理论上会来；但万一子进程杀不掉也不拖着 run-app
      killTimer = setTimeout(() => {
        if (settled) return
        console.log('[launcher] tray click 超时，按未点击处理:', targetPath)
        try { child.kill() } catch { /* ignore */ }
        finish(false)
      }, 9000)
    })
  } catch (err) {
    console.log('[launcher] tray click setup failed:', err instanceof Error ? err.message : String(err))
    try { rmSync(scriptPath, { force: true }) } catch { /* ignore */ }
    return Promise.resolve(false)
  }
}

// 把 Dock 窗口压到 z-order 最底（HWND_BOTTOM）。Electron 没有 moveBottom()，
// 只能通过 SetWindowPos 调 Windows API 实现真正沉底。
//
// 两条落地通道：常驻助手（~20ms，默认）与一次性 PowerShell（~700ms，助手没起来时兜底）。
// 无论走哪条，收尾都要经过 `finishSink()` 的代数校验 —— 见那里的注释。
//
// ⚠️ `strict`（v1.19.4）：**点图标启动后**这一次沉底必须是「无条件生效」的。
// 收尾里的「用户又抓回 Dock 了」判定包含「指针停在玻璃条上」和「刚在 Dock 上动过」，
// 而点图标这个动作**必然**让这两条成立 —— 于是启动后的沉底每次都被自己撤销：
// 表现就是「打开微信，Dock 闪一下、过一会儿（等看门狗）才退到后台」（用户 2026-11-28 报障）。
// 启动路径传 strict=true，只认「sinkSeq 变了 / 窗口被藏了」这两种真正的反悔信号。
function sendToBottom(win: BrowserWindow, strict = false): void {
  if (win.isDestroyed()) return
  const startSeq = sinkSeq
  // 同一扇窗口已有沉底任务在跑：不重复起进程（每次都是一个新的 powershell.exe）。
  // 延迟重试（180ms）而不是直接放弃——谁后到谁说了算，最后一次 blur 的意图必须被满足。
  //
  // ⚠️ 重试的守卫**不能**写成 `sinkState?.win === win`：上一轮任务完成时会把 sinkState
  // 置回 null，于是这个守卫恒假、重试永远什么都不做（第二次让位意图被静默吞掉）。
  // 正确的守卫是「意图还成立吗」——没被更晚的唤回作废、窗口还在、可见、没收托盘、没拿到焦点。
  if (sinkState && sinkState.win === win) {
    setTimeout(() => {
      if (sinkSeq !== startSeq) return // 期间有更新的意图，交给那条路径
      // ⚠️ `strict` 必须**透传**下去：启动路径那次沉底一旦退化成非 strict，
      //    finishSink 里的「用户又抓回 Dock 了」判定就会因为「点图标必然把指针
      //    留在玻璃条上」而撤销掉它 —— 正是 v1.19.4 修过的那个症状。
      //    同理 strict 时不看 isFocused / canSinkNow（初始那次调用本来也不看）。
      const stillWanted = win.isVisible() && !dockTrayHidden &&
        (strict || (!win.isFocused() && canSinkNow()))
      if (!win.isDestroyed() && stillWanted) sendToBottom(win, strict)
    }, 180)
    return
  }

  const buf = win.getNativeWindowHandle()
  const hwnd = buf.length >= 8
    ? `0x${buf.readBigUInt64LE(0).toString(16)}`
    : `0x${buf.readUInt32LE(0).toString(16)}`
  sinkState = { win, seq: startSeq, strict }
  lastSinkAt = Date.now()

  // 快路：常驻助手在（应用启动 5s 后就是）→ 一次管道往返，实测 ~20ms。
  // 这是「点开应用后 Dock **立刻**退开」的关键：慢路要起一个 powershell（~700ms），
  // 那期间新窗口已经弹出来了、Dock 还挂在上面的观感就是用户报的
  // 「闪一下、过一会儿才退到后台」（2026-11-28）。
  if (activateHelperReady && activateHelper) {
    logInfo('dock', `sendToBottom(助手) seq=${startSeq} hwnd=${hwnd}`)
    void helperSink(hwnd).then((ok) => {
      finishSink(win, startSeq, strict, ok ? null : new Error('助手沉底失败'))
    })
    return
  }

  const psScript = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WinZ {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
'@
# HWND_BOTTOM=1, SWP_NOSIZE|SWP_NOMOVE|SWP_NOACTIVATE
[WinZ]::SetWindowPos([IntPtr]::new(${hwnd}), [IntPtr]::new(1), 0, 0, 0, 0, 0x0002 -bor 0x0001 -bor 0x0010) | Out-Null`

  logInfo('dock', `sendToBottom(PS 兜底) seq=${startSeq} hwnd=${hwnd}`)
  runPowerShell(psScript, 4000, ({ err }) => finishSink(win, startSeq, strict, err))
}

/** 沉底任务的收尾（快路 / 慢路共用）。err 非空表示这次 SetWindowPos 没落地。 */
function finishSink(win: BrowserWindow, startSeq: number, strict: boolean, err: Error | null): void {
  // ⚠️ 必须先捕获「这次沉底是不是我们自己的、还是否仍然成立」，**再**清 sinkState。
  // 原实现先清 sinkState 再调 stillWanted()，而 stillWanted() 的第一个条件正是
  // `sinkState?.win === win` —— 于是它恒为 false，紧跟的 `if (!visible) recoverDock()`
  // 在**每一次成功的沉底之后**都会执行，把刚沉下去的 Dock 又拉回置顶
  // （并顺带 markDockShown() 重置 2.5s 宽限期，让下一次 blur 也被吞掉）。
  // 表现：「点击别的软件后 Dock 让位」100% 被撤销。
  const ours = sinkState?.win === win && sinkState.seq === startSeq
  if (sinkState?.win === win) sinkState = null
  // ⚠️ 窗口可能在沉底途中就被销毁（托盘退出 / 切档重建 / 渲染进程崩溃后的重建）：
  //    下面 `pointerOverBar()` 要读 `win.getContentBounds()`，对已销毁窗口必定抛
  //    "Object has been destroyed"。慢路（一次性 PowerShell）里那是 execFile 回调，
  //    抛错会落进 uncaughtException —— 这一次的「仍然有效 / 需要补偿」判定整条被跳过，
  //    而且快路（助手 .then）里会变成未处理 rejection。所以存活判定要提到最前。
  if (win.isDestroyed()) return
  if (err) {
    logError('dock', 'sendToBottom 失败', err)
    // 退避：失败会让窗口停在「已降级、没沉底」的半吊子状态，看门狗下一拍（500ms）
    // 又会认为该沉底 → 每 500ms 起一个 powershell.exe 的死循环（每个 ~700ms CPU、
    // 几十 MB 内存）。这里记账，让 watchdog 先歇 SINK_FAIL_BACKOFF_MS 再重试。
    lastSinkFailAt = Date.now()
    // 失败时调用方已经把窗口从置顶层降级（setAlwaysOnTop(false)），却没能真正沉底：
    // 窗口会停在「非置顶、又盖在普通窗口上面」的半吊子状态，且不会再自己回来。
    // 显式恢复置顶，把下一次让位交给下一次 blur 重新尝试。
    // 同时清掉 dockAutoSunk —— 窗口已经回到置顶层了，再留着这个标记会让下一次
    // Alt+Space / 托盘点击走「唤回」分支（位置本来就在顶上）→ 按一下毫无反应。
    if (win.isVisible() && !dockTrayHidden) {
      dockAutoSunk = false
      recoverDock(win)
    }
    return
  }
  // 这次沉底仍然有效（期间没有任何更晚的「拉回/隐藏」意图，窗口也还在原位）→ 什么都不做
  // ⚠️ 这里**不能**再用 `!win.isFocused()`：本机的焦点状态会卡在 true（见 sinkWatchdogTick
  //    的注释），那样每一次成功沉底都会被这行判成「已被拉回」→ 紧接着 recoverDock 撤销掉，
  //    表现就是「沉一下又弹回来」，还会每 500ms 白起一个 PowerShell。
  //    换成「期间用户有没有重新抓住 Dock」：指针回到玻璃条上 / 浮层打开 / 刚在 Dock 上动过。
  // strict（启动路径）：不看指针/活动 —— 点图标必然把指针留在玻璃条上，看了就永远撤销。
  const reEngaged = strict ? false
    : (pointerOverBar(win) || dockOverlayOpen || Date.now() - lastDockActivityAt < 600)
  if (ours && sinkSeq === startSeq && win.isVisible() && !reEngaged && !dockTrayHidden) {
    return
  }
  // 迟到的 HWND_BOTTOM 补偿：执行期间用户可能已经把 Dock 拉回来了
  // （Alt+Space 唤回 / 托盘 / 鼠标移回 / 启动失败恢复）。这里不能再用
  // isAlwaysOnTop() 判断——恢复路径会把它设回 true，原写法恒真、形同虚设。
  if (win.isVisible()) recoverDock(win)
}

/** 光标是不是停在玻璃条上（含 6px 容差）。
 *
 *  ⚠️ 不用 renderer 的 `dock-pointer` 事件：它只在 mouseenter/mouseleave 时报一次，
 *  实测会被莫名其妙的 mouseleave 提前清掉（静止悬停时尤其不可靠），而静止悬停恰恰是
 *  「用户正在看 Dock」的典型状态。主进程直接量：光标（`screen.getCursorScreenPoint`，
 *  屏幕 DIP）+ 内容区原点（`getContentBounds`）+ renderer 上报的玻璃条矩形（`dockBarRect`）。 */
function pointerOverBar(win: BrowserWindow): boolean {
  if (!dockBarRect) return false
  const b = win.getContentBounds()
  const p = screen.getCursorScreenPoint()
  const pad = 6
  return p.x >= b.x + dockBarRect.x - pad && p.x <= b.x + dockBarRect.x + dockBarRect.width + pad &&
         p.y >= b.y + dockBarRect.y - pad && p.y <= b.y + dockBarRect.y + dockBarRect.height + pad
}

/** 退场看门狗（v1.19.1）：用户不在用 Dock 时，让它自动退回所有窗口后面。
 *
 *  用户报障原话：「我希望在点击其他区域的时候，dock 栏就自动退到后台」。
 *
 *  ⚠️ 为什么不用 blur / isFocused()（实测结论，改这块先读）：
 *  这扇窗的焦点状态在本机会**卡死在 true** —— 系统前台已经是 Edge/抖音
 *  （`GetForegroundWindow` 也指向它），但 `win.isFocused()` / `document.hasFocus()`
 *  一直是 true，Windows 也不再发 WM_KILLFOCUS。原因是窗口被前台锁拒绝激活时，
 *  `show()/focus()` 只拿到了**线程内键盘焦点**。结果 blur 永不触发 → 点别的软件不让位
 *  （用户实机日志里整段会话 `sendToBottom` 一次都没有）。
 *  `powerMonitor.getSystemIdleTime()` 也同样不可用：本机恒返回 0（实测系统已空闲 3s）。
 *
 *  所以判据只有一个来源可靠的信号：**renderer 上报的「用户刚在 Dock 上动过」**
 *  （mousemove / keydown / wheel / pointerdown，见 `dock-activity`）。
 *  「没在动 + 没悬停 + 没浮层」持续 `DOCK_IDLE_SINK_MS` → 退场。
 *  沉底之后 `isAlwaysOnTop()` 变 false，下一拍直接跳过，不会反复起 PowerShell。 */
const SINK_WATCHDOG_MS = 500
/** 用户离开 Dock 多久后让它退到后台。太短会在「眼睛还在看、手还没动」时消失，2.5s 够稳。 */
const DOCK_IDLE_SINK_MS = 2500
/** 沉底失败后的退避窗口：失败时窗口已被恢复置顶，若不退避，看门狗下一拍（500ms）
 *  就会再次尝试 → 每 500ms 一个 powershell.exe 的死循环。5s 足够让一次性抖动自愈，
 *  又不会让「真的失败了」永远不重试。 */
const SINK_FAIL_BACKOFF_MS = 5000

/** 上一次 watchdog 的判定结果（只在变化时落一行日志，500ms 一拍也不会刷屏）。
 *  排查「Dock 不退场」时先看这一行：`in-use` = 指针在上面或有浮层、`busy` = 刚动过、
 *  `grace` = 刚显示/唤回的 2.5s 宽限、`not-top` = 已经退过了。 */
let lastWatchdogState = ''

function sinkWatchdogTick(): void {
  const win = mainWindow
  let state: string
  if (!win || win.isDestroyed()) state = 'no-window'
  else if (!win.isVisible()) state = 'hidden'
  else if (dockTrayHidden) state = 'tray'
  else if (dialogOpen) state = 'dialog'
  else if (!win.isAlwaysOnTop()) state = 'not-top'
  else if (sinkState) state = 'sinking'
  else if (pointerOverBar(win) || dockOverlayOpen) state = 'in-use'
  else if (Date.now() - lastDockActivityAt < DOCK_IDLE_SINK_MS) state = 'busy'
  else if (!canSinkNow()) state = 'grace'
  else if (Date.now() - lastSinkFailAt < SINK_FAIL_BACKOFF_MS) state = 'sink-failed'
  else state = 'sink'

  if (state !== lastWatchdogState) {
    lastWatchdogState = state
    logInfo('dock', `watchdog state=${state}`)
  }

  if (state !== 'sink' || !win) return
  dockAutoSunk = true
  win.setAlwaysOnTop(false)
  sendToBottom(win)
}

/** 看门狗定时器句柄。必须可停：`before-quit` 会 preventDefault 并最长等 800ms，
 *  这段时间里每 500ms 的一拍仍可能在退出途中再起一个 PowerShell（沉底一次 ~700ms），
 *  既拖慢退出又白烧一次 CPU。 */
let sinkWatchdogTimer: NodeJS.Timeout | null = null

function startSinkWatchdog(): void {
  if (sinkWatchdogTimer) return
  sinkWatchdogTimer = setInterval(sinkWatchdogTick, SINK_WATCHDOG_MS)
  sinkWatchdogTimer.unref?.()
}

function stopSinkWatchdog(): void {
  if (!sinkWatchdogTimer) return
  clearInterval(sinkWatchdogTimer)
  sinkWatchdogTimer = null
}

/** 创建 Dock 窗口。
 *  edge 显式传入（**不再从磁盘回读**）：切换位置的写入万一失败，也不会出现
 *  「窗口已重建、方向却退回旧值」的错位；dockEdge 与窗口始终一致。
 *  startHidden 决定建好后是否显示——由调用方给出「原本是显示还是收在托盘里」，
 *  不能再拿 startedAtLogin 判断：那是整进程常量，开机自启会话里永远为真，
 *  切位置重建的窗口会一直不显示（Dock 直接消失进托盘）。 */
function createWindow(edge: DockEdge, startHidden: boolean): void {
  const iconPath = resolveResource('icon.ico')
  dockEdge = edge
  // 旧窗口留下的「延迟隐藏」必须作废：它闭包里只比对 sinkSeq 与 dockTrayHidden，
  // 而新窗口这两者可能凑巧都成立 —— 迟到的 hide() 会把刚建好的 Dock 直接藏掉。
  clearLaunchHide()
  // 🚫 换新 HWND 时必须清掉 region 去重 key，否则「重建窗口」这条路上 region 永久丢失：
  // ready-to-show 与 renderer 首帧上报算出来的 key 与上一扇窗口完全相同（尺寸不变、浮层
  // 关着），`apply()` 里 `key === dockShapeApplied` 直接 return → 新窗口从来没调过
  // setShape → 整窗恢复吃鼠标（用户报障就是「改进之后又不穿透了」）。
  // 去重只能用来挡「同一扇窗口的重复上报」，不能跨窗口继承。
  dockShapeApplied = ''
  const { w: winW, h: winH } = windowSizeFor(edge)
  const pos = positionForEdge(edge, { w: winW, h: winH })

  mainWindow = new BrowserWindow({
    width: winW,
    height: winH,
    x: pos.x,
    y: pos.y,
    show: false,
    frame: false,
    transparent: true,
    // 显式给全透明背景色：Electron 默认背景是白色（#FFF），透明窗口一旦发生
    // setBounds 重绘就会先糊一层白底（表现为整窗白闪）。当前已取消所有程序化
    // resize（面板/菜单都改成固定高度浮层），保留此项作为兜底。
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // 把停靠边同步传给渲染端（preload 直接读 argv 暴露成常量）：首帧就能按方向布局，
      // 不走 IPC 异步取，避免启动瞬间先画一次底部 Dock 再翻上去
      additionalArguments: [`--ql-edge=${dockEdge}`]
    }
  })

  // 注：这里不再监听 move/moved，也没有位置巡检——Dock 不支持自由拖动，
  // 窗口位置只由「位置」预设决定（见 positionForEdge / applyDockEdge）。

  mainWindow.on('ready-to-show', () => {
    // 命中区兜底重设：窗口重建（切竖排档位 / activate）后新 HWND 没有 region，
    // 而 renderer 的首帧上报要等 page 加载完。这里先用上一扇窗口记下的矩形顶一下，
    // 尺寸没变所以通常是对的；renderer 挂载后会上报真实值覆盖它。
    applyDockHitRegion(mainWindow)
    // 是否显示只看 startHidden（调用方给出的「原本显示 / 原本收在托盘里」）。
    // 曾经这里还判断 startedAtLogin，那是整进程常量：开机自启会话里永远为真，
    // 于是切位置重建出来的窗口一律不显示——Dock 会直接消失进托盘。
    if (!startHidden) {
      mainWindow?.show()
      markDockShown() // 启动/重建后刚显示：这段时间的 blur 是焦点抖动，不触发沉底
      // 首次显示后核实一次 z-order：启动瞬间终端/资源管理器正在抢前台，
      // 只依赖 show() + focus() 有概率停在「可见但不在最前」（v1.11.0 自愈）
      if (mainWindow && !mainWindow.isDestroyed()) verifyDockOnTop(mainWindow, sinkSeq, 0)
    } else {
      dockTrayHidden = true
      // 收在托盘里：不能算「刚显示过」，否则之后第一次唤回+点击别的软件会落在
      // 宽限期里被吞掉（唤醒路径自己会重新 markDockShown，见 toggleWindow）
      dockShownAt = 0
    }
  })

  // Hide to tray instead of closing
  mainWindow.on('close', (event) => {
    if (!forceQuit) {
      event.preventDefault()
      dockTrayHidden = true
      sinkSeq++ // 隐藏同样作废在途沉底（与其它四条隐藏路径一致）：不能让它去操作一扇已隐藏的窗口
      mainWindow?.hide()
    }
  })

  // 点击其他软件时让出置顶：Dock 沉到普通窗口下方，不再遮挡正在使用的应用。
  // 点击 Dock / Alt+Space / 托盘唤出时由 focus 事件恢复置顶。
  // 注意：setAlwaysOnTop(false) 只从置顶层降级（HWND_NOTOPMOST），z-order 仍停在
  // 非置顶组顶部——Explorer 也是非置顶窗口，Dock 依然排在它之上。必须再调
  // SetWindowPos(HWND_BOTTOM) 把 z-order 压到最底，Dock 才会真正沉到其他窗口下方。
  mainWindow.on('blur', () => {
    // 系统文件对话框打开期间不沉底：对话框是模态的，会抢走焦点触发 blur，
    // 此时沉底会连带把对话框压到其他软件下面（模态对话框跟随父窗口层级）
    if (dialogOpen) return
    // 窗口已隐藏（如 run-app 启动后自动隐藏到托盘，hide() 会触发 blur）：不可见窗口无需沉底
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return
    // 已经收在托盘里：不需要为一次由隐藏引起的 blur 再起一个 PowerShell 进程
    if (dockTrayHidden) return
    // 刚显示出来（启动 / 重建窗口 / Alt+Space 唤回）：焦点抖动一律不沉底。
    // 这一条直接省掉一个 700ms 的 powershell.exe（见 SINK_GRACE_MS 注释）
    if (!canSinkNow()) return
    const startSeq = sinkSeq
    // blur 与「用户真的点了别的软件」之间存在噪声：首次启动、切换停靠位置重建窗口等
    // 都会伴随一次焦点抖动。延迟一拍再确认——期间若焦点已回到 Dock（或用户按了
    // Alt+Space 唤回、窗口被隐藏），就整条取消。这一拍也是留给「真的点了别的软件」
    // 的判定窗口：用户点击别的窗口后焦点不会在 120ms 内回到 Dock。
    setTimeout(() => {
      if (sinkSeq !== startSeq) return
      const win = mainWindow
      // 复核时把「窗口还在、可见、没收托盘、没拿到焦点、不在宽限期」一次判完：
      // 任何一条不满足都说明这次让位已经过时，不能白起一个 PowerShell 进程
      if (!win || win.isDestroyed() || !win.isVisible()) return
      if (dockTrayHidden || win.isFocused() || !canSinkNow()) return
      win.setAlwaysOnTop(false)
      sendToBottom(win)
    }, 120)
  })

  // 获得焦点（点击 Dock / Alt+Space / 托盘唤出）时恢复置顶。
  // run-app 启动后窗口隐藏到托盘，唤回时由这里恢复置顶并拉回顶层。
  mainWindow.on('focus', () => {
    dockTrayHidden = false
    dockAutoSunk = false // 拿到焦点就说明它不是「被 watchdog 沉掉的状态」了
    sinkSeq++ // 拿到焦点就是最明确的「我要它在上面」信号，作废在途沉底
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) recoverDock(mainWindow)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url).catch((err) => {
      logError('window', '外部链接打开失败', err)
    })
    return { action: 'deny' }
  })
  // ⚠️ 第二道防线：renderer 目前靠 document 级 `dragover`/`drop` 的 preventDefault 挡
  //    「把文件拖到窗口上 → Chromium 导航到 file:// → 白屏」，但那只在 renderer 生效
  //    （脚本出错/新窗口/页面重载瞬间都可能有空档）。主进程这里直接拒绝任何导航：
  //    Dock 窗口只加载一次页面，之后不应该再发生任何 top-level 导航。
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl && url.startsWith(devUrl)) return // 开发模式 HMR 重载用
    event.preventDefault()
    logWarn('window', `拦截页面导航: ${url.slice(0, 200)}`)
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  // 未获得单实例锁：本实例正在退出流程中，不初始化窗口/托盘
  if (!gotSingleInstanceLock) return

  // ⚠️ 必须先 await 填好「桌面图标是否隐藏」的缓存，**再**建窗：
  //    renderer 用 sendSync 在首帧之前读它，缓存没填好就会落回 false（=图标可见），
  //    系统里其实是隐藏的 → 菜单先渲染「隐藏桌面图标」、随后翻成「显示桌面图标」。
  //    代价约 50~200ms（一次 PowerShell），换文案从首帧就对。
  await primeDesktopIconsHidden()

  // 用户设置（settings.json）：必须在建窗之前读进来 —— renderer 首帧用 sendSync 读它，
  // 晚于建窗就会出现「先按默认主题画一帧、再翻成用户主题」的闪烁。
  initSettings()
  registerSettingsIpc({
    getDockEdge: () => dockEdge,
    applyDockEdge: (v) => (isImplementedEdge(v) ? setDockEdge(v) : false)
  })

  // shortcuts.json 的读写 IPC（load / save / externalize-icons）：注册本身不做 IO，
  // 放在建窗之前只是为了「renderer 一挂载就能 invoke」。
  registerShortcutsIpc()

  // 图标协议（A1）：条目上只存 iconFile，渲染端用 ql-icon://i/<file> 取图。
  // 它只是读文件，建窗之前注册好，首帧的 <img> 就不会 404。
  registerIconProtocol()

  // 设置中心（独立窗口 760×560）：Dock 只有 300px 高、透明窗 resize 会白闪，
  // 设置项没地方摆 → 「+」菜单里的分组选择器/偏好项全部搬进这扇窗，主菜单瘦回「动作」。
  // 这里只注册 IPC；窗口按需创建（打开时不常驻，关掉即销毁）。
  registerSettingsWindowIpc({
    iconPath: resolveResource('icon.ico'),
    preloadPath: join(__dirname, '../preload/index.js'),
    dataDir: app.getPath('userData'),
    onOpened: hideDockForSettings,
    onClosed: showDockAfterSettings
  })

  // 启动：位置取记忆里的停靠位置；是否显示由「是否开机自启」决定（--autostart 时收在托盘）
  createWindow(readDockEdge(), startHiddenAtLogin)

  // 沉底看门狗（v1.19.1）：blur 是**边沿触发**，覆盖不到「Dock 从来没拿到过焦点」的情形。
  // 1.2s 一拍、纯内存判断；只有真的要沉底时才起一次 PowerShell（与 blur 路径同量级）。
  // 放在建窗之后：`mainWindow` 必须先存在；窗口重建时这个 interval 不重开（它读的是全局）。
  // 退场看门狗（v1.19.1）：不依赖 blur / isFocused / 系统空闲时间（这三者在本机都不可信，
  // 见 sinkWatchdogTick 的注释），只按「用户最近有没有在用 Dock」判定。
  // 放在建窗之后：`mainWindow` 必须先存在；窗口重建时这个 interval 不重开（它读的是全局）。
  startSinkWatchdog()

  // 激活助手预热（v1.19.3）：点图标要「秒开」就得让那个常驻 PowerShell 提前把 C# 编译好，
  // 否则第一次点击会自己吃一次 ~1s 的冷启动。放到 5s 之后 —— 不与启动时的图标扫描/列盘符抢资源，
  // 也不占首帧时间；起不来（没有 PowerShell / 被策略拦）时会自动退回一次性探询。
  setTimeout(() => { void ensureActivateHelper() }, 5000).unref()

  // 更新检查（F1）：打包版启动 20s 后静默看一眼 latest.yml，有新版只走托盘气泡，
  // 绝不弹窗抢焦点（Dock 是常驻桌面窗，弹窗会把用户正在干的事打断）。
  scheduleSilentUpdateCheck(notifyUser)
  // 启动过程中收到过 second-instance（窗口还不存在时只能记账）：建好窗口后补一次唤回
  if (pendingSecondInstanceShow) {
    pendingSecondInstanceShow = false
    const win = mainWindow
    if (win && !win.isDestroyed()) {
      const reveal = (): void => {
        if (win.isDestroyed()) return
        clearLaunchHide()
        dockTrayHidden = false
        sinkSeq++
        markDockShown()
        win.show()
        recoverDock(win)
        win.focus()
      }
      // 页面还没画好时 show() 会露出未绘制的窗口，等 ready-to-show 再显示
      if (win.isVisible()) reveal()
      else win.once('ready-to-show', reveal)
    }
  }
  // 显示器参数变化后重新归位（screen 模块必须等 ready，所以在这里注册）
  screen.on('display-metrics-changed', reapplyDockEdgeOnDisplayChange)
  screen.on('display-added', reapplyDockEdgeOnDisplayChange)
  screen.on('display-removed', reapplyDockEdgeOnDisplayChange)
  // 桌面目录实时监听：文件夹新增/删除时通知 renderer 同步 Dock 图标
  startDesktopWatch()

  // System tray
  // 用多尺寸 ICO 而不是 16×16 的 PNG：显示器缩放 125% 时托盘需要 20 物理像素、
  // 150% 需要 24、200% 需要 32，单尺寸 PNG 会被系统拉伸成模糊（实测原 16px 图标
  // 在 125% 下必然发虚）。ICO 里 16/20/24/32 都是原生绘制，由外壳按当前 DPI 挑。
  //
  // ⚠️ 整块必须包 try/catch：`new Tray(emptyImage)` 会抛（打包漏资源 / 绿色版被挪走后
  //    resolveResource 回落到不存在的路径 → 空图）。原来它一抛，这个 async 回调就变成
  //    unhandledRejection（只打一行日志），**后面所有初始化整段跳过** —— 其中就包括
  //    在线代码之后的 `globalShortcut.register`。后果是「有 Dock、没托盘、Alt+Space 也没反应」，
  //    而且用户没有任何 UI 入口可以退出应用。
  try {
    const trayIcon = nativeImage.createFromPath(resolveResource('tray-icon.ico'))
    tray = new Tray(trayIcon)
    tray.setToolTip('快捷方式面板')
    tray.on('click', () => toggleWindow())

    const contextMenu = Menu.buildFromTemplate([
      {
        label: '显示窗口',
        click: () => {
          if (!mainWindow || mainWindow.isDestroyed()) return
          // 与 toggleWindow 的显示分支保持一致（三个动作缺一不可）：
          // ① sinkSeq++ 作废在途沉底——否则迟到的 SetWindowPos(HWND_BOTTOM) 会把刚显示的
          //    窗口钉到底部；② recoverDock 统一置顶入口；③ focus 由 recoverDock 的巡检兜住。
          // 原来只做 show()+focus()：一旦 Windows 前台锁拒绝这次激活（CLAUDE.md 里记过这个
          // 场景），窗口就停在「可见但不置顶」，而且没有任何宽限期保护
          clearLaunchHide()
          dockTrayHidden = false
          dockAutoSunk = false
          sinkSeq++
          // ⚠️ 必须 markDockShown()：这是「用户主动显示」，接下来 2.5s 内的 blur 都是焦点
          //    抖动，不该让位。其它四条显示路径（toggleWindow 两个分支 / ready-to-show /
          //    second-instance / 设置窗关闭）都有这一句，只有托盘这条漏了 —— 而
          //    `--autostart` 起的那次启动是把 dockShownAt 显式打成 0 的，
          //    于是从托盘唤回后点一下别的软件，Dock 会立刻被沉底。
          markDockShown()
          mainWindow.show()
          recoverDock(mainWindow)
          mainWindow.focus()
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          forceQuit = true
          app.quit()
        }
      }
    ])
    tray.setContextMenu(contextMenu)
  } catch (err) {
    logError('tray', '托盘初始化失败（快捷键与 Dock 仍可用，但只能从任务栏/Alt+Space 操作）', err)
  }

  // Global shortcut to toggle window. Prefer Alt+Space (verified working);
  // fall back to Ctrl+Alt+Space only if it fails to register. Note: Ctrl+Alt
  // is treated as AltGr on Windows and can be grabbed by IME/keyboard layouts,
  // which is why Alt+Space is tried first.
  let shortcutRegistered = false
  for (const combo of ['Alt+Space', 'Ctrl+Alt+Space']) {
    if (globalShortcut.register(combo, () => toggleWindow(true))) {
      shortcutRegistered = true
      console.log(`Registered global shortcut: ${combo}`)
      break
    }
  }
  if (!shortcutRegistered) {
    logWarn('hotkey', '所有唤出快捷键都注册失败（Alt+Space / Ctrl+Alt+Space）')
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      // 重新建窗：沿用当前方向，并直接显示（用户主动激活）
      createWindow(dockEdge, false)
    }
  })
})

// 退出前落盘：renderer 的保存是 400ms 防抖的，退出那一刻可能还有一次改动没写盘。
// 用 before-quit（窗口还活着、IPC 双向可用）推一条 flush-pending-save，然后**等
// renderer 回 flush-save-done**（B5）——不是拍一个固定 200ms 的定时器：图标外置后
// 一次落盘要过 externalize-icons + save-shortcuts 两次 IPC，磁盘忙时 200ms 会被挤掉，
// 用户看到的就是「退出前最后改的那一下没了」。上限 800ms 兜住 renderer 卡死。
let quitFlushed = false
let finishQuit: ((reason: string) => void) | null = null
ipcMain.on('flush-save-done', () => {
  finishQuit?.('renderer 已确认写盘')
})
app.on('before-quit', (event) => {
  // 不能要求 forceQuit：只有托盘「退出」会置它，其它退出路径（window-all-closed、
  // 系统注销/关机等）也需要把 renderer 400ms 防抖窗口里的改动落盘。
  if (quitFlushed) return
  if (!mainWindow || mainWindow.isDestroyed()) return
  quitFlushed = true
  event.preventDefault()
  let finished = false
  const finish = (reason: string): void => {
    if (finished) return
    finished = true
    finishQuit = null
    logInfo('persist', `退出前落盘：${reason}`)
    // 再次 quit 时 quitFlushed 已置位，before-quit 直接放行
    app.quit()
  }
  finishQuit = finish
  const win = mainWindow
  try {
    win.webContents.send('flush-pending-save')
  } catch {
    // IPC 已经不通（页面崩溃 / webContents 已销毁）：没有可等的东西，立刻放行
    finish('IPC 不可用，跳过等待')
    return
  }
  setTimeout(() => finish('等待超时（800ms），已放行'), 800)
})

// ─── 诊断：渲染端错误上报 / 打开日志目录 / 导出诊断包（B2）───────────────
// renderer 的 console.error 在打包版里用户永远看不到，所以让它把错误主动推过来
ipcMain.on('report-renderer-error', (_e, payload: unknown) => {
  const p = payload as { message?: unknown; stack?: unknown; source?: unknown } | null
  const message = typeof p?.message === 'string' ? p.message : '(无消息)'
  const stack = typeof p?.stack === 'string' ? p.stack : ''
  const source = typeof p?.source === 'string' ? p.source : ''
  logError('renderer', `${message}${source ? ` @ ${source}` : ''}${stack ? `\n${stack}` : ''}`)
})

ipcMain.handle('open-log-dir', async (): Promise<boolean> => {
  if (!getLogDir()) return false
  const err = await shell.openPath(getLogDir())
  if (err) logWarn('diag', `打开日志目录失败: ${err}`)
  return !err
})

/** 诊断包：日志 + 两份 JSON + 环境信息，打成 zip 放到桌面并打开资源管理器定位。
 *  用系统自带的 Compress-Archive（不引第三方 zip 依赖：本项目刻意保持零运行时依赖）。 */
ipcMain.handle('export-diagnostics', async (): Promise<string | false> => {
  const userData = app.getPath('userData')
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
  const ps = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ud = '${userData.replace(/'/g, "''")}'
$stage = Join-Path $env:TEMP 'ql-diag-${stamp}'
New-Item -ItemType Directory -Force -Path $stage | Out-Null
if (Test-Path (Join-Path $ud 'logs')) { Copy-Item (Join-Path $ud 'logs') $stage -Recurse -Force }
foreach ($f in 'shortcuts.json','shortcuts.json.bak','window-position.json','settings.json') {
  $p = Join-Path $ud $f
  if (Test-Path $p) { Copy-Item $p $stage -Force }
}
$info = @(
  'QuickLaunch diagnostics',
  ('time: ' + (Get-Date -Format o)),
  ('app: ${app.getVersion()}'),
  ('electron: ${process.versions.electron}'),
  ('node: ${process.versions.node}'),
  ('packaged: ${app.isPackaged}'),
  ('os: ' + [System.Environment]::OSVersion.VersionString),
  ('userData: ' + $ud)
)
$info | Set-Content -Path (Join-Path $stage 'info.txt') -Encoding UTF8
$dest = Join-Path ([Environment]::GetFolderPath('Desktop')) 'QuickLaunch-diagnostics-${stamp}.zip'
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $dest -Force
Remove-Item $stage -Recurse -Force
Write-Output ('DIAGOK=' + $dest)
`
  return new Promise((resolve) => {
    runPowerShell(ps, 30000, ({ err, stdout, stderr }) => {
      const lines = String(stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      const mark = lines.find((l) => l.startsWith('DIAGOK='))
      if (err || !mark) {
        logError('diag', `导出诊断包失败 code=${(err as NodeJS.ErrnoException | null)?.code ?? '-'} ${String(stderr ?? '').trim().slice(0, 400)}`)
        resolve(false)
        return
      }
      const dest = mark.slice('DIAGOK='.length).trim()
      logInfo('diag', `诊断包已导出 ${dest}`)
      try { shell.showItemInFolder(dest) } catch {}
      resolve(dest)
    })
  })
})

// ─── 崩溃看门狗（B1）──────────────────────────────────────────────────────
// 背景：透明无边框窗口一旦 renderer 挂掉，用户看到的是「Dock 消失了、进程还在、
// Alt+Space 也没反应」。没有日志、没有重建，现场什么都留不下来。
//
// 策略：
// - **自动重建**，但要限流。崩溃-重建死循环会把 CPU 打满，用户只看到 Dock 一直在闪，
//   比「停手并告诉他去看日志」更糟。
// - **不弹模态框**：真实崩溃现场弹 dialog 有可能把主进程也卡住（它要跑自己的事件循环），
//   托盘气泡 + 日志文件已经够用户找到我们。
// - 限流窗口 60s / 最多 3 次是拍的：单次崩溃（显卡驱动、HMR）能自愈，
//   真·死循环（坏图标、坏 JSON）在第 3 次就停手。
const CRASH_WINDOW_MS = 60_000
const CRASH_MAX_REBUILDS = 3
let crashTimes: number[] = []
let crashGaveUp = false

/** 托盘气泡（失败静默：有些系统策略禁掉了通知，不能让它反过来搞崩流程） */
function notifyUser(title: string, content: string): void {
  try {
    tray?.displayBalloon({ title, content, iconType: 'error' })
  } catch {
    /* 忽略 */
  }
}

function rebuildAfterRendererGone(reason: string): void {
  if (crashGaveUp) return
  const now = Date.now()
  crashTimes = crashTimes.filter((t) => now - t < CRASH_WINDOW_MS)
  crashTimes.push(now)
  if (crashTimes.length > CRASH_MAX_REBUILDS) {
    crashGaveUp = true
    logError('crash', `渲染进程在 ${CRASH_WINDOW_MS / 1000}s 内第 ${crashTimes.length} 次异常退出，停止自动重建`)
    notifyUser('快捷方式面板已停止自动恢复', `渲染进程反复退出。日志：${getLogDir()}`)
    return
  }
  logWarn('crash', `渲染进程异常退出（${reason}），第 ${crashTimes.length} 次自动重建（edge=${dockEdge} hidden=${dockTrayHidden}）`)
  try {
    const old = mainWindow
    mainWindow = null
    old?.destroy()
  } catch (err) {
    logWarn('crash', '销毁崩溃窗口时出错（忽略）', err)
  }
  try {
    createWindow(dockEdge, dockTrayHidden)
    logInfo('crash', '窗口重建完成')
  } catch (err) {
    logError('crash', '窗口重建失败', err)
    notifyUser('快捷方式面板未能恢复', `日志：${getLogDir()}`)
  }
}

app.on('render-process-gone', (_event, webContents, details) => {
  // 只关心主窗口：文件夹卡片/搜索浮层将来会有自己的 webContents，不该一起重建
  if (mainWindow && !mainWindow.isDestroyed() && webContents !== mainWindow.webContents) {
    logWarn('crash', `非主窗口的渲染进程退出（reason=${details.reason}），不重建`)
    return
  }
  rebuildAfterRendererGone(`reason=${details.reason} exitCode=${details.exitCode ?? '?'}`)
})

app.on('child-process-gone', (_event, details) => {
  // GPU / utility 进程崩溃不会让 Dock 消失（Chromium 会自己重启它们），只记录
  logWarn('crash', `子进程退出 type=${details.type} reason=${details.reason} exitCode=${details.exitCode ?? '?'}`)
})

process.on('uncaughtException', (err) => {
  logError('crash', 'uncaughtException（主进程）', err)
  notifyUser('快捷方式面板遇到内部错误', `${err.message}\n日志：${getLogDir()}`)
})

process.on('unhandledRejection', (reason) => {
  logError('crash', 'unhandledRejection（主进程）', reason)
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  stopDesktopWatch()
  stopActivateHelper() // 常驻激活助手必须一起收掉，否则退出后还挂着一个 powershell.exe
  stopSinkWatchdog()
  // 设置的写盘是 150ms 合并的（拖滑块会连发几十个 set-settings）：退出前必须强制落一次，
  // 否则「刚改完就退出」那一下会跟着进程一起消失。
  flushSettingsWrite()
})

/** 点完托盘图标之后，等应用把窗口真的显示出来。
 *
 *  ⚠️ 必须**轮询**，不能只查一次：微信点完托盘约 1s 才出窗，一次性检查会把它误判成失败。
 *  这里的探询同时充当「把窗口抬到前台」的动作（`Probe` 命中可见窗口时会置前）。
 *  最多等 `tries × 400ms`（默认 ~2.5s）：真的不建窗的应用（WeGame 实测）只能认。 */
async function waitForWindowShown(targetPath: string, tries = 6): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const s = await helperProbeOnce(targetPath)
    if (s === 'running') return true
    if (s === 'absent') return false // 进程都退出了，再等也没意义
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return false
}

app.on('window-all-closed', () => {
  // 切换停靠边时会 destroy 旧窗口再建新的：这一瞬间没有窗口，不能当成「用户关掉了应用」
  if (recreatingWindow) return
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
