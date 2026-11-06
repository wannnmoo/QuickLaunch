#!/usr/bin/env node
/**
 * 轻量自检（D6）—— 只查本项目真实踩过的坑，不追求通用 lint。
 *
 * 为什么不用 ESLint：本项目用 TypeScript 7 预发布版，`typescript-eslint` 的 peer
 * 范围还没跟上，装它就是一路 `--legacy-peer-deps`。而真正值得守的约定（C# 纯 ASCII、
 * PowerShell 输出标记、不许 renderer 碰 electron、不许留 .bak）通用 linter 一条都管不了，
 * 全写成本地规则反而更省事、零依赖、零版本冲突。
 *
 * 用法：node devtools/lint.mjs        （CI 与 npm run verify 都跑它）
 * 退出码：0 = 全过；1 = 有 error 级问题
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const problems = []

const err = (file, line, rule, msg) => problems.push({ file, line, rule, level: 'error', msg })
const warn = (file, line, rule, msg) => problems.push({ file, line, rule, level: 'warn', msg })

/** 递归收集源码文件 */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const srcFiles = walk(join(ROOT, 'src'))
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/')
const byExt = (ext) => srcFiles.filter((p) => p.endsWith(ext))

// ── 1. 主进程内嵌的 C# 必须纯 ASCII ─────────────────────────────────────
// `powershell.exe -Command <文本>` 按系统 ANSI 代码页（中文 Windows = GBK/936）解码命令行，
// 而源码是 UTF-8。C# 里出现中文注释时 GBK 会解错多字节序列、吃掉注释结尾的 `*/`，
// 整段编译失败 → 功能静默失效（不报错，只表现为「没生效」，极难定位）。
// 约定：C# 里的说明一律写成英文标识符/注释，中文解释写在 TS 一侧。
{
  const targets = [...byExt('.ts')].filter((p) => !p.includes(`${'shared'}`))
  const constRe = /^const ([A-Z_]+_CS)\s*=\s*`/gm
  for (const p of targets) {
    const text = readFileSync(p, 'utf8')
    const lines = text.split('\n')
    let m
    while ((m = constRe.exec(text))) {
      const startLine = text.slice(0, m.index).split('\n').length
      // 找到模板串结束的反引号（不含转义）
      let end = m.index + m[0].length
      while (end < text.length && !(text[end] === '`' && text[end - 1] !== '\\')) end++
      const body = text.slice(m.index, end)
      const idx = body.search(/[^\x00-\x7F]/)
      if (idx >= 0) {
        const line = startLine + body.slice(0, idx).split('\n').length - 1
        err(rel(p), line, 'csharp-ascii', `${m[1]} 含非 ASCII 字符（会让 Add-Type 静默失败）；C# 内只写英文，中文说明写在 TS 一侧`)
      }
      void lines
    }
  }
}

// ── 2. console.error / warn 只允许出现在 logger 与 errors 里 ────────────
// 打包版里用户看不到 devtools 控制台，全部错误必须落盘（logger）或推给主进程（reportError）。
// 放行名单是「实现落盘/上报的那两个模块」，别往名单里加业务文件。
{
  const ALLOW = new Set(['src/main/logger.ts', 'src/renderer/src/errors.ts', 'src/main/index.ts'])
  for (const p of [...byExt('.ts'), ...byExt('.tsx')]) {
    const r = rel(p)
    if (ALLOW.has(r)) continue
    readFileSync(p, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return // 注释里的示例不算
        if (/console\.(error|warn)\s*\(/.test(line)) {
          err(r, i + 1, 'no-console', '改用 logError/logWarn（主进程）或 reportClientError（renderer）')
        }
      })
  }
}

// ── 3. 窗口不可自由拖动（Dock 窗专用；设置窗是普通窗口，允许自绘标题栏拖动）──
// 透明窗口下 Dock 栏贴窗口上沿/下沿，位置一动就得补偿布局，实测必然跳动。
// 位置只由停靠预设决定 —— 这条在 CLAUDE.md 里写过，用脚本钉住。
// ⚠️ 设置中心（src/renderer/src/settings/**）是 `frame: false` 的**普通不透明窗口**，
//    它必须靠 `-webkit-app-region: drag` 才能拖，所以这里按目录放行；
//    但要求它的按钮容器显式 `no-drag`（否则标题栏上的 × / – 点不动）。
{
  for (const p of byExt('.css')) {
    const r = rel(p)
    const isSettingsWin = r.startsWith('src/renderer/src/settings/')
    const lines = readFileSync(p, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (!/app-region\s*:\s*drag/.test(line) || line.trim().startsWith('/*')) return
      if (isSettingsWin) return
      err(r, i + 1, 'no-window-drag', '窗口位置只由停靠预设决定，不要引入 -webkit-app-region: drag')
    })
    if (isSettingsWin && lines.some((l) => /app-region\s*:\s*drag/.test(l))) {
      if (!lines.some((l) => /app-region\s*:\s*no-drag/.test(l))) {
        err(r, 1, 'no-window-drag', '设置窗用了 drag，但没有任何 no-drag 容器 —— 标题栏按钮会点不动')
      }
    }
  }
}

// ── 4. renderer 不许碰 electron / node 内置 ────────────────────────────
// contextBridge 是唯一通道；越过它的 import 在打包后会直接抛（或者更糟：构建时被外部化）。
{
  for (const p of [...byExt('.ts'), ...byExt('.tsx')]) {
    const r = rel(p)
    if (!r.startsWith('src/renderer/')) continue
    readFileSync(p, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (/^\s*import\s.*from\s+['"]electron['"]/.test(line) || /require\(\s*['"]electron['"]\s*\)/.test(line)) {
          err(r, i + 1, 'no-electron-in-renderer', 'renderer 只能通过 window.api（preload contextBridge）访问主进程能力')
        }
        if (/^\s*import\s.*from\s+['"]node:/.test(line)) {
          err(r, i + 1, 'no-node-in-renderer', 'renderer 不能用 node 内置模块；需要能力就加 IPC')
        }
      })
  }
}

// ── 5. src/ 下不许留备份/临时文件 ──────────────────────────────────────
// 曾经把 App.tsx.bak 留在 src/renderer/src/ 里，被 tsconfig include 后报一片语法错。
{
  for (const p of srcFiles) {
    if (/\.(bak|tmp|orig|rej)$/.test(p) || /\.bak\d*$/.test(p)) {
      err(rel(p), 1, 'no-backup-in-src', '备份请放到仓库根目录以外的临时位置（如 D:\\），src/ 只放会被编译的文件')
    }
  }
}

// ── 6. ipcMain.handle 的每个 channel 都必须在 preload 里被 invoke ───────
// 主进程写了 handler、preload 忘了暴露，是「功能写了但点不到」的典型来源。
// 只做 warn：有些通道故意只给内部用（如 select-folder 由 parse-lnk 复用）。
{
  const mainText = byExt('.ts')
    .filter((p) => rel(p).startsWith('src/main/'))
    .map((p) => readFileSync(p, 'utf8'))
    .join('\n')
  const preloadText = byExt('.ts')
    .filter((p) => rel(p).startsWith('src/preload/'))
    .map((p) => readFileSync(p, 'utf8'))
    .join('\n')

  const channels = new Set()
  const re = /ipcMain\.handle\(\s*'([^']+)'/g
  let m
  while ((m = re.exec(mainText))) channels.add(m[1])
  const reOn = /ipcMain\.on\(\s*'([^']+)'/g
  while ((m = reOn.exec(mainText))) channels.add(m[1])

  for (const ch of channels) {
    if (!preloadText.includes(`'${ch}'`)) {
      warn('src/preload/index.ts', 0, 'ipc-unexposed', `主进程注册了 '${ch}'，但 preload 里没有同名通道`)
    }
  }
}

// ── 输出 ───────────────────────────────────────────────────────────────
const errors = problems.filter((p) => p.level === 'error')
const warnings = problems.filter((p) => p.level === 'warn')

for (const p of problems) {
  const where = p.line > 0 ? `${p.file}:${p.line}` : p.file
  console.log(`${p.level === 'error' ? 'ERROR' : 'WARN '} ${where}  [${p.rule}] ${p.msg}`)
}

if (problems.length === 0) {
  console.log('lint: 全部规则通过')
} else {
  console.log(`\nlint: ${errors.length} 个错误，${warnings.length} 个警告`)
}
process.exit(errors.length > 0 ? 1 : 0)
