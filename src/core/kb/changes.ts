/**
 * **一批 op ⇒ 这批 op 让哪几类对象失效。**
 *
 * 这是 `Change` 的**唯一来源**：`apply` 知道每一格，所以它不必再靠调用方另外宣布一次
 * （曾经有 `ChangeSink` 与 `changesOf` 两份，前者在 tx 里手写、后者在落盘层从 op 推导 ——
 * 两份能不一致，而「通知漏了一条」在界面上只是偶尔少刷新一行）。
 *
 * 本文件零 DOM、零存储、零模型：只做 op 形状的投影。
 */
import type { Change, ChangeKind, Op } from './types.ts'

export function changesOf(ops: readonly Op[]): Change[] {
  const out: Change[] = []
  const seen = new Set<string>()
  const add = (kind: ChangeKind, id: string): void => {
    const key = `${kind}\u0000${id}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ kind, id })
  }
  for (const o of ops) {
    if (o.e === 'anno') {
      add('annos', o.block)
      continue
    }
    add('blocks', o.e === 'block' ? o.id : o.block)
  }
  return out
}

/** 这次动过的块 id（订阅者按 id 做增量重画；同 id 只报一次） */
export function idsOf(ops: readonly Op[]): string[] {
  return [...new Set(changesOf(ops).map((c) => c.id))]
}

/**
 * 这批 op 里有没有**结构变化**（树长什么样变了），还是只有格子值（正文/属性）。
 *
 * 为什么视图需要这一位：正文改动可以「按 id 局部替换那一行」，而树变了
 * （插入/移动/删块）之后，行集合本身变了——只换已有行挂不上新行。
 * 文本编辑是高频的（每个键），结构编辑是低频的（一次回车/一次拖拽）；
 * 高频路径必须便宜、低频路径可以整页重画 ⇒ 两类要能分开判，判据只能从 op 形状来
 * （调用方各自宣布「这是结构变化」就会有两份答案）。
 *
 * 判据（与 `BlockPatch` 的格一一对应）：
 *   · `block.upsert{content|modified}` ＝ 打字/格式/时刻 ⇒ **不是**；
 *   · `block.upsert{parent|prev|created}` ＝ 插入/移动（created 只在 genesis 出现）⇒ 是；
 *   · `block.exist` ＝ 软删/恢复/清除 ⇒ 是（可见块集合变了）；
 *   · `prop`／`anno` ＝ 属性与区间 ⇒ 不是。
 */
export function structuralOf(ops: readonly Op[]): boolean {
  return ops.some(
    (o) =>
      o.e === 'block' &&
      (o.op === 'exist' || o.value.parent !== undefined || o.value.prev !== undefined || o.value.created !== undefined),
  )
}
