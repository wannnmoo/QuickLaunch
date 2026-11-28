# 快捷方式面板 (Shortcut Dashboard)

基于 **React 19 + TypeScript 7 + Electron 43 + Vite 7** 构建的 Windows 桌面应用——透明毛玻璃 Dock 栏悬浮桌面，一键启动程序、文件夹和系统位置。

## 移除「隐藏任务栏」功能（v1.21，未发版）

**用户结论**：这个功能「还是不太实用」—— 隐藏任务栏抢不回那 48px（二选一：要贴边不唤出就抢不回工作区；
要工作区全屏就得开 auto-hide，而鼠标一贴底边任务栏又滑回来），隐藏后连**我们自己的托盘图标**也一起没了，
而托盘型应用（微信/QQ）的唤出又必须先有一个看得见的任务栏 —— 于是整条功能删除。

> 铺垫在上面那节「托盘应用『点不动』事故与回滚」里：为了绕开任务栏而直接 `ShowWindow` 隐藏窗口，
> 结果给微信留下了「可见但点不动」的假窗口；重启 exe 又会多开实例；不展开就点托盘图标在 Win11 上没有落点。
> 三条路都不通，这个功能就没有存在价值了。

### 清理范围

| 位置 | 删掉的东西 |
|---|---|
| `src/main/ps.ts` | `ACTIVATE_CS` 里整段任务栏 C#：`TbState` / `TbSet` / `TbHideInstant` / `TbRevealOffscreen` / `TbShowInstant` / `TaskbarWindows` / `AppBarState` / `AppBarSetState` / `SetWorkAreaFor` / `BroadcastWorkAreaChange`，以及随之无用的 `APPBARDATA` / `SHAppBarMessage` / `MONITORINFO` / `MonitorFromWindow` / `GetMonitorInfo` / `GetWindowRect` / `GetSystemMetrics` / `SendMessageTimeout(string)` / `SystemParametersInfo(RECT)`。`ACTIVATE_CS` 从 **23.9KB → 12.4KB**；另删掉上一版那个会留「假活窗口」的 `ShowHidden` |
| `src/main/index.ts` | 任务栏模块（`TASKBAR_WATCH_MS` / `taskbarHiddenByUs` / `savedBarState` / `taskbarWatchTimer` / `queryTaskbar` / `showTaskbar` / `hideTaskbar` / `toggleTaskbar` / `startTaskbarWatch` / `stopTaskbarWatch` / `repairTaskbarOnStart` / `restoreTaskbarOnQuit` / `helperRequest`）、助手指令 `TB?` / `TBO` / `TBI` / `TB …`、IPC `taskbar-state` / `taskbar-toggle`、`DIRECT_SHOW_TRAY_WINDOW` 与 `helperShowHidden`、`whenReady` 里的崩溃自检定时器、`will-quit` 里的同步还原，以及**全项目唯一一处 `execFileSync`** |
| `src/preload/index.ts` + `env.d.ts` | `getTaskbarState()` / `toggleTaskbar()` 两个通道与对应类型 |
| `src/shared/types.ts` + `src/main/settings.ts` | `AppSettings.trayClickReveal` 及其 normalize 分支（老 `settings.json` 里残留该键会被忽略，不需要迁移） |
| `src/renderer/src/App.tsx` | `taskbarHidden` state / 读取 effect / `handleToggleTaskbar`；`'in-tray'` 提示里那句「先＋→ 显示任务栏」的分支与它的依赖项 |
| `src/renderer/src/AddMenu.tsx` | 「隐藏任务栏」「托盘应用可唤出任务栏」两个菜单项与对应 props |
| 产物 | 构建后 `out/main/index.js` 里 `TbState` / `taskbar-toggle` / `trayClickReveal` / `ShowHidden` 命中数均为 **0** |

### 现在的行为

托盘型应用（微信/QQ）收在托盘时，点 Dock 图标仍是「用 UIA 点**它自己的**托盘图标」：
任务栏可见 → 一路正常；任务栏被用户自己隐藏了 → 返回 `in-tray` 并提示「点右下角托盘图标即可打开」，
**不做任何系统级改动、不显示任务栏、也不强行 `ShowWindow`**。

顺带保留的两处纯改进（与本次事故无关）：`FindWindowIn` 同 rank 内优先「非 `WS_EX_TOOLWINDOW` / 非 owned」
的窗口（微信有个隐藏的 `Weixin` 工具窗，按枚举顺序会挑错）；`AnimationsRestore()` 不再无条件把
「最小化动画」写成开（先记住调用前的值）。

## 托盘应用「点不动」事故与回滚（v1.21，未发版）

**用户报障**：隐藏任务栏后点微信，必须等任务栏重新出现在屏幕上它才会从托盘里出来；
随后按上一版（直接 `ShowWindow` 隐藏窗口）改完之后又出现新症状：**微信显示出来但卡死、点不动**。

### 结论：直接显示隐藏窗口这条路是错的，已回滚

托盘最小化 ≠ 销毁窗口，句柄确实还在（实测微信收托盘时
`hwnd=526470 cls=Qt51514QWindowIcon title=[微信] vis=0`），所以上一版据此推断
「`ShowWindow(SW_SHOW)` 就等于点托盘图标」并把它设为主路径 —— **这个推断漏了一层**：

微信 4 是基于 Chromium 的（进程里有 `wechatappex`，窗口线程挂着 `Chrome_SystemMessageWindow`），
它躲进托盘时会**销毁自己的渲染表面**。从外部把窗口壳显示出来不会重建那层表面，于是：

> 窗口出现了、画面是上一帧的残影、点哪里都没有反应。

**当时的验证看错了层次**：`WM_NULL` 有回应、`IsHungAppWindow=false`、`IsWindowEnabled=true`、
`GUI flags=0` —— 消息层一切正常。**消息层活着 ≠ 界面活着**，拿这些指标判「能不能点」会得到
一个非常有说服力的错误结论（记进 CLAUDE.md 了）。

顺带否掉的另两条替代路线：

| 尝试 | 实测结果 |
|---|---|
| 再启一次 exe，指望单实例逻辑唤出主窗 | 微信**直接多开**：进程数 5→6，多出一个 `微信` 主窗（正是整套探询机制要防的事） |
| 不展开就点托盘图标 | Win11 托盘已无 `ToolbarWindow32`（实测 `Shell_TrayWnd` 下只剩 `TrayNotifyWnd` / `ReBarWindow32` / XAML bridge），溢出区图标微软官方确认「不显示出来就无法用 UIA 枚举」 |

### 改动

- `src/main/index.ts`：新增 `DIRECT_SHOW_TRAY_WINDOW = false` 开关，把「直接显示隐藏窗口」这条路
  **默认关掉**，`run-app` 的 `tray` 分支回到「UIA 点它自己的托盘图标」这条唯一可靠的路径
  （**随后这一版的实现连同整条隐藏任务栏功能一起被删除，见上一节**）。
- `CLAUDE.md`：更正上一版写错的结论（「老注释只对了一半」是错的），补上
  「消息层活着 ≠ 界面活着」这条判据，并保留两条已验证的宏观结论（Win11 无 `ToolbarWindow32`、
  UIA 无法枚举未展开的溢出区）。
- 保留两处与本次事故无关的顺带修复（都是纯改进）：`FindWindowIn` 同 rank 内优先非
  `WS_EX_TOOLWINDOW`/非 owned 窗口（微信有个隐藏的 `Weixin` 工具窗，按枚举顺序会挑错）；
  `AnimationsRestore()` 不再无条件把「最小化动画」写成开（先记住原值）。

### 那么「任务栏不出现」还有没有解？

对微信这类 Chromium 应用：**没有**。要么接受那 ~1.5s 的任务栏出现（`trayClickReveal = true`，默认），
要么一次都不碰任务栏、只提示用户自己去点（`trayClickReveal = false`）。
**唯一的例外**是原生控件类托盘应用（老式 Qt/纯 Win32）—— 理论上可以直接显示窗口，
但那需要逐个应用验证，所以不设为默认。

## 代码体检（基于 v1.20.1，未发版）

全量通读 + 三路并行审查（主进程 / 渲染进程 / PowerShell 与存储层），按「崩溃 → 逻辑 → 卡顿 → 数据安全」修了一批。
以下每一条都能在代码里定位到具体行为，标了实测数字的是本次量过的。

### 崩溃与「看起来没崩但废了」

- **`finishSink()` 在存活判定之前读了窗口几何**（`index.ts`）：沉底走一次性 PowerShell 慢路时（~700ms），
  期间窗口完全可能已被销毁（托盘退出 / 切档重建 / 渲染进程崩溃后的重建）→ `pointerOverBar()` 里的
  `win.getContentBounds()` 抛 `Object has been destroyed`。慢路里那是 `execFile` 回调，异常落进
  `uncaughtException` 只打一行日志，而**这一次「仍然有效 / 需要补偿」的判定整条被跳过**（Dock 可能卡在半吊子状态）；
  快路里则是未处理 rejection。现在存活判定提到最前。
- **三处 `webContents.send()` 只判了窗口、没判 webContents**（`index.ts` 的 `applyDockEdge` / `setDockEdge` /
  桌面监听）：渲染进程崩溃且崩溃看门狗限流放弃重建后，「窗口在、渲染没了」会一直留到重启 —— 期间改分辨率、
  桌面增删都会往废掉的 webContents 发消息并抛错。抽出 `safeSend()` 统一兜住。
- **常驻激活助手死掉后永远拉不起来**（`index.ts` 的 `ensureActivateHelper`）：`activateHelperStarting`
  是一个**已 resolve(true) 的 Promise**，`exit` / 启动抛错 / 4s 超时三条路都没复位它 → 之后
  `ensureActivateHelper()` 永远返回旧值，助手再也不会 spawn。后果：点图标退回 ~0.9s 的一次性 PowerShell，
  探询恒 `retry`（「已在运行就不多开」整条失效，微信会被开出第二个登录窗），「隐藏/显示任务栏」全部静默失败。
  三处都补了复位，超时那一路还会把没编译完的 powershell 收掉（原来它会成孤儿常驻）。
- **`AddMenu` 的条件 hooks**：`if (!menuPos) return null` 写在 `useState` / `useLayoutEffect` **之前**
  —— 菜单关着 = 0 个 hook、打开 = 2 个，违反 Hook 规则。实测 React 19 在打包版侥幸不崩、dev 每次首开都往
  main.log 抛一句 `Expected static flag was missing`；以后在早退前再加一个 hook 就会立刻变成「点 + 直接进崩溃屏」。
- **设置窗渲染期抛异常 = 一块白窗**：`main.tsx` 的 `?view=settings` 分支原来没包 `ErrorBoundary`（Dock 那侧有）。
- **设置窗构建失败不回滚 Dock**（`settingsWindow.ts`）：先 `onOpenedHook()` 藏 Dock 再建窗，`catch` 里只
  `return false` → 「Dock 没了、设置窗也没出来」，只能自己去托盘找。现在失败会调 `onClosedHook()` 把 Dock 还回来；
  另给 `did-fail-load` 加了自毁（否则窗口对象非 null 但永不显示，再点「完整设置…」只会聚焦一个空窗）。

### 逻辑 bug（用户能直接看见的）

- **调音量会顺手把 UI 的静音状态改掉**（`audio.ts`）：`invalidateVolumeCache()` 把 `volCache` 置空后，
  `.then` 里写乐观缓存时读的是 `volCache?.data.mute ?? false` —— 恒等于 `false`。于是「拖动滑块」会把静音标记
  显示成未静音，「切静音」会把音量显示成 0（系统状态其实没变）。改成在调用前先拍下旧值。
- **切换默认设备后对勾会跳回旧设备**（`audio.ts`）：`force=true` 的强刷复用了「切换**之前**发出的」
  `inflight` 请求，它拿到的默认设备是旧的；结果卡片先乐观挪对勾、一秒后又跳回去，得再刷一次才对。
  现在 `force` 不复用 inflight，并加了缓存代际（`cacheGen`）作废过期结果的写缓存资格。
- **开了「跟随系统主题」后，改任何设置都会让 Dock 跳回存储的那一档**（`App.tsx`）：`settings-changed`
  广播里带的是 settings.json 里存着的 `theme`，无条件 `setTheme(next.theme)` 会覆盖 `prefers-color-scheme`
  派生出来的值，而且那个 effect 依赖只有 `followSystemTheme`，值没变就永不重跑 → 不会自愈。
- **隐藏任务栏后点托盘型应用，提示还在让你「点右下角」**（`App.tsx`）：`handleRun` 的依赖数组漏了
  `taskbarHidden`，读到陈旧闭包。
- **`showTaskbar()` 不检查助手返回值**（`index.ts`）：`TBSET=0`（失败）也匹配那个正则、`null`（助手不可用）
  更没检查，却照样清 `taskbarHiddenByUs`、删崩溃标记、停 5s 巡检 —— 一旦恢复失败，任务栏永久隐藏且失去
  全部自愈路径（只能重启 Explorer）。现在只认 `TBSET=1`，失败保留原状让巡检继续重试。
- **沉底串行化的重试丢了 `strict`**（`index.ts`）：启动后那次沉底若命中「已有任务在跑 → 180ms 重试」，
  重试体调的是 `sendToBottom(win)`（`strict=false`）→ 收尾里「指针还在玻璃条上」判成用户抓回 Dock →
  `recoverDock()` 把刚沉下去的窗口拉回来。这正是 v1.19.4 修过的「打开应用 Dock 闪一下」症状。
- **托盘「显示窗口」少了 `markDockShown()`**（`index.ts`）：其它四条显示路径都有这一句，只有这条漏了 ——
  而 `--autostart` 那次启动会把 `dockShownAt` 显式打成 0，于是从托盘唤回后点一下别的软件，Dock 立刻被沉底。
- **失败恢复后按 Alt+Space「没反应」**（`index.ts`）：`restoreDockAfterFailedLaunch` 的 `sink` 分支与
  `finishSink` 的失败分支都只 `recoverDock()`、没清 `dockAutoSunk` → 下一次 Alt+Space 命中「唤回」分支
  （位置本来就在顶上）→ 按一下什么都不发生，要按两次。
- **任务栏隐藏时点托盘图标可能被 5s 巡检抢回去**：`run-app` 的 `tray` 分支「临时显示任务栏 → 点 → 藏回」
  全程约 1.5s，而巡检只看 `taskbarHiddenByUs` 和可见性，看到 visible 就重新隐藏 → UIA 拿到空树 → 点不中。
- **音频卡片的方向键会穿透到 Dock 导航**（`AudioCard` / `SettingsCard`）：卡片只对 `Esc`（音频卡另含 `↑↓/Enter`）
  `stopPropagation`，`←/→/Home/End` 会冒泡到 document 级 `useDockKeyboard` → 在卡片**背后**点亮选中框，
  关掉卡片后 5s 内按 Enter 会启动那个看不见的选中项。现在导航键在卡片内一律拦截（滑块仍能正常调）。

### 卡顿（都带实测）

- **`runPowerShell()` 漏了 `windowsHide`**（`ps.ts`，全项目唯一一处）：Node 默认 `false`，而本进程是 GUI
  子系统，spawn 控制台程序会新建一个控制台窗口 —— 每次调用闪一下黑框。音频枚举、盘符、桌面扫描、图标提取、
  沉底兜底全走这一个入口。
- **`list-drives` 完全没有缓存**（`index.ts`）：`openDrivesCard` 每次悬停「此电脑」都刷新一次，而一次调用要起
  一个 powershell（0.3~0.6s）。鼠标在图标上来回划几下就是好几个进程并发。补 3s TTL + 请求合并。
- **拖一次设置滑块 = 308ms 主进程同步阻塞**（`settings.ts`，实测 60 次 `writeFileAtomic`）：
  设置窗滑块是「每个 input 事件一次 set-settings」，每次都要 normalize + open→write→**fsync**→读旧文件→
  JSON.parse→copy 成 .bak→rename + 广播所有 WebContents，期间 `setShape`/托盘/音频 IPC 全部排队。
  改成 150ms 合并写盘（内存 cache 仍立即更新，`will-quit` 里强制 flush）。
- **启动第 8 秒的两个 PS 撞在一起**（`App.tsx`）：`loadAudio()` 与 `getAudioVolume()` 并发发出，各自
  冷启动 + 把 12KB 的 `AUDIO_CS` 重新编译一遍 → 一个明显的 CPU 尖峰。改成串行。
- **`App` 每次渲染两次强制同步布局**（`App.tsx`）：`overlayBottom()` / `overlayTop()` 在 render 期间无条件读
  `.dock-bg` 的 `getBoundingClientRect()`，哪怕一个浮层都没开。拖拽时 `dropIdx` 每跨一个图标就变一次，
  正好构成「布局失效 → 强制布局」的循环。现在只在真有浮层打开时才测量。
- **拖拽期间 window 监听反复重挂**（`useEdgeScroll.ts`）：`App` 传进去的 `onDropIdx` / `isDragging` 是内联箭头
  函数，每次渲染换引用 → `step` 换 → `pumpEdgeScroll` 换 → 那个 effect 每重渲染就卸载再挂 3 个 window 监听。
  回调改走 ref，`step` / `pump` 变稳定引用。
- **面板成员渲染是 O(n²)**（`App.tsx`）：每个成员都 `slice(0, index).filter(...)` 重算槽位并分配新数组。
  改成累加器（主 Dock 那侧早就是这个写法）。
- **`primeDesktopIconsHidden()` 的超时是 5s**（`index.ts`）：它在 `createWindow` **之前**被 await，
  超时多长，用户双击图标后就多久看不到任何东西（连托盘和 Alt+Space 都还没建）。降到 2s（正常 50~200ms，
  探测失败时渲染端本来就有「不翻转文案」的兜底）。
- **沉底失败会让看门狗每 500ms 起一个 powershell**（`index.ts`）：失败时 `recoverDock()` 把窗口恢复置顶，
  而下一拍 watchdog 又判定该沉底 → 死循环（每次 ~700ms CPU）。加失败退避 5s。

### 数据安全与泄漏

- **换一次图标就让 `.bak` 变成「引用了已删除文件的备份」**（`iconStore.ts` / `shortcutsStore.ts`）：
  保存流程是「写新 shortcuts.json（顺手把旧的复制成 .bak）→ 按**当前**条目清孤儿图标」，于是 `.bak` 里
  上一代的 `iconFile` 立刻变孤儿被删。之后主文件一旦损坏、走「从 .bak 恢复」，恢复出来的条目图标全部 404
  且没有补图路径。`pruneIcons()` 现在会并入 `.bak` / `.recovery` 引用的文件名。
- **清孤儿图标失败会让一次已经写成功的保存对外报 `false`**（`shortcutsStore.ts`）：`pruneIcons` 与写盘
  在同一个 try 里，它一抛（目录被删 / 权限）就返回 false，用户看到「保存失败」而磁盘其实已是新数据，还会
  多落一份没必要的 `.recovery`。现在单独 try/catch。
- **助手 stdout 的 `buf` 无界增长**（`index.ts`）：等 READY 用的那条监听器在 ready 之后仍无条件
  `buf += …`（每次响应 10~20B 永久堆积，`includes()` 还是 O(n)）。拿到 READY 立刻摘掉。
- **托盘点击脚本按 pid 复用文件名**（`index.ts`）：600ms 内点两个不同托盘型应用时，第二次覆盖同一路径，
  而第一次结束时 `rmSync` 删掉的正是第二次还没被读到的脚本 → 第二次静默失败。文件名加时间戳 + 随机后缀，
  9s 兜底定时器也纳入 `finish()` 清理。
- **日志按 UTF-16 码元数当字节数**（`logger.ts`）：本文件日志绝大多数是中文（UTF-8 下 3 字节/字），用
  `line.length` 会把大小低估 2~3 倍（main.log 实到 400~600KB 才轮转），且与初始化时的 `statSync().size`
  口径不一致。改成 `Buffer.byteLength()`。
- **托盘初始化没 try/catch**（`index.ts`）：`resolveResource` 回落到不存在的路径 → `new Tray(emptyImage)`
  抛错 → 这个 async 回调变成 unhandledRejection，**后面所有初始化整段跳过**（含 `globalShortcut.register`）→
  「有 Dock、没托盘、Alt+Space 也没反应」，且用户没有任何 UI 入口能退出。
- **看门狗定时器句柄没人持有**（`index.ts`）：退出流程会 `preventDefault()` 并最长等 800ms，这段时间里
  它仍可能再起一个 PowerShell。现在存句柄、`will-quit` 里停掉。
- 另修：`AudioCard` 的两个定时器在卸载后仍会跑（`setState` 打到已卸载组件、并白起一次 PS 读音量）；
  `App` 的起跳/撤销定时器补了卸载清理。

### 顺带修了探针的一个长期假红

`hitregion-e2e.cjs` 里 `INSET = 20` 是**写死的 60 档值**，而产品侧的内缩量随图标档位缩放
（`round(20 × iconSize / 60)`：48→16 / 60→20 / 72→24）—— 只要用户把图标调成 48 或 72 档，
`region top / bottom` 这 5 项断言必然差 4px（超出 TOL=2）而全红。已改成连接后从渲染进程读实际
`--dock-icon` 再算内缩与放大区高度，标签也按实际值打印。**本机当前是 48 档，实测 5 项假红全部转绿。**

## v1.19.9（2026-11-28）

**隐藏任务栏后不再留那 60px 空带** —— 改用「自动隐藏 + 工作区广播」，做法照 [Windhawk 的
Toggle Taskbar Visibility](https://github.com/Asteski/windhawk-mods/blob/main/mods/asteski-toggle-taskbar-visibility.wh.cpp)。

### 调研结论（别人的做法）

| 项目 | 做法 | 参考 |
|---|---|---|
| Windhawk mod（**在 explorer 内**运行） | Win11 分支注释原文：*"use auto-hide mode, which removes reserved maximize space"* | [源码](https://github.com/Asteski/windhawk-mods/blob/main/mods/asteski-toggle-taskbar-visibility.wh.cpp) |
| 同上，隐藏动作 | `ABM_SETSTATE(ABS_AUTOHIDE)` + `SetWindowPos(SWP_FRAMECHANGED)` + `SPI_SETWORKAREA(rcMonitor)` + 广播 `WM_SETTINGCHANGE` | 同上 |
| Win10 老办法 | `ShowWindow(SW_HIDE)` + `SPI_SETWORKAREA` + 广播 | [LazPlanet](https://lazplanet.gitlab.io/2014/02/show-hide-windows-taskbar-lazarus.html) |

**关键结论**：Win11 上没人做到「完全隐藏 + 全屏」——auto-hide 就是拿回空间的那个开关。
（我们自己另测的两条都无效：`SPI_SETWORKAREA` 单用会被 AppBar 覆盖，`ABM_SETPOS` 跨进程被忽略。）

### 改动

- `TbHideInstant()`：`ABS_AUTOHIDE` + `SW_HIDE` + `SetWindowPos(FRAMECHANGED)`
  + `SPI_SETWORKAREA(整屏)` + **广播 `WM_SETTINGCHANGE`**（这一拍才是让已开着的窗口立刻重读工作区的关键）
- `SetWorkAreaFor()`：恢复时用 `ABM_GETTASKBARPOS` 算回「整屏 − 任务栏」再写回去
- 实测：隐藏 → 工作区 `1380 → 1440`（铺满，空带消失）；恢复 → `1440 → 1380`

### 代价（用户已知并接受）

底边仍留 2px 感应条，鼠标贴上去任务栏会滑出来 —— 这是 auto-hide 的固有行为，
换来的正是「最大化窗口铺满全屏」。

## v1.19.8（2026-11-28）

**修「微信仍然打不开」。** 两个独立原因：

1. **任务栏被隐藏时根本没去点托盘图标**（v1.19.7 为了「不要展开任务栏」直接跳过了这一步）——
   而托盘图标是微信从托盘恢复的唯一入口，跳过就等于永远打不开。
   现在改成：**短暂把任务栏请回来 → 点 → 立刻藏回去**（实测全程 ~2.1s）。
2. **点得太早**：`TB 1` 刚返回就去遍历 UIA 树，此时托盘图标还没挂进去 → 拿到空树 → 直接失败。
   补 **250ms 落定等待**，这是关键的一拍。

顺带把托盘图标的候选名补全：除了窗口标题与 exe 名，再加 exe 版本信息里的
`FileDescription` / `ProductName`（微信 4 的托盘 UIA 名与窗口标题不一致时也能命中）。

实测（任务栏隐藏 + 微信收在托盘）：
```
15:25:05.599 任务栏已隐藏
15:25:06.119 目标在运行但窗口收在托盘里（助手）
15:25:06.130 为点托盘图标临时显示任务栏（点完立刻藏回）
15:25:08.275 托盘点击输出: 1          ← 点中了
微信窗口: 微信=1                       ← 打开了
任务栏: {"known":true,"hidden":true}   ← 又藏回去了
```

### 关于「底部空了一块」

这是「纯隐藏」的固有代价：任务栏一旦不隐藏成 auto-hide，它的 AppBar 占位就一直保留
（`SPI_SETWORKAREA` / `ABM_SETPOS` 都试过：返回 TRUE，值都不生效）。
**二选一**：要让那 60px 回来只能用 auto-hide，而 auto-hide 必然带来「贴边冒出来」。
当前默认选「贴边不冒出来」。要「工作区全屏」的话，把 `TbHideInstant` 里的
`ABS_AUTOHIDE` 那一步加回去即可（一行）。

## v1.19.7（2026-11-28）

**隐藏任务栏之后，鼠标贴到屏幕底边不再把它唤出来。**

之前用的是 Windows 的「自动隐藏」——它能把工作区还给全屏，但代价是底边留一条 2px 的感应条，
鼠标一贴上去 Explorer 就把整条任务栏滑出来（用户明确要求不要这个）。

- `TbHideInstant()` 改成**纯 `SW_HIDE`**，不再切 `ABS_AUTOHIDE`：没有 auto-hide 就没有贴边唤出
- 实测：隐藏后把光标停在底边 1.5 秒，两条任务栏始终 `vis=0`；再点「显示任务栏」正常回来
- 试过但**不成立**的两条路（记下来省得再走）：
  - 把任务栏窗口挪到屏幕外 → Explorer 会立刻把它摆回停靠位
  - 纯隐藏后再 `SPI_SETWORKAREA` 抢回工作区 → 返回 TRUE，值不生效（AppBar 仍占着那块）
- **代价（明确接受）**：工作区仍保留那 48px，最大化窗口底部会留一条空带。
  「贴边不唤出」和「工作区全屏」在 Windows 这层二选一：前者要关掉 auto-hide，后者只有 auto-hide 给得了

## v1.19.6（2026-11-28）

修 v1.19.5 的三个问题（用户实机反馈）。

### 1. 音量卡片先显示 50 再跳到真值

`useState(50)` 是写死的占位，而真值要 PowerShell 读（~0.9s）才回来 —— 那 1 秒里显示的是假数。

- 改成**模块级记住上次读到的真值**（跨卡片开关复用），本次会话一次都没读到过就显示 `—` + 禁用滑块，
  绝不显示一个编出来的数字
- App 启动 8s 的预热里顺手读一次音量（原先只预热设备列表），所以正常情况下卡片一打开就是真值

### 2. 隐藏任务栏时卡

原因：`TbSet` 里 `Thread.Sleep(260)` 等滑动动画 —— 睡的是**常驻助手**，它那条命令队列被堵住 260ms，
期间任何「点图标激活 / 沉底」都得排队。

- 拆成两步、由 TS 侧串起来：`TB <show> <state>`（切自动隐藏）→ 320ms → `TBH`（收掉窗口）
- 助手不再 sleep，随时能响应其它指令

### 3. 点已存在实例「从后台托盘打开」

日志实录（15:00:18）：微信当时**真的收在托盘里**，走的是「点托盘图标唤出」；Edge 那类是最小化，
走 `SW_RESTORE`。两者都会播 Windows 的还原动画 —— 那个动画原本是从任务栏位置飞出来，
任务栏藏起来之后就变成「从后台凭空冒出来」。

- 激活最小化窗口时**临时关掉系统动画**（`SPI_SETANIMATION`，`AnimationsOff/Restore` 包住那一次
  `SW_RESTORE`），窗口直接在原位置出现，不再从任务栏飞出来

### 4. 任务栏藏起来后，点微信不再「展开任务栏」

**根因链**：微信收在托盘 → 只能靠点它的托盘图标唤出 → 托盘图标长在任务栏上 → 任务栏被藏了 → 点不到。

实测三条边界（都试过，记下来免得再走一遍）：

1. 直接 `ShowWindow` 显示微信的隐藏主窗口 —— **无效**，它自己立刻收回（`vis` 始终 0）
2. 给 Qt 的托盘消息窗口发回调：`WM_USER+100` 的 `wParam` 当鼠标键 / 当图标 id 各试一次，
   再把 `WM_USER+0..120` × `WM_LBUTTONUP` 全扫一遍 —— **无命中**
3. 把任务栏窗口「显示到屏幕外 + 保持自动隐藏」—— UIA 依然遍历不到托盘图标
   （实测隐藏状态下 `Shell_TrayWnd` 下只剩 3 个元素）；UIA 要的是「真的在屏幕上」

所以：**任务栏隐藏时不再尝试点托盘图标，也绝不展开任务栏**（用户明确要求），
提示改成可执行的「先「＋」→ 显示任务栏，再点托盘图标」。任务栏可见时行为不变。

### 5. 隐藏任务栏要「立马隐藏，不要动画」

- `TbHideInstant()`：`AnimationsOff` → `SETSTATE(AUTOHIDE)` → `SW_HIDE` → `AnimationsRestore`，
  一次调用、一次往返，任务栏**直接消失**，没有滑出/淡出
- 之前是两步（切自动隐藏 → 320ms 后再收窗口），用户看到的正是那段滑动动画
- 菜单文案改用「我们自己的意图」优先：刚切完的一两百毫秒里 Explorer 报的矩形还是旧值，
  只信查询会让文案立刻跳回去

## v1.19.5（2026-11-28）

两个新功能：**一键隐藏/显示 Windows 任务栏**，以及把**音量**并进「音频」条目。

### 新增：任务栏一键显隐（「+」菜单，紧挨「隐藏桌面图标」）

- 点一下隐藏，再点一下恢复；菜单文案跟着状态变（隐藏任务栏 / 显示任务栏）
- **不是简单的 `ShowWindow`**：实测那样做，工作区仍然扣着任务栏那 48px（2048×1104），
  最大化窗口会在底部留一条空带；而 `SPI_SETWORKAREA` 返回成功却不生效（Explorer 的 AppBar 占着）。
  正确做法是先用 `SHAppBarMessage(ABM_SETSTATE, ABS_AUTOHIDE)` 让它把工作区还回来（→2048×1152），
  等滑动动画结束再 `ShowWindow(SW_HIDE)` 把窗口也收掉
- 主屏与副屏的 `Shell_SecondaryTrayWnd` 一起处理；**按各自显示器**的底边判断「是否已滑出屏幕」
  （副屏坐标空间不同，用 `SM_CYSCREEN` 会误判 → 看门狗会每 5s 重新触发一次动画，画面闪烁）
- 三道还原保险：退出时同步还原（`will-quit` + `execFileSync`，全项目唯一一处）→
  崩溃后靠 `taskbar-hidden.json` 在下次启动补还原 → Explorer 重启把任务栏放回来时，5s 巡检再藏一次
- 全部走常驻助手（`TB?` / `TB 0|1 <state>`），一次往返 ~20ms

### 新增：音量并入「音频」卡片

- 「音频」条目卡片顶部加了音量条：静音键 + 滑块 + 数值，作用对象是**当前默认输出设备**
- 支持静音（图标换成划掉的喇叭，用强调色淡底而不是红——淡玻璃里红太重）
- 滑块**本地乐观**：拖动时不等于 PowerShell（~0.9s 一次），松手后再回读真值；↑↓/←→ 也走同一条提交
- 走 `IAudioEndpointVolume`（`AUDIO_CS` 里新增，vtable 顺序与 native 一致）；卡片可见行数 5 → 4（让出 28px 给音量条）

### 实测

```
音量：读 2% → 设 30 → 静音 → 取消 → 还原（回读全部一致）
任务栏：hidden:false → 隐藏（work 1104→1152，两条都滑出屏幕）→ 恢复（work 回到 1104、位置复原）
```

> 说明：这台机器上「隐藏」表现为 Windows 的自动隐藏（滑出屏幕、工作区还给全屏），
> 鼠标贴底边仍会把它唤回来——这是 Explorer 的行为，不改注册表就绕不过去。

## v1.19.4（2026-11-28）

修「打开微信时 Dock 闪一下、过一会儿才退到后台」。两个独立原因叠在一起。

### 修复

- **启动后的沉底被自己撤销了**（「闪一下」的真凶）：`sendToBottom` 收尾里有一句
  「期间用户有没有重新抓住 Dock」的补偿判定，其中包含「指针停在玻璃条上 / 刚在 Dock 上动过」。
  而**点图标这个动作必然**让这两条成立 → 每次启动后的沉底 4ms 内就被 `recoverDock()` 拉回顶部，
  再等退场看门狗 2.5s 后重新沉。日志实录：
  ```
  02.033  sendToBottom(助手) seq=2
  02.074  recoverDock seq=2 top=false      ← 41ms 后自己撤销
  06.317  watchdog state=sink              ← 4.3s 后才真沉
  ```
  修法：`sendToBottom(win, strict)` —— 启动路径传 `strict = true`，只认
  「sinkSeq 变了 / 窗口被藏了」这两种真正的反悔信号，不再看指针与活动。
- **沉底走常驻助手**（「过一会儿」的真凶）：原来每次沉底都起一个 powershell（~700ms），
  新窗口早弹出来了、Dock 还挂在上面。现在给助手加了 `SINK <hwnd>` 指令
  （`QLActivate.Sink`，一次管道往返实测 ~20ms），助手不可用时才退回一次性 PowerShell。
  实测：点图标 → 40ms 内 `exstyle` 从 `0x200008`（置顶）变 `0x200000`，且**保持**不再回弹。

### 已知取舍

`state = tray`（窗口真收进托盘）这条路径仍要 ~1.9s：它走的是 UI Automation 点托盘图标，
是 UIA 的固有开销；而且 UIA 失败时 Dock 会保持可见 2.5s（让你看见「请点托盘图标」的提示），
之后由退场看门狗收走。

## v1.19.3（2026-11-28）

点开应用后 Dock 的默认去向改成「退到后台」，并修掉 `sink` 模式其实没生效的老 bug。

### 变更

- **`afterLaunch` 默认从「隐藏到托盘」改为「让位沉底」**：点开应用后 Dock **仍然可见**，
  只是退到所有窗口后面；想再用它，Alt+Space / 托盘一下就回来（不用去托盘里找）
- 设置 → 行为 的三项顺序调整为 `让位沉底 / 隐藏到托盘 / 保持显示`（默认排第一个）
- 三条启动路径统一走这个三态：`run-app`（含「激活已运行实例」）、`run-as-admin`、`open-sound-settings`

### 修复

- 🚫 **`sink` 模式只调了 `sendToBottom()`，没先清置顶位**：`SetWindowPos(HWND_BOTTOM)` 对
  **置顶窗口**只是把它沉到「置顶层内部的最底」，照样盖在所有普通窗口上面 —— 所以「让位沉底」
  看起来毫无效果（用户报障：「点了应用 Dock 还挡着，不会退到后台」）。
  现在与 blur / 退场看门狗两条让位路径一致：**先 `setAlwaysOnTop(false)` 再沉底**
- 沉底后置 `dockAutoSunk`：Alt+Space / 托盘那一下是**唤回**而不是「隐藏到托盘」

### 实测

点前 `exstyle=0x200008`（`WS_EX_TOPMOST`）→ 启动记事本 → 点后 `exstyle=0x200000` 且窗口**仍可见**，
即「退到后台但没消失」。

## v1.19.2（2026-11-28）

修「已经登录的微信，点图标又弹一个登录窗；Edge 也开不出已有窗口」——点图标对单实例应用
多开了进程。根因是「先探测再启动」被整段关掉了（v1.13.8 起 `PROBE_BEFORE_LAUNCH = false`）。

### 修复

- **重新打开四态探询**（`PROBE_BEFORE_LAUNCH = true`）：
  `running` → 激活已有窗口（**不新开进程**）；`tray` → 用 UI Automation 点托盘图标唤出；
  `absent` → 启动；`failed` → fail-open 照旧启动
- **常驻激活助手**（「秒开」的关键）：应用启动 5s 后预热一个 PowerShell 进程，
  `ACTIVATE_CS` 只在这里编译一次，之后每点一次图标只走一次 stdin/stdout 往返
  - 实测冷启动成本：`powershell` 最小启动 **604ms**、加 `Add-Type` **869ms**（原来每次都付）
  - 助手预热后：**8~30ms**；助手空闲 10 分钟自退，父进程消失时随 stdin EOF 退出
  - 顺带否掉了一条看似更快的路：`cscript` 的 `AppActivate` 只要 44ms，但它内部就是
    `SetForegroundWindow`，窗口不是前台时被前台锁直接拒（实测微信退化成 3s），
    且不认最小化/托盘 —— 所以没采用
- **`tasklist` 快路只在助手没预热时用**：助手预热后连「没在运行」也只要 ~20ms，
  比 `tasklist` 的 ~70ms 还快
- **探询改异步**：原来 `execFileSync` 在主进程里同步等约 0.9s（最坏 3 次重试 ≈ 3.5s），
  期间 Dock 整个假死（悬停放大、动画全停）；现在全链路 `await`
- **窗口挑选按可见度打分**（正常 3 / 最小化 2 / 隐藏 1）：原来取枚举到的**第一个**有标题窗口，
  而微信 4.x 这类应用会造一堆**带标题的隐藏辅助窗口**，明明开着主窗口却被判成「收在托盘」，
  只弹一句「请点托盘图标」

### 实测

| 目标 | 结果 | 耗时 | 进程数 |
|---|---|---|---|
| 微信（已登录、窗口可见） | `true`（激活） | **9ms** | 5 → **5** |
| Edge（已开着） | `true`（激活） | **17ms** | 26 → **26** |
| 记事本（没在运行） | `true`（启动） | **~50ms** | 0 → 1 |
| 微信（收在托盘） | 走 UIA 点托盘图标 | ~1.9s（UIA 固有开销） | 5 → **5** |

## v1.19.1（2026-11-28）

修「点了别的软件，Dock 还盖在上面不退」——Dock 悬浮在屏幕中间时压住视频/编辑器的那个。
根因是**焦点信号在这扇窗上根本不可用**，不是阈值调得不对。

### 修复

- **退场改由看门狗判定**：每 500ms 一拍，只要「可见 + 没收托盘 + 光标不在玻璃条上 +
  没有浮层 + 用户 2.5s 没在 Dock 上动过」就沉底一次（沉完 `isAlwaysOnTop()` 变 false，
  下一拍跳过，不会反复起 PowerShell）
- **删掉悬停时的 `focus()`**：`dock-pointer` 里那声 `mainWindow.focus()` 会被前台锁拒绝激活、
  却仍把键盘焦点拿到本线程 —— 于是 `win.isFocused()` / `document.hasFocus()` **永久卡在 true**，
  Windows 之后再不发 `WM_KILLFOCUS`，`blur` 永不触发（实机日志里整段会话 `sendToBottom` 一次都没有）。
  纯悬停本来也不该抢焦点；真实点击图标时系统会自己给
- **沉底的迟到补偿不再看 `isFocused()`**：改看「指针是否回到玻璃条 / 浮层是否打开 /
  刚有没有在 Dock 上动过」。原来那行 `!win.isFocused()` 在焦点卡死时会判成「已被拉回」，
  于是每次沉底都被紧跟着的 `recoverDock()` 撤销 —— 表现是「沉一下又弹回来」，
  并且每 500ms 白起一个 PowerShell
- **`verifyDockOnTop()` 巡检给沉底让路**：新增 `lastSinkAt`，沉底后 3s 内不再断言置顶
  （巡检 250ms 一次、比沉底的 ~700ms PowerShell 快，晚到一拍就会把窗口拉回顶部）
- **指针是否停在 Dock 上**改由主进程直接量（`screen.getCursorScreenPoint()` +
  `getContentBounds()` + renderer 上报的玻璃条矩形）；renderer 只上报「动过」的心跳，
  不再依赖 enter/leave 事件（实测会被莫名的 mouseleave 提前清掉）
- **Alt+Space / 托盘「唤回」语义**：被看门狗压到底之后按一次是**拉回前台**，不是隐藏到托盘
  （原来窗口明明看不见，还要按两次）

### 排查笔记（别再走一遍）

- `powerMonitor.getSystemIdleTime()` 在本机恒返回 0（实测系统已空闲 3s），不能用来判「有没有人在操作」
- 从外部 `SetForegroundWindow` 会被前台锁拒绝；「合成 Alt 键再调」在探针进程里能成功，
  但在 Electron spawn 出来的 PowerShell 里仍然被拒，**不要指望靠抢前台来修 blur**
- 判定「用户在用 Dock」不能用 `blur`、不能用 `isFocused()`、不能用系统空闲时间，
  就只剩「光标坐标 + 交互心跳」两件事是可信的

## v1.19.0（2026-11-21）

观感与入口的一版：先修手感与配色，再把「音频」「设置」做成 Dock 上的系统条目。
（v1.18 的「手感版」没有单独发版，一并记在这里。）

### 新增：音频设备切换（Dock 条目 + 双栏卡片）

- Dock 新增「音频」系统条目，顺序 `此电脑 → 音频 → 设置 → 回收站`；图标随**当前默认输出设备**的形态变
  （耳机 / 扬声器 / HDMI）
- 点开是 460×202 双栏卡片：左输出、右输入，点一行即设为系统默认（三个角色一起设：系统 / 多媒体 / 通话）
- **乐观更新**：点完对勾立刻挪过去 + 该行 spinner，PowerShell 返回后强刷校正；失败（设备刚被拔掉）弹提示并刷新
- 技术：Core Audio COM（`IMMDeviceEnumerator` + `IPolicyConfigVista`），C# 内嵌在 `ps.ts` 的 `AUDIO_CS`
  - ⚠️ 本机只注册了 `{294935CE-…}`（AudioSes.dll），常见写法里的 `{870AF99C-…}` 不存在 → 代码里两个都试
  - ⚠️ `EnumAudioEndpoints` 是 `IMMDeviceEnumerator` 的第 1 个槽位，顺序写错抛的是 NRE 而不是 HRESULT
  - 主进程 3s 缓存 + 请求合并，渲染端启动 8s 预热；单次调用约 0.9s

### 新增：快捷设置（Dock 上的「设置」条目）

- Dock 新增「设置」系统条目（滑杆图标），点开是 460×202 卡片：
  材质 / 图标大小 / 悬停放大 / 停靠位置 / 跟随系统 / 开机自启
- 改完立刻生效（走 `patchSettings` 乐观更新），页脚「完整设置…」进原来那扇 480×308 窗口
- 「+」菜单里的「设置…」撤掉：设置入口只剩 Dock 这一个，菜单回到「只放动作」

### 视觉：手感版 + 一套 surface token

- **图标去衬底**：`--icon-wrap-bg` 默认透明，只在悬停浮出一层薄底 + 内描边（原来常驻渐变底 + 内描边 + 镜面 + 辉光）
- **几何随尺寸派生**：间距 / 标签字号 / 图标占比（73.3%）/ 分组拼图 / 徽标 / 面板内边距 / 提示条位置全部按
  `--dock-icon` 算；顺带修掉 48 档分组拼图溢出、72 档提示条压进玻璃条
- **启动反馈**：点图标播 380ms 起跳、失败抖 260ms；主进程把隐藏推迟 300ms，并新增 `clearLaunchHide()` 覆盖所有唤回路径
- **统一材质**：新增 `--sf-*` surface token，菜单 / 右键菜单 / 三张卡片 / 分组面板 / 撤销条 / 设置窗共用；
  暗色从 0.9 实心降到 0.62 亮灰蓝 + blur，描边与投影各减一档；设置窗选中态改 tonal（淡蓝底 + 亮蓝字）

### 修复

- `AUDIO_CS` 缺 `[Console]::OutputEncoding = UTF8`：Electron 主进程 spawn 的 PowerShell 没有控制台，
  默认按 OEM 936 输出，设备名里的中文全变成 `����`（同一段脚本在带 UTF-8 控制台的终端里是正常的，所以开发机上没暴露）
- `applyZoom()` 去重 key 只看 `scale`：切 bottom↔top 时上浮方向翻转但 transform 不重写
- 卡片/撤销条/菜单各自抄色值导致的「三种灰」，改为共用 `--sf-*`

## v1.17.0（2026-11-07）

设置中心独立成形的一版：Dock 侧的逻辑一条没改，但「配置」全部搬出 300px 的 Dock，
顺带补掉了一整批性能、稳定性与工程化欠账。

### 新增：设置中心（独立窗口 480×308）

- **透明毛玻璃独立窗**：`frame: false` + 自绘标题栏 + `transparent: true`，与 Dock 同材质
  （黑夜 / 白天 / 透明三档数值全抄 Dock，圆角同为 24px），Esc 关窗、单例、开窗即让位
- **左栏五类**：通用 / 外观 / 行为 / 数据 / 关于 —— 停靠位置、图标尺寸（48/60/72）、悬停放大、
  玻璃强度、点击后行为、两个延迟、开机自启、桌面图标、数据目录、诊断包、版本与更新检查
- **打开设置 Dock 自动隐藏、关闭自动恢复**（用户明确要求；只在自己藏过 Dock 时才恢复，不抢用户的手动收起）
- **「+」菜单瘦身**：只剩动作（快捷方式 / 文件夹 / 桌面图标 / 自启 / 设置… / 检查更新 / 日志 / 诊断包 / 版本）
- `settings.json` 为唯一真相源，主进程广播 `settings-changed`；旧的 `localStorage.ql-theme` 一次性迁移

### 性能

- **图标外置**：`icons/` + `ql-icon://` 自定义协议，`shortcuts.json` 不再内嵌 base64（60 个图标约省 1MB，每次保存不再整份重写大字符串）
- **文件夹卡片局部渲染**：`FolderCard` 拆成 memo 组件 + `useSyncExternalStore` 图标订阅，图标分批推送不再让整个 App 重渲染
- **悬停放大改几何缓存**：`offsetLeft/offsetWidth` 二分定位，60 个图标时单帧最多触及 6 个
- **启动不再抢跑 PowerShell 列盘符**：延迟 4s，首帧更快

### 稳定性

- **崩溃看门狗**：`render-process-gone` 60s 内最多重建 3 次，超限托盘气泡告知
- **落盘日志**：`{userData}/logs/main.log`（200KB × 3 轮转）+ renderer 错误上报 + 一键导出诊断包
- **退出保存握手**：`before-quit` 等 renderer 确认写盘（最多 800ms），不再固定 sleep
- **保存失败可观测**：写盘失败降级到 `.recovery` 并提示；`shortcuts.json` 损坏时保留现场并从 `.bak` 恢复
- **CSP**（`default-src 'self'` + `img-src 'self' data: ql-icon:`）与 ErrorBoundary 崩溃界面

### 交互

- 拖文件到图标上 = 用该程序打开；删除可 5s 内撤销（分组会连带恢复成员）
- 键盘导航补齐 Home / End / Tab / Delete / 右键菜单键 + 首字母 type-ahead
- 边缘滚动改成幂函数曲线，Shift + 滚轮快滚；拖拽视觉（缩放 + 圆头落点线）
- 图标归一化到 64×64 透明包围盒，尺寸不一的图标不再大小错落

### 工程化

- `src/shared/types.ts` 成为三进程唯一类型真相源；主进程按职责拆出 7 个模块
- 自建 lint（`devtools/lint.mjs`，6 条项目专属规则：C# 纯 ASCII、禁止 renderer 碰 Node、IPC 必须被 preload 暴露…）
- 单测（`node --test` 直跑 .ts）+ `npm run verify`（lint → typecheck → test → build → 命中区探针）
- 119 个一次性探针归档到 `devtools/archive/`，只留 13 个长期回归；新增 `probe:settings` 验证 Dock 让位
- 仓库瘦身：删掉 137MB 的 Electron 离线包，`electronDist` 指向 `node_modules/electron/dist`

---

## 技术栈

| 技术 | 版本 |
|---|---|
| React | 19.2.7 |
| TypeScript | 7.0.2 |
| Electron | 43.1.0 |
| Vite | 7.3.6 |
| electron-vite | 5.0.0 |
| electron-builder | 26.15.3 |

---

## 已实现功能

### 毛玻璃 Dock 栏
- **透明常驻窗口**：`transparent` + `frame: false` + `alwaysOnTop` + `skipTaskbar`，悬浮桌面、不在任务栏显示
- **停靠位置三档**：「+」菜单分段控件切换 **中间 / 下 / 上**（默认中间＝悬浮屏幕中央）；切换是主进程原地 `setBounds` + 事件翻布局（约 60ms，不重建窗口、不重载页面、无白闪）；窗口不支持自由拖拽，位置只由预设决定（避免移动窗口时的布局跳动）
- **点击自动沉底**：点击其他软件时自动让出置顶沉到最底，不遮挡正在使用的程序（鼠标移出 Dock / 在软件中滚动不沉底）；鼠标移回 Dock 或 Alt+Space 唤回置顶
- **独立背景层**：毛玻璃背景（`blur(32px) saturate(1.6)`）是独立层 `.dock-bg`，只覆盖图标区，图标垂直居中、上下间距紧凑
- **悬停放大**：鼠标靠近图标平滑放大 + 上浮（最大 1.4×），放大图标从背景顶部透明区顶出，类似 macOS Dock
- **水平滚动**：图标超过宽度时滚动容器横向滚动，滚轮/触控板查看，两端渐隐提示「还有更多」
- **拖拽排序**：按住图标拖到目标位置，蓝色指示线实时显示插入点
- **右键删除**：自定义右键菜单（编辑 / 打开文件位置 / 以管理员身份运行 / 复制路径 / 新建分组 / 插入分隔线 / 删除）
- **文件夹悬停预览（v1.10.0）**：悬停文件夹条目 300ms 弹出预览卡片，列出目录内容（目录优先、自然序、最多 400 项）+ 文件大小 + 「打开」按钮；图标走 `app.getFileIcon`（无 PowerShell），首批内联、其余分批推送就地替换

### 桌面图标显隐
- 「+」菜单内置**隐藏/显示桌面图标**开关
- 通过向桌面 `SHELLDLL_DefView` 发送 `WM_COMMAND 0x7402` 切换——与 Windows「右键桌面 → 查看 → 显示桌面图标」底层一致，不依赖 `SHChangeNotify`（后者在部分 Win11 上不刷新桌面）
- 切换后 Explorer 自动同步注册表 `HideIcons`，状态持久化；状态读取**优先读注册表 `HideIcons`**（Explorer 每次切换都会同步，实测最可靠），拿不到才回退 `IsWindowVisible(ListView)`，两路都拿不到就报「未知」而不是编一个「可见」（见更新日志 ㉟）
- 菜单文案由主进程缓存驱动（`sendSync` 取首帧真值），切换后同步写回缓存 —— 文案与系统真值始终一致

### 添加快捷方式
- 支持 `.lnk`（Windows 快捷方式）、`.url`（网页快捷方式）、`.pif` 文件
- 文件对话框默认过滤所有快捷方式类型，也可选择任意文件
- 通过 PowerShell + `WScript.Shell` COM 解析快捷方式属性
- **文件夹**：添加文件夹到 Dock，提取系统黄色文件夹图标，点击在资源管理器中打开
- **系统位置**：一键添加「此电脑」「回收站」，图标从注册表解析 CLSID，带 `shell32.dll` 硬编码回退

### 高清图标提取
- 使用 Win32 `SHDefExtractIcon` API 请求 **256×256** 原生尺寸图标
- `.lnk` → 从目标 exe 提取（优先使用 `IconLocation` 指定的文件和索引）
- `.url` → 读取 `.url` 文件内的 `IconFile` 条目：
  - 远程 favicon URL → 自动下载转 base64
  - 本地图标文件 → `SHDefExtractIcon` 提取
  - 未指定 → 兜底默认浏览器图标（路径：系统 HTTP 协议关联 → `shell32.dll` globe 图标）

### 软件名称提取
- 优先级：`exe 的 FileDescription`（版本信息）→ `.lnk` 的 Description → 文件名（去扩展名）
- `.url` 文件优先用快捷方式文件名

### 启动容错
- **置顶让位**：启动目标前 Dock 临时让出置顶（`setAlwaysOnTop(false)`），新程序窗口浮到 Dock 之上不被遮挡；窗口获得焦点时恢复
- **EACCES/EPERM 回退**：直接 spawn 被拒（程序需管理员权限或杀软拦截）时回退 `shell.openPath()`——与资源管理器双击一致，自动弹 UAC 提权
- **URL / 系统位置**：URL 用 `shell.openExternal`，`shell:` CLSID 用 `explorer` 打开

### 分组 / 分隔线 / 键盘导航（v1.9.0）
- **分组堆叠**：图标右键「新建分组」；拖图标到分组图标上归组、从面板拖回 Dock 移出；分组图标显示组内前 4 个成员缩略拼图 + 数量徽标；点开是主 Dock 同构的迷你面板（宽度随内容、超出才滚动，高度固定）
- **分隔线**：图标右键「在此之前插入分隔线」，可拖拽调位置；不启动、不参与扫描与键盘导航
- **键盘导航**：`Alt+Space` 唤出即选中（记住上次位置）；`←/→` 移动、`Enter` 启动、`Esc` 退出；分组上 `→` 进面板、`←` 返回；方向键随时可唤醒选中框
- **拖入即添加**：从资源管理器拖快捷方式/exe 到 Dock 栏即入 Dock（按落点插入、重复跳过并提示）

### 持久化 + 系统托盘
- **自动保存**：所有图标实时保存到 `userData/shortcuts.json`，重启自动恢复
- **系统托盘**：关闭窗口最小化到托盘，左键单击托盘图标切换显隐，右键菜单「显示窗口」/「退出」
- **全局快捷键**：`Alt+Space` 置顶时按=隐藏到托盘，沉底或已隐藏时按=唤回置顶（注册失败自动回退 `Ctrl+Alt+Space`）

### 编码适配
- PowerShell 输出强制 UTF-8（`[Console]::OutputEncoding`）
- 解决中文 Windows GBK 编码导致描述乱码的问题

---

## IPC 接口

| Channel | 方向 | 说明 |
|---|---|---|
| `parse-lnk` | Renderer → Main | 解析快捷方式文件，返回 `LnkInfo`，不传路径则弹出系统文件对话框（支持多选） |
| `select-folder` | Renderer → Main | 选择文件夹（支持多选），返回路径/名称/系统文件夹图标 (shell32.dll index 4) |
| `scan-desktop-folders` | Renderer → Main | 扫描桌面文件夹与指向文件夹的 .lnk，并固定附加「此电脑」「回收站」；单次 PowerShell 完成枚举 + 图标提取 |
| `check-folders-missing` | Renderer → Main | 返回传入路径中已不存在的子集（主进程纯 `fs.existsSync`），用于清理被删除的桌面文件夹 |
| `desktop-changed` | Main → Renderer | 桌面目录 `fs.watch`（非递归 + debounce 1s）变化推送，renderer 重新执行清理 + 扫描合并 |
| `describe-paths` | Renderer → Main | 拖放添加：解析拖入的路径数组，返回 `{ accepted, rejected }` |
| `nav-enter` | Main → Renderer | Alt+Space 唤出 Dock 时推送，renderer 进入键盘导航模式并恢复上次选中位置 |
| `run-app` | Renderer → Main | 启动目标程序（exe/URL/`shell:` 位置），或通过 `shell.openPath` 打开文件夹 |
| `load-shortcuts` | Renderer → Main | 从 `userData/shortcuts.json` 加载已保存的快捷方式（含形状归一化与旧字段迁移） |
| `save-shortcuts` | Renderer → Main | 保存快捷方式数据到 `userData/shortcuts.json` |
| `get-desktop-icons-hidden` | Renderer → Main | 读取桌面图标当前是否隐藏（**主进程缓存**，启动时用注册表 `HideIcons` 预热、拿不到才回退 ListView 可见性；读不到返回 `null` = 未知） |
| `toggle-desktop-icons` | Renderer → Main | 切换桌面图标显隐，返回切换后状态 |
| `get-auto-start` / `set-auto-start` | Renderer → Main | 读取 / 切换开机自启动（注册表 Run 登录项） |
| `pick-icon` | Renderer → Main | 更换条目图标：选 exe/dll/ico（`SHDefExtractIcon`）或 png/jpg（直读转 dataURL） |
| `run-as-admin` | Renderer → Main | 以管理员身份运行（`Start-Process -Verb RunAs` → UAC 提权） |
| `open-file-location` | Renderer → Main | 在资源管理器中定位目标（`explorer /select`） |
| `copy-text` | Renderer → Main | 复制文本到剪贴板（「复制路径」用） |
| `dock-pointer` | Renderer → Main | 通知主进程鼠标进入 Dock 窗口恢复置顶（`ipcRenderer.send`，单向） |
| `get-dock-edge` / `set-dock-edge` | Renderer → Main | 读取 / 切换 Dock 停靠位置（`middle` / `bottom` / `top`；横向三档原地换坐标并持久化，未实现档位归一化回默认） |
| `dock-edge-changed` | Main → Renderer | 停靠位置变更推送（含「改显示器参数后重新归位」），renderer 据此翻布局 |
| `list-folder` | Renderer → Main | 文件夹预览卡片：`fs.readdir` 枚举（目录优先 + 自然序 + 400 项上限）+ 首批 14 个 `getFileIcon` 图标，其余后台分批推送；5s 缓存 + 在途请求去重 |
| `folder-icons` | Main → Renderer | 后台补齐的预览图标分批推送（按路径就地替换，避免卡片长时间停在占位块） |
| `open-path` | Renderer → Main | 用 `ShellExecuteEx`（`shell.openPath`）打开任意路径——目录开资源管理器、文档/图片交给关联程序；与点 Dock 图标一致，**成功后才**隐藏 Dock |

### LnkInfo 结构

```typescript
interface LnkInfo {
  targetPath: string      // 目标路径或 URL
  arguments: string       // 启动参数
  workingDirectory: string // 工作目录
  windowStyle: number     // 窗口样式 (1=正常 3=最大化 7=最小化)
  hotkey: string          // 快捷键
  iconLocation: string    // 图标位置 (path,index)
  description: string     // 显示名称
  iconDataUrl: string     // PNG base64 data URL
  // isUrl: boolean        // PowerShell 层判定字段，preload 类型已丢弃
}
```

---

## 项目结构

```
QuickLaunch/
├── resources/
│   ├── icon.ico                  # 应用图标 (16-256px 多尺寸)
│   └── tray-icon.png             # 托盘图标 (16×16)
├── src/
│   ├── main/
│   │   └── index.ts              # Electron 主进程（IPC、窗口、托盘、快捷键、PowerShell）
│   ├── preload/
│   │   └── index.ts              # 预加载脚本（contextBridge API + 类型定义）
│   └── renderer/
│       ├── index.html            # HTML 入口
│       └── src/
│           ├── main.tsx          # React 入口
│           ├── App.tsx           # 根组件（Dock 栏 + 拖拽排序 + 放大 + 水平滚动）
│           ├── App.css           # 样式（毛玻璃 Dock + 动画）
│           └── env.d.ts          # TypeScript 全局类型声明
├── electron-vite.config.ts       # electron-vite 配置
├── tsconfig.json                 # TypeScript 总配置
├── tsconfig.node.json            # TS 配置 (主进程/预加载)
├── tsconfig.web.json             # TS 配置 (渲染进程)
├── electron-builder.yml          # 打包配置（含图标 + extraResources）
├── CHANGELOG.md                  # 版本更新日志
└── package.json
```

---

## 可用命令

```bash
npm run dev        # 启动开发模式（Vite HMR + Electron 热重载）
npm run build      # 生产构建
npm run typecheck  # TypeScript 类型检查
npm run preview    # 预览生产构建
npm run package    # 构建并打包为可执行安装包
```

---

## 更新日志

### v1.15.1 (2026-10-18) —— 子 Dock 拖拽排序 + 文件夹预览点击

**1) 子 Dock 组内拖拽排序**
- 面板成员复用主 Dock 的拖拽状态机；新增 `panelDropIdx` 与 `calcPanelDropIndex()`，在面板内容坐标里计算落点，支持组内成员拖动重排。
- 面板成员在 Dock 玻璃条上松手才算「移出分组」；在面板内松手走组内重排，不再被旧逻辑当成无效落点。
- 插入指示线按「可显示成员」下标渲染，分隔线不占槽位；重排结果随 `shortcuts.json` 持久化。

**2) 文件夹预览卡片点击**
- 全局 `mousedown` 关闭面板时放行卡片内部节点（`folderCardRef.contains`），避免按下瞬间收面板。
- 面板自动收起定时器检测到预览卡片仍打开时保持面板，防止卡片在 `mousedown` 与 `mouseup` 之间横移，导致 `click` 落到 `.app` 上。
- 卡片内文件/文件夹现在会正常调用 `open-path`，失败时提示。

**3) 回归与版本**
- `devtools/probe/regression.cjs` 扩到 **31 项，31/31 通过**（新增子 Dock 拖拽顺序/持久化/指示线与卡片点击断言）。
- `npm run typecheck`、`npm run build` 通过；安装包 `dist/QuickLaunch Setup 1.15.1.exe`。
- 版本号 `1.15.0 → 1.15.1`（`package.json` + `package-lock.json`）。

### v1.15.0 (2026-10-17) —— 今日改动审查：持久化/分组/透明主题收口

**1) 持久化与异常路径**
- `writeFileAtomic` 先写 tmp 再 rename，保留 `.bak`；加载时 JSON 解析失败先回退 `.bak`，备份也坏则把损坏文件另存为 `.corrupt-*`，不再让一次坏写清空全部快捷方式。
- `sanitizeShortcutEntries` 逐条校验 id/targetPath/类型并去重；`load-shortcuts` 返回 `corrupt`/`recovered` 状态，renderer 据此提示，保存失败（false）不再静默。
- `run-app` 补齐本地文档（走 `shell.openPath`，失败不隐藏 Dock）、URL（`await shell.openExternal`）与 `steam://` 分支；`spawn` 的 `error` 事件如实返回，避免“点了没反应”。

**2) 文件夹分组语义**
- 文件夹可像图标一样拖入分组，归组时只删除 `specialType`、保留 `isFolder`；分组展开后仍按文件夹渲染（黄色文件夹图标、悬停预览、点击打开目录），不再退化成普通启动项。
- 删除分组只删除分组条目，组内文件夹回到顶层，不会删除真实目录。

**3) 分组子 Dock**
- 面板中心对齐分组图标（`panelLeft` 按图标中心与面板实测宽度计算并钳制在窗口内），左右内边距 16px，空分组也有居中的空态药丸。
- 修复分组内文件夹/盘符预览卡片被 `openGroup` 条件隐藏的问题；卡片按面板左右侧锚定、限高并钳制，避免向上顶出窗口被裁。
- 指针离开面板/图标 180ms 宽限后自动收起；拖拽中不收起；`Esc` 关闭面板并把选择移回分组图标；`Enter` 在分组上展开面板。

**4) 透明主题与字号**
- 透明主题下分组子 Dock 恢复全透明（不再叠深色底），深色药丸只留给成员标签；仅文件夹/盘符预览卡片保留文字底衬，空分组用深色药丸保证可读。
- 透明主题下拉菜单/右键菜单保持全透明 + 近黑字 + 白描边；统一菜单字号/字重，修复“两种字体”观感；Windows 字体栈显式加入微软雅黑 UI。

**5) 分组缩略图**
- 改为严格 2×2 网格：容器 46×46、四边 7px，三张 22px 缩略图固定在左上/右上/左下，右下 22px 徽标；2px 间隙，不再用旧阶梯偏移。
- 单成员仍用 36px 居中大图；徽标仅在成员数 >1 时显示。

**6) 回归**
- `devtools/probe/regression.cjs` **26/26** 通过（新增/更新分组缩略图 2×2 对齐与徽标重叠、面板卡片可见/侧边锚定、面板水平居中等断言）。
- `npm run typecheck`、`npm run build` 通过；安装包 `dist/QuickLaunch Setup 1.15.0.exe`。

**7) 版本号 `1.14.0 → 1.15.0`**（`package.json` + `package-lock.json`）。

### v1.14.0 (2026-09-26) —— 全量代码审查 + 启动逻辑回退到 v1.13.4

**1) 点图标回归「直接启动」（用户要求）**
`PROBE_BEFORE_LAUNCH = false`：v1.13.5 引入的四态探询被这个常量短路，打包时被**整段静态消除**
（产物里 `ACTIVATE_CS`/`probeTargetState`/`clickTrayIconFor` 命中数均为 0）。详见下方 ㊳。

**2) 全量审查（主进程 / 渲染端 / 构建打包三路并行）后修掉的真实 bug**

| 级别 | 问题 | 修法 |
|---|---|---|
| 🔴 | `env.d.ts` 与 preload 的 `runApp` 类型还留着已删除的 `'probe-failed'` | 类型同步为 `true \| false \| 'in-tray'` |
| 🔴 | `toggleDesktopIcons` 声明 `Promise<boolean>`，主进程读不到时却 `resolve(null)` —— 类型把「状态未知」抹掉了，而 `null` 走假值正是 v1.13.7/1.13.8 两次「文案卡死」的成因 | preload + `env.d.ts` 统一 `Promise<boolean \| null>` |
| 🔴 | **几何缓存失效条件漏了「条目顺序」**：依赖是 `[apps.length, ...]`，而拖拽重排是**纯置换**（长度不变、图标宽都是 60px、中心点数组一模一样），封顶时 `.dock-inner` 盒宽也不变、ResizeObserver 不回调 → 缓存里 `el↔cx` 失配，表现为「鼠标划过后面的图标、放大的却是前面的图标」 | 依赖改为条目签名 `apps.map(a => a.id).join(',')` |
| 🔴 | **分组面板里手抖拖 6px 会把成员踢出分组**：「从面板拖出」的命中区用 `.dock` 的 rect（占满整窗，y 覆盖窗口下沿 174px），而面板图标行与玻璃条**纵向重叠** → 面板内小幅拖动也判成「落在 Dock 上」 | 命中区改为「玻璃条内 **且** 光标不在面板矩形内」 |
| 🔴 | **「+」按钮永远关不掉自己打开的菜单**：document 的 mousedown 先把 `menuPos` 置 null（按钮不在 `menuRef` 内），React 在 mousedown 与 click 之间提交这次更新 → click 时闭包读到 null → 又开一次（菜单只闪一下） | mousedown 处理器里放行 `addBtnRef`，开关交给 `handleAddToggle` |
| 🔴 | **空列表时键盘导航彻底不可用**：`resumeNavId` 返回 null → 唤醒分支直接 return，连「+」都够不到（`ADD_BTN_ID` 只在 `→` 走到最右时才设置） | 回落到 `ADD_BTN_ID` |
| 🔴 | **孤儿分组成员永久不可见、不可删**：`groupId` 指向不存在的分组 → 既不在顶层渲染、也不在任何面板里，而每次保存都把它写回磁盘（与历史「哨兵→空串」同类的自锁坏数据） | 加载时归一化：这类成员降级为顶层条目 |
| 🟡 | `showOpenDialogSafe` 的 `disabled: true` 是**空操作**（`OpenDialogOptions` 无此字段；靠对象展开骗过了 TS 的多余属性检查），注释还在说它是模态的来源 | 删掉该键，注释改为「模态由 parent 参数提供」 |
| 🟡 | `desktopPath()` 硬编码 `D:\Desktop`，而它决定**扫描哪个目录 + fs.watch 盯哪个目录 + 三个对话框默认位置** | 改为以 `app.getPath('desktop')` 为唯一真相源（桌面重定向时它本就返回该路径） |
| 🟡 | `run-as-admin` 无论成败都 `return true`，UAC 被取消时用户只见「Dock 消失又回来」；`open-path`/`openFileLocation`/`copyText` 的失败也全静默 | 返回真实结果 + renderer 逐条补提示 |
| 🟡 | `extractIcon` 把**整段 stdout** 当 base64（v1.13.8 那类「多漏一行就静默坏」的坑） | 取最后一行 |
| 🟡 | 拖入多个快捷方式时**串行** await（每个 ~900ms，20 个 = IPC 挂 ~18s，界面像卡死） | 限并发 4 并行（结果按下标写回，顺序不变） |
| 🟡 | `probeTargetState` 里有 520ms **同步忙等**（开关一旦打开，最坏 3×(0.9s+0.26s)≈3.5s 主进程假死 —— 本项目「execFileSync 卡死 Dock」同族） | 改为 `await`（函数转 async） |
| 🟡 | `toggleWindow` 只判 `!mainWindow`、漏 `isDestroyed()`（全文件唯一漏点，退出序列里会抛） | 补上 |
| 🟡 | 主进程只有 `setWindowOpenHandler`，**没有 `will-navigate`** 兜底（拖文件导航到 `file://` 白屏只靠 renderer 的 preventDefault） | 补 `will-navigate` 拒绝一切非 dev-server 导航 |
| ⚪ | `SINK_GRACE_MS(2500)` 与 `verifyDockOnTop` 巡检链（5×250=1250ms）存在**隐式数值耦合**：调到 ≤1250ms 会让位 100% 失效，而回归脚本把 `canSinkNow()` 硬编码成 `true`、测不出来 | 把不变量写进注释（含推理与更彻底的解法） |

**3) 版本号 `1.13.8 → 1.14.0`**（`package.json` + `package-lock.json` 两处）

**4) ⚠️ 过程事故（如实记录）**：审查期间有外部写入把 `package.json` 剥成了最小版
（丢掉 `scripts` 与 `devDependencies`、版本回退到 1.13.7）。已按 `HEAD` 内容恢复并升到 1.14.0，
恢复后 `typecheck` / `build` / 全部回归探针**重跑通过**。若再出现「`npm run build` 报 Missing script」，
先 `git diff package.json` 看这一处。

**5) 本版回归证据（全绿）**
| 套件 | 结果 | 覆盖 |
|---|---|---|
| `devtools/probe/regression.cjs` | **20/20** | Dock 几何 / 横向滚动可达性 / 拖拽后几何缓存新鲜度 / 分组徽标重叠 / 「+」菜单几何 / 键盘导航层级 |
| `devtools/probe/flip-e2e.cjs` | **7/7** | 桌面图标文案与系统注册表真值同步翻转、主进程无 `toggle read failed` |
| `devtools/probe/runapp-open-always.cjs` | **5/5** | Clash Verge（进程在、无窗口）等目标点了**必须能打开**、且不多开 |
| `npm run typecheck` + `npm run build` | 通过 | — |

**6) 已知未修（留到下一版）**：`sandbox: false` 可收紧为 `true`；`ready-to-show` 少了 `sinkSeq++`，
且 `--autostart` 会无条件改写意图状态（开机自启后 1s 内按 Alt+Space 要多按一次）；
用户在**系统桌面右键菜单**里切换「显示桌面图标」后，Dock 菜单文案会停在旧值（有意取舍：菜单打开时不再探测）；
`recreateWindowForEdge` 目前不可达（三档窗口尺寸相同），左/右停靠落地时须重审监听器与定时器归属；
`parseLnkFile` 的 `JSON.parse(整段 stdout)` 仍是「整段当载荷」的写法。

### v1.13.1 (2026-09-24) 及之后的滚动条目（含 v1.13.2 ~ v1.13.8）

**专项修复：一次全项目 bug 审计（代码 + UI）发现的 19 个缺陷**。审计方式：类型检查 + 通读三个进程的全部源码 + 用**真实构建产物**在真实 Chromium 里驱动真实 UI（新增 8 个探针脚本，见文末）。下面按「用户能感知的严重度」排列。

#### 严重：三个功能实际上是坏的

- **① 点击其他软件后 Dock 立刻自己弹回置顶**（`src/main/index.ts` `sendToBottom`）
  - **根因是判断反了**：回调里先 `sinkState = null`（1547 行），紧接着调 `stillWanted()`，而 `stillWanted()` 的第一个条件正是 `sinkState?.win === win` —— 于是它**恒为 false**，紧跟的 `if (!destroyed && visible) recoverDock(win)` 在**每一次成功的沉底之后**都会执行，把刚沉下去的 Dock 又拉回置顶，并顺带 `markDockShown()` 重置 2.5s 宽限期（下一次 blur 也被吞掉）。这行是 v1.11.0 引入的
  - **修法**：进回调时先捕获「这次沉底是不是我们自己的、代际有没有变」，再清状态；只有「期间确实有更晚的拉回/隐藏意图」才走 `recoverDock` 补偿
  - **验证**：`sink-logic.cjs` 用逐行对照的五个场景复验 —— 正常沉底 → 不 recoverDock ✔；沉底途中唤回 → recoverDock ✔；途中隐藏到托盘 / PS 失败 / 窗口被销毁 → 不 recoverDock ✔
- **② 有分隔线时拖拽排序会插错位置**（`App.tsx`）
  - **三个下标空间混用**：`calcDropIndex` 在 `dockCenters` 上二分，而 `measureCenters` **跳过分隔线**（`data-sep`）→ 返回的是「不含分隔线」的下标；但 `topAnchorId` 用的是 `list.filter(a => !a.groupId)`（**含**分隔线），插入线比较的 `viewTopLevel` 也含分隔线。每有一条分隔线落在落点左侧，插入位置与指示线就整体偏左一个槽位
  - **实测复现**：图标 `A ▏ B C D`，把 C 拖到 B 的右半边（光标 x=573）→ 数组变成 `A ▏ C B D`（C 越过了 B），指示线画在 x=513（B 左边两格）
  - **修法**：统一到「可显示顶层条目（非分组成员且非分隔线）」一个空间——新增 `droppableTop()`，`topAnchorId` 与插入线渲染都按它计数
  - **验证**：同一场景修复后 `A ▏ B C D` 保持不变，指示线落在 x=577（≈ 光标 573）✔
- **③「以管理员身份运行」对没有启动参数的条目 100% 失败**（`src/main/index.ts`）
  - `Start-Process` 的 `-ArgumentList` / `-WorkingDirectory` 都是 `[ValidateNotNullOrEmpty]`，传空串**先**在校验阶段抛错（本机 PS 5.1 实测：`Cannot validate argument on parameter 'ArgumentList'. The argument is null or empty.`），根本走不到创建进程那一步。而「没有启动参数」正是绝大多数条目的常态
  - 更糟的是这条路径**先把 Dock 隐藏了**（`mainWindow.hide()`），失败只打一行日志、IPC 还返回 `true` → 用户看到「Dock 消失、没有 UAC、什么都没发生」
  - **修法**：用参数哈希表拼装，空值一律**不传**该参数；失败时 `restoreDockAfterFailedLaunch()` 把 Dock 还给用户
  - **验证**：`runas-check.cjs` 从源码里提取脚本模板，在真实 PS 5.1 上跑五种参数组合（含单引号转义）—— 全部通过参数校验、走到「文件不存在」✔

#### 高：会静默丢功能的缺陷

- **④ 拖入 ≥13 个 exe 会被整批拒绝**（`runPowerShell` 未设 `maxBuffer`）
  - Node `execFile` 默认 1 MiB，超限时子进程被杀、`err.code = ERR_CHILD_PROCESS_STDIO_MAXBUFFER`；而所有调用点都把 `err` 当成「没有结果」→ 静默返回空数组。实测 `describeExecutables` 每个 exe 带一枚 256px 图标 = **80,235 字节**，**13 个就超 1 MiB**（1,043,075 B）；20 个是 1.6 MB
  - 用户看到的是「已跳过 20 个（重复或格式不支持）」，完全不知道真实原因
  - **修法**：`PS_MAX_BUFFER = 8 MiB`
  - 顺带核对了 `scan-desktop-folders`：那条每项只带一枚 **48px** 图标（约 2.7 KB），要 380+ 个桌面文件夹才可能超限，**不是**本次的问题路径（审计时曾被怀疑，实测排除）
- **⑤ 6 处硬编码 256px 图标尺寸与 `ICON_SIZE = 64` 矛盾**（`src/main/index.ts`）
  - `parseLnkFile` 4 处 + `describeExecutables` 2 处仍在传 `256`。同一枚图标实测 64px = 10,048 B、256px = 82,972 B（**8.3 倍**）—— 这既是磁盘/内存浪费，也是 ④ 的直接原因。306-310 行早就为文件夹图标修好了同一个问题，这 6 处漏了
- **⑥ 把「此电脑」拖进分组 → 成员残留 `specialType`**（`App.tsx`）
  - 归组写的是 `{ ...item, groupId: overGroup }`，`specialType: 'this-pc'` 跟着进组 → 这个「分组成员」在面板里仍被当成系统位置渲染（标签被改写成「此电脑 · 可用 …」、图标上挂一条用量细条）
  - **修法**：入组时显式 `delete member.isFolder / member.specialType`

#### 中

- **⑦ `folder-icons` 只发给第一个请求者**：`folderListPending` 复用在途 Promise 时，闭包里捕获的是**旧**窗口的 `sender`。窗口重建（切停靠位置 / dev HMR）后新窗口命中同一条 Promise，后台补图标全推给了旧 WebContents，卡片永远停在占位块。改为 pending 记录**可变的 sender**，每批推送前重新取
- **⑧ Dock 玻璃条比设计值矮 16px**：实测 `.dock-bar` 只有 **130px**（设计 146），连锁导致 `.dock-bg` 只有 **60px**（设计 76），整条玻璃条偏薄、图标底边距窗口底 8px 而非贴底。根因是 `.dock-bar` 作为 flex 项在算 auto 高度时被父级 `.dock` 的**内容盒**（130px）确定化。修法：`.dock-bar { height: 146px }` + `.dock-inner { height: 100% }`；修后 `.dock-bg` = 76px、`.dock` = 162px（= 146 + 上下 8px padding，正是设计值）、图标底边贴窗口底。**五个浮层的贴边锚点全部自动跟随**（实测菜单/右键菜单/面板/两张卡片的 8px 间隙与窗口内约束均不变）
- **⑨ 托盘「显示窗口」与关闭到托盘没走统一入口**：前者缺 `sinkSeq++` / `recoverDock()` / `markDockShown()`（一旦 Windows 前台锁拒绝这次激活，窗口会停在「可见但不置顶」，且没有宽限期保护）；后者缺 `sinkSeq++`（正是注释里要防的「HWND_BOTTOM 钉在隐藏窗口上」）
- **⑩ 启动路径的未捕获异常/未处理 rejection**：`execFile('explorer', …)` 没有回调也没有 `error` 监听（spawn 失败会在主进程抛未捕获异常）；`shell.openExternal`（两处，含 `setWindowOpenHandler`）与 `shell.openPath` 的返回 Promise 被丢弃（`steam://` / 没有关联程序的 `mailto:` 会 reject）

#### 低

- **⑪ `sendToBottom` 的串行化重试永远不执行**：重试守卫写成 `sinkState?.win === win`，而前一次任务完成时已把 `sinkState` 置回 `null` → 第二次让位意图被静默丢弃。改为按「意图是否仍成立」判断（`sinkSeq` / 可见 / 焦点 / 托盘 / 宽限期）
- **⑫ `load-shortcuts` 只校验数组、不校验元素**：`[1,"x",null]` 是合法 JSON，会原样进 renderer；改为过滤掉非对象元素
- **⑬ `showOpenDialogSafe` 可能永久卡住 `dialogOpen`**：`showOpenDialog` 若同步抛错，`.finally()` 注册不上 → 之后 Dock 再也不沉底；改为 `try/catch`
- **⑭ `ensureFolderIcon` 把失败缓存成空串且不再重试**：`folderIcon !== null` 让后续调用直接返回，`select-folder` 整个会话发空图标；改为失败时复位成 `null`
- **⑮ 抢不到单实例锁的进程仍会跑预热**：`whenReady` 里的预热没被 `gotSingleInstanceLock` 保护，白起一个 `powershell.exe`
- **⑯ `fillFolderIcons` 的 `sender.send` 可能抛成未处理 rejection**（该函数是 `void` 掉的）：包 `try/catch` 并在捕获时删缓存
- **⑰ 键盘导航的层级判断错了**：`list` 只按 `openGroupId` 取。面板被鼠标点开、而选中框仍在主 Dock 上时，`list.findIndex(navId)` 恒为 −1 → `→` 会让选中框凭空飞进面板第一个成员，`←` 会收起面板。改为按**选中项实际所在层级**（`navInPanel`）决定列表；`Escape` 在该场景下改为「收起面板并退出导航」。顺带明确了：`→` 在最右侧时**仅当选中框不在面板内**才落到「+」（面板内需先 `←`/`Esc` 退出）—— 这条行为已写入 `CLAUDE.md`
- **⑱ 编辑表单里清空名称会静默无效**：`editFields.description.trim() || a.description` 在名称被清空时保留原名，输入框空了却没改成功。改为允许清空（渲染兜底显示「未命名」）
- **⑲ 位置选择器与文档不一致**：`handleEdgePick` 会关掉「+」菜单，而 CLAUDE.md 写的是「位置选择后菜单保持打开」（主题选择器也是保持打开的）。统一为**保持打开**

- **⑳ Dock 图标垂直偏心：玻璃条内「上留 16px、下留 0px」**（用户直接反馈「为什么图标上面间距比下面大」）
  - **根因**：`.dock-inner` 是 `flex-direction: column`（默认），所以 `align-items` 管的是**横轴**——原来写的 `align-items: flex-end` 只管横向收边，**纵向压根没被居中**；纵向位置实际由 `justify-content`（默认 `flex-start`）+ `padding-top` 决定，于是衬底被顶到玻璃条下沿
  - **实测**：玻璃条 `[218, 294]`（高 76），图标衬底 `[234, 294]`（高 60）→ 上 16px / 下 0px（诊断时还量到 `item.offsetTop = 98` 而 `padding-top` 只有 82，多出的 8px 来自 `align-items: flex-end` 对内容盒的影响）
  - **修法**：改成 `justify-content: center`（纵向）+ `align-items: center`（横向），并把 `.dock-bar` / `.dock-inner` / `.dock-bg` 三处数值重新配平：
    ```
    .dock-bar  高 158（贴底 → [136, 294]）
    .dock-inner padding: 82px 16px 0 → 内容盒 [218, 294]，高 76
    .dock-bg { top: 82px; bottom: 0 } → 高 76，正好等于内容盒
    衬底 60 在 76 里居中 → [226, 286] → 玻璃内上 8 / 下 8
    ```
  - **实测复核**（真壁纸 + 三档停靠位置）：上 8 / 下 8、图标图像上 16 / 下 16，`middle`/`bottom`/`top` 三档完全一致；顺带确认悬浮标签不被 `.dock-inner` 的 `overflow` 裁掉（标签顶边在容器顶边下方 58px，余量充足）
  - 连带同步：`.dock-edge` 的 `top`、`top` 布局镜像的 `bottom/padding`（82）、`.drop-hint` 的 `bottom/top`（156 → 168，因为 Dock 由 146 变 158）
  - ⚠️ **这是一次「CSS 属性用在错的轴上」的典型**：`align-items` vs `justify-content` 在 `flex-direction: column` 下会互换语义，而且写错时**不报错、只是静默偏心**——所以布局改完一定要**量数字**，不能只看「元素在容器里」就以为居中了

- **㉑ 滚不到最前面：「此电脑」「回收站」被推到屏幕外且找不回来**（延续 ⑳ 的修复，用户随后反馈）
  - **根因**：⑳ 里我给 `.dock-inner` 加了 `justify-content: center` 来做纵向居中。但它是**横向滚动容器**（`overflow-x: auto`）——flex 在**主轴溢出**时 `justify-content: center` 会让内容**向两侧同时溢出**，而**左侧那半永远滚不到**
  - **最隐蔽的一点**：浏览器**不把左侧溢出算进可滚动区**，所以 `scrollWidth` 会**小于**真实内容宽度 —— 实测 31 个图标时 `scrollWidth` 只有 **1582**，而把各元素宽度加起来实际是 **2012**。于是「滚到底」也到不了最前面，因为可滚动区压根没包含那 430px
  - **实测现象**：`scrollLeft = 0` 时第一个图标停在 **x = −390**（容器左缘是 24）；滚轮、`scrollIntoView`、拖拽自动滚动全都无效
  - **修法**：`.dock-inner` **不加 `justify-content`**；纵向位置改由 `padding-top: 82px` + `padding-bottom: 0` + `align-items: center` 决定（`flex-direction: row` 下 `align-items` 管的是**纵轴**，正好用来在 76px 内容盒里居中 60px 衬底）
  - **实测复核**：`scrollWidth` 从 1582 恢复到 **2012**（= 内容真实跨度）；`scrollLeft = 0` 时第一个图标 left = **40**（容器 24 + padding 16），完整可见；从最右用滚轮一路向左能回到第一个图标 ✔
  - ⚠️ 这两个 bug 是**同一处 CSS 的两个轴**打架：⑳ 要纵向居中、㉑ 的解法在横轴上破坏了滚动。教训是**滚动容器上不要用 `justify-content` 做居中**，用 padding 把内容推到位

- **㉒ `electron-builder.yml` 的 `files` 是排除式，把开发脚手架整包打进了 asar**（打包发布时发现）
  - electron-builder 的 `files` 语义是「**没列出来的都会进去**」，原配置只排除了 `src/`、`node_modules/` 和几个配置文件，漏掉两类，实测：
    - `electron-v43.1.0-win32-x64.zip`（**144 MB**，仅用于 `electronDist` 跳过下载）——它就躺在项目根目录，被整包塞进 asar，`app.asar` 因此虚报到 **142 MB**
    - `devtools/**`（3.7 MB / 224 个文件：图标候选图、探针脚本、截图、提交信息草稿）——asar 的 **250 个条目里有 235 个是它**
  - **修法**：显式加 `!electron-v*.zip` 与 `!devtools/**`
  - **实测效果**：`app.asar` 条目 **250 → 14**、体积 **142 MB → 0.89 MB**；安装包 **235 MB → 95 MB**（省掉 140 MB）
  - 这两者都不参与运行时（main 只读 `out/**` 与 `resources/`），排除是安全的；打包版已实机启动验证（窗口标题「快捷方式面板」、4 个 Electron 子进程正常）

- **㉓ 分组图标：4 个以上成员时，右下角数量徽标盖住第 4 张缩略图**（用户反馈）
  - **现象**：分组有 4 个成员时，右下角那张成员图标被蓝色的成员数徽标压住一角
  - **根因**：徽标 `.dock-badge` 是 16×16 锚在图标框右下角（占 `(44,44)..(60,60)`），而缩略拼图原来是 54×54 **铺满整个图标框** —— 2×2 时第 4 张正好落在右下角，**实测被盖住 25%**（重叠 169/676 px²）。3 个成员时第二行只有一个、被 `justify-content: center` 居中，所以碰不到；**这个 bug 只在 ≥4 个成员时出现**（成员越多越明显，与直觉相反）
  - **修法**：拼图缩为 2×2 = `19 + 2 + 19 = 40`，钉在图标框 `(4,4)..(44,44)`，与徽标恰好相接不重叠；徽标加一圈 `0 0 0 1.5px var(--label-pill-bg)` 外描边（它可能压在任意颜色的图标上）
  - **实测**（5 种成员数：1/2/3/4/8）：重叠 **169 px² → 0 px²**，全部为 0
  - ⚠️ **定位方式试错四轮，三条弯路值得记下**：
    1. `margin` / 负 margin **无效** —— `.dock-icon-wrap` 是 `display:flex` + `align-items/justify-content: center`，flex 居中断言会盖掉 margin
    2. 只写 `position:absolute; top:0; left:0` **也无效** —— 实测 `offsetLeft/offsetTop` 仍是 `9/9`（被 flex 居中）。**绝对定位只把盒子移出文档流，并不豁免父级的对齐**
    3. 正解：`position:absolute` + 四向 inset + `margin:auto`（本项目用 `inset:0; margin:4px auto auto 4px`）
  - 教训：**在 flex 容器里给绝对子元素定位时，`top/left` 不一定说了算**，必须实测 `offsetLeft/offsetTop`；我在这处连续推错三次，每次都被探针打回来。另外「1px 余量」在亚像素布局下会退化成 8×8 的实际重叠，**余量要给够，别卡着算**
  - 回归断言见 `regression.cjs` 第 8 组

- **㉔ 分组缩略图改为「层叠卡片」（UI 改进，用户选定方向 A）**
  - **动机**：㉓ 的修法是把 2×2 网格缩小并让位给徽标，徽标确实不盖了，但拼图缩到 19px 后**偏小、且整体偏向图标框左上**，看着像「缩水的小方块阵」；而且只要网格铺满图标框，就永远要和右下角的徽标抢地盘
  - **做法**：换成 4 张 **22px 卡片向右下阶梯**排列（`(2,2) / (22,0) / (0,22) / (18,18)`）——第 4 张自然收在 `(18,18)..(40,40)`，**右下角天生空出来给徽标**，不再需要"算余量"；卡片之间加 `box-shadow` 分开，形成「一叠东西」的厚度感
  - **实测**：徽标重叠 **0 px²**（1/2/3/4/8 五种成员数全覆盖），卡片比原来大 3px、视觉重心也回到图标区中心
  - **选型过程**（脚本 `stack-variants.cjs` 一次渲染 6 种候选并输出 1x 截图对比）：
    | 方案 | 结论 |
    |---|---|
    | 4 张 32px 纯旋转堆叠（±3°/±8°） | 最像 macOS 文件夹，但 44px 下四张糊成一坨、认不出成员 ❌ |
    | 只显示 3 张更大的阶梯 | 辨识度好，但少显示一个成员 ❌ |
    | **4 张 22px 阶梯（前卡在右下）** | 四张都能辨认 + 有厚度感 + 右下角天然让位 ✅ |
  - 成员不足 4 个时位置**固定不重排**（2 个是「左上+右上」、3 个是「上排两个+左下」），所以看起来始终是同一叠，不会因为成员数变化而跳位置

- **㉕ 「白天」模式偏白，没有毛玻璃感**（用户反馈）
  - **根因是两层白叠加**：`.dock-bg` 的玻璃底色本身是 `rgba(252,252,254,.92) → .74`（几乎不透），
    而它上面还压着一层 `radial-gradient(rgba(255,255,255,.14))` 的上沿高光 —— 在这么高的不透明度上再叠白，
    「白板感」被放大一档，彩色壁纸完全透不出来
  - **修法**：底色降到 **`.68 → .46`**，上沿高光从 `.14` 降到 **`.045`**，饱和度同时从 1.7 回调到 **1.45**
    （白玻璃下再拉高饱和会让彩色壁纸透出时发灰发脏）。为此把原来硬编码在高光与 backdrop-filter 里的
    两个值抽成变量 **`--dock-sheen` / `--dock-sat`**，便于按主题调
  - **实测**（真实应用窗口）：玻璃填充 `rgba(252,252,254,0.68)` ✔、`--dock-sheen: 0.045` ✔、`--dock-sat: 1.45` ✔；
    截图对比可见壁纸的紫/橙渐变明显透过玻璃，同时图标仍清晰
  - ⚠️ 教训：**多层半透明叠加要一起算总不透明度**。只调最外层（或只调底色）都看不出效果 ——
    这次是底色 + 径向高光两层白叠在一起，只看其中一个变量会误判「已经够透了」

- **㉖ 「+」菜单里两种字体不匹配、字比较粗糙**（用户反馈）
  - **根因一（粗糙）**：字体栈是
    `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`
    —— 这些在 Windows 上**都不提供中文字形**，中文落到 Arial 缺失后由 GDI 兜底字（Tahoma）渲染，
    笔画细、边缘发虚。改为 `system-ui, 'Segoe UI Variable Text', 'Segoe UI', 'Microsoft YaHei UI', …`：
    显式把**微软雅黑 UI**（雅黑的 UI 变体，小字号 hinting 更好）排进栈里
  - **根因二（不匹配）**：`.dropdown-item` 是 `<button>`，而 **Chromium 的 UA 样式表给 button 设了自己的
    font、不是 `inherit`** —— 于是它拿不到 body 的字体栈（实测 computed font-family 就是 `Arial`）；
    而同在菜单里的 `.theme-seg-btn` 因为显式写了 `font: inherit`，用的是应用字体栈。
    同一个浮层里两种中文字形并排。修法是在基础层全局收口 `button, input, select, textarea { font: inherit }`
  - **根因三（不匹配）**：菜单项 `.84rem/400`、分段按钮 `.8rem/600` —— 字号差 + 字重差叠加，视觉上是「两种字体」
  - **实测**（应用改动后）：菜单项与分段按钮**同为** `system-ui / 13.44px / weight 500 / letter-spacing .01em`，
    子行 `12.48px/500`；真实应用窗口里 body 字体为 `system-ui`
  - ⚠️ 教训：**`<button>` 不继承 `font`** 是 Chromium UA 样式表的固有行为，凡是给按钮写字体都要显式声明
    或在基础层统一收口；别指望它跟着 body 走

- **㉗ `run-app` 立刻 `return true`，启动失败的回执永远传不到 renderer**（弹窗时机审计发现）
  - **审计方法**：把「弹出/消失」的所有路径列出来逐一核对——显示 4 条（启动、Alt+Space/托盘、second-instance、失败回滚）、
    隐藏 5 条（启动目标、关窗到托盘、Alt+Space 隐藏、失败回滚的反向、重建窗口）。重点核对**异步窗口期**里的顺序
  - **发现的缺陷**：`run-app` 的「Executable」分支是
    ```ts
    execFile(targetPath, args, (err) => { …restoreDock… })   // 回调是异步的
    return true                                              // ← 却立刻返回成功
    ```
    spawn 失败是**异步**通知回调的。实测（探针 `runapp-timing.cjs`，与源码逐行同构）：
    目标不存在时 handler 在 **~1ms** 就返回了 `true`，而 `ENOENT` 要到 **~400ms** 后才在回调里到达。
    **后果**：renderer 里那句
    `window.api.runApp(...).then(ok => { if (ok === false) showDropHint('启动失败：目标不存在或无法运行') })`
    **永远不可能触发** —— Dock 约 0.4s 后自己弹回来、却一句解释都没有。
    那句提示正是 v1.13.1 为了消除「点了没反应」而加的，结果因为返回值恒真而形同虚设（典型「修了但没生效」）
  - **修法**：监听子进程的 `spawn` / `error` 两个事件再决定返回值 ——
    `spawn` 表示进程真的起来了（立刻 resolve），`error` 表示没起来（resolve false）。
    ⚠️ **不能用 `execFile` 的完成回调判成功**：对 GUI 程序那个回调要等**程序关闭**才触发，
    挂上去会让这个 IPC 一直挂到用户关掉应用为止（这是必须避开的设计陷阱）
  - **实测**（探针 `runapp-fixed.cjs`）：不存在的 exe → 返回值 **false** + Dock 还回；
    存在的 GUI 程序（notepad）→ 返回值 **true** + Dock 保持隐藏（**不等进程退出**，21ms 返回）

- **㉘ 启动失败的回滚会「抢用户的操作」**（同上审计，修 ㉗ 时连带发现）
  - `restoreDockAfterFailedLaunch()` 原实现是**无条件** `show()`。但失败回调是异步的（~400ms），
    这段时间里用户完全可能已经自己 Alt+Space 唤回、**或又点了另一个图标并成功启动** ——
    那时这个迟到的回调会把 Dock 又弹回来
  - 第一版修法只加了 `if (!dockTrayHidden) return`，**不够**：用户点第二个图标时 `run-app` 会再次
    把 `dockTrayHidden` 置真，值凑巧又相等，守卫失效 —— 这个漏洞是我自己的状态机测试
    （探针 `visibility-state.cjs` 场景 3）抓出来的
  - **正解：比代际，不比布尔值**。`run-app` / `run-as-admin` 隐藏时记下当时是第几代
    （`sinkSeq++` 之后的值）并往下传，回滚时 `if (sinkSeq !== hideSeq) return` ——
    期间只要发生过任何一次唤回或再次隐藏，代际就变了，这次回滚自动作废
  - **实测**（`visibility-state.cjs` 5 个场景全过）：正常失败还回 ✔ / 用户已唤回时不重复 show ✔ /
    第二个应用已启动时不弹回 ✔ / URL 失败还回 ✔ / UAC 取消还回 ✔

- **㉙ 弹窗时序审计的其余结论（这些是**对的**，记录以免以后改坏）**
  - 显示 4 条路径**都**做了 `sinkSeq++` + `markDockShown()` + `recoverDock()` 三件套（`second-instance`、
    托盘「显示窗口」、`toggleWindow` 显示分支、`ready-to-show`）；隐藏 5 条路径都做了 `sinkSeq++`，
    没有漏网的（这是 v1.13.1 修回归时补的，本次逐条复核确认）
  - `blur` 的 120ms 延迟复核是对的：回调里先比 `sinkSeq`（任何招回都会 ++ 使其作废），
    再查可见/焦点/托盘/宽限期，四条全过才起 PowerShell
  - **`focus` 每次都会 `sinkSeq++`**，因此「点回 Dock 再点别的软件」不会留下过期的沉底定时器 ——
    旧定时器代际不符自动作废，永远只有一个待执行（这条设计很关键，别再改成"只在状态变化时才 ++"）
  - ⚠️ **已知取舍（未改）**：`run-app` 是**先隐藏再 spawn**，所以「目标不存在」时用户会看到
    Dock 消失约 0.4s 再回来 + 提示。要消除这个闪烁得在隐藏前做存在性预检，
    但那对 `shell:`/URL/裸命令名（PATH 里解析）会误判，风险大于收益，故保留现状

- **㉚ 点图标时不再重复开进程：已在运行的目标改为「激活它的窗口」（v1.13.5，用户反馈）**
  - **现象**：点 Dock 上的微信图标会**又开一个进程窗口**，而不是切到已经开着的那个
  - **先排除误判**：写探针（`wechat-launch.cjs`）实测对比两种启动方式，目标都是 `E:\WeChat\Weixin\Weixin.exe`：
    | 方式 | 结果 |
    |---|---|
    | `execFile`（= 应用当时的做法，CreateProcess） | 新增 1 个进程 |
    | `Start-Process`（= 资源管理器双击，ShellExecuteEx） | 新增 1 个进程 |
    **两者都新开进程** —— 所以这**不是**启动方式的问题，换 ShellExecuteEx 也修不了。必须由我们主动把已有窗口提到前台
  - **可行为什么是可能的**（探针 `ActivateProbe.cs` 实测）：微信收在托盘时那个主窗口是
    `class=Qt51514QWindowIcon title=[微信] visible=False` —— 它**还在**，只是被隐藏了。
    `ShowWindow(SW_SHOW)` 就能让它真的显示出来（持续可见、不被它自己再藏回去）；
    但 `SetForegroundWindow` 会被 Windows 前台锁**拒绝**（实测返回 False），
    必须配 **`AttachThreadInput`** 把我们的线程挂到当前前台线程上才成功
  - **实现**：`run-app` 在隐藏 Dock **之前**先判断「目标是否已在运行」——
    是则激活其窗口并直接返回，不启动新进程。匹配用**进程可执行文件路径**（大小写不敏感）而不是进程名；
    跳过无标题窗口与 IME 辅助窗口；只对「无启动参数的本地 exe」生效（带参数时用户要的多半是明确的新行为，不替他改语义）
  - **实测**（探针 `activate-real.cjs`，从**构建产物**里抠出真实 C# 再跑）：
    `ACTIVATED`，且 Weixin 进程数 **1 → 1（没有新增）** ✔
  - ⚠️⚠️ **踩坑：这段 C# 必须纯 ASCII，中文注释会让它静默失效**。第一版我写了中文注释 →
    `powershell.exe -Command <文本>` 是按**系统 ANSI 代码页**（中文 Windows = GBK/936）解码命令行的，
    而脚本是 UTF-8：GBK 解码把多字节序列解错、**把注释结尾的 `*/` 吃掉** → 整段源码语法错误 →
    Add-Type 编译失败 → `FindPid` 永远返回 0 → 功能静默失效（只表现为"没生效"，不报错，极难查）。
    实测本项目其它 C# 常量（`ICON_EXTRACTOR_CS` / `DESKTOP_ICONS_CS` / `WinZ`）**都是 0 个非 ASCII 字符**
    —— 那不是巧合，是这条约定在撑着。**新增内嵌 C# 时务必保持纯 ASCII**，说明写在 TS 那一侧

- **㉛ 收在托盘里的程序：用 UI Automation 点它的托盘图标把它唤出来（v1.13.7，用户要求）**
  - **背景**：v1.13.6 只做到「不重复启动」，托盘态让用户自己去点托盘图标。用户追问「真的没办法打开了吗」，
    要求应用直接帮他点 —— 结果是**有办法，而且我上一轮说"技术上不可行"是错的**。走 UIA：托盘图标本身就是
    UIA 元素、有 `Invoke` 模式，等价于用户自己点它，**不碰应用的窗口、不开进程、不动鼠标**。
  - **实测（真实应用内，非探针）**：`probeTargetState = tray` → `clickTrayIconFor = true`（1856ms）→
    微信窗口 `visible 0 → 1`、进程数 5→5 不变、未响应 0 个、临时脚本残留 0 个
  - **四个坑（都很隐蔽，改这块必读）**
    1. 🚩 **`FindAll(NameProperty, 中文)` 恒返回 0**：名字确实传对了（实测 C# 侧收到
       `663E 793A 9690 85CF 7684 56FE 6807` = 显示隐藏的图标），条件就是匹配不上。
       **改成遍历子树、在 C# 里用 `Name == want` 比较**（实测「遍历到 35 个元素、精确命中 1」）
    2. 🚩 **`powershell.exe -Command` 传中文会被截成半个字符**：实测报
       `[QLTray]::ClickTrayIcon('显示隐藏的图�?, …) 字符串缺少终止符` → 整条脚本解析失败，
       而且 stdout 已被消费、**看不到任何输出**，表现成「调用方静默死住」。
       **改成写「带 UTF-8 BOM 的 .ps1」再用 `-File` 执行**（BOM 不能省，否则 PS 5.1 按 ANSI 代码页读文件）；
       顺带也不再依赖系统区域设置（中文 Win 是 GBK，别的语言机器本来会直接坏掉）
    3. 🚩 **`Process.MainWindowTitle` 在窗口隐藏时是空的**：于是候选名退化成 `Weixin`，
       而托盘图标叫「微信」，**永远匹配不上**（这是"点了没反应"的直接原因）。
       **改用 `EnumWindows` + `GetWindowText` 取该程序所有顶层窗口的标题**（微信的托盘 tooltip == 它的窗口标题）
    4. 🚩🚩 **`execFileSync` 阻塞主进程事件循环**：UIA 的 `Invoke` 那一步在完整应用里会卡住不返回
       （最小 Electron 应用里同样的脚本却正常），于是**整个 Dock 卡死**、连 `app.exit(0)` 都执行不到。
       **改成 `execFile` + Promise + 9s 超时兜底**。⚠️ 这条不只影响本功能：
       **任何走 `execFileSync` 的 PowerShell 调用都可能把 Dock 卡死**，新代码优先用异步
  - **匹配策略**：候选名 = 该程序所有顶层窗口标题 + exe 名兜底；匹配不到就**什么都不点**（列出面板里的
    名字也没关系，绝不乱点别人的托盘图标），退回「提示用户自己点」
  - **收尾**：点击后自动把溢出面板关掉，不留残影（实测残留 0）
  - 回归验证：`node devtools/probe/tray-bom.cjs`（BOM 文件方案，连跑两次都返回 1）、
    `tray-v2.cjs`（树遍历法）、`uia-diag5.cjs`（证明「遍历 35 个、精确命中 1」）
- **㉜ 桌面图标开关：文案不再「先显示隐藏、再立马切成显示」（v1.13.7 修，用户反馈）**
  - **现象**：系统里桌面图标**已隐藏**时，打开「+」菜单会先显示「隐藏桌面图标」、随即翻成「显示桌面图标」
  - **根因（两条叠加）**
    1. `desktopIconsHidden` 的初始值是硬编码 `false`（= 图标可见），而真值要等异步读取；
       系统里实际是隐藏的话，读回来必然翻转一次文案。**读的时机也太晚** —— 只在菜单打开时才读。
    2. `readDesktopIconsHidden()` **读失败时返回 `false`**，把「读失败」和「图标可见」混为一谈：
       启动那次读失败 → 状态停在「可见」；菜单打开再读（这次成功）→ 文案当场翻转。
       实测把 `null` 和 `false` 分开后可复现两种路径的差异。
  - **修法（三道）**
    ① 主进程加**缓存** `desktopIconsHiddenCache` + `get-desktop-icons-hidden-sync`（`sendSync`），
       preload 暴露 `desktopIconsHiddenInitial()`，renderer 用它做 `useState` 的初始值 ——
       **首帧就是对的，根本没有异步窗口可以翻转**。应用启动时预热一次缓存；
       切换成功后也写回缓存。（⚠️ 必须缓存：`sendSync` 要求处理器**同步**设置 `event.returnValue`，
       而读操作要起 PowerShell、是异步的，在 `.then` 里赋值已经晚了 —— 这条弯路走了一半才发现）
    ② `readDesktopIconsHidden()` 与 `toggle-desktop-icons` 失败时返回 **`null`**（状态未知），
       不再编一个 `false` 冒充「图标可见」；renderer 收到 `null` 时**保持现状、不翻转**
    ③ 切换失败时返回缓存里的已知值（连缓存都没有才返回 `null`）
  - **实测**（`flip-test.cjs`，真实构建产物 + 模拟「图标已隐藏」）：
    `desktopIconsHiddenInitial()` 返回 `true`，菜单打开后 1.2s 内采样 20 次文案集合 = `["显示桌面图标"]`，
    **零翻转**；再把异步读全改成 `null`（模拟读全失败）后文案依旧正确、依旧零翻转
- **㉝ 「+」菜单底部显示版本号（v1.13.7，用户要求）**
  - 新增 IPC `get-app-version`（`app.getVersion()`，打包/开发同一个字段），菜单最底部一行
    `快捷方式面板 v1.13.7`，非交互元素
  - ⚠️ **必须做成「可滚动内容 + 固定页脚」两段式**：整窗只有 300px，菜单可用高度约 200px，
    而内容（4 个菜单项 + 停靠位置 + 主题两行 + 分隔线）已经接近这个量。第一版把版本行直接
    放在菜单容器里，它被挤进滚动区 —— 实测 `rect.top=292` 而菜单底只有 `209`，**用户永远看不到**。
    现在 `.dropdown-menu` 是 flex 纵向布局、`.dropdown-scroll` 负责滚动（`min-height: 0`）、
    版本行在滚动区之外。以后再加菜单项也只滚内容区、页脚始终可见
  - 顺带修正 `overlayAvail` 的**基准错误**（原来用常量 `BASE_WINDOW_H(300)` 减锚点偏移，
    而锚点偏移是从**真实** `window.innerHeight` 推出的，两者差几像素；菜单内容本就贴着上限，
    差这几像素就把主题选择器推进了滚动区）。现在直接用 `window.innerHeight - anchorOffset`。
    ⚠️ 也**不能在 render 里读 `dockBgRef.getBoundingClientRect()`**：首帧 ref 还没挂上，
    会回退到兜底值把菜单压成 120px（实测踩过）
  - 回归验证：`menu-version.cjs`（文案 + computed 样式 + 截图）、`menu-geom2.cjs`（几何与裁切）
- **㉞ 澄清：「点开微信后 Dock 隐藏到托盘」是既定行为，不是 bug（v1.13.7 与用户确认）**
  - 用户报「点开微信后软件就退出到后台」，实测**应用进程没有退出**：
    `runApp` 返回 `true`、主窗口 `visible=false destroyed=false`、5 秒后仍存活，微信窗口 0→1 成功唤出。
    实际就是设计中的「启动目标后隐藏到托盘，把桌面让出来」。用户确认「就是正常的隐藏到系统托盘」，
    明确**不需要改**。以后再遇到「应用退出」类报障，先量进程存活再改代码

- **㉟ 桌面图标开关：文案「永远卡在『隐藏桌面图标』」的真凶 —— PowerShell 里漏掉的 `[void]`（v1.13.8 修，用户反馈）**
  - **现象**：菜单里隐藏/显示桌面图标**都正常**（图标真的会变），但菜单文案**永远显示「隐藏桌面图标」**，
    点几次都不变。v1.13.7 那三道修法（缓存 + 同步首帧 + `null` 不写进 state）都没治住它 ——
    因为它们防的是「首帧渲染错值」，而这个 bug 根本不在渲染侧。
  - **根因**：`toggle-desktop-icons` 的 PowerShell 脚本里
    `[DesktopIcons]::SendMessage($dv, 0x0111, 0x7402, 0)` **没写 `[void]`**。
    PowerShell 会把**未赋值方法调用的返回值**也写进 stdout —— 于是 stdout 变成两行
    `"0\n1"`（第一行是 SendMessage 的 IntPtr 返回值，第二行才是注册表真值）。
    旧解析对**整段** stdout 做等值判断（`raw !== '0' && raw !== '1'`）→ 判成「读失败」：
    - `toggle-desktop-icons` 返回 `null` → 主进程缓存**永不更新**（始终停在启动时那份 `false`）；
    - renderer 虽然保住了乐观值，但**下一次打开菜单**又读到那份陈旧缓存 `false` → 文案退回「隐藏桌面图标」；
    - 结果就是「图标在翻、文案不动」，而且每次点完都精确回到同一个错值 —— 看起来像文案被写死了。
  - **修法（三道）**
    1. **`[void][DesktopIcons]::SendMessage(...)`** —— 从源头堵住 stdout 污染（真正的根因）
    2. **标记式输出 + 只认标记**：脚本改为输出 `HIDEICONS=0|1`（读不到时输出 `HIDEICONS=?`），
       主进程 `parseDesktopIconsHidden()` 只扫这个标记、忽略其它任何行 ——
       以后再有东西往 stdout 漏（Add-Type 警告、新加的方法调用……）都不会中招。
       顺带修掉「`FindListView` 拿不到却编一个 `0`（= 可见）」：现在明确输出「未知」，交给上层保持现状
    3. **读不到结果时的兜底**：0x7402 是**翻转**语义，命令确实发出去了（`TOGGLED=1`）时把缓存取反，
       不让它永远停在旧值上
  - **实测**（`devtools/probe/flip-e2e.cjs`：真实 main + 真实 preload + 真实 renderer，
    从外部读注册表当真值）：修前 `注册表 0→1` 而文案 `隐藏桌面图标 → 隐藏桌面图标`（复现用户报障）、
    主进程日志 `[desktop-icons] toggle read failed: undefined | stdout: "0\n1"`；
    修后 7/7 通过（文案与系统真值同步翻转、日志干净）
  - ⚠️ **为什么 v1.13.7 的探针没抓到**：`flip-test.cjs` 用的是**模拟 IPC**
    （`ipcMain.on('get-desktop-icons-hidden-sync', e => { e.returnValue = true })`），
    它证明的是「首帧文案正确」，**从未跑过那段 PowerShell**。
    教训：凡是「外部命令输出解析」类的 bug，模拟 IPC 的探针一律测不出来，必须起真实主进程。
    另外 `flip-real.cjs` 名字也误导 —— 它其实只把应用起起来、连 CDP 都没连上（脚本里自己写了
    「本脚本不引入依赖」就收工了），所以这轮补了 `flip-e2e.cjs` 并把旧脚本的缺口写在注释里
  - ⚠️ **同类坑的现成防线**：托盘点击那条路径早就在用
    `String(stdout).trim().split(/\r?\n/).pop()`（只取最后一行）。
    **解析 PowerShell 输出时不要对整段做等值判断** —— 谁也不知道脚本里还有没有别的语句会往 stdout 漏东西

- **㊱ 点图标「有的直接打开、有的弹『没能确认是否已在运行』」的真凶 —— 四态探询把两种相反的结果混成同一个返回值（v1.13.8 修，用户反馈）**
  - **现象**：Dock 上有的图标点一下直接打开，有的点一下只弹
    「没能确认是否已在运行，为避免多开已取消：请再点一次」。
    实测最严重的一条：**当前没在运行的程序，永远点不开**。
  - **根因（两处，叠加）**
    1. `QLActivate.Activate` 把「**根本没有这个进程**」和「**进程在、但还没建出带标题的窗口**」
       都返回 `0`；上层把 `0` 一律当「没探到、值得重试」，3 次之后判 `failed`（= 拒绝启动）。
       于是 **`absent` 对「exe 存在但没在运行」是不可达的** —— 而这是最常见的情形。
       实测 `charmap.exe` 没在运行时：`Activate = 0` → 重试 3 次（**2.4s**）→ `probe-failed` → **进程数 0 → 0**。
       带启动参数的条目（quark / WPS / 钉钉 / GamePP）走 `if (!args)` 直接跳过探询、
       文件夹 / URL / `shell:` 在 `activateRunningInstance` 里直接返回 `absent` ——
       所以「有的点开就能直接打开」，**差别在有没有启动参数 / 是不是文件系统路径，与 App 本身无关**。
    2. `Activate` 的后半段**也**返回 `0`：窗口找到了、`IsWindowVisible` 为真，但
       `SetForegroundWindow` 被 Windows 前台锁拒绝时 `return ok ? 1 : 0` → 0。
       上层读到 0 又当「没有窗口」，于是一个**明明在运行、窗口就在那儿**的程序也被判成
       「无法判定」→ 什么都不做。实测：`FindWindow = 7932662`（句柄有效、`visible=True`、非最小化）而 `Activate = 0`。
    ⇒ 合起来：**没在运行的点不开；在运行的也可能被判成「无法判定」**；只有带参数 / 文件夹 / URL 能直接打开。
  - **为什么之前的验证没抓到**：`activate-3state.cjs` 用例 1 用的是
    `C:\__no_such_app__\nope.exe` —— **路径都不存在**，那条路在 TS 层就被 `existsSync` 短路了，
    根本没进探询；真正要命的「exe 存在但没在运行」从没测过。
    `retry-logic.cjs` 的参考模型更把「3 次 retry → `absent`」（= 会启动）写成期望，
    而源码里是 `failed`（= 不启动）—— 两边语义从来就不一致。
  - **修法（三道）**
    1. **拆开返回值**：新增 `QLActivate.Probe`，四个码各表一态 ——
       `1` 在运行（已置前，或至少已把窗口抬起来）、`-1` 在运行但窗口隐藏（收托盘）、
       `0` 进程在但还没有带标题的窗口（可重试）、**`2` 根本没这个进程（唯一允许启动新实例的码）**。
       `absent` 从此可达：没在运行的程序**第一次探询就返回 2**，直接进启动流程，还省掉了 3 次重试的 2.5s
    2. **前台锁拒绝 ≠ 没有窗口**：`SetForegroundWindow` 失败时不再返回 0，改为
       `SetWindowPos(HWND_TOP) + BringWindowToTop` 把窗口抬起来，**仍返回 `1`**
       （程序确实在运行，绝不能再启动一个）
    3. **进程匹配加文件名兜底**：读 `MainModule.FileName` 对提权 / 受保护进程会抛异常
       （实测本机 273 个进程里 **148 个**读不到路径），只按全路径匹配会把**正在运行**的程序
       误判成「没在运行」→ 多开。现在同名进程也算「在运行」（安全侧）；
       只有全路径命中时才优先用它们的窗口
  - **实测**（`devtools/probe/runapp-four-states.cjs`：真实应用 + CDP 直接调 `window.api.runApp`）
    | 用例 | 修前 | 修后 |
    |---|---|---|
    | 没在运行 + 无参数 | `probe-failed`（2.4s）**进程 0 → 0，什么都没发生** | `true`（878ms）**进程 0 → 1，真的起来了** |
    | 已在运行 + 无参数 | `probe-failed` | `true`（848ms）**进程 1 → 1，不多开** |
    | 没在运行 + 带参数 | `true`（跳过探询） | `true`（不变） |
    | 文件夹 | `true` | `true`（不变） |
    负向对照：把构建产物里的 `case 2: return 'absent'` 改回 `'retry'`，用例 1 立刻退回
    `probe-failed` + 进程 0 → 0（精确复现用户报障）—— 说明这条断言真的守得住
  - 附带：`probe-failed` 的菜单提示改为「程序已在运行但还没出现窗口：为避免多开，请稍等再点一次」——
    现在它只剩这一种情形了（原来那句「没能确认是否已在运行」其实是在替这个 bug 背锅）
  - ⚠️ **教训：一个返回值不要承载两种语义**。「没有窗口」与「没有进程」是**相反**的结论 ——
    前者必须什么都不做（多开就是登录窗），后者必须启动。挤在同一个 `0` 里，就注定有一条路走错。
    另外这条路径的输出解析也一并换成标记式（`STATE=<code>`），理由同 ㉟

- **㊲ 点 Clash Verge 这类「托盘型应用」永远打不开 —— `failed` 态改成 fail-open（v1.13.8 修，用户反馈）**
  - **现象**（用户报障原话 + 主进程日志）：
    `[launcher] 无法判定目标是否在运行，为避免多开实例而放弃本次启动: E:\ClashVerge\Clash Verge.exe`
    —— 点几次都不开；而带启动参数 / 文件夹 / URL 的条目一切正常。
  - **先证伪「是今天新改的那段代码搞坏的」**：在**那个状态下**实测（`devtools/probe/diag-clash-state.cjs`）——
    该进程的窗口清单里**只有**托盘窗口 / 无标题窗口 / 输入法辅助窗口，今天的 `Probe = 0`、`FindWindow = 0`；
    而**昨天**的 `Activate` 用的就是**同一套「只认有标题窗口」的判定**（路径匹配那一层也正常：WMI 能读到
    `E:\ClashVerge\Clash Verge.exe`、`pids=1`），所以它同样返回 `0` → 同样 retry 3 次 → 同样 `failed`。
    **两版行为一致 ⇒ 问题不在那次改动，而在「探不出结论就不启动」这条约束本身**（四态探询才是今天新增的）。
  - **真因**：Clash Verge 是 **Tauri 托盘型应用**，空闲时**根本没有主窗口**。实测本机（应用收在托盘）：
    ```
    pid=99776  cls=tao_system_tray_app      title=[]  visible=False   ← 只有托盘窗口
    pid=99776  cls=Tao Thread Event Target  title=[]  visible=True    ← 可见但无标题
    pid=99776  cls=MSCTFIME UI / IME                                  ← 输入法辅助窗口（本就跳过）
    ```
    `FindWindow` 只认**有标题**的顶层窗口（这是为了不把 Qt/Electron 的无标题辅助窗口置前），
    于是它永远返回 0 → `retry` ×3 → `failed` → 旧逻辑「不启动」→ **用户永远点不开它**。
    也就是说：「探不出结论就不启动」这条约束，在「目标连窗口都还没有」时**方向是反的** ——
    此时启动才是唯一能拿到窗口的办法（单实例应用会自己把窗口显示出来）。
  - **修法**：`failed` 不再拦，**直接落到启动流程**（fail-open）。
    `running`（有窗口 → 置前，绝不新开）与 `tray`（窗口隐藏 → 点托盘图标唤出，绝不强行 `ShowWindow`）
    两条保护**原样保留**；同时删掉 `RunAppResult` 的 `'probe-failed'` 与 renderer 的那条提示分支。
  - **实测**（`devtools/probe/runapp-open-always.cjs`：真实应用 + CDP 调 `window.api.runApp`）：
    | 用例 | 结果 |
    |---|---|
    | Clash Verge（进程在、无窗口） | 返回 `true`（2.5s），**进程 1 → 1 不多开**，窗口标题 `""` → `Clash Verge`（真的出来了） |
    | 普通 exe 没在运行 | `true`，真的启动 |
    | 普通 exe 已在运行 | `true`，激活且不多开 |
  - ⚠️ **教训：安全约束要先算清「拦下来的代价」**。这里拦下来 = 用户 **100% 点不开**；
    放行的代价 = 极少数情况下多开一个实例 —— 而「窗口隐藏但确实存在」的微信/QQ
    早已被 `-1`（tray）那一态保护住。宁可偶尔多开一次，也不要让用户点不开。
    另外：报障时**先用同一输入对比新旧两版行为**，能立刻分清「今天的改动」还是「既有设计」——
    这次就是靠这一步避免了一次方向错误的大回退

- **㊳ 按用户要求：把「点图标先探询」整个关掉，启动逻辑退回 v1.13.4（v1.13.8）**
  - **背景**：v1.13.5 引入、v1.13.6 扩成四态的这套探询，遇到「进程在、但没有主窗口」的目标
    （Clash Verge 这类 Tauri 托盘应用）必然判 `failed`；即便按 ㊲ 改成 fail-open，每次点击仍要先花
    约 0.9s 探一次。用户明确要求**回到 v1.13.4 的行为：点图标一律直接启动**。
  - **做法：一个开关，代码不删**
    ```ts
    const PROBE_BEFORE_LAUNCH = false   // ← 唯一需要改的一行
    ```
    `run-app` 里整段探询被这个常量短路；`false` 时打包器会把 `ACTIVATE_CS` / `probeTargetState` /
    `clickTrayIconFor` **整段静态消除**——实测构建产物 `out/main/index.js` 里这三个名字的命中数都是 **0**，
    运行时行为与 v1.13.4 完全一致（`run-app` 第一件事就是收起 Dock 然后 spawn）。
  - **实测**（`devtools/probe/runapp-open-always.cjs`：真实应用 + CDP 调 `window.api.runApp`）
    | 用例 | 结果 |
    |---|---|
    | Clash Verge（进程在、无窗口） | `true` **10ms**，窗口真的出现，进程 1 → 1 |
    | 普通 exe 没在运行 | `true` **6ms**，真的启动 |
    | 普通 exe 已在运行 | `true` **4ms**，进程 1 → 2（**会多开一个 —— 这就是 v1.13.4 的既定行为**） |
  - ⚠️ **代价（用户已知悉并选择）**：微信 / QQ 收在托盘时再点图标会**多开一个实例（弹登录窗）**，
    这正是 v1.13.5 当初要解决的问题。想恢复那套保护：把上面那行改成 `true`，再 `npm run build`。
  - ⚠️ **开关只对源码有效**：`false` 时探询代码被静态消除，直接改 `out/main/index.js` 是没用的。
  - 配套：`runapp-four-states.cjs` 会先检查构建产物里有没有探询代码，没有就打印说明并跳过（退出码 0）；
    `flip-e2e.cjs`（桌面图标文案）不受影响，仍然 7/7

#### 本次审计用的探针脚本（都在 `devtools/probe/`，已被 `.gitignore` 忽略）

跑法统一为 `node_modules/electron/dist/electron.exe devtools/probe/<名字>.cjs`：

| 脚本 | 作用 |
|---|---|
| `ui-probe.cjs` | 全量 UI 行为探针（42 项断言）+ 截图输出到 `probe/out/` |
| `nav-deterministic.cjs` | 键盘导航确定性验证（16 项，含「恢复上次位置」） |
| `sink-logic.cjs` | 沉底补偿逻辑五场景 + 串行重试验证 |
| `runas-check.cjs` | 从源码提取 run-as-admin 脚本，在真实 PS 上验证参数校验 |
| `batch-size.cjs` / `ps-checks.cjs` | maxBuffer 阈值、图标体积、Start-Process 校验 |
| `verify2.cjs` / `special-into-group.cjs` | 分隔线落点错位、入组字段污染 |
| `reorder-cache.cjs` / `final-probe.cjs` / `top-menu-diag.cjs` | 几何缓存通道、Dock 几何、顶部菜单锚点 |
| `centering-all-edges.cjs` | **三档停靠位置下的垂直居中一致性**（衬底/图标在玻璃条内的上下留白，附带每档截图） |
| `scroll-check.cjs` | **横向滚动的可达性**（滚轮左右滚、`scrollWidth`、第一个图标能否回到可视区） |
| `stack-variants.cjs` | **分组缩略图的 6 种候选样式**并排渲染 + 1x 截图，用于选型（层叠卡片就是这么定下来的） |
| `badge-geometry.cjs` | 徽标与缩略图/单图的重叠面积，覆盖 1/2/3/4/8 五种成员数 |
| `payload-loss.cjs` | **落盘往返**：模拟真实 shortcuts.json + 桌面扫描合并，核对 groupId/specialType 等字段是否存活 |
| `themes.cjs` / `themes-1x.cjs` | 三种主题逐一渲染 + 取配色变量（**按层拆解 background-image**，别只看第一层） |
| `menu-fonts.cjs` | 「+」菜单字体候选对比（**不要再设 `zoomFactor`**，会按源污染后续所有探针） |
| `runapp-timing.cjs` | **`run-app` 返回值时序**：证明原实现 ~1ms 就返回 true、而 ENOENT 要 ~400ms 后才到 |
| `runapp-fixed.cjs` | 同上，验证修好后 handler 能等到 spawn 结果（false / true 各一例） |
| `visibility-state.cjs` | **弹出/消失状态机**的 5 个场景（正常回滚 / 用户已唤回 / 第二个应用已启动 / URL 失败 / UAC 取消） |
| `wechat-launch.cjs` | 实测 `execFile` 与 `Start-Process` 对微信是否新开进程（结论：都会，与启动方式无关） |
| `ActivateProbe.cs` | 验证「ShowWindow + AttachThreadInput + SetForegroundWindow」能否把托盘里的微信唤出 |
| `activate-real.cjs` | 从**构建产物**抠出真实 `ACTIVATE_CS` 再跑，确认激活成功且进程数不变 |
| `tray-bom.cjs` | BOM+.ps1 方案的托盘点击（连跑两次）；`tray-v2.cjs` 树遍历法；`uia-diag5.cjs` 证明「遍历 35 个、精确命中 1」 |
| `flip-test.cjs` | 桌面图标文案零翻转（含「异步读全失败」的极端情形；⚠️ 用的是**模拟 IPC**，测不出 PowerShell 输出解析类 bug） |
| `flip-e2e.cjs` | **桌面图标文案端到端（v1.13.8 补）**：起真实应用 + CDP 点菜单项，核对「系统注册表真值 ↔ 菜单文案」是否同步翻转，并断言主进程没有 `toggle read failed`；退出码 0/1 可直接进 CI |
| `runapp-four-states.cjs` | **点图标的四态端到端（v1.13.8 补）**：真实应用 + CDP 调 `window.api.runApp`，四个用例（没在运行/已在运行/带参数/文件夹）逐一核对返回值**与进程数**（尤其是「没在运行 → 必须真的启动」）；退出码 0/1 |
| `runapp-open-always.cjs` | **「点了必须能打开」端到端（v1.13.8 补）**：重点用例是 Clash Verge 这类**空闲时没有主窗口**的 Tauri 托盘应用（进程在、窗口为空），核对返回 `true` **且窗口真的出现**、进程数不爆炸；退出码 0/1 |
| `diag-clash-state.cjs` | 把同一个目标路径同时喂给「今天的 `Probe`」与「昨天的 `Activate`」，用**同一台机器的同一状态**证明两版行为一致（排除「是今天改坏的」） |
| `menu-version.cjs` / `menu-geom2.cjs` | 版本号文案与 computed 样式 / 菜单几何与裁切判定 |

#### ⚠️ 探针环境里一个查了很久的坑：`devicePixelRatio` 会漂成 3

写这一轮时花了不少时间在一个**假问题**上，记下来免得重蹈：

- 现象：`ui-probe` 的浮层几何断言突然全挂，探针里 `innerWidth=400 / innerHeight=100 / devicePixelRatio=3`；
  主题截图也整体偏大。连续排查了「zoom 持久化」「独立 userData 没生效」「窗口尺寸没被尊重」等若干假设，都不成立
- **真相**：真实应用窗口里实测是 `vw=1200 / vh=300 / dpr=1.25`（显示器 2048×1152 @125%），**一切正常**；
  是**探针进程**的 DPR 漂到了 3，导致同样的 1200×300 窗口只报告 400×100 CSS 像素
- **代价**：期间一度怀疑是自己改的字体/玻璃 CSS 把布局搞坏了 —— 差点去回滚一个**本来正确**的改动
- **对策（已落地）**：
  1. `regression.cjs` 与 `ui-probe.cjs` 都加了**视口自检**：`vw < 1000 || vh < 250` 就当场停下并报
     「断言不可信」，绝不输出误导性结论（宁可失败，也不要假通过/假失败）
  2. 关键改动一律**再用真实应用复核一次**（临时钩子读 `innerWidth`/几何/字体再删掉），不只看探针
  3. 探针里**不要设 `zoomFactor`**：Chromium 按**源**持久化 zoom，会污染之后所有同源探针
| `label-check.cjs` / `visual-check.cjs` | 悬浮标签是否被容器裁剪、真壁纸下的居中肉眼复核 |

**探针本身踩过的三个坑**（写在这里省得下次重踩）：
1. **React 19 的事件委托挂在 `#root` 上** —— `document.dispatchEvent(new KeyboardEvent(…))` 不会被收到，必须在 `document.body` 上派发。第一版探针因此报了 4 个假失败
2. **`onMouseEnter`/`Leave` 是 React 用 `mouseout`/`mouseover` 合成的** —— 直接派发 `mouseenter` 事件不会触发，必须给出正确的 `relatedTarget` 序列
3. **切停靠位置必须走 `dock-edge-changed` 事件**，不能直接改 DOM 上的 `data-edge`：React 的 edge state 没变，之后任何一次重渲染都会把属性改回去，浮层锚点按旧布局算 —— 于是量到「顶部布局下菜单在窗口外」这种假 bug

### v1.13.0 (2026-09-19)

**主 Dock 玻璃条宽度随图标数量伸缩**（用户要求：图标少时两端不该留大片空白，应像分组面板一样随数量涨大，到上限才开始滑动）

- **改动前的行为**：玻璃条恒定占满窗口（85% 屏宽 ≤ 1200px），图标少时两端是两条很长的空玻璃，观感像是「没填满」
- **改动后**：DOM 变成 `.app > .dock > .dock-bar > (.dock-bg, .dock-inner, .dock-edge ×2)`，两层分工
  - `.dock` 退化为**纯定位与拖放命中层**（`width: 100%` 占满整窗，`padding: 8px 24px`），不再决定玻璃条宽度
  - `.dock-bar` 是玻璃条本体：`width: max-content` + `max-width: calc(var(--dock-vw) - 48px)` —— 图标少时收缩到刚好看得下，一路长到上限后由 `.dock-inner` 横向滚动
  - **窗口尺寸始终不变**（透明窗口 resize 会白闪），变的只是这一层；与分组面板 `.group-panel` 同一套做法
- **实测**（真实 Chromium + 真实构建产物 CSS，逐个数图标量宽度）：

  | 图标数 | 0 | 4 | 16 | 20 | 30 |
  |---|---|---|---|---|---|
  | `.dock-bar` 宽度 | 32px | 284px | 1052px | **1154px（封顶）** | 1154px |
  | 可滚动 | 否 | 否 | 否 | **是**（内容 1308） | 是（内容 1948） |

- **两个坑（都已修，写进 `CLAUDE.md`）**：
  - **上限不能用 `100vw`**：实测本窗口里 `window.innerWidth` 是 **1202**（窗口设的是 1200），`100vw` 跟着它走 → 玻璃条会多出 2px 溢出可用区。改为 renderer 把 `window.innerWidth` 写进 `--dock-vw`（写在 `.app` 根元素、随 resize 更新），CSS 用 `calc(var(--dock-vw, 100vw) - 48px)`
  - **`--dock-vw` 必须在探针里也补上**，否则量到的是 `100vw` 兜底值——第一版探针就因此「看起来通过、其实测的是另一条路径」
- **附带修掉一处不一致**：`.dock` 占满整窗，图标少时条两侧的透明区也在 `.dock` 内 → 原来**在空白处松手也能添加文件，但那里不显示插入线和禁止光标**。现在拖放命中区按 `.dock-bar` 算（`dragover` 用 `elementFromPoint` 判断，`drop` 再用 `dockBarRef` 兜一道）
- `.dock-bg` / `.dock-edge` 的左右偏移由 `24px` 改为 `0`（原先那 24px 是 `.dock` 的 padding，现在定位基准已是 `.dock-bar`）；`.dock-inner` 去掉冗余的 `max-width: 100%`（限宽只由 `.dock-bar` 负责）
- **回归验证脚本**：`node_modules/electron/dist/electron.exe devtools/probe/probe-main.cjs`（起本地 HTTP 服务引用真实构建产物 CSS —— **必须 HTTP，不能 file://**：探针页与构建产物不在同一目录，file:// 下属于不同不透明源，样式表会被判跨源而**静默不生效**，第一版探针就因此量到「没有样式」的全宽）

**统一图标：全项目改用同一枚 SVG 绘制的图标**（用户要求：统一各处图标、重新用 SVG 绘制、必须清晰）

- **形象重新设计**：蓝色圆角方块（`#3B7BD5`，圆角 54/256）上叠**三块白色瓷砖**。蓝块 = Dock 的玻璃条，三块瓷砖 = 停在上面的一格格快捷方式
- **两枚图标完全一致**：主图标（`icon.ico`）与托盘图标（`tray-icon.ico`）由**同一份 SVG** 生成，并在 6 个共同尺寸上**逐像素相同**（`verify-icons.mjs` 校验）。此前两者是两个不同形象（2×3 六块 / 蓝块+加号），这正是「图标不统一」的来源
- **SVG 成为唯一真相源**：新增 `resources/icon.svg` 与 `resources/tray-icon.svg`（两者必须逐字节相同，生成器内含哈希校验，不一致直接报错退出）。ICO 全部由脚本生成，不再手改
- **零依赖的光栅化**：新增 `devtools/make-icons.mjs`——按**圆角矩形的解析覆盖率**逐尺寸独立渲染。不做超采样、也不从 256 缩下来，所以 16px 的边缘是算出来的。刻意**不引入** sharp/resvg/canvas，也不用 Electron 截图（本机没有这些库，且引依赖只为一枚图标不划算）
- **尺寸是「从像素网格反推」出来的，不是审美数字**：16px 画布只有 16 格，结构极其有限。实测淘汰了三套方案（`final-check.mjs` / `try-icons*.mjs` 可复现）：
  | 方案 | 16px 实测 | 结论 |
  |---|---|---|
  | 2×2 / 2×3 网格 | 白色连成一片 | ❌ 结构全丢，读成一个白方块 |
  | 三条**横**线 | 分得开 | ❌ 满宽横线 + 0.24 长宽比 = 标准「汉堡菜单」，语义跑偏 |
  | 竖块但间隙 12 | 隙仅 0.75px，抗锯齿糊平 | ❌ 又是白方块 |
  | **竖块 条48/隙32** | `B WWWW B WWWW B WWWW B`（隙 2px 完整保留） | ✅ 现行 |
- **方法论教训**：判断小尺寸可读性的正确判据是**「间隙里是否真的还留有底色」**，而不是数「浅色连通块个数」——抗锯齿会产生浅蓝像素，按后者会把已经糊掉的方案误判为通过（这个错在本轮中确实犯过一次，差点定稿了一个 16px 下是白块的方案）
- **档位调整**：主图标 9 档（16/20/24/32/40/48/64/128/256，4486 B）；托盘 6 档（16/20/24/32/48/64，1167 B）。托盘去掉 256 档——通知区物理最大 32px，再大的永远取不到
- ⚠️ **改图标一律不要用 PowerShell 的 `Set-Content`/`Get-Content`**：本轮生成器脚本被这样改过一次，中文注释全部 mojibake 且行被合并成语法错误（`return outside function`）。这是项目既有那条 PowerShell 编码坑在脚本文件上的又一次实例，已写进 `CLAUDE.md`

### v1.12.3 (2026-09-15)

**修复：启动一个条目后的 700ms 内点别的条目会被静默吞掉（用户实测反馈：「分组里点软件有时不消失到后台」）**

根因是 v1.12.0 加的「防连点」守卫用了一个**全局时间戳** `lastRunAtRef`：

```js
if (now - lastRunAtRef.current < 700) return   // ← 与「点的是哪个条目」无关
```

于是启动 A 之后的 700ms 内点 B 会被直接 `return`：**既不启动、也没有任何反馈**。用户看到的就是「Dock 没消失、软件也没起来」——分组面板里连点几个成员时尤其容易撞上（启动 A → Dock 隐藏 → Alt+Space 唤回 → 点 B，中间往往不到 700ms）。

而这个守卫本身就是多余的：主进程 `run-app` 的**第一件事**就是 `mainWindow.hide()`（在 `CreateProcess` 之前），窗口随即消失、根本来不及被点第二次。它真正需要挡的只是「同一次点击被派发两遍」（合成双击 / 鼠标抖动）。

- 改为**按启动目标分别计时**（`Map<targetPath, timestamp>`，窗口收到 600ms）
- **实测验证**（独立脚本，四个场景）：点 A 后 200ms 点 B —— 旧逻辑 B 被丢弃（复现现象），新逻辑 A/B 都启动；同一图标 40ms 内点两下 —— 仍被挡住（防连点有效）；同目标隔 700ms 再点 —— 允许（不会永久锁死）；分组面板里每 120ms 连点 4 个不同成员 —— 4 个全部启动

**优化：不再打包 `node_modules`（asar 145.7 MB → 138.41 MB）**
三个产物**都不在运行时 require 第三方包**——main 只依赖 `electron` + Node 内置模块（`child_process`/`fs`/`path`），preload 只依赖 `electron`，renderer 由 Vite 把 `react`/`react-dom` 全量打进 bundle。实测 asar 里的 `node_modules`（react/react-dom/scheduler）**7.2 MB 纯属白占体积**，已在 `electron-builder.yml` 里整目录排除。安装包 232.6 → 232.0 MB。
⚠️ 本项目目前**没有任何运行时依赖**，所以整目录排除是安全的；将来若真要用外部/原生模块（例如加 sqlite），必须去掉 `!node_modules/**`，否则那个包不会被打进产物。

**其他：文件夹预览缓存上限收紧**（主进程里最大的可变内存块）
`FOLDER_CACHE_MAX` 40 → 24、`FOLDER_ICON_LIMIT` 150 → 96（卡片一屏约 20 行，96 个够滚四屏以上）。每减少一个缓存目录就少一份「上百个图标 data URL」的常驻，也少一份 `folder-icons` 事件的跨进程拷贝。

**内存占用的实测分析（回答「为什么内存这么高」，结论：没有泄漏，是 Electron 稳态开销）**
排查了所有「会持续吃资源」的嫌疑，全部排除：

| 嫌疑 | 实测结论 |
|---|---|
| 常驻重绘 | `dock-sweep` 是 `animation-play-state: paused`（仅 hover 时跑）；`ql-spin`/`ql-shimmer` 只存在于「加载中」元素里，卡片关掉即卸载；没有任何常驻 `rAF` 循环 |
| 软件渲染回退 | 代码里**没有任何** `--disable-gpu` / `swiftshader` / `appendSwitch`，走的是正常 GPU 合成 |
| 图标字符串 | 33 个条目共约 79 万 base64 字符 → main + renderer 各约 1 MB，量级可忽略 |
| 目录列表缓存 | 收紧后约 3 MB 量级 |

所以 215 MB（任务管理器里 4 个进程的**合计**）基本就是 Electron 的固定成本：一个 `transparent: true` + 全屏宽 `backdrop-filter: blur(36px)` 的常驻置顶窗口，Chromium 必须为它维持合成层、并逐帧对「窗口背后的桌面」做模糊采样——透明窗口没有不透明快速路径。**0.1% CPU 也印证了这是稳态、不是泄漏**（若真在泄漏，CPU 与内存曲线会持续爬升）。
可选（未做，属观感取舍）：把 `blur(36px)` 降到 24px、或去掉 `transparent` 改成不透明窗口配截图背景——都能换来明显的内存/合成开销下降，但会改变现有的毛玻璃观感，需要确认后再动。

### v1.12.2 (2026-09-13)

**修复 v1.12.0 引入的严重回归：文件夹图标永久空白（测试机实测 + 独立问题报告）**
现象：Dock 里「此电脑」「回收站」正常，但文件夹条目（如 `D:\Desktop\test`）图标是一块空白；落盘的 `shortcuts.json` 里该条目 `iconDataUrl` 长度为 **0**；**重启不恢复、删了重加才会好**。

根因是 v1.12.0 那个「共享文件夹图标哨兵」的设计缺陷，三个环节互相咬死：

1. `mergeDesktopScan` 给桌面文件夹存的是哨兵串 `ql-shared-folder-icon`，**把主进程刚提取好的真图标直接丢了**（`f.specialType ? f.iconDataUrl : FOLDER_ICON_SENTINEL`）
2. 而哨兵要靠模块常量 `sharedFolderIcon` 还原，它**只有一个赋值点**——加载时从磁盘上找一个「带非空图标的文件夹条目」。全新安装时 `shortcuts.json` 不存在、存量用户若恰好在扫描前把文件夹删了，这个常量就一直是 `""`
3. 于是保存链路 `realIcon(哨兵)` → `""`，**把空串写进磁盘固化**；下次加载时 `find(a => a.isFolder && a.iconDataUrl)` 又命中不了空串 → 下一轮继续写空串。`app.asar` 里的主进程还原逻辑（`lastFolderIconDataUrl` 只在 `startsWith('data:image/')` 时记录）同样救不了空串

**结论：首启即损坏、且永久自锁。**

修复（按「别再引入中间态」的思路重做，不是打补丁）：

- **撤掉哨兵**：文件夹条目直接存主进程给的**真实 data URL**。v1.12.0 想省的是「N 个文件夹各存一份 base64」，实测（60 个文件夹）这笔优化总共只值：结构化克隆 0.11ms、`JSON.stringify` 0.19ms、磁盘 152KB——而且 V8 会把内容相同的字符串内部化，**renderer 侧的真实堆增量 ≈ 一份图标而不是 N 份**。为这点收益引入一个「会自锁成空值」的中间态，完全不划算
- **顺带自愈历史坏数据**：启动同步（load → prune → scan）结束后调用 `repairEmptyFolderIcons()`，用扫描回来的共享图标**回填空值条目**，然后由防抖保存写回磁盘。**用户不需要删配置、不需要重装**；已有有效图标一个都不碰（有断言覆盖）
- 主进程 `save-shortcuts` 回归「不碰任何字段」：删掉 `FOLDER_ICON_SENTINEL` / `lastFolderIconDataUrl` 与整个 `writeShortcuts` 遍历换算。**教训：写入路径上的「换算」必须以「换算不出来会怎样」为前提设计**——这个哨兵的失败模式是「写坏数据」而不是「少写数据」，代价差一个量级
- **报告附带发现一并修复**：`parse-lnk` 的文件夹分支写死 `GetIconBase64(shell32.dll, 4, 256)`，漏了 v1.12.0 的尺寸收口，导致同一张黄色文件夹图标出现 256/48 两种 base64 并存 → 改用 `FOLDER_ICON_SIZE`

**验证**（独立脚本，按报告取证数据建模：此电脑 3602 / 回收站 4594 / 文件夹图标 2586 字符）：

| 场景 | v1.12.1 | v1.12.2 |
|---|---|---|
| 全新安装首启 | 渲染 `0` 字符（空白）、落盘 `0`（固化空串） | 渲染 `2586`、落盘 `2586` |
| 用坏数据重启 1/2/3 次 | 恒为 `0`（自锁，复现成功） | 启动修复回填 → `2586`，写回磁盘 |
| 正常存量用户 | — | 既有图标与两个系统位置图标**原样保留**，新扫描条目带真图标 |

`npm run typecheck`、`npm run build` 通过。

### v1.12.1 (2026-09-13)

**修复 v1.12.0 引入的回归：Dock 横向滚动后，悬停放大命中偏左（用户实测反馈）**
现象是「鼠标移到后面的图标，图标动画却显示在前面的图标上；前面（还没滚动到的部分）正常」。根因是 v1.12.0 的几何缓存**用混了两套坐标系**：

- `measureCenters()` 量的是 `rect.left - 容器.left`，这是**视口坐标**（相对容器可见左缘，随滚动变化）
- `magnifyAt()` / `calcDropIndex()` 算的是 `clientX - 容器.left`，这是**内容坐标**（不随滚动变化）
- 两者只在 `scrollLeft === 0` 时相等。Dock 一滚动，命中就整体偏左 `scrollLeft` 像素——偏移量正好是「显示在前面的图标上」的那个距离，**图标越多越需要滚动、偏得越多**，所以表现为「前面还好、后面不对」

修复：两处统一到**内容坐标**——`measureCenters()` 量中心点时 `+ container.scrollLeft`，`magnifyAt()` / `calcDropIndex()` 算光标位置时同样 `+ container.scrollLeft`。因为走的是相对量，滚动时不需要重新测量，缓存依旧只在布局变化时重建（性能收益不变）。

- **验证**（独立脚本，模拟 1500px 屏 / 1200px Dock 窗口 / 19 个图标溢出 126px 的真实几何）：6 个不同 `scrollLeft`（0 / 1 / 37 / 63 / 125 / 126）× 容器内逐像素共 **6,918 个采样点**，断言「放大集合恰好等于光标 ±140px 内的图标」全部一致；同一批采样点上 v1.12.0 的旧算法有 **4,259 个**不一致。极端位置对照：光标停在容器右端时，修复后放大 `[15..19]`，v1.12.0 因越界导致放大集合为空（一个图标都不亮）
- 同类隐患一并自查：`calcDropIndex()`（拖拽插入线、拖入文件落点）在 v1.12.0 里用了同样的错误算法，滚动后插入位置会偏——已同步修正
- `npm run typecheck`、`npm run build` 通过；重新打包出 `QuickLaunch Setup 1.12.1.exe`

### v1.12.0 (2026-09-13)

**性能与资源占用专项**（用户要求：检查 bug 与逻辑、优化内存、减少资源消耗与卡顿）。所有量化结论都来自实机实测，不是推断。

- **放大效果不再「逐图标读写交替」（鼠标划过 Dock 卡顿的主因）**：原实现每个 `mousemove` 都对**每个**图标 `getBoundingClientRect()`、紧接着写 inline `transform`——读-写-读-写交替触发强制同步布局（layout thrashing），每次移动都要为全部图标各做一次布局读取 + 一次样式写入。改为**几何缓存 + 影响范围**：
  - `measureCenters()` 只在整个布局变化时量一次，把各图标中心点存成**升序数字数组**；鼠标移动时在数组上二分定位，再只遍历左右各 140px 内的一小段（60 个图标时单帧最多触及 **6 个**，原来固定 60 个）
  - 失效走两条通道：① 显式 layout effect（`apps.length` / 主题 / 停靠边 / 分组开关）② `ResizeObserver`（DPI 缩放、面板撑宽等「尺寸变了但依赖没变」的情况）。**不能只靠 `ResizeObserver`**：图标增删只改变内容排布、容器盒子尺寸不一定变，观察者不会回调
  - 观察者挂在 **ref 回调**里（`useEffect` 在 ref 回调之后才跑，挂载帧会漏掉），且 `ResizeObserver` 挂上去**没有初始通知**，必须显式补测一次——否则启动后第一次悬停没有放大效果
  - `applyZoom()` 用 `WeakMap` 记住上次写入的缩放值，值没变就**完全不碰 DOM**（原来每帧无条件写 transform + zIndex）
  - **等价性实测**：把新旧算法抽出来在 145,200 个光标位置 × 6 种图标数量（0/1/2/5/20/60）上逐点比对，缩放值完全一致
- **鼠标移动不再触发整树重渲染**：`handleDockMouseMove` 原来每次移动都 `setNavId(null)`，即使值已经是 `null` 也会让整个 `App`（含全部图标、标签、分组拼图、面板成员）重渲染一遍；改用 `navIdRef` 判断，只在该清的时候才 setState。拖拽落点换算 `calcDropIndex` 也复用同一份几何缓存，不再每次重新量全部图标并排序
- **沉底不再空烧 PowerShell 进程**：实测 `powershell.exe -NoProfile -NonInteractive -Command <WinZ 脚本>` 单次 **690~785ms** CPU 时间（进程启动 ~450ms + .NET 运行时 + `Add-Type` 编译 C# ~250ms），每次还额外占几十 MB 私有内存。新增**沉底宽限期**（`SINK_GRACE_MS = 2500ms`）：Dock 刚显示出来（启动 / 重建窗口 / Alt+Space 唤回 / 恢复显示）后的失焦一律是焦点抖动，直接跳过；`blur` 的 120ms 复核里也补上 `dockTrayHidden` / `canSinkNow()` 判定——`run-app`、`open-path`、`run-as-admin` 隐藏 Dock 时新增 `sinkSeq++`，让这条路上的 PowerShell 完全不会被起起来
- **保存不再「每帧全量序列化」**：原来 `apps` 每变一次就立刻 `saveShortcuts(apps)`——拖一次图标（每帧一次变更）等于几十次跨进程结构化克隆 + 几十次 `JSON.stringify` 整个数组 + 几十次磁盘写入。改为 **400ms 防抖**；退出时主进程 `before-quit` 推 `flush-pending-save` 并留 200ms 让 renderer 落盘（`will-quit` 时窗口已销毁、IPC 不通，用它兜底是无效的），renderer 卸载时也会 flush 一次
- **共享文件夹图标：N 份 base64 → 1 份**：桌面扫描出的文件夹图标对每个条目都是同一张图，但每个条目各存一份字符串，于是 renderer 状态、每次 IPC（load/save/scan/check）、`shortcuts.json`、每次保存的序列化里都有 N 份。改为状态里存短哨兵 `ql-shared-folder-icon`、渲染时换成共享常量（JS 字符串按引用传递，全应用只留一份）；**磁盘格式不变**——主进程写盘前把哨兵还原成真实 data URL，加载时再归一化回哨兵（旧文件、手改文件都照旧可用）。实测 30 个文件夹的图标字符串占用 **118 KB → 5 KB**
- **PowerShell 图标尺寸 256px → 64px（文件夹 48px）**：Dock 图标 CSS 只有 44px、分组拼图 26px、预览卡片 17px，256px 的 PNG 每个 2~10 KB 纯属浪费（`SHDefExtractIcon` 还要多做一次高质量缩放）。数据同样要同时活在主进程状态、IPC、renderer state、磁盘四处，尺寸降一档是全链路省内存
- **`select-folder` 一次选 N 个文件夹不再起 N 个 PowerShell**：原来在 `map` 里逐个 `await extractIcon()`，选 20 个文件夹就是 20 个 `powershell.exe`（每个 ~500ms + 几十 MB）；改为复用常驻的那一枚共享图标
- **`list-folder` 的 fs 并发受限**：400 项目录原来 `Promise.all` 一次性把 400 个 `stat` 压进 libuv 线程池（默认只有 4 个线程），排队项连同闭包一起堆内存；新增 `forEachLimited`（并发 16 / 图标批次 8），总耗时几乎不变、峰值请求数降一个量级
- **目录列表缓存会清理过期项**：原来只在插入新条目时按插入序踢掉最旧一条，长期没有新目录进来时过期条目会一直挂着（每个 400 项目录带着上百个 base64 图标常驻）；改为先踢过期、再按上限踢最旧，并在每批后台图标推完后刷新保鲜期（打开着的卡片不会被误踢）
- **浮层渲染不再每次全量重算**：`groupIconMembersById`（分组缩略拼图/徽标）与顶层/成员列表改为 `useMemo`；文件夹卡片收 `folder-icons` 分批事件时先比对本批路径是否命中本目录，**整批不命中就直接返回原状态**（React 直接 bail out）——原来每批都对 400 行做一次遍历 + 建新对象
- **`elementFromPoint` 每帧最多算一次**：菜单「移出即关」的命中判定原来每条 `mousemove` 都强制一次样式/布局计算（高刷鼠标一秒几百条），改用 rAF 合并，判定结果不变
- **CSS 合成层与长列表**：`.dock-item` 的常驻 `will-change: transform` 改为仅 `:hover` 时生效（常驻会给每个图标留一个合成层，图标越多显存/内存越高）；文件夹卡片最多 400 行，每行加 `content-visibility: auto` + `contain-intrinsic-size: auto 26px`，屏外行跳过渲染，观感不变
- **修复的 bug**：
  - `run-app` 把「进程起来了但退出码非零」当成启动失败，会把 Dock 拽回来（很多应用/启动器带参数启动后立刻以非零码退出）。现在只有 `err.code` 是字符串（真正的 spawn 级失败：ENOENT/EACCES/EPERM/UNKNOWN…）才算失败
  - `run-app` 打开文件夹分支是 fire-and-forget：目标被删掉时 `shell.openPath` 明明返回了错误串，Dock 却已经收起；改为 await 并在失败时恢复显示
  - `fillFolderIcons` 先 `sender.send` 再检查 `sender.isDestroyed()`——对已销毁的 WebContents 调 send 本身就会抛错；改为先检查再发，且失效时先删缓存（缓存里的对象**已经被就地改过图标**，留着会让下次 `list-folder` 命中「半截图标」的旧数据而不再补批）
  - 启动失败恢复分支没调 `markDockShown()`（新增宽限期后会导致刚恢复的 Dock 立刻又能被沉底）
  - `parse-lnk` / `select-folder` / `pick-icon` 三个系统对话框打开期间，Dock 窗口仍可交互（能再点开菜单，把弹层状态搞乱）；统一收口到 `showOpenDialogSafe()`：`dialogOpen` 标记 + `disabled: mainWindow` 让对话框成为**真模态子窗口**
  - 连点启动：Dock 隐藏到托盘前用户容易多点几下，每次都会真的 `CreateProcess` 开一个新实例；加 700ms 启动节流 + 失败提示
  - `describe-paths` 用 `metas.find()` 逐个线性查找（O(n²)），一次拖入上百个文件纯属白烧 CPU；改为建索引
  - `select-folder` / `describe-paths` 的图标提取结果不再重复读取（一次提取、全条目共用）
  - 所有 PowerShell 调用补上 `-NonInteractive`（漏掉时脚本遇到交互式提示会挂到超时，白占一个进程），并统一收口到 `runPowerShell()` helper
  - `startedAtLogin` 是整进程常量，重命名为 `startHiddenAtLogin` 并只在 `whenReady` 用一次，避免后来者再次误用（v1.10.0 那次窗口消失事故的根因就是这个）
  - 桌面目录 `fs.watch` 在退出时不关闭；新增 `stopDesktopWatch()` 在 `will-quit` 收掉
- **验证**：`npm run typecheck`、`npm run build` 通过；放大算法等价性 145,200 个采样点逐点比对一致；哨兵持久化往返（旧文件 → 归一化 → 写盘 → 二次往返幂等 → 自定义图标不被误压）由独立脚本逐条断言通过

### v1.11.0 (2026-09-12)

- **修复：Dock 沉底竞态导致「唤不回来」**（用户实测反馈：首次启动后 Dock 先浮在浏览器上、很快沉下去，此后按 `Alt+Space` 卡住不动，只有最小化/回桌面才恢复）。根因是沉底本身是异步的——`blur` 里先 `setAlwaysOnTop(false)`，再由 PowerShell 调 `SetWindowPos(HWND_BOTTOM)`（每次新起 `powershell.exe` + `Add-Type` 编译 C#，实测滞后 200ms~1s）。这个窗口期内任何「把 Dock 拉回来」的操作都会与迟到的沉底打架，而原实现的补偿只在 PS 回调里判一次 `isAlwaysOnTop()`——**恢复路径恰好会把它设回 `true`，该判断恒真、形同虚设**。修复分四层：
  - **意图代数**：新增单调递增的 `sinkSeq`，`toggleWindow`（显示**与隐藏**两条分支）、`dock-pointer`、`focus`、启动失败恢复、`second-instance` 全部递增；在途沉底任务在启动前与回调里各比对一次，发现代际变化即整条放弃（不再去操作一扇已被 `hide()` 的窗口）
  - **串行化**：同一窗口已有沉底任务在跑时不再起第二个 `powershell.exe`，改为 180ms 后重试——「谁后到谁说了算」，最后一次失焦的意图仍会被满足
  - **统一恢复入口 `recoverDock()`**：置顶 + `moveTop` + 120ms 后再补一次（前台激活锁会拒绝首次激活），替换原先散落在 6 处的 `setAlwaysOnTop(true) + moveTop()`
  - **自愈巡检 `verifyDockOnTop()`**：实测发现 `moveTop()` 只把窗口提到「同一组内的顶部」、**并不重新断言置顶位**，且恢复后 `WS_EX_TOPMOST` 有约 300ms 处于 `False`。巡检在「窗口可见、未收进托盘、期间无新的让位意图」三个条件都成立却没拿到焦点时补一次置顶断言，最多 4 次；`blur` 分支另加 120ms 延迟复核（期间焦点已回到 Dock 就取消），并在 `ready-to-show` 后核实一次首次显示的 z-order
- **托盘图标改为多尺寸 ICO**（新增 `resources/tray-icon.ico`，16/20/24/32 每个尺寸原生绘制；旧的 16×16 `tray-icon.png` 已删除）：125% 缩放下托盘需要 20 物理像素、150% 需 24、200% 需 32，单尺寸 PNG 会被系统拉伸成模糊。图形为「蓝色圆角块 + 白色加号」——取应用图标的设计语言（同款蓝 `#3b7bd5`、同款圆角），但**为小尺寸重画**：原图标是 2×3 六个圆角块，缩到 16px 后每块只剩约 4px，糊成一片蓝斑。候选方案（单块/横条+3 块/两竖块/块+亮边/块+加号/半透明底+3 条）逐一渲染到真实 16px 比对后选定
- **玻璃条视觉**：顶部亮环（`inset 0 1px 0` 提到 `.22`）+ 底缘暗线、径向厚度高光（受光面在玻璃上沿）、渐变描边（`background-clip` 双层，非 `border-image`——后者会接管圆角且切片方向对上下边不可控）、底部冷色反射光、细噪点纹理抗色带、hover 才跑的 30s 缓移光带（`transform` 驱动不重绘模糊层，配 `prefers-reduced-motion` 与 `html[data-glass-fx='off']` 双开关）、黑夜色温微调、白天提高不透明度并拉开上下落差（`.92 → .74`）
- **图标与交互**：图标瓷砖加内描边与悬停顶部镜面、悬停投影加冷色辉光、图标本身改双层 `drop-shadow`；拖拽插入线从纯蓝硬边竖条改为两端淡出的胶囊（与选中框统一）；数字统一 `tabular-nums`、路径改等宽字体
- **浮层统一**：菜单/右键菜单/分组面板/卡片共用一档毛玻璃饱和度（`--glass-sat`，Dock 仍 1.7，浮层黑夜 1.4 / 白天 1.25），并清理了重复的 CSS 规则与「+」按钮那三处 `!important` 硬压色（收进主题变量后，白天主题的加号悬停方向也由「变亮」修正为「变深」）
- **空态与加载态**：空分组、未检测到驱动器、空文件夹、文件夹不可读都有了图标 + 主副文案（内联 SVG，不引图标库）；`读取中…` 改为转圈 + 三行骨架屏（骨架行与 `.folder-row` 同高 26px，真列表填入时不跳动）
- **透明模式文字可读性**（三种写法逐一实测后定稿）：废弃「单方向柔和白晕」（不够亮以形成轮廓，中灰/复杂壁纸上文字直接融进背景）与「四向硬晕 + 柔晕」（能看清但边缘发毛、观感发糊，用户要求去掉光晕），改为**白色描边** `-webkit-text-stroke` + `paint-order: stroke fill`——在字形背后画实心描边，零模糊、边缘锐利。粗细微调到 **0.65px**（小字号 0.5px）：描边骑在字形轮廓上画，**越粗笔画越细**，0.5 以下笔画开始缺、0.8 以上字形被吃掉一圈显虚；描边会随 `color` 继承给内联 SVG 图标，已在图标上单独清零。透明模式同时强制 `text-shadow: none`（基础 `.dock-label` 自带的深色投影与 hover 叠加层都会让悬停更糊）
- **窗口标题**：`index.html` 里脚手架残留的 `Electron React App` 改为「快捷方式面板」
- **验证**（实机 + CDP 实测，非推断）：修复前后对照确认 `WS_EX_TOPMOST` 在 sink→recover 后回到 `True`、sink→hide→show 序列同样回到 `True`；透明模式的 `-webkit-text-stroke` / `paint-order` / `text-shadow: none` 均以计算样式确认生效；描边与托盘图标候选均渲染到真实像素尺寸比对；`npm run typecheck` 与 `npm run build` 通过
- **已知问题（未修）**：`package-lock.json` 的 `version` 字段停留在 `1.1.0`（历史遗留，自 1.2.0 起就没跟上）。本次仅同步了 `package.json` → `1.11.0`；lock 文件需用 `npm install --package-lock-only` 重新生成（该命令会同时刷新依赖树，属独立改动，未与本次功能变更混合提交）

### v1.10.0 (2026-09-12)

- **文件夹悬停预览卡片**：鼠标悬停 Dock 上的文件夹条目 300ms 弹出预览卡片（复用「此电脑」盘符卡片的浮层几何与玻璃观感），直接列出目录内容——**目录优先**、中文/数字自然序、单次最多 400 项（超出在底部提示还有 N 项，请在资源管理器中查看），每行显示 shell 真图标 + 文件大小（目录不递归统计）；卡片头部是名称 + 完整路径 + 「N 个文件夹 · M 个文件」摘要 + 「打开」按钮（走新 IPC `open-path`，`ShellExecuteEx` 语义与资源管理器双击一致：目录开资源管理器、文档/图片交给关联程序）。鼠标移开 150ms 宽限后关闭（宽限期内移到卡片上即取消，可继续在卡片里滚动查看），拖拽排序/拖入文件进行中不弹（会挡住落点指示线）
- **预览性能（全程不起 PowerShell）**：枚举用 `fs.readdir`，文件图标用 Electron 内置 `app.getFileIcon`——进程内直接查系统 shell 图标，实测 20 个文件共 284ms（首次）/ 36ms（之后走系统缓存）；同等条件走 PowerShell 要 1.3s（光 `powershell -NoProfile` 启动就 ~900ms，再加 `Add-Type` 编译 ~250ms、每图标 ~12ms）。**首批 14 个图标在返回前就填好**，配合「鼠标刚碰到图标就开始列目录」的悬停预取，卡片弹出时首屏图标已就位；其余按 24 个一批后台补齐并推 `folder-icons` 事件**就地替换**（上限 150 个，再多显示中性占位块）。目录统一用启动时提取一次、常驻内存的标准黄色文件夹图标（shell32 index 4）——**不能对目录用 `getFileIcon`**：实测返回的目录图标是错的（`dist`/`node_modules` 变成「磁盘」、`.git` 变白纸）。同目录列表 5s TTL 缓存（上限 40 条）+ 在途请求 Promise 去重（悬停预取与 300ms 后的卡片打开会请求两次，不去重就整体跑两遍）
- **Dock 位置三档：中间 / 下 / 上**：位置选择器是「+」菜单里的分段控件（默认「中间」＝悬浮屏幕中央，上下都留出空间，悬停放大幅度不被屏幕边缘吃掉），选择后写入 `{userData}/window-position.json`——只存 `{"edge":"..."}`，文件名沿用（老配置里的 `x`/`y`/`displayId` 直接忽略，不报错）；左/右竖排（尺寸不同，下一阶段接）在读入与写入时都归一化回默认，防止手改配置文件改出竖排尺寸的窗口。**切换是原地换坐标**（`setBounds` + `dock-edge-changed` 事件，实测 ~62ms）：不重建窗口、不重载页面、无白闪；renderer 收到事件后只改根元素的 `data-edge` 翻整套布局（放大方向/标签药丸/两端渐隐遮罩/选中框 `transform-origin`/菜单与卡片的浮层锚点全部跟着翻转），页面重载过的 renderer 用 `get-dock-edge` 主动同步；首帧仍走 preload 读的 `--ql-edge` argv 常量，避免启动瞬间先画底部 Dock 再翻上去
- **取消窗口自由拖拽**：删掉整套 `-webkit-app-region: drag`（`.dock` 的 drag 区 + 10 处 `no-drag` 声明）与位移检测（`moved` 监听、debounce 保存、启动坐标校验 + 多显示器恢复）。原因：透明窗口里 Dock 栏要么贴窗口上沿、要么贴下沿，窗口位置一动就得补偿布局，实机表现为**明显跳动**（做过「边缘区域判定 + 拖动过程中不切位置 + 松手平滑收尾」也压不住），最终彻底改为**纯预设位置**——位置只能从菜单明确选择，不存在拖拽中间态
- **修复（第二轮代码审查 + 实机验证）**：
  - 开机自启会话里切位置会重建窗口，而 `ready-to-show` 判断的是整进程常量 `startedAtLogin`（该会话里恒为真）→ 重建出来的窗口一律不显示、Dock 直接消失进托盘；改为只看调用方传入的 `startHidden`
  - `list-folder` 把 Windows 目录联接/符号链接当成文件（junction 在 `Dirent` 上是 `isDirectory()=false` + `isSymbolicLink()=true`）——算进文件数、按文件排序、显示字节大小、图标也不对；改为对符号链接项补一次 `stat` 判定真身（断链仍按文件处理）
  - `open-path` 先隐藏 Dock 再打开目标：目标已删除或没有关联程序时 `shell.openPath` 返回错误串，用户看到的是「点了没反应、Dock 还消失了」；改为**打开成功后才隐藏**
  - `list-folder` 与 `run-app` 都先隐藏 Dock 的同类问题：`run-app` 启动失败（ENOENT 等）时目标没起来、Dock 却已收起，失败分支恢复显示 + 置顶
  - 切位置会重建窗口，`fillFolderIcons` 的 sender 随之失效，缓存里那批没图标的项会被当成「已完成的缓存」返回，卡片在 TTL 内永远只有占位块且没有补批会再来；改为 sender 失效时**删掉自己写的那条缓存**
  - 再选当前档位时 `setDockEdge` 的 ±2px 提前返回不再吞掉事件：页面重载过的 renderer 拿的是启动时的 argv 边，不重发事件它的布局会一直停在旧位置
  - 显示器参数变化（分辨率/缩放/增删显示器）后 Dock 不重新归位；`screen` 的三类事件统一重新套用当前位置——**必须在 `app.whenReady()` 之后注册**（提前注册会以 `The 'screen' module can't be used before the app 'ready' event` 直接崩在启动）
  - 右键菜单/「+」菜单打开时未清除键盘导航选中（`navId`），此时按 Enter 会启动看不见的选中项；开菜单即清选中，菜单打开期间 Enter 交给菜单
  - 顶部位置下选中框被裁：放大 1.4× 从图标顶端长出，`transform-origin` 仍是 `center bottom`；`data-edge='top'` 时改为 `center top`
  - 超大目录（>4000 项）用 `Intl.Collator` 排序会比较百万次、把主进程卡住数秒（卡片最多只显示 400 行）；超阈值退回廉价的字符串比较
  - 预览列表屏蔽资源管理器默认不显示的系统项（`desktop.ini` / `thumbs.db` / `$RECYCLE.BIN` / `System Volume Information`）
- **验证**（实机 + CDP 实测，非推断）：三档位置窗口坐标 (424,0)/(424,290)/(424,804)，玻璃条顶边 0/224/224，切换 6 次压力测试进程数恒定；整窗 `-webkit-app-region` 计算值为 `none`（拖拽确实不存在了）；页面重载后仍停在「上」；菜单打开时选中数为 0；顶部选中框未被裁；启动失败时 Dock 仍在；`--autostart` 隐藏启动 + 二次启动唤出可见；错误分支（不存在/无权限/非目录/空目录/网络路径）均秒回；`npm run typecheck` 与 `npm run build` 通过

### v1.9.0 (2026-09-11)

- **拖入文件即添加**：从资源管理器把 `.lnk`/`.url`/`.pif`/`.exe`/`.com` 拖到 Dock 栏即入 Dock——按落点插入（蓝色插入线预览）、按路径去重（重复或格式不支持则跳过并用提示胶囊汇报数量）。Electron 32+ 已移除 `File.path`，路径改由 preload 的 `webUtils.getPathForFile` 提供；新增 IPC `describe-paths`（快捷方式复用 `parseLnkFile`，exe 走**单次 PowerShell 批量**取 FileDescription + 图标，提取失败回退 shell32 通用图标，工作目录取 exe 所在目录）。仅 Dock 栏区域响应拖放，其余位置显示禁止光标；整窗拦截 `dragover`/`drop` 默认行为，避免 Chromium 把窗口导航到 `file://` 白屏
- **分组堆叠（Stack）**：新增 `isGroup` / `groupId` 字段（**扁平模型**，桌面扫描/缺失清理/持久化全部沿用原逻辑）。图标右键「新建分组」创建空组并自动横向滚到末尾；**分组图标默认渲染组内前 4 个成员的缩略拼图**（0 个成员回退 2×2 网格图标、1 个放大单图，用户换过图标则用自定义图标），右下角显示成员数徽标；把图标拖到分组图标上即归组、从面板拖回 Dock 条内即移出、删除分组＝解散（成员回顶层并保留相对位置）；分组编辑表单只留名称 + 图标。**面板是与主 Dock 同构的迷你 Dock**——条目直接复用 `.dock-item` 系列样式、悬停放大走同一个 `magnify()`、滚轮横向滚动用原生非被动监听，宽度随内容伸缩（超出窗口宽度才滚动）、高度固定
- **键盘导航**：`Alt+Space` 唤出 Dock 时进入导航模式（主进程推送 `nav-enter`）；`←/→` 不循环移动、`Enter` 启动、`Esc` 退出；分组上 `→`/`Enter` 展开面板并把选中移入第一个成员、`←`/`Esc` 返回主 Dock；可导航到末尾的「+」按钮（Enter 打开菜单）。**选中位置持久化到 localStorage**（`ql-nav-last`）——启动、Alt+Space 唤出、方向键「唤醒」都恢复到上次位置，条目失效则回落第一个。选中态为左右两条渐变竖框，并加 `scroll-margin` 保证从最右移回最左时左框不被裁
- **分隔线**：图标右键「在此之前插入分隔线」把 Dock 分成逻辑区段；`isSeparator` 条目可拖拽排序、随 `shortcuts.json` 持久化，不启动、不参与桌面扫描去重/清理/键盘导航/悬停放大。样式为 1px 渐变柔线（两端淡出、随主题变色），命中区 9px + `z-index: 20` 保证旁边图标放大时也能点中（右键→删除）
- **菜单交互重做**：菜单底边统一锚在**实测的** Dock 毛玻璃条上方 8px（右键菜单不再压进 Dock 栏）；水平锚点让光标落在菜单内侧 8px，垂直上移即可进入菜单；「移出即关」加三道防误关（必须先真正进过菜单本体、进入后 150ms 内的掠过不算离开、菜单外扩 24px 宽容区）；「+」菜单高度上限提升到 208px，内部滚动明显减少；**Dock 空白处右键不再弹菜单**
- **取消窗口 resize（根治透明窗口白闪）**：分组面板与菜单都改成固定高度的浮层后，删除了整套「窗口临时加高」机制（`set-panel-extra` IPC、`setWindowExtra()`、`baseBounds`/`panelExtra`、`moved` 守卫），并显式设置 `backgroundColor: '#00000000'`——应用运行期间不再有任何程序化窗口缩放，白闪从根上消失
- **修复（代码审查发现）**：
  - 启动时的「记住选中位置」从未生效——初始化 effect 读的是尚未镜像本轮的 `appsRef`，现改为显式传入当前列表
  - 拖入文件的落点插入混用了下标空间（顶层下标当扁平下标），存在分组成员时插入位置会偏「成员数」个槽位并破坏「成员紧跟分组」的区块结构
  - 键盘导航进入分组时可能选中分隔线（选中框无处渲染、`←` 变死键），记忆位置命中分隔线时同样会落到不可见选中
  - 分组缩略拼图与数量徽标把分隔线算了进去（空破图格 + 计数偏大）
  - 成员数徽标下沿被滚动容器裁掉 3px
  - 面板经鼠标移出/失焦关闭后，导航选中仍停在不可见的组内成员上
  - `load-shortcuts` 增加形状归一化：非数组返回 `[]`（否则 renderer 会抛未处理 rejection 并中断本轮桌面扫描），并把早期开发版的 `separator` 字段就地迁移为 `isSeparator`
  - `open-file-location` 的 `exec` 拼接前拒绝含 cmd 元字符的路径
  - `npm run typecheck` 修复为逐子项目检查（原 solution-style 配置下 `tsc --noEmit` 什么都不检查），并修掉被它掩盖的 3 个类型错误；`handleDockWheel` 改原生非被动 wheel 监听（React 在 root 上以 passive 注册，`preventDefault()` 原本是空操作）

### v1.8.1 (2026-08-23)

- **主题切换改分段选择器**：「+」菜单的主题循环按钮替换为**分段控件**（纯 flex，无绝对定位——嵌套滑块方案反复出布局问题后彻底重写）：主行「透明 | 毛玻璃」、毛玻璃激活时下方展开子行「黑夜 | 白天」；激活项自带底色高亮，**选择后菜单保持打开**可连续切换预览；毛玻璃态记忆子主题（切去透明再切回不丢）；配色经 CSS 变量随三主题自动适配
- **开机自启动开关配色统一**：开关指示器不再是固定 iOS 绿色，改为跟随主题强调色（`--switch-on-bg`/`--switch-on-knob`）——黑夜=白轨道+深球、白天=深轨道+白球、透明=深色 75% 轨道+白球，与下方主题分段选择器同一配色语言
- **透明风格可读性增强**：「+」加号不透明度提高至 0.92 并加**双层深投影**勾出轮廓（浅色壁纸上可见）；透明风格菜单保持全透明，文字用近黑 `#1f2430` + 白色光晕投影（浅色壁纸清晰，深色壁纸靠光晕托底）；编辑输入框浅白底 + 深字
- **标签统一悬停显示 + 各主题专属底衬**：三主题（黑夜/白天/透明）标签均默认隐藏、悬停图标时淡入（0.16s）；**标签改为 macOS 式悬浮在图标上方**（绝对定位，不再占用图标下方布局行——玻璃条紧凑贴合图标，下方不再留空白）；**完整显示名称不截断**（移除 72px 上限）；「+」添加按钮不显示悬浮标签；透明放大区由 44px 加高到 **70px**（悬停标签随 1.4× 放大一起上移，原 44px 区会被滚动容器裁剪）——`.dock-bg`/`.dock-edge` 的 top 同步对齐；每主题配自己药丸底衬（`--label-pill-bg`）：黑夜=深藏青 `rgba(12,16,28,0.55)`（白字）、白天=浅白玻璃 `rgba(255,255,255,0.75)`（深字）、透明=中性深灰 `rgba(0,0,0,0.30)`（白字）

### v1.8.0 (2026-08-22)

- **透明风格主题**：「+」菜单主题切换扩展为三态循环（黑夜 → 白天 → 透明 → 黑夜），透明风格下 Dock 背景完全透明——毛玻璃层、边框、阴影、两端渐隐遮罩全部不渲染，图标直接悬浮在桌面上；图标底衬透明（悬停时轻微底衬+外阴影提示可点击），**下拉菜单/右键菜单同步透明**（无毛玻璃与边框，保留悬浮投影 + 菜单项文字投影保证可读），标签/菜单沿用黑夜主题配色（白色标签+深阴影，任意壁纸可读），添加按钮加投影防止白底壁纸不可见；偏好持久化到 localStorage（`ql-theme` 支持 `transparent`）
- **快捷方式名称解析修复**：显示名优先级调整为「快捷方式自身描述 → 目标 exe 版本信息 → 快捷方式文件名 → 目标文件名」——wscript.exe 这类脚本宿主没有有意义的 FileDescription（此前会显示成「Windows Script Host」），现在引用快捷方式自身的描述（如「DeepSeek Harness」）
- **启动参数引号修复**：`run-app` 参数拆分改为 `splitArgs`（双引号包裹段作为整体并剥引号）——修复 `wscript.exe "E:\DSH\start-dsh.vbs"` 这类带引号参数的快捷方式点击时出现「Windows Script Host 执行失败（内存资源不足）」；顺带支持含空格的带引号参数
- **菜单配色统一**：黑夜/白天主题的下拉菜单与右键菜单背景改为**直接引用 Dock 渐变变量**（`--menu-bg: linear-gradient(180deg, var(--dock-bg-top), var(--dock-bg-bottom))`）——菜单与软件背景**同色同透明度**，仅靠毛玻璃与悬浮投影区分弹层
- **右键菜单扩展**：新增「编辑」（名称/启动参数/工作目录/更换图标——图标可从 exe/dll/ico/png 提取，png/jpg 直接读文件）、「打开文件位置」（`explorer /select` 定位）、「以管理员身份运行」（`Start-Process -Verb RunAs` → UAC 提权，仅程序条目）、「复制路径」（Electron clipboard）；新增 IPC `pick-icon` / `run-as-admin` / `open-file-location` / `copy-text`
- **多显示器支持**：记住 Dock 拖拽后的位置（`{userData}/window-position.json`，`moved` 事件 debounce 500ms 保存）；启动时恢复，坐标校验需落在某显示器工作区内（显示器移除/分辨率变化时回退主屏居中）
- **界面打磨（动画回退后保留静态视觉）**：菜单项改**胶囊悬停**（两侧 8px 边距 + 10px 圆角，下拉与右键一致）；毛玻璃增至 `blur(36px) saturate(1.7)`、圆角 24px；图标底衬圆角 18px、图标 12px；标签加字重/字距与双层柔和投影。放大/按压/入场等**动画全部回退原始设置**（果冻曲线、按压反馈、图标入场、指示线动画、菜单弹簧动画实测手感不佳）

### v1.7.1 (2026-08-22)

- **Alt+Space 反复切换失灵修复**：桌面无其他软件（前台被桌面 Progman 持有）时，`show()+focus()` 的激活会被前台锁拒绝——Dock 短暂获得焦点后约 500ms 被抢回，触发一次虚假 `blur` 把 Dock 沉底（仍可见）；原 `toggleWindow()` 依赖 `isAlwaysOnTop()` 判定按键意图，陷入「显示→被压底→再次显示→再次被压底」死循环，Alt+Space 永远无法隐藏到托盘
- **改用自维护意图状态** `dockTrayHidden`：隐藏/不可见 → 唤回置顶；可见（无论置顶或被沉底）→ 隐藏到托盘。该标志在所有显示/隐藏路径同步维护（run-app 隐藏、关闭窗口到托盘、`--autostart` 启动、second-instance 唤出、托盘菜单「显示窗口」、dock-pointer、focus）。沉底（blur）仍保留——虚假 blur 压底不影响按键，真正的「点击其他软件让位」行为不变

### v1.7.0 (2026-08-22)

- **启动后自动隐藏到托盘**：点击 Dock 图标启动程序/打开文件夹/URL/系统位置后，Dock 自动隐藏到托盘（相当于关闭窗口到托盘，不退出）——打开目标后 Dock 不再遮挡桌面；托盘左键单击 / `Alt+Space` / 托盘菜单「显示窗口」随时唤回并恢复置顶（`toggleWindow` 按可见性判断，隐藏状态下任一唤回路径均生效）
- **blur 沉底守卫**：`blur` 处理器增加 `isVisible()` 检查——`hide()` 隐藏窗口会触发 blur，此时不再执行 `setAlwaysOnTop(false)` + `sendToBottom()`（白跑一次 PowerShell 沉底）；沉底逻辑仅对可见窗口生效
- **桌面文件夹实时同步**：主进程对桌面目录挂 `fs.watch`（非递归，debounce 1s），变化时推送 `desktop-changed` 事件；renderer 复用启动扫描同一条「清理缺失 + 合并新增」逻辑——桌面新增文件夹/指向文件夹的 .lnk 即时加入 Dock，**被删除/移动的文件夹条目即时移除**（图标跟着桌面走）
- **缺失清理**：新增 `check-folders-missing` IPC（主进程纯 `fs.existsSync`，无 PowerShell），清理所有 `isFolder` 条目中路径已不存在的（桌面文件夹被删除、外部硬盘/网络盘未连接等），系统位置（`shell:` 特殊项）不参与；启动加载后与实时事件都会执行，清理结果随保存 effect 持久化
- **防重复触发**：`desktopSyncBusyRef` 保证清理/扫描进行中跳过重复事件（fs.watch 的 debounce 只聚合事件，扫描自身耗时可更长）；扫描合并逻辑提取为 `mergeDesktopScan`/`pruneMissingFolders` 供启动与实时共用（基线分别为已加载列表/当前列表）
- **代码整理**：桌面路径提取为 `desktopPath()`（`D:\Desktop` 优先，回退系统桌面），扫描处理器同步复用

### v1.6.0 (2026-08-12)

- **开机自启动**：「+」菜单新增「开机自启动」开关（iOS 风格开关指示器显示在菜单项右侧——开=绿色圆球在右、关=灰色圆球在左，与左侧文字对齐；**切换后菜单保持打开**，可连续切换，点击菜单外区域才关闭）
- **桌面自动扫描**：启动时自动扫描桌面上的文件夹和指向文件夹的 `.lnk` 快捷方式，并**固定附加「此电脑」「回收站」**加入 Dock——按「此电脑 → 回收站 → 文件夹」顺序插到 Dock 前部（新增文件夹也落在系统位置之后，不破坏固定顺序），路径规范化去重（与已有条目均不重复，已手动添加过的自动跳过），文件夹统一黄色文件夹图标，系统位置走注册表 CLSID 图标解析；加载完已保存数据后再扫描合并，避免竞态
- **保存防清盘修复**：保存 effect 增加 `loadedRef` 守卫——初始加载完成前不保存，修复 React.StrictMode 双挂载下挂载时 `save([])` 清空 `shortcuts.json`、导致已保存的程序快捷方式永久丢失（只剩扫描文件夹能靠重新扫描恢复）的严重 bug
- **启动扫描优化**：`scan-desktop-folders` 合并为单次 PowerShell 调用（枚举 + 共享文件夹图标 + 系统位置 CLSID 图标解析一次完成，启动不再拉起 6 个 powershell 进程）；图标失败逐级回退（系统图标 → 黄色文件夹 → 通用文档），`add-special-item` 同步带兜底
- **StrictMode 副作用修复**：`nextId++` 全部移出 `setApps` updater（StrictMode 双调用 updater 不再跳号）；菜单开关（开机自启动/桌面图标）增加脏标记，过期的异步读取不再覆盖乐观更新；滚轮滚动改为取主导轴，触控板斜向滚动不再双倍位移；`.gitignore` 忽略视觉调试目录
- **菜单精简**：「+」菜单移除「此电脑」「回收站」手动添加入口（启动扫描已自动加入，入口冗余）——同步移除 `add-special-item` IPC、`SPECIAL_ITEMS` 映射表与 `resolveClsidIcon` 死代码，系统位置 CLSID/图标回退全部内联在扫描脚本
  - 通过注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 登录项实现（Electron 原生 `app.setLoginItemSettings`），无第三方依赖
  - 开机启动时带 `--autostart` 参数，默认**隐藏到托盘**启动，不打扰登录后的桌面；Alt+Space / 托盘图标随时唤出
  - 打包版注册 `QuickLaunch.exe --autostart`；开发模式注册 `electron.exe --autostart <应用路径>`
  - 菜单打开时实时读取注册表状态（外部修改也会同步显示）
- **单实例锁**：`requestSingleInstanceLock()` 防止重复启动——开机自启已在运行、用户又手动启动 exe 时，后启动的实例直接退出并唤起已有窗口，避免出现两个 Dock

### v1.5.2 (2026-08-12)

- **置顶沉底逻辑修复**：
  - **dock-pointer 恢复置顶补 `focus()`**：此前鼠标移回 Dock 只恢复置顶不抢焦点，Dock 保持「置顶但无焦点」状态，之后再点击其他软件不会触发 `blur` 而无法沉底、持续遮挡——现在焦点闭环，点击让位恢复生效（副作用：鼠标滑过 Dock 时会短暂抢走焦点）
  - **sendToBottom 竞态修复**：`sendToBottom` 通过 PowerShell 异步执行 `HWND_BOTTOM`，若期间用户已通过 dock-pointer/focus 恢复置顶，迟到的压底操作会把 Dock 压到底部——回调检测到窗口仍处于置顶态时 `moveTop()` 拉回抵消
- **安装程序向导化**：NSIS 由一键安装改为向导式（`oneClick: false` + `allowToChangeInstallationDirectory: true`），安装时出现「选择安装位置」页面可自由改路径；加入中英文向导语言（`installerLanguages: zh_CN + en_US`），按系统语言自动选择

### v1.5.1 (2026-08-10)

- **文件夹快捷方式图标修复**：`SHDefExtractIcon` 对目录返回 E_FAIL 取不到图标，导入指向文件夹的 `.lnk` 显示破图——目标为文件夹时统一回退 `shell32.dll` 黄色文件夹图标（index 4），与「添加文件夹」一致
- **JS 模板字符串转义修复**：内嵌 PowerShell 脚本的 Windows 路径此前用单反斜杠，被 JS 当转义符吞掉（`C:\Windows\...` 静默变 `C:Windows...`）导致图标提取静默失败——全部改用双反斜杠
- **`.url` 快捷方式解析修复**：WScript.Shell 对 `.url` 文件的 `TargetPath` 实测返回空字符串，原代码用 TargetPath 判 URL 失败，导致网页快捷方式图标/名称丢失——改为按扩展名判定 `.url`，并从 INI 直接读 `URL=` 行补全目标
- **IconIndex 数组匹配修复**：`$urlIni -match 'IconIndex...'` 对数组不设置 `$Matches`，带本地 `IconFile` 的 `.url` 解析会异常——改为逐行标量匹配
- **图标终极兜底**：目标不存在 / 图标提取链全失败时给通用文档图标（`shell32.dll` index 1），避免 Dock 破图

### v1.5.0 (2026-08-08)

- **沉底行为收敛为仅「点击其他软件」**：此前鼠标离开 Dock 延迟 500ms 沉底，后来又加入「在其他软件上滚动滚轮沉底」仍触发频繁——现在鼠标移出 Dock、在软件中滚动都不再让位，只有点击其他软件（`blur`）才沉底；鼠标移回 Dock / Alt+Space / 托盘唤出恢复置顶
- **新增/选择文件默认定位 D 盘桌面**：添加文件/文件夹对话框默认打开 `D:\Desktop`（用户重定向后的桌面），不存在时回退系统桌面
- **文件夹多选**：添加文件夹支持一次多选（`multiSelections` + `openDirectory`，Win32 原生 `IFileOpenDialog` 组合），选中的文件夹逐个提取图标、一次性全部加入 Dock
- **快捷方式多选**：添加快捷方式同样支持一次多选（`multiSelections` + `openFile`），选中的 `.lnk`/`.url` 逐个解析、一次性全部加入 Dock；单个解析失败不影响其余
- **白天/黑夜主题切换**：「+」菜单新增「切换到白天/黑夜模式」，毛玻璃 Dock、菜单、标签全部换肤；偏好持久化到 localStorage，重启后保持
- **界面打磨**：移除空状态「点击 + 添加」提示；添加菜单隐藏原生滚动条（滚轮/触控板可滚）、四角圆角统一加大、水平位置钳制在窗口内防止右缘被裁
- **打包离线配置**：`electron-builder.yml` 用 `electronDist` 指向本地手动下载的 `electron-v*.zip` 打包，跳过 Electron 网络下载；`.gitignore` 新增 `electron-v*.zip` 规则，避免误提交大文件

### v1.4.0 (2026-08-08)

- **隐藏/显示桌面图标**：「+」菜单新增开关，向桌面 `SHELLDLL_DefView` 发 `WM_COMMAND 0x7402` 切换（与 Windows 右键菜单底层一致，兼容 SHChangeNotify 失效的 Win11）
- **点击其他软件自动沉底**：Dock 失去焦点（`blur`）时让出置顶并压到 z-order 最底（`SetWindowPos HWND_BOTTOM`），不再遮挡正在使用的程序；获得焦点时恢复置顶
- **鼠标离开 Dock 自动沉底**：滚动滚轮等不转移焦点的操作也会触发——`mouseenter/mouseleave` 通知主进程 `dock-pointer`，进入恢复置顶、离开沉底
- **Alt+Space 行为优化**：置顶显示时按=隐藏到托盘；沉底或已隐藏时按=唤回置顶（不再因沉底误触发隐藏）
- **新增菜单超高修复**：加入桌面图标开关后菜单超过 300px 窗口高度，加 `maxHeight` + `overflow-y: auto` 内部滚动
- **文件对话框不沉底**：添加/选择文件或文件夹弹系统对话框期间（`dialogOpen` 标志）暂停自动沉底并保持 Dock 置顶——否则模态对话框跟随 Dock 沉底，被压到其他软件下面
- **延迟沉底防闪**：鼠标离开 Dock 延迟 500ms 再沉底，期间移回取消——快速划过 Dock 不再反复闪沉；点击其他软件仍由 `blur` 立即让位
- **代码精简**：移除调试用诊断日志（`[dock] blur/focus`、`[desktop-icons] get/toggle`）

### v1.3.0 (2026-08-08)

- **水平滚动 Dock**：图标超过 Dock 宽度时横向滚动，滚轮/触控板滑动查看，两端渐隐遮罩提示「还有更多」
- **Dock 背景独立层**：毛玻璃背景拆分为 `.dock-bg`，只覆盖图标区——图标垂直居中、上下间距缩小；hover 放大图标从背景顶出（类似 macOS）
- **新增菜单修复**：下拉菜单移出滚动容器（fixed 定位渲染），修复被 `overflow` 裁剪而看不见的问题
- **启动容错**：直接 spawn 被拒（EACCES/EPERM，多为需管理员权限或杀软拦截）时回退 `shell.openPath()` 自动提权
- **置顶让位**：启动目标前 Dock 临时让出置顶，新程序窗口浮到 Dock 之上；窗口获得焦点时恢复
- **全局快捷键回退**：`Alt+Space` 优先，注册失败自动回退 `Ctrl+Alt+Space`
- **拖拽误启动修复**：拖拽结束后紧随的 click 被吞掉，不再误启动图标
- **菜单自动关闭**：鼠标移出菜单区域（或移出窗口）自动关闭，无需点击
- **mailto 正则修复**：URL 判定支持 `mailto:`（无 `//` 前缀）

### v1.2.0 (2026-07-21)

- **Dock 风格 UI 重设计**：透明毛玻璃 Dock 栏替代网格面板，悬浮桌面
- **图标拖拽排序**：按住图标拖放到目标位置，蓝色指示线显示插入点
- **自定义右键菜单**：右键图标弹出「删除」选项，不再直接删除
- **系统位置支持**：一键添加「此电脑」和「回收站」，图标从注册表动态解析
- **合并添加按钮**：四个添加选项统一到一个下拉菜单
- **Dock 放大效果**：鼠标靠近图标时平滑放大 + 上浮动画
- **代码精简**：提取共享图标提取器（`ICON_EXTRACTOR_CS`）、`resolveResource`、`doAdd` 泛型辅助，消除约 120 行重复代码
- **透明常驻窗口**：`transparent: true` + `alwaysOnTop` + `skipTaskbar`，Dock 悬浮桌面

### v1.1.0 (2026-07-21)

- **自定义无边框窗口**：去除系统标题栏，header 区域可拖拽移动
- **系统托盘**：关闭窗口最小化到托盘，左键单击托盘图标切换显隐
- **全局快捷键**：`Alt+Space` 切换窗口显隐
- **图标持久化存储**：添加的快捷方式和文件夹自动保存到 `%APPDATA%/electron-react-app/shortcuts.json`，重启后恢复
- **应用图标**：Remix Icon `apps-2-fill` 3×2 网格风格，含 ICO 多尺寸 + 托盘 PNG
- **文件夹收纳**：支持添加文件夹到面板，提取系统黄色文件夹图标，点击在资源管理器中打开
- 清理死代码

### v1.0.0 (2026-07-14)

- 初始化 React + TypeScript + Electron 空项目
- 快捷方式文件解析（.lnk / .url / .pif）
- Win32 API 高清图标提取（256×256）
- 图标网格面板（添加、启动、右键删除）
- .url 文件 favicon 自动下载
- 软件名称智能提取（FileDescription → Description → 文件名）
- 中文编码 UTF-8 适配
