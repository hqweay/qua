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
