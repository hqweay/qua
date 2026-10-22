/**
 * **标签页的 footer**：属于 / 包含 / 成员。
 *
 * 三块内容，两个方向：
 *   · **属于**：`#演员._parentTags`（可写，× 删一条；父标签被删后留下「已删除」＋清理）；
 *   · **包含**：谁把 `#演员` 写进了自己的 `_parentTags`（**派生、只读**，同一条边的反向读法）；
 *   · **成员**：打了这个标签（含后代标签）的真实块 —— 复用反链 footer 的形状：
 *     挂的是共享 store 的活块，可原地编辑。
 *
 * ⚠️ 不设第二条边：两个面板读的是同一份 `_parentTags`。
 * ⚠️ 成员是**算作**进来的（`membersOf`）：`#人物` 的成员含只打 `#演员` 的块，
 *    但这些块**不获得** `#人物` 的字段（字段只看直接标签，见 `core/props.ts`）。
 */
import { findPath, type Atom, type Block, type BlockStore } from '../core/index.ts'
import { t } from '../core/msg.ts'
import { BlockEditor } from '../view/editor.ts'

export interface TagPanelDeps {
  store: BlockStore
  blocks: () => Block[]
  /** 当前对象；不是标签 ⇒ 整段隐藏 */
  tag: () => Block | undefined
  parents: (tag: Block) => Block[]
  dangling: (tag: Block) => string[]
  children: (tag: Block) => Block[]
  members: (tag: Block) => Block[]
  /** 这个标签是否**同时作为页**（页角色只决定是否进页列表） */
  isPage: (tag: Block) => boolean
  togglePage: (tagId: string) => void
  shortId: (id: string) => string
  /** 加一条归属（按名字找父标签；找不到就提示） */
  addParent: (tagId: string, name: string) => void
  removeParent: (tagId: string, parentId: string) => void
  /** 清理全部悬空归属 */
  pruneParents: (tagId: string) => void
  /** 成员编辑器里的编辑：落盘 */
  onChange: () => void
  /** 成员编辑器获得焦点：装配层把「活动编辑器」切到它 */
  onFocus: () => void
  onFocusBlock: (blockId: string) => void
  onAtomClick?: (atom: Atom, el: HTMLElement, mods: { altKey: boolean }) => void
  onAtomsLost?: (labels: string[]) => void
}

export interface TagPanelEls {
  root: HTMLElement
  title: HTMLElement
  pageToggle: HTMLButtonElement
  relations: HTMLElement
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
      // 折叠态是视图私有的（理由同反链）
      doc: { roots: [], folded: {}, trash: deps.store.trash },
    })
    this.editor.events = {
      change: (kind) => {
        if (kind !== 'load') this.deps.onChange()
      },
      focusBlock: (blockId) => this.deps.onFocusBlock(blockId),
      atomClick: (atom, el, mods) => this.deps.onAtomClick?.(atom, el, mods),
      atomsLost: (atoms) => this.deps.onAtomsLost?.(atoms.map((a) => a.label)),
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
    this.els.title.textContent = `#${tag.text.trim() === '' ? this.deps.shortId(tag.id) : tag.text}`
    this.els.pageToggle.textContent = this.deps.isPage(tag) ? t('ui.tagpanel.unPage') : t('ui.tagpanel.asPage')
    this.renderRelations(tag)
    this.renderMembers(tag)
  }

  private renderRelations(tag: Block): void {
    const box = this.els.relations
    box.replaceChildren()

    const parents = this.deps.parents(tag)
    const dangling = this.deps.dangling(tag)
    const children = this.deps.children(tag)

    box.appendChild(
      relationRow(
        t('ui.tagpanel.belongsTo'),
        [
          ...parents.map((p) => ({ label: `#${p.text || this.deps.shortId(p.id)}`, onRemove: () => this.deps.removeParent(tag.id, p.id) })),
          ...dangling.map((id) => ({
            label: `#${this.deps.shortId(id)}${t('ui.tagpanel.deleted')}`,
            onRemove: () => this.deps.removeParent(tag.id, id),
          })),
        ],
        dangling.length > 0
          ? { label: t('ui.tagpanel.prune', { count: dangling.length }), onClick: () => this.deps.pruneParents(tag.id) }
          : null,
      ),
    )

    box.appendChild(
      relationRow(
        t('ui.tagpanel.contains'),
        children.map((c) => ({ label: `#${c.text || this.deps.shortId(c.id)}` })),
        null,
      ),
    )

    // 加一条归属：输入标签名（名字比较走地址规范化 —— `# 人物 ` 与 `#人物` 是同一个）
    const form = document.createElement('form')
    form.className = 'tagpanel-add'
    form.addEventListener('submit', (e) => e.preventDefault())
    const input = document.createElement('input')
    input.className = 'prop-input'
    input.placeholder = t('ui.tagpanel.addParentPlaceholder')
    const add = document.createElement('button')
    add.type = 'submit'
    add.textContent = t('ui.tagpanel.addParent')
    add.addEventListener('click', () => {
      const name = input.value.trim()
      if (name === '') return
      this.deps.addParent(tag.id, name)
      input.value = ''
    })
    form.append(input, add)
    box.appendChild(form)
  }

  private renderMembers(tag: Block): void {
    const members = this.deps.members(tag)
    this.els.membersCount.textContent = t('ui.tagpanel.memberCount', { count: members.length })
    this.els.membersEmpty.hidden = members.length > 0
    this.els.membersEditor.hidden = members.length === 0
    if (members.length === 0) {
      // 空结果也保留本视图的折叠态：它记的是「哪些行收着」，不是「这次有几行」
      this.editor.loadPage({ roots: [], folded: this.editor.doc.folded, trash: this.deps.store.trash }, this.deps.store.marks, this.deps.store.atoms)
      return
    }

    // 去掉「祖先也在结果里」的块，避免同一个块作为 root + 子树重复渲染
    const ids = new Set(members.map((b) => b.id))
    const roots: Block[] = []
    for (const b of members) {
      const path = findPath(this.deps.blocks(), b.id) ?? []
      if (path.slice(0, -1).some((p) => ids.has(p.id))) continue
      const live = this.deps.store.find(b.id)
      if (live) roots.push(live)
    }
    this.editor.loadPage(
      { roots, folded: this.editor.doc.folded, trash: this.deps.store.trash },
      this.deps.store.marks,
      this.deps.store.atoms,
    )
  }

  private schedule(): void {
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      this.timer = null
      this.render()
    }, 200)
  }
}

function relationRow(
  title: string,
  items: { label: string; onRemove?: () => void }[],
  action: { label: string; onClick: () => void } | null,
): HTMLElement {
  const row = document.createElement('div')
  row.className = 'tagpanel-relation'
  const head = document.createElement('span')
  head.className = 'tagpanel-relation-title'
  head.textContent = title
  row.appendChild(head)
  if (items.length === 0) {
    const none = document.createElement('span')
    none.className = 'tagpanel-relation-empty'
    none.textContent = t('ui.common.none')
    row.appendChild(none)
  }
  for (const item of items) {
    const chip = document.createElement('span')
    chip.className = 'tagpanel-chip'
    chip.textContent = item.label
    if (item.onRemove) {
      const x = document.createElement('button')
      x.type = 'button'
      x.className = 'tagpanel-chip-x'
      x.title = t('ui.tagpanel.remove')
      x.textContent = '×'
      x.addEventListener('click', item.onRemove)
      chip.appendChild(x)
    }
    row.appendChild(chip)
  }
  if (action) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'tagpanel-action ghost'
    btn.textContent = action.label
    btn.addEventListener('click', action.onClick)
    row.appendChild(btn)
  }
  return row
}
