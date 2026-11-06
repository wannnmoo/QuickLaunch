/**
 * 落盘日志（200 KB × 3 滚动）。
 *
 * 为什么要有它：这套代码里「实测三次才定位」的坑太多了（沉底代际、region 去重、
 * PowerShell 输出解析、spawn 时序……），而这些 bug 的共同点是**现场只在用户机器上出现**，
 * 我们手里只有一句「点了没反应」。console.error 写在 stdout 里，打包成 exe 之后
 * 用户永远看不到 —— 等于没有。
 *
 * 设计取舍：
 * - **同步 appendFileSync**：日志量很小（每次一两百字节），异步写会让「崩溃前的最后一行」
 *   有概率丢在缓冲区里 —— 那恰恰是最需要的一行。
 * - **自带滚动**：用户可能开着跑几个月，不能无限增长。200 KB × 3 = 最多 600 KB。
 * - **绝不让日志本身把进程搞崩**：任何写失败都吞掉并置 writeFailed，
 *   之后只留 console 输出（日志是诊断工具，不是业务依赖）。
 * - **时间戳带毫秒**：沉底/恢复这类竞态全靠毫秒级对齐才看得出谁先谁后。
 */

import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'

/** 单个日志文件的上限（字节）。3 个文件合计 600 KB 封顶 */
const LOG_MAX_BYTES = 200 * 1024
/** 滚动文件数：main.log + main.1.log + main.2.log */
const LOG_KEEP = 3

let logDir = ''
let logPath = ''
let ready = false
/** 当前文件已写字节数（避免每次都 statSync） */
let written = 0
/** 写盘彻底失败后不再尝试（磁盘满 / 权限被拒），只走 console */
let degraded = false

function rotateIfNeeded(incoming: number): void {
  if (written + incoming <= LOG_MAX_BYTES) return
  try {
    // main.2 丢弃，main.1 → main.2，main → main.1
    const oldest = join(logDir, `main.${LOG_KEEP - 1}.log`)
    if (existsSync(oldest)) unlinkSync(oldest)
    for (let i = LOG_KEEP - 2; i >= 1; i--) {
      const from = join(logDir, `main.${i}.log`)
      if (existsSync(from)) renameSync(from, join(logDir, `main.${i + 1}.log`))
    }
    renameSync(logPath, join(logDir, 'main.1.log'))
  } catch {
    // 滚动失败就继续往当前文件写（宁可超一点，也别丢日志）
  }
  written = 0
}

/** 在 app ready 之前调用也没问题（userData 路径此时已可用） */
export function initLogger(): void {
  if (ready) return
  try {
    logDir = join(app.getPath('userData'), 'logs')
    mkdirSync(logDir, { recursive: true })
    logPath = join(logDir, 'main.log')
    try {
      written = existsSync(logPath) ? statSync(logPath).size : 0
    } catch {
      written = 0
    }
    ready = true
    logInfo('app', `日志已启用 ${logPath}`)
  } catch (err) {
    degraded = true
    console.error('[log] 初始化失败，日志只在控制台输出:', err instanceof Error ? err.message : String(err))
  }
}

export type LogLevel = 'info' | 'warn' | 'error'

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0')
}

function stamp(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

function formatExtra(extra: unknown): string {
  if (extra === undefined) return ''
  if (extra instanceof Error) return ` | ${extra.name}: ${extra.message}\n${extra.stack ?? ''}`
  if (typeof extra === 'string') return ` | ${extra}`
  try {
    return ` | ${JSON.stringify(extra)}`
  } catch {
    return ` | ${String(extra)}`
  }
}

export function logLine(level: LogLevel, tag: string, message: string, extra?: unknown): void {
  const line = `${stamp()} [${level.toUpperCase().padEnd(5)}] [${tag}] ${message}${formatExtra(extra)}\n`
  // 控制台始终照旧：开发时看终端，打包版看日志文件
  if (level === 'error') console.error(line.trimEnd())
  else if (level === 'warn') console.warn(line.trimEnd())
  else console.log(line.trimEnd())
  if (!ready || degraded) return
  try {
    rotateIfNeeded(line.length)
    appendFileSync(logPath, line, 'utf-8')
    written += line.length
  } catch (err) {
    degraded = true
    console.error('[log] 写盘失败，后续只走控制台:', err instanceof Error ? err.message : String(err))
  }
}

export const logInfo = (tag: string, message: string, extra?: unknown): void => logLine('info', tag, message, extra)
export const logWarn = (tag: string, message: string, extra?: unknown): void => logLine('warn', tag, message, extra)
export const logError = (tag: string, message: string, extra?: unknown): void => logLine('error', tag, message, extra)

export const getLogDir = (): string => logDir
export const getLogPath = (): string => logPath

/** 读最近 n 行（诊断包/「查看日志」用；文件最多 200 KB，整读没问题） */
export function readRecentLog(maxBytes = LOG_MAX_BYTES): string {
  if (!ready) return ''
  try {
    const text = readFileSync(logPath, 'utf-8')
    return text.length > maxBytes ? text.slice(text.length - maxBytes) : text
  } catch {
    return ''
  }
}
