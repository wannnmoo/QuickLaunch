// 校验 icon.ico 与 tray-icon.ico 在**共同尺寸上逐个像素一致**（用户要求两枚图标一模一样）。
// 用法: node devtools/verify-icons.mjs
import { readFileSync } from 'node:fs'

function entries (file) {
  const buf = readFileSync(file)
  const n = buf.readUInt16LE(4)
  const out = new Map()
  for (let i = 0; i < n; i++) {
    const o = 6 + i * 16
    const w = buf[o] === 0 ? 256 : buf[o]
    const bytes = buf.readUInt32LE(o + 8)
    const off = buf.readUInt32LE(o + 12)
    out.set(w, buf.subarray(off, off + bytes))
  }
  return out
}

const a = entries('resources/icon.ico')
const b = entries('resources/tray-icon.ico')
console.log(`icon.ico      : ${[...a.keys()].join(', ')}`)
console.log(`tray-icon.ico : ${[...b.keys()].join(', ')}`)

let allSame = true
let checked = 0
for (const [size, png] of b) {
  const other = a.get(size)
  if (!other) { console.log(`  ${size}px  icon.ico 里没有这个尺寸`); allSame = false; continue }
  const same = Buffer.compare(png, other) === 0
  console.log(`  ${String(size).padStart(3)}px  ${png.length} B  ${same ? '两枚完全一致 ✔' : '✗ 不一致'}`)
  if (!same) allSame = false
  checked++
}
// 顺便确认 PNG 头里的宽高与目录项声明的一致（防止尺寸标错）
for (const [file, map] of [['icon.ico', a], ['tray-icon.ico', b]]) {
  for (const [size, png] of map) {
    const isPng = png[0] === 0x89 && png[1] === 0x50
    if (!isPng) { console.log(`✗ ${file} ${size}px 不是 PNG 条目`); allSame = false; continue }
    const w = png.readUInt32BE(16)
    const h = png.readUInt32BE(20)
    if (w !== size || h !== size) { console.log(`✗ ${file} ${size}px 实际为 ${w}x${h}`); allSame = false }
  }
}
console.log(`\n共同尺寸 ${checked} 个，全部逐像素一致: ${allSame ? '是 ✔' : '否 ✗'}`)
process.exit(allSame ? 0 : 1)
