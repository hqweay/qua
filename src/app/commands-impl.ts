/**
 * `App` 门面的实现（本体能用什么，命令就能用什么）。
 *
 * **为什么拆成几个工厂**：`App` 有二十来个方法，但它们在「改什么」上差异很大——
 * 页的增删改、视图的皮肤与槽、演示与诊断。混在一个对象里，任何改动都要在一个 200 行的
 * 字面量里找位置（原先就是这样）。拆开后每段只认出自己需要的那几项能力。
 *
 * **本文件是转出面**：装配层只认识这一处，各域的实现住在 `commands/` 下、
 * 按「改的是什么」分文件。门面接口（`PageDeps` 等）同样从 `commands/types.ts` 出来。
 *
 * **装配层仍是唯一拼装点**：这些工厂不认识 `ws`／`ed`／`registry` 这些全局身份，
 * 只通过参数拿到「读什么、写什么、刷新什么」。库的唯一持有者始终是装配层（门禁 17）。
 *
 * ⚠️ 纪律：这里**不碰 `document`**（59 ：命令不知道 UI）。要聚焦、要滚动、要弹菜单，
 *   一律走注入的能力。
 */
export { devCommands } from './commands/dev.ts'
export { journalCommands } from './commands/journal.ts'
export { pageCommands } from './commands/page.ts'
export { propsCommands } from './commands/props.ts'
export { makePageBlock, rootsFor, rootsForFeed, rootsForMany, rootsForTarget, takenWhere } from './commands/roots.ts'
export { tagTreeCommands } from './commands/tag-tree.ts'
export { viewCommands } from './commands/view.ts'
export { zoomCommands } from './commands/zoom.ts'
export type { DevDeps, PageDeps, PropsDeps, TagTreeDeps, ViewDeps } from './commands/types.ts'
