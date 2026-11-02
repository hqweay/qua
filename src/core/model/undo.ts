/**
 * 撤销栈与命令日志：快照式 undo，外加组合期守卫需要的调用日志。
 */

export interface Snap {
  blocks: string
  sel: string
}

export type UndoKind = 'insert' | 'delete' | 'structural' | 'mark' | 'other'

export class UndoStack {
  private past: { snap: Snap; kind: UndoKind; at: number }[] = []
  private future: Snap[] = []
  /** 连续同类编辑的合并窗口（1200ms） */
  mergeWindowMs = 1200

  depth(): number {
    return this.past.length
  }
  redoDepth(): number {
    return this.future.length
  }
  clear(): void {
    this.past = []
    this.future = []
  }
  /**
   * **这一笔会不会被合并进上一笔**（只对 `insert`／`delete` 在 1200ms 内成立）。
   *
   * 为什么要问：合并时那份快照**根本不会入栈**，取它就是纯浪费 ——
   * 而它是 `JSON.stringify(整片森林)`：实测 50000 块时 10.2ms，
   * 而一次按键的事务本身只要 0.55ms。也就是说**连续打字的每一次按键，
   * 95% 的时间花在一份取完就丢的快照上**。
   *
   * ⇒ 调用方在**改动之前**用 `kind`／`at` 问一句，会合并就跳过取快照。
   */
  willMerge(kind: UndoKind, at: number): boolean {
    const last = this.past[this.past.length - 1]
    return Boolean(last && last.kind === kind && (kind === 'insert' || kind === 'delete') && at - last.at <= this.mergeWindowMs)
  }

  record(before: Snap | null, kind: UndoKind, at: number): boolean {
    const last = this.past[this.past.length - 1]
    const mergeable =
      last && last.kind === kind && (kind === 'insert' || kind === 'delete') && at - last.at <= this.mergeWindowMs
    this.future = []
    if (mergeable || before === null) {
      // 合并进上一笔：`before` 是 `null`（调用方已经问过 `willMerge`，省下了那份快照）
      if (last) last.at = at
      return false
    }
    this.past.push({ snap: before, kind, at })
    if (this.past.length > 500) this.past.shift()
    return true
  }
  undo(current: Snap): Snap | null {
    const e = this.past.pop()
    if (!e) return null
    this.future.push(current)
    return e.snap
  }
  redo(current: Snap): Snap | null {
    const s = this.future.pop()
    if (!s) return null
    this.past.push({ snap: current, kind: 'other', at: Date.now() })
    return s
  }
}

/* -------------------------------------------------- 上下文键与命令守卫 */

export type CtxKeys = Record<string, unknown>

export interface CommandLogEntry {
  name: string
  at: number
}

export class CommandLog {
  entries: CommandLogEntry[] = []
  run(name: string): void {
    this.entries.push({ name, at: Date.now() })
  }
  count(name: string): number {
    return this.entries.filter((e) => e.name === name).length
  }
  reset(): void {
    this.entries = []
  }
}

/** 组合期守卫：`composing` 为真时命令**零触发** */
export function guarded(log: CommandLog, ctx: CtxKeys, name: string): boolean {
  if (ctx.composing) return false
  log.run(name)
  return true
}

/* 假数据统一放在 `seed.ts`：文案门禁的白名单按**文件**划，
   夹具留在 core 里会让「中文只许出现在字典/种子/测试」这条断言失去意义。 */
