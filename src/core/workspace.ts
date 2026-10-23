/**
 * 本地持久化的**导出面**（老路径不变：`import { ... } from './workspace.ts'`）。
 *
 * 实现已经按「一个文件一件事」拆到 `storage/` 下的 StoragePort）：
 *
 * | 想找什么 | 去哪 |
 * |---|---|
 * | 「页」是什么（`_lists` 里有 `page` 的块） | **本文件**（模型概念，不是存储） |
 * | 库里存什么、版本号、深度校验 | `storage/shape.ts` |
 * | 偏好、默认值、形状兜底 | `storage/prefs.ts` |
 * | 异步 ＋ 批次的存储契约 | `storage/port.ts` |
 * | 字节的进与出（当前 `localStorage`） | `storage/local-storage.ts` |
 * | 上层拿到的那个对象 | `storage/index.ts`（`createWorkspaceStore`） |
 *
 * 上层**不该**再 import `localStorage`、也不该假定「写库是一次同步调用」。
 */
import type { Block } from './model.ts'

export { DEFAULT_DOCK, DEFAULT_PREFS, normalizePrefs } from './storage/prefs.ts'
export type { DockPrefs, DockSlotPrefs, Prefs, ThemeMode } from './storage/prefs.ts'
export { pageDoc, parseWorkspace, WORKSPACE_VERSION } from './storage/shape.ts'
export type { ParseResult, Workspace } from './storage/shape.ts'
export { createWorkspaceStore, judge, WHOLE_LIBRARY_CHANGES } from './storage/index.ts'
export type { LoadedWorkspace, WorkspaceStore } from './storage/index.ts'
export type { Change, ChangeKind, CommitBatch, LoadResult, SaveResult, StoragePort } from './storage/port.ts'
export { createLocalStorageAdapter } from './storage/local-storage.ts'

/**
 * ⚠️ **不可逆项**：这个键名一旦改，用户已存的库就静默消失
 * （`arch-check` 的 `key` 条会逐字比较它）。
 *
 * 键名是**公开的固定值**，不含任何机器私有标识；原型期用过的旧键不迁移（本仓不做兼容），
 * 删掉 `.cache/` 里的旧 profile 重 seed 即可。
 */
export const STORAGE_KEY = 'qua.workspace'

/**
 * 页 ＝ **`_lists` 里有 `page` 的块**。
 *
 * ⚠️ 这里**没有** `title`／`icon`／`roots` 三个字段（2026-10-19 一步到位）：
 *   · 页名 ＝ 该块的主别名（`_aliases[0]`）；正文是描述
 *   · 图标 ＝ 属性 `_icon`（38 ，系统属性带 `_` 前缀）
 *   · 子块 ＝ 块的 `children`（层级就是真实父子，承 15 E1）
 *
 * 「页」不再是独立实体，只是**块森林里的一个块 + 一个露面**（承 1／5：没有页实体）。
 *
 * ⚠️ 形状上它与普通块**没有区别**（页是 `props._lists` 里的一个值，不是独立字段），
 *    这个别名只用来给「这里必须是页」的那些位置一个可读的类型名。
 */
export type PageBlock = Block
