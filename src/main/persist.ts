/**
 * 落盘工具：原子写。
 *
 * 直接 writeFileSync 在「写了一半」时（崩溃 / 断电 / 杀进程）会留下截断的 JSON，
 * 而 load 侧解析失败会退化成空数组 —— 用户全部快捷方式一次性消失且不可恢复。
 * 同卷 rename 是原子替换：读者要么看到旧内容、要么看到新内容，不会看到半截。
 * 旧文件只有在能解析成合法 JSON 时才备份，避免拿损坏内容盖掉上一次的好备份。
 *
 * 失败时清掉临时文件并把异常抛给调用方（save-shortcuts / set-settings 都需要
 * 把失败如实返回给上层，而不是假装成功）。
 */

import { closeSync, copyFileSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'fs'

export function writeFileAtomic(targetPath: string, text: string): void {
  const tmpPath = `${targetPath}.tmp-${process.pid}`
  let fd: number | null = null
  try {
    fd = openSync(tmpPath, 'w')
    const buf = Buffer.from(text, 'utf-8')
    let offset = 0
    while (offset < buf.length) {
      offset += writeSync(fd, buf, offset, buf.length - offset)
    }
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    try {
      if (existsSync(targetPath)) {
        JSON.parse(readFileSync(targetPath, 'utf-8')) // 只为判断旧文件是否值得备份
        copyFileSync(targetPath, `${targetPath}.bak`)
      }
    } catch {
      // 旧文件本身已损坏（或备份失败）：跳过备份，直接用新内容覆盖
    }
    renameSync(tmpPath, targetPath)
  } catch (err) {
    if (fd !== null) { try { closeSync(fd) } catch {} }
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath) } catch {}
    throw err
  }
}
