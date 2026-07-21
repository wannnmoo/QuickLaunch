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

项目遵循 `electron-vite` 标准结构，严格区分三个进程：

| 进程 | 入口 | 职责 |
|---|---|---|
| **Main** | [`src/main/index.ts`](src/main/index.ts) | 应用生命周期、透明无边框窗口、系统托盘、全局快捷键、IPC 处理器、PowerShell 调用 |
| **Preload** | [`src/preload/index.ts`](src/preload/index.ts) | `contextBridge.exposeInMainWorld` 暴露 `window.api` 和 `window.electron`，定义 `LnkInfo` 和 `AppEntry` 类型 |
| **Renderer** | [`src/renderer/src/main.tsx`](src/renderer/src/main.tsx) | React 19 SPA，挂载 `<App />` 到 `#root` |

Renderer 通过 preload 脚本的 contextBridge 安全隔离，**不能**直接访问 Node.js 或 Electron API。

### 透明窗口 + Dock 布局

- `transparent: true` + `frame: false` 透明无边框窗口（300px 高，85% 屏幕宽，居中）
- `alwaysOnTop: true` + `skipTaskbar: true` — 常驻桌面，不在任务栏显示
- Dock 栏在窗口底部，毛玻璃背景（`backdrop-filter: blur`），圆角阴影
- Dock 空白区域可拖拽移动窗口（`-webkit-app-region: drag`）
- 图标排列在 Dock 内，鼠标悬停放大效果（JS 驱动，计算距离决定缩放比例）
- 图标支持拖拽排序（自定义鼠标事件，5px 阈值区分点击和拖拽）

### 系统托盘 + 快捷键

- **Alt+Space** 全局快捷键切换窗口显隐
- 关闭窗口 → 隐藏到系统托盘（不退出）
- 托盘左键单击 → 切换显隐
- 托盘右键菜单 →「显示窗口」/「退出」
- 托盘图标：[`resources/tray-icon.png`](resources/tray-icon.png)（16×16）
- 应用图标：[`resources/icon.ico`](resources/icon.ico)

### IPC 通道

所有 IPC 使用 `ipcMain.handle` / `ipcRenderer.invoke`（Promise 模式）：

| Channel | 方向 | 说明 |
|---|---|---|
| `parse-lnk` | Renderer → Main | 解析 .lnk/.url/.pif 快捷方式文件，返回 `LnkInfo` |
| `select-folder` | Renderer → Main | 选择文件夹，从 `shell32.dll` index 4 提取黄色文件夹图标 |
| `add-special-item` | Renderer → Main | 添加系统位置（此电脑/回收站），从注册表解析图标 |
| `run-app` | Renderer → Main | 启动程序/URL/shell:/CLSID 命令，或通过 `shell.openPath()` 打开文件夹 |
| `load-shortcuts` | Renderer → Main | 从 `{userData}/shortcuts.json` 加载持久化数据 |
| `save-shortcuts` | Renderer → Main | 保存持久化数据到 `{userData}/shortcuts.json` |

### React UI

App 是**唯一的 React 组件**（[`src/renderer/src/App.tsx`](src/renderer/src/App.tsx)）：

- 单个 `useState<AppEntry[]>` 管理快捷方式列表
- 模块级 `nextId` 生成自增 ID，启动时从已保存数据恢复
- **Dock 栏**：底部毛玻璃横栏，图标水平排列
- **+ 按钮**：Dock 末尾的添加按钮，点击展开下拉菜单（添加快捷方式/文件夹/此电脑/回收站）
- **左键点击**：启动程序/打开文件夹
- **右键菜单**：自定义右键菜单（删除选项），在光标右侧弹出
- **拖拽排序**：按住图标拖动到目标位置释放，蓝色指示线显示插入点
- **放大效果**：鼠标靠近图标时放大 + 上浮（拖拽时暂停）
- **持久化**：`apps` 变化时自动保存，启动时自动恢复

### 图标提取机制

- 共享 C# P/Invoke 类 `IconExtractor`（常量 `ICON_EXTRACTOR_CS`），通过 `SHDefExtractIcon` + `System.Drawing` 提取图标
- `extractIcon()` 封装：PowerShell 调用 → 提取 → Base64 → data URL
- `parse-lnk` 复用 `ICON_EXTRACTOR_CS` 常量
- `select-folder` 和 `add-special-item` 复用 `extractIcon()`
- 特殊项目（此电脑/回收站）通过注册表 `HKCR\CLSID\{CLSID}\DefaultIcon` 动态解析图标位置
- URL 快捷方式图标解析链：`.url` 的 `IconFile` → 浏览器 favicon → 默认浏览器 exe → shell32.dll 地球图标（index 13）
- PowerShell 超时 10 秒，每次调用启动新 `powershell.exe`

### 持久化格式

快捷方式保存至 `{userData}/shortcuts.json`，格式为 `AppEntry[]` 数组。`AppEntry` 通过 `isFolder` 区分文件夹，通过 `specialType` 区分系统项目（此电脑/回收站）。

## 平台限制

此应用**仅限 Windows**。依赖 PowerShell、`WScript.Shell` COM、`SHDefExtractIcon` Win32 API、`System.Drawing` GDI+。

## 注意事项

- **已初始化为 git 仓库**（`Initial commit: QuickLaunch v1.1.0`）
- **无测试框架**、**无 ESLint/Prettier**
- `AppEntry` 类型在 [`src/preload/index.ts`](src/preload/index.ts) 和 [`src/renderer/src/App.tsx`](src/renderer/src/App.tsx) 中各自定义，修改时需保持同步
- `env.d.ts` 再次复刻 API 类型到 `Window` 接口——contextBridge 隔离导致 Renderer 端类型必须在此声明
- `App.tsx` 使用模块级变量 `nextId`（非 React state）；启动时从已保存最大 ID + 1 重建
- `resolveResource()` 统一处理开发/生产环境的资源路径解析
- 窗口拖拽：`.dock` 设为 `drag` 区域，所有交互元素（`.dock-inner`、`.dock-item`、`.dropdown-menu` 等）显式设为 `no-drag`
