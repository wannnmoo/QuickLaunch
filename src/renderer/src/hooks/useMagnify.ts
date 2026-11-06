/**
 * Dock 悬停放大（D1 拆分自 App.tsx）。
 *
 * 几何来自 measureCenters 的缓存（见 ./dockGeometry）：每次鼠标移动只做算术 ——
 * 在升序中心点数组上二分定位光标，再只遍历左右各 MAGNIFY_RANGE 内的那一段
 * （升序数组上就是从 start 到末尾的连续前缀），区间外只有「上一帧刚被放大过」
 * 的元素才需要复位。整体是一次容器布局读取 + 少量样式写入。
 *
 * ⚠️ 两个不改会被坑的地方：
 *  ① 光照坐标必须是**内容坐标**（视口 + scrollLeft），与 centers 的口径一致；
 *  ② 放大倍数来自设置（1.25 / 1.4 / 1.55），**magnify === 1 是「不放大」的合法值** ——
 *     判断缺失要用 `Number.isFinite`，用 `|| 默认值` 会把它当假值又放大回去。
 */
import { useCallback, useRef } from 'react'
import type { AppSettings } from '../../../shared/types'
import { applyZoom, type DockCenter } from '../dockGeometry'

export const MAGNIFY_RANGE = 140
/** 默认放大到 1.4×（= 1 + 0.4）。实际倍数由设置驱动，这里只作兜底 */
export const MAGNIFY_EXTRA = 0.4

type Options = {
  settingsRef: { current: AppSettings }
  /** Dock 停在上沿时放大方向朝下（上浮取负值） */
  isTop: boolean
}

export function useMagnify({ settingsRef, isTop }: Options): {
  magnifyAt: (container: HTMLElement | null, centers: DockCenter[], clientX: number) => void
  clearMagnify: () => void
} {
  /** 上一次放大过的元素（只有它们可能需要复位，避免每帧遍历全部图标） */
  const magnified = useRef<Set<HTMLElement>>(new Set())

  const magnifyAt = useCallback(
    (container: HTMLElement | null, centers: DockCenter[], clientX: number) => {
      const active = magnified.current
      if (!container || centers.length === 0) {
        active.forEach((el) => applyZoom(el, 1, 0))
        active.clear()
        return
      }
      // 光标同样换算到**内容坐标**
      const mx = clientX - container.getBoundingClientRect().left + container.scrollLeft

      // 升序中心点里找第一个 >= mx 的位置（二分：几十个图标也别线性扫）
      let lo = 0
      let hi = centers.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (centers[mid].cx < mx) lo = mid + 1
        else hi = mid
      }
      let start = lo
      while (start > 0 && mx - centers[start - 1].cx < MAGNIFY_RANGE) start--

      const magSet = settingsRef.current.magnify
      const extra = Math.max(0, (Number.isFinite(magSet) ? magSet : 1 + MAGNIFY_EXTRA) - 1)
      const liftRange = MAGNIFY_RANGE * 0.6
      const next = new Set<HTMLElement>()
      for (let i = start; i < centers.length; i++) {
        const { cx, el } = centers[i]
        const dist = Math.abs(mx - cx)
        if (dist >= MAGNIFY_RANGE) break
        const s = 1 + (1 - dist / MAGNIFY_RANGE) * extra
        // 上浮方向朝 Dock 外侧：底部 Dock 向上顶出玻璃条，顶部 Dock 向下顶出
        const lift = dist < liftRange ? (1 - dist / liftRange) * 8 : 0
        applyZoom(el, s, isTop ? lift : -lift)
        next.add(el)
      }
      // 上一帧放大、这一帧不在范围内的图标复位
      active.forEach((el) => {
        if (!next.has(el)) applyZoom(el, 1, 0)
      })
      magnified.current = next
    },
    [isTop, settingsRef]
  )

  const clearMagnify = useCallback(() => {
    magnified.current.forEach((el) => applyZoom(el, 1, 0))
    magnified.current.clear()
  }, [])

  return { magnifyAt, clearMagnify }
}
