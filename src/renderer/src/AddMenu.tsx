/**
 * 「+」新增按钮的下拉菜单（D1 拆分自 App.tsx）。
 *
 * 渲染在滚动容器之外（fixed 定位），锚点由调用方算好：水平居中对齐「添加」按钮，
 * `overlayAnchor` 负责贴边方向（Dock 在下方时菜单挂在玻璃条外侧 8px）。
 *
 * ⚠️ 这个菜单只放「动作」，不放「配置」。
 * 整窗只有 300px 高、`resizable: false`、透明窗 resize 会白闪，所以菜单可用高度约 200px。
 * v1.16 曾把 7 组偏好设置（停靠位置 / 主题两层 / 图标大小 / 放大 / 玻璃 / 悬停延迟 /
 * 点击后行为）全塞进来，靠 `.dropdown-scroll` 硬滚 —— 结果是每组只能挤成
 * `label + 三段胶囊` 一行，「标准」两个字在 28px 胶囊里贴边（用户截图反馈）。
 * v1.17 起这些配置全部搬到**独立设置窗口**（src/main/settingsWindow.ts，
 * 760×560，左栏分类 + 右侧表单），菜单恢复成 4 个动作 + 1 个「设置…」入口。
 * v1.19 起「设置…」也撤了：Dock 上有了「设置」系统条目（点开是快捷设置卡，
 * 卡里再进完整窗口）。菜单从此只有**动作**，没有任何配置入口。
 * 再加菜单项前先问：它是不是「配置」？是就进设置卡/设置窗口。
 */
import { useLayoutEffect, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'

type Props = {
  menuPos: { cx: number; top: number } | null
  overlayAnchor: CSSProperties
  menuRef: RefObject<HTMLDivElement | null>
  appVersion: string
  desktopIconsHidden: boolean
  autoStart: boolean
  onAdd: () => void
  onAddFolder: () => void
  onToggleDesktopIcons: () => void
  onToggleAutoStart: () => void
  onOpenLogDir: () => void
  onExportDiagnostics: () => void
  onCheckUpdate: () => void
}

export default function AddMenu(p: Props): React.JSX.Element | null {
  const { menuPos } = p

  // ⚠️ **早退必须放在所有 hook 之后**：原来 `if (!menuPos) return null` 写在这两个 hook
  //    上面，于是「菜单关着」= 0 个 hook、「菜单打开」= 2 个 hook —— 这是条件 hooks，
  //    违反 Hook 规则。实测 React 19 在打包版里侥幸不崩（dev 构建每次首开会往 main.log
  //    抛一句 `Expected static flag was missing`），但它只依赖 React 实现细节活着：
  //    任何一个补丁版本收紧检查、或者以后在早退之前再加一个 hook，就会立刻变成
  //    「点「+」直接进崩溃屏」。这里把 hook 提前，渲染结果逐像素不变。

  // 水平位置：以「+」按钮中心居中，但必须按**实测菜单宽度**钳制。
  // ⚠️ 旧写法用的是固定 100px（`Math.min(Math.max(cx, 100), innerWidth - 100)`）：
  //    菜单加了几行后实测宽 ~200px，右边缘只剩 innerWidth-5，而 `--sf-shadow` 的
  //    blur 是 30px —— 阴影整个被窗口边界裁掉，右侧看上去「没有阴影」（用户 2026-11-28 截图）。
  //    现在按 半宽 + 阴影余量 钳制，四边都留出投影空间。
  const [left, setLeft] = useState(menuPos?.cx ?? 0)
  useLayoutEffect(() => {
    if (!menuPos) return
    const w = p.menuRef.current?.offsetWidth ?? 200
    const half = w / 2
    const pad = 26 // 阴影横向外扩（blur 30 / 2 = 15，再留 11px 余量，覆盖 125%/150% 缩放）
    const min = half + pad
    const max = window.innerWidth - half - pad
    const next = min > max ? window.innerWidth / 2 : Math.min(Math.max(menuPos.cx, min), max)
    setLeft(next)
  }, [menuPos, p.menuRef])

  if (!menuPos) return null

  return (
    <div
      ref={p.menuRef}
      className="dropdown-menu"
      style={{
        left,
        // 贴边锚点与右键菜单一致（Dock 毛玻璃条外侧 8px）——若锚在「+」按钮内侧，
        // 菜单边会正好贴在玻璃条边上，看起来完全没有间距
        ...p.overlayAnchor,
        transform: 'translateX(-50%)'
      }}
    >
      <div className="dropdown-scroll">
        <button className="dropdown-item" onClick={p.onAdd}>
          添加快捷方式
        </button>
        <button className="dropdown-item" onClick={p.onAddFolder}>
          添加文件夹
        </button>
        <div className="dropdown-divider" />
        <button className="dropdown-item" onClick={p.onToggleDesktopIcons}>
          {p.desktopIconsHidden ? '显示桌面图标' : '隐藏桌面图标'}
        </button>
        <button className="dropdown-item" onClick={p.onToggleAutoStart}>
          <span>开机自启动</span>
          {/* 开关指示器：纯展示，点击整个菜单项切换 */}
          <span className={`item-switch${p.autoStart ? ' on' : ''}`} />
        </button>
        <div className="dropdown-divider" />
        {/* 设置入口**不在菜单里**（v1.19 起）：Dock 上已有「设置」系统条目，
            点开就是快捷设置卡，卡里再进完整窗口。菜单只做动作，不再放设置。 */}
        {/* 更新（F1）：手动检查，结果走 drop-hint 提示 —— 菜单会先关掉 */}
        <button className="dropdown-item" onClick={p.onCheckUpdate}>
          检查更新
        </button>
        {/* 诊断（B2）：打包版没有终端，用户出问题时唯一能给我们的东西 */}
        <button className="dropdown-item" onClick={p.onOpenLogDir}>
          打开日志目录
        </button>
        <button className="dropdown-item" onClick={p.onExportDiagnostics}>
          导出诊断包
        </button>
        {/* 版本号是滚动内容的**最后一行**（用户要求「放到上拉菜单最后面，
            不要一直显示在下面」），不再是固定页脚 */}
        <div className="dropdown-divider" />
        <div className="dropdown-version">快捷方式面板 v{p.appVersion || '—'}</div>
      </div>
    </div>
  )
}
