import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * 渲染错误兜底。
 *
 * 没有它的时候：App 里任何一处抛异常（坏图标、坏 JSON、某个条目字段是 undefined）
 * 都会让 React 卸载整棵树 → 用户看到一扇**全透明的空窗口**，而且它仍然置顶、
 * 仍然吃鼠标、Alt+Space 仍然能"唤回"——表现为「Dock 没了但鼠标点哪儿都没反应」。
 * 这比崩溃更难排查，因为它连崩溃都算不上。
 *
 * 有它之后：错误被捕获 → 上报主进程日志 → 原地显示一个可读的卡片，带「重新加载」与
 * 「导出诊断包」两个按钮。用户能自救，我们也能拿到栈。
 *
 * 注意：React 的 error boundary **抓不到**事件处理器里的异常和异步错误，
 * 那两类由 main.tsx 的 window 'error' / 'unhandledrejection' 通道兜住（只记录，不拦截）。
 */
type Props = { children: ReactNode }
type State = { error: Error | null; info: string }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: '' }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    try {
      window.api?.reportError({
        message: `React render error: ${error.message}`,
        stack: `${error.stack ?? ''}\n--- componentStack ---\n${info.componentStack ?? ''}`,
        source: 'ErrorBoundary'
      })
    } catch {
      /* 上报通道本身出错就算了 */
    }
    this.setState({ info: info.componentStack ?? '' })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash-screen">
        <div className="crash-card">
          <h2>面板遇到一个错误</h2>
          <p className="crash-msg">{error.message}</p>
          <div className="crash-actions">
            <button type="button" onClick={() => window.location.reload()}>重新加载</button>
            <button type="button" onClick={() => { void window.api?.exportDiagnostics() }}>导出诊断包</button>
            <button type="button" onClick={() => { void window.api?.openLogDir() }}>打开日志目录</button>
          </div>
          <details>
            <summary>技术细节</summary>
            <pre>{error.stack}{this.state.info}</pre>
          </details>
        </div>
      </div>
    )
  }
}
