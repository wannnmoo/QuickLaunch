// SVG(仅圆角矩形) → 多尺寸 PNG → ICO，一次跑完。
// 为什么自己做光栅化：这台机器没有 sharp/resvg/canvas，而 Electron 拉起来渲染再截图太重。
// 更关键的是**精度**：图标只由圆角矩形构成（见 resources/icon.svg），而圆角矩形的
// 覆盖率可以解析求出（到圆角矩形的最短距离 + 1px 过渡带），比通用渲染器的 4x 超采样
// 更锐利、且完全确定（同样输入永远同样输出）。每个尺寸都是**独立解析渲染**，
// 不是把 256 缩放下来——这正是 16px 下还能看清的原因。
//
// 用法: node devtools/make-icons.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { deflateSync, inflateSync, crc32 } from 'node:zlib'
import { createHash } from 'node:crypto'

const SOURCE = 'resources/icon.svg'
// 两枚图标产出**完全相同**的图形（用户 2026-09 的决定：托盘与主图标一模一样）。
// 两个 SVG 必须逐字节一致——下面用哈希强制校验，防止以后只改一个、两处图标悄悄分叉。
// 要真的做出差异，得先想清楚并改掉这段校验。
const MIRROR = 'resources/tray-icon.svg'
const BACKDROP = { r: 0xf5, g: 0xf5, b: 0xf5 } // 资源管理器浅色背景，用于合成预览

// ── 几何：圆角矩形 ──────────────────────────────────────────────────────────
// 返回点到「圆角矩形」的最短距离（矩形内部为负）。坐标全部按 256 画布给出，
// 渲染时按 size/256 缩放，因此每个尺寸的圆角半径是精确的 (r * scale)。
function sdRoundRect (px, py, cx, cy, hw, hh, r) {
  const dx = Math.abs(px - cx) - (hw - r)
  const dy = Math.abs(py - cy) - (hh - r)
  const ax = Math.max(dx, 0)
  const ay = Math.max(dy, 0)
  const outside = Math.hypot(ax, ay)
  const inside = Math.min(Math.max(dx, dy), 0)
  return outside + inside - r
}

/** 覆盖率（0..1）。1px 过渡带：在像素中心采样距离场即可得到解析抗锯齿，
 *  不需要超采样——这就是小尺寸仍然锐利的原因。 */
const coverage = (d) => Math.min(1, Math.max(0, 0.5 - d))

// ── 合成：src 覆盖到 dst（非预乘 alpha）────────────────────────────────────
function over (dst, sr, sg, sb, sa) {
  const da = dst[3]
  const oa = sa + da * (1 - sa)
  if (oa <= 0) return [0, 0, 0, 0]
  dst[0] = (sr * sa + dst[0] * da * (1 - sa)) / oa
  dst[1] = (sg * sa + dst[1] * da * (1 - sa)) / oa
  dst[2] = (sb * sa + dst[2] * da * (1 - sa)) / oa
  dst[3] = oa
  return dst
}

/** 渲染一张 size×size 的 RGBA 图。shapes 由 SVG 解析得到，坐标基准 256。 */
function render (shapes, size, withBackdrop = false) {
  const s = size / 256
  const px = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = (x + 0.5) / s
      const cy = (y + 0.5) / s
      const dst = [0, 0, 0, 0]
      if (withBackdrop) { dst[0] = BACKDROP.r; dst[1] = BACKDROP.g; dst[2] = BACKDROP.b; dst[3] = 1 }
      for (const sh of shapes) {
        let a = sh.opacity
        for (const p of sh.parts) {
          a *= coverage(sdRoundRect(cx, cy, p.cx, p.cy, p.hw, p.hh, p.r))
          if (a <= 0) break
        }
        if (a > 0) over(dst, sh.r, sh.g, sh.b, a)
      }
      const i = (y * size + x) * 4
      px[i] = Math.round(dst[0]); px[i + 1] = Math.round(dst[1])
      px[i + 2] = Math.round(dst[2]); px[i + 3] = Math.round(dst[3] * 255)
    }
  }
  return px
}

// ── 极简 SVG 解析：只认 <rect>（含 rx）与 <g fill/opacity> 继承 ─────────────
// 注意：**必须先剥掉 XML 注释再解析**。本项目的 SVG 里用了大段注释说明设计约束，
// 而注释正文中会举例写出 `<g fill="#3B7BD5">` 这样的标签文本；不剥注释的话正则
// 会先匹配到注释里的那一段，把注释内容当成图形体，报出莫名其妙的「rect 缺少 fill」。
function stripComments (svg) {
  return svg.replace(/<!--[\s\S]*?-->/g, '')
}

function parseSvg (rawSvg) {
  const svg = stripComments(rawSvg)
  const num = (s, k, d) => {
    const m = s.match(new RegExp(k + '="([-\\d.]+)"'))
    return m ? parseFloat(m[1]) : d
  }
  const hex = (h) => ({
    r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16)
  })
  const shapes = []
  const groupRe = /<g\b([^>]*)>([\s\S]*?)<\/g>/g
  const collect = (body, inherited) => {
    // 自闭合与显式闭合都要吃：<rect .../> 与 <rect ...></rect>
    const rectRe = /<rect\b([^>]*?)\s*\/?>/g
    let m
    while ((m = rectRe.exec(body))) {
      const a = m[1]
      const fill = (a.match(/fill="(#[0-9a-fA-F]{6})"/) || [])[1] || inherited.fill
      if (!fill) throw new Error('rect 缺少 fill: ' + a)
      const opacity = num(a, 'opacity', num(a, 'fill-opacity', inherited.opacity))
      const x = num(a, 'x', 0), y = num(a, 'y', 0)
      const w = num(a, 'width', 0), h = num(a, 'height', 0)
      const rx = num(a, 'rx', 0)
      const c = hex(fill)
      shapes.push({
        ...c, opacity,
        parts: [{ cx: x + w / 2, cy: y + h / 2, hw: w / 2, hh: h / 2, r: Math.min(rx, w / 2, h / 2) }]
      })
    }
    // 组自身的 fill 作为默认值传给子 rect
  }
  let m
  let matchedGroup = false
  while ((m = groupRe.exec(svg))) {
    matchedGroup = true
    const attrs = m[1]
    const fill = (attrs.match(/fill="(#[0-9a-fA-F]{6})"/) || [])[1]
    const opacity = num(attrs, 'opacity', 1)
    collect(m[2], { fill, opacity })
  }
  if (!matchedGroup) collect(svg, { fill: null, opacity: 1 })
  if (shapes.length === 0) throw new Error('没解析到任何 <rect>')
  return shapes
}

// ── PNG 编码（过滤 0 = None；图标这类平色图配合 zlib 已经足够小）──────────
function chunk (type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0)
  return Buffer.concat([len, td, crc])
}
function encodePng (size, px) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))
  ])
}

// ── ICO 容器 ──────────────────────────────────────────────────────────────
function buildIco (entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4)
  const dir = Buffer.alloc(16 * entries.length)
  let offset = 6 + 16 * entries.length
  const blobs = []
  entries.forEach((e, i) => {
    const o = i * 16
    dir[o] = e.size >= 256 ? 0 : e.size
    dir[o + 1] = e.size >= 256 ? 0 : e.size
    dir[o + 2] = 0; dir[o + 3] = 0
    dir.writeUInt16LE(1, o + 4)   // planes
    dir.writeUInt16LE(32, o + 6)  // bpp
    dir.writeUInt32LE(e.png.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += e.png.length
    blobs.push(e.png)
  })
  return Buffer.concat([header, dir, ...blobs])
}

// ── 主流程 ────────────────────────────────────────────────────────────────
const APP_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
// 托盘尺寸只到 64：通知区图标物理最大 32px（200% DPI），即便用户再开系统放大也远用不到
// 256。两枚图标**图形完全一致**（同一份 SVG），只是托盘不塞用不到的大图，省 ~6% 体积、
// 也避免系统在极端情况下拿 256 去缩一个 16px 的图标。
const TRAY_SIZES = [16, 20, 24, 32, 48, 64]

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
if (!existsSync(MIRROR)) {
  console.error(`缺少 ${MIRROR}——请把 ${SOURCE} 的内容复制过去（两枚图标必须一致）`)
  process.exit(1)
}
if (sha(SOURCE) !== sha(MIRROR)) {
  console.error(`✗ ${SOURCE} 与 ${MIRROR} 内容不一致。两枚图标要求完全一样：`)
  console.error(`  用 ${SOURCE} 的内容覆盖 ${MIRROR}，或改掉 make-icons.mjs 里这段校验。`)
  process.exit(1)
}

function build (svgPath, sizes, outIco, previewDir) {
  if (!existsSync(svgPath)) { console.log(`跳过 ${svgPath}（还不存在）`); return }
  const shapes = parseSvg(readFileSync(svgPath, 'utf-8'))
  mkdirSync(previewDir, { recursive: true })
  const tag = outIco.split(/[\\/]/).pop().replace(/\.ico$/, '') // icon / tray-icon
  const entries = []
  for (const size of sizes) {
    const png = encodePng(size, render(shapes, size))
    entries.push({ size, png })
    // 预览版：合成到浅色底，方便肉眼检查边缘（资源管理器就是浅色背景）
    writeFileSync(`${previewDir}/${tag}-${size}.png`, encodePng(size, render(shapes, size, true)))
  }
  writeFileSync(outIco, buildIco(entries))
  console.log(`${svgPath} -> ${outIco}  [${sizes.join(', ')}]  ${entries.reduce((a, e) => a + e.png.length, 0)} B`)
}

build(SOURCE, APP_SIZES, 'resources/icon.ico', 'devtools/icons/preview')
build(MIRROR, TRAY_SIZES, 'resources/tray-icon.ico', 'devtools/icons/preview')

// 放大预览（最近邻），把 16/24/32 放到 256 便于肉眼确认「有没有糊」
function enlarge (pngPath, size, out) {
  const src = readFileSync(pngPath)
  const idat = []
  let p = 8
  while (p < src.length) {
    const len = src.readUInt32BE(p)
    const type = src.subarray(p + 4, p + 8).toString('ascii')
    if (type === 'IDAT') idat.push(src.subarray(p + 8, p + 8 + len))
    p += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const scale = Math.floor(256 / size)
  const outSize = size * scale
  const px = Buffer.alloc(outSize * outSize * 4)
  for (let y = 0; y < outSize; y++) {
    for (let x = 0; x < outSize; x++) {
      const si = (Math.floor(y / scale) * (size * 4 + 1) + 1) + Math.floor(x / scale) * 4
      const di = (y * outSize + x) * 4
      px[di] = raw[si]; px[di + 1] = raw[si + 1]; px[di + 2] = raw[si + 2]; px[di + 3] = raw[si + 3]
    }
  }
  writeFileSync(out, encodePng(outSize, px))
}

for (const n of ['icon', 'tray-icon']) {
  for (const s of [16, 24, 32]) {
    const src = `devtools/icons/preview/${n}-${s}.png`
    if (existsSync(src)) enlarge(src, s, `devtools/icons/zoom-${n}-${s}.png`)
  }
}
console.log('放大预览: devtools/icons/zoom-*.png')
