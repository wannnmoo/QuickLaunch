# QuickLaunch

Windows 桌面快捷启动面板 —— 将快捷方式文件和文件夹收纳到网格面板，一键启动。

## 功能

- **快捷方式解析**：支持 `.lnk` / `.url` / `.pif`，高清图标提取（256×256）
- **文件夹收纳**：添加文件夹到面板，系统原生黄色文件夹图标
- **持久化存储**：添加的图标自动保存，重启不丢失
- **系统托盘**：关闭窗口最小化到托盘，`Alt+Space` 切换显隐
- **无边框窗口**：简洁现代的自定义窗口，拖拽 header 移动
- **自适应网格**：根据窗口宽度自动调整列数
- **左键启动 / 右键删除**

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
  main/              # Electron 主进程
  preload/           # contextBridge API
  renderer/          # React 前端
```

## 平台

仅限 Windows —— 快捷键解析依赖 PowerShell / Win32 API。

## 许可证

MIT
