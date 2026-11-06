import { memo, useCallback, useRef, useSyncExternalStore } from 'react'
import type { FC, RefObject } from 'react'
import type { FolderChild, FolderListing } from '../../shared/types'
import { fmtFileSize } from './format'
import { getFolderIconsVersion, lookupFolderIcon, subscribeFolderIcons } from './folderIcons'
import EmptyState from './EmptyState'

/** 文件夹悬停预览卡片的状态：anchorX = 悬停图标中心的视口 X（卡片按它锚定并钳制在窗口内） */
export type FolderCardState = {
  path: string
  name: string
  anchorX: number
  /** null = 正在读取（卡片先出现，列表随后填入） */
  data: FolderListing | null
}

type RowProps = {
  item: FolderChild
  icon: string | undefined
  onOpen: (item: FolderChild) => void
}

/**
 * 单行（A3）。`memo` 在这里是实打实的收益：一批图标推 24 个，命中当前目录的
 * 可能只有几行 —— 其余 140 多行的 props（item 引用 + icon 字符串）完全没变，
 * React 直接跳过它们的子树，只重渲染真正换了图标的那几行。
 */
const FolderRow = memo(function FolderRow({ item, icon, onOpen }: RowProps) {
  return (
    <div
      className={'folder-row' + (item.isDir ? ' dir' : '')}
      title={item.name}
      onClick={() => onOpen(item)}
    >
      <span className="folder-row-icon">
        {icon ? <img src={icon} alt="" draggable={false} /> : <span className="folder-row-glyph" />}
      </span>
      <span className="folder-row-name">{item.name}</span>
      <span className="folder-row-meta">
        {item.isDir ? '文件夹' : (fmtFileSize(item.size) || '文件')}
      </span>
    </div>
  )
})

type Props = {
  card: FolderCardState
  left: number
  anchorStyle: React.CSSProperties
  /** 「+」菜单 / 右键菜单打开时把卡片藏起来（原来的 visibility: hidden） */
  hidden: boolean
  cardRef: RefObject<HTMLDivElement | null>
  onEnter: () => void
  onLeave: () => void
  onOpenFolder: () => void
  onOpenChild: (item: FolderChild) => void
}

/**
 * 文件夹悬停预览卡片。
 *
 * 它被拆成独立组件（A3）不是为了好看，是为了**重渲染的范围**：图标分批补齐走
 * `folderIcons` 这个 App 之外的 store，订阅者只有这里，所以批次到达时 App 完全
 * 不动（Dock 的 60 个图标、分组拼图、面板成员都不用 diff）。见 folderIcons.ts 的说明。
 */
const FolderCard: FC<Props> = ({
  card,
  left,
  anchorStyle,
  hidden,
  cardRef,
  onEnter,
  onLeave,
  onOpenFolder,
  onOpenChild
}) => {
  // 订阅图标 store：批次到达时只让这张卡片重渲染
  useSyncExternalStore(subscribeFolderIcons, getFolderIconsVersion, getFolderIconsVersion)

  // 稳定引用的转发：App 里的 onOpenChild 每次渲染都是新函数，直接进 FolderRow 的
  // props 会让 memo 全部失效。这里用 ref 兜住，行组件的 props 引用就只随 item/icon 变。
  const openRef = useRef(onOpenChild)
  openRef.current = onOpenChild
  const handleOpen = useCallback((item: FolderChild) => {
    openRef.current(item)
  }, [])

  const data = card.data

  return (
    <div
      ref={cardRef}
      className="drives-card folder-card"
      style={{
        left,
        ...anchorStyle,
        // 与「+」菜单 / 右键菜单互斥；分组面板开着时**不隐藏**——面板里的
        // 文件夹成员也要能弹预览卡片，卡片已改锚到面板外侧。
        visibility: hidden ? 'hidden' : 'visible'
      }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div className="folder-card-head">
        <div className="folder-card-title">
          <span className="folder-card-name">{card.name}</span>
          <span className="folder-card-path" title={card.path}>{card.path}</span>
        </div>
        <div className="folder-card-open" title="在资源管理器中打开" onClick={onOpenFolder}>
          打开
        </div>
      </div>
      {!data && (
        <>
          <div className="folder-loading">
            <svg className="spinner" width="13" height="13" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M12 3a9 9 0 1 0 9 9" />
            </svg>
            读取中…
          </div>
          {/* 骨架行：和 .folder-row 同高（26px），真列表填入时不会跳动 */}
          <div className="folder-loading"><span className="skeleton" style={{ width: '58%' }} /></div>
          <div className="folder-loading"><span className="skeleton" style={{ width: '74%' }} /></div>
          <div className="folder-loading"><span className="skeleton" style={{ width: '46%' }} /></div>
        </>
      )}
      {data?.error && (
        <EmptyState
          className="drives-empty"
          icon={
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <line x1="12" y1="7.5" x2="12" y2="13" />
              <line x1="12" y1="16.5" x2="12.01" y2="16.5" />
            </svg>
          }
          main={
            data.error === 'missing' ? '文件夹不存在（可能已删除或移动）'
              : data.error === 'denied' ? '无法读取（权限不足）'
                : '这不是一个文件夹'
          }
        />
      )}
      {data && !data.error && (
        <>
          <div className="folder-card-sub">
            {data.folders} 个文件夹 · {data.files} 个文件
          </div>
          {data.items.length === 0 && (
            <EmptyState
              className="drives-empty"
              icon={
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 7.5a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                </svg>
              }
              main="空文件夹"
            />
          )}
          {data.items.map((it) => (
            <FolderRow
              key={it.path}
              item={it}
              icon={lookupFolderIcon(it.path, it.iconDataUrl)}
              onOpen={handleOpen}
            />
          ))}
          {data.truncated > 0 && (
            <div className="folder-card-more">
              还有 {data.truncated} 项未列出（打开文件夹查看）
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default memo(FolderCard)
