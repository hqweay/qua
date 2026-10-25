/**
 * **obj 记录**：一个标签的「一次出现」。
 *
 * 判据：记录**不是新块种类**，是一条普通的**内容块**，靠 `_tags` 归属在某个标签下
 * （`_tags` 是归属，不是角色）。于是它自动获得三件已有能力：
 *   · 标签字段（声明在标签块上）直接可填；
 *   · 查询 `{tag}`／`{prop}` 直接够得到；
 *   · 标签页的成员列表直接包含它（成员＝带这条归属的块）。
 *
 * 与「块标签 chip」的分工：chip 是「这块**归类**到某标签」，记录是「某标签**的一次出现**」。
 * 行内 `#名` 的引用 run 指向记录；删掉正文里那一枚只摘引用，**不删记录**。
 *
 * ⚠️ 记录**没有地址**（v1）：正文是描述，不写 `_aliases`。地址意味着「可被 `[[ ]]` 按名找」，
 *    而记录的身份由「哪条引用指向它」给出；要提名/升格成页是另一个动词。
 * ⚠️ 记录**落在当天**（与页块同一条落点口径，见 `core/placement.ts`）：
 *    位置是真实信息（这件事发生在哪天），归类由 `_tags` 表达。
 */
import { mkBlock, type Block } from './model.ts'
import { TAGS_PROP } from './tags.ts'
import { daySlotInTx, insertInDayDirect, type BlockFinder } from './placement.ts'
import type { Tx } from './kb/types.ts'

/** 造一条记录（还没进树）：正文＝键入名（作描述），归属＝这个标签 */
export function mkObjRecord(name: string, tagId: string): Block {
  return mkBlock(name.trim(), { props: { [TAGS_PROP]: [tagId] } })
}

/** 事务内物化一条记录：落进当天，返回它（调用方拿 id 插引用 run） */
export function createObjRecordInTx(
  tx: Tx,
  find: BlockFinder,
  name: string,
  tagId: string,
  now: Date = new Date(),
): Block {
  const record = mkObjRecord(name, tagId)
  const slot = daySlotInTx(tx, find, now)
  tx.insert(record, slot.parentId, slot.index)
  return record
}

/** 无事务入口时的兜底：只给「没有 tx 的视图」用，正常写路径一律走 `createObjRecordInTx` */
export function createObjRecordDirect(
  forest: Block[],
  name: string,
  tagId: string,
  now: Date = new Date(),
): Block {
  const record = mkObjRecord(name, tagId)
  insertInDayDirect(forest, record, now)
  return record
}
