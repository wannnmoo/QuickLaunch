import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// ⚠️ 只有**一个** HTML 入口（index.html）。设置中心不是第二个页面，而是同一入口的
// `?view=settings` 视图 —— 原因见 src/renderer/src/main.tsx 顶部注释：
// electron-vite 5.0.0 的 renderer 预设会把 `build.rollupOptions.input` 覆盖回单个
// index.html 字符串（预设是通过 `enforce: 'pre'` 插件写入的，配置文件与普通插件都输给它），
// 多页面入口实测无法生效，产物里永远只有 index.html。
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ include: ['electron'] })]
  },
  preload: {
    plugins: [externalizeDepsPlugin({ include: ['electron'] })]
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
