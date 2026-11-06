/**
 * 纯格式化 / 规范化小工具（渲染进程）。
 *
 * 这些函数原来都躺在 App.tsx 顶部。抽出来的原因很实际：拆分预览卡片等子组件时，
 * 子组件要用到它们，而从 App.tsx 反向 import 会把「App 依赖子组件、子组件又依赖 App」
 * 绕成环（Vite 能跑，但热更新会拿到半初始化的模块，表现为 undefined is not a function）。
 * 所以它们必须待在**不依赖任何 React 状态**的叶子模块里。
 */

/**
 * 路径规范化：去首尾空白 + 去尾部反斜杠 + 小写。
 * Windows 路径大小写不敏感，桌面扫描去重、图标批次对齐都靠它。
 */
export const normPath = (p: string): string => (p || '').trim().replace(/\\+$/, '').toLowerCase()

/**
 * 文件大小格式化：按 B / KB / MB / GB 递进（单个文件比磁盘小几个量级，
 * 所以和磁盘容量用的 `fmtSize` 分级不同）。
 *
 * 负数（目录）返回空串；**非有限值也返回空串** —— 少了这一条，
 * 拿不到大小的文件（stat 失败 / 网络盘断开）会渲染成 `NaN GB`。
 */
export const fmtFileSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}
