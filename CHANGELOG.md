# 快捷方式面板 (Shortcut Dashboard)

基于 **React 19 + TypeScript 7 + Electron 43 + Vite 7** 构建的 Windows 桌面应用——透明毛玻璃 Dock 栏悬浮桌面，一键启动程序、文件夹和系统位置。

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
- **透明常驻窗口**：`transparent` + `frame: false` + `alwaysOnTop` + `skipTaskbar`，悬浮桌面、不在任务栏显示，Dock 空白区域可拖拽移动
- **点击/滚动自动沉底**：点击其他软件或鼠标离开 Dock 时自动让出置顶沉到最底，不遮挡正在使用的程序；鼠标移回 Dock 或 Alt+Space 唤回置顶
- **独立背景层**：毛玻璃背景（`blur(32px) saturate(1.6)`）是独立层 `.dock-bg`，只覆盖图标区，图标垂直居中、上下间距紧凑
- **悬停放大**：鼠标靠近图标平滑放大 + 上浮（最大 1.4×），放大图标从背景顶部透明区顶出，类似 macOS Dock
- **水平滚动**：图标超过宽度时滚动容器横向滚动，滚轮/触控板查看，两端渐隐提示「还有更多」
- **拖拽排序**：按住图标拖到目标位置，蓝色指示线实时显示插入点
- **右键删除**：自定义右键菜单（删除选项）

### 桌面图标显隐
- 「+」菜单内置**隐藏/显示桌面图标**开关
- 通过向桌面 `SHELLDLL_DefView` 发送 `WM_COMMAND 0x7402` 切换——与 Windows「右键桌面 → 查看 → 显示桌面图标」底层一致，不依赖 `SHChangeNotify`（后者在部分 Win11 上不刷新桌面）
- 切换后 Explorer 自动同步注册表 `HideIcons`，状态持久化；状态读取用 `IsWindowVisible(ListView)`，比读注册表更贴近真实视觉状态

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
| `parse-lnk` | Renderer → Main | 解析快捷方式文件，返回 `LnkInfo`，不传路径则弹出系统文件对话框 |
| `select-folder` | Renderer → Main | 选择文件夹，返回路径/名称/系统文件夹图标 (shell32.dll index 4) |
| `add-special-item` | Renderer → Main | 添加系统位置（此电脑/回收站），从注册表解析图标 |
| `run-app` | Renderer → Main | 启动目标程序（exe/URL/`shell:` 位置），或通过 `shell.openPath` 打开文件夹 |
| `load-shortcuts` | Renderer → Main | 从 `userData/shortcuts.json` 加载已保存的快捷方式 |
| `save-shortcuts` | Renderer → Main | 保存快捷方式数据到 `userData/shortcuts.json` |
| `get-desktop-icons-hidden` | Renderer → Main | 读取桌面图标当前是否隐藏（ListView 可见性，回退注册表） |
| `toggle-desktop-icons` | Renderer → Main | 切换桌面图标显隐，返回切换后状态 |
| `dock-pointer` | Renderer → Main | 通知主进程鼠标进入/离开 Dock 窗口（`ipcRenderer.send`，单向） |

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
