/**
 * Dock 几何（D1 拆分自 App.tsx）。
 *
 * 这里只有「纯函数 + 模块级缓存」，不碰 React，所以可以独立测试、也可以被
 * 主 Dock 与分组面板同时复用（面板就是迷你 Dock，量法与放大完全一样）。
 *
 * ⚠️ **坐标系是这个模块唯一的坑**：容器是横向滚动容器，存下来的必须是
 * **内容坐标**（= 视口坐标 + scrollLeft），命中也必须换算到同一个坐标系。
 * 历史上错过一次：量的是「相对容器可见左缘」的视口坐标、命中算的却是
 * `clientX - container.left`（内容坐标），两者只在 `scrollLeft === 0` 时相等 ——
 * 于是 Dock 一旦横向滚动，光标越往后放大就偏到左边 `scrollLeft` 像素的图标上
 * （表现为「鼠标移到后面的图标，动画却显示在前面的图标上」）。
 */

export type DockCenter = { id: number; cx: number; el: HTMLDivElement }

export function measureCenters(
  refs: Map<number, HTMLDivElement>,
  container: HTMLElement | null
): DockCenter[] {
  if (!container) return []
  // A4：能用布局值就用布局值。`offsetLeft` / `offsetWidth` 是**纯布局读数**——
  // 不触发强制同步布局（getBoundingClientRect 会），也**不含 transform**，
  // 所以正在放大（scale 1.4）的图标量出来仍是它该在的 60px 槽位。
  // 唯一要注意的是坐标系：offsetLeft 相对 offsetParent 的 **padding 盒左缘**，
  // 而命中侧用的是**内容坐标**（相对容器 border 盒左缘 + scrollLeft），
  // 两者只差 offsetParent 的 borderLeft —— 图标全在同一个滚动容器里排布，
  // offsetParent 一致，补一个常量就能对齐。
  // `offsetParent` 不是本容器的（如以后给某个图标加了定位祖先）就回退到
  // rect 算法，保证坐标仍然正确。
  const borderLeft = parseFloat(getComputedStyle(container).borderLeftWidth) || 0
  let box: DOMRect | null = null
  let scroll = 0
  const out: DockCenter[] = []
  refs.forEach((el, id) => {
    if (el.dataset.sep) return // 分隔线不参与放大
    let left: number
    if (el.offsetParent === container) {
      left = el.offsetLeft + borderLeft
    } else {
      box ??= container.getBoundingClientRect()
      scroll = container.scrollLeft
      left = el.getBoundingClientRect().left - box.left + scroll
    }
    out.push({ id, cx: left + el.offsetWidth / 2, el })
  })
  out.sort((a, b) => a.cx - b.cx)
  return out
}

/** 把某个图标的放大状态落到 DOM 上。用 WeakMap 记住上一次写进去的值，
 *  值没变就完全不动 DOM —— 原来每帧对每个图标无条件写 transform/zIndex，
 *  即使数值与上一帧一模一样也会让浏览器重新做样式解析与合成。 */
const appliedZoom = new WeakMap<HTMLElement, number>()

export function applyZoom(el: HTMLElement, scale: number, lift: number): void {
  const prev = appliedZoom.get(el)
  if (prev === scale) return
  if (scale <= 1) {
    el.style.transform = ''
    el.style.zIndex = ''
    appliedZoom.delete(el)
    return
  }
  el.style.transform = `scale(${scale}) translateY(${lift}px)`
  el.style.zIndex = '10'
  appliedZoom.set(el, scale)
}
