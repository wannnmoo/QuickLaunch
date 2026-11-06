// 纯函数单测：`node --test devtools/tests/`
//
// 这里只测**不依赖 Electron 运行时**的模块 —— 一旦 import 了 'electron'，
// 在纯 node 下拿到的是路径字符串，测试会以「莫名其妙 undefined」的形式失败。
// 需要真实窗口/进程的验证走 devtools/probe/*.cjs（用 electron.exe 跑）。
//
// node v24 原生支持 .ts 的类型剥离，所以直接 import 源码，不需要预编译。
import test from 'node:test'
import assert from 'node:assert/strict'

import { normPath, fmtFileSize } from '../../src/renderer/src/format.ts'
import { DEFAULT_SETTINGS } from '../../src/shared/types.ts'

test('normPath：去空白、去尾部反斜杠、统一小写', () => {
  assert.equal(normPath('C:\\Users\\Me\\Desktop\\'), 'c:\\users\\me\\desktop')
  assert.equal(normPath('  C:\\Apps  '), 'c:\\apps')
  // 只去掉**尾部**的反斜杠：中间的不能动，否则子路径会被拼坏
  assert.equal(normPath('C:\\a\\b'), 'c:\\a\\b')
  // 盘符根目录的尾斜杠是路径的一部分，但仍按同一个规则归一化（用于比较而非拼路径）
  assert.equal(normPath('D:\\'), 'd:')
  assert.equal(normPath(''), '')
})

test('normPath：大小写与尾斜杠不同的同一路径必须相等（去重靠它）', () => {
  assert.equal(normPath('C:\\Apps\\Tool'), normPath('c:\\apps\\tool\\'))
})

test('fmtFileSize：B/KB/MB/GB 递进与边界', () => {
  assert.equal(fmtFileSize(0), '0 B')
  assert.equal(fmtFileSize(999), '999 B')
  assert.equal(fmtFileSize(1024), '1.0 KB')
  assert.equal(fmtFileSize(1024 * 1024 - 1), '1024.0 KB')
  assert.equal(fmtFileSize(1024 * 1024), '1.0 MB')
  assert.equal(fmtFileSize(1024 * 1024 * 1024 * 2.5), '2.5 GB')
})

test('fmtFileSize：负数与非法值不产出「NaN GB」', () => {
  assert.equal(fmtFileSize(-1), '')
  assert.equal(fmtFileSize(Number.NaN), '')
})

test('DEFAULT_SETTINGS：关键字段的默认值与类型是稳定的', () => {
  // 这些值是 UI 初始状态与「字段坏掉时回退值」的共同来源，改动会同时影响
  // 首帧布局与设置面板的选中态，所以要显式钉住。
  assert.equal(DEFAULT_SETTINGS.theme, 'dark')
  assert.equal(DEFAULT_SETTINGS.dockEdge, 'middle')
  assert.equal(DEFAULT_SETTINGS.iconSize, 60)
  assert.equal(DEFAULT_SETTINGS.magnify, 1.4)
  assert.equal(DEFAULT_SETTINGS.glassBlur, 36)
  assert.equal(DEFAULT_SETTINGS.glassSaturate, 1.7)
  assert.equal(DEFAULT_SETTINGS.folderCardDelay, 300)
  assert.equal(DEFAULT_SETTINGS.panelCloseDelay, 180)
  assert.equal(DEFAULT_SETTINGS.afterLaunch, 'hide')
  assert.equal(DEFAULT_SETTINGS.probeBeforeLaunch, false)
  assert.equal(DEFAULT_SETTINGS.searchEnabled, true)
  assert.equal(DEFAULT_SETTINGS.followSystemTheme, false)
})

test('DEFAULT_SETTINGS：iconSize 必须是 Dock 几何公式认识的三个档位', () => {
  // App.css 的 --dock-pad = iconSize + 22、玻璃条高 = pad + iconSize + 16
  // 都按 48/60/72 算过窗口高度余量（300px 里最大 182+... 仍放得下）
  assert.ok([48, 60, 72].includes(DEFAULT_SETTINGS.iconSize))
})
