# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 常用命令

```bash
npm run dev         # 启动开发模式（Vite HMR + Electron 热重载）
npm run build       # 生产构建
npm run typecheck   # TypeScript 类型检查（tsc --noEmit）
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
  1. `blur` 事件（点击其他窗口失去焦点）→ 立即 `setAlwaysOnTop(false)` + `sendToBottom()`（点击其他软件是有意让位）
  2. `run-app` 启动目标前 `setAlwaysOnTop(false)`，让新程序窗口浮到 Dock 之上
- **对话框期间不沉底**：`dialogOpen` 标志（模块级 `let`），`parse-lnk` / `select-folder` 弹系统文件对话框前置 `true`（并 `setAlwaysOnTop(true)` + `moveTop()` 保持置顶），`try/finally` 归零。`blur` 沉底逻辑检查该标志——模态对话框是 Dock 的子窗口，跟随父窗口层级，若对话框抢焦点触发沉底会把选择器连带压到其他软件下面
- **恢复置顶**：`focus` 事件（点击 Dock / Alt+Space / 托盘唤出）、renderer `mouseenter`（`dock-pointer(true)`）→ `setAlwaysOnTop(true)` + `moveTop()`
- **关键坑**：`setAlwaysOnTop(false)` 只是从置顶层降级（`HWND_NOTOPMOST`），z-order 仍停在非置顶组顶部——Explorer 也是非置顶窗口，Dock 依然盖在它上面。**必须再 `sendToBottom()` 调 `SetWindowPos(hwnd, HWND_BOTTOM)` 真正沉底**（Electron 没有 `moveBottom()`，只能走 PowerShell P/Invoke）
- Dock 栏在窗口底部。毛玻璃背景是**独立层 `.dock-bg`**：只覆盖图标区（图标垂直居中，上下各 8px），`blur(32px) saturate(1.6)` 圆角阴影
- Dock 空白区域可拖拽移动窗口（`-webkit-app-region: drag`）
- 图标排列在 Dock 内，鼠标悬停放大效果（JS 驱动，最大放大 1.4×，上浮 8px，影响半径 140px）。放大图标从背景顶部**透明区顶出**（类似 macOS）——`.dock-inner` 顶部有 44px 透明 padding 作为放大显示区，否则 `overflow` 会把放大溢出裁掉
- 图标放不下时**横向滚动**：`.dock-inner` 是滚动容器（`overflow-x: auto`，隐藏滚动条），滚轮/触控板转水平滚动（`handleDockWheel`）；两端 `dock-edge` 渐隐遮罩提示「还有更多」，仅可滚动侧显示（`scrollState`）
- 图标支持拖拽排序（自定义 mousedown/mousemove/mouseup 事件，5px 阈值区分点击和拖拽，蓝色指示线显示插入点）

### 系统托盘 + 快捷键

- **Alt+Space** 全局快捷键：置顶显示时按 → 隐藏到托盘；沉底或已隐藏时按 → 唤回置顶（`toggleWindow()` 用 `isVisible() && isAlwaysOnTop()` 区分两种状态，不是简单的 show/hide）。优先注册，失败自动回退 `Ctrl+Alt+Space`；Ctrl+Alt 在 Windows 上等同 AltGr，易被输入法/键盘布局占用
- 关闭窗口 → 隐藏到系统托盘（不退出）
- 托盘左键单击 → `toggleWindow()`（同上逻辑）
- 托盘右键菜单 →「显示窗口」/「退出」
- 托盘图标：[`resources/tray-icon.png`](resources/tray-icon.png)（16×16）
- 应用图标：[`resources/icon.ico`](resources/icon.ico)

### 开机自启动

- **实现**：Electron 原生 `app.setLoginItemSettings` / `getLoginItemSettings`，写注册表 `HKCU\...\Run` 登录项，无第三方依赖
- **参数**：打包版注册 `QuickLaunch.exe --autostart`；开发模式 `process.execPath` 是 `electron.exe`，必须附带应用路径参数（`--autostart <appPath>`，第一个非开关参数被 Electron 当作 app 路径）——`autoStartArgs()` 按 `app.isPackaged` 区分，`get/set` 必须传相同的 `path`/`args` 才能正确匹配注册表项
- **`--autostart` 隐藏启动**：带该参数启动（开机自启）时窗口默认隐藏到托盘（`ready-to-show` 不 `show()`），不打扰登录后的桌面；Alt+Space / 托盘图标唤出
- **UI**：「+」菜单项「开机自启动」：右侧显示 **iOS 风格开关指示器**（`.item-switch`，开=绿色轨道+圆球在右，关=灰色轨道+圆球在左，轨道色 `--switch-off-bg` 随主题；`.dropdown-item` 为 flex `space-between` 布局，左侧文字与其余菜单项完全对齐），菜单打开时 `getAutoStart()` 实时读取，点击 `setAutoStart()` 乐观更新——**与其他菜单项不同，切换后不关闭菜单**（开关类控件交互，用户可立即看到状态翻转并连续切换）
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
| `run-app` | Renderer → Main | 启动程序/URL/`shell:` CLSID 命令，或通过 `shell.openPath()` 打开文件夹；URL 判定正则 `/^(https?\|ftp\|steam):\/\/\|^mailto:/i` |
| `load-shortcuts` | Renderer → Main | 从 `{userData}/shortcuts.json` 加载持久化数据 |
| `save-shortcuts` | Renderer → Main | 保存持久化数据到 `{userData}/shortcuts.json` |
| `get-desktop-icons-hidden` | Renderer → Main | 读取桌面图标当前是否隐藏（ListView 可见性，找不到 ListView 时回退读注册表 HideIcons） |
| `toggle-desktop-icons` | Renderer → Main | 切换桌面图标显隐，返回切换后状态 |
| `get-auto-start` | Renderer → Main | 读取开机自启动是否开启（`getLoginItemSettings`，传与 set 相同的 path/args 匹配注册表项） |
| `set-auto-start` | Renderer → Main | 开启/关闭开机自启动（`setLoginItemSettings` 写 `HKCU\...\Run`），返回切换后实际状态 |
| `dock-pointer` | Renderer → Main | 通知主进程鼠标进入 Dock 窗口恢复置顶（`inside=true`；离开不再沉底——沉底仅由点击其他软件 `blur` 触发）。用 `ipcRenderer.send` 单向，非 invoke；高频进出不阻塞 renderer |

### React UI

App 是**唯一的 React 组件**（[`src/renderer/src/App.tsx`](src/renderer/src/App.tsx)）：

- 单个 `useState<AppEntry[]>` 管理快捷方式列表
- 模块级 `nextId` 生成自增 ID，启动时从已保存最大 ID + 1 恢复
- **Dock 栏**：底部毛玻璃横栏，图标水平排列，gap 4px；内容超过宽度时横向滚动
- **+ 按钮**：Dock 末尾的添加按钮，点击展开下拉菜单（添加快捷方式/文件夹/**隐藏或显示桌面图标**/**开机自启动**/**切换到白天或黑夜模式**；「此电脑」「回收站」由启动扫描自动加入，无手动入口）。菜单**渲染在滚动容器之外**（fixed 定位）：`addBtnRef` 提供按钮坐标存入 `menuPos` state，菜单底边对齐按钮上方 8px。滚动容器的 `overflow` 会裁剪向上弹出的菜单，故不能放容器内。菜单加 `maxHeight: menuPos.top - 8` + `overflow-y: auto`——5 项菜单（外加 2 分隔线）超过窗口内可用高度时内部滚动，滚动条隐藏（与 `.dock-inner` 一致），滚轮/触控板滚动；水平位置钳制在窗口内（`Math.min(Math.max(cx, 100), innerWidth - 100)`），防止按钮靠窗口右缘时菜单伸出被裁掉圆角
- **菜单自动关闭**：下拉菜单和右键菜单鼠标移出即自动关闭（无需点击）——`mousemove` 用 `elementFromPoint` 判断鼠标是否仍在菜单（或「添加」按钮）DOM 内，不在则延迟 120ms 关闭，期间移回取消；鼠标移出窗口（`mouseleave`）立即关闭，点击外部（`mousedown`）也关闭
- **桌面图标开关**：菜单打开时 `getDesktopIconsHidden()` 读取状态决定文案（隐藏/显示），点击 `toggleDesktopIcons()` 乐观更新（先切文案，IPC 返回后校正）
- **开机自启动开关**：菜单打开时 `getAutoStart()` 读取注册表状态决定开关开/关（`.item-switch`），点击 `setAutoStart()` 乐观更新（先切开关，IPC 返回后校正，**不关闭菜单**）；写注册表 `HKCU\...\Run` 登录项
- **快捷方式/文件夹多选**：`parse-lnk` / `select-folder` 对话框均开 `multiSelections`，一次多选逐个生成条目（`handleAdd` / `handleAddFolder` 批量 append，文件夹图标统一取 shell32 黄色文件夹图标）
- **白天/黑夜主题**：`theme` state（`'dark' | 'light'`），根元素加 `theme-light` 类切换 CSS 变量（Dock 背景/标签/菜单/右键菜单全部跟随）；偏好持久化到 localStorage（key `ql-theme`）
- **左键点击**：启动程序/打开文件夹（拖拽启动后忽略点击）
- **右键菜单**：自定义右键菜单（删除选项），fixed 定位在光标右侧
- **拖拽排序**：mousedown 设置 dragRef → mousemove 超过 5px 阈值启动拖拽 → 计算 dropIdx 显示蓝色指示线 → mouseup 执行数组重排。`calcDropIndex` 用 `getBoundingClientRect` 视口坐标，Dock 滚动后仍正确。**防误启动**：真实拖拽结束时（mouseup 时 `dragStartedRef` 为 true）置 `suppressClickRef=true`，紧随其后的 click 在 `handleRun` 中被吞掉——click 在 mouseup 之后才派发，此时 `setDragId(null)` 已生效，仅凭 `dragId` 判断不可靠；每次新的 mousedown 先清除该标记，避免误吞正常点击
- **放大效果**：`handleDockMouseMove` 计算鼠标到每个图标的距离，< 140px 时缩放 + 上浮（拖拽时暂停）
- **持久化**：`apps` 变化时 `useEffect` 自动保存，启动时 `useEffect` 自动恢复

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

快捷方式保存至 `{userData}/shortcuts.json`，格式为 `AppEntry[]` 数组。字段：`id`、`iconDataUrl`、`targetPath`、`arguments`、`workingDirectory`、`description`，可选 `isFolder`（文件夹）与 `specialType`（`'this-pc'` / `'recycle-bin'`）。`parse-lnk` 解析出的 `windowStyle`/`hotkey`/`iconLocation` 在持久化时被丢弃（`AppEntry` 不含这些字段）。

主题偏好（白天/黑夜）存在渲染端 localStorage（key `ql-theme`），不走 IPC 文件持久化——纯 UI 偏好，无需主进程参与。

### 桌面自动扫描

- 启动时（renderer 加载完 `shortcuts.json` **之后**）自动调用 `scan-desktop-folders`：**单次 PowerShell 调用**完成枚举 + 图标提取（避免启动时拉起多个 powershell 进程）——枚举桌面文件夹 + 用 `WScript.Shell` 解析 `.lnk` 目标（目标为目录才纳入；`.url`/程序快捷方式跳过）
- **固定附加系统位置**：无论桌面枚举结果如何，都会追加「此电脑」「回收站」（`specialType: 'this-pc' | 'recycle-bin'`），注册表 CLSID 图标解析内嵌在脚本里（不再走 `resolveClsidIcon` 多进程调用）
- **图标兜底链**：文件夹统一黄色文件夹图标（shell32 index 4，与「添加文件夹」一致）→ 失败回退通用文档图标（index 1）；系统位置先用注册表解析的图标 → 失败回退黄色文件夹图标 → 通用文档图标
- 去重在 renderer：`normPath()`（去尾部 `\` + 小写）与 `saved`（加载结果）比较（系统位置的 `targetPath` 是 `shell:` 命令，同样参与比较）；新增条目按 `specialType` 有无分别标 `specialType` / `isFolder: true`，合并后由保存 effect 持久化
- **插入顺序**：updater 内纯合并——系统位置区块（既有 + 新增，按 此电脑→回收站 稳定排序）+ 新文件夹 + 其余（保持原顺序）。Dock 前部固定为此电脑/回收站/文件夹；若用户手动拖动过系统位置，下次合并会归位到区块前部
- **去重/排序/id 分配都在 updater 外完成**（StrictMode 双调用 updater 时无副作用；updater 内仍有防御性路径过滤，防止与启动早期手动添加竞态）
- 加载完成即解锁保存（`loadedRef`，不等扫描）；**顺序执行（load → scan 链式）避免竞态**——若并行，扫描结果可能被 `loadShortcuts` 的 `setApps` 覆盖丢失
- 注意：被用户删除的桌面文件夹/系统位置下次启动会重新加入（暂无忽略列表）；桌面路径沿用 `D:\Desktop`（重定向桌面，回退系统桌面）

## 平台限制

此应用**仅限 Windows**。依赖 PowerShell、`WScript.Shell` COM、`SHDefExtractIcon` Win32 API、`System.Drawing` GDI+。

## 注意事项

- **无测试框架**、**无 ESLint/Prettier**
- `AppEntry` 类型在 [`src/preload/index.ts`](src/preload/index.ts)、[`src/renderer/src/App.tsx`](src/renderer/src/App.tsx)、[`src/renderer/src/env.d.ts`](src/renderer/src/env.d.ts) 三处各自定义，修改时需保持同步
- `env.d.ts` 再次复刻 API 类型到 `Window` 接口——contextBridge 隔离导致 Renderer 端类型必须在此声明
- `App.tsx` 使用模块级变量 `nextId`（非 React state）；启动时从已保存最大 ID + 1 重建
- 窗口拖拽：`.dock` 设为 `drag` 区域，所有交互元素（`.dock-inner`、`.dock-item`、`.dropdown-menu`、`.context-menu` 等）显式设为 `no-drag`
- `.dock-inner` 是横向滚动容器（`overflow-x: auto`），CSS 规范强制其垂直方向也裁剪——**向上弹出的下拉菜单必须渲染在容器外**（fixed 定位），放容器内会被裁掉
- 滚动容器会裁剪垂直溢出的放大图标，`.dock-inner` 顶部 44px 透明 padding 即预留的放大显示区；`.dock-bg` 背景层只覆盖图标区，放大图标从该区顶出显示在透明区
- 开发模式下窗口加载 `ELECTRON_RENDERER_URL` 环境变量 URL；生产模式下加载 `../renderer/index.html` 文件
- `setWindowOpenHandler` 拦截所有 `target=_blank`/新窗口请求：一律 `shell.openExternal()` 用默认浏览器打开并 `deny`，应用内不产生新窗口
- `webPreferences.sandbox: false`：preload 依赖 `process.contextIsolated` 分支和 `@electron-toolkit/preload`，改成 `true` 会破坏 contextBridge
- 关闭 → 隐藏托盘通过 `forceQuit` 标志区分：普通关闭 `preventDefault()` + `hide()`；托盘「退出」置 `forceQuit=true` 后 `app.quit()`。新增退出路径需同步设置该标志
- 拖拽排序的 `mousemove`/`mouseup` 监听挂在 `window` 上（非 dock 元素），鼠标移出窗口仍能完成排序；`mouseup` 在窗口外也会触发
- `run-app` 用 `execFile(targetPath, args.split(' '))` 按空格拆分参数，不支持含空格的参数——已知限制
- `run-app` 直接 spawn 被拒（`EACCES`/`EPERM`，多为程序需要管理员权限或杀软拦截裸 `CreateProcess`）时**回退 `shell.openPath()`**——与资源管理器双击一致，自动弹 UAC 提权，代价是丢弃启动参数。该路径是已处理流程，只打单行 `console.log`，不打错误堆栈
- **保存守卫（防清盘）**：保存 effect 在 `loadedRef`（初始加载完成前）为 false 时直接跳过——挂载时 `apps=[]` 不再覆盖 `shortcuts.json`。否则在 **React.StrictMode 双挂载**下，`save([])` 会先清空文件，第二次 `load` 读到空文件返回 `[]`，已保存条目永久丢失（桌面自动扫描的文件夹会靠重新扫描"复活"，手动添加的程序快捷方式则彻底消失）。`main.tsx` 使用了 `<React.StrictMode>`，改动持久化流程时必须保留该守卫
- **版本号管理**：git 提交信息用版本号（如 `v1.6.0: ...`），但仓库**无 git tag**；`package.json` 的 `version` 字段需手动同步（当前已同步为 `1.6.0`，每次发布需手动更新）
- 项目有 [`CHANGELOG.md`](CHANGELOG.md) 按版本记录变更（当前记录到 v1.6.0），功能变更后需同步更新，并与提交信息版本对齐
- 窗口 `resizable: false`，尺寸固定（85% 屏宽 ≤ 1200px × 300px）
