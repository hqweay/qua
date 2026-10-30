/**
 * **obj 记录**：一个标签的「一次出现」。
 *
 * 判据：记录**不是新块种类**，是一条普通的**内容块**，靠 `props._tags` 归属在某个标签下
 * （归属住在属性袋里，不是块上的又一个顶层字段——理由见 `model.ts` 的 `listsOf`）。
 * 于是它自动获得三件已有能力：
 *   · 标签字段（声明在标签块上）直接可填；
 *   · 查询 `{tag}`／`{prop}` 直接够得到；
 *   · 标签页的成员列表直接包含它（成员＝带这条归属的块）。
 *
 * 与「块标签 chip」的分工：chip 是「这块**归类**到某标签」，记录是「某标签**的一次出现**」。
 * 两者在数据上是同一件事（`props._tags`），差别只在怎么诞生；行内 `#名` 的引用 run 指向记录，
 * 它只是一次提及，**不写** `_tags`（见 `core/tags.ts` 文件头）⇒ 删掉正文里那一枚只摘引用，**不删记录**。
 *
 * ⚠️ 记录**没有地址**（v1）：正文是描述，不写 `_aliases`。地址意味着「可被 `[[ ]]` 按名找」，
 *    而记录的身份由「哪条引用指向它」给出；要提名/升格成页是另一个动词。
 * ⚠️ 记录**落在森林顶层**（与页块、标签块同一条口径）：
 *    v1 曾落在当天（「位置是真实信息：这件事发生在哪天」），被推翻——出生时刻已经由块上的
 *    `created` 记着，位置只是同一件事的第二份答案，还会让记录跟着某一天被搬、被折叠，
 *    并逼着每条记录先物化一天。顶层位置对记录不承载信息，读路径一律按 id／`_tags` 找它。
 */
import { mkBlock, type Block } from './model.ts'
import { TAGS_PROP } from './tags.ts'
import type { Tx } from './kb/types.ts'

/** 造一条记录（还没进树）：正文＝键入名（作描述），归属＝这个标签 */
export function mkObjRecord(name: string, tagId: string): Block {
  return mkBlock(name.trim(), { props: { [TAGS_PROP]: [tagId] } })
}

/** 事务内物化一条记录：落进森林顶层，返回它（调用方拿 id 插引用 run） */
export function createObjRecordInTx(
  tx: Tx,
  roots: readonly Block[],
  name: string,
  tagId: string,
): Block {
  const record = mkObjRecord(name, tagId)
  tx.insert(record, null, roots.length)
  return record
}

/** 无事务入口时的兜底：只给「没有 tx 的视图」用，正常写路径一律走 `createObjRecordInTx` */
export function createObjRecordDirect(forest: Block[], name: string, tagId: string): Block {
  const record = mkObjRecord(name, tagId)
  forest.push(record)
  return record
}
