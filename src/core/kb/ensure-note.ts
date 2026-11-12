/**
 * 备注块的**事务内**创建：块与指向槽一次落定，写路径全部走 `Tx`。
 *
 * 与 `ensureTagInTx` 不同，备注没有「找到或创建」的语义——每条备注都是新块，
 * 两条备注评论同一段是两个身份，不是同一条。这里单独存在一个文件的理由与
 * ensure-tag 同一条：建块必须进事务，否则「宿主加上了锚、备注块却不在」的半批
 * 会静默落盘（正文进事务、备注块留在事务外）。
 *
 * ⚠️ 身份块住森林顶层：位置对身份不承载信息，树操作会把住在子树里的备注当货物搬走
 *    （所有读路径都按 id 找它，与 tag/schema/journal 同一条纪律）。
 */
import { uuidv7Hex } from '../model/ids.ts'
import { ANNOTATES_PROP, NOTE_TYPE, isAnnotatesPairs, type NotePair } from '../relations/annotates.ts'
import type { Block } from '../model/model.ts'
import type { Tx } from './types.ts'

/** 一条备注块的内存形状（不落盘、不进 op——进 op 的只有 `tx.insert` 产的 `block.upsert`） */
export function mkNoteBlock(pairs: readonly NotePair[]): Block {
  const now = Date.now()
  return {
    id: uuidv7Hex(),
    content: [], // 正文是用户接下来写的评论；指向在槽里，不是正文
    children: [],
    created: now,
    modified: now,
    props: { _type: NOTE_TYPE, [ANNOTATES_PROP]: pairs.map((p) => ({ ...p })) },
  }
}

/**
 * 创建一条备注块，写路径全部走 `tx`（插在森林顶层末尾）。
 *
 * @param roots 森林顶层（新备注块插在它末尾——位置不承载信息，只求不穿插在现有根之间）
 * @throws `pairs` 为空或形状非法 —— 一条不知道自己标哪的备注就是块级退化态，
 *          当场抛、整笔事务回滚，坏形状进不了内存更进不了日志。
 */
export function ensureNoteInTx(roots: readonly Block[], pairs: readonly NotePair[], tx: Tx): Block {
  if (!isAnnotatesPairs(pairs)) throw new Error('note needs at least one valid (block, anno) pair')
  const block = mkNoteBlock(pairs)
  tx.insert(block, null, roots.length)
  return block
}
