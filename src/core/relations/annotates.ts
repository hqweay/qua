/**
 * **备注边**：块之间「谁在评论谁的一段字」。
 *
 * 备注不是一个实体，是「块」的另一种用法（`_type: 'core/note'`）：它自己住森林顶层
 * （身份不占位置，与 tag/journal 同纪律），身上带 `_annotates` 槽回答「我评论谁的哪一段」。
 * 每对 `{block, anno}` 指向宿主块上的一枚区间锚（anno 住**宿主块**上——维护点在被编辑的
 * 那一块自己身上，一条与十条备注的成本相同；住备注块上就要扫全库找「谁备注我」）。
 * 边在这里派生：槽是唯一真相，边不落盘。
 *
 * 为什么指向是槽不是内容 ref run：指向是**元数据**不是正文——用户写的是评论，
 * 「评论附在哪段」不是他打的字。放进正文既会混进他写的内容，也会被拆块／合并
 * 当货物搬走、被清除格式顺手清掉。
 */
import { blockTypeOf, type Block } from '../model/model.ts'

/** 备注块的类型 id（类型声明表与建块共用这一份） */
export const NOTE_TYPE = 'core/note'

/** 备注块身上的系统槽：这一条备注标了哪些（宿主块，区间锚）对 */
export const ANNOTATES_PROP = '_annotates'

/** 一对指向：`block` ＝ 宿主块 id；`anno` ＝ 宿主 `annos` 里那枚区间锚的 id */
export interface NotePair {
  block: string
  anno: string
}

/**
 * `_annotates` 的形状判据（op 产出／op 收端／落盘校验共用同一份）：
 * 非空数组，每对两个非空字符串键，且对不重复（重复对没有第二个答案）。
 *
 * **空数组不合法**——「零锚的备注」就是块级退化态（一条备注不知道自己标哪，
 * 每个读点都要分支）。要摘就 `clearProp` 整格摘掉，不留空壳。
 */
export function isAnnotatesPairs(v: unknown): v is NotePair[] {
  if (!Array.isArray(v) || v.length === 0) return false
  const seen = new Set<string>()
  for (const x of v) {
    const p = x as Partial<NotePair> | null
    if (typeof p?.block !== 'string' || p.block === '') return false
    if (typeof p?.anno !== 'string' || p.anno === '') return false
    const key = `${p.block}\u0001${p.anno}`
    if (seen.has(key)) return false
    seen.add(key)
  }
  return true
}

/**
 * 备注标了哪些（宿主块，区间锚）对。
 *
 * ⚠️ **不校验存活**——ref 是事实，解析是读的事（与 `_belongsTo` 的 `parentIdsOf`
 *    同一条纪律）：宿主被删时槽里的 id 留着（悬空可见），读侧按 `resolveRef`
 *    的口径照实显示，不在形状判据里追溯清理。
 */
export function annotatesPairsOf(b: Block): NotePair[] {
  const raw = b.props?.[ANNOTATES_PROP]
  if (!isAnnotatesPairs(raw)) return []
  return raw.map((x) => ({ block: x.block, anno: x.anno }))
}

/** 是不是备注块（读 `_type`，与 `blockTypeOf` 同一条判据——没有第二份答案） */
export function isNoteBlock(b: Block): boolean {
  return blockTypeOf(b) === NOTE_TYPE
}
