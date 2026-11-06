/**
 * 设置中心（独立窗口）。
 *
 * 布局：左栏分类（通用 / 外观 / 行为 / 数据 / 关于）+ 右侧表单 + 底部「重置本节」。
 *
 * 三个设计决定：
 *  1. **表单自己排版，不再挤成一行**。旧「+」菜单里每组设置是 `label + 三段胶囊` 横排，
 *     可用宽度只有约 130px，「标准」两个字贴边（用户截图反馈的就是这个）。
 *     这里每行是 `label(132px) + 控件(1fr)`，胶囊按钮给了 `min-width: 62px` + 14px 内边距 + nowrap。
 *  2. **设置真相源是主进程（settings.json）**，这个窗口只调 `setSettings(patch)` 并订阅
 *     `settings-changed`：所以从 Dock 菜单改、从这个窗口改、手改 JSON 后重启，三处永远一致。
 *  3. **首帧同步读**（`settingsInitial()` = sendSync），否则窗口会先按默认值画一帧再跳变。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../shared/types'

type Section = 'general' | 'appearance' | 'behavior' | 'data' | 'about'

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'general', label: '通用' },
  { id: 'appearance', label: '外观' },
  { id: 'behavior', label: '行为' },
  { id: 'data', label: '数据' },
  { id: 'about', label: '关于' }
]

/** 左栏图标：13px 线性图标，`stroke: currentColor` 跟随导航态变色（激活白、其余 62% 白）。
 *  加图标是为了「清晰直观」—— 纯文字五连排在 96px 窄栏里一眼扫不出区别，图标给了视觉锚点。 */
const NAV_ICONS: Record<Section, React.ReactNode> = {
  general: (
    <svg className="st-nav-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M2.5 5h11M2.5 11h11" />
      <circle cx="6" cy="5" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="10.5" cy="11" r="1.7" fill="currentColor" stroke="none" />
    </svg>
  ),
  appearance: (
    <svg className="st-nav-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
      <path d="M8 2.2c3.2 0 5.8 2.3 5.8 5.2 0 1.4-1.1 2.3-2.5 2.3H9.9c-.7 0-1.2.5-1.2 1.1 0 .3.1.5.3.7.2.3.3.5.3.8 0 .6-.5 1.1-1.3 1.1-3.2 0-5.8-2.6-5.8-5.7S4.8 2.2 8 2.2Z" />
      <circle cx="6" cy="6.1" r=".85" fill="currentColor" stroke="none" />
      <circle cx="9.5" cy="5.3" r=".85" fill="currentColor" stroke="none" />
      <circle cx="5.3" cy="9.2" r=".85" fill="currentColor" stroke="none" />
    </svg>
  ),
  behavior: (
    <svg className="st-nav-ico" viewBox="0 0 16 16" fill="currentColor" stroke="none">
      <path d="M8.7 1.8 3.9 9.1h3.2l-.6 5.1 5.6-7.6H8.2l.5-4.8Z" />
    </svg>
  ),
  data: (
    <svg className="st-nav-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <ellipse cx="8" cy="3.9" rx="4.6" ry="1.9" />
      <path d="M3.4 3.9v4c0 1 2.1 1.9 4.6 1.9s4.6-.9 4.6-1.9v-4" strokeLinecap="round" />
      <path d="M3.4 7.9v4c0 1 2.1 1.9 4.6 1.9s4.6-.9 4.6-1.9v-4" strokeLinecap="round" />
    </svg>
  ),
  about: (
    <svg className="st-nav-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 7.3v4" />
      <circle cx="8" cy="4.9" r=".85" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** 「重置本节」要回退的字段（dockEdge 走主进程的窗口几何，单独列） */
const SECTION_KEYS: Record<Section, (keyof AppSettings)[]> = {
  general: [],
  appearance: ['theme', 'glassPlan', 'iconSize', 'magnify', 'glassBlur', 'glassSaturate', 'followSystemTheme'],
  behavior: ['afterLaunch', 'folderCardDelay', 'panelCloseDelay'],
  data: [],
  about: []
}

// ── 小控件 ───────────────────────────────────────────────────────────────

function Row(props: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="st-row">
      <div className="st-row-label">
        <span>{props.label}</span>
        {props.hint && <span className="st-row-hint">{props.hint}</span>}
      </div>
      <div className="st-row-control">{props.children}</div>
    </div>
  )
}

function Seg<T extends string | number>(props: {
  value: T
  options: { v: T; label: string }[]
  onPick: (v: T) => void
  ariaLabel: string
}) {
  return (
    <div className="st-seg" role="group" aria-label={props.ariaLabel}>
      {props.options.map((o) => (
        <button
          key={String(o.v)}
          type="button"
          className={'st-seg-btn' + (o.v === props.value ? ' active' : '')}
          aria-pressed={o.v === props.value}
          onClick={() => props.onPick(o.v)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Switch(props: { on: boolean; onToggle: () => void; ariaLabel: string }) {
  return (
    <button
      type="button"
      className={'st-switch' + (props.on ? ' on' : '')}
      role="switch"
      aria-checked={props.on}
      aria-label={props.ariaLabel}
      onClick={props.onToggle}
    >
      <span className="st-switch-knob" />
    </button>
  )
}

function Slider(props: {
  value: number
  min: number
  max: number
  step: number
  suffix?: string
  onChange: (v: number) => void
  ariaLabel: string
}) {
  return (
    <div className="st-slider">
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        aria-label={props.ariaLabel}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      <span className="st-slider-val">
        {props.value}
        {props.suffix ?? ''}
      </span>
    </div>
  )
}

// ── 主组件 ───────────────────────────────────────────────────────────────

export default function SettingsApp() {
  const [section, setSection] = useState<Section>('general')
  const [settings, setSettings] = useState<AppSettings>(() => {
    try {
      const s = window.api?.settingsInitial?.()
      return s ? { ...DEFAULT_SETTINGS, ...s } : DEFAULT_SETTINGS
    } catch {
      return DEFAULT_SETTINGS
    }
  })
  const [autoStart, setAutoStart] = useState(false)
  const [desktopHidden, setDesktopHidden] = useState<boolean | null>(null)
  const [version, setVersion] = useState('')
  const [entries, setEntries] = useState<number | null>(null)
  const [status, setStatus] = useState('')
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const say = useCallback((text: string): void => {
    setStatus(text)
    if (statusTimer.current) clearTimeout(statusTimer.current)
    statusTimer.current = setTimeout(() => setStatus(''), 2600)
  }, [])

  /** 所有改动都走这里：乐观更新 + 主进程返回后校正（失败时退回主进程的值） */
  const patch = useCallback(
    (p: Partial<AppSettings>): void => {
      setSettings((prev) => ({ ...prev, ...p }))
      void window.api
        .setSettings(p)
        .then((next) => {
          if (next) setSettings({ ...DEFAULT_SETTINGS, ...next })
        })
        .catch(() => {
          say('保存失败，本次改动可能没写进磁盘')
          void window.api.getSettings().then((next) => setSettings({ ...DEFAULT_SETTINGS, ...next }))
        })
    },
    [say]
  )

  // 主进程写过盘（包括另一扇窗口改的）就跟上
  useEffect(
    () =>
      window.api.onSettingsChanged((next) => {
        if (next) setSettings({ ...DEFAULT_SETTINGS, ...next })
      }),
    []
  )

  useEffect(() => {
    void window.api.getAutoStart().then(setAutoStart)
    setDesktopHidden(window.api.desktopIconsHiddenInitial())
    void window.api.getAppVersion().then(setVersion)
    void window.api.loadShortcuts().then((r) => setEntries(r.entries.length))
  }, [])

  useEffect(() => () => {
    if (statusTimer.current) clearTimeout(statusTimer.current)
  }, [])

  // Esc 关窗：自绘标题栏没有系统快捷键，这扇窗的全部键盘退出路径就是这一条。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        window.api.closeSettings()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 设置窗自己的配色：跟「主题」选择走，三档都保留（透明档在窗口里是近黑实心卡，
  // 因为 Dock 的透明主题本身没有玻璃层，窗口不能没有底；详见 settings.css 那段注释）
  const systemDark = useSystemDark()
  const resolvedTheme: 'dark' | 'light' | 'transparent' = settings.followSystemTheme
    ? systemDark
      ? 'dark'
      : 'light'
    : settings.theme === 'light'
      ? 'light'
      : settings.theme === 'transparent'
        ? 'transparent'
        : 'dark'

  const themeMode: 'glass-dark' | 'glass-light' | 'transparent' =
    settings.theme === 'transparent' ? 'transparent' : settings.theme === 'light' ? 'glass-light' : 'glass-dark'

  const pickTheme = (mode: 'glass-dark' | 'glass-light' | 'transparent'): void => {
    if (mode === 'transparent') {
      patch({ theme: 'transparent', followSystemTheme: false })
      return
    }
    const plan = mode === 'glass-light' ? 'light' : 'dark'
    patch({ theme: plan, glassPlan: plan, followSystemTheme: false })
  }

  const resetSection = (): void => {
    if (section === 'general' || section === 'data') {
      say('这一节没有可重置的项')
      return
    }
    if (section === 'about') {
      say('关于页没有可重置的项')
      return
    }
    const p: Partial<AppSettings> = {}
    for (const k of SECTION_KEYS[section]) {
      // @ts-expect-error 逐字段赋值：键与值都来自同一张 DEFAULT_SETTINGS
      p[k] = DEFAULT_SETTINGS[k]
    }
    patch(p)
    say('已恢复本节的默认值')
  }

  /** 只有「外观 / 行为」两节有可回退字段，其余三节不显示按钮 */
  const canReset = SECTION_KEYS[section].length > 0

  return (
    <div className="st" data-theme={resolvedTheme}>
      <header className="st-titlebar">
        <div className="st-title">设置</div>
        <div className="st-titlebar-btns">
          {canReset && (
            <button
              type="button"
              className="st-tb-btn st-tb-text"
              title="把本节恢复成默认值"
              onClick={resetSection}
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M3 8a5 5 0 1 1 1.7 3.8" />
                <path d="M3 4.6V8h3.4" />
              </svg>
              <span>恢复默认</span>
            </button>
          )}
          <button
            type="button"
            className="st-tb-btn"
            aria-label="最小化"
            onClick={() => window.api.minimizeSettings()}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M2 6h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            className="st-tb-btn st-tb-close"
            aria-label="关闭"
            onClick={() => window.api.closeSettings()}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </header>

      <div className="st-body">
        <nav className="st-nav" aria-label="设置分类">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={'st-nav-item' + (section === s.id ? ' active' : '')}
              aria-current={section === s.id ? 'page' : undefined}
              onClick={() => setSection(s.id)}
            >
              {NAV_ICONS[s.id]}
              <span>{s.label}</span>
            </button>
          ))}
        </nav>

        <main className="st-pane">
          {section === 'general' && (
            <>
              <h2 className="st-h2">通用</h2>
              <p className="st-desc">开启/关闭系统级集成。这两项会直接改注册表与桌面，改完立刻生效。</p>
              <Row label="开机自启动" hint="登录后自动启动">
                <Switch
                  on={autoStart}
                  ariaLabel="开机自启动"
                  onToggle={() => {
                    const target = !autoStart
                    setAutoStart(target)
                    void window.api.setAutoStart(target).then((next) => {
                      if (typeof next === 'boolean' && next !== target) setAutoStart(next)
                      say(next ? '已开启开机自启动' : '已关闭开机自启动')
                    })
                  }}
                />
              </Row>
              <Row label="桌面图标" hint="隐藏桌面图标">
                <Switch
                  on={desktopHidden === true}
                  ariaLabel="隐藏桌面图标"
                  onToggle={() => {
                    void window.api.toggleDesktopIcons().then((next) => {
                      if (typeof next === 'boolean') {
                        setDesktopHidden(next)
                        say(next ? '桌面图标已隐藏' : '桌面图标已显示')
                      } else {
                        say('没能切换桌面图标（状态未知）')
                      }
                    })
                  }}
                />
              </Row>
              <Row label="唤出 Dock" hint="全局生效">
                <div className="st-keys">
                  <kbd className="st-kbd">Alt</kbd>
                  <span className="st-key-plus">+</span>
                  <kbd className="st-kbd">Space</kbd>
                </div>
              </Row>
              <Row label="键盘操作" hint="Dock 可见时">
                <div className="st-keys">
                  <kbd className="st-kbd">←</kbd>
                  <kbd className="st-kbd">→</kbd>
                  <span className="st-key-tip">选择</span>
                  <kbd className="st-kbd">Enter</kbd>
                  <span className="st-key-tip">启动</span>
                  <kbd className="st-kbd">Esc</kbd>
                  <span className="st-key-tip">退出</span>
                </div>
              </Row>
              <Row label="停靠位置" hint="原地生效">
                <Seg
                  ariaLabel="Dock 停靠位置"
                  value={settings.dockEdge}
                  options={[
                    { v: 'middle', label: '居中' },
                    { v: 'bottom', label: '贴底' },
                    { v: 'top', label: '贴顶' }
                  ]}
                  onPick={(v) => patch({ dockEdge: v })}
                />
              </Row>
            </>
          )}

          {section === 'appearance' && (
            <>
              <h2 className="st-h2">外观</h2>
              <p className="st-desc">Dock 的材质、尺寸与玻璃强度。改完回到桌面即可看到效果。</p>
              <Row label="玻璃材质" hint="与 Dock 同材质">
                <Seg
                  ariaLabel="Dock 材质"
                  value={themeMode}
                  options={[
                    { v: 'glass-dark', label: '黑夜' },
                    { v: 'glass-light', label: '白天' },
                    { v: 'transparent', label: '透明' }
                  ]}
                  onPick={pickTheme}
                />
              </Row>
              <Row label="跟随系统" hint="系统切深浅色时自动换">
                <Switch
                  on={settings.followSystemTheme}
                  ariaLabel="跟随系统主题"
                  onToggle={() => patch({ followSystemTheme: !settings.followSystemTheme })}
                />
              </Row>
              <Row label="图标大小">
                <Seg
                  ariaLabel="图标大小"
                  value={settings.iconSize}
                  options={[
                    { v: 48, label: '小' },
                    { v: 60, label: '中' },
                    { v: 72, label: '大' }
                  ]}
                  onPick={(v) => patch({ iconSize: v })}
                />
              </Row>
              <Row label="悬停放大" hint="最大倍数">
                <Seg
                  ariaLabel="悬停放大倍数"
                  value={settings.magnify}
                  options={[
                    { v: 1.25, label: '弱' },
                    { v: 1.4, label: '标准' },
                    { v: 1.55, label: '强' }
                  ]}
                  onPick={(v) => patch({ magnify: v })}
                />
              </Row>
              <Row label="玻璃强度" hint="模糊半径">
                {/* 只有滑块、没有三段预设：480px 宽的窗里「预设 + 滑块」叠两行会让外观页
                    多出 34px 滚动（实测 scroll 309 / 可视 276）。数值单位直接写在右侧，
                    比「淡/标准/浓」更适合逐像素调 —— 预设那一档的饱和度联动也一并去掉了 */}
                <Slider
                  ariaLabel="玻璃模糊半径"
                  value={settings.glassBlur}
                  min={8}
                  max={64}
                  step={1}
                  suffix=" px"
                  onChange={(v) => patch({ glassBlur: v })}
                />
              </Row>
            </>
          )}

          {section === 'behavior' && (
            <>
              <h2 className="st-h2">行为</h2>
              <p className="st-desc">点击图标后的去向，以及各种浮层的响应速度。</p>
              <Row label="点击图标后" hint="Dock 去向">
                <Seg
                  ariaLabel="点击图标后 Dock 的行为"
                  value={settings.afterLaunch}
                  options={[
                    { v: 'hide', label: '隐藏到托盘' },
                    { v: 'keep', label: '保持显示' },
                    { v: 'sink', label: '让位沉底' }
                  ]}
                  onPick={(v) => patch({ afterLaunch: v })}
                />
              </Row>
              <Row label="文件夹预览延迟" hint="悬停多久弹卡">
                <div className="st-stack">
                  <Seg
                    ariaLabel="文件夹预览延迟预设"
                    value={settings.folderCardDelay}
                    options={[
                      { v: 120, label: '快' },
                      { v: 300, label: '标准' },
                      { v: 600, label: '慢' }
                    ]}
                    onPick={(v) => patch({ folderCardDelay: v })}
                  />
                  <Slider
                    ariaLabel="文件夹预览延迟"
                    value={settings.folderCardDelay}
                    min={0}
                    max={1200}
                    step={20}
                    suffix=" ms"
                    onChange={(v) => patch({ folderCardDelay: v })}
                  />
                </div>
              </Row>
              <Row label="分组面板收起" hint="移开后多久收">
                <div className="st-stack">
                  <Slider
                    ariaLabel="分组面板收起延迟"
                    value={settings.panelCloseDelay}
                    min={60}
                    max={900}
                    step={20}
                    suffix=" ms"
                    onChange={(v) => patch({ panelCloseDelay: v })}
                  />
                </div>
              </Row>
            </>
          )}

          {section === 'data' && (
            <>
              <h2 className="st-h2">数据</h2>
              <p className="st-desc">
                所有内容都在本机：快捷方式列表、外置图标、日志。没有账号、没有云同步。
              </p>
              <Row label="快捷方式" hint="分组 / 分隔线">
                <span className="st-stat">{entries === null ? '读取中…' : `${entries} 个条目`}</span>
              </Row>
              <Row label="数据目录" hint="配置与日志">
                <div className="st-btn-row">
                  <button type="button" className="st-btn" onClick={() => void window.api.openDataDir()}>
                    打开数据目录
                  </button>
                  <button type="button" className="st-btn" onClick={() => void window.api.openLogDir()}>
                    打开日志目录
                  </button>
                </div>
              </Row>
              <Row label="诊断包" hint="日志 + 配置">
                <button
                  type="button"
                  className="st-btn"
                  onClick={() => {
                    say('正在导出诊断包…')
                    void window.api.exportDiagnostics().then((p) => {
                      say(p ? '诊断包已导出到桌面' : '导出失败，请查看日志')
                    })
                  }}
                >
                  导出诊断包
                </button>
              </Row>
            </>
          )}

          {section === 'about' && (
            <>
              <h2 className="st-h2">关于</h2>
              <p className="st-desc">快捷方式面板 —— 常驻桌面的毛玻璃 Dock。</p>
              <Row label="版本">
                <span className="st-stat">v{version || '—'}</span>
              </Row>
              <Row label="更新" hint="检查新版本">
                <button
                  type="button"
                  className="st-btn"
                  onClick={() => {
                    say('正在检查更新…')
                    void window.api.checkUpdate().then((r) => {
                      if (r.status === 'dev') say('开发模式下不检查更新')
                      else if (r.status === 'latest') say(`已是最新版本 v${r.current}`)
                      else if (r.status === 'available' && r.url) {
                        say(`发现新版本 v${r.latest}，正在打开下载页…`)
                        void window.api.openUpdatePage(r.url)
                      } else if (r.status === 'available') say(`发现新版本 v${r.latest}，但没有可用的下载地址`)
                      else say(`检查更新失败：${r.reason ?? '未知原因'}`)
                    })
                  }}
                >
                  检查更新
                </button>
              </Row>
              <Row label="技术栈" hint="零运行时依赖">
                <span className="st-stat">Electron · React 19 · TypeScript</span>
              </Row>
            </>
          )}
        </main>
      </div>

      {status && (
        <div className="st-toast" role="status">
          {status}
        </div>
      )}
    </div>
  )
}

/** 系统深浅色（跟随系统主题时用；Electron 的渲染进程会自动跟随 OS） */
function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = (): void => setDark(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return dark
}
