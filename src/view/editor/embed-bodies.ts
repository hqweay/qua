/**
 * 嵌入体与查询体的**身体生命周期**：行元素换掉之前必须摘掉旧身体，
 * 否则订阅会跟着旧节点留在后台（每行一次 store 订阅就是白付的账）。
 *
 * 从 BlockEditor 拆出的协作对象：自有状态只有「谁挂了哪个回收函数」一张表；
 * 「画什么」仍归装配层（`events.embedBody`／`events.viewBody`），这里只管
 * 登记与回收，不发明第二条订阅路径。
 */
import { t } from '../../core/infra/msg.ts'
import type { Block } from '../../core/index.ts'
import type { BlockEditor } from './editor.ts'

export class EmbedBodies {
  private readonly disposers = new Map<string, () => void>()
  /**
   * **整页重画时被保住的那一行**（结构变化后保留输入锚点行的重画路径）。
   *
   * 重画会把每一行的身体摘掉再重挂；被保住的那一行是**原元素原样换回**的，
   * 它的身体（里层编辑器／表格）既不能被摘、也不能先挂一份新的——
   * 摘了，浮层与正在输入的编辑器当场消失；挂了新的，旧行换回后留一份没人管的订阅。
   */
  private pinned: string | null = null

  constructor(
    private readonly ed: BlockEditor,
    /** 露面块的身体能不能展开（深度 1 的构造性截断；见 `ViewOpts.embedBodies`） */
    private readonly allowed: boolean,
  ) {}

  /** makeBlockEl 的 `embedBody` 钩子：嵌套截断／破态／真身体，挂上的回收函数记进表 */
  attach(b: Block, into: HTMLElement): void {
    if (b.id === this.pinned) return
    if (!this.allowed) {
      into.textContent = t('ui.embed.nested')
      into.dataset.embedNested = '1'
      return
    }
    if (!this.ed.events.embedBody) {
      into.textContent = t('ui.embed.broken')
      return
    }
    const dispose = this.ed.events.embedBody(b, into)
    if (dispose) this.disposers.set(b.id, dispose)
  }

  /** makeBlockEl 的 `codeBody` 钩子：代码岛的 CM6 实例也走同一张回收表 */
  attachCodeBody(b: Block, into: HTMLElement): void {
    if (b.id === this.pinned) return
    const dispose = this.ed.events.codeBody?.(b, into)
    if (dispose) this.disposers.set(b.id, dispose)
  }

  /** makeBlockEl 的 `viewBody` 钩子（正文里的查询体；装配层没接就不进这个分支） */
  attachViewBody(b: Block, into: HTMLElement): void {
    if (b.id === this.pinned) return
    const dispose = this.ed.events.viewBody!(b, into)
    if (dispose) this.disposers.set(b.id, dispose)
  }

  /** makeBlockEl 的 `automationBody` 钩子（自动化块的三段式定义体；生命周期同上） */
  attachAutomationBody(b: Block, into: HTMLElement): void {
    if (b.id === this.pinned) return
    const dispose = this.ed.events.automationBody?.(b, into)
    if (dispose) this.disposers.set(b.id, dispose)
  }

  /** makeBlockEl 的 `defBody` 钩子（定义值配置／字段声明的就地投影；生命周期同上） */
  attachDefBody(b: Block, into: HTMLElement): void {
    if (b.id === this.pinned) return
    const dispose = this.ed.events.defBody?.(b, into)
    if (dispose) this.disposers.set(b.id, dispose)
  }

  /**
   * makeBlockEl 的 `manageProps` 钩子（主体行下的管理档）。
   *
   * 它不是「身体」，但生命周期与身体同型：实例属于块、DOM 随行换、行重画要保住
   * 而不重建（里面有一份草稿/展开态与正在编辑的控件）。回收走同一张表，
   * `disposeRow`／`disposeAll` 的时机就已经是对的——另开一张表只会多一处要记得调。
   */
  attachManageProps(b: Block, into: HTMLElement): void {
    if (b.id === this.pinned) return
    const dispose = this.ed.events.manageProps?.(b, into)
    if (dispose) this.disposers.set(b.id, dispose)
  }

  /** 摘掉某一行的身体（换 DOM 之前做） */
  disposeRow(id: string): void {
    const d = this.disposers.get(id)
    if (!d) return
    this.disposers.delete(id)
    d()
  }

  disposeAll(): void {
    for (const id of [...this.disposers.keys()]) {
      if (id === this.pinned) continue
      this.disposeRow(id)
    }
  }

  /** 整页重画期间保住这一行的身体（`attach`／`disposeAll` 都跳过它） */
  pin(id: string): void {
    this.pinned = id
  }

  unpin(): void {
    this.pinned = null
  }

  isPinned(id: string): boolean {
    return this.pinned === id
  }
}
