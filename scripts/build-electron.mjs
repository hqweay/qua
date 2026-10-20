/**
 * 把 `electron/*.ts` 打成 Electron 能直接跑的 CJS（`dist-electron/*.cjs`）。
 *
 * 为什么是 CJS：`package.json` 里是 `"type": "module"`，而 Electron 的 **preload 在
 * `sandbox: true` 下必须是 CJS**（`.cjs` 后缀是最省事的确定性写法）。主进程跟着一起走 CJS，
 * 免得出现「一个 ESM 一个 CJS」的双份心智负担。
 *
 * ⚠️ `electron` 必须 external —— 它不是要打包进 bundle 的库，是运行时本体。
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22', // Electron 44 的内置 Node
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
  outdir: `${root}dist-electron`,
  outExtension: { '.js': '.cjs' },
}

const entries = [`${root}electron/main.ts`, `${root}electron/preload.ts`]

if (watch) {
  const { context } = await import('esbuild')
  const ctx = await context({ ...common, entryPoints: entries })
  await ctx.watch()
  console.log('[build:electron] watching electron/*.ts（改了要手动重启 electron）')
} else {
  await build({ ...common, entryPoints: entries })
}
