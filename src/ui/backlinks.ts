/**
 * **反链 view block（footer 版）**（下一层）。
 *
 * 它不是「反链面板组件」——是一个 **view**：source = `refs(current)`，view = outline，
 * 结果是一列**真实源块**（活引用，不是拷贝），所以可以原地编辑；编辑写回共享 block store，
 * 另一个视图（正文/右槽/另一个实例）收到 `touch` 后同步。
 *
 * 当前的 placement 是正文 footer；以后右槽就是挂同一个 view（slot 只负责排一列块）。
 *
 * 刷新策略：反链是**上下文**，默认 live/on-blur；编辑 footer 自身时冻结结果集
 * （不在打字时把行抽走），失焦或点刷新再重查。
 */
import {
  backrefBlocks,
  findPath,
  type Block,
  type BlockStore,
} from '../core/index.ts'
import { t } from '../core/msg.ts'
import { BlockEditor } from '../view/editor.ts'

export interface BacklinksViewDeps {
  store: BlockStore
  /** 整片森林（活引用） */
  blocks: () => Block[]
  targetId: () => string
  /** 反链编辑器里的编辑：持久化（不刷新 docks，避免把它自己搬走） */
  onChange: (kind: string) => void
  /** footer 编辑器获得焦点：装配层把「活动编辑器」切到它 */
  onFocus: () => void
  onAtomsLost?: (labels: string[]) => void
}

export interface BacklinksViewEls {
  root: HTMLElement
  editor: HTMLElement
  title: HTMLElement
  count: HTMLElement
  refresh: HTMLButtonElement
}

export class BacklinksView {
  readonly editor: BlockEditor
  private readonly els: BacklinksViewEls
  private readonly deps: BacklinksViewDeps
  private timer: number | null = null

  constructor(els: BacklinksViewEls, deps: BacklinksViewDeps) {
    this.els = els
    this.deps = deps
    this.els.title.textContent = t('ui.backlinks.title')
    this.els.refresh.textContent = t('ui.backlinks.refresh')
    this.els.refresh.addEventListener('click', () => this.render())
    this.els.editor.addEventListener('focusin', () => this.deps.onFocus())

    this.editor = new BlockEditor({
      container: els.editor,
      // 记录视图：没有「视图级同级」；点空白/删段根都不该发生
      blankArea: els.editor,
      allowBlankCreate: false,
      allowRootRemove: false,
      store: deps.store,
      doc: { roots: [] },
    })
    this.editor.events = {
      change: (kind) => {
        if (kind !== 'load') this.deps.onChange(kind)
      },
      atomsLost: (atoms) => this.deps.onAtomsLost?.(atoms.map((a) => a.label)),
    }

    // 外部编辑：不在 footer 编辑时重查（编辑中冻结）；footer 自己的编辑不重查（on-blur 再算）
    deps.store.subscribe((source) => {
      if (source === this.editor) return
      if (this.editor.container.contains(document.activeElement)) return
      this.schedule()
    })
    this.els.editor.addEventListener('focusout', () => {
      // 焦点仍在 footer 内的另一块时不算离开；离开后重查一次（引用可能被这次编辑移除）
      window.setTimeout(() => {
        if (!this.editor.container.contains(document.activeElement)) this.render()
      }, 0)
    })
  }

  /** 重查当前对象的反链并装载；空则整段隐藏（不留死文案） */
  render(): void {
    const target = this.deps.targetId()
    if (!target) {
      this.els.root.hidden = true
      return
    }
    // 传共享索引：反链从「扫全库 atoms ＋ 遍历森林」变成查表（store 已经缓存了它）
    const sources = backrefBlocks({
      blocks: this.deps.blocks(),
      atoms: this.deps.store.atoms,
      targetId: target,
      index: this.deps.store.index,
    })
    if (sources.length === 0) {
      this.els.root.hidden = true
      return
    }

    // 去掉「祖先也在结果里」的源块：否则同一个块会作为 root + 子树重复渲染
    const ids = new Set(sources.map((s) => s.blockId))
    const roots: Block[] = []
    for (const s of sources) {
      const path = findPath(this.deps.blocks(), s.blockId) ?? []
      const nested = path.slice(0, -1).some((p) => ids.has(p.id))
      if (nested) continue
      const b = this.deps.store.find(s.blockId)
      if (b) roots.push(b)
    }
    if (roots.length === 0) {
      this.els.root.hidden = true
      return
    }

    this.els.root.hidden = false
    this.els.count.textContent = t('ui.backlinks.count', { count: sources.length })
    this.editor.loadPage({ roots }, this.deps.store.marks, this.deps.store.atoms)
  }

  private schedule(): void {
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      this.timer = null
      this.render()
    }, 200)
  }
}
