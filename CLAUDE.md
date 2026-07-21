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

这是一个名为「快捷方式面板」的 Windows Electron 桌面应用——用户添加 `.lnk`/`.url`/`.pif` 快捷方式文件和文件夹，应用提取其图标并在网格中展示，点击即可启动对应程序或打开文件夹。

### Electron 三进程模型

项目遵循 `electron-vite` 标准结构，严格区分三个进程：

| 进程 | 入口 | 职责 |
|---|---|---|
| **Main** | [`src/main/index.ts`](src/main/index.ts) | 应用生命周期、无边框窗口、系统托盘、全局快捷键、IPC 处理器、PowerShell 调用 |
| **Preload** | [`src/preload/index.ts`](src/preload/index.ts) | `contextBridge.exposeInMainWorld` 暴露 `window.api` 和 `window.electron`，定义 `LnkInfo` 和 `AppEntry` 类型 |
| **Renderer** | [`src/renderer/src/main.tsx`](src/renderer/src/main.tsx) | React 19 SPA，挂载 `<App />` 到 `#root` |

Renderer 通过 preload 脚本的 contextBridge 安全隔离，**不能**直接访问 Node.js 或 Electron API。

### 自定义窗口 + 系统托盘

窗口使用 `frame: false` 无边框模式，header 区域通过 CSS `-webkit-app-region: drag` 可拖拽移动。

- **Alt+Space** 全局快捷键切换窗口显隐
- 关闭窗口 → 隐藏到系统托盘（不退出）
- 托盘左键单击 → 切换显隐
- 托盘右键菜单 →「显示窗口」/「退出」
- 托盘图标：[`resources/tray-icon.png`](resources/tray-icon.png)（16×16 透明背景 3×2 网格）
- 应用图标：[`resources/icon.ico`](resources/icon.ico)（7 尺寸 ICO，3×2 网格风格）

### IPC 通道

所有 IPC 使用 `ipcMain.handle` / `ipcRenderer.invoke`（Promise 模式）：

| Channel | 方向 | 说明 |
|---|---|---|
| `parse-lnk` | Renderer → Main | 解析快捷方式文件，返回 [`LnkInfo`](src/preload/index.ts#L4-L13) |
| `select-folder` | Renderer → Main | 选择文件夹，通过 PowerShell + Win32 从 `shell32.dll` index 4 提取黄色文件夹图标 |
| `run-app` | Renderer → Main | 启动程序（exe/URL）或通过 `shell.openPath()` 打开文件夹 |
| `load-shortcuts` | Renderer → Main | 从 `{userData}/shortcuts.json` 加载持久化数据 |
| `save-shortcuts` | Renderer → Main | 保存持久化数据到 `{userData}/shortcuts.json` |

`LnkInfo` 和 `AppEntry` 接口均定义在 [`src/preload/index.ts`](src/preload/index.ts) 中。Renderer 中的 [`env.d.ts`](src/renderer/src/env.d.ts) 通过全局 `Window` 接口增强复刻了 API 类型。

### React UI

App 是**唯一的 React 组件**（[`src/renderer/src/App.tsx`](src/renderer/src/App.tsx)，约 120 行），包含全部 UI 逻辑：

- 使用单个 `useState<AppEntry[]>` 管理状态
- **持久化**：启动时调用 `loadShortcuts()` 恢复，`apps` 变化时自动 `saveShortcuts()`
- `AppEntry` 通过可选的 `isFolder` 字段区分快捷方式和文件夹
- 双按钮 header：「+ 添加快捷方式」（蓝色）和「+ 添加文件夹」（橙色）
- 暗色主题 CSS Grid 布局（[`App.css`](src/renderer/src/App.css)），列数自适应
- 左键点击 = 启动/打开，右键点击 = 移除

### TypeScript 配置

根目录 [`tsconfig.json`](tsconfig.json) 仅包含项目引用，自身无 compilerOptions：

- **[`tsconfig.node.json`](tsconfig.node.json)** — Main + Preload 进程：`composite: true`、`module: "ESNext"`、`moduleResolution: "bundler"`、无 DOM 类型
- **[`tsconfig.web.json`](tsconfig.web.json)** — Renderer 进程：相同配置 + `jsx: "react-jsx"` + DOM 类型

### 构建工具链

[`electron-vite.config.ts`](electron-vite.config.ts) 定义了三个独立的 Vite 构建：

- `main` 和 `preload` 使用 `externalizeDepsPlugin()`（依赖外部引用）
- `renderer` 使用 `@vitejs/plugin-react` + `@` 路径别名 → `src/renderer/src`

`npm run package` 额外运行 `electron-builder`（配置在 [`electron-builder.yml`](electron-builder.yml)），通过 `extraResources` 将 `icon.ico` 和 `tray-icon.png` 一起打包。

## 平台限制

此应用**仅限 Windows**。快捷方式解析依赖于：

- 通过 `powershell.exe` 调用的 PowerShell
- `WScript.Shell` COM 对象（Windows Script Host）
- `SHDefExtractIcon` Win32 API 和 `System.Drawing`（C# GDI+）
- 文件夹图标从 `C:\Windows\System32\shell32.dll` 提取

这些 API 在 macOS 或 Linux 上均不可用。

## 注意事项

- 项目**不是** git 仓库——没有 `.git` 目录，没有提交历史
- **无测试框架**——尚未配置 vitest 或任何其他测试运行器
- **无代码检查/格式化工具**——未安装 ESLint 或 Prettier
- `CHANGELOG.md` 同时作为 README——包含技术栈详情、API 文档和功能说明
- `AppEntry` 类型在 `preload/index.ts` 和 `App.tsx` 中各自定义，修改时需保持同步
