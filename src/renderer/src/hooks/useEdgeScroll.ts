/**
 * 拖到两端自动滚动（D1 拆分自 App.tsx）。
 *
 * 用 rAF 循环而不是只在 mousemove 里滚：**鼠标停在边缘不动时也要持续滚动**，
 * 而 mousemove 只在移动时才来。离开边缘区、松手、鼠标移出窗口都会自停。
 *
 * 速度曲线（C7）：strength 的 1.35 次方。端点不变（贴死仍是 EDGE_MAX_SPEED，
 * 刚进区仍是 ~0），但中段被压低 —— 边缘区内侧变慢、可以微调落点，贴到边上
 * 仍然全速。线性曲线的问题是刚进区就已经半速，想停在某个图标之前总冲过头。
 */
import { useCallback, useEffect, useRef } from 'react'

/** 进入边缘多少像素内开始自动滚动 */
export const EDGE_ZONE = 60
/** 每帧最大步长（≈1080px/s） */
export const EDGE_MAX_SPEED = 18

type Options = {
  innerRef: { current: HTMLDivElement | null }
  /** 滚动位置变了要同步「两端还有没有更多」的提示状态 + 底部滚动条 */
  updateScrollState: () => void
  /** 图标在光标下方移动后重算落点（只有正在拖拽时才用） */
  calcDropIndex: (clientX: number) => number
  onDropIdx: (idx: number) => void
  /** 是否正在拖拽图标或文件（决定要不要跟着重算落点） */
  isDragging: () => boolean
}

export function useEdgeScroll(opts: Options): {
  pumpEdgeScroll: (clientX: number) => void
  stopEdgeScroll: () => void
} {
  const { innerRef, updateScrollState, calcDropIndex, onDropIdx, isDragging } = opts
  const rafRef = useRef<number | null>(null)
  const clientXRef = useRef(0)

  const stopEdgeScroll = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  // 卸载时收掉可能在跑的帧循环（鼠标按着不放时组件被卸载 / StrictMode 重挂，
  // 循环会一直排帧直到光标离开边缘区才自停）
  useEffect(() => stopEdgeScroll, [stopEdgeScroll])

  const step = useCallback(() => {
    const el = innerRef.current
    if (!el) {
      rafRef.current = null
      return
    }
    const rect = el.getBoundingClientRect()
    const x = clientXRef.current
    // 左右两侧的贴近程度（0 = 在边缘区外，1 = 贴到边上）。上下都要钳：光标跑到
    // 容器外（Dock 侧边留白、窗口外）时算出来会 >1，那样每帧步长就突破上限
    const left = Math.min(1, Math.max(0, 1 - (x - rect.left) / EDGE_ZONE))
    const right = Math.min(1, Math.max(0, 1 - (rect.right - x) / EDGE_ZONE))
    const strength = Math.max(left, right)
    if (strength <= 0) {
      rafRef.current = null
      return
    }

    const before = el.scrollLeft
    const stepPx = Math.max(1, Math.round(Math.pow(strength, 1.35) * EDGE_MAX_SPEED))
    el.scrollLeft = before + (right > left ? 1 : -1) * stepPx
    if (el.scrollLeft !== before) {
      updateScrollState()
      if (isDragging()) onDropIdx(calcDropIndex(x))
    }
    rafRef.current = requestAnimationFrame(step)
  }, [innerRef, updateScrollState, isDragging, onDropIdx, calcDropIndex])

  const pumpEdgeScroll = useCallback(
    (clientX: number) => {
      clientXRef.current = clientX
      if (rafRef.current === null) rafRef.current = requestAnimationFrame(step)
    },
    [step]
  )

  return { pumpEdgeScroll, stopEdgeScroll }
}
