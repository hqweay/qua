/**
 * **条件 → 候选 id 超集**：只回答「哪些块**可能**命中」，不回答「命中了没有」。
 *
 * 判据只有一条：返回的集合必须 ⊇ 真正命中的块，否则候选迭代会静默丢行。
 * 不知道就返回 `undefined`（整次回退全林）——**绝不用空集表示「不支持」**：
 * 空集是一条合法答案（「这块条件不可能命中」），拿它冒充「不知道」会把整批结果吞掉。
 *
 * ⚠️ **标签并集的地雷**：当前 matcher 对任何 `{tag}` 节点都只问环境里的**全局并集**
 *    （条件树里出现的所有标签节点的成员并集），不是这个节点自己的成员。所以
 *    `all:[{tag:A},{tag:B}]` 实际命中 A∪B，候选也只能给 A∪B。等 matcher 改成逐节点
 *    判定时，这里要同步改成「各取自己的成员」——两处必须一起改，否则交集会悄悄丢行。
 * ⚠️ 方向原子／`children`／`text`／`mark`／`link`／`prop` 都不产出候选（形状本身要整林）。
 *    `not` 永不收窄（否定条件的补集不是候选）。
 */
import { refKindsOf, refTargetOf, type QueryNode } from './query.ts'
import type { RefKind } from '../relations/relations.ts'

/**
 * 抽取要用到的读数（由索引侧注入；本文件不 import Index，保持 query 层零 infra）。
 * 都是「候选的超集」，不是「精确命中」。
 */
export interface CandidateTables {
  /**
   * **整份 where 的标签成员并集**。当前 matcher 的 `{tag}` 判定读的就是这一份
   * （见文件头的地雷）；`where` 里没有标签节点时可以是空集。
   */
  tagUnion(): Iterable<string>
  /** 指向 `targetId`、kind 在 `kinds` 里的来源块 */
  refSources(targetId: string, kinds: readonly RefKind[]): Iterable<string>
  /** 全部页块 id */
  pages(): Iterable<string>
  /** 全部标签块 id（有 `tag` 露面） */
  tags(): Iterable<string>
  /** 全部日记块 id（**不去重**；组合里的 `{role:'journal'}` 是普通谓词） */
  journals(): Iterable<string>
}

/**
 * 候选超集；`undefined` ＝ 这份条件不由候选路径回答（回退全林）。
 *
 * 组合规则：
 *   · `all`：取**可枚举子条件**的交集（每个都是必要条件，交集仍是超集）；
 *     一个都不可枚举 ⇒ `undefined`；`all:[]` 恒真 ⇒ `undefined`。
 *   · `any`：**全部分支**可枚举才取并集，否则 `undefined`；`any:[]` 恒假 ⇒ 空集。
 *   · `not`：永不收窄。
 */
export function candidateIdsOf(node: QueryNode, tables: CandidateTables): ReadonlySet<string> | undefined {
  if ('all' in node) {
    const sets: Set<string>[] = []
    for (const child of node.all) {
      const s = candidateIdsOf(child, tables)
      if (s !== undefined) sets.push(new Set(s))
    }
    if (sets.length === 0) return undefined
    // 先拿最小的开刀：交集只可能更小
    sets.sort((a, b) => a.size - b.size)
    const out = new Set(sets[0])
    for (const s of sets.slice(1)) {
      for (const id of out) if (!s.has(id)) out.delete(id)
    }
    return out
  }
  if ('any' in node) {
    if (node.any.length === 0) return new Set()
    const out = new Set<string>()
    for (const child of node.any) {
      const s = candidateIdsOf(child, tables)
      if (s === undefined) return undefined
      for (const id of s) out.add(id)
    }
    return out
  }
  if ('not' in node) return undefined
  /**
   * 标签：给**全局并集**（不是这个节点的成员）。见文件头的地雷——这是当前 matcher
   * 的真实语义，不是实现偷懒。
   */
  if ('tag' in node) return new Set(tables.tagUnion())
  if ('is' in node) return new Set([node.is])
  if ('role' in node) {
    if (node.role === 'page') return new Set(tables.pages())
    if (node.role === 'tag') return new Set(tables.tags())
    // 组合里的日记：全部日记块（不去重）；顶层精确日记由调用方换成「一天一个」
    if (node.role === 'journal') return new Set(tables.journals())
    return undefined // note：没有列表
  }
  if ('ref' in node) {
    const to = refTargetOf(node.ref)
    // 不限目标 = 「发过引用边」：要枚举整张出向表，收益低（第一刀回退）
    if (to === undefined) return undefined
    return new Set(tables.refSources(to, refKindsOf(node.ref)))
  }
  return undefined
}
