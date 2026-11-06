/**
 * 用户设置（{userData}/settings.json）。
 *
 * 为什么要有独立文件而不是塞进 shortcuts.json：
 * - shortcuts.json 每次拖动图标都整份重写（还带几十个 base64 图标），设置混进去会被
 *   高频写入，一旦某次写坏就一起丢；
 * - 设置是**低频、小体积、需要渲染端首帧就读到**的东西，独立文件 + 同步读取最省事。
 *
 * 设计约定：
 * - **读的时候逐字段校验 + clamp**，任何一个字段坏掉只回退那一项，不让整份设置失效。
 *   这样用户手改 JSON 写出 `"magnify": "big"` 也只会退成 1.4，而不是让 Dock 起不来。
 * - **写的时候 merge**：调用方只传想改的字段（partial patch），其余保持不变。
 * - `dockEdge` 的真相源仍然是 window-position.json（历史原因 + 它和窗口几何强相关）；
 *   这里只让 `get-settings` 的返回值带上当前真实档位，`set-settings` 收到 dockEdge
 *   就转交给主进程的 setDockEdge，**不再单独存一份**（避免两处不一致）。
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { app, ipcMain, webContents } from 'electron'
import { DEFAULT_SETTINGS, type AppSettings, type DockEdge } from '../shared/types'
import { logWarn } from './logger'
import { writeFileAtomic } from './persist'

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n))

const oneOf = <T extends string | number>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback

const asNumber = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

const asBool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)

let settingsPath = ''
let cache: AppSettings = { ...DEFAULT_SETTINGS }

/** 把任意来源的对象规整成合法设置（逐字段校验，坏的只回退那一项） */
export function normalizeSettings(raw: unknown): AppSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    theme: oneOf(o.theme, ['dark', 'light', 'transparent'] as const, DEFAULT_SETTINGS.theme),
    glassPlan: oneOf(o.glassPlan, ['dark', 'light'] as const, DEFAULT_SETTINGS.glassPlan),
    // dockEdge 只是「读出来给渲染端看」的字段，真实值由主进程注入
    dockEdge: DEFAULT_SETTINGS.dockEdge,
    iconSize: oneOf(asNumber(o.iconSize, DEFAULT_SETTINGS.iconSize), [48, 60, 72] as const, DEFAULT_SETTINGS.iconSize),
    magnify: clamp(asNumber(o.magnify, DEFAULT_SETTINGS.magnify), 1, 1.6),
    glassBlur: Math.round(clamp(asNumber(o.glassBlur, DEFAULT_SETTINGS.glassBlur), 8, 64)),
    glassSaturate: clamp(asNumber(o.glassSaturate, DEFAULT_SETTINGS.glassSaturate), 1, 2.4),
    folderCardDelay: Math.round(clamp(asNumber(o.folderCardDelay, DEFAULT_SETTINGS.folderCardDelay), 0, 1500)),
    panelCloseDelay: Math.round(clamp(asNumber(o.panelCloseDelay, DEFAULT_SETTINGS.panelCloseDelay), 0, 1500)),
    afterLaunch: oneOf(o.afterLaunch, ['hide', 'keep', 'sink'] as const, DEFAULT_SETTINGS.afterLaunch),
    probeBeforeLaunch: asBool(o.probeBeforeLaunch, DEFAULT_SETTINGS.probeBeforeLaunch),
    searchEnabled: asBool(o.searchEnabled, DEFAULT_SETTINGS.searchEnabled),
    followSystemTheme: asBool(o.followSystemTheme, DEFAULT_SETTINGS.followSystemTheme)
  }
}

/** 可在设置里改、且需要写盘的那些字段（dockEdge 除外：它走 window-position.json） */
type StoredSettings = Omit<AppSettings, 'dockEdge'>

function toStored(s: AppSettings): StoredSettings {
  const { dockEdge: _edge, ...rest } = s
  return rest
}

export function initSettings(): void {
  settingsPath = join(app.getPath('userData'), 'settings.json')
  if (!existsSync(settingsPath)) {
    cache = { ...DEFAULT_SETTINGS }
    return
  }
  try {
    cache = normalizeSettings(JSON.parse(readFileSync(settingsPath, 'utf-8')))
  } catch (err) {
    logWarn('settings', 'settings.json 读取/解析失败，使用默认设置', err)
    cache = { ...DEFAULT_SETTINGS }
  }
}

/** 当前设置（不含真实 dockEdge —— 由调用方补上） */
export const getSettingsCache = (): AppSettings => cache

function broadcast(settings: AppSettings): void {
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue
    try {
      wc.send('settings-changed', settings)
    } catch {
      /* 窗口正在销毁：忽略 */
    }
  }
}

/**
 * 注册设置相关 IPC。
 * `getDockEdge` / `applyDockEdge` 由主进程注入 —— settings 模块不碰窗口几何。
 */
export function registerSettingsIpc(hooks: {
  getDockEdge: () => DockEdge
  applyDockEdge: (edge: unknown) => boolean
}): void {
  const withEdge = (): AppSettings => ({ ...cache, dockEdge: hooks.getDockEdge() })

  // 同步读取：作为 renderer 的 useState 初始值，保证首帧主题/尺寸就是对的。
  // ⚠️ sendSync 的处理器必须**同步**设置 event.returnValue（异步赋值已经太晚）
  ipcMain.on('get-settings-sync', (event) => {
    event.returnValue = withEdge()
  })

  ipcMain.handle('get-settings', () => withEdge())

  ipcMain.handle('set-settings', (_e, patch: unknown): AppSettings => {
    const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>

    // dockEdge 单独走：它要动窗口，且真相源在 window-position.json
    if (typeof p.dockEdge === 'string') {
      if (!hooks.applyDockEdge(p.dockEdge)) logWarn('settings', `拒绝未实现的停靠位置: ${p.dockEdge}`)
    }

    const merged = normalizeSettings({ ...toStored(cache), ...p })
    cache = merged
    try {
      writeFileAtomic(settingsPath, JSON.stringify(toStored(merged), null, 2))
    } catch (err) {
      logWarn('settings', 'settings.json 写盘失败（本次会话仍生效）', err)
    }
    const next = withEdge()
    broadcast(next)
    return next
  })
}
