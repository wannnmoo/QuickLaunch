// shortcuts.json 持久化层（D2 拆分自 main/index.ts）。
//
// 这里只管「读 / 校验 / 写 / 迁移」四件事，不含任何窗口或 Dock 逻辑 ——
// 拆出来的目的：这些函数是纯数据变换，可以直接用 node --test 单测（见 devtools/tests）。
import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs'
import { join } from 'path'
import { ipcMain } from 'electron'
import { logError, logInfo, logWarn } from './logger'
import { writeFileAtomic } from './persist'
import { externalizeIcons, pruneIcons } from './iconStore'

// ─── IPC: persist shortcuts ─────────────────────────────────────────────────

export const shortcutsPath = join(app.getPath('userData'), 'shortcuts.json')
/** 上一次「可解析」的副本：shortcuts.json 解析失败时先尝试从它恢复 */
export const shortcutsBackupPath = `${shortcutsPath}.bak`

/** sanitize 之后仍可能是形状未知的条目（见 sanitizeShortcutEntries），所以这里的
 *  entries 比 shared 的 LoadShortcutsResult.entries 更宽 —— 它只是主进程内部的中间态。 */
export interface SanitizedShortcutsResult {
  entries: unknown[]
  corrupt: boolean
  recovered: boolean
}

export function sanitizeShortcutEntries(raw: unknown[]): unknown[] {
  const result: unknown[] = []
  const seenIds = new Set<number>()
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const obj = entry as Record<string, unknown>
    let normalized: Record<string, unknown>
    if (obj.separator) {
      const { separator: _legacy, ...rest } = obj
      normalized = { ...rest, isSeparator: true }
    } else {
      normalized = { ...obj }
    }
    if (typeof normalized.id !== 'number' || !Number.isFinite(normalized.id)) continue
    if (typeof normalized.targetPath !== 'string') continue
    if (seenIds.has(normalized.id)) continue
    seenIds.add(normalized.id)
    if (typeof normalized.isGroup !== 'boolean') delete normalized.isGroup
    if (typeof normalized.isSeparator !== 'boolean') delete normalized.isSeparator
    if (typeof normalized.isFolder !== 'boolean') delete normalized.isFolder
    if (typeof normalized.groupId !== 'number' || !Number.isFinite(normalized.groupId)) delete normalized.groupId
    for (const key of ['iconDataUrl', 'iconFile', 'description', 'arguments', 'workingDirectory', 'specialType', 'hotkey', 'page']) {
      if (typeof normalized[key] !== 'string') delete normalized[key]
    }
    // 普通条目必须有目标；分组 / 分隔线本来就是空 targetPath
    if (!normalized.isGroup && !normalized.isSeparator && normalized.targetPath.trim() === '') continue
    result.push(normalized)
  }
  return result
}

/** 读取并解析一个持久化文件；顶层不是数组时视为损坏（抛给调用方走恢复流程）。
 *  返回 dropped：被 sanitize 丢弃的条目数——只要 > 0 就说明磁盘里有一部分
 *  无法识别的条目，调用方必须把原文件另存一份再让 renderer 写回合法子集。 */
export function readShortcutEntries(filePath: string): { entries: unknown[]; dropped: number } {
  const raw: unknown = JSON.parse(readFileSync(filePath, 'utf-8'))
  if (!Array.isArray(raw)) throw new Error('shortcuts.json 顶层不是数组')
  const entries = sanitizeShortcutEntries(raw)
  return { entries, dropped: raw.length - entries.length }
}

/** 把当前 shortcuts.json 另存一份现场（best-effort）。用于「解析失败」与「部分条目
 *  无法识别」两种场景：前者整个文件保留，后者至少保住被 sanitize 丢掉的原始数据。 */
export function preserveCorruptShortcuts(): void {
  try {
    copyFileSync(shortcutsPath, `${shortcutsPath}.corrupt-${Date.now()}`)
  } catch (copyErr) {
    logError('persist', '保留损坏的 shortcuts.json 现场失败', copyErr)
  }
}

/** 加载后把条目上的内联图标迁出成文件（A1 的历史数据迁移）。
 *  迁移成功后**立刻回写磁盘**：否则每次启动都要把几 MB base64 重新解一遍 base64、
 *  再写同样的文件（内容哈希保证不重复写，但解码成本跑不掉）。
 *  失败不影响加载结果 —— 条目上仍然留着 iconDataUrl，功能完全正常，只是继续内联。 */
export function migrateLoadedIcons(result: SanitizedShortcutsResult): SanitizedShortcutsResult {
  try {
    const { entries, changed } = externalizeIcons(result.entries)
    if (!changed) return result
    const before = result.entries.length
    logInfo('icons', `已把 ${before} 条条目中的内联图标外置到 icons/`)
    try {
      writeShortcuts(entries)
      pruneIcons(entries)
    } catch (err) {
      logWarn('icons', '图标外置后回写 shortcuts.json 失败（下次启动会重试）', err)
    }
    return { ...result, entries }
  } catch (err) {
    logWarn('icons', '图标外置失败（继续使用内联 data URL）', err)
    return result
  }
}


/** 写盘。v1.12.2 起 renderer 状态里存的就是真实 data URL，这里不再做任何换算。
 *  （v1.12.0/v1.12.1 曾在这里把哨兵串换成「最近见过的文件夹图标」，那个值为空时
 *   会把空串写进磁盘，是「文件夹图标永久空白」事故的最后一环。） */
export function writeShortcuts(data: unknown[]): void {
  writeFileAtomic(shortcutsPath, JSON.stringify(data))
}


/** 批量把条目上的内联图标外置成 iconFile（A1）。renderer 在保存前调它，
 *  这样内存里的 React state 也不再持有 base64 —— 之后每次保存只有几十字节/条。 */

/** 注册 shortcuts 读写相关的 IPC（load / save / externalize-icons）。
 *  handler 必须在 app ready 前后都能安全调用，所以这里只做注册、不做 IO。 */
export function registerShortcutsIpc(): void {
  ipcMain.handle('load-shortcuts', (): SanitizedShortcutsResult => {
    if (!existsSync(shortcutsPath)) return { entries: [], corrupt: false, recovered: false }
    try {
      const { entries, dropped } = readShortcutEntries(shortcutsPath)
      if (dropped > 0) {
        // 文件能 parse，但有部分条目形状不可用：保留现场，并让 renderer 提示用户。
        // 否则下次保存会用合法子集覆盖磁盘，被丢掉的原始条目就永久消失了。
        preserveCorruptShortcuts()
        logWarn('persist', `shortcuts.json 有 ${dropped} 条无法识别，已保留现场；有效条目 ${entries.length} 条`)
        return migrateLoadedIcons({ entries, corrupt: true, recovered: false })
      }
      return migrateLoadedIcons({ entries, corrupt: false, recovered: false })
    } catch (err) {
      logError('persist', 'shortcuts.json 读取/解析失败', err)
      // 无论能否从 .bak 恢复，都先把坏掉的原文件留一份现场：否则恢复成功后下一次
      // 保存会直接覆盖它，原始数据就再也拿不回来了。
      preserveCorruptShortcuts()
      // 先尝试上一次成功保存的副本：它最可能是用户真实数据的完整版本
      try {
        const { entries, dropped } = readShortcutEntries(shortcutsBackupPath)
        logWarn('persist', `已从 shortcuts.json.bak 恢复 ${entries.length} 条（丢弃 ${dropped} 条）`)
        return migrateLoadedIcons({ entries, corrupt: true, recovered: true })
      } catch {
        // 备份也不可用：返回空列表交给 renderer 决定（原文件已另存现场）
        return { entries: [], corrupt: true, recovered: false }
      }
    }
  })

  ipcMain.handle('save-shortcuts', (_event, data: unknown): boolean => {
    if (!Array.isArray(data)) return false
    // A1：写盘前把可能残留的内联图标外置（renderer 保存前已经调过一次 externalize-icons，
    // 这里是兜底：老版本 renderer / 手工粘贴的数据也不会把 base64 写回磁盘）。
    // 放在 try 外面：外置失败（磁盘写不了）不该让「整次保存」连带失败。
    let entries: unknown[] = data
    try {
      entries = externalizeIcons(data).entries
    } catch (err) {
      logWarn('icons', '保存前外置图标失败，按原样写盘', err)
    }
    try {
      writeShortcuts(entries)
      // 不再被引用的图标文件顺手清掉（改图标、删条目都会留下孤儿文件）
      pruneIcons(entries)
      return true
    } catch (err) {
      // 不能静默吞掉：renderer 据此提示「保存失败」，否则用户以为已经写盘
      logError('persist', 'save-shortcuts 写盘失败', err)
      // A5 降级保存：主写入失败（文件被占用 / 权限 / 只读目录）时，至少把这份数据
      // 落到旁边一个 `.recovery` 文件里 —— 用户下次启动虽然读不到它，但人工救援
      // 时数据还在，不会被「下一次成功保存」覆盖掉。失败就只剩日志了。
      try {
        const recoveryPath = `${shortcutsPath}.recovery`
        writeFileSync(recoveryPath, JSON.stringify(entries))
        logWarn('persist', `已降级保存到 ${recoveryPath}（${entries.length} 条）`)
      } catch (fallbackErr) {
        logError('persist', '降级保存也失败，本次改动只存在于内存', fallbackErr)
      }
      return false
    }
  })

  ipcMain.handle('externalize-icons', (_event, entries: unknown) => {
    if (!Array.isArray(entries)) return { entries: [], changed: false }
    return externalizeIcons(entries)
  })
}
