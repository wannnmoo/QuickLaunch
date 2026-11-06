/**
 * 图标外置存储（A1）。
 *
 * 背景：`shortcuts.json` 里原来把每个图标的 base64 data URL 直接内联在条目上。
 * 60 个图标约 0.5~1MB，而 renderer 每次保存都会把**整份**列表跨进程克隆一次、
 * 主进程再整份重序列化落盘（400ms 防抖）。图标越多，一次改名/一次拖动都要付
 * 这份固定成本，磁盘上同样是每次全量覆盖同一批字节。
 *
 * 做法：图标解码后按内容哈希存成 `{userData}/icons/<sha1-16>.<ext>`，条目上只留
 * `iconFile` 文件名，渲染端用自定义协议 `ql-icon://i/<file>` 取图（走 Chromium 的
 * 文件读取 + 图片解码缓存，比 base64 字符串还省一次 atob）。
 *
 * 三条不变量：
 *  1. **文件名是内容哈希** —— 同一张图只落一份；重复写入直接命中已存在的文件。
 *     图标更新时会产生新文件，旧文件由 `pruneIcons()` 按「没人引用」清理。
 *  2. **协议只读 icons 目录** —— 任何 `..` / 绝对路径 / 非白名单扩展名一律拒绝，
 *     否则这个协议就成了任意文件读取接口。
 *  3. **外置是幂等的** —— 条目已有 `iconFile` 就原样返回，`iconDataUrl` 清掉；
 *     迁移历史数据、保存新数据走的是同一个函数。
 */
import { app, protocol, net, nativeImage } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { logWarn } from './logger'

/** data URL → 扩展名。只认这几种图片格式（图标提取出来就是 png / 用户选的 jpg）。 */
const EXT_BY_MIME: Record<string, string> = {
  png: 'png',
  jpeg: 'jpg',
  jpg: 'jpg',
  webp: 'webp',
  gif: 'gif',
  bmp: 'bmp',
  'x-icon': 'ico',
  'vnd.microsoft.icon': 'ico'
}

const DATA_URL_RE = /^data:image\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i
/** 允许通过 ql-icon 协议读取的扩展名（与上面同一批） */
const ALLOWED_EXT = new Set(Object.values(EXT_BY_MIME))

let iconDirCache: string | null = null

function iconDir(): string {
  if (iconDirCache) return iconDirCache
  // 惰性求值：main/index.ts 在顶层 import 本模块，那时还没 ready；第一次真正用到
  // 是在 load-shortcuts / 保存时，早已 ready。用户目录本身在 ready 前也取得到，
  // 但没必要为此多一处「提前调用 Electron API」的隐患。
  iconDirCache = join(app.getPath('userData'), 'icons')
  return iconDirCache
}

function ensureIconDir(): string {
  const dir = iconDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** 把 data URL 解成 Buffer；格式不认识返回 null（调用方保留原样，不要丢图标） */
function decodeDataUrl(dataUrl: string): { buf: Buffer; ext: string } | null {
  const m = DATA_URL_RE.exec(dataUrl.trim())
  if (!m) return null
  const ext = EXT_BY_MIME[m[1].toLowerCase()]
  if (!ext) return null
  try {
    const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64')
    // 空图 / 解错（base64 里混了非法字符会被静默丢弃）都当失败
    if (buf.length < 32) return null
    return { buf, ext }
  } catch {
    return null
  }
}

// ─── 图标归一化（E4）────────────────────────────────────────────────────
// 问题：同一排图标看起来「大大小小」—— shell32 提取的通用图标四周带大片透明留白，
// 而应用自带图标往往撑满画布；.ico 源图尺寸也不一（16/32/256 混在一起）。CSS 只能
// 等比缩放整块画布，管不到「画布里的物体占多大」，所以必须在像素层把透明边裁掉。
const ICON_TARGET = 64 // 与 ICON_SIZE 一致：Dock 里最大显示 44px，2x 屏够用
const ICON_PAD = 1 // 裁完后四周留 1px，避免把描边连同抗锯齿一起切掉
const ICON_ALPHA_MIN = 8 // alpha ≤ 8 视为全透明（抗锯齿边缘的灰会被排除）

/** 扫描 BGRA 位图里「不透明内容」的包围盒。返回 DIP 坐标的矩形，全透明返回 null。 */
function alphaBounds(
  bitmap: Buffer,
  width: number,
  height: number
): { x: number; y: number; width: number; height: number } | null {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    const row = y * width * 4
    for (let x = 0; x < width; x++) {
      // toBitmap() 是 BGRA：字节顺序 B,G,R,A —— alpha 在 +3
      if (bitmap[row + x * 4 + 3] <= ICON_ALPHA_MIN) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

/**
 * 归一化一张图标：裁掉透明边 → 正方形（居中补透明）→ 缩放到 64×64 → 输出 PNG。
 *
 * 任何一步做不了（解码失败、位图尺寸和 DIP 尺寸对不上、裁剪越界）都**原样返回**：
 * 图标歪一点可以接受，图标消失不行。
 */
function normalizeIcon(dataUrl: string): { buf: Buffer; ext: string } | null {
  const decoded = decodeDataUrl(dataUrl)
  if (!decoded) return null
  try {
    const img = nativeImage.createFromDataURL(dataUrl)
    if (img.isEmpty()) return decoded
    const size = img.getSize()
    if (size.width <= 0 || size.height <= 0) return decoded
    const bitmap = img.toBitmap()
    // toBitmap() 给的是物理像素（scaleFactor 放大后）。只有和 DIP 尺寸对得上
    // 才敢按下标算坐标，否则（高 DPI 下 125%/150%）直接放弃归一化。
    if (bitmap.length !== size.width * size.height * 4) return decoded

    const box = alphaBounds(bitmap, size.width, size.height)
    if (!box) return decoded

    // 正方形化：取较长边，居中扩展
    const side = Math.max(box.width, box.height)
    let x = Math.round(box.x - (side - box.width) / 2)
    let y = Math.round(box.y - (side - box.height) / 2)
    // 越界平移回来（不能直接 clamp 宽高：那样会破坏正方形）
    x = Math.max(0, Math.min(x, size.width - side))
    y = Math.max(0, Math.min(y, size.height - side))
    const w = Math.min(side, size.width)
    const h = Math.min(side, size.height)

    // 已经是「无留白的 64×64 方图」就不要再重编码一遍（会把 PNG 越压越糊）
    const alreadyTight =
      box.width >= size.width - ICON_PAD * 2 && box.height >= size.height - ICON_PAD * 2 &&
      size.width === ICON_TARGET && size.height === ICON_TARGET
    if (alreadyTight) return decoded

    const cropped = img.crop({ x, y, width: w, height: h })
    const resized = cropped.resize({ width: ICON_TARGET, height: ICON_TARGET, quality: 'best' })
    const buf = resized.toPNG()
    if (!buf || buf.length < 32) return decoded
    return { buf, ext: 'png' }
  } catch (err) {
    logWarn('icons', '图标归一化失败（保留原图）', err)
    return decoded
  }
}

/** 落盘并返回文件名（`<sha1-16>.<ext>`）。失败返回 null —— 调用方保留原 dataUrl。 */
export function storeIconDataUrl(dataUrl: string): string | null {
  const decoded = normalizeIcon(dataUrl)
  if (!decoded) return null
  const hash = createHash('sha1').update(decoded.buf).digest('hex').slice(0, 16)
  const name = `${hash}.${decoded.ext}`
  const file = join(ensureIconDir(), name)
  try {
    if (!existsSync(file)) writeFileSync(file, decoded.buf)
    return name
  } catch (err) {
    logWarn('icons', `图标落盘失败（保留内联 data URL）: ${name}`, err)
    return null
  }
}

/**
 * 把一批条目上的 `iconDataUrl` 外置成 `iconFile`。
 * - 已有 `iconFile` 的条目：只删掉可能残留的 `iconDataUrl`
 * - 解不出来 / 落盘失败：**保留原 dataUrl**（宁可继续内联，也不能把图标弄没）
 * - 返回新数组（不改入参），`changed` 用于调用方决定要不要回写 renderer 状态
 */
export function externalizeIcons(entries: unknown[]): { entries: unknown[]; changed: boolean } {
  let changed = false
  const out = entries.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
    const entry = raw as Record<string, unknown>
    const dataUrl = typeof entry.iconDataUrl === 'string' ? entry.iconDataUrl : ''
    const existing = typeof entry.iconFile === 'string' ? entry.iconFile : ''
    if (existing) {
      if (!dataUrl) return raw
      changed = true
      const { iconDataUrl: _drop, ...rest } = entry
      return rest
    }
    if (!dataUrl) return raw
    const name = storeIconDataUrl(dataUrl)
    if (!name) return raw
    changed = true
    const { iconDataUrl: _drop, ...rest } = entry
    return { ...rest, iconFile: name }
  })
  return { entries: out, changed }
}

/** 删除没有被任何条目引用的图标文件（保存后调用；best-effort，失败只记日志）。
 *  只动 `icons` 目录里的普通文件，且只认扩展名白名单。 */
export function pruneIcons(entries: unknown[]): void {
  const dir = iconDir()
  if (!existsSync(dir)) return
  const used = new Set<string>()
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue
    const name = (raw as Record<string, unknown>).iconFile
    if (typeof name === 'string' && name) used.add(name)
  }
  let removed = 0
  for (const name of readdirSync(dir)) {
    if (used.has(name)) continue
    const ext = name.split('.').pop()?.toLowerCase() ?? ''
    if (!ALLOWED_EXT.has(ext)) continue
    try {
      if (!statSync(join(dir, name)).isFile()) continue
      unlinkSync(join(dir, name))
      removed++
    } catch {
      /* 被占用 / 已删除：下次再清 */
    }
  }
  if (removed > 0) logWarn('icons', `已清理 ${removed} 个未引用的图标文件`)
}

/**
 * 注册 `ql-icon://` 协议。**必须在 app ready 之前**调用 `registerSchemesAsPrivileged`
 * （模块导入时执行一次），`protocol.handle` 则在 ready 之后调用。
 *
 * 为什么标 standard + secure：非 standard 的 scheme 在 Chromium 里是不透明源，
 * `<img>` 能显示但 CSP 的 `img-src ql-icon:` 与相对解析行为都不确定；标 secure
 * 是为了避免「非安全源」警告污染控制台（本项目没有 https 源）。
 */
export function registerIconScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'ql-icon',
      privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: false }
    }
  ])
}

export function registerIconProtocol(): void {
  protocol.handle('ql-icon', (request) => {
    let name = ''
    try {
      const url = new URL(request.url)
      // ql-icon://i/<file>：host 只用来让 URL 合法（standard scheme 要求有 host）
      name = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    } catch {
      return new Response('bad request', { status: 400 })
    }
    // ─── 只允许 icons 目录里的白名单文件 ───────────────────────────────
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
      return new Response('forbidden', { status: 403 })
    }
    const ext = name.split('.').pop()?.toLowerCase() ?? ''
    if (!ALLOWED_EXT.has(ext)) return new Response('forbidden', { status: 403 })
    const file = join(iconDir(), name)
    if (!existsSync(file)) return new Response('not found', { status: 404 })
    // net.fetch 走 Chromium 的文件读取，自带缓存与正确的 Content-Type 推断
    return net.fetch(pathToFileURL(file).toString())
  })
}
