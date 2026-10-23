/// <reference types="vite/client" />

/**
 * 「这次构建要不要带测试面」的编译期常量（`vite.config.ts` 的 `define` 注入）。
 *
 * 为什么要一个常量而不是直接读 `import.meta.env.DEV`：验收要跑在**构建产物**上
 * （`dist/` 冒烟、打包冒烟），那里 `DEV` 恒为 false，但断言用的仍是同一批诊断口。
 * 只有显式带 `VITE_QUA_TEST=1` 的构建才把它置真；产品构建（`pnpm build` / `build:mac`）恒假。
 */
declare const __QUA_TEST__: boolean
