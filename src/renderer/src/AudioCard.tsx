/**
 * 音频切换卡片（输出 / 输入 双栏）。
 *
 * 为什么是「卡片」而不是设置页里的一段：切换设备是高频动作，Dock 的心智是
 * 「点一下就有反应」。设置中心 480×308 放不下两列设备 + 状态，而且要多点两下才能到。
 *
 * 几何（与 `.drives-card` 同一套浮层规则，只是更宽）：
 *  - 宽 460（两列各 ~220），纵向吃 `anchorStyle.maxHeight`（≈211px）；
 *  - 标题 16 + 列内滚动（最多 5 行可见）+ 页脚 26；
 *  - `position: fixed` 由外层 `cardOverlayAnchor` 定位，**必须进 `overlayOpen`**，
 *    否则 `setShape` 会把卡片裁成「画得出、点不动」（v1.15.2 的 `.drop-hint` 事故）。
 *
 * 键盘：卡片自己管（容器 tabIndex=-1，打开即 focus）。
 * `↑↓` 在输出+输入的扁平列表里移动，`Enter` 切换，`Esc` 关闭。
 * 用 `stopPropagation` 挡住 document 级的 `useDockKeyboard`，避免两套导航抢键。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AudioDevice, AudioSnapshot } from '../../shared/types'

type Props = {
  snapshot: AudioSnapshot | null
  loading: boolean
  /** 正在切换的设备 id（string）——期间该行显示「切换中」并禁止再点 */
  pendingId: string | null
  style: React.CSSProperties
  hidden: boolean
  cardRef: React.RefObject<HTMLDivElement | null>
  onPick: (device: AudioDevice) => void
  onRefresh: () => void
  onOpenSystem: () => void
  onEnter: () => void
  onLeave: () => void
  onClose: () => void
}

/** Win11 的 PKEY_Device_FriendlyName 通常已带 ` (适配器名)` 后缀；卡片里适配器单独一行，
 *  所以把重复的后缀剥掉（只剥与 adapter 完全一致的那个括号，别误伤 "扬声器 (USB)" 这种名字）。 */
export function audioDisplayName(device: { name: string; adapter: string }): string {
  const { name, adapter } = device
  if (!adapter) return name
  const suffix = ` (${adapter})`
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name
}

/** EndpointFormFactor → 线性图标。3 耳机 / 1 扬声器 / 9 HDMI / 4 麦克风，其余走扬声器 */
export function AudioGlyph(props: { formFactor: number; flow: 'render' | 'capture'; size?: number }): React.JSX.Element {
  const s = props.size ?? 14
  const common = {
    width: s,
    height: s,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  }
  if (props.flow === 'capture' || props.formFactor === 4) {
    return (
      <svg {...common}>
        <rect x="5.6" y="1.8" width="4.8" height="8" rx="2.2" />
        <path d="M3.4 7.4a4.6 4.6 0 0 0 9.2 0M8 12v2.2" />
      </svg>
    )
  }
  if (props.formFactor === 3 || props.formFactor === 5) {
    return (
      <svg {...common}>
        <path d="M3 10.4V8a5 5 0 0 1 10 0v2.4" />
        <rect x="2.2" y="9.6" width="2.6" height="4.2" rx="1.3" />
        <rect x="11.2" y="9.6" width="2.6" height="4.2" rx="1.3" />
      </svg>
    )
  }
  if (props.formFactor === 9) {
    return (
      <svg {...common}>
        <rect x="1.8" y="2.6" width="12.4" height="8.4" rx="1.4" />
        <path d="M5.4 13.4h5.2" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <path d="M2.4 6h2.2L8 3v10L4.6 10H2.4z" />
      <path d="M10.6 6.2a2.8 2.8 0 0 1 0 3.6" />
      <path d="M12.4 4.6a5.2 5.2 0 0 1 0 6.8" />
    </svg>
  )
}

function Row(props: {
  device: AudioDevice
  active: boolean
  cursor: boolean
  pending: boolean
  onClick: () => void
}): React.JSX.Element {
  const { device, active, cursor, pending } = props
  return (
    <div
      className={
        'audio-row' + (active ? ' current' : '') + (cursor ? ' cursor' : '') + (pending ? ' pending' : '')
      }
      role="button"
      tabIndex={-1}
      aria-current={active ? 'true' : undefined}
      aria-label={`${audioDisplayName(device)}${device.adapter ? ` · ${device.adapter}` : ''}`}
      onClick={props.onClick}
    >
      <span className="audio-glyph">
        <AudioGlyph formFactor={device.formFactor} flow={device.flow} />
      </span>
      <span className="audio-text">
        <span className="audio-name">{audioDisplayName(device)}</span>
        {device.adapter && <span className="audio-adapter">{device.adapter}</span>}
      </span>
      {pending ? (
        <span className="audio-spinner" aria-label="切换中" />
      ) : (
        active && (
          <svg className="audio-check" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M2.4 6.4 4.8 8.8 9.6 3.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )
      )}
    </div>
  )
}

export default function AudioCard(p: Props): React.JSX.Element {
  const [cursor, setCursor] = useState(0)
  // 光标框只在卡片真的拿到焦点时显示：否则一打开就有一圈框压在第一行上，
  // 和「当前默认设备」的强调色抢同一种视觉语言（第一次实拍就是这个观感）
  const [focused, setFocused] = useState(false)
  /** 用户用方向键动过光标之后，就别再自动跳回默认设备了 */
  const cursorTouched = useRef(false)
  const listRef = useRef<HTMLDivElement>(null)

  // 扁平列表：输出在前、输入在后（键盘 ↑↓ 跨两列走）
  const flat = useMemo(
    () => [...(p.snapshot?.render ?? []), ...(p.snapshot?.capture ?? [])],
    [p.snapshot]
  )

  // 打开即拿焦点：卡片自己处理方向键，不要让 document 级导航抢走
  useEffect(() => {
    if (p.hidden) return
    const el = p.cardRef.current
    if (!el) return
    el.focus({ preventScroll: true })
    cursorTouched.current = false
    // 只在「关→开」时跑一次：依赖 hidden，不依赖 flat（否则每次刷新列表都会抢焦点）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.hidden])

  // 数据到达后再把光标放到当前默认设备上（首帧 snapshot 还是 null，那时拿不到 isDefault）
  useEffect(() => {
    if (cursorTouched.current) return
    const idx = flat.findIndex((d) => d.isDefault)
    if (idx >= 0) setCursor(idx)
  }, [flat])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // 卡片是浮层里唯一可交互的东西：所有键都在这里消费，避免 document 级导航双开
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      p.onClose()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      if (flat.length === 0) return
      cursorTouched.current = true
      const step = e.key === 'ArrowDown' ? 1 : -1
      const next = (cursor + step + flat.length) % flat.length
      setCursor(next)
      // 让被选中的行滚进可视区（列表可能有 8 项以上）
      const row = listRef.current?.querySelectorAll<HTMLElement>('.audio-row')[next]
      row?.scrollIntoView({ block: 'nearest' })
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      const d = flat[cursor]
      if (d && !p.pendingId) p.onPick(d)
    }
  }

  const renderCol = (title: string, list: AudioDevice[]): React.JSX.Element => (
    <div className="audio-col">
      <div className="audio-col-title">
        {title}
        <span className="audio-count">{list.length}</span>
      </div>
      <div className="audio-list">
        {list.length === 0 && !p.loading && <div className="audio-empty">没有可用设备</div>}
        {list.map((d) => {
          const idx = flat.indexOf(d)
          return (
            <Row
              key={d.id}
              device={d}
              active={d.isDefault}
              cursor={focused && idx === cursor}
              pending={p.pendingId === d.id}
              onClick={() => { if (!p.pendingId) p.onPick(d) }}
            />
          )
        })}
        {p.loading && list.length === 0 && (
          <>
            <div className="audio-skeleton" />
            <div className="audio-skeleton" />
            <div className="audio-skeleton" />
          </>
        )}
      </div>
    </div>
  )

  return (
    <div
      ref={p.cardRef}
      className="drives-card audio-card"
      style={{ ...p.style, visibility: p.hidden ? 'hidden' : 'visible' }}
      role="dialog"
      aria-label="音频设备"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onMouseEnter={p.onEnter}
      onMouseLeave={p.onLeave}
    >
      <div ref={listRef} className="audio-cols">
        {renderCol('输出', p.snapshot?.render ?? [])}
        {renderCol('输入', p.snapshot?.capture ?? [])}
      </div>
      <div className="audio-foot">
        <button type="button" className="audio-btn" onClick={p.onRefresh} disabled={p.loading}>
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <path d="M13 8a5 5 0 1 1-1.6-3.7" />
            <path d="M13 3.6V8H8.6" />
          </svg>
          {p.loading ? '刷新中' : '刷新'}
        </button>
        <span className="audio-tip">↑↓ 选择 · Enter 切换</span>
        <button type="button" className="audio-btn audio-btn-primary" onClick={p.onOpenSystem}>
          声音设置
        </button>
      </div>
    </div>
  )
}
