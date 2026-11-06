/**
 * 文件夹预览卡片的后台图标存储（A3）。
 *
 * 为什么要出这个模块：主进程的 `list-folder` 只秒回前 14 个图标，剩下的按每批
 * 24 个通过 `folder-icons` 事件补齐（一个 150 项的目录约 6 批）。原来每批都
 * `setFolderCard(...)` —— 而 `folderCard` 是 **App 的 state**，于是每批都会让整个
 * App（Dock 全部图标、标签、分组拼图、面板成员、两张大卡片）重渲染一次。
 * 6 批 = 6 次全树 diff，而每次真正变的只有二十来行。
 *
 * 现在图标不进 React state，而是放在这个 App 之外的可订阅 store 里：
 * 批次到达只 `notify()` 订阅者（只有卡片一个），卡片内部再用 memo 的行组件，
 * 最终只有「图标真的变了的那几行」重渲染。
 *
 * 注意：这里存的只是**运行时缓存**，不落盘——目录换了一批路径就会越来越多，
 * 所以有 `MAX_ENTRIES` 上限，超了按插入顺序丢最早的（Map 保证插入序）。
 */

import { normPath } from './format'

/** 上限：一个目录最多 400 项、卡片本身又有 150 的上限，4000 条足够浏览十几个目录 */
const MAX_ENTRIES = 4000

const icons = new Map<string, string>()
const listeners = new Set<() => void>()
let version = 0

/** 查询某个文件的图标；没有就退回条目自带的那张（首批图标或通用占位） */
export function lookupFolderIcon(path: string, fallback?: string): string | undefined {
  return icons.get(normPath(path)) ?? fallback
}

export function subscribeFolderIcons(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function getFolderIconsVersion(): number {
  return version
}

/**
 * 收下一批图标（`path → dataURL`）。返回是否真的有变化——
 * 没有变化就完全不通知，避免重复批次引起无意义的重渲染。
 */
export function pushFolderIcons(batch: Record<string, string>): boolean {
  let changed = false
  for (const rawPath of Object.keys(batch)) {
    const icon = batch[rawPath]
    if (!icon) continue
    const key = normPath(rawPath)
    if (!key || icons.get(key) === icon) continue
    icons.set(key, icon)
    changed = true
  }
  if (!changed) return false

  if (icons.size > MAX_ENTRIES) {
    const overflow = icons.size - MAX_ENTRIES
    let removed = 0
    for (const key of icons.keys()) {
      if (removed >= overflow) break
      icons.delete(key)
      removed++
    }
  }

  version++
  // 复制一份再遍历：订阅者在回调里退订不会破坏本轮迭代
  for (const cb of [...listeners]) cb()
  return true
}

/** 测试/诊断用：清空缓存 */
export function clearFolderIcons(): void {
  if (icons.size === 0) return
  icons.clear()
  version++
  for (const cb of [...listeners]) cb()
}
