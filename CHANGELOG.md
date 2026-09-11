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
| `get-desktop-icons-hidden` | Renderer → Main | 读取桌面图标当前是否隐藏（ListView 可见性，回退注册表） |
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
