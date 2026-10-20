import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
  // 固定端口 5180（README 写死的那个）
  server: { port: 5180, strictPort: true },
  preview: { port: 5180, strictPort: true },
})
