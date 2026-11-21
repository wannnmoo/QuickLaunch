/**
 * 快捷设置卡片（Dock 上的「设置」条目）。
 *
 * 为什么不是把整扇设置窗搬过来：Dock 窗口只有 300px 高、浮层可用高度 ≈202px，
 * 而完整设置是 5 个分类 × 20 来行。所以这里只放**改完立刻能看到效果**的 6 项，
 * 其余一律走页脚的「完整设置…」（打开原来那扇 480×308 的独立窗口）。
 *
 * 几何与音频卡同构（460 宽、行高 `--sf-row`、页脚 26），两卡并排时不会像两个物种：
 *   6 行 × 28 = 168 + 页脚 26 = 194 ≤ 202 ✔
 * 改行数/行高时记得重算这条账（否则最后一行会被 `overflow: hidden` 切掉半行，
 * 音频卡第一版就踩过）。
 */
import { useEffect } from 'react'
import type { AppSettings } from '../../shared/types'

type Props = {
  settings: AppSettings
  autoStart: boolean
  style: React.CSSProperties
  hidden: boolean
  cardRef: React.RefObject<HTMLDivElement | null>
  onPatch: (patch: Partial<AppSettings>) => void
  onToggleAutoStart: () => void
  onOpenWindow: () => void
  onEnter: () => void
  onLeave: () => void
  onClose: () => void
}

/** 与设置窗 `.st-seg` 同一套「淡底 + 亮字」的选中态（卡里再铺实心蓝就比窗口还重） */
function Seg<T extends string | number>(p: {
  value: T
  options: { v: T; label: string }[]
  onPick: (v: T) => void
  ariaLabel: string
}): React.JSX.Element {
  return (
    <div className="qc-seg" role="group" aria-label={p.ariaLabel}>
      {p.options.map((o) => (
        <button
          key={String(o.v)}
          type="button"
          className={'qc-seg-btn' + (o.v === p.value ? ' active' : '')}
          aria-pressed={o.v === p.value}
          onClick={() => p.onPick(o.v)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Switch(p: { on: boolean; onToggle: () => void; ariaLabel: string }): React.JSX.Element {
  return (
    <button
      type="button"
      className={'qc-switch' + (p.on ? ' on' : '')}
      role="switch"
      aria-checked={p.on}
      aria-label={p.ariaLabel}
      onClick={p.onToggle}
    >
      <span className="qc-switch-knob" />
    </button>
  )
}

function Row(p: { label: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="qc-row">
      <span className="qc-label">
        {p.label}
        {p.hint && <span className="qc-hint">{p.hint}</span>}
      </span>
      <span className="qc-control">{p.children}</span>
    </div>
  )
}

export default function SettingsCard(p: Props): React.JSX.Element {
  const { settings } = p

  // 打开即拿焦点：Esc 关卡片（否则会走 document 级导航，行为对不上）
  useEffect(() => {
    if (p.hidden) return
    p.cardRef.current?.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.hidden])

  const themeMode: 'glass-dark' | 'glass-light' | 'transparent' =
    settings.theme === 'transparent' ? 'transparent' : settings.theme === 'light' ? 'glass-light' : 'glass-dark'

  return (
    <div
      ref={p.cardRef}
      className="drives-card quick-card"
      style={{ ...p.style, visibility: p.hidden ? 'hidden' : 'visible' }}
      role="dialog"
      aria-label="快捷设置"
      tabIndex={-1}
      onMouseEnter={p.onEnter}
      onMouseLeave={p.onLeave}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          p.onClose()
        }
      }}
    >
      <div className="qc-list">
        <Row label="材质">
          <Seg
            ariaLabel="玻璃材质"
            value={themeMode}
            options={[
              { v: 'glass-dark', label: '黑夜' },
              { v: 'glass-light', label: '白天' },
              { v: 'transparent', label: '透明' }
            ]}
            onPick={(v) => {
              if (v === 'transparent') p.onPatch({ theme: 'transparent', followSystemTheme: false })
              else {
                const plan = v === 'glass-light' ? 'light' : 'dark'
                p.onPatch({ theme: plan, glassPlan: plan, followSystemTheme: false })
              }
            }}
          />
        </Row>
        <Row label="图标">
          <Seg
            ariaLabel="图标大小"
            value={settings.iconSize}
            options={[
              { v: 48 as const, label: '小' },
              { v: 60 as const, label: '中' },
              { v: 72 as const, label: '大' }
            ]}
            onPick={(v) => p.onPatch({ iconSize: v })}
          />
        </Row>
        <Row label="放大">
          <Seg
            ariaLabel="悬停放大倍数"
            value={settings.magnify}
            options={[
              { v: 1.25, label: '弱' },
              { v: 1.4, label: '标准' },
              { v: 1.55, label: '强' }
            ]}
            onPick={(v) => p.onPatch({ magnify: v })}
          />
        </Row>
        <Row label="位置">
          <Seg
            ariaLabel="停靠位置"
            value={settings.dockEdge}
            options={[
              { v: 'middle' as const, label: '居中' },
              { v: 'bottom' as const, label: '贴底' },
              { v: 'top' as const, label: '贴顶' }
            ]}
            onPick={(v) => p.onPatch({ dockEdge: v })}
          />
        </Row>
        <Row label="跟随系统" hint="深浅色">
          <Switch
            ariaLabel="跟随系统主题"
            on={settings.followSystemTheme}
            onToggle={() => p.onPatch({ followSystemTheme: !settings.followSystemTheme })}
          />
        </Row>
        <Row label="开机自启">
          <Switch ariaLabel="开机自启动" on={p.autoStart} onToggle={p.onToggleAutoStart} />
        </Row>
      </div>
      <div className="audio-foot">
        <button type="button" className="audio-btn audio-btn-primary" onClick={p.onOpenWindow}>
          完整设置…
        </button>
        <span className="audio-tip">Esc 关闭</span>
      </div>
    </div>
  )
}
