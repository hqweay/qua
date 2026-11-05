/**
 * 右槽的**反链卡**：和正文块底的「引用」栏同一种东西——一列**真实的可编辑块**。
 *
 * 为什么不是「一列摘要行」：反链要回答的是「哪一句在别处引了我」，读者接着就想
 * 在那句话上改。摘要行只能看、不能改，于是同一个块在两个地方有两种能力；
 * 真正的口径是**一块只有一份内容、露面可以有多个**，所以这里直接装一台
 * `EditableBlock`，与挂载区共用 store、撤销、事件表与面包屑展开。
 *
 * 与挂载区的差别只在**落点**：那边是「在这一块下面就地展开」，这边是「另一处的摘要」；
 * 判据（`derivedRecordsOf(…, 'refs')`）同一份，不各写一遍。
 *
 * ⚠️ **卡壳是持久的**：`sync()` 每次重画只改卡状态与目标；卡片元素本身不重建。
 *    反链卡里有一台 contenteditable，每次重画换掉它 = 每敲一个字丢一次焦点。
 * ⚠️ **重载节奏归 `EditableBlock`**（防抖、聚焦冻结、离焦补做）；这里只在
 *    「当前对象换了」时主动换一次装载，不叠第二条重载路径。
 */
import {
  applyQuickFilter,
  derivedRecordsOf,
  displayNameOf,
  EMPTY_QUICK_FILTER,
  quickFilterAdd,
  quickFilterDrop,
  type Block,
  type BlockStore,
  type QuickFilterAtom,
  type QuickFilterState,
} from '../../core/index.ts'
import { expandContexts, unfoldForContext } from '../../core/views/context-expand.ts'
import type { KbClient } from '../../core/kb/types.ts'
import { t } from '../../core/infra/msg.ts'
import type { BlockEditor, Run } from '../../view/editor/editor.ts'
import { buildDockCard, applyDockCardState, type DockCardState } from '../dock/dock.ts'
import { cardNote } from '../chrome/card-parts.ts'
import { renderQuickFilter } from '../chrome/quick-filter.ts'
import { EditableBlock } from '../block-ui/editable-block.ts'

export interface BackrefsCardDeps {
  store: BlockStore
  /** 读门面：反链按当前对象现算，祖先链按 id 取 */
  kb: KbClient
  /** 写入事务入口（装配层注入，见 `Run`） */
  write: Run
  /** 当前对象：卡跟着它走（与其它派生卡同一条口径） */
  target: () => string
  /** 与正文**同一份**编辑器事件表（点引用 / 块标 / 右键 / 补全…） */
  wire: (editor: BlockEditor, change: (kind: string) => void) => void
  /** 编辑器获得焦点：装配层把「活动编辑器」切过来（键位走命令层，认的是它） */
  onFocus: (editor: BlockEditor) => void
  /** 卡被拆掉：装配层若正把 `ed` 指着它，要退回正文 */
  onDispose: (editor: BlockEditor) => void
  /** 卡里编辑了模型：落盘、刷角标；**不重画槽**（重画会打断这一行的输入） */
  onChange: () => void
  /** 卡壳状态（收起／单卡／拖拽／关闭；装配层按 prefs 现算） */
  state: () => DockCardState
  onClose: () => void
  /** 浮层外壳（快速筛选的 chips 层住在这里面；与挂载区同一条窄缝） */
  openPopover?: (render: (host: HTMLElement) => void, anchor: DOMRect | null | (() => DOMRect | null)) => void
}

export class BackrefsCard {
  /** 持久卡壳：`renderDockStack` 按节点身份排位，原位不动 ⇒ 不换 DOM、不丢焦点 */
  readonly el: HTMLElement
  private readonly deps: BackrefsCardDeps
  /** 编辑器宿主（`.dock-backlinks-editor`） */
  private readonly host: HTMLElement
  private readonly empty: HTMLElement
  private readonly editable: EditableBlock
  /** 上一次装载的对象：只在它变了时主动重载 */
  private target = ''
  /** 面包屑就地展开的祖先栈（运行时视图状态，不落盘；与挂载区/窗口同一条机制） */
  private expanded = new Set<string>()
  /**
   * 快速筛选 chips（**会话瞬态**）：不写偏好、不入库、不产生 op、不进撤销栈。
   * 卡跟着对象走——换了对象，chips 说的就不是同一批材料，清空。
   */
  private filter: QuickFilterState = { ...EMPTY_QUICK_FILTER }
  private readonly tools: HTMLElement
  private readonly filterBtn: HTMLButtonElement

  constructor(deps: BackrefsCardDeps) {
    this.deps = deps
    this.host = document.createElement('div')
    this.host.className = 'dock-backlinks-editor'
    this.empty = cardNote(t('ui.dock.noBackRefs'))
    this.empty.hidden = true

    // 卡头没有「本卡专属动作」的通道（那是跨卡扫视的区域）——筛选按钮贴着它作用的内容
    this.tools = document.createElement('div')
    this.tools.className = 'dock-backlinks-tools'
    this.tools.hidden = true
    this.filterBtn = document.createElement('button')
    this.filterBtn.type = 'button'
    this.filterBtn.className = 'dock-backlinks-filter'
    this.filterBtn.textContent = t('ui.filter.button')
    this.filterBtn.title = t('ui.filter.buttonHint')
    this.filterBtn.addEventListener('click', () => this.openQuickFilter())
    this.tools.appendChild(this.filterBtn)

    this.editable = new EditableBlock({
      host: this.host,
      store: deps.store,
      write: deps.write,
      load: (ed, ids) => this.load(ed, ids),
      // 反链的行是别处的块：根不能搬/并出这一栏（那会改到它真正的落点）
      structuralScope: 'roots',
      wire: deps.wire,
      onChange: deps.onChange,
      onFocus: deps.onFocus,
      // 面包屑：普通点＝把祖先装成这一栏的根（中心/历史不动）；「收起上下文」＝逐层退回
      onExpandContext: (ancestorId, rowId) => this.expand(ancestorId, rowId),
      onContextBack: (rootId) => this.collapse(rootId),
    })

    const body = document.createElement('div')
    body.className = 'dock-backlinks-body'
    body.append(this.tools, this.editable.root, this.empty)

    this.el = buildDockCard(
      {
        id: 'backrefs',
        title: t('ui.dock.backRefs'),
        body,
        close: { title: t('ui.dock.closeCard'), onClick: deps.onClose },
      },
      deps.state(),
    )
  }

  /**
   * 每次排槽调一次：刷新卡壳状态；只有**当前对象换了**才换一次装载。
   *
   * ⚠️ 不能每次重画都 `load`：正文每敲一个键都会重画槽，而 `load` 会换掉编辑器里的
   *    行节点 —— 正在打的字就丢了。内容变了由 `EditableBlock` 自己按防抖/冻结处理。
   */
  sync(): HTMLElement {
    applyDockCardState(this.el, this.deps.state())
    const target = this.deps.target()
    if (target !== this.target) {
      this.target = target
      // 换对象 ⇒ 上一份展开栈说的是旧那批来源块的祖先，清掉（过期的 id 不该再展开）
      this.expanded.clear()
      // chips 说的是「上一批材料里看谁」——对象换了就归零，不带着旧筛选看新对象
      this.filter = { ...EMPTY_QUICK_FILTER }
      this.load(this.editable.ed)
    }
    return this.el
  }

  /** 从槽里摘掉：退订 store、卸事件、（若活动编辑器是它）交回装配层 */
  dispose(): void {
    const ed = this.editable.ed
    if (ed) this.deps.onDispose(ed)
    this.editable.dispose()
    this.el.remove()
  }

  /**
   * 装什么：当前对象的所有引用源块（**一块一行**），面包屑给祖先链。
   *
   * 与挂载区 `loadDerived` 同一套口径：只画最外层命中（祖先与子孙同时命中时，
   * 子块由祖先那一行自己展开）；`expandContexts` 把点过的祖先叠成装载根。
   */
  private load(ed: BlockEditor | null, _ids?: readonly string[], focusHint?: string): void {
    const host = this.deps.kb.get(this.target)
    const all = host ? derivedRecordsOf(host, this.deps.kb, 'refs') : []
    const records = applyQuickFilter(all, this.filter)

    // 筛选按钮：有材料、或正筛着（结果被筛空时还得留得住「摘掉 chip」的入口）
    const active = this.filter.include.length > 0 || this.filter.remove.length > 0
    this.tools.hidden = all.length === 0 && !active
    this.filterBtn.dataset.active = active ? '1' : '0'

    const ids = new Set(records.map((r) => r.block.id))
    const roots: Block[] = []
    const contexts = new Map<string, readonly Block[]>()
    for (const r of records) {
      if (r.path.some((p) => ids.has(p.id))) continue
      roots.push(r.block)
      if (r.path.length > 0) contexts.set(r.block.id, r.path)
    }

    if (roots.length === 0) {
      this.empty.hidden = false
      this.empty.textContent = active ? t('ui.dock.noBackRefsFiltered') : t('ui.dock.noBackRefs')
      this.host.hidden = true
      // 已有编辑器也要清空：否则「没有反链了」时屏幕上还留着上一条
      const editor = ed ?? this.editable.ed
      editor?.loadPage({ roots: [], folded: editor.doc.folded })
      return
    }

    this.empty.hidden = true
    this.host.hidden = false
    const editor = ed ?? this.editable.ensureEditor()
    const plan = expandContexts({ roots, contexts }, this.expanded, (id) => this.deps.kb.pathOf(id), focusHint)
    this.expanded = plan.expanded
    const folded = unfoldForContext(editor.doc.folded, plan.covers, (id) => this.deps.kb.pathOf(id))
    editor.loadPage({ roots: plan.roots, folded, contexts: plan.contexts, expandedRoots: plan.contextRoots })
    if (plan.focusId) editor.reveal(plan.focusId)
  }

  /** 点面包屑一格：把那个祖先装成这一栏的根（就地展开） */
  private expand(ancestorId: string, rowId: string): void {
    if (!ancestorId) return
    this.expanded.add(ancestorId)
    this.load(this.editable.ed, undefined, rowId)
  }

  /** 「收起上下文」：只收这一层；内层还留在栈里，下一次重算会浮出来 */
  private collapse(rootId: string): void {
    if (!this.expanded.delete(rootId)) return
    this.load(this.editable.ed)
  }

  /**
   * 弹出 chips 层。锚点每次现查（重画会重建按钮，矩形快照留不住指向）；
   * 锚点不在了 ⇒ 浮层自己关（装配层浮层的既有口径）。
   */
  private openQuickFilter(): void {
    if (!this.deps.openPopover) return
    this.deps.openPopover(
      (box) => {
        const paint = (): void =>
          renderQuickFilter(box, {
            records: () => {
              const host = this.deps.kb.get(this.target)
              return host ? derivedRecordsOf(host, this.deps.kb, 'refs') : []
            },
            state: () => this.filter,
            labelOf: (atom: QuickFilterAtom) => {
              const id = 'up' in atom ? atom.up.is : atom.tag
              const block = this.deps.kb.get(id)
              return block ? displayNameOf(block) || id.slice(-4) : id.slice(-4)
            },
            onAdd: (atom, to) => {
              const next = quickFilterAdd(this.filter, atom, to)
              if (!next) return
              this.filter = next
              this.load(this.editable.ed)
              paint()
            },
            onDrop: (atom) => {
              const next = quickFilterDrop(this.filter, atom)
              if (!next) return
              this.filter = next
              this.load(this.editable.ed)
              paint()
            },
          })
        paint()
      },
      () => this.el.querySelector('.dock-backlinks-filter')?.getBoundingClientRect() ?? null,
    )
  }
}
