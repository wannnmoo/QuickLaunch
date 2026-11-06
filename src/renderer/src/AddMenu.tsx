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
 * 再加菜单项前先问：它是不是「配置」？是就进设置窗口。
 */
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
  onOpenSettings: () => void
  onOpenLogDir: () => void
  onExportDiagnostics: () => void
  onCheckUpdate: () => void
}

export default function AddMenu(p: Props): React.JSX.Element | null {
  const { menuPos } = p
  if (!menuPos) return null

  return (
    <div
      ref={p.menuRef}
      className="dropdown-menu"
      style={{
        // 水平钳制在窗口内：菜单以按钮中心为锚点居中，若按钮靠近窗口右缘，
        // 菜单会伸出窗口被裁掉右角（圆角变直角）。钳到距边缘 100px 内保证完整
        left: Math.min(Math.max(menuPos.cx, 100), window.innerWidth - 100),
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
        {/* 设置中心：所有配置（材质 / 尺寸 / 玻璃 / 延迟 / 行为 / 停靠位置）都在那扇窗里。
            菜单只留一个入口 —— 见文件头注释。 */}
        <button className="dropdown-item" onClick={p.onOpenSettings}>
          <span>设置…</span>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className="item-chevron">
            <path d="M4.5 2.5L8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
          </svg>
        </button>
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
