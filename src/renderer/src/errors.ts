/**
 * renderer 侧错误上报（B2 的落点）。
 *
 * 打包版里 renderer 的 `console.error` 用户永远看不到 —— 控制台要开 devtools 才有，
 * 而 Dock 是常驻桌面的小窗，用户不会去开。所以这里统一往前推：
 *   主进程 `report-renderer-error` → logger 落盘 → 诊断包里可见。
 *
 * 只上报、不改变控制流：调用方原本 `catch { 提示一下 }` 的语义必须保留，
 * 这里绝不 throw，也绝不弹 UI（弹窗交给调用方的 showDropHint / 崩溃屏）。
 */

interface ReportPayload {
  message: string
  stack: string
  source: string
}

/**
 * @param tag 模块短名（`folder-card` / `desktop-sync` …），只是给人看的分类前缀
 * @param err 任意抛出物：Error / string / DOMException / 事件对象
 */
export function reportClientError(tag: string, err: unknown, source = 'renderer'): void {
  const message = err instanceof Error ? err.message : String(err)
  const stack = err instanceof Error && err.stack ? err.stack : ''

  // 开发期仍然打控制台：终端里能立刻看到，不必翻日志文件。
  // 这一行是全项目唯一允许直接 console.error 的地方（devtools/lint.mjs 白名单）。
  if (import.meta.env.DEV) {
    console.error(`[${tag}]`, err)
  }

  const payload: ReportPayload = { message: `[${tag}] ${message}`, stack, source }
  try {
    window.api?.reportError?.(payload)
  } catch {
    // preload 还没就绪（首帧崩溃）或主进程已退出：吞掉，绝不因为上报失败而让原错误变严重
  }
}
