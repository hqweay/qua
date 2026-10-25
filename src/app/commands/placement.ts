/**
 * **落点**：内容创建时「落在哪」。
 *
 * 判据：任何**内容**（页块、obj 记录）诞生于**某一天**——位置是真实信息
 * （喝咖啡发生在 10-24），「从天里长出页」是默认路径，不是特例。
 *
 * 与「身份」的落点是两件事，**别混**：
 *   · **内容**（页 / 记录）⇒ 落进当天（本文件）；
 *   · **身份**（tag / schema / journal）⇒ 物化在森林顶层（系统架，不进时间线叙事）。
 * 身份块落顶层不是因为「顶层更高级」，而是因为它**不参与组织**：所有读路径都按 id 找它，
 * 位置对它不承载任何信息。
 *
 * ⚠️ 为什么单独一层：落点口径一旦散在 `newPage`、`ensureTag`、记录物化几处，
 *    就会出现「同一个问题几个答案」——而这几个答案平时看不出差别，只在用户整理某一天时
 *    才显形（页跟着那一天被删掉）。这里只回答一个问题：**这个新块该放进哪**。
 *
 * ⚠️ **只接受事务**：落位几乎总是要和别的东西同笔（页块与它的空首子块、记录与它的归属），
 *    所以这里不自己开事务——`tx` 由调用方给，物化当天与插入内容落在同一笔里。
 */
import { journalId, mkJournalBlock, todayISO } from '../../core/index.ts'
import type { KbClient } from '../../core/kb/types.ts'
import type { Tx } from '../../core/kb/types.ts'

/**
 * 物化某一天，返回它的块 id（**幂等**）。
 *
 * id 由 `(本地日)` 确定性派生 ⇒ 「一天一个」是结构保证，不靠扫描去重。
 * 已经存在就什么都不写（零 op）——「打开 / 落笔」是高频动作，不该每次顺手写库。
 */
export function ensureDayInTx(tx: Tx, kb: KbClient, date: string): string {
  const id = journalId(date)
  if (!kb.get(id)) tx.insert(mkJournalBlock(date), null, 0)
  return id
}

/**
 * 一个**内容**块该用的落点：`parent` ＝ 当天、`index` ＝ 当天子块末尾。
 *
 * 当天不存在时**在同一笔事务里**物化它——两件事分开写就会留下
 * 「内容建好了、却挂在一棵还没建的天上」的半截状态。
 */
export function daySlotInTx(tx: Tx, kb: KbClient): { parentId: string; index: number } {
  const parentId = ensureDayInTx(tx, kb, todayISO())
  const day = kb.get(parentId)
  return { parentId, index: day?.children.length ?? 0 }
}
