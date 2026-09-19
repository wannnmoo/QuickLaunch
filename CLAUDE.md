# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 常用命令

```bash
npm run dev         # 启动开发模式（Vite HMR + Electron 热重载）
npm run build       # 生产构建
npm run typecheck   # TypeScript 类型检查（= typecheck:node + typecheck:web，逐个子项目 tsc --noEmit）
npm run preview     # 预览生产构建
npm run package     # 构建并打包为可分发的安装程序（electron-builder）
```

## 架构概览

这是一个名为「快捷方式面板」的 Windows Electron 桌面应用——透明 Dock 栏悬浮在桌面，用户可添加快捷方式、文件夹、此电脑、回收站，通过毛玻璃 Dock 栏快速启动。

### Electron 三进程模型

项目遵循 `electron-vite` 标准结构（配置文件 [`electron-vite.config.ts`](electron-vite.config.ts)），严格区分三个进程：

| 进程 | 入口 | 职责 |
|---|---|---|
| **Main** | [`src/main/index.ts`](src/main/index.ts) | 应用生命周期、透明无边框窗口、系统托盘、全局快捷键、IPC 处理器、PowerShell 调用 |
| **Preload** | [`src/preload/index.ts`](src/preload/index.ts) | `contextBridge.exposeInMainWorld` 暴露 `window.api` 和 `window.electron`，定义 `LnkInfo` 和 `AppEntry` 类型 |
| **Renderer** | [`src/renderer/src/main.tsx`](src/renderer/src/main.tsx) | React 19 SPA，挂载 `<App />` 到 `#root`，样式在 [`App.css`](src/renderer/src/App.css) |

Renderer 通过 preload 脚本的 contextBridge 安全隔离，**不能**直接访问 Node.js 或 Electron API。

### TypeScript 项目引用

`tsconfig.json` 通过 references 分为两个子项目：

| 配置文件 | 涵盖范围 |
|---|---|
| [`tsconfig.node.json`](tsconfig.node.json) | `src/main/` + `src/preload/`（ESNext，无 DOM） |
| [`tsconfig.web.json`](tsconfig.web.json) | `src/renderer/src/`（ESNext + DOM + JSX） |

### 透明窗口 + Dock 布局

- `transparent: true` + `frame: false` 透明无边框窗口（300px 高，85% 屏宽 ≤ 1200px）——水平方向**恒为主显示器工作区居中**，垂直方向由停靠位置预设决定
- `alwaysOnTop: true` + `skipTaskbar: true` — 常驻桌面，不在任务栏显示
- **自动让位**：Dock 沉到 z-order 最底不遮挡，鼠标移回 / 点击 Dock / Alt+Space / 托盘唤出恢复置顶。**只有点击其他软件（`blur`）才让位**——鼠标移出 Dock、或在其他软件上滚动滚轮都不沉底，用户可自由移动鼠标：
  1. `blur` 事件（点击其他窗口失去焦点）→ **延迟 120ms 复核**再 `setAlwaysOnTop(false)` + `sendToBottom()`：这一拍是为了滤掉启动/重建窗口等场景的焦点抖动，期间若焦点已回到 Dock、窗口被隐藏或 `sinkSeq` 代际变了就整条取消（点击其他窗口后焦点不会在 120ms 内回来，正常让位不受影响）；**窗口已隐藏（`isVisible()` 为 false）或已收在托盘（`dockTrayHidden`）时直接跳过**——不为一次由隐藏引起的 blur 白跑一个 PowerShell 进程
  2. `run-app` 启动目标后**自动隐藏到托盘**（`mainWindow.hide()`，不退出进程）——用户点开图标后 Dock 彻底让出桌面；托盘左键 / Alt+Space / 托盘菜单「显示窗口」随时唤回（`toggleWindow` 按 `isVisible()` 判断，隐藏状态下任一唤回路径均显示并恢复置顶）
- **对话框期间不沉底**：`dialogOpen` 标志（模块级 `let`），三个弹对话框的 IPC（`parse-lnk` / `select-folder` / `pick-icon`）统一走 **`showOpenDialogSafe()`**：置 `dialogOpen`、把 Dock 顶到最前，并传 `disabled: mainWindow` 让对话框成为**真模态子窗口**（挡住 Dock 输入，避免用户在对话框开着时又点开菜单把弹层状态搞乱；Windows 也会把对话框排进父窗口的 z-order 组）。`blur` 沉底逻辑检查该标志——模态对话框是 Dock 的子窗口，跟随父窗口层级，若对话框抢焦点触发沉底会把选择器连带压到其他软件下面
- **恢复置顶（v1.11.0 起统一走 `recoverDock()`）**：`focus` 事件（点击 Dock / Alt+Space / 托盘唤出）、renderer `mouseenter`（`dock-pointer(true)`）、`toggleWindow` 显示分支、启动失败恢复、`second-instance` 都调它——置顶 + `moveTop` + 120ms 后再补一次，末尾接 `verifyDockOnTop()` 自愈巡检
- **沉底与恢复的竞态防护（v1.11.0，改这块必须先读）**：沉底是**异步**的（新起 `powershell.exe` + `Add-Type` 编译 C#，实测滞后 200ms~1s），这段时间里任何「拉回」操作都会与它打架。防护分四层：① 单调递增的 `sinkSeq`——`toggleWindow` 的**显示与隐藏两条分支**、`dock-pointer`、`focus`、启动失败恢复、`second-instance` 全部 `++`，在途沉底在启动前与回调里各比对一次，代际不符即整条放弃；② 同一窗口的沉底任务**串行化**（已有任务在跑时 180ms 后重试，不再起第二个进程）；③ 迟到的 `SetWindowPos(HWND_BOTTOM)` 补偿**不能再用 `isAlwaysOnTop()` 判断**——恢复路径会把它设回 `true`，原写法恒真、形同虚设；④ `verifyDockOnTop()` 自愈巡检：`moveTop()` 只把窗口提到「同一组内的顶部」、并不重新断言置顶位（实测恢复后 `WS_EX_TOPMOST` 有约 300ms 为 `False`），所以「窗口可见 + 未收托盘 + `sinkSeq` 未变」却没拿到焦点时补一次置顶断言，最多 4 次
- **关键坑**：`setAlwaysOnTop(false)` 只是从置顶层降级（`HWND_NOTOPMOST`），z-order 仍停在非置顶组顶部——Explorer 也是非置顶窗口，Dock 依然盖在它上面。**必须再 `sendToBottom()` 调 `SetWindowPos(hwnd, HWND_BOTTOM)` 真正沉底**（Electron 没有 `moveBottom()`，只能走 PowerShell P/Invoke）
- **停靠位置三档（中间 / 下 / 上）**：类型 `DockEdge = 'bottom' | 'top' | 'left' | 'right' | 'middle'`，但 `IMPLEMENTED_EDGES` 只放行 `bottom`/`top`/`middle`——左/右竖排窗口尺寸不同，需要重建窗口（`recreateWindowForEdge` 已留好），是下一阶段的事。坐标由 `presetPosition(edge)` 在主显示器工作区上算：`top` 贴工作区顶边、`bottom` 贴工作区底边、`middle` 垂直居中；三者都水平居中、窗口尺寸（85% 屏宽 ≤ 1200px × 300px）完全相同，所以切换是**原地 `setBounds` + `webContents.send('dock-edge-changed')`**（实测 ~62ms，不重建窗口、不重载页面、无白闪），只有尺寸真的变了才走 `recreateWindowForEdge`。持久化在 `{userData}/window-position.json`（只存 `{"edge":"..."}`，**文件名沿用旧版**；旧版写的 `{x,y,displayId}` 直接忽略；读入与写入都把未实现档位归一化回 `DEFAULT_EDGE` = `middle`，防止手改配置文件改出竖排尺寸的窗口）。`setDockEdge` 对同档位（±2px 内）提前返回时**仍然重发事件**——页面重载过的 renderer 拿的是启动时 argv 里的旧边，不重发它的布局会一直停在旧位置；renderer 挂载时另外用 `get-dock-edge` 主动同步一次。首次参数走 preload 读的 `--ql-edge=<edge>` argv 常量，首帧就是正确方向，不会先画底部再翻上去
- **窗口不可自由拖动**：代码里没有任何 `-webkit-app-region: drag`（CSS 里只剩两处解释性注释），也没有 `move`/`moved` 监听或位置巡检。原因：透明窗口下 Dock 栏要么贴窗口上沿、要么贴下沿，窗口位置一动就得补偿布局，实测表现为**明显跳动**（做过「边缘区域判定 + 拖动过程中不切位置 + 松手平滑收尾」也压不住），于是位置**只由预设决定**。不要再引入拖拽/位置记忆
- **显示器参数变化**：`screen.on('display-metrics-changed' | 'display-added' | 'display-removed', reapplyDockEdgeOnDisplayChange)` 重新套用当前档位。**这三行必须写在 `app.whenReady()` 里**——`screen` 模块在 `ready` 之前使用会抛 `The 'screen' module can't be used before the app 'ready' event`，直接把启动打崩（曾发生过）
- Dock 栏贴窗口的贴边侧：`bottom`/`middle` 布局里玻璃条在窗口下沿（`middle` 只是窗口整体悬在屏幕中间），`top` 布局里玻璃条贴窗口上沿、整套几何垂直镜像（`.app[data-edge='top']` 里改玻璃条位置、`.dock-inner` 的 70px 透明放大区从上改到下、`.dock-item` 的 `transform-origin` 改 `center top`、悬浮标签挂到图标下方、菜单/卡片/面板的浮层锚点由 JS 改到玻璃条下沿外侧）。毛玻璃背景是**独立层 `.dock-bg`**：只覆盖图标区（图标垂直居中），`blur(36px) saturate(1.7)`、圆角 24px、边框 + 阴影
- 图标排列在 Dock 内，鼠标悬停放大效果（JS 驱动，最大放大 1.4×，上浮 8px，影响半径 140px）。放大图标从背景顶部**透明区顶出**（类似 macOS）——`.dock-inner` 顶部有 **70px** 透明 padding 作为放大+悬浮标签显示区，否则 `overflow` 会把放大溢出裁掉（`data-edge='top'` 时这 70px 挪到下方，放大向下顶出）
- **悬停放大走几何缓存，绝不逐图标读布局（v1.12.0，改这块必须先读）**：原实现每个 `mousemove` 都对每个图标 `getBoundingClientRect()` 再写 inline `transform`，读-写交替触发强制同步布局（layout thrashing），是「鼠标划过 Dock 卡顿」的主因。现在：
  - `measureCenters(refs, container)` 把各图标中心点量成**升序数组**（`dockCenters` / `panelCenters`），只在布局变化时重算一次
  - `magnifyAt()` 在升序数组上**二分**定位光标，再只遍历左右各 140px 内的那一段连续区间；`applyZoom()` 用 `WeakMap` 记住上次写入的缩放值，**值没变就完全不碰 DOM**。实测 60 个图标时单帧最多触及 6 个（原来固定 60 个）；新旧算法在 145,200 个采样点上逐点比对完全一致
  - **失效有两条通道，缺一不可**：① 显式 `useLayoutEffect`（依赖 `apps.length` / `theme` / `edge` / `openGroupId`）；② `ResizeObserver` 挂在 **ref 回调**里（`useEffect` 在 ref 回调之后才跑，挂载帧会漏掉）。**不能只靠 `ResizeObserver`**——图标增删只改变内容排布、容器盒子尺寸不一定变，观察者不会回调，缓存会留在旧中心点；另外 `ResizeObserver` 挂上去**没有初始通知**，必须在挂载时显式补测一次，否则启动后第一次悬停没有放大效果
  - `calcDropIndex` 复用同一份缓存（落点判定本来只有「最近两个图标之间」的粒度，放大导致的几像素偏差不影响结果）
  - **⚠️ 坐标系：缓存与命中必须都在「内容坐标」里（v1.12.1 翻修过一次，改这里必看）**。容器是**横向滚动容器**，而 `clientX - container.getBoundingClientRect().left` 算出来的是**内容坐标**（不随滚动变化）。所以两边都必须换算对齐：
    - `measureCenters()`：`rect.left - box.left + container.scrollLeft + rect.width / 2`
    - `magnifyAt()` / `calcDropIndex()`：`clientX - container.getBoundingClientRect().left + container.scrollLeft`
    v1.12.0 只在测量侧漏了 `scrollLeft`（量成视口坐标），于是 Dock 一旦横向滚动，命中就整体偏左 `scrollLeft` 像素——**图标越多越需要滚动、偏得越多**，表现为「鼠标移到后面的图标，放大却显示在前面的图标上」。因为用的是相对量，滚动本身**不需要**重新测量，缓存依旧只在布局变化时重建
- **主 Dock 的 `mousemove` 不做整树重渲染**：`handleDockMouseMove` / `handlePanelMouseMove` 用 `navIdRef` 判断是否真的需要 `setNavId(null)`——原来无条件每次移动都 setState，会让整个 `App`（全部图标 + 标签 + 分组拼图 + 面板成员）跟着重渲染
- **标签悬停显示（三主题一致）**：`.dock-label` 默认隐藏，鼠标悬停图标时淡入（0.16s）；标签**绝对定位悬浮在图标上方**（macOS 式，不占图标下方布局行——玻璃条紧凑贴合图标），完整显示名称不截断；每主题一个药丸底衬（`--label-pill-bg`：黑夜=深藏青 `rgba(12,16,28,0.55)` 白字、白天=浅白玻璃 `rgba(255,255,255,0.75)` 深字、透明=中性深灰 `rgba(0,0,0,0.30)` 白字）；「+」添加按钮不显示悬浮标签
- 图标放不下时**横向滚动**：`.dock-inner` 是滚动容器（`overflow-x: auto`，隐藏滚动条），滚轮/触控板转水平滚动（原生 `addEventListener('wheel', …, { passive: false })`——React 在 root 上以 passive 注册 wheel，`onWheel` 里 `preventDefault()` 是空操作）；两端 `dock-edge` 渐隐遮罩提示「还有更多」，仅可滚动侧显示（`scrollState`）
- **玻璃条宽度随图标数量伸缩（v1.13.0，改这块必须先读）**：DOM 是 `.app > .dock > .dock-bar > (.dock-bg, .dock-inner, .dock-edge ×2)`，两层分工严格：
  - `.dock` **只做定位与拖放命中层**：`width: 100%` 占满整窗，`padding: 8px 24px`。它**不再决定玻璃条宽度**
  - `.dock-bar` 是**玻璃条本体**：`width: max-content` + `max-width: calc(var(--dock-vw) - 48px)`。图标少时收缩到刚好看得下（两端大留白消失），一路长到上限后由 `.dock-inner` 横向滚动
  - **窗口尺寸始终不变**（透明窗口 resize 会白闪），变的只是这一层的宽度；与分组面板 `.group-panel` 同一套做法
  - ⚠️ **上限不能用 `100vw`**：实测本窗口里 `window.innerWidth` 是 **1202**（窗口设的是 1200），而 `100vw` 跟着它走——所以 `.dock-bar` 会多出 2px 溢出可用区。改为 renderer 把 `window.innerWidth` 写进 **`--dock-vw`**（写在 `.app` 根元素上，随 resize 更新），CSS 用 `calc(var(--dock-vw, 100vw) - 48px)`
  - ⚠️ `.dock-bg` / `.dock-edge` 的左右偏移都改成 **0**（原先写 `24px`，那是 `.dock` 的 padding；现在定位基准已经是 `.dock-bar` 本身）
  - ⚠️ `.dock-inner` **不要写 `max-width: 100%`**：`.dock-bar` 是 `max-content`（收缩包裹），其内部百分比 max-width 的解析基准不确定，留着既冗余又让「谁在限宽」难读。限宽只由 `.dock-bar` 负责
  - **拖入文件的命中区按 `.dock-bar` 算，不能按 `.dock`**：`.dock` 占满整窗，图标少时条两侧大片透明区也在 `.dock` 内——不区分就会出现「在空白处松手也能添加，但那里不显示插入线和禁止光标」。`document` 级 `dragover` 用 `elementFromPoint` 判断是否在条上（不用 `e.target`：光标下方可能是被 transform 放大的图标），不在条上就 `dropEffect='none'` 并清掉插入线；`handleDockDrop` 里再用 `dockBarRef` 兜一道
  - **回归验证脚本**：`node_modules/electron/dist/electron.exe .dsh-vision-toolkit/probe/probe-main.cjs`——起一个本地 HTTP 服务（**必须 HTTP，不能 file://**：探针页与构建产物不在同一目录，file:// 下属于不同不透明源，样式表会被判跨源而**静默不生效**，第一版探针就因此量到「没有样式」的全宽），引用真实构建产物的 CSS，在真实 Chromium 里逐个数图标量 `.dock-bar` 宽度。实测：0 个 → 32px、4 个 → 284px、16 个 → 1052px、20 个 → 封顶 1154px 且开始滚动（内容 1308）、30 个 → 仍 1154px
- 图标支持拖拽排序（自定义 mousedown/mousemove/mouseup 事件，5px 阈值区分点击和拖拽，蓝色指示线显示插入点）。**落点换算**：`calcDropIndex` 返回的是「顶层图标」下标（`iconRefs` 里只有顶层条目 + 分隔线），而 `apps` 是扁平数组（含分组成员），所以重排与拖入添加都必须用 `topAnchorId(list, idx)` 先换成锚点 id 再取扁平插入点——直接把顶层下标当扁平下标用会让插入位置偏「成员数」个槽位
- **拖入文件添加**：从资源管理器拖 `.lnk`/`.url`/`.pif`/`.exe`/`.com` 到 Dock 栏即添加（**仅 Dock 栏区域**响应，其余位置显示禁止光标）。Electron 32+ 已移除 `File.path`，路径只能由 preload 的 `webUtils.getPathForFile` 提供；主进程 `describe-paths` 分派解析（快捷方式复用 `parseLnkFile`，exe 走单次 PowerShell 批量取 FileDescription + 图标，提取失败回退 shell32 通用图标），renderer 按落点插入、按路径去重（重复或格式不支持则跳过并提示）。**整窗**都要 `dragover`/`drop` preventDefault，否则 Chromium 会把窗口导航到 `file://`（白屏）
- **分隔线**：`isSeparator` 特殊条目——1px 渐变柔线（比图标矮、两端淡出、随主题变色），只从图标右键「在此之前插入分隔线」创建；可拖拽排序、随 `shortcuts.json` 持久化；不启动、不参与桌面扫描去重/清理/键盘导航/悬停放大。命中区做成 9px（可视竖线仅 1px）+ `z-index: 20`：1px 太细时旁边放大中的图标（`magnify` 给图标设 `z-index: 10`）会压住它，右键点不中
- **键盘导航**：`Alt+Space` 唤出 Dock 时主进程 `webContents.send('nav-enter')` → renderer 进入导航模式（`navId`）。`←/→` 不循环移动、`Enter` 启动、`Esc` 退出；分组上 `→`/`Enter` 展开面板并把选中移入第一个**非分隔线**成员、`←`/`Esc` 返回主 Dock；可导航到末尾的「+」按钮（`ADD_BTN_ID = -1` 哨兵，Enter 打开菜单）。选中位置写入 localStorage `ql-nav-last`，启动/唤出/方向键唤醒都恢复到它（条目失效则回落第一个）。选中态是左右两条渐变竖框（`.dock-item.selected` / `.drop-target` 共用），并靠 `.dock-item { scroll-margin-inline: 44px }` 保留滚动余量——否则 `scrollIntoView({ inline: 'nearest' })` 会把容器内边距一起滚掉，最左图标的左框被裁。**菜单打开时必须清掉 `navId`**（`handleContextMenu` / `handleAddToggle` 都 `setNavId(null)`）并把 `Enter` 让给菜单——否则选中框不可见却仍是活的，按 Enter 会启动看不见的条目

### 系统托盘 + 快捷键（v1.11.0 起托盘图标为多尺寸 ICO）

- **Alt+Space** 全局快捷键：隐藏/不可见时按 → 唤回置顶；可见（置顶或沉底）时按 → 隐藏到托盘。`toggleWindow()` 用**自维护意图状态 `dockTrayHidden`**（非 `isAlwaysOnTop()`——桌面无其他窗口时前台锁会拒绝激活，Dock 获得焦点约 500ms 后被抢回产生虚假 `blur` 沉底，读置顶位会陷入「显示→被压底→再显示」死循环，v1.7.1 修复）。`dockTrayHidden` 在所有显示/隐藏路径同步维护（run-app 隐藏、close 到托盘、`--autostart` 启动、second-instance、托盘「显示窗口」、dock-pointer、focus）。优先注册 Alt+Space，失败自动回退 `Ctrl+Alt+Space`；Ctrl+Alt 在 Windows 上等同 AltGr，易被输入法/键盘布局占用。**键盘唤出**（`toggleWindow(true)`，仅全局快捷键路径；托盘点击不传该参数）时额外 `webContents.send('nav-enter')`，renderer 据此进入键盘导航模式
- 关闭窗口 → 隐藏到系统托盘（不退出）
- 托盘左键单击 → `toggleWindow()`（同上逻辑）
- 托盘右键菜单 →「显示窗口」/「退出」
- 托盘图标：[`resources/tray-icon.ico`](resources/tray-icon.ico)（16/20/24/32/48/64 六档）。**必须用多尺寸 ICO，不能用单尺寸 PNG**：显示器缩放 125% 时托盘需要 20 物理像素、150% 需要 24、200% 需要 32，单尺寸 PNG 会被系统拉伸成模糊（v1.11.0 之前是 16×16 PNG，在 125% 下必然发虚）。托盘只到 64 档：通知区物理最大 32px，再大的档位永远取不到
- 应用图标：[`resources/icon.ico`](resources/icon.ico)（16/20/24/32/40/48/64/128/256 九档）

### 图标体系（v1.13.0 起由 SVG 生成，改图标必读）

**唯一真相源是两个 SVG**，ICO 由脚本生成、**不要手改 ICO**：

| 文件 | 作用 |
|---|---|
| [`resources/icon.svg`](resources/icon.svg) | 主图标源（应用 / 安装包 / 桌面 / 开始菜单 / 任务栏 / 窗口） |
| [`resources/tray-icon.svg`](resources/tray-icon.svg) | 托盘源。**必须与 `icon.svg` 逐字节相同**（用户要求两处形象完全一致） |
| `.dsh-vision-toolkit/make-icons.mjs` | 生成器：SVG → 逐尺寸独立光栅化 → ICO。**内含哈希校验，两个 SVG 不一致就直接报错退出** |
| `.dsh-vision-toolkit/verify-icons.mjs` | 校验两枚 ICO 在共同尺寸上**逐像素一致** |

改图标的流程：改 `icon.svg` → 复制覆盖 `tray-icon.svg` → 跑 `node .dsh-vision-toolkit/make-icons.mjs` → 跑 `verify-icons.mjs` 复核。

**形象**：蓝色圆角方块（`#3B7BD5`，圆角 54/256）上叠**三块白色瓷砖**（条宽 48 / 间隙 32 / 高 140 / 圆角 12）。蓝块 = Dock 的玻璃条，三块瓷砖 = 停在上面的一格格快捷方式。

**几何是「从像素网格反推」出来的，不是审美数字——改尺寸前务必看这段**。图标最小要出到 16×16，那时画布只有 16 格，能承载的结构极有限。实测过的方案与结论（脚本 `final-check.mjs` / `try-icons*.mjs` 可复现）：

| 方案 | 16px 实测 | 结论 |
|---|---|---|
| 2×2 / 2×3 网格 | 白色连成一片 | ❌ 结构全丢，读成一个白方块 |
| 三条**横**线 | 分得开 | ❌ 满宽横线 + 0.24 长宽比 = 标准「汉堡菜单」，语义跑偏 |
| 竖块但间隙 12 | 隙仅 0.75px，抗锯齿糊平 | ❌ 又是白方块 |
| **竖块 条48/隙32** | `B WWWW B WWWW B WWWW B`（隙 2px 完整保留） | ✅ 现行 |

- **判断小尺寸可读性的正确判据：间隙里是否真的还留有底色**，而不是数「浅色连通块个数」——抗锯齿会产生浅蓝像素，按后者会把糊掉的方案误判为通过（这个错已经犯过一次）
- 光栅化器只认**圆角矩形**（`<rect>` / `<g fill>`）。要加 path / 描边 / 渐变 / 滤镜，必须先把渲染方案换掉（当前刻意不引依赖：没有 sharp/resvg/canvas，也没用 Electron 截图）
- 生成器解析前会**先剥掉 XML 注释**：SVG 注释里若出现 `<g fill=...>` 这样的标签文本，不剥就会被正则先匹配到（踩过一次）
- ⚠️ **改 `.dsh-vision-toolkit/*.mjs` 一律用编辑器工具，不要用 PowerShell 的 `Set-Content`/`Get-Content`**——本项目已因此损坏过一次脚本（中文注释全部 mojibake + 行被合并成语法错误）。这就是「注意事项」里那条 PowerShell 编码坑在脚本文件上的又一次实例

### 开机自启动

- **实现**：Electron 原生 `app.setLoginItemSettings` / `getLoginItemSettings`，写注册表 `HKCU\...\Run` 登录项，无第三方依赖
- **参数**：打包版注册 `QuickLaunch.exe --autostart`；开发模式 `process.execPath` 是 `electron.exe`，必须附带应用路径参数（`--autostart <appPath>`，第一个非开关参数被 Electron 当作 app 路径）——`autoStartArgs()` 按 `app.isPackaged` 区分，`get/set` 必须传相同的 `path`/`args` 才能正确匹配注册表项
- **`--autostart` 隐藏启动**：带该参数启动（开机自启）时窗口默认隐藏到托盘（`ready-to-show` 不 `show()`），不打扰登录后的桌面；Alt+Space / 托盘图标唤出
- **UI**：「+」菜单项「开机自启动」：右侧显示**开关指示器**（`.item-switch`，配色与主题分段选择器统一——`--switch-on-bg`/`--switch-on-knob` 按主题定义：黑夜=白轨道+深球、白天/透明=深轨道+白球，关闭态均为弱轨道+白球；`.dropdown-item` 为 flex `space-between` 布局，左侧文字与其余菜单项完全对齐），菜单打开时 `getAutoStart()` 实时读取，点击 `setAutoStart()` 乐观更新——**与其他菜单项不同，切换后不关闭菜单**（开关类控件交互，用户可立即看到状态翻转并连续切换）
- **单实例锁**：模块顶层 `app.requestSingleInstanceLock()`——未获得锁直接 `app.quit()`，`whenReady` 开头 `return` 跳过初始化；`second-instance` 事件唤起已有窗口（防止开机自启 + 手动启动出现两个 Dock）

### IPC 通道

所有 IPC 使用 `ipcMain.handle` / `ipcRenderer.invoke`（Promise 模式）。Preload 暴露两个对象：
- `window.api` — 自定义 API（见下表）
- `window.electron` — 来自 `@electron-toolkit/preload` 的标准 Electron API

| Channel | 方向 | 说明 |
|---|---|---|
| `parse-lnk` | Renderer → Main | 解析 .lnk/.url/.pif 快捷方式文件，返回 `LnkInfo[]`；不传路径则弹出系统文件对话框（`multiSelections` 支持一次多选，单个解析失败不影响其余）。对话框默认定位 `D:\Desktop`（重定向后的桌面，回退系统桌面） |
| `select-folder` | Renderer → Main | 选择文件夹（`multiSelections` 支持一次多选），从 `shell32.dll` index 4 提取黄色文件夹图标，返回数组 |
| `scan-desktop-folders` | Renderer → Main | 扫描桌面上的文件夹和指向文件夹的 .lnk 快捷方式，并**固定附加「此电脑」「回收站」系统位置**（启动时自动合并，renderer 端路径规范化去重），返回 `{path, name, iconDataUrl, specialType?}[]`（单次 PS 调用完成枚举 + 图标提取，图标失败逐级回退） |
| `check-folders-missing` | Renderer → Main | 检查哪些文件夹路径已不存在（主进程纯 `fs.existsSync`，无 PowerShell），返回不存在的子集——用于清理被删除的桌面文件夹条目 |
| `desktop-changed` | Main → Renderer | 主进程 `fs.watch` 桌面目录（非递归，debounce 1s）后推送的事件（`webContents.send`，非 handle/invoke）；renderer 收到后重新执行「清理缺失 + 扫描合并」，桌面文件夹增删实时同步到 Dock |
| `run-app` | Renderer → Main | 启动程序/URL/`shell:` CLSID 命令，或通过 `shell.openPath()` 打开文件夹；URL 判定正则 `/^(https?\|ftp\|steam):\/\/\|^mailto:/i`；启动后 Dock 自动隐藏到托盘（`blur` 沉底逻辑对不可见窗口跳过——`hide()` 触发的 blur 不再白跑一次 PowerShell 沉底） |
| `load-shortcuts` | Renderer → Main | 从 `{userData}/shortcuts.json` 加载持久化数据 |
| `save-shortcuts` | Renderer → Main | 保存持久化数据到 `{userData}/shortcuts.json`。**主进程不做任何字段换算**——renderer 状态里存的就是最终要落盘的真实 data URL |
| `flush-pending-save` | Main → Renderer | 退出前推送：renderer 的保存有 400ms 防抖，收到后立刻把未落盘的改动 invoke 一次 `save-shortcuts`。主进程在 `before-quit` 推它并留 200ms（`will-quit` 时窗口已销毁、IPC 不通，不能用） |
| `get-desktop-icons-hidden` | Renderer → Main | 读取桌面图标当前是否隐藏（ListView 可见性，找不到 ListView 时回退读注册表 HideIcons） |
| `toggle-desktop-icons` | Renderer → Main | 切换桌面图标显隐，返回切换后状态 |
| `get-auto-start` | Renderer → Main | 读取开机自启动是否开启（`getLoginItemSettings`，传与 set 相同的 path/args 匹配注册表项） |
| `set-auto-start` | Renderer → Main | 开启/关闭开机自启动（`setLoginItemSettings` 写 `HKCU\...\Run`），返回切换后实际状态 |
| `dock-pointer` | Renderer → Main | 通知主进程鼠标进入 Dock 窗口恢复置顶（`inside=true`；离开不再沉底——沉底仅由点击其他软件 `blur` 触发）。用 `ipcRenderer.send` 单向，非 invoke；高频进出不阻塞 renderer |
| `pick-icon` | Renderer → Main | 为条目更换图标：系统对话框选 exe/dll/ico（`SHDefExtractIcon` 提取）或 png/jpg（直接读文件转 dataURL），返回 `{path, iconDataUrl}` 或 null |
| `run-as-admin` | Renderer → Main | 以管理员身份运行：PowerShell `Start-Process -Verb RunAs`（UAC 提权，保留参数/工作目录）；启动后 Dock 隐藏到托盘 |
| `open-file-location` | Renderer → Main | 在资源管理器中定位目标：`explorer /select,"path"`（整段单参数，支持空格路径）；`shell:`/URL 忽略 |
| `copy-text` | Renderer → Main | 复制文本到剪贴板（`clipboard.writeText`，用于「复制路径」） |
| `describe-paths` | Renderer → Main | 拖放添加：解析拖入的文件路径数组——快捷方式走 `parseLnkFile`、`.exe`/`.com` 走单次 PowerShell 批量取 FileDescription + 图标（失败回退 shell32 通用图标），返回 `{ accepted, rejected }`；rejected 由 renderer 汇总成「已跳过 N 个」提示 |
| `nav-enter` | Main → Renderer | Alt+Space 唤出 Dock 时推送（`webContents.send`，非 handle/invoke）；renderer 据此进入键盘导航模式并恢复到上次选中位置 |
| `get-dock-edge` / `set-dock-edge` | Renderer → Main | 读取 / 切换停靠位置（`middle`/`bottom`/`top`；横向三档窗口尺寸相同 → `applyDockEdge` 原地 `setBounds` + 推事件并写 `window-position.json`；未实现档位被拒并归一化回默认） |
| `dock-edge-changed` | Main → Renderer | 停靠位置变更推送（含显示器参数变化后的重新归位）；renderer 收到后翻 `data-edge` 布局。**同档位提前返回时也会重发**（页面重载过的 renderer 只有启动 argv 里的旧边） |
| `list-folder` | Renderer → Main | 文件夹预览卡片的数据源：`fs.readdir` + 目录优先自然序 + 400 项上限，文件大小只 stat 文件（目录不递归，**并发受限 16**，别用无脑 `Promise.all` 压垮 libuv 线程池），**首批 14 个图标在返回前填好**（目录用一次提取常驻的 shell32 index 4 黄色文件夹图标、文件用 `app.getFileIcon`）；5s TTL 缓存（上限 40，写入前先清理过期项）+ 在途请求 Promise 去重；失败返回 `error: 'missing' \| 'denied' \| 'notdir'` |
| `folder-icons` | Main → Renderer | 预览图标后台分批推送（每批 24 个，总上限 150）；renderer 按路径就地替换（**本批没命中当前卡片目录时直接返回原状态**，不建新对象）。窗口被重建后 sender 失效时，主进程会删掉自己写的那条缓存（否则卡片在 TTL 内永远停在占位块） |
| `open-path` | Renderer → Main | `shell.openPath`（ShellExecuteEx 语义）打开任意路径——目录开资源管理器、文档/图片交给关联程序；**返回成功后才隐藏 Dock**（目标不存在/无关联程序时保持可见，否则用户看到「点了没反应 + Dock 消失」） |

### React UI

App 是**唯一的 React 组件**（[`src/renderer/src/App.tsx`](src/renderer/src/App.tsx)）：

- 单个 `useState<AppEntry[]>` 管理快捷方式列表
- 模块级 `nextId` 生成自增 ID，启动时从已保存最大 ID + 1 恢复
- **Dock 栏**：毛玻璃横栏（位置由根元素 `data-edge` 决定：`bottom`/`middle` 在窗口下沿、`top` 在上沿），图标水平排列，gap 4px；内容超过宽度时横向滚动
- **+ 按钮**：Dock 末尾的添加按钮，点击展开下拉菜单（添加快捷方式/文件夹/**停靠位置分段选择器**/**主题嵌套选择器**/**隐藏或显示桌面图标**/**开机自启动**；「此电脑」「回收站」由启动扫描自动加入，无手动入口）。菜单**渲染在滚动容器之外**（fixed 定位）：`addBtnRef` 提供按钮坐标存入 `menuPos` state，菜单底边对齐按钮上方 8px。滚动容器的 `overflow` 会裁剪向上弹出的菜单，故不能放容器内。菜单加 `maxHeight: menuPos.top - 8` + `overflow-y: auto`——超过窗口内可用高度时内部滚动，滚动条隐藏（与 `.dock-inner` 一致），滚轮/触控板滚动；水平位置钳制在窗口内（`Math.min(Math.max(cx, 100), innerWidth - 100)`），防止按钮靠窗口右缘时菜单伸出被裁掉圆角。**停靠位置选择器**（`DOCK_EDGE_CHOICES`：中间/下/上）复用主题分段控件的 `.theme-seg` 样式——位置选择后菜单保持打开，`handleEdgePick` 不做本地短路，一切以主进程 `setDockEdge` + 事件回推为准
- **主题分段选择器**（`.theme-seg`，纯 flex 分段控件——绝对定位滑块方案反复出布局问题后重写）：主行「透明 | 毛玻璃」两段（激活项自带底色 `--nt-ink` 高亮 + 文字 `--nt-ink-on`）；毛玻璃激活时下方展开子行「黑夜 | 白天」（透明态 `display: none` 隐藏），选中项底色 `--nt-sub-bg`。`handleThemePick(next)` 选择后**菜单保持打开**可连续预览；`glassPlan` state 记忆毛玻璃子主题（切去透明再切回不丢）。配色经 CSS 变量随主题适配，定义于 `.app`/`.theme-light`/`.theme-transparent`
- **菜单自动关闭**：鼠标移出即关（点击外部 `mousedown`、鼠标移出窗口也关）。三条防误关规则：① `menuHoveredRef` 门控——**必须先真正进过菜单本体**才启用「移出即关」（右键瞬间鼠标还停在图标上、离菜单几十像素，一上来就判定会把菜单秒关）；② 进菜单后 150ms 内的「掠过」不算离开；③ 菜单矩形外扩 24px 宽容区——从图标移向菜单的路上要掠过菜单底角/边缘，贴着走不算离开。「+」按钮只负责「保持打开」，不置位 hovered（否则鼠标一离开按钮就秒关）
- **文件夹悬停预览卡片**：悬停文件夹条目 300ms 弹出（`openFolderCard`），与「此电脑」盘符卡片同构、复用 `.drives-card` 浮层几何。三条关键设计：① **悬停即预取**——`mouseenter` 立刻 `listFolder()`，300ms 后真弹卡片时直接命中主进程缓存，看不到「先占位块再换图标」；② **延迟关闭 150ms 宽限**——鼠标从图标移到卡片上会先离开图标，宽限期内移入卡片即取消关闭（可继续在卡片里滚动看）；③ 同一目录且已加载完时只更新锚点，不清成「读取中」再重载（否则闪一下、缓存过期还要整目录重扫）。卡片宽度先按图标中心渲染，`useLayoutEffect` 测量后在 paint 前把水平位置钳制进窗口（贴边缘时内收，不会看到跳一下）。拖拽排序 / 文件拖入进行中不弹（会挡住落点指示线）
- **桌面图标开关**：菜单打开时 `getDesktopIconsHidden()` 读取状态决定文案（隐藏/显示），点击 `toggleDesktopIcons()` 乐观更新（先切文案，IPC 返回后校正）
- **开机自启动开关**：菜单打开时 `getAutoStart()` 读取注册表状态决定开关开/关（`.item-switch`），点击 `setAutoStart()` 乐观更新（先切开关，IPC 返回后校正，**不关闭菜单**）；写注册表 `HKCU\...\Run` 登录项
- **快捷方式/文件夹多选**：`parse-lnk` / `select-folder` 对话框均开 `multiSelections`，一次多选逐个生成条目（`handleAdd` / `handleAddFolder` 批量 append，文件夹图标统一取 shell32 黄色文件夹图标）
- **白天/黑夜/透明主题**：`theme` state（`'dark' | 'light' | 'transparent'`，由「+」菜单的**主题分段选择器**设置，见上条——不再是循环按钮），根元素加 `theme-light` / `theme-transparent` 类切换 CSS 变量（Dock 背景/标签/菜单/右键菜单全部跟随）；偏好持久化到 localStorage（key `ql-theme`）。**菜单配色与 Dock 统一**：`--menu-bg` 在黑暗/白天主题下**直接引用 `--dock-bg-top/bottom`**（`linear-gradient(180deg, var(--dock-bg-top) 0%, var(--dock-bg-bottom) 100%)`）——菜单与软件背景同色同透明度，仅靠 blur(20px) 毛玻璃与悬浮投影区分弹层。**透明风格**：`.theme-transparent` 在文件末尾覆盖——`.dock-bg` 背景/`backdrop-filter`/边框/阴影全部置空（图标直接悬浮桌面），`--dock-edge` 置透明（两端渐隐遮罩隐藏，滚动仍可用），图标底衬透明、悬停时给轻微底衬+外阴影，**下拉菜单/右键菜单同步全透明**（背景/毛玻璃/边框置空，保留悬浮投影），文字固定近黑 `#1f2430` + **白色描边**（详见下方「透明风格文字可读性」），编辑输入框浅白底 + 深字
- **左键点击**：启动程序/打开文件夹（拖拽启动后忽略点击）
- **右键菜单**：custom（编辑/打开文件位置/以管理员身份运行/复制路径/新建分组/在此之前插入分隔线/删除），fixed 定位、**向上弹出**（`data-edge='top'` 时整套浮层改由 `overlayTop()` 锚在玻璃条**下沿外侧**8px，向下弹出、`maxHeight` 按窗口剩余高度算），底边固定在实测的 Dock 毛玻璃条外侧 8px（`overlayBottom()` / `overlayTop()` 读 `.dock-bg` 的 rect，不硬编码）；水平锚点让**光标落在菜单内侧 8px**（`left: x - 8`，靠近窗口右缘时翻转为贴右缘向左展开）——早期写成 `left: x + 4` 会让光标停在菜单左缘外，垂直上移进不去、稍一横移就触发「移出即关」而秒关。`maxHeight` = Dock 栏上方可用空间（约 208px），超出时内部滚动。分隔线条目的菜单只有「删除」；**Dock 空白处右键不再弹菜单**。**编辑模式**：菜单内切换为表单（名称/启动参数/工作目录 + 更换图标 + 保存/取消），`editingId` 控制；更换图标走 `pick-icon` IPC（exe/dll/ico 提取、png/jpg 直读）；「打开位置」仅文件系统路径显示（`explorer /select`），「管理员运行」仅程序条目（`isFolder`/`specialType`/URL 隐藏），「复制路径」始终显示。编辑表单输入框需 `user-select: text`（全局 `user-select: none`）
- **拖拽排序**：mousedown 设置 dragRef → mousemove 超过 5px 阈值启动拖拽 → 计算 dropIdx 显示蓝色指示线 → mouseup 执行数组重排。`calcDropIndex` 与悬停放大共用同一份几何缓存，**两处都必须在内容坐标里比较**（见上方坐标系说明——v1.12.0 漏了 `scrollLeft`，Dock 滚动后插入位置会偏）。**防误启动**：真实拖拽结束时（mouseup 时 `dragStartedRef` 为 true）置 `suppressClickRef=true`，紧随其后的 click 在 `handleRun` 中被吞掉——click 在 mouseup 之后才派发，此时 `setDragId(null)` 已生效，仅凭 `dragId` 判断不可靠；每次新的 mousedown 先清除该标记，避免误吞正常点击
- **放大效果**：`handleDockMouseMove` 在几何缓存上二分定位，只对左右各 140px 内的图标缩放 + 上浮（拖拽时暂停）。**不要改回「逐图标 getBoundingClientRect」**——那是 layout thrashing，详见上方「悬停放大走几何缓存」
- **持久化（v1.12.0 起是 400ms 防抖 + 退出落盘）**：`apps` 变化时 `useEffect` 设置一个 400ms 防抖定时器再 `saveShortcuts()`，启动时 `useEffect` 自动恢复。**不要改回「每次变更立刻保存」**——拖拽排序每帧都会变更一次 `apps`，那等于每帧跨进程克隆整个数组（含全部 base64 图标）+ `JSON.stringify` + 写盘。退出时由主进程 `before-quit` 推 `flush-pending-save`（并留 200ms）让 renderer 立刻落盘；renderer 卸载时也会 flush 一次。**必须用 `before-quit` 而不是 `will-quit`**——后者触发时窗口已销毁、IPC 不通，兜底是无效的
- **文件夹图标：直接存真实 data URL（v1.12.2 撤掉哨兵，别再引入中间态）**：v1.12.0 曾把文件夹条目的图标换成一个短哨兵串、渲染/写盘时再换回模块常量 `sharedFolderIcon`，想省内存和磁盘。**那个设计有致命缺陷**：`sharedFolderIcon` 只有一个赋值点（加载时从磁盘上找「带非空图标的文件夹条目」），而唯一给文件夹条目写图标的路径（桌面扫描）又存的是哨兵、把主进程刚提取好的真图标丢了 → **全新安装首启就把空串写进磁盘，而且永远自愈不了**（详见 CHANGELOG v1.12.2）。现在每条自帶真图标；模块级 `sharedFolderIcon` 只作为**修复源**（启动时回填历史坏数据的空图标、兜住主进程没给图标的扫描结果）。
  - 实测这笔优化的全部收益（60 个文件夹）：结构化克隆 0.11ms、`JSON.stringify` 0.19ms、磁盘 152KB——而且 V8 会把内容相同的字符串内部化，**renderer 侧的堆增量 ≈ 一份图标**而不是 N 份。为一个「能自锁成空值」的中间态去省这点东西，完全不划算
  - 教训：**写入路径上的「换算」必须以「换算不出来会怎样」为前提设计**。这个哨兵的失败模式是「写坏数据」而不是「少写数据」，代价差了一个量级
- **分组（Stack）**：`isGroup` 条目点击展开面板而不启动；成员用 `groupId` 归属（**扁平模型，不嵌套**——桌面扫描/缺失清理/持久化全部沿用原逻辑）。右键图标「新建分组」创建空组并横向滚动到末尾；分组图标默认渲染**组内前 4 个非分隔线成员的缩略拼图**（0 个成员回退 2×2 网格图标、1 个放大单图、用户换过图标则用自定义图标），右下角 `.dock-badge` 显示成员数（徽标贴图标框内侧：负偏移会被滚动容器裁掉下沿）。拖到分组图标上即归组（插到该组现有成员之后），从面板拖到 Dock 条内即移出，删除分组=解散（成员回顶层、保留相对位置）；编辑表单对分组只留名称 + 图标
- **分组面板（迷你 Dock）**：与主 Dock 同构——顶部透明放大区 + 玻璃条，条目**直接复用 `.dock-item` 系列样式**、悬停放大走同一个 `magnify()`、滚轮横向滚动用原生非被动监听；宽度 `max-content`（有几个图标就多宽，超出窗口宽度才滚动），**高度固定**，因此完全不改变窗口尺寸（这也是透明窗口 resize 白闪的根治手段）。菜单打开期间面板用 `visibility: hidden` 隐藏——两者同处 Dock 栏上方一条带，而窗口只有 300px 高，无法叠放
- **数组不变量**：分组成员在扁平数组里**紧跟其分组条目之后**（归组时插到该组现有成员末尾）。桌面扫描合并的 `rest` 保持相对顺序，所以成员区不会被扫描打散；任何顶层插入/重排都必须经 `topAnchorId` 换算，否则会插进成员区块中间

### 透明风格文字可读性（v1.11.0）

透明模式下文字直接压在壁纸上，必须有一圈与底色反差的外轮廓才读得清。**三种写法都实测过**（定义在 `App.css` 的「透明风格的文字可读性」段）：

| 写法 | 结论 |
|---|---|
| 单个方向的柔和白晕（`0 0 6px rgba(255,255,255,.3)`） | **不可行**——既不够亮以形成轮廓，颜色也和壁纸混在一起，中灰/复杂壁纸上文字直接融进背景 |
| 四向硬晕 + 柔晕（`text-shadow` 四个方向 1px + 一圈 blur） | 能看清，但那是**一圈模糊光晕**，文字边缘发毛、观感发糊（已按用户要求废弃） |
| **白色描边（现行）** | `-webkit-text-stroke: 0.65px rgba(255,255,255,.92)` + `paint-order: stroke fill`——在字形背后画一圈实心描边，**完全没有模糊**，边缘锐利，缩到 11px 也清楚 |

- **`paint-order: stroke fill` 是关键**：默认描边压在填充之上会把字吃细（发白/发糊）；改成先描边后填充，描边完整垫在字形底下
- **粗细有实测的平衡点：0.65px**。描边是骑在字形轮廓上画的，**越粗笔画越细**——0.5px 以下笔画开始缺，0.8px 以上字形被吃掉一圈显虚发粗（1.1px 明显过粗，用户反馈的第一版）
- 小字号（卡片副行、文件大小、面板空态）收细到 `0.5px`——同样 0.65px 压在 11px 的字上会显粗
- **透明模式下必须 `text-shadow: none`**：基础 `.dock-label` 自带深色投影（那是给毛玻璃主题用的，压在壁纸上只会脏），`.dock-item:hover .dock-label` 悬停还会再叠一层（不压掉的话悬停反而更糊）
- **新增透明模式下的文字元素时要挂上描边并清掉 text-shadow**（卡片这一组曾完全漏掉，是「字融进背景」最严重的地方）；壁纸亮度自适应方案已废弃——透明就是透明，靠描边保证可读性

### 特殊项目（此电脑 / 回收站）

已无独立 IPC（`add-special-item` 已移除，菜单入口同步删除）——系统位置仅由启动扫描 `scan-desktop-folders` 的 PS 脚本内联处理：CLSID、shell 命令、图标回退（shell32 硬编码索引）都硬编码在脚本里：

| 项目 | CLSID | shell32 回退索引 |
|---|---|---|
| 此电脑 | `{20D04FE0-3AEA-1069-A2D8-08002B30309D}` | index 15 |
| 回收站 | `{645FF040-5081-101B-9F08-00AA002F954E}` | index 31 |

图标解析流程（脚本内）：先查注册表 `HKCR\CLSID\{CLSID}\DefaultIcon` → 提取图标路径和索引 → 失败回退 shell32.dll 硬编码索引 → 再失败回退黄色文件夹图标。

### 图标提取机制

- 共享 C# P/Invoke 类 `IconExtractor`（模块级常量 `ICON_EXTRACTOR_CS`），通过 `SHDefExtractIcon` + `System.Drawing` 提取图标
- `extractIcon()` 封装：PowerShell 调用 → C# 提取 → Base64 → `data:image/png;base64,...` URL
- `parse-lnk` 复用 `ICON_EXTRACTOR_CS` 常量
- `select-folder` 复用 `extractIcon()`（`add-special-item` 已随菜单入口一并移除）
- URL 快捷方式图标解析链：`.url` 的 `IconFile` → favicon 下载 → 默认浏览器 exe → `shell32.dll` 地球图标（index 13）
- **尺寸按用途取（v1.12.0）**：`ICON_SIZE = 64`（Dock 图标 CSS 只有 44px、分组拼图 26px、预览卡片 17px）、`FOLDER_ICON_SIZE = 48`。原来一律 256px：PNG 大 4 倍，`SHDefExtractIcon` 还要多做一次高质量缩放；而这份 base64 要同时活在主进程状态、IPC 消息、renderer state、`shortcuts.json` 四处字符串里，是纯浪费
- **所有 PowerShell 调用统一走 `runPowerShell(psScript, timeout, done)`**（参数已带 `-NoProfile -NonInteractive`）——漏掉 `-NonInteractive` 时脚本遇到交互式提示会挂到超时，白占一个进程。超时 10 秒（`extractIcon`），每次调用启动新 `powershell.exe`
- **PowerShell 的代价是实打实的（实测本机 PowerShell 5.1）**：`powershell.exe -NoProfile -NonInteractive -Command <WinZ 脚本>` 单次 **690~785ms** CPU 时间——进程启动 ~450ms + .NET 运行时初始化 + `Add-Type` 编译 C# ~250ms，每次还额外占几十 MB 私有内存。**新增任何「事件里起 PowerShell」的逻辑前先想清楚触发频率**（`sendToBottom` 的 `SINK_GRACE_MS` 宽限期就是这么来的）
- **每个 PowerShell 脚本开头都强制 `[Console]::OutputEncoding = [Text.Encoding]::UTF8`**，适配中文 Windows GBK 编码——新增/修改 PS 脚本时务必保留，否则输出中文乱码
- **JS 模板字符串里内嵌的 PowerShell 脚本，写 Windows 路径必须用双反斜杠 `\\`**（如 `'C:\\Windows\\System32\\shell32.dll'`）——单反斜杠的 `\W`/`\S` 等会被 JS 当转义符吞掉，编译后路径变成 `C:WindowsSystem32...`（静默失效，Test-Path/图标提取返回空，无明显报错）。新增硬编码路径时务必双反斜杠

### 桌面图标显隐机制

- 共享 C# P/Invoke 类 `DesktopIcons`（模块级常量 `DESKTOP_ICONS_CS`）：`FindWindow`/`FindWindowEx` 找 `Progman` → `SHELLDLL_DefView`（失败回退 `WorkerW` 遍历）→ `SysListView32 "FolderView"`
- 切换：向 `SHELLDLL_DefView` 发 `WM_COMMAND 0x7402`——与 Windows「右键桌面 → 查看 → 显示桌面图标」底层完全一致。**不是发到 ListView 而是发到 DefView**（实测 ListView 无效）。切换后 Explorer 自动同步注册表 `HideIcons`，状态持久化，无需手动写注册表
- 状态读取：`IsWindowVisible(ListView)`，比读注册表更贴近真实视觉状态；找不到 ListView 时回退读注册表 `HKCU\...\Explorer\Advanced\HideIcons`
- 不用 `SHChangeNotify` 方案——该刷新在部分 Win11 系统上注册表翻转但桌面不刷新，故弃用
- `sendToBottom()` 用另一个 C# 类 `WinZ` 调 `SetWindowPos(hwnd, HWND_BOTTOM)`，通过 `getNativeWindowHandle()` 取窗口句柄

### 资源路径解析

`resolveResource(filename)` 先尝试 `<__dirname>/../../resources/`（开发环境），不存在则回退到 `<appPath>/../`（生产环境 asar 包外）。

### electron-vite 构建配置

[`electron-vite.config.ts`](electron-vite.config.ts) 定义三个构建目标：

| 目标 | 插件 | 说明 |
|---|---|---|
| `main` | `externalizeDepsPlugin` | 将 Electron/Node 依赖外部化，不打包进 bundle |
| `preload` | `externalizeDepsPlugin` | 同上 |
| `renderer` | `@vitejs/plugin-react` | React JSX/TS 支持，`@` 别名映射到 `src/renderer/src` |

### 打包配置

[`electron-builder.yml`](electron-builder.yml) 定义构建产物：
- appId: `com.quicklaunch.app`
- 额外资源：`resources/icon.ico` → `icon.ico`，`resources/tray-icon.ico` → `tray-icon.ico`
- Windows：`executableName: QuickLaunch`，图标 `resources/icon.ico`
- **排除源码和配置文件，仅打包编译输出**。**额外排除 `node_modules/**`**（v1.12.3）：三个产物都不在运行时 require 第三方包——main 只依赖 `electron` + Node 内置模块，preload 只依赖 `electron`，renderer 由 Vite 把 react/react-dom 全量打进 bundle。实测 asar 里的 `node_modules`（react/react-dom/scheduler）7.2 MB 纯属白占（asar 145.7 → 138.41 MB）。⚠️ 一旦将来真要引入外部/原生模块（例如 sqlite），**必须去掉这一行**，否则那个包不会被打进产物
- `electronDist: ./electron-v*.zip`：用项目根目录**手动下载**的 Electron 分发包打包，跳过网络下载（日志出现 `using custom electronDist zip file` 即为生效）。zip 已被 `.gitignore` 的 `electron-v*.zip` 规则忽略；需与 `package.json` 的 Electron 版本一致，换机器打包前删掉该行或用 `ELECTRON_MIRROR` 环境变量

### 持久化格式

快捷方式保存至 `{userData}/shortcuts.json`，格式为 `AppEntry[]` 数组。字段：`id`、`iconDataUrl`、`targetPath`、`arguments`、`workingDirectory`、`description`，可选 `isFolder`（文件夹）、`specialType`（`'this-pc'` / `'recycle-bin'`）、`isGroup`（分组）、`groupId`（所属分组 id）、`isSeparator`（分隔线）。`parse-lnk` 解析出的 `windowStyle`/`hotkey`/`iconLocation` 在持久化时被丢弃（`AppEntry` 不含这些字段）。**加载归一化在主进程 `load-shortcuts`**：非数组（文件被外部改坏）返回 `[]`——否则 renderer 的 `baseline.filter` 会抛错并中断整轮加载与桌面扫描（未 await 的 Promise rejection）；早期开发版写过的 `separator` 字段会被就地转成 `isSeparator: true`。

主题偏好（白天/黑夜）存在渲染端 localStorage（key `ql-theme`），不走 IPC 文件持久化——纯 UI 偏好，无需主进程参与。

Dock 停靠位置存在 `{userData}/window-position.json`——**只有一个字段**：`{"edge":"middle"|"bottom"|"top"}`。文件名沿用 v1.8.x 的「窗口位置记忆」文件（旧版写的 `{x,y,displayId}` 直接忽略，按默认位置启动）。读写都过一遍 `IMPLEMENTED_EDGES` 白名单，白名单外的档位（左/右竖排）一律归一化成 `DEFAULT_EDGE`（`middle`）——手改配置文件也改不出尺寸不对的窗口。

### 桌面自动扫描

- 启动时（renderer 加载完 `shortcuts.json` **之后**）自动调用 `scan-desktop-folders`：**单次 PowerShell 调用**完成枚举 + 图标提取（避免启动时拉起多个 powershell 进程）——枚举桌面文件夹 + 用 `WScript.Shell` 解析 `.lnk` 目标（目标为目录才纳入；`.url`/程序快捷方式跳过）
- **固定附加系统位置**：无论桌面枚举结果如何，都会追加「此电脑」「回收站」（`specialType: 'this-pc' | 'recycle-bin'`），注册表 CLSID 图标解析内嵌在脚本里（不再走 `resolveClsidIcon` 多进程调用）
- **图标兜底链**：文件夹统一黄色文件夹图标（shell32 index 4，与「添加文件夹」一致）→ 失败回退通用文档图标（index 1）；系统位置先用注册表解析的图标 → 失败回退黄色文件夹图标 → 通用文档图标
- 去重在 renderer：`normPath()`（去尾部 `\` + 小写）与 `saved`（加载结果）比较（系统位置的 `targetPath` 是 `shell:` 命令，同样参与比较）；新增条目按 `specialType` 有无分别标 `specialType` / `isFolder: true`，合并后由保存 effect 持久化
- **插入顺序**：updater 内纯合并——系统位置区块（既有 + 新增，按 此电脑→回收站 稳定排序）+ 新文件夹 + 其余（保持原顺序）。Dock 前部固定为此电脑/回收站/文件夹；若用户手动拖动过系统位置，下次合并会归位到区块前部
- **去重/排序/id 分配都在 updater 外完成**（StrictMode 双调用 updater 时无副作用；updater 内仍有防御性路径过滤，防止与启动早期手动添加竞态）
- 加载完成即解锁保存（`loadedRef`，不等扫描）；**顺序执行（load → prune → scan 链式）避免竞态**——若并行，扫描结果可能被 `loadShortcuts` 的 `setApps` 覆盖丢失
- **实时同步（v1.7.0）**：主进程 `startDesktopWatch()` 对桌面目录挂 `fs.watch`（非递归——只关心桌面直接子项，文件夹内部文件变化不触发；debounce 1s 聚合）→ `webContents.send('desktop-changed')` → renderer 重新执行「清理缺失 + 扫描合并」（`pruneMissingFolders` + `mergeDesktopScan`，与启动共用同一套逻辑，基线分别为当前列表/已加载列表）。`appsRef` 镜像最新列表供事件回调读取（避免过期闭包）；`desktopSyncBusyRef` 防重入——清理/扫描进行中跳过重复事件（debounce 只聚合 watch 事件，扫描自身耗时可更长）
- **缺失清理**：`pruneMissingFolders` 收集所有 `isFolder` 条目路径 → `check-folders-missing` IPC（主进程纯 `fs.existsSync`，无 PowerShell）→ 返回不存在子集 → 移出 Dock（随保存 effect 持久化）。系统位置（`shell:` 命令，`specialType` 条目）不参与。权衡：外部硬盘/网络盘未连接时其文件夹条目也会被清理（桌面文件夹重新连接后由扫描恢复，手动添加的需重新添加）
- 注意：被用户删除的桌面文件夹会从 Dock 移除（实时或下次启动），重新创建同名文件夹后会再次加入（暂无忽略列表——跳过某文件夹需在扫描脚本里加过滤）；桌面路径沿用 `D:\Desktop`（重定向桌面，回退系统桌面）
- **与分组/分隔线的交互**：扫描条目的 `targetPath` 恒非空，而分组与分隔线是空 `targetPath`，所以 `normPath('')` 虽进入去重集合也不会误判；清理只看 `isFolder && targetPath`，不会删掉分组或分隔线；合并时它们随 `rest` 保持相对顺序，成员区不会被打散

## 平台限制

此应用**仅限 Windows**。依赖 PowerShell、`WScript.Shell` COM、`SHDefExtractIcon` Win32 API、`System.Drawing` GDI+。

## 注意事项

- **无测试框架**、**无 ESLint/Prettier**
- `AppEntry` 类型在 [`src/preload/index.ts`](src/preload/index.ts)、[`src/renderer/src/App.tsx`](src/renderer/src/App.tsx)、[`src/renderer/src/env.d.ts`](src/renderer/src/env.d.ts) 三处各自定义，修改时需保持同步
- `env.d.ts` 再次复刻 API 类型到 `Window` 接口——contextBridge 隔离导致 Renderer 端类型必须在此声明
- `App.tsx` 使用模块级变量 `nextId`（非 React state）；启动时从已保存最大 ID + 1 重建
- **窗口不可拖拽**（v1.10.0 起）：`.dock` 不再是 `drag` 区域，全项目**没有任何 `-webkit-app-region` 声明**（CSS 里只剩两处解释性注释）。位置只能由 `presetPosition` 预设决定——新增交互时不要往 Dock 空白区加 drag
- 弹出层（「+」下拉菜单、右键菜单、「此电脑」卡片、文件夹卡片、分组面板）**必须渲染在滚动容器外**（fixed 定位 + 实测锚点）：`.dock-inner` 是横向滚动容器（`overflow-x: auto`），CSS 规范强制其垂直方向也裁剪，放容器内会被裁掉
- 滚动容器会裁剪垂直溢出的放大图标：`.dock-inner` 在贴边侧留 **70px** 透明 padding 作为放大+悬浮标签显示区（`data-edge='top'` 时这 70px 在下方，其余在顶部）；`.dock-bg` 背景层只覆盖图标区，放大图标从该区顶出显示在透明区
- 开发模式下窗口加载 `ELECTRON_RENDERER_URL` 环境变量 URL；生产模式下加载 `../renderer/index.html` 文件
- `setWindowOpenHandler` 拦截所有 `target=_blank`/新窗口请求：一律 `shell.openExternal()` 用默认浏览器打开并 `deny`，应用内不产生新窗口
- `webPreferences.sandbox: false`：preload 依赖 `process.contextIsolated` 分支和 `@electron-toolkit/preload`，改成 `true` 会破坏 contextBridge
- 关闭 → 隐藏托盘通过 `forceQuit` 标志区分：普通关闭 `preventDefault()` + `hide()`；托盘「退出」置 `forceQuit=true` 后 `app.quit()`。新增退出路径需同步设置该标志
- 拖拽排序的 `mousemove`/`mouseup` 监听挂在 `window` 上（非 dock 元素），鼠标移出窗口仍能完成排序；`mouseup` 在窗口外也会触发
- `run-app` 用 `execFile(targetPath, splitArgs(args))` 拆分参数——`splitArgs` 按空格切分但把双引号包裹段作为整体并剥引号（.lnk 的 Arguments 常带引号，如 `"E:\DSH\start-dsh.vbs"`；原样拆分会把字面引号传给 wscript 等宿主导致「Windows Script Host 执行失败」，顺带支持含空格的带引号参数）；含空格且无引号的参数仍不支持——已知限制
- **`run-app` 的失败判定只看「进程有没有起来」**：`err.code` 是**字符串**才是 spawn 级失败（ENOENT/EACCES/EPERM/UNKNOWN…），**数字则是进程正常启动、只是退出码非零**——很多应用/启动器带参数启动后会立刻以非零码退出，把这种当成失败会把 Dock 错误地拽回来。恢复显示统一走 `restoreDockAfterFailedLaunch()`
- **`run-app` 直接 spawn 被拒（`EACCES`/`EPERM`，多为程序需要管理员权限或杀软拦截裸 `CreateProcess`）时回退 `shell.openPath()`**——与资源管理器双击一致，自动弹 UAC 提权，代价是丢弃启动参数。该路径是已处理流程，只打单行 `console.log`，不打错误堆栈；其它 spawn 失败会**恢复显示 + 置顶**（点了图标却什么都没启动时 Dock 不能消失）
- **启动防连点必须按目标分别计时（v1.12.3 踩过，别再写成全局）**：`handleRun` 用 `lastRunAtRef: Map<targetPath, timestamp>`（窗口 600ms）而不是一个全局时间戳。曾经写成全局 `if (now - lastRunAtRef.current < 700) return`：启动 A 之后的 700ms 内点 B 会被**静默丢弃**——既不启动、也无任何反馈，表现为「Dock 不消失、软件也没起来」（分组面板连点成员时最易撞上）。而且这个守卫本来就不需要那么强：主进程 `run-app` 的**第一件事**就是 `mainWindow.hide()`（在 `CreateProcess` 之前），窗口随即消失、来不及被点第二次，它只需挡「同一次点击被派发两遍」
- **文件夹预览（`list-folder`）的三个坑**：① Windows 目录联接/符号链接在 `Dirent` 上是 `isDirectory()=false` + `isSymbolicLink()=true`，必须补一次 `stat` 才认得出是目录（否则算进文件数、按文件排序、显示字节大小、图标也不对）；② 超大目录（>4000 项）用 `Intl.Collator` 排序会比较百万次、把主进程卡住好几秒，超阈值退回廉价的字符串比较；③ 后台补图标（`fillFolderIcons`）每批前检查 `sender.isDestroyed()`，失效时**删掉自己写的那条缓存**——否则窗口重建后卡片在 TTL 内永远只有占位块，且没有任何补批会再来。**目录图标不能用 `app.getFileIcon`**（实测返回错图标），统一用启动时提取一次、常驻内存的 shell32 index 4 黄色文件夹图标
- `open-path` 与 `run-app` 的隐藏时机不同：`open-path`（预览卡片点条目 /「打开」）**先打开、成功后才隐藏** Dock；`run-app`（点 Dock 图标）先隐藏再启动，但**启动失败会恢复显示 + 置顶**。两条都不要改成「无条件先隐藏」——目标不存在时用户看到的是「点了没反应、Dock 还消失了」
- **保存守卫（防清盘）**：保存 effect 在 `loadedRef`（初始加载完成前）为 false 时直接跳过——挂载时 `apps=[]` 不再覆盖 `shortcuts.json`。否则在 **React.StrictMode 双挂载**下，`save([])` 会先清空文件，第二次 `load` 读到空文件返回 `[]`，已保存条目永久丢失（桌面自动扫描的文件夹会靠重新扫描"复活"，手动添加的程序快捷方式则彻底消失）。`main.tsx` 使用了 `<React.StrictMode>`，改动持久化流程时必须保留该守卫
- **⚠️ 本机 shell 是 Windows PowerShell 5.1（不是 7）**：`Get-Content`/`Set-Content` 默认按 **ANSI/GBK** 读写，用它批量改写 UTF-8 源文件会造成**不可逆的中文丢失**（本项目曾因此损坏 `App.tsx` 150 行 / 319 个字符，靠 git HEAD 匹配 + 逐行修复表才救回）。改文件一律用编辑器工具，或显式 `[System.IO.File]::ReadAllText/WriteAllText` + `New-Object System.Text.UTF8Encoding($false)`；含中文的 `.ps1` 脚本必须先加 UTF-8 BOM 再交给 `powershell -File` 执行
  - **不只是中文丢失**：`(Get-Content -Raw) -replace ... | Set-Content -NoNewline` 这类「读-改-写」还会**悄悄合并行尾**，把脚本压成一行并抛出 `SyntaxError`（`return outside function`）。v1.13.0 做图标时用这招改 `.dsh-vision-toolkit/make-icons.mjs` 就中了一次，中文注释也全成了 mojibake。**结论：任何源文件（含自己写的生成脚本）都只用编辑器工具改，PowerShell 只用来读和跑命令**——它是本项目第二起同类事故了
- **版本号管理**：git 提交信息用版本号（如 `v1.6.0: ...`），但仓库**无 git tag**；`package.json` 的 `version` 字段需手动同步（当前已同步为 `1.13.0`，每次发布需手动更新）
- 项目有 [`CHANGELOG.md`](CHANGELOG.md) 按版本记录变更（当前记录到 v1.13.0），功能变更后需同步更新，并与提交信息版本对齐
- 窗口 `resizable: false`，尺寸固定（85% 屏宽 ≤ 1200px × 300px）
