/**
 * **日记流的来源**：一份 QuerySpec 字面量 ＋ 把它翻回块列表的纯路径内核。
 *
 * 日记流不是独立的库读：它是查询视图的**临时实例**——「选哪些天、什么序、取几段」
 * 全部由查询语言表达（role 成员条件 ＋ `_date` 降序 ＋ limit 分页），与查询块共用
 * 同一份评估（`evaluateQuery`）。这里只把这条 spec 与内核收在一处：
 * 冷启动（还没有索引）走纯路径内核，命令层走 `kb.query`（索引路径），等式由测试钉住。
 *
 * ⚠️ 分页＝limit 变宽：降序下「追加」天然等于「把 limit 调大」——
 *    多出来的就是更旧的几天，不需要 offset。
 * ⚠️ 写规则不在这里：物化今天、空天补首子块、`_date` 只读是**装载与写边界**的事
 *    （`journal.ts` 与装载边界）；查询永不写库。
 */
import { FEED_INITIAL } from './journal.ts'
import type { Block } from './model.ts'
import { findById, runQuery, type QuerySpec } from './query.ts'

/** 日记流的来源字面量：`_date` 降序（今日在顶）、只取**存在的**天、首屏 `FEED_INITIAL` 段 */
export const FEED_SPEC: QuerySpec = {
  where: { role: 'journal' },
  scope: 'all',
  sort: [{ by: '_date', dir: 'desc' }],
  limit: FEED_INITIAL,
}

/**
 * spec 求值内核（纯路径）：结果 id 翻回活块，解析不到的跳过。
 *
 * 「不造空天」是这条 spec 的自然结果——没有写过的日期没有块，也就不会命中。
 */
export function feedDays(blocks: readonly Block[], limit: number): Block[] {
  return runQuery({ ...FEED_SPEC, limit }, { blocks, atoms: [] })
    .map((h) => findById(blocks, h.blockId))
    .filter((b): b is Block => b !== undefined)
}
