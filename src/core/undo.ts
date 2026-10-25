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
  record(before: Snap, kind: UndoKind, at: number): boolean {
    const last = this.past[this.past.length - 1]
    const mergeable =
      last && last.kind === kind && (kind === 'insert' || kind === 'delete') && at - last.at <= this.mergeWindowMs
    this.future = []
    if (mergeable) {
      last.at = at
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
