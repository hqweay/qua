import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
  /**
   * 构建期常量：`true` ⇒ 带测试面（夹具命令 ＋ `window.__qua`）。
   *
   * 为什么不在运行期判 `import.meta.env.DEV`：验收跑在**构建产物**上，那里它恒为 false。
   * 反过来，产品构建不带这个 flag ⇒ 整个测试面在打包时就没了，不是「藏起来」而是不存在。
   */
  define: { __QUA_TEST__: JSON.stringify(process.env.VITE_QUA_TEST === '1') },
  // 固定端口 5180（README 写死的那个）
  server: { port: 5180, strictPort: true },
  preview: { port: 5180, strictPort: true },
})
