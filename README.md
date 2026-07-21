# QuickLaunch

Windows 桌面快捷启动面板 —— 毛玻璃 Dock 栏悬浮桌面，一键启动程序、文件夹和系统位置。

## 功能

- **快捷方式解析**：支持 `.lnk` / `.url` / `.pif`，高清图标提取（256×256）
- **文件夹收纳**：添加文件夹到 Dock，系统原生黄色文件夹图标
- **系统位置**：一键添加「此电脑」「回收站」，图标从注册表动态解析
- **拖拽排序**：按住图标拖动到任意位置，蓝色指示线实时显示插入点
- **Dock 放大效果**：鼠标靠近图标时平滑放大 + 上浮
- **持久化存储**：所有图标自动保存，重启不丢失
- **透明窗口**：毛玻璃 Dock 悬浮桌面，透明区域可拖拽移动
- **系统托盘**：关闭窗口最小化到托盘，`Alt+Space` 切换显隐

## 技术栈

| 技术 | 版本 |
|---|---|
| React | 19 |
| TypeScript | 7 |
| Electron | 43 |
| Vite | 7 |
| electron-vite | 5 |

## 开发

```bash
npm install
npm run dev        # 开发模式（HMR + 热重载）
npm run typecheck  # 类型检查
npm run build      # 生产构建
npm run package    # 打包为 Windows 安装包
```

## 项目结构

```
resources/           # 图标资源
  icon.ico           # 应用图标（多尺寸）
  tray-icon.png      # 托盘图标（16×16）
src/
  main/              # Electron 主进程（IPC、窗口、托盘、PowerShell）
  preload/           # contextBridge API + 类型定义
  renderer/          # React 前端（Dock UI、拖拽排序、放大效果）
```

## 平台

仅限 Windows —— 依赖 PowerShell / Win32 API / WScript.Shell COM。

## 许可证

MIT
