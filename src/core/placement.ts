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
 * ⚠️ **这一层住在 core，不住 app**：落点有两个消费者——命令层（新建页）与编辑器
 *    （`#` 面板里实例化一条记录）。后者在 view 层，不能反向 import app；
 *    而落点口径一旦各写一份，就会在「用户整理某一天」时显出两个答案。
 *
 * ⚠️ **只接受事务**：落位几乎总是要和别的东西同笔（页块与它的空首子块、记录与它的归属），
 *    所以这里不自己开事务——`tx` 由调用方给，物化当天与插入内容落在同一笔里。
 */
import { findJournalDay, journalId, mkJournalBlock, todayISO } from './journal.ts'
import type { Tx } from './kb/types.ts'
import type { Block } from './model.ts'

/** 按 id 找块（事务内读的是**活块**：`tx.insert` 之后立刻就能找到） */
export type BlockFinder = (id: string) => Block | undefined

/**
 * 物化某一天，返回它的块 id（**幂等**）。
 *
 * id 由 `(本地日)` 确定性派生 ⇒ 「一天一个」是结构保证，不靠扫描去重。
 * 已经存在就什么都不写（零 op）——「打开 / 落笔」是高频动作，不该每次顺手写库。
 */
export function ensureDayInTx(tx: Tx, find: BlockFinder, date: string = todayISO()): string {
  const id = journalId(date)
  if (!find(id)) tx.insert(mkJournalBlock(date), null, 0)
  return id
}

/**
 * 一个**内容**块该用的落点：`parent` ＝ 当天、`index` ＝ 当天子块末尾。
 *
 * 当天不存在时**在同一笔事务里**物化它——两件事分开写就会留下
 * 「内容建好了、却挂在一棵还没建的天上」的半截状态。
 */
export function daySlotInTx(
  tx: Tx,
  find: BlockFinder,
  now: Date = new Date(),
): { parentId: string; index: number } {
  const parentId = ensureDayInTx(tx, find, todayISO(now))
  const day = find(parentId)
  return { parentId, index: day?.children.length ?? 0 }
}

/**
 * 不带事务的落点（只给「没有事务入口的视图」兜底，正常写路径一律走 `tx`）。
 *
 * 与事务版**共用同一个日期口径与同一个 journal 构造**：这里若自己拼一个
 * 「今天在哪」，月份/时区/一天一个的判据就会长出第二份。
 */
export function insertInDayDirect(forest: Block[], block: Block, now: Date = new Date()): string {
  const date = todayISO(now)
  let day = findJournalDay(forest, date)
  if (!day) {
    day = mkJournalBlock(date)
    forest.unshift(day)
  }
  day.children.push(block)
  return day.id
}
