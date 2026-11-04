import { readFile } from 'node:fs/promises'
import { defineConfig, type Plugin } from 'vite'

/**
 * `.wasm?inline` → data URL 字符串。
 *
 * Vite 的 `?inline` 只对 CSS 等已知资源生效；WASM 会被当成 JS 去解析（二进制当场报错）。
 * 分词 WASM 必须内联：桌面端页面是 `file://`，Chromium 不允许 `fetch(file://…)`，
 * 而 `new URL(..., import.meta.url)` 在打包后会变成一个 fetch 不到的本地路径。
 */
function inlineWasm(): Plugin {
  return {
    name: 'qua-inline-wasm',
    enforce: 'pre',
    async load(id) {
      if (!id.endsWith('.wasm?inline')) return null
      const file = id.slice(0, -'?inline'.length)
      const buf = await readFile(file)
      return `export default ${JSON.stringify(`data:application/wasm;base64,${buf.toString('base64')}`)}`
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [inlineWasm()],
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
  /**
   * 构建期常量：`true` ⇒ 带测试面（夹具命令 ＋ `window.__qua`）。
   *
   * 为什么不在运行期判 `import.meta.env.DEV`：验收跑在**构建产物**上，那里它恒为 false。
   * 反过来，产品构建不带这个 flag ⇒ 整个测试面在打包时就没了，不是「藏起来」而是不存在。
   */
  define: { __QUA_TEST__: JSON.stringify(process.env.VITE_QUA_TEST === '1') },
  /**
   * `jieba-wasm` 的 web 构建用 `new URL('…wasm', import.meta.url)` 延迟取 wasm。
   * dev 预打包会把这个相对 URL 改写掉，所以显式排除；worker 里用 `?inline` 直接
   * 取 wasm 字节（桌面端 `file://` 下不能 fetch 本地文件）。
   */
  optimizeDeps: { exclude: ['jieba-wasm'] },
  /**
   * worker 有自己的一份插件容器（Vite 6）；`?inline` 的 WASM 必须在**那一份**里也登记，
   * 否则 rollup 会把二进制当 JS 解析。
   */
  worker: { plugins: () => [inlineWasm()] },
  // 固定端口 5180（README 写死的那个）
  server: { port: 5180, strictPort: true },
  preview: { port: 5180, strictPort: true },
})
