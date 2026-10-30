/**
 * **块的挂载区**：块底那一栏「引用／同类／提及 ＋ 用户挂的查询」，一条 tab 条 ＋ 一个 body。
 *
 * 三条口径落在这一层：
 *   · **一个编辑器，N 个 loader**：切 tab 只换 `loadPage` 的 roots。编辑器不重建，
 *     所以撤销栈与选区都不丢（重建一次，用户按 ⌘Z 就只能撤到「刚切过 tab」）。
 *   · **tab 不是块**：`local` 栏自己拥有条件与视图（不建块），`linked` 栏只存
 *     「指向哪一块 ＋ 哪张视图」，`derived` 栏每次现算。增删交给装配层的命令
 *     （「写到哪一格」是模型层的事：块宿主写 `_mounts`、日记宿主写设备状态）。
 *   · **空栏仍在**：栏在、body 里一行说明。空是**状态**不是错误，把栏藏掉
 *     会让用户以为「这块没有引用」，而真相是「还没有人引用它」。
 *
 * ## 稳定 id
 *
 * 每栏有一个稳定 `id`（内置栏 `d-<source>`、用户栏 `t-<hex>`）；数组位只表示顺序。
 * 激活项／展开栈／视图体都按 `id` 记 —— 用**数组下标**当下标的后果是
 * 摘掉第一栏之后 active 与展开栈全体漂到别一栏上，而不报错。
 *
 * 编辑器装配（建实例、订阅、防抖重载、聚焦冻结、离焦补做、事件表）全部在
 * `EditableBlock` 里；这一层只决定**装哪些根**（哪一栏、展开到哪层、面包屑怎么给）。
 *
 * ⚠️ 与右槽的分工：右槽的 `backrefsCard` 是**页级派生卡**（读当前对象、跟着它走）。
 *    挂载区是「在这一块下面就地展开」。硬统一会得到两份各自记激活项的 tab 条。
 * ⚠️ 这里不碰命令、不认识浮层：`＋`／`×` 只回调装配层。
 */
import {
  canEditMounts,
  derivedSpecOf,
  displayNameOf,
  expandContexts,
  isJournal,
  mountEntriesOf,
  readViewSet,
  resolveBoundView,
  unfoldForContext,
  type Block,
  type BlockStore,
  type MountEntry,
  type MountHost,
  type ViewOwnerStore,
  type ViewConfig,
  type QuerySpec,
} from '../core/index.ts'
import type { KbClient } from '../core/kb/types.ts'
import { t, type MsgId } from '../core/msg.ts'
import { type BlockEditor, type Run } from '../view/editor.ts'
import { EditableBlock } from './editable-block.ts'

/** 非大纲那一栏的**视图体**（由装配层造：只有那里有完整依赖） */
export interface ViewBodyHost {
  root: HTMLElement
  mount(): void
  sync(): void
  dispose(): void
}

export interface MountAreaDeps {
  store: BlockStore
  /** 写入事务入口：执行者在装配层，这里只原样转给编辑器（见 `Run`） */
  write: Run
  /** 读门面：三栏的数据都按 id 取（反链查表、查询走索引、祖先链按 id 现读） */
  kb: KbClient
  /** 视图配置的唯一接缝（读拥有者/绑定） */
  owners: ViewOwnerStore
  /** 日记宿主的那一组（设备状态；由装配层从 prefs 取） */
  journalMounts: () => readonly MountEntry[]
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
  /** 「×」：摘掉一栏（`tabId` 是**稳定 id**，不是数组下标） */
  onRemoveTab?: (host: MountHost, tabId: string) => void
  /**
   * 这一栏非大纲时用的视图体（local／linked 栏可以有表格等看法）。
   *
   * 返回 `null` ⇒ 这一栏画大纲。由装配层造，因为「求值的上下文」与「写事务的 source」
   * 只有那一层答得出来。
   */
  createView?: (host: Block, entry: MountEntry) => ViewBodyHost | null
  /**
   * 初始是否展开。日记流里只有今天展开，更早的天是一行摘要（一行 DOM ＋ 不建编辑器）。
   */
  expanded?: boolean
}

/** 一栏装载什么：根块 ＋ 每个根行的面包屑（祖先链，不含自己） */
interface MountRoots {
  roots: Block[]
  contexts: Map<string, readonly Block[]>
}

const BUILTIN_LABEL: Record<'refs' | 'same' | 'mentions', MsgId> = {
  refs: 'ui.mount.refs',
  same: 'ui.mount.same',
  mentions: 'ui.mount.mentions',
}

const EMPTY_TEXT: Record<MountEntry['kind'], MsgId> = {
  derived: 'ui.mount.empty.user',
  local: 'ui.mount.empty.user',
  linked: 'ui.mount.empty.user',
}

export class MountArea {
  readonly root: HTMLElement
  private readonly deps: MountAreaDeps
  /** tab 条（展开时可见） */
  private readonly tabsEl: HTMLElement
  private readonly bodyEl: HTMLElement
  private readonly editorEl: HTMLElement
  /** 非大纲那一栏的视图体槽 */
  private readonly viewEl: HTMLElement
  private readonly emptyEl: HTMLElement
  /** 折叠时那一行摘要（只有「引用 N」——同类／提及的计数要现算，折叠时不值得算） */
  private readonly summaryEl: HTMLButtonElement
  /**
   * 那**一个**编辑器装配。懒建由它自己管：折叠的天、空的栏不建实例（30 天 feed
   * 只该有一个编辑器），建了就一直复用（切 tab 不重建 ⇒ 撤销栈与选区都不丢）。
   */
  private readonly block: EditableBlock
  private entries: MountEntry[] = []
  /** 当前激活那一栏的 **id**；找不到（栏被摘掉了）就回落到第一栏 */
  private active = ''
  private open: boolean
  /**
   * 每栏的**上下文展开栈**（祖先 id），按 `id` 记。视图状态，不落盘。
   * 每栏各记各的：在「引用」里展开的上下文不会突然出现在「同类」。
   */
  private readonly expandedByTab = new Map<string, Set<string>>()
  /** 上次装载的「上下文根 → 覆盖的命中行」；收起一层时用它算滚回哪 */
  private covers: ReadonlyMap<string, readonly string[]> = new Map()
  /** 这一段是谁；段落换人时清空展开状态 */
  private hostId = ''
  /** 当前这一栏的视图体（非大纲时才有） */
  private view: ViewBodyHost | null = null
  /** 视图体对应哪一栏的哪张视图（变了才重建） */
  private viewKey = ''
  /** 上一次读到的那组条目的串（`refreshEntries` 用它判「要不要重排」） */
  private entrySig = ''

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

    this.viewEl = document.createElement('div')
    this.viewEl.className = 'mount-view'
    this.viewEl.hidden = true

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
      // 装载动作＝重画整片（栏出现条件读维度存在性，内容变了栏可能增减）
      load: () => this.render(),
      wire: (editor, change) => deps.wire(editor, change),
      onChange: (kind) => deps.onChange(kind),
      onFocus: (editor) => deps.onFocus(editor),
      // 面包屑：普通点＝就地展开；展开根行首的「收起上下文」＝逐层退回
      onExpandContext: (ancestorId, rowId) => this.expand(ancestorId, rowId),
      onContextBack: (rootId) => this.collapse(rootId),
    })

    this.bodyEl.append(this.emptyEl, this.block.root, this.viewEl)
    this.root.append(this.summaryEl, this.tabsEl, this.bodyEl)

    this.render()
  }

  /** 编辑器实例（折叠／空栏时可能还没有）。装配层用它判「活动编辑器」 */
  get blockEditor(): BlockEditor | null {
    return this.block.ed
  }

  /** 摘掉实例（装配层在段根换人时调）：退订 store、卸事件，别让游离容器继续被重画 */
  dispose(): void {
    this.detachView()
    this.block.dispose()
  }

  /**
   * **栏集合可能变了**（加/摘/改名/换视图/设备状态里的日记栏）：变了才重排。
   *
   * 为什么不直接 `render()`：那是整条 tab 条重建，会把焦点从用户正按的那颗按钮上
   * 抽走（而这几件事多半正是点击触发的）。判据是**这一组条目本身**的串 ——
   * 它比「上一次是谁在读」更接近事实：内容没变就不该动 DOM。
   */
  refreshEntries(): void {
    const host = this.deps.host()
    if (!host) return
    const next = mountEntriesOf(host, this.deps.kb.roots(), { journalMounts: this.deps.journalMounts() })
    const sig = JSON.stringify(next)
    if (sig === this.entrySig) return
    this.entrySig = sig
    this.render()
  }

  /** 展开/收起（视图状态，不进库） */
  setOpen(open: boolean): void {
    if (this.open === open) return
    this.open = open
    this.render()
  }

  /** 这一段的宿主（`MountHost` 是「这一栏写哪」的唯一判别器） */
  private mountHost(): MountHost {
    const host = this.deps.host()
    if (!host) return { kind: 'block', blockId: '' }
    return isJournal(host) ? { kind: 'journal' } : { kind: 'block', blockId: host.id }
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
    this.entries = mountEntriesOf(host, this.deps.kb.roots(), { journalMounts: this.deps.journalMounts() })
    this.entrySig = JSON.stringify(this.entries)

    // 栏可能被摘掉：激活项不在了就回落到第一栏，而不是留一个空 body
    if (!this.entries.some((e) => e.id === this.active)) this.active = this.entries[0]?.id ?? ''
    const activeAt = this.entries.findIndex((e) => e.id === this.active)

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
    this.load(host, this.entries[activeAt]!, focusHint)
  }

  /* ------------------------------------------------------------ tab 条 */

  private renderTabs(host: Block, activeAt: number): void {
    this.tabsEl.textContent = ''
    const hostRef = this.mountHost()
    this.entries.forEach((entry, i) => {
      const wrap = document.createElement('div')
      wrap.className = 'mount-tabwrap'
      wrap.dataset.tab = entry.id
      wrap.dataset.kind = entry.kind

      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'mount-tab'
      btn.setAttribute('role', 'tab')
      btn.dataset.tab = entry.id
      btn.textContent = this.labelOf(entry)
      btn.addEventListener('click', () => this.activate(entry.id))
      wrap.appendChild(btn)

      // 内置三栏不可摘：它们不落盘，摘了也没有「摘掉」的落点；local／linked 才有 ×
      if ((entry.kind === 'local' || entry.kind === 'linked') && this.deps.onRemoveTab) {
        const x = document.createElement('button')
        x.type = 'button'
        x.className = 'mount-x'
        x.textContent = '×'
        x.title = t('ui.mount.remove')
        x.dataset.tab = entry.id
        x.addEventListener('click', (e) => {
          e.stopPropagation()
          this.deps.onRemoveTab?.(hostRef, entry.id)
          /**
           * 当场重画：焦点在这颗 × 上，而 store 订阅在「焦点在本视图里」时会**跳过**
           * （那是「打字时别把行抽走」的保护）。不补这一次，用户会看到「点了 × 没反应」。
           *
           * ⚠️ 不再整批清展开栈：键是**稳定 id**，摘掉一栏之后其余栏的键一个都不漂。
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
      add.title = t('ui.mount.addMenu')
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

  /**
   * 一栏的 tab 文案。
   *
   * `linked` 栏缺省**叫目标的名字**（改了目标名就跟着变）—— 它只是一根指针，
   * 自己不该有第二个名字；用户想改名才写 `label` 覆盖。
   */
  private labelOf(entry: MountEntry): string {
    if (entry.kind === 'derived') return t(BUILTIN_LABEL[entry.source])
    if (entry.kind === 'local') return entry.label
    if (entry.label !== undefined && entry.label.trim() !== '') return entry.label
    const target = this.deps.kb.get(entry.block)
    if (!target) return t('ui.mount.dangling')
    const name = displayNameOf(target).trim()
    return name === '' ? t('ui.query.untitled') : name
  }

  private activate(id: string): void {
    if (this.active === id) return
    this.active = id
    const host = this.deps.host()
    if (host) this.renderTabs(host, this.entries.findIndex((e) => e.id === this.active))
    const entry = this.entries.find((e) => e.id === this.active)
    if (host && entry) this.load(host, entry)
  }

  /* ------------------------------------------------------------ body */

  private load(host: Block, entry: MountEntry, focusHint?: string): void {
    const view = this.viewOf(entry)
    if (view) {
      this.showView(host, entry, view)
      return
    }
    this.detachView()
    const base = this.rootsFor(host, entry)
    const plan = expandContexts(base, this.expandedFor(entry.id), (id) => this.deps.kb.pathOf(id), focusHint)
    // 过期的展开 id 当场剪掉：下次再出现同 id 时不该「自己又展开」
    this.expandedByTab.set(entry.id, plan.expanded)
    this.covers = plan.covers
    if (plan.roots.length === 0) {
      this.showEmpty(t(EMPTY_TEXT[entry.kind]))
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

  /**
   * 这一栏**现在选的是哪张视图**；`null` ＝ 大纲。
   *
   * `derived` 栏永远大纲（它没有配置——配置是「能不能编辑」的前提）。
   */
  private viewOf(entry: MountEntry): ViewConfig | null {
    if (entry.kind === 'derived') return null
    const hostRef = this.mountHost()
    if (entry.kind === 'local') {
      const data = this.deps.owners.read({ kind: 'tab', host: hostRef, tabId: entry.id })
      return data ? readViewSet(data).active : null
    }
    const target = this.deps.owners.readBinding({ kind: 'linked-tab', host: hostRef, tabId: entry.id })
    if (!target) return null
    const data = this.deps.owners.read(target.owner)
    if (!data) return null
    return resolveBoundView(target, data).view
  }

  private showView(host: Block, entry: MountEntry, view: ViewConfig): void {
    /**
     * 大纲的岛根要**从文档里摘掉**，不能 dispose：
     * `EditableBlock.dispose()` 是终态（退订＋卸事件），而摘掉只是为了让同一块
     * 不在这一屏出现两份 `data-block-id`。切回大纲时再挂回去，撤销栈还在。
     */
    this.block.root.remove()
    this.editorEl.hidden = true
    this.emptyEl.hidden = true
    this.viewEl.hidden = false
    const key = `${entry.id}:${view.id}`
    if (this.viewKey !== key) {
      this.detachView()
      const made = this.deps.createView?.(host, entry) ?? null
      this.viewKey = key
      this.view = made
      if (made) {
        this.viewEl.replaceChildren(made.root)
        made.mount()
        return
      }
    } else {
      this.view?.sync()
      return
    }
    // 装配层没给视图体（这一档还没做渲染器）⇒ 给一句实话而不是空屏
    if (!this.view) {
      this.viewEl.replaceChildren()
      const p = document.createElement('p')
      p.className = 'tv-unsupported'
      p.textContent = t('ui.view.unsupported')
      this.viewEl.appendChild(p)
    }
  }

  private detachView(): void {
    if (this.view) {
      this.view.dispose()
      this.view.root.remove()
    }
    this.view = null
    this.viewKey = ''
    this.viewEl.hidden = true
    this.viewEl.replaceChildren()
    // 摘掉视图体之后把大纲的岛根挂回去（编辑器实例一直还在）
    if (this.block.root.parentElement !== this.bodyEl) this.bodyEl.insertBefore(this.block.root, this.viewEl)
  }

  /** 当前栏的展开栈（懒建；每栏一份，按稳定 id 记） */
  private expandedFor(id: string): Set<string> {
    let set = this.expandedByTab.get(id)
    if (!set) {
      set = new Set()
      this.expandedByTab.set(id, set)
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
    this.detachView()
    this.emptyEl.textContent = text
    this.emptyEl.hidden = false
    this.editorEl.hidden = true
    this.editorEl.dataset.empty = '1'
  }

  /* ------------------------------------------------------------ 数据 */

  /**
   * 一栏的 roots（＋ 每个装载根的面包屑）。
   *
   * 三种栏的**上下文**各不相同，写在这里是唯一的落点：
   *   · `derived`（引用／同类／提及）问的是「谁跟我有关」⇒ **不给子树锚点**：
   *     那些块本来就在别处，把它们关进宿主子树会让这一栏恒空；
   *   · `local`／`linked` 是「这一块下面的…」⇒ 锚点＝宿主块（与中心查询块同一条口径：
   *     它的锚点也是它所在的容器）。
   *
   * ⚠️ `excludeIds` 与 `selfId` **分开给**：`selfId` 只负责解析 `'$self'`，
   *    剔除走 `excludeIds`。两者曾经是同一个字段，于是「想解析它，又不得不排除它」
   *    这种形状无法表达。
   */
  private rootsFor(host: Block, entry: MountEntry): MountRoots {
    if (entry.kind === 'derived') {
      const spec = derivedSpecOf(host, this.deps.kb.roots(), entry.source)
      if (!spec) return { roots: [], contexts: new Map() }
      const hits = this.deps.kb.query(spec, { selfId: host.id, excludeIds: [host.id] })
      return this.topLevel(hits)
    }
    const hostRef = this.mountHost()
    const excludeIds = [host.id]
    if (entry.kind === 'linked') excludeIds.push(entry.block)
    const spec = this.specFor(hostRef, entry)
    if (!spec) return { roots: [], contexts: new Map() }
    const hits = this.deps.kb.query(spec, { selfId: host.id, scopeId: host.id, excludeIds })
    return this.topLevel(hits)
  }

  /** 一栏的条件：`local` 自己带着；`linked` 读目标块的 `_query`（**一份条件**） */
  private specFor(hostRef: MountHost, entry: MountEntry): QuerySpec | null {
    if (entry.kind === 'local') return entry.spec
    const target = this.deps.owners.readBinding({ kind: 'linked-tab', host: hostRef, tabId: entry.id })
    if (!target) return null
    return this.deps.owners.read(target.owner)?.query ?? null
  }

  private topLevel(hits: readonly { blockId: string; path: string[] }[]): MountRoots {
    const ids = new Set(hits.map((h) => h.blockId))
    const roots: Block[] = []
    const contexts = new Map<string, readonly Block[]>()
    for (const h of hits) {
      if (h.path.some((id) => ids.has(id))) continue
      const live = this.deps.store.find(h.blockId)
      if (!live) continue
      roots.push(live)
      // 顶层根没有祖先 ⇒ 不画面包屑（它自己那一行已经有名字了）
      if (h.path.length > 0) {
        contexts.set(
          h.blockId,
          h.path.map((id) => this.deps.store.find(id)).filter((b): b is Block => b !== undefined),
        )
      }
    }
    return { roots, contexts }
  }

  /** 「引用 N」：与展开态那一栏同一条口径（入向边表，剔除宿主自己） */
  private countRefs(host: Block): number {
    const ids = new Set<string>()
    for (const s of this.deps.kb.backrefBlocksOf(host.id)) if (s.blockId !== host.id) ids.add(s.blockId)
    return ids.size
  }
}
