/**
 * Dock 键盘导航（D1 拆分自 App.tsx 的 keydown effect）。
 *
 * 只有一条 document 级监听器，`navId` 为 null 时负责「唤醒」选中框。
 * 列表用哪一份取决于**选中项实际在哪一层**（`navInPanel`），不能只看 openGroupId ——
 * 面板可能是鼠标点开的，而选中框仍在主 Dock 上。
 */
import { useEffect } from 'react'
import type { AppEntry } from '../../../shared/types'

/** 「+」新增按钮的合成 id（不属于 apps，永远排在导航列表末尾之外） */
export const ADD_BTN_ID = -1

type Options = {
  navId: number | null
  openGroupId: number | null
  contextMenu: unknown
  menuPos: unknown
  appsRef: { current: AppEntry[] }
  iconRefs: { current: Map<number, HTMLElement> }
  panelIconRefs: { current: Map<number, HTMLElement> }
  typeaheadRef: { current: { buf: string; at: number } }
  setNavId: (id: number | null) => void
  setOpenGroupId: (id: number | null) => void
  setContextMenu: (v: { x: number; y: number; appId: number } | null) => void
  setMenuPos: (v: null) => void
  resumeNavId: (apps: AppEntry[]) => number | null
  armNavIdle: () => void
  handleAddToggle: () => void
  handleRun: (app: AppEntry) => void
  handleDelete: (id: number) => void
  closeDrivesCard: () => void
  closeFolderCard: () => void
}

export function useDockKeyboard(o: Options): void {
  const {
    navId, openGroupId, contextMenu, menuPos, appsRef, iconRefs, panelIconRefs, typeaheadRef,
    setNavId, setOpenGroupId, setContextMenu, setMenuPos, resumeNavId, armNavIdle,
    handleAddToggle, handleRun, handleDelete, closeDrivesCard, closeFolderCard
  } = o

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      // 编辑表单的输入框里正常打字，不参与导航
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return

      const navInPanel =
        openGroupId !== null && appsRef.current.some((a) => a.id === navId && a.groupId === openGroupId)
      const list = navInPanel
        ? appsRef.current.filter((a) => a.groupId === openGroupId && !a.isSeparator)
        : appsRef.current.filter((a) => !a.groupId && !a.isSeparator)

      // 菜单打开时 Esc 必须先能关菜单。⚠️ 这条**必须放在 navId === null 早退之前**：
      // 打开菜单的两个入口（handleAddToggle / handleContextMenu）都会 setNavId(null)，
      // 所以菜单打开时 navId 恒为 null，Esc 会在下面那句早退里被 return 掉
      if (e.key === 'Escape' && (contextMenu || menuPos)) {
        e.preventDefault()
        setContextMenu(null)
        setMenuPos(null)
        return
      }

      // 未处于导航模式：按方向键 / Home / End 直接「唤醒」选中框
      // Home / End 则直接跳到首/尾 —— 用户按它们时想要的显然不是「回到上次那里」
      if (navId === null) {
        const wakeKey =
          e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End'
        if (!wakeKey) return
        if (contextMenu || menuPos) return
        e.preventDefault()
        if (e.key === 'Home') {
          const first = list[0]
          if (first) setNavId(first.id)
          return
        }
        if (e.key === 'End') {
          const last = list[list.length - 1]
          if (last) setNavId(last.id)
          return
        }
        const resume = resumeNavId(appsRef.current)
        if (resume === null) return
        setNavId(resume)
        return
      }

      // 已进入导航模式：任何导航键都重置自动隐藏计时（含「按了但位置没变」的情况）
      if (
        e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Enter' ||
        e.key === 'Home' || e.key === 'End' || e.key === 'Tab'
      ) armNavIdle()

      // 「+」按钮：← 回到最后一个图标，Enter 打开菜单
      if (navId === ADD_BTN_ID) {
        if (e.key === 'ArrowLeft') {
          e.preventDefault()
          const last = list[list.length - 1]
          if (last) setNavId(last.id)
        } else if (e.key === 'Enter') {
          e.preventDefault()
          handleAddToggle()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          setNavId(null)
        }
        return
      }

      const current = appsRef.current.find((a) => a.id === navId)
      const idx = list.findIndex((a) => a.id === navId)

      // 首字母跳转（C4）：600ms 内的连续字符累积成一个前缀，从**当前项的下一个**开始
      // 循环查找（连按同一个字母能在同首字母的条目之间轮转）。只在真的命中时
      // preventDefault —— 未命中的字母键不该从浏览器手里抢走。
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && list.length > 0) {
        const now = Date.now()
        if (now - typeaheadRef.current.at > 600) typeaheadRef.current.buf = ''
        typeaheadRef.current.buf += e.key.toLowerCase()
        typeaheadRef.current.at = now
        const prefix = typeaheadRef.current.buf
        const n = list.length
        const from = idx >= 0 ? idx : 0
        const start = prefix.length === 1 ? from + 1 : from
        for (let k = 0; k < n; k++) {
          const cand = list[(start + k + n) % n]
          if ((cand.description || '').toLowerCase().startsWith(prefix)) {
            e.preventDefault()
            setNavId(cand.id)
            return
          }
        }
      }

      switch (e.key) {
        case 'ArrowRight': {
          e.preventDefault()
          // 分组：→ 进入面板并把选中移到第一个成员（分隔线不参与导航）
          if (current?.isGroup) {
            setOpenGroupId(current.id)
            const first = appsRef.current.find((a) => a.groupId === current.id && !a.isSeparator)
            if (first) setNavId(first.id)
            return
          }
          const next = list[idx + 1]
          if (next) {
            setNavId(next.id)
            return
          }
          // 已经在最右：落到「+」（面板里没有 + 按钮）。条件用 navInPanel 而不是
          // openGroupId —— 面板开着但选中项在主 Dock 时，→ 到最右应当照常落到「+」
          if (!navInPanel) setNavId(ADD_BTN_ID)
          return
        }
        case 'ArrowLeft': {
          e.preventDefault()
          if (navInPanel) {
            setOpenGroupId(null)
            setNavId(openGroupId)
            return
          }
          const prev = list[idx - 1]
          if (prev) setNavId(prev.id)
          return
        }
        case 'Enter': {
          e.preventDefault()
          // 菜单打开时不响应 Enter：选中框可能被菜单盖住，启动会显得无缘无故
          if (contextMenu || menuPos) return
          if (!current) return
          if (current.isGroup) {
            setOpenGroupId(current.id)
            const first = appsRef.current.find((a) => a.groupId === current.id && !a.isSeparator)
            if (first) setNavId(first.id)
            return
          }
          // 走 handleRun（与鼠标点击同一条路径）：那里有「同目标 600ms 去抖」和
          // 「启动失败 / 窗口收在托盘」的提示，直接调 runApp 会让键盘启动绕过去抖
          handleRun(current)
          setNavId(null)
          return
        }
        case 'Escape': {
          e.preventDefault()
          if (contextMenu || menuPos) {
            setContextMenu(null)
            setMenuPos(null)
            return
          }
          if (navInPanel) {
            setOpenGroupId(null)
            setNavId(openGroupId)
            return
          }
          if (openGroupId !== null) setOpenGroupId(null)
          setNavId(null)
          return
        }
        // ─── C4 补齐的导航键 ───────────────────────────────────────────
        case 'Home': {
          e.preventDefault()
          const first = list[0]
          if (first) setNavId(first.id)
          return
        }
        case 'End': {
          e.preventDefault()
          const last = list[list.length - 1]
          if (last) setNavId(last.id)
          return
        }
        // Tab / Shift+Tab 等同 → / ←：Dock 里没有可聚焦控件，把 Tab 让给浏览器
        // 只会把焦点丢到不可见的元素上（撤销按钮等），不如就地接管
        case 'Tab': {
          e.preventDefault()
          const step = e.shiftKey ? -1 : 1
          const next = list[idx + step]
          if (next) {
            setNavId(next.id)
            return
          }
          if (step > 0 && !navInPanel) setNavId(ADD_BTN_ID)
          return
        }
        case 'Delete': {
          e.preventDefault()
          // 分隔线也能删，但它没有「名字」，撤销条文案会走 isSeparator 分支
          if (!current) return
          handleDelete(current.id)
          setNavId(null)
          return
        }
        // 键盘唤起右键菜单（ContextMenu 键 / Shift+F10）。坐标取图标矩形中心：
        // 菜单自己会做钳制，不必另算锚点
        case 'ContextMenu':
        case 'F10': {
          if (e.key === 'F10' && !e.shiftKey) return
          e.preventDefault()
          if (!current || contextMenu || menuPos) return
          const el = iconRefs.current.get(current.id) ?? panelIconRefs.current.get(current.id)
          const r = el?.getBoundingClientRect()
          if (!r) return
          closeDrivesCard()
          closeFolderCard()
          setContextMenu({ x: r.left + r.width / 2, y: r.top + r.height / 2, appId: current.id })
          setNavId(null)
          return
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [
    navId, openGroupId, contextMenu, menuPos, appsRef, iconRefs, panelIconRefs, typeaheadRef,
    setNavId, setOpenGroupId, setContextMenu, setMenuPos, resumeNavId, armNavIdle,
    handleAddToggle, handleRun, handleDelete, closeDrivesCard, closeFolderCard
  ])
}
