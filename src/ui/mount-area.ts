/**
 * **块的挂载区**：块底那一栏「引用／同类／提及 ＋ 用户配的查询」，一条 tab 条 ＋ 一个 body。
 *
 * 三条口径落在这一层：
 *   · **一个编辑器，N 个 loader**：切 tab 只换 `loadPage` 的 roots。编辑器不重建，
 *     所以撤销栈与选区都不丢（重建一次，用户按 ⌘Z 就只能撤到「刚切过 tab」）。
 *   · **tab 不是块**：这一层不建块、不写 `children`。用户栏的增删交给装配层
 *     （`onAddTab` / `onRemoveTab`），因为「写到哪一格」是模型层的事。
 *   · **空 tab 仍在**：栏在、body 里一行说明。空是**状态**不是错误，把栏藏掉
 *     会让用户以为「这块没有引用」，而真相是「还没有人引用它」。
 *
 * 编辑器装配（建实例、订阅、防抖重载、聚焦冻结、离焦补做、事件表）全部在
 * `EditableBlock` 里；这一层只决定**装哪些根**（哪个 tab、展开到哪层、面包屑怎么给）。
 *
 * ⚠️ 与右槽的分工：右槽的 `backrefsCard` 是**页级派生卡**（读当前对象、跟着它走）。
 *    挂载区是「在这一块下面就地展开」。硬统一会得到两份各自记激活项的 tab 条。
 * ⚠️ 这里不碰命令、不认识浮层：`＋` 只回调装配层。
 */
import { type Block, type BlockStore, type MountTab, mountTabsOf, canEditMounts, expandContexts, unfoldForContext } from '../core/index.ts'
import type { KbClient } from '../core/kb/types.ts'
import { t, type MsgId } from '../core/msg.ts'
import { type BlockEditor, type Run } from '../view/editor.ts'
import { EditableBlock } from './editable-block.ts'

export interface MountAreaDeps {
  store: BlockStore
  /** 写入事务入口：执行者在装配层，这里只原样转给编辑器（见 `Run`） */
  write: Run
  /** 读门面：三栏的数据都按 id 取（反链查表、查询走索引、祖先链按 id 现读） */
  kb: KbClient
  /** 宿主块（＝这一段段根）。段被换掉/收掉时由装配层丢弃实例 */
  host: () => Block | undefined
  /** 编辑器里的编辑：落盘 */
  onChange: (kind: string) => void
  /** 获得焦点（编辑器已建好才可能发生）：装配层把「活动编辑器」切过来 */
  onFocus: (editor: BlockEditor) => void
  /**
   * **接上与正文同一套编辑器事件**（点引用/点块标/右键块菜单/`#`·`@` 补全…）。
   *
   * 为什么是「接一份」而不是在这里一项一项写：这些编辑器是同一种东西，
   * 差别只在装载谁。分散着接就会漏（漏了也不报错：面板里点引用不跳、右键没菜单）。
   * 事件表本身在装配层只有一份（`viewEvents`）。
   */
  wire: (editor: BlockEditor, change: (kind: string) => void) => void
  /** 「＋」：由装配层弹一个选择器（本层不知道浮层长什么样） */
  onAddTab?: (hostId: string) => void
  /** 「×」：摘掉一栏用户 tab（`index` 是**用户栏**的序，不是整条 tab 条的序） */
  onRemoveTab?: (hostId: string, index: number) => void
  /**
   * 初始是否展开。日记流里只有今天展开，更早的天是一行摘要（一行 DOM ＋ 不建编辑器）。
   */
  expanded?: boolean
}

/** 一条 tab 的键：内置栏用 `kind`，用户栏用 `user:<序>` */
const keyOf = (tab: MountTab, userIndex: number): string => (tab.kind === 'user' ? `user:${userIndex}` : tab.kind)

/** 一栏装载什么：根块 ＋ 每个根行的面包屑（祖先链，不含自己） */
interface MountRoots {
  roots: Block[]
  contexts: Map<string, readonly Block[]>
}

const BUILTIN_LABEL: Record<MountTab['kind'], MsgId | ''> = {
  refs: 'ui.mount.refs',
  same: 'ui.mount.same',
  mentions: 'ui.mount.mentions',
  user: '',
}

const EMPTY_TEXT: Record<MountTab['kind'], MsgId> = {
  refs: 'ui.mount.empty.refs',
  same: 'ui.mount.empty.same',
  mentions: 'ui.mount.empty.mentions',
  user: 'ui.mount.empty.user',
}

export class MountArea {
  readonly root: HTMLElement
  private readonly deps: MountAreaDeps
  /** tab 条（展开时可见） */
  private readonly tabsEl: HTMLElement
  private readonly bodyEl: HTMLElement
  private readonly editorEl: HTMLElement
  private readonly emptyEl: HTMLElement
  /** 折叠时那一行摘要（只有「引用 N」——同类／提及的计数要现算，折叠时不值得算） */
  private readonly summaryEl: HTMLButtonElement
  /**
   * 那**一个**编辑器装配。懒建由它自己管：折叠的天、空的栏不建实例（30 天 feed
   * 只该有一个编辑器），建了就一直复用（切 tab 不重建 ⇒ 撤销栈与选区都不丢）。
   */
  private readonly block: EditableBlock
  private tabs: MountTab[] = []
  /** 当前激活那一条的键；找不到（栏被摘掉了）就回落到第一条 */
  private active = ''
  private open: boolean
  /**
   * 每个 tab 的**上下文展开栈**（祖先 id）。视图状态，不落盘。
   * 每个 tab 各记各的：在「引用」里展开的上下文不会突然出现在「同类」。
   */
  private readonly expandedByTab = new Map<string, Set<string>>()
  /** 上次装载的「上下文根 → 覆盖的命中行」；收起一层时用它算滚回哪 */
  private covers: ReadonlyMap<string, readonly string[]> = new Map()
  /** 这一段是谁；段落换人时清空展开状态 */
  private hostId = ''

  constructor(deps: MountAreaDeps) {
    this.deps = deps
    this.open = deps.expanded ?? true

    this.root = document.createElement('section')
    this.root.className = 'mount'

    this.summaryEl = document.createElement('button')
    this.summaryEl.type = 'button'
    this.summaryEl.className = 'mount-summary'
    this.summaryEl.addEventListener('click', () => this.setOpen(true))

    this.tabsEl = document.createElement('div')
    this.tabsEl.className = 'mount-tabs'
    this.tabsEl.setAttribute('role', 'tablist')

    this.bodyEl = document.createElement('div')
    this.bodyEl.className = 'mount-body'

    this.editorEl = document.createElement('div')
    this.editorEl.className = 'mount-editor'
    this.editorEl.spellcheck = false

    this.emptyEl = document.createElement('p')
    this.emptyEl.className = 'mount-empty'
    this.emptyEl.hidden = true

    this.block = new EditableBlock({
      host: this.editorEl,
      store: deps.store,
      write: deps.write,
      // 重查比窗口贵一档（要跑查询），防抖放长一点；焦点/按下/组合期的冻结在组件里
      debounceMs: 200,
      // 冻结范围＝整片挂载区：焦点落在 tab 按钮上时，重排 tab 条同样会把正被按的那颗换掉
      area: this.root,
      // 装载动作＝重画整片（tab 出现条件读维度存在性，内容变了栏可能增减）
      load: () => this.render(),
      wire: (editor, change) => deps.wire(editor, change),
      onChange: (kind) => deps.onChange(kind),
      onFocus: (editor) => deps.onFocus(editor),
      // 面包屑：普通点＝就地展开；展开根行首的「收起上下文」＝逐层退回
      onExpandContext: (ancestorId, rowId) => this.expand(ancestorId, rowId),
      onContextBack: (rootId) => this.collapse(rootId),
    })

    this.bodyEl.append(this.emptyEl, this.block.root)
    this.root.append(this.summaryEl, this.tabsEl, this.bodyEl)

    this.render()
  }

  /** 编辑器实例（折叠／空 tab 时可能还没有）。装配层用它判「活动编辑器」 */
  get blockEditor(): BlockEditor | null {
    return this.block.ed
  }

  /** 摘掉实例（装配层在段根换人时调）：退订 store、卸事件，别让游离容器继续被重画 */
  dispose(): void {
    this.block.dispose()
  }

  /** 展开/收起（视图状态，不进库） */
  setOpen(open: boolean): void {
    if (this.open === open) return
    this.open = open
    this.render()
  }

  render(focusHint?: string): void {
    const host = this.deps.host()
    if (!host) {
      this.root.hidden = true
      return
    }
    // 段落换人：上一段的展开栈没有意义
    if (this.hostId !== host.id) {
      this.hostId = host.id
      this.expandedByTab.clear()
      this.covers = new Map()
    }
    this.root.hidden = false
    this.tabs = mountTabsOf(host, this.deps.kb.roots())

    // 栏可能被摘掉：激活项不在了就回落到第一条，而不是留一个空 body
    if (!this.tabs.some((tab, i) => keyOf(tab, this.userIndexAt(i)) === this.active)) this.active = this.tabs[0] ? keyOf(this.tabs[0], 0) : ''
    const activeAt = this.activeIndex()

    this.root.dataset.open = this.open ? '1' : '0'
    this.summaryEl.hidden = this.open
    this.tabsEl.hidden = !this.open
    this.bodyEl.hidden = !this.open

    if (!this.open) {
      // 折叠只给「引用 N」：另两栏要算一遍查询，一行摘要不值得
      const refs = this.countRefs(host)
      this.summaryEl.textContent = `${t('ui.mount.refs')} ${t('ui.mount.count', { count: refs })}`
      return
    }

    this.renderTabs(host, activeAt)
    if (activeAt < 0) {
      this.showEmpty(t('ui.mount.empty.user'))
      return
    }
    this.load(host, this.tabs[activeAt]!, focusHint)
  }

  /* ------------------------------------------------------------ tab 条 */

  private userIndexAt(i: number): number {
    // 用户栏的序＝它在 `_mounts` 数组里的位置；内置栏在前，所以「前面有几个 user」
    let n = -1
    for (let k = 0; k <= i; k++) if (this.tabs[k]!.kind === 'user') n++
    return n
  }

  private activeIndex(): number {
    return this.tabs.findIndex((tab, i) => keyOf(tab, this.userIndexAt(i)) === this.active)
  }

  private renderTabs(host: Block, activeAt: number): void {
    this.tabsEl.textContent = ''
    this.tabs.forEach((tab, i) => {
      const userIndex = this.userIndexAt(i)
      const wrap = document.createElement('div')
      wrap.className = 'mount-tabwrap'
      wrap.dataset.tab = keyOf(tab, userIndex)
      wrap.dataset.kind = tab.kind

      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'mount-tab'
      btn.setAttribute('role', 'tab')
      btn.dataset.tab = keyOf(tab, userIndex)
      btn.textContent = tab.kind === 'user' ? (tab.label ?? '') : t(BUILTIN_LABEL[tab.kind] as MsgId)
      btn.addEventListener('click', () => this.activate(keyOf(tab, userIndex)))
      wrap.appendChild(btn)

      // 内置三栏不可摘：它们不落盘，摘了也没有「摘掉」的落点；用户栏才有 ×
      if (tab.kind === 'user' && this.deps.onRemoveTab) {
        const x = document.createElement('button')
        x.type = 'button'
        x.className = 'mount-x'
        x.textContent = '×'
        x.title = t('ui.mount.remove')
        x.dataset.tab = keyOf(tab, userIndex)
        x.addEventListener('click', (e) => {
          e.stopPropagation()
          this.deps.onRemoveTab?.(host.id, userIndex)
          /**
           * 用户栏的下标是数组位：摘掉一栏之后，`user:1` 会变成另一栏。
           * 展开栈按 tab 键记账，键全都会漂 ⇒ 整批清掉，宁可从收起态重来。
           */
          this.expandedByTab.clear()
          this.covers = new Map()
          /**
           * 当场重画：焦点在这颗 × 上，而 store 订阅在「焦点在本视图里」时会**跳过**
           * （那是「打字时别把行抽走」的保护）。不补这一次，用户会看到「点了 × 没反应」。
           */
          this.render()
        })
        wrap.appendChild(x)
      }
      if (i === activeAt) wrap.dataset.active = '1'
      this.tabsEl.appendChild(wrap)
    })

    // 「＋」只给能配用户栏的宿主（过去的日记天不给：那一栏没有落点）
    if (this.deps.onAddTab && canEditMounts(host)) {
      const add = document.createElement('button')
      add.type = 'button'
      add.className = 'mount-add'
      add.textContent = '＋'
      add.title = t('ui.mount.add')
      add.addEventListener('click', () => this.deps.onAddTab?.(host.id))
      this.tabsEl.appendChild(add)
    }

    // 收起：折叠态之后只剩一行摘要。日记流里「今天展开、更早的一行摘要」靠它切换
    const collapse = document.createElement('button')
    collapse.type = 'button'
    collapse.className = 'mount-collapse'
    collapse.textContent = t('ui.mount.collapse')
    collapse.title = t('ui.mount.collapse')
    collapse.addEventListener('click', () => this.setOpen(false))
    this.tabsEl.appendChild(collapse)
  }

  private activate(key: string): void {
    if (this.active === key) return
    this.active = key
    const host = this.deps.host()
    if (host) this.renderTabs(host, this.activeIndex())
    if (host) {
      const at = this.activeIndex()
      if (at >= 0) this.load(host, this.tabs[at]!)
    }
  }

  /* ------------------------------------------------------------ body */

  private load(host: Block, tab: MountTab, focusHint?: string): void {
    const base = this.rootsFor(host, tab)
    const plan = expandContexts(base, this.expandedFor(this.active), (id) => this.deps.kb.pathOf(id), focusHint)
    // 过期的展开 id 当场剪掉：下次再出现同 id 时不该「自己又展开」
    this.expandedByTab.set(this.active, plan.expanded)
    this.covers = plan.covers
    if (plan.roots.length === 0) {
      this.showEmpty(t(EMPTY_TEXT[tab.kind]))
      // 空结果也保留这份视图的折叠态：它记的是「哪些行收着」，不是「这次有几行」
      this.block.ed?.loadPage({ roots: [], folded: this.block.ed.doc.folded })
      return
    }
    const ed = this.block.ensureEditor()
    this.emptyEl.hidden = true
    this.editorEl.hidden = false
    delete this.editorEl.dataset.empty
    const folded = unfoldForContext(ed.doc.folded, plan.covers, (id) => this.deps.kb.pathOf(id))
    ed.loadPage({ roots: plan.roots, folded, contexts: plan.contexts, expandedRoots: plan.contextRoots })
    if (plan.focusId) ed.reveal(plan.focusId)
  }

  /** 当前 tab 的展开栈（懒建；每个 tab 一份） */
  private expandedFor(key: string): Set<string> {
    let set = this.expandedByTab.get(key)
    if (!set) {
      set = new Set()
      this.expandedByTab.set(key, set)
    }
    return set
  }

  /**
   * 普通点面包屑：把那个祖先装成这一栏的根，**中心／历史不动**。
   * `rowId` 是点击那一格所在的行；`expandContexts` 用它算展开后滚到哪条命中。
   */
  private expand(ancestorId: string, rowId: string): void {
    if (!ancestorId) return
    this.expandedFor(this.active).add(ancestorId)
    this.render(rowId || undefined)
  }

  /** 「收起上下文」：只收这一层；内层还留在栈里，下一次渲染会浮出来 */
  private collapse(rootId: string): void {
    const set = this.expandedFor(this.active)
    if (!set.delete(rootId)) return
    this.render(this.covers.get(rootId)?.[0])
  }

  private showEmpty(text: string): void {
    this.emptyEl.textContent = text
    this.emptyEl.hidden = false
    this.editorEl.hidden = true
    this.editorEl.dataset.empty = '1'
  }

  /**
   * 一栏的 roots（＋ 每个装载根的面包屑）。
   *
   * 「引用」走索引的入向边表（与反链 footer 同一条数），其余走查询——
   * 两条路都必须**剔除宿主自己**：它是位置的性质，不是条件的性质。
   */
  private rootsFor(host: Block, tab: MountTab): MountRoots {
    if (tab.kind === 'refs') return this.refRoots(host)
    /**
     * `$self` 的解析**不在这里**：查询求值的第一步就按 `selfId` 解析（两条求值路径共用那一份）。
     * 这里只声明「谁是宿主」，免得同一份条件在 UI 与 core 各解释一遍。
     */
    const hits = this.deps.kb.query(tab.spec, { selfId: host.id })
    return this.topLevel(
      hits.map((h) => ({
        id: h.blockId,
        // `QueryHit.path` 已经是「根 → 父」（不含自己），正是面包屑要的那一段
        path: h.path.map((id) => this.deps.store.find(id)).filter((b): b is Block => b !== undefined),
      })),
    )
  }

  private refRoots(host: Block): MountRoots {
    const sources = this.deps.kb
      .backrefBlocksOf(host.id)
      .filter((s) => s.blockId !== host.id)
      // 路径只取一次：topLevel 判「祖先也在结果里」和面包屑用的是同一份
      .map((s) => ({ id: s.blockId, path: this.deps.kb.pathOf(s.blockId).slice(0, -1) }))
    return this.topLevel(sources)
  }

  /**
   * 只留**最外层**命中：祖先也在结果里时，那一块会被祖先的子树渲染出来，
   * 再单列一次就是同一个块出现两遍。顺序沿用命中顺序（查询的「冻结」需要它稳定）。
   *
   * `path` 是**祖先链（不含自己）**：它同时是「最外层」的判据与根行的面包屑。
   */
  private topLevel(hits: readonly { id: string; path: readonly Block[] }[]): MountRoots {
    const ids = new Set(hits.map((h) => h.id))
    const roots: Block[] = []
    const contexts = new Map<string, readonly Block[]>()
    for (const h of hits) {
      if (h.path.some((p) => ids.has(p.id))) continue
      const live = this.deps.store.find(h.id)
      if (!live) continue
      roots.push(live)
      // 顶层根没有祖先 ⇒ 不画面包屑（它自己那一行已经有名字了）
      if (h.path.length > 0) contexts.set(h.id, h.path)
    }
    return { roots, contexts }
  }

  private countRefs(host: Block): number {
    return this.refRoots(host).roots.length
  }
}
