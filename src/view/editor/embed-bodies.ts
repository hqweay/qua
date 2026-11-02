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

  constructor(
    private readonly ed: BlockEditor,
    /** 露面块的身体能不能展开（深度 1 的构造性截断；见 `ViewOpts.embedBodies`） */
    private readonly allowed: boolean,
  ) {}

  /** makeBlockEl 的 `embedBody` 钩子：嵌套截断／破态／真身体，挂上的回收函数记进表 */
  attach(b: Block, into: HTMLElement): void {
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

  /** makeBlockEl 的 `viewBody` 钩子（正文里的查询体；装配层没接就不进这个分支） */
  attachViewBody(b: Block, into: HTMLElement): void {
    const dispose = this.ed.events.viewBody!(b, into)
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
    for (const id of [...this.disposers.keys()]) this.disposeRow(id)
  }
}
