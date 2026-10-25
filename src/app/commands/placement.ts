/**
 * 命令层的落点入口：**转调 `core/placement.ts`**（判据与实现在那里只有一份）。
 *
 * 为什么还留这一层：命令层拿的是读门面 `KbClient`，而落点的机制不关心「怎么找块」；
 * 把 `kb.get` 收成 `BlockFinder` 再递进去，编辑器（view 层）就能用同一个落点，
 * 不必为了「今天是哪一块」再写一份。
 */
import {
  daySlotInTx as daySlot,
  ensureDayInTx as ensureDay,
  type BlockFinder,
} from '../../core/placement.ts'
import type { KbClient, Tx } from '../../core/kb/types.ts'
import { todayISO } from '../../core/index.ts'

const findIn = (kb: KbClient): BlockFinder => (id) => kb.get(id)

/** 物化某一天（幂等），返回块 id */
export function ensureDayInTx(tx: Tx, kb: KbClient, date: string = todayISO()): string {
  return ensureDay(tx, findIn(kb), date)
}

/** 一个内容块该用的落点：当天 ＋ 末尾 */
export function daySlotInTx(tx: Tx, kb: KbClient): { parentId: string; index: number } {
  return daySlot(tx, findIn(kb))
}
