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

- `transparent: true` + `frame: false` 透明无边框窗口（300px 高，85% 屏幕宽，最大 1200px，居中）
- `alwaysOnTop: true` + `skipTaskbar: true` — 常驻桌面，不在任务栏显示
- **自动让位**：Dock 沉到 z-order 最底不遮挡，鼠标移回 / 点击 Dock / Alt+Space / 托盘唤出恢复置顶。**只有点击其他软件（`blur`）才让位**——鼠标移出 Dock、或在其他软件上滚动滚轮都不沉底，用户可自由移动鼠标：
  1. `blur` 事件（点击其他窗口失去焦点）→ 立即 `setAlwaysOnTop(false)` + `sendToBottom()`（点击其他软件是有意让位）；**窗口已隐藏（`isVisible()` 为 false）时跳过**——`run-app` 隐藏到托盘触发的 blur 不再白跑一次 PowerShell 沉底
  2. `run-app` 启动目标后**自动隐藏到托盘**（`mainWindow.hide()`，不退出进程）——用户点开图标后 Dock 彻底让出桌面；托盘左键 / Alt+Space / 托盘菜单「显示窗口」随时唤回（`toggleWindow` 按 `isVisible()` 判断，隐藏状态下任一唤回路径均显示并恢复置顶）
- **对话框期间不沉底**：`dialogOpen` 标志（模块级 `let`），`parse-lnk` / `select-folder` 弹系统文件对话框前置 `true`（并 `setAlwaysOnTop(true)` + `moveTop()` 保持置顶），`try/finally` 归零。`blur` 沉底逻辑检查该标志——模态对话框是 Dock 的子窗口，跟随父窗口层级，若对话框抢焦点触发沉底会把选择器连带压到其他软件下面
- **恢复置顶**：`focus` 事件（点击 Dock / Alt+Space / 托盘唤出）、renderer `mouseenter`（`dock-pointer(true)`）→ `setAlwaysOnTop(true)` + `moveTop()`
- **关键坑**：`setAlwaysOnTop(false)` 只是从置顶层降级（`HWND_NOTOPMOST`），z-order 仍停在非置顶组顶部——Explorer 也是非置顶窗口，Dock 依然盖在它上面。**必须再 `sendToBottom()` 调 `SetWindowPos(hwnd, HWND_BOTTOM)` 真正沉底**（Electron 没有 `moveBottom()`，只能走 PowerShell P/Invoke）
- Dock 栏在窗口底部。毛玻璃背景是**独立层 `.dock-bg`**：只覆盖图标区（图标垂直居中），`blur(36px) saturate(1.7)`、圆角 24px、边框 + 阴影
- Dock 空白区域可拖拽移动窗口（`-webkit-app-region: drag`）
- **多显示器 + 位置记忆**：`moved` 事件（debounce 500ms）把窗口坐标写入 `{userData}/window-position.json`（含 displayId）；`createWindow` 启动时读取，坐标需落在某显示器工作区内（`readWindowPosition()` 校验，显示器移除/分辨率变化时回退主屏居中）
- 图标排列在 Dock 内，鼠标悬停放大效果（JS 驱动，最大放大 1.4×，上浮 8px，影响半径 140px）。放大图标从背景顶部**透明区顶出**（类似 macOS）——`.dock-inner` 顶部有 **70px** 透明 padding 作为放大+悬浮标签显示区，否则 `overflow` 会把放大溢出裁掉
- **标签悬停显示（三主题一致）**：`.dock-label` 默认隐藏，鼠标悬停图标时淡入（0.16s）；标签**绝对定位悬浮在图标上方**（macOS 式，不占图标下方布局行——玻璃条紧凑贴合图标），完整显示名称不截断；每主题一个药丸底衬（`--label-pill-bg`：黑夜=深藏青 `rgba(12,16,28,0.55)` 白字、白天=浅白玻璃 `rgba(255,255,255,0.75)` 深字、透明=中性深灰 `rgba(0,0,0,0.30)` 白字）；「+」添加按钮不显示悬浮标签
- 图标放不下时**横向滚动**：`.dock-inner` 是滚动容器（`overflow-x: auto`，隐藏滚动条），滚轮/触控板转水平滚动（原生 `addEventListener('wheel', …, { passive: false })`——React 在 root 上以 passive 注册 wheel，`onWheel` 里 `preventDefault()` 是空操作）；两端 `dock-edge` 渐隐遮罩提示「还有更多」，仅可滚动侧显示（`scrollState`）
- 图标支持拖拽排序（自定义 mousedown/mousemove/mouseup 事件，5px 阈值区分点击和拖拽，蓝色指示线显示插入点）。**落点换算**：`calcDropIndex` 返回的是「顶层图标」下标（`iconRefs` 里只有顶层条目 + 分隔线），而 `apps` 是扁平数组（含分组成员），所以重排与拖入添加都必须用 `topAnchorId(list, idx)` 先换成锚点 id 再取扁平插入点——直接把顶层下标当扁平下标用会让插入位置偏「成员数」个槽位
- **拖入文件添加**：从资源管理器拖 `.lnk`/`.url`/`.pif`/`.exe`/`.com` 到 Dock 栏即添加（**仅 Dock 栏区域**响应，其余位置显示禁止光标）。Electron 32+ 已移除 `File.path`，路径只能由 preload 的 `webUtils.getPathForFile` 提供；主进程 `describe-paths` 分派解析（快捷方式复用 `parseLnkFile`，exe 走单次 PowerShell 批量取 FileDescription + 图标，提取失败回退 shell32 通用图标），renderer 按落点插入、按路径去重（重复或格式不支持则跳过并提示）。**整窗**都要 `dragover`/`drop` preventDefault，否则 Chromium 会把窗口导航到 `file://`（白屏）
- **分隔线**：`isSeparator` 特殊条目——1px 渐变柔线（比图标矮、两端淡出、随主题变色），只从图标右键「在此之前插入分隔线」创建；可拖拽排序、随 `shortcuts.json` 持久化；不启动、不参与桌面扫描去重/清理/键盘导航/悬停放大。命中区做成 9px（可视竖线仅 1px）+ `z-index: 20`：1px 太细时旁边放大中的图标（`magnify` 给图标设 `z-index: 10`）会压住它，右键点不中
- **键盘导航**：`Alt+Space` 唤出 Dock 时主进程 `webContents.send('nav-enter')` → renderer 进入导航模式（`navId`）。`←/→` 不循环移动、`Enter` 启动、`Esc` 退出；分组上 `→`/`Enter` 展开面板并把选中移入第一个**非分隔线**成员、`←`/`Esc` 返回主 Dock；可导航到末尾的「+」按钮（`ADD_BTN_ID = -1` 哨兵，Enter 打开菜单）。选中位置写入 localStorage `ql-nav-last`，启动/唤出/方向键唤醒都恢复到它（条目失效则回落第一个）。选中态是左右两条渐变竖框（`.dock-item.selected` / `.drop-target` 共用），并靠 `.dock-item { scroll-margin-inline: 14px }` 保留滚动余量——否则 `scrollIntoView({ inline: 'nearest' })` 会把容器内边距一起滚掉，最左图标的左框被裁

### 系统托盘 + 快捷键

- **Alt+Space** 全局快捷键：隐藏/不可见时按 → 唤回置顶；可见（置顶或沉底）时按 → 隐藏到托盘。`toggleWindow()` 用**自维护意图状态 `dockTrayHidden`**（非 `isAlwaysOnTop()`——桌面无其他窗口时前台锁会拒绝激活，Dock 获得焦点约 500ms 后被抢回产生虚假 `blur` 沉底，读置顶位会陷入「显示→被压底→再显示」死循环，v1.7.1 修复）。`dockTrayHidden` 在所有显示/隐藏路径同步维护（run-app 隐藏、close 到托盘、`--autostart` 启动、second-instance、托盘「显示窗口」、dock-pointer、focus）。优先注册 Alt+Space，失败自动回退 `Ctrl+Alt+Space`；Ctrl+Alt 在 Windows 上等同 AltGr，易被输入法/键盘布局占用。**键盘唤出**（`toggleWindow(true)`，仅全局快捷键路径；托盘点击不传该参数）时额外 `webContents.send('nav-enter')`，renderer 据此进入键盘导航模式
- 关闭窗口 → 隐藏到系统托盘（不退出）
- 托盘左键单击 → `toggleWindow()`（同上逻辑）
- 托盘右键菜单 →「显示窗口」/「退出」
- 托盘图标：[`resources/tray-icon.png`](resources/tray-icon.png)（16×16）
- 应用图标：[`resources/icon.ico`](resources/icon.ico)

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
| `save-shortcuts` | Renderer → Main | 保存持久化数据到 `{userData}/shortcuts.json` |
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

### React UI

App 是**唯一的 React 组件**（[`src/renderer/src/App.tsx`](src/renderer/src/App.tsx)）：

- 单个 `useState<AppEntry[]>` 管理快捷方式列表
- 模块级 `nextId` 生成自增 ID，启动时从已保存最大 ID + 1 恢复
- **Dock 栏**：底部毛玻璃横栏，图标水平排列，gap 4px；内容超过宽度时横向滚动
- **+ 按钮**：Dock 末尾的添加按钮，点击展开下拉菜单（添加快捷方式/文件夹/**主题嵌套选择器**/**隐藏或显示桌面图标**/**开机自启动**；「此电脑」「回收站」由启动扫描自动加入，无手动入口）。菜单**渲染在滚动容器之外**（fixed 定位）：`addBtnRef` 提供按钮坐标存入 `menuPos` state，菜单底边对齐按钮上方 8px。滚动容器的 `overflow` 会裁剪向上弹出的菜单，故不能放容器内。菜单加 `maxHeight: menuPos.top - 8` + `overflow-y: auto`——超过窗口内可用高度时内部滚动，滚动条隐藏（与 `.dock-inner` 一致），滚轮/触控板滚动；水平位置钳制在窗口内（`Math.min(Math.max(cx, 100), innerWidth - 100)`），防止按钮靠窗口右缘时菜单伸出被裁掉圆角
- **主题分段选择器**（`.theme-seg`，纯 flex 分段控件——绝对定位滑块方案反复出布局问题后重写）：主行「透明 | 毛玻璃」两段（激活项自带底色 `--nt-ink` 高亮 + 文字 `--nt-ink-on`）；毛玻璃激活时下方展开子行「黑夜 | 白天」（透明态 `display: none` 隐藏），选中项底色 `--nt-sub-bg`。`handleThemePick(next)` 选择后**菜单保持打开**可连续预览；`glassPlan` state 记忆毛玻璃子主题（切去透明再切回不丢）。配色经 CSS 变量随主题适配，定义于 `.app`/`.theme-light`/`.theme-transparent`
- **菜单自动关闭**：鼠标移出即关（点击外部 `mousedown`、鼠标移出窗口也关）。三条防误关规则：① `menuHoveredRef` 门控——**必须先真正进过菜单本体**才启用「移出即关」（右键瞬间鼠标还停在图标上、离菜单几十像素，一上来就判定会把菜单秒关）；② 进菜单后 150ms 内的「掠过」不算离开；③ 菜单矩形外扩 24px 宽容区——从图标移向菜单的路上要掠过菜单底角/边缘，贴着走不算离开。「+」按钮只负责「保持打开」，不置位 hovered（否则鼠标一离开按钮就秒关）
- **桌面图标开关**：菜单打开时 `getDesktopIconsHidden()` 读取状态决定文案（隐藏/显示），点击 `toggleDesktopIcons()` 乐观更新（先切文案，IPC 返回后校正）
- **开机自启动开关**：菜单打开时 `getAutoStart()` 读取注册表状态决定开关开/关（`.item-switch`），点击 `setAutoStart()` 乐观更新（先切开关，IPC 返回后校正，**不关闭菜单**）；写注册表 `HKCU\...\Run` 登录项
- **快捷方式/文件夹多选**：`parse-lnk` / `select-folder` 对话框均开 `multiSelections`，一次多选逐个生成条目（`handleAdd` / `handleAddFolder` 批量 append，文件夹图标统一取 shell32 黄色文件夹图标）
- **白天/黑夜/透明主题**：`theme` state（`'dark' | 'light' | 'transparent'`，由「+」菜单的**主题分段选择器**设置，见上条——不再是循环按钮），根元素加 `theme-light` / `theme-transparent` 类切换 CSS 变量（Dock 背景/标签/菜单/右键菜单全部跟随）；偏好持久化到 localStorage（key `ql-theme`）。**菜单配色与 Dock 统一**：`--menu-bg` 在黑暗/白天主题下**直接引用 `--dock-bg-top/bottom`**（`linear-gradient(180deg, var(--dock-bg-top) 0%, var(--dock-bg-bottom) 100%)`）——菜单与软件背景同色同透明度，仅靠 blur(20px) 毛玻璃与悬浮投影区分弹层。**透明风格**：`.theme-transparent` 在文件末尾覆盖——`.dock-bg` 背景/`backdrop-filter`/边框/阴影全部置空（图标直接悬浮桌面），`--dock-edge` 置透明（两端渐隐遮罩隐藏，滚动仍可用），图标底衬透明、悬停时给轻微底衬+外阴影，**下拉菜单/右键菜单同步全透明**（背景/毛玻璃/边框置空，保留悬浮投影），文字固定近黑 `#1f2430` + 白色光晕投影（曾试过 desktopCapturer 采样壁纸亮度自适应黑/白字，已按需求移除——透明就是透明），加号白 0.92 + 双层深投影，编辑输入框浅白底 + 深字
- **左键点击**：启动程序/打开文件夹（拖拽启动后忽略点击）
- **右键菜单**：custom（编辑/打开文件位置/以管理员身份运行/复制路径/新建分组/在此之前插入分隔线/删除），fixed 定位、**向上弹出**，底边固定在实测的 Dock 毛玻璃条上方 8px（`overlayBottom()` 读 `.dock-bg` 的 rect，不硬编码）；水平锚点让**光标落在菜单内侧 8px**（`left: x - 8`，靠近窗口右缘时翻转为贴右缘向左展开）——早期写成 `left: x + 4` 会让光标停在菜单左缘外，垂直上移进不去、稍一横移就触发「移出即关」而秒关。`maxHeight` = Dock 栏上方可用空间（约 208px），超出时内部滚动。分隔线条目的菜单只有「删除」；**Dock 空白处右键不再弹菜单**。**编辑模式**：菜单内切换为表单（名称/启动参数/工作目录 + 更换图标 + 保存/取消），`editingId` 控制；更换图标走 `pick-icon` IPC（exe/dll/ico 提取、png/jpg 直读）；「打开位置」仅文件系统路径显示（`explorer /select`），「管理员运行」仅程序条目（`isFolder`/`specialType`/URL 隐藏），「复制路径」始终显示。编辑表单输入框需 `user-select: text`（全局 `user-select: none`）
- **拖拽排序**：mousedown 设置 dragRef → mousemove 超过 5px 阈值启动拖拽 → 计算 dropIdx 显示蓝色指示线 → mouseup 执行数组重排。`calcDropIndex` 用 `getBoundingClientRect` 视口坐标，Dock 滚动后仍正确。**防误启动**：真实拖拽结束时（mouseup 时 `dragStartedRef` 为 true）置 `suppressClickRef=true`，紧随其后的 click 在 `handleRun` 中被吞掉——click 在 mouseup 之后才派发，此时 `setDragId(null)` 已生效，仅凭 `dragId` 判断不可靠；每次新的 mousedown 先清除该标记，避免误吞正常点击
- **放大效果**：`handleDockMouseMove` 计算鼠标到每个图标的距离，< 140px 时缩放 + 上浮（拖拽时暂停）
- **持久化**：`apps` 变化时 `useEffect` 自动保存，启动时 `useEffect` 自动恢复
- **分组（Stack）**：`isGroup` 条目点击展开面板而不启动；成员用 `groupId` 归属（**扁平模型，不嵌套**——桌面扫描/缺失清理/持久化全部沿用原逻辑）。右键图标「新建分组」创建空组并横向滚动到末尾；分组图标默认渲染**组内前 4 个非分隔线成员的缩略拼图**（0 个成员回退 2×2 网格图标、1 个放大单图、用户换过图标则用自定义图标），右下角 `.dock-badge` 显示成员数（徽标贴图标框内侧：负偏移会被滚动容器裁掉下沿）。拖到分组图标上即归组（插到该组现有成员之后），从面板拖到 Dock 条内即移出，删除分组=解散（成员回顶层、保留相对位置）；编辑表单对分组只留名称 + 图标
- **分组面板（迷你 Dock）**：与主 Dock 同构——顶部透明放大区 + 玻璃条，条目**直接复用 `.dock-item` 系列样式**、悬停放大走同一个 `magnify()`、滚轮横向滚动用原生非被动监听；宽度 `max-content`（有几个图标就多宽，超出窗口宽度才滚动），**高度固定**，因此完全不改变窗口尺寸（这也是透明窗口 resize 白闪的根治手段）。菜单打开期间面板用 `visibility: hidden` 隐藏——两者同处 Dock 栏上方一条带，而窗口只有 300px 高，无法叠放
- **数组不变量**：分组成员在扁平数组里**紧跟其分组条目之后**（归组时插到该组现有成员末尾）。桌面扫描合并的 `rest` 保持相对顺序，所以成员区不会被扫描打散；任何顶层插入/重排都必须经 `topAnchorId` 换算，否则会插进成员区块中间

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
- PowerShell 超时 10 秒（`extractIcon`），每次调用启动新 `powershell.exe`
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
- 额外资源：`resources/icon.ico` → `icon.ico`，`resources/tray-icon.png` → `tray-icon.png`
- Windows：`executableName: QuickLaunch`，图标 `resources/icon.ico`
- 排除源码和配置文件，仅打包编译输出
- `electronDist: ./electron-v*.zip`：用项目根目录**手动下载**的 Electron 分发包打包，跳过网络下载（日志出现 `using custom electronDist zip file` 即为生效）。zip 已被 `.gitignore` 的 `electron-v*.zip` 规则忽略；需与 `package.json` 的 Electron 版本一致，换机器打包前删掉该行或用 `ELECTRON_MIRROR` 环境变量

### 持久化格式

快捷方式保存至 `{userData}/shortcuts.json`，格式为 `AppEntry[]` 数组。字段：`id`、`iconDataUrl`、`targetPath`、`arguments`、`workingDirectory`、`description`，可选 `isFolder`（文件夹）、`specialType`（`'this-pc'` / `'recycle-bin'`）、`isGroup`（分组）、`groupId`（所属分组 id）、`isSeparator`（分隔线）。`parse-lnk` 解析出的 `windowStyle`/`hotkey`/`iconLocation` 在持久化时被丢弃（`AppEntry` 不含这些字段）。**加载归一化在主进程 `load-shortcuts`**：非数组（文件被外部改坏）返回 `[]`——否则 renderer 的 `baseline.filter` 会抛错并中断整轮加载与桌面扫描（未 await 的 Promise rejection）；早期开发版写过的 `separator` 字段会被就地转成 `isSeparator: true`。

主题偏好（白天/黑夜）存在渲染端 localStorage（key `ql-theme`），不走 IPC 文件持久化——纯 UI 偏好，无需主进程参与。

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
- 窗口拖拽：`.dock` 设为 `drag` 区域，所有交互元素（`.dock-inner`、`.dock-item`、`.dropdown-menu`、`.context-menu` 等）显式设为 `no-drag`
- `.dock-inner` 是横向滚动容器（`overflow-x: auto`），CSS 规范强制其垂直方向也裁剪——**向上弹出的下拉菜单必须渲染在容器外**（fixed 定位），放容器内会被裁掉
- 滚动容器会裁剪垂直溢出的放大图标，`.dock-inner` 顶部 70px 透明 padding 即预留的放大+悬浮标签显示区；`.dock-bg` 背景层只覆盖图标区，放大图标从该区顶出显示在透明区
- 开发模式下窗口加载 `ELECTRON_RENDERER_URL` 环境变量 URL；生产模式下加载 `../renderer/index.html` 文件
- `setWindowOpenHandler` 拦截所有 `target=_blank`/新窗口请求：一律 `shell.openExternal()` 用默认浏览器打开并 `deny`，应用内不产生新窗口
- `webPreferences.sandbox: false`：preload 依赖 `process.contextIsolated` 分支和 `@electron-toolkit/preload`，改成 `true` 会破坏 contextBridge
- 关闭 → 隐藏托盘通过 `forceQuit` 标志区分：普通关闭 `preventDefault()` + `hide()`；托盘「退出」置 `forceQuit=true` 后 `app.quit()`。新增退出路径需同步设置该标志
- 拖拽排序的 `mousemove`/`mouseup` 监听挂在 `window` 上（非 dock 元素），鼠标移出窗口仍能完成排序；`mouseup` 在窗口外也会触发
- `run-app` 用 `execFile(targetPath, splitArgs(args))` 拆分参数——`splitArgs` 按空格切分但把双引号包裹段作为整体并剥引号（.lnk 的 Arguments 常带引号，如 `"E:\DSH\start-dsh.vbs"`；原样拆分会把字面引号传给 wscript 等宿主导致「Windows Script Host 执行失败」，顺带支持含空格的带引号参数）；含空格且无引号的参数仍不支持——已知限制
- `run-app` 直接 spawn 被拒（`EACCES`/`EPERM`，多为程序需要管理员权限或杀软拦截裸 `CreateProcess`）时**回退 `shell.openPath()`**——与资源管理器双击一致，自动弹 UAC 提权，代价是丢弃启动参数。该路径是已处理流程，只打单行 `console.log`，不打错误堆栈
- **保存守卫（防清盘）**：保存 effect 在 `loadedRef`（初始加载完成前）为 false 时直接跳过——挂载时 `apps=[]` 不再覆盖 `shortcuts.json`。否则在 **React.StrictMode 双挂载**下，`save([])` 会先清空文件，第二次 `load` 读到空文件返回 `[]`，已保存条目永久丢失（桌面自动扫描的文件夹会靠重新扫描"复活"，手动添加的程序快捷方式则彻底消失）。`main.tsx` 使用了 `<React.StrictMode>`，改动持久化流程时必须保留该守卫
- **⚠️ 本机 shell 是 Windows PowerShell 5.1（不是 7）**：`Get-Content`/`Set-Content` 默认按 **ANSI/GBK** 读写，用它批量改写 UTF-8 源文件会造成**不可逆的中文丢失**（本项目曾因此损坏 `App.tsx` 150 行 / 319 个字符，靠 git HEAD 匹配 + 逐行修复表才救回）。改文件一律用编辑器工具，或显式 `[System.IO.File]::ReadAllText/WriteAllText` + `New-Object System.Text.UTF8Encoding($false)`；含中文的 `.ps1` 脚本必须先加 UTF-8 BOM 再交给 `powershell -File` 执行
- **版本号管理**：git 提交信息用版本号（如 `v1.6.0: ...`），但仓库**无 git tag**；`package.json` 的 `version` 字段需手动同步（当前已同步为 `1.9.0`，每次发布需手动更新）
- 项目有 [`CHANGELOG.md`](CHANGELOG.md) 按版本记录变更（当前记录到 v1.9.0），功能变更后需同步更新，并与提交信息版本对齐
- 窗口 `resizable: false`，尺寸固定（85% 屏宽 ≤ 1200px × 300px）
