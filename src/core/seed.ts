/**
 * 种子 / 夹具的**旧入口**，只剩转发。
 *
 * 实现已按用途拆开：夹具样张在 `fixtures/`，冷启动首屏在 `bootstrap.ts`。
 * 这一层留着是为了不动既有 import（`main.ts`、`commands-impl.ts`、`tests/`）——
 * 下一轮删掉它时，调用方改成直连对应文件即可。
 */
export { parseInline } from './fixtures/inline.ts'
export { seedWorkspace, TASK_TAG_LABEL, TASK_STATUS_LABEL } from './fixtures/seed.ts'
export { degradedWorkspace, emptyWorkspace, sparseWorkspace } from './fixtures/states.ts'
export { fixtureWorkspace } from './fixtures/index.ts'
export { bootWorkspace } from './bootstrap.ts'
