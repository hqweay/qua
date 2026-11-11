/**
 * **页签**：一次只看一个子块；页签＝直接子块，身体渲染那一块的整棵子树。
 *
 * 三条判据：
 *   · 页签是**独立的视图种类**，不是卡片的一种摆法——身体是普通块的行
 *     （可编辑大纲），不是卡片（标题＋字段＋封面）；页签还有自己的状态
 *     （激活项），而卡片的两副面孔（网格／看板）身体是同一份。
 *   · **激活项是视图实例状态**：不进 KB、不跨表面同步。切走再回来回落第一页；
 *     那一页被删后解析不到也回落第一页——不留一个点不亮的状态。
 *   · 身体是**一台 `EditableBlock`**（与侧槽窗口同一装配）：在页签里打的字
 *     就落在那一块上；换页签＝换 roots，不重建编辑器（选区不丢）。
 */
import {
  blockLabel,
  openActionOf,
  type Block,
  type FindBlock,
  type BlockStore,
  type OpenAction,
  type StructureGroup,
  type ViewConfig,
} from '../../core/index.ts'
import { type BlockEditor, type Run } from '../../view/editor/editor.ts'
import { EditableBlock } from '../block-ui/editable-block.ts'
import { t } from '../../core/infra/msg.ts'
import { viewNote } from './view-note.ts'

export interface ViewTabsDeps {
  store: BlockStore
  /** 写入事务入口（页签里的编辑与别处的编辑同一条写路径） */
  write: Run
  /** 页签＝这一块的直接子块（只有 children 源会有；查询源命中是平的，没有「页」） */
  tabs: () => readonly StructureGroup[]
  view: () => ViewConfig | null
  /** 与正文同一份事件表（右键块菜单、`#`·`@` 补全、划选气泡） */
  wire: (ed: BlockEditor, change: (kind: string) => void) => void
  onChange: () => void
  onFocus: (ed: BlockEditor) => void
  /** 页签有身份（那一块）：双击打开它（单击是切换，不抢走） */
  openBlock: (blockId: string, place?: OpenAction) => void
}

export class ViewTabs {
  /** 引用解析用（呈现摘要现算名字）：页签名与形状签名共用这一只箭头 */
  private readonly kbFind: FindBlock
  readonly root: HTMLElement
  private readonly deps: ViewTabsDeps
  /** 页签的形状签名（块 id ＋ 名字）：变了才重建切换条；正文变化不碰它 */
  private shape = ''
  /** 成员的 id 签名：新建／删除／**换了一块**都算变了（重建搬身体编辑器 ⇒ 不能跟打字节奏走） */
  private memberIds = ''
  /** 激活页（视图实例状态：不进 KB、不跨表面同步） */
  private active = ''
  private component: EditableBlock | null = null
  /** 切换条与身体的宿主（整片重画只重建条，身体编辑器一直活着） */
  private strip: HTMLElement | null = null
  private body: HTMLElement | null = null

  constructor(deps: ViewTabsDeps) {
    this.deps = deps
    this.kbFind = (id) => deps.store.find(id)
    this.root = document.createElement('section')
    this.root.className = 'vtabs-view'
  }

  dispose(): void {
    const component = this.component
    this.component = null
    if (!component) return
    component.flush()
    component.dispose()
    component.root.remove()
  }

  render(): void {
    const groups = this.deps.tabs()
    const view = this.deps.view()
    const direction = view?.tabs?.direction === 'vertical' ? 'vertical' : 'horizontal'
    this.root.dataset.direction = direction
    this.memberIds = groups.map((g) => g.block.id).join('|')

    const nextShape = groups.map((g) => `${g.block.id}:${blockLabel(g.block, this.kbFind)}`).join('|')
    if (nextShape !== this.shape || !this.strip || !this.body) {
      this.shape = nextShape
      this.renderStrip(groups)
    }
    this.paint(groups)
  }

  /**
   * 逐块通知（`ids` 是被动过的那几个块）的入口，两件事分开做：
   *
   * · **成员数变了**（新建/删除一行）⇒ 重建切换条；
   * · **已有页签的内容变了**（首行就是页签的名字，改正文＝改名）⇒ **就地改文案**。
   *   重建会搬动身体编辑器的 DOM（丢焦点、断输入），所以改名绝不走整条重建——
   *   逐键 patch 一个 span 的 textContent 就够。
   */
  sync(ids?: readonly string[]): void {
    const groups = this.deps.tabs()
    // 成员签名用 **id 序**不用数量：数量守不住「删一块＋原地补一块」这类替换形
    // （数量没变、名单变了）——旧签名会漏掉重建，页签条顶着旧样子
    if (groups.map((g) => g.block.id).join('|') !== this.memberIds) {
      this.render()
      return
    }
    if (!ids || ids.length === 0 || !this.strip) return
    let relabelled = false
    for (const id of ids) {
      const tab = this.strip.querySelector(`.vtab[data-group-key="${CSS.escape(id)}"]`)
      if (!tab) continue
      const g = groups.find((x) => x.block.id === id)
      if (!g) continue
      const name = tab.querySelector('.vtab-name')
      if (name) name.textContent = blockLabel(g.block, this.kbFind)
      const count = tab.querySelector('.vtab-count')
      if (count) count.textContent = String(g.records.length)
      relabelled = true
    }
    // shape 里的名字位已经就地改过：不同步它，下次 render 会拿陈旧签名误判「要整条重建」
    if (relabelled) {
      this.shape = groups.map((g) => `${g.block.id}:${blockLabel(g.block, this.kbFind)}`).join('|')
    }
  }

  /** 重建切换条（结构与改名走这里；编辑器与身体不动） */
  private renderStrip(groups: readonly StructureGroup[]): void {
    this.root.replaceChildren()
    const strip = document.createElement('div')
    strip.className = 'vtabs'
    strip.setAttribute('role', 'tablist')
    strip.setAttribute(
      'aria-orientation',
      this.root.dataset.direction === 'vertical' ? 'vertical' : 'horizontal',
    )
    for (const g of groups) {
      strip.appendChild(this.tab(g))
    }
    const body = document.createElement('div')
    body.className = 'vtabs-body'
    this.strip = strip
    this.body = body
    this.root.append(strip, body)
    if (this.component) body.appendChild(this.component.root)
  }

  private tab(g: StructureGroup): HTMLElement {
    const tab = document.createElement('button')
    tab.type = 'button'
    tab.className = 'vtab'
    tab.dataset.groupKey = g.block.id
    if (g.block.id === this.active) tab.dataset.active = '1'
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-selected', g.block.id === this.active ? 'true' : 'false')
    const name = document.createElement('span')
    name.className = 'vtab-name ui-ellipsis'
    name.textContent = blockLabel(g.block, this.kbFind)
    const count = document.createElement('span')
    count.className = 'vtab-count'
    count.textContent = String(g.records.length)
    tab.append(name, count)
    tab.addEventListener('click', () => {
      if (this.active === g.block.id) return
      this.active = g.block.id
      this.paint(this.deps.tabs())
    })
    // 组有身份：双击打开那一块（单击是切换，不抢走）
    tab.dataset.tip = t('ui.cards.openGroupHint')
    tab.addEventListener('dblclick', (e) => {
      e.preventDefault()
      this.deps.openBlock(g.block.id, openActionOf(e))
    })
    return tab
  }

  /**
   * 画激活页：无页 ⇒ 空态；有页 ⇒ 页签条高亮 ＋ 身体重挂 roots。
   *
   * 身体那台编辑器**跨页签复用**（换页签只换 roots，不重建实例）——
   * 重建会把撤销栈与选区一起丢掉，换页签又不是换视图。
   */
  private paint(groups: readonly StructureGroup[]): void {
    for (const el of Array.from(this.strip?.children ?? [])) {
      const on = el.getAttribute('data-group-key') === this.activeTab(groups)
      if (on) el.setAttribute('data-active', '1')
      else el.removeAttribute('data-active')
      el.setAttribute('aria-selected', on ? 'true' : 'false')
    }
    const activeId = this.activeTab(groups)
    if (activeId === '') {
      if (this.body && !this.body.querySelector('.view-note')) {
        this.body.replaceChildren(viewNote(t('ui.tabs.empty')))
      }
      return
    }
    const block = this.deps.store.find(activeId)
    if (!block) return
    this.paintEditor(block)
  }

  /** 激活页：记住的那页还在就用它；不在（删除／首帧）回落第一页 */
  private activeTab(groups: readonly StructureGroup[]): string {
    const remembered = groups.find((g) => g.block.id === this.active)
    const active = remembered ?? groups[0]
    this.active = active?.block.id ?? ''
    return this.active
  }

  private paintEditor(block: Block): void {
    const body = this.body
    if (!body) return
    const component = this.component
    if (component) {
      const ed = component.ed
      if (ed) {
        ed.loadPage({ roots: [block], folded: ed.doc.folded })
        return
      }
    }
    if (!this.component) {
      const host = document.createElement('div')
      host.className = 'vtabs-editor'
      host.spellcheck = false
      this.component = new EditableBlock({
        host,
        store: this.deps.store,
        write: this.deps.write,
        // 页的根是派生的行：不能并进上一行／搬出这一页；根内部照常编辑。
        // 首行就是页签本身（容器的真实子块）：右键「删除块」＝删这一页（软删可回，
        // 默认放行）。fill 关：一段恒一页，补空块会把「删这一页」变成「原地换空块」；
        // 落点由视图回落激活页给
        structuralScope: 'roots',
        rootRemoveFill: false,
        load: (ed) => {
          if (!ed) return
          ed.reloadFromStore()
        },
        wire: (editor, change) => this.deps.wire(editor, change),
        onChange: () => this.deps.onChange(),
        onFocus: (editor) => this.deps.onFocus(editor),
      })
      this.component.ensureEditor()
      body.replaceChildren(this.component.root)
    }
    const ed = this.component.ed
    if (ed) ed.loadPage({ roots: [block], folded: {} })
  }
}
