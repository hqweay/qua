/**
 * 撤销栈与命令日志：**条目式 undo**（两侧状态 ＋ 选区），外加组合期守卫需要的调用日志。
 *
 * 条目里只有「这次事务动过的块」的前态／后态（见 `kb/scoped.ts`），不再有整片森林。
 * 撤销/重做只是把条目从一边搬到另一边：**两侧都在条目里**，所以搬家时不需要
 * 现取一份「现在」的快照 —— 那正是旧实现每次 ⌘Z 都要付的第二笔整库序列化。
 */
import type { Sel } from './selection.ts'
import type { UndoCapture } from '../kb/scoped.ts'
import { mergeStates } from '../kb/scoped.ts'

export type UndoKind = 'insert' | 'delete' | 'structural' | 'mark' | 'other'

/**
 * 撤销栈里的条目：一次事务（或一次合并在同一窗口里的连续编辑）的**两侧状态**。
 *
 * 为什么两侧都存：撤销要回到 `before`、重做要回到 `after`。只存一侧就得在撤销时
 * 现取一次「现在」的快照——那正是要消掉的那笔 O(整库)。
 * 条目里**没有整片森林**：只有这次动过的块（id ＋ 深拷的格 ＋ 落点）。
 *
 * `sel` 是**改动之前**的选区（撤销后回到这里）；`kind`／`at` 只服务合并窗口。
 */
export interface UndoEntry extends UndoCapture {
  sel: Sel | null
  kind: UndoKind
  at: number
  /**
   * **撤销那一刻**的选区（不是「改动之后」）：重做回到这里。
   *
   * 旧实现把这个值存在 `future` 栈的那份整库快照里；现在它只是一格，跟条目一起走。
   */
  redoSel?: Sel | null
}

export class UndoStack {
  private past: UndoEntry[] = []
  private future: UndoEntry[] = []
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
   * 记一笔（`capture === null` ＝ 这次动作没有开过事务：不新建条目）。
   *
   * **合并窗口**只对 `insert`／`delete` 在 1200ms 内成立（连续打字/连删算一步）。
   * 合并时**不新建条目**：`before` 保留第一次（撤销要回到开始打字之前），
   * `after` 用最后一次（重做要回到停手那一刻）；`sel` 也保留第一次。
   */
  record(capture: UndoCapture | null, sel: Sel | null, kind: UndoKind, at: number): boolean {
    const last = this.past[this.past.length - 1]
    const mergeable =
      last !== undefined &&
      last.kind === kind &&
      (kind === 'insert' || kind === 'delete') &&
      at - last.at <= this.mergeWindowMs
    this.future = []
    if (capture === null) return false
    if (mergeable && last) {
      last.before = mergeStates(last.before, capture.before, 'first')
      last.after = mergeStates(last.after, capture.after, 'last')
      last.directEdit = last.directEdit || capture.directEdit
      last.at = at
      return false
    }
    this.past.push({ ...capture, sel, kind, at })
    if (this.past.length > 500) this.past.shift()
    return true
  }

  /** 撤销一步：条目搬进 `future`（不取「当前」快照——重做要的那一侧就在条目里） */
  undo(sel: Sel | null): UndoEntry | null {
    const e = this.past.pop()
    if (!e) return null
    e.redoSel = sel
    this.future.push(e)
    return e
  }

  /** 重做一步：条目搬回 `past` */
  redo(): UndoEntry | null {
    const e = this.future.pop()
    if (!e) return null
    this.past.push(e)
    return e
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
