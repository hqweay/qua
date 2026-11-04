/// <reference types="vite/client" />

/**
 * 「这次构建要不要带测试面」的编译期常量（`vite.config.ts` 的 `define` 注入）。
 *
 * 为什么要一个常量而不是直接读 `import.meta.env.DEV`：验收要跑在**构建产物**上
 * （`dist/` 冒烟、打包冒烟），那里 `DEV` 恒为 false，但断言用的仍是同一批诊断口。
 * 只有显式带 `VITE_QUA_TEST=1` 的构建才把它置真；产品构建（`pnpm build` / `build:mac`）恒假。
 */
declare const __QUA_TEST__: boolean

/**
 * 分词 WASM 的**内联字节**（Vite 的 `?inline` 把文件变成 data URL 字符串）。
 *
 * 类型只在这里声明一次：worker 与将来可能的主线程适配器共用同一个别名，
 * 不各自写一份 `declare module`。
 */
declare module '*.wasm?inline' {
  const dataUrl: string
  export default dataUrl
}
