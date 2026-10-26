/**
 * **标签页的 footer：成员**。
 *
 * 只剩一件事：打了这个标签（含下级标签，见 `membersOf` 的「算作」）的真实块 ——
 * 复用反链 footer 的形状，挂的是共享 store 的活块，可原地编辑。
 *
 * ⚠️ 「属于／包含」**不在这里**：归属边能配在任何块上（不只是标签），
 *    所以它住在属性区（`ui/properties.ts` 的「属于」那一行）。
 *    判据：**能配在任何块上的关系，住在属性区；只有某类块才有的关系，住在那个块的面板里。**
 *    成员是后者（谁是这一支的成员，只有标签有）。
 * ⚠️ 成员是**算作**进来的：`#人物` 的成员含只打 `#演员` 的块，
 *    但这些块**不获得** `#人物` 的字段（字段只看直接标签，见 `core/props.ts`）。
 */
import { displayNameOf, type Block, type BlockStore } from '../core/index.ts'
import type { RefClickHit, RefClickMods } from '../view/editor-events.ts'
import type { KbClient } from '../core/kb/types.ts'
import { t } from '../core/msg.ts'
import { BlockEditor, type Run } from '../view/editor.ts'

export interface TagPanelDeps {
  store: BlockStore
  /** 写入事务入口：执行者在装配层，这里只原样转给成员编辑器（见 `Run`） */
  write?: Run
  /** 读门面：成员行的祖先链按 id 现读（成员是装配层注入的窄派生） */
  kb: KbClient
  /** 当前对象；不是标签 ⇒ 整段隐藏 */
  tag: () => Block | undefined
  members: (tag: Block) => Block[]
  /** 这个标签是否**同时标记为页**（页只决定是否进页列表） */
  isPage: (tag: Block) => boolean
  togglePage: (tagId: string) => void
  shortId: (id: string) => string
  /** 成员编辑器里的编辑：落盘 */
  onChange: () => void
  /** 成员编辑器获得焦点：装配层把「活动编辑器」切到它 */
  onFocus: () => void
  onFocusBlock: (blockId: string) => void
  /** Shift+点成员块标：在右槽打开它 */
  onOpenInDock: (blockId: string) => void
  onRefClick?: (ref: RefClickHit, mods: RefClickMods, el?: HTMLElement) => void
}

export interface TagPanelEls {
  root: HTMLElement
  title: HTMLElement
  pageToggle: HTMLButtonElement
  membersTitle: HTMLElement
  membersCount: HTMLElement
  membersEmpty: HTMLElement
  membersEditor: HTMLElement
}

export class TagPanel {
  readonly editor: BlockEditor
  private readonly els: TagPanelEls
  private readonly deps: TagPanelDeps
  private timer: number | null = null

  constructor(els: TagPanelEls, deps: TagPanelDeps) {
    this.els = els
    this.deps = deps
    this.els.membersTitle.textContent = t('ui.tagpanel.members')
    this.els.pageToggle.addEventListener('click', () => {
      const tag = this.deps.tag()
      if (tag) this.deps.togglePage(tag.id)
    })
    this.els.membersEmpty.textContent = t('ui.tagpanel.emptyMembers')
    this.els.membersEditor.addEventListener('focusin', () => this.deps.onFocus())
    this.editor = new BlockEditor({
      container: els.membersEditor,
      blankArea: els.membersEditor,
      allowBlankCreate: false,
      allowRootRemove: false,
      store: deps.store,
      write: deps.write,
      // 折叠态是视图私有的（理由同反链）
      doc: { roots: [], folded: {} },
    })
    this.editor.events = {
      change: (kind) => {
        if (kind !== 'load') this.deps.onChange()
      },
      focusBlock: (blockId) => this.deps.onFocusBlock(blockId),
      openInDock: (blockId) => this.deps.onOpenInDock(blockId),
      refClick: (ref, mods, el) => this.deps.onRefClick?.(ref, mods, el),
    }
    deps.store.subscribe((source) => {
      if (source === this.editor) return
      if (this.editor.container.contains(document.activeElement)) return
      this.schedule()
    })
    this.els.membersEditor.addEventListener('focusout', () => {
      window.setTimeout(() => {
        if (!this.editor.container.contains(document.activeElement)) this.render()
      }, 0)
    })
  }

  render(): void {
    const tag = this.deps.tag()
    if (!tag) {
      this.els.root.hidden = true
      return
    }
    this.els.root.hidden = false
    const name = displayNameOf(tag).trim()
    this.els.title.textContent = `#${name === '' ? this.deps.shortId(tag.id) : name}`
    this.els.pageToggle.textContent = this.deps.isPage(tag) ? t('ui.tagpanel.unPage') : t('ui.tagpanel.asPage')
    this.renderMembers(tag)
  }

  private renderMembers(tag: Block): void {
    const members = this.deps.members(tag)
    this.els.membersCount.textContent = t('ui.tagpanel.memberCount', { count: members.length })
    this.els.membersEmpty.hidden = members.length > 0
    this.els.membersEditor.hidden = members.length === 0
    if (members.length === 0) {
      // 空结果也保留本视图的折叠态：它记的是「哪些行收着」，不是「这次有几行」
      this.editor.loadPage({ roots: [], folded: this.editor.doc.folded })
      return
    }

    // 去掉「祖先也在结果里」的块，避免同一个块作为 root + 子树重复渲染
    const ids = new Set(members.map((b) => b.id))
    const roots: Block[] = []
    for (const b of members) {
      const path = this.deps.kb.pathOf(b.id)
      if (path.slice(0, -1).some((p) => ids.has(p.id))) continue
      const live = this.deps.store.find(b.id)
      if (live) roots.push(live)
    }
    this.editor.loadPage({ roots, folded: this.editor.doc.folded })
  }

  private schedule(): void {
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      this.timer = null
      this.render()
    }, 200)
  }
}
