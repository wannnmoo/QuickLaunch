/**
 * 空状态 / 错误状态（E6）。
 *
 * 背景：Dock 里原来有三处各写一套的「空」—— 盘符卡片「未检测到驱动器」、
 * 文件夹卡片「空文件夹 / 文件夹不存在」、分组面板「空分组」。三处的图标尺寸、
 * 行距、字号都是各自抄的，主题切换时透明度也不一致（有的用 opacity，有的写死 rgba）。
 *
 * 现在统一成一个组件 + 一组 `.es-*` 样式，**只保留「图标 + 主文案 + 副文案」三段**：
 * 空状态的信息量就该这么点，多一个按钮反而让人以为要在这里操作。
 */
import type { ReactNode } from 'react'

type Props = {
  /** 线性图标（15×15，细描边），由调用方内联传入 —— 不引图标库 */
  icon?: ReactNode
  main: string
  sub?: string
  /** 额外类名：`drives-empty`（卡片内居中）/ `group-panel-empty`（面板内居中） */
  className?: string
}

export default function EmptyState({ icon, main, sub, className }: Props): React.JSX.Element {
  return (
    <div className={'es-block' + (className ? ` ${className}` : '')}>
      {icon}
      <span className="es-main">{main}</span>
      {sub && <span className="es-sub">{sub}</span>}
    </div>
  )
}
