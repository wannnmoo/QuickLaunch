/**
 * 更新检查（F1）—— 零依赖版本。
 *
 * 为什么不用 electron-updater：
 *   ① 它是**运行时依赖**，而本项目打包时整目录排除 node_modules（见 electron-builder.yml），
 *      引它就得改打包策略、把 7 MB+ 的依赖塞进 asar；
 *   ② 它默认走「静默下载 + 退出时安装」，而本应用的安装包是 NSIS 向导式（用户要选路径），
 *      自动安装会绕过那个向导；
 *   ③ 它要求代码签名与 update feed 托管，缺一环就静默失败，排查成本比自建高。
 *
 * 这里只做「检查 + 提示 + 跳转下载页」：
 *   读 electron-builder 发布时自动生成的 `latest.yml`（只需一个静态文件），
 *   比对版本号，有新版就提示并打开下载页。用户自己决定什么时候升级。
 *
 * feed 指向本仓库的 GitHub Release：`releases/latest/download/latest.yml` 永远解析到
 * 最新一版的清单（electron-builder 打包时会把 latest.yml 一并产出，发 Release 时一起上传即可）。
 */

import { net, shell, app } from 'electron'
import { logInfo, logWarn } from './logger'

/** latest.yml 的地址。electron-builder 发布 NSIS 包时会同名生成，内容形如：
 *  version: 1.16.0
 *  files:
 *    - url: QuickLaunch-Setup-1.16.0.exe
 *      sha512: ...
 *      size: 81234567
 *  path: QuickLaunch-Setup-1.16.0.exe
 *  releaseDate: '2026-11-07T00:00:00.000Z'
 */
const UPDATE_FEED_URL = 'https://github.com/wannnmoo/QuickLaunch/releases/latest/download/latest.yml'

export type UpdateStatus = 'dev' | 'latest' | 'available' | 'error'

export interface UpdateCheckResult {
  status: UpdateStatus
  /** 当前运行版本 */
  current: string
  /** feed 里的最新版本（status=available/latest 时有值） */
  latest?: string
  /** 直接下载/发布页地址（status=available 时有值） */
  url?: string
  /** status=error 时的人类可读原因 */
  reason?: string
}

/** 语义化版本比较：只看数字段，缺位补 0。返回 >0 表示 a 更新。 */
export function compareVersions(a: string, b: string): number {
  const norm = (v: string): number[] =>
    v
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .map((p) => parseInt(p, 10))
      .map((n) => (Number.isFinite(n) ? n : 0))
  const av = norm(a)
  const bv = norm(b)
  const len = Math.max(av.length, bv.length)
  for (let i = 0; i < len; i++) {
    const d = (av[i] ?? 0) - (bv[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** 从 latest.yml 里抠出 version 与首个 files[].url。 */
export function parseLatestYml(text: string): { version: string; file?: string } | null {
  const version = /^version:\s*['"]?([^'"\s]+)/m.exec(text)?.[1]
  if (!version) return null
  const file = /^\s*-\s*url:\s*['"]?([^'"\s]+)/m.exec(text)?.[1] ?? /^path:\s*['"]?([^'"\s]+)/m.exec(text)?.[1]
  return { version, file }
}

/** 把相对文件名拼成绝对下载地址（feed 与安装包通常同目录）。 */
function resolveDownloadUrl(file: string | undefined): string | undefined {
  if (!file) return undefined
  if (/^https?:\/\//i.test(file)) return file
  return UPDATE_FEED_URL.replace(/\/[^/]*$/, `/${file}`)
}

/** 单次检查。永远 resolve，不 throw —— 调用方（启动静默检查）不该被网络问题打断。 */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const current = app.getVersion()

  // 开发模式不检查：版本号永远是 package.json 的，与发布 feed 无可比性，
  // 而且频繁 HMR 重载会把「有新版本」的提示刷成噪音。
  if (!app.isPackaged) return { status: 'dev', current }

  try {
    const res = await net.fetch(UPDATE_FEED_URL, {
      signal: AbortSignal.timeout(8000),
      headers: { 'cache-control': 'no-cache' }
    })
    if (!res.ok) {
      return { status: 'error', current, reason: `HTTP ${res.status}` }
    }
    const parsed = parseLatestYml(await res.text())
    if (!parsed) return { status: 'error', current, reason: 'latest.yml 格式不对（缺 version）' }

    if (compareVersions(parsed.version, current) <= 0) {
      return { status: 'latest', current, latest: parsed.version }
    }

    const url = resolveDownloadUrl(parsed.file)
    logInfo('update', `发现新版本 ${parsed.version}（当前 ${current}）${url ? ` → ${url}` : ''}`)
    return { status: 'available', current, latest: parsed.version, url }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    logWarn('update', `检查更新失败：${reason}`)
    return { status: 'error', current, reason }
  }
}

/**
 * 启动后延迟静默检查一次（用户没主动点菜单）。
 * @param notify 托盘气泡回调 —— 由 index.ts 注入，避免这里 import 主窗口模块形成环
 */
export function scheduleSilentUpdateCheck(notify: (title: string, content: string) => void): void {
  if (!app.isPackaged) return
  const t = setTimeout(() => {
    void checkForUpdates().then((r) => {
      if (r.status === 'available') {
        notify('QuickLaunch 有新版本', `${r.current} → ${r.latest}，在「+」菜单里点「检查更新」查看`)
      }
    })
  }, 20_000)
  // 不 unref：这个定时器很短，且 quit 时进程直接结束，没必要留悬挂句柄逻辑
  void t
}

/** 打开更新下载页（没有 url 就什么都不做，返回 false 让上层提示）。 */
export async function openUpdatePage(url: string | undefined): Promise<boolean> {
  if (!url) return false
  await shell.openExternal(url)
  return true
}
