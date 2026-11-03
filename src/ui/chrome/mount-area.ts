/**
 * **块的挂载区**：块底那一栏「引用／同类／提及 ＋ 用户挂的查询」，一条 tab 条 ＋ 一个 body。
 *
 * 三条口径落在这一层：
 *   · **一个编辑器，N 个 loader**：切 tab 只换 `loadPage` 的 roots。编辑器不重建，
 *     所以撤销栈与选区都不丢（重建一次，用户按 ⌘Z 就只能撤到「刚切过 tab」）。
 *   · **tab 不是块**：`local` 栏自己拥有条件与视图（不建块、也不指向块），
 *     `derived` 栏每次现算。增删交给装配层的命令
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
 * ⚠️ 与右槽的分工：右槽的 `backrefsCard` 是**页级派生卡**（读当前对象、跟着它走），
 *    判据与这里的「引用」栏**同源**（都走 `derivedRecordsOf`），差别只在落点：
 *    槽里是「另一处的摘要」，这里是「在这一块下面就地展开」。
 *    硬统一会得到两份各自记激活项的 tab 条。
 * ⚠️ 这里不碰命令、不认识浮层：`＋`／`×` 只回调装配层。
 */
import {
  canEditMounts,
  derivedRecordsOf,
  derivedSpecOf,
  expandContexts,
  hasLiveChildren,
  isJournal,
  mountEntriesOf,
  readViewSet,
  unfoldForContext,
  DERIVED_VIEW_KINDS,
  type Block,
  type BlockStore,
  type DerivedSource,
  type DerivedViewKind,
  type MountEntry,
  type MountHost,
  type ViewOwnerStore,
  type ViewConfig,
  type ViewRecord,
} from '../../core/index.ts'
import type { FoldState } from '../../core/index.ts'
import type { KbClient } from '../../core/kb/types.ts'
import { t, type MsgId } from '../../core/infra/msg.ts'
import { type BlockEditor, type Run } from '../../view/editor/editor.ts'
import { EditableBlock } from '../block-ui/editable-block.ts'
import { bindDropTarget, setDragTab } from '../../view/dnd.ts'

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
   * **双击改名**（只有 local 栏有名字；派生栏的名字由来源字典给）。
   *
   * 输入框在装配层弹：这一层不认识浮层、也不碰命令。`anchor` 是那一栏的矩形
   * —— 浮层贴着用户点的那个 tab，而不是屏幕中央（「改的是哪一个」由位置回答）。
   */
  onRenameTab?: (host: MountHost, tabId: string, anchor: DOMRect) => void
  /**
   * **拖拽换序**：把 `tabId` 挪到 `targetId` 的前／后。
   *
   * 顺序＝那一格数组的位次（`_mounts` / `Prefs.journalMounts`），写内容、可撤销。
   * 派生栏与用户栏可以互相越位（派生栏落进去的只是一条位置标记）。
   * 与改名同一个形状：这一层只报「谁挪到了谁旁边」，写哪一格与命令都在装配层。
   */
  onMoveTab?: (host: MountHost, tabId: string, targetId: string, place: 'before' | 'after') => void
  /**
   * 派生栏现在选了什么看法（**设备状态**：没有拥有者）。
   *
   * 由装配层现读 `Prefs`；这一层不碰偏好，也不写它 —— 写走 `setDerivedKind`。
   */
  derivedKind?: (host: Block, source: DerivedSource) => DerivedViewKind
  /** 切派生栏的看法（装配层写设备状态并重画这一栏） */
  setDerivedKind?: (host: Block, source: DerivedSource, kind: DerivedViewKind) => void
  /**
   * 这一栏非大纲时用的视图体（local 栏可以有表格等看法）。
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

const BUILTIN_LABEL: Record<DerivedSource, MsgId> = {
  refs: 'ui.mount.refs',
  members: 'ui.mount.members',
  same: 'ui.mount.same',
  mentions: 'ui.mount.mentions',
}

const EMPTY_TEXT: Record<MountEntry['kind'], MsgId> = {
  derived: 'ui.mount.empty.user',
  local: 'ui.mount.empty.user',
}

/** 派生栏空态：三种来源各自说一句实话（「还没有人引用它」≠「条件没匹配」） */
const DERIVED_EMPTY: Record<DerivedSource, MsgId> = {
  refs: 'ui.mount.empty.refs',
  members: 'ui.mount.empty.members',
  same: 'ui.mount.empty.same',
  mentions: 'ui.mount.empty.mentions',
}

/** 派生栏的**只读**条件说明（它没有条件可编辑，也没有构建器落点） */
const DERIVED_WHY: Record<DerivedSource, MsgId> = {
  refs: 'ui.mount.why.refs',
  members: 'ui.mount.why.members',
  same: 'ui.mount.why.same',
  mentions: 'ui.mount.why.mentions',
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
  /**
   * 派生栏的抬头：`引用 · 12 条  [大纲] [列表] [表格]  ⋯`。
   *
   * 为什么要它（而不是复用视图宿主那条抬头）：派生栏没有拥有者 —— 抬头里的
   * 「这一栏是什么」是它唯一能说清自己的地方，而「切看法」写的是设备状态。
   */
  private readonly derivedHeadEl: HTMLElement
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
  /**
   * 哪些派生栏已经播过「关联型默认折叠」（**按栏记**：一个编辑器 N 个 loader，
   * 切 tab 只换 roots、编辑器不重建，所以 `doc.folded` 是几栏共用的）。
   */
  private readonly foldSeeded = new Set<string>()
  /** 这一段是谁；段落换人时清空展开状态 */
  private hostId = ''
  /** 现挂在视图槽里的那一个（local 栏按栏缓存；派生栏现造现弃） */
  private view: ViewBodyHost | null = null
  /** 现造现弃的那一个（派生栏）：detach 时要 dispose；local 的在缓存里，只摘不弃 */
  private ownedView: ViewBodyHost | null = null
  /**
   * **local 栏的视图宿主，按栏缓存**（含大纲）。
   *
   * 大纲归了视图宿主之后，一栏一个实例：切 tab 不重建 ⇒ 面包屑展开栈、冻结结果、
   * 条件树草稿各栏各持，来回切不丢；同一栏里切看法也不换实例
   * （`mount()` ⇒ `sync()` 自会按激活视图换分支）。段落换人／栏被摘掉时成批弃。
   */
  private readonly tabViews = new Map<string, ViewBodyHost>()
  /** 引用栏的 kind 过滤（大纲专用设备状态；切到表格时由「类型」列承担同一件事） */
  private refKind: 'all' | 'inline' | 'property' | 'embed' = 'all'
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

    this.derivedHeadEl = document.createElement('div')
    this.derivedHeadEl.className = 'mount-derived-head'
    this.derivedHeadEl.hidden = true

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

    this.bodyEl.append(this.derivedHeadEl, this.emptyEl, this.block.root, this.viewEl)
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
    for (const v of this.tabViews.values()) v.dispose()
    this.tabViews.clear()
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
    const next = this.entriesFor(host)
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

  /**
   * 从装配层点名激活某一栏（新建栏之后跳过去看它）。
   * 栏不在这份条目里就什么都不做 —— 那是「这一栏已经不在了」，不是静默失败。
   */
  activateTab(tabId: string): void {
    if (!this.entries.some((e) => e.id === tabId)) return
    this.activate(tabId)
  }

  /** 这一段的宿主（`MountHost` 是「这一栏写哪」的唯一判别器） */
  private mountHost(): MountHost {
    const host = this.deps.host()
    if (!host) return { kind: 'block', blockId: '' }
    return isJournal(host) ? { kind: 'journal' } : { kind: 'block', blockId: host.id }
  }

  /**
   * 这一屏该有哪些栏：内置（按宿主类型＋设备顺序）在前，存下来的用户栏在后。
   *
   * 两处读者（`render` 与重排比较）必须同一份判据，否则 `entrySig` 会和实际画的
   * 不是同一份东西——「顺序变了但签名没变」会静默不重画。
   */
  private entriesFor(host: Block): MountEntry[] {
    return mountEntriesOf(host, { journalMounts: this.deps.journalMounts() })
  }

  render(focusHint?: string): void {
    const host = this.deps.host()
    if (!host) {
      this.root.hidden = true
      return
    }
    // 段落换人：上一段的展开栈与各栏的视图宿主都没有意义
    if (this.hostId !== host.id) {
      this.hostId = host.id
      this.expandedByTab.clear()
      this.covers = new Map()
      this.refKind = 'all'
      for (const v of this.tabViews.values()) v.dispose()
      this.tabViews.clear()
    }
    this.root.hidden = false
    this.entries = this.entriesFor(host)
    this.entrySig = JSON.stringify(this.entries)
    // 栏被摘掉：它的视图宿主一起退（订阅还挂着的话，游离容器会被白重画）
    if (this.tabViews.size > 0) {
      const alive = new Set(this.entries.map((e) => e.id))
      for (const [id, v] of this.tabViews) {
        if (alive.has(id)) continue
        v.dispose()
        this.tabViews.delete(id)
      }
    }

    // 栏可能被摘掉：激活项不在了就回落到第一栏，而不是留一个空 body
    if (!this.entries.some((e) => e.id === this.active)) this.active = this.entries[0]?.id ?? ''
    const activeAt = this.entries.findIndex((e) => e.id === this.active)

    this.root.dataset.open = this.open ? '1' : '0'
    this.summaryEl.hidden = this.open
    this.tabsEl.hidden = !this.open
    this.bodyEl.hidden = !this.open

    if (!this.open) {
      /**
       * 折叠摘要跟**第一栏**走：标签页的第一栏是「成员」，普通块是「引用」。
       * 不写死「引用 N」——那会让标签页折叠时显示一个通常为 0 的数字，
       * 而它真正的成员在另一栏。
       */
      const first = this.entries[0]
      if (first?.kind === 'derived') {
        const count = derivedRecordsOf(host, this.deps.kb, first.source).length
        this.summaryEl.textContent = `${t(BUILTIN_LABEL[first.source])} ${t('ui.mount.count', { count })}`
      } else {
        this.summaryEl.textContent = t('ui.mount.expand')
      }
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
      /**
       * 改名只有 local 栏有：双击就地弹输入框（与浏览器标签页、其它编辑器同一套手势）。
       * `title` 是给「不知道能双击」的人的唯一提示 —— 不另立一颗铅笔图标：
       * 那一栏的 chrome 已经有两件（名字、×），再加一件会把 4 个字的宽度吃掉。
       */
      if (entry.kind === 'local' && this.deps.onRenameTab) {
        btn.title = t('ui.mount.renameHint')
        btn.addEventListener('dblclick', (e) => {
          e.preventDefault()
          this.deps.onRenameTab?.(hostRef, entry.id, btn.getBoundingClientRect())
        })
      }
      /**
       * **拖拽换序**：整条 tab 条一条顺序，所以派生栏与用户栏互为落点（可以互相越位）。
       * 写哪一格由命令层按宿主判；这一层只报「谁挪到了谁旁边」。
       * 过去的日记天不给拖：那一格是共享配置，改了会影响今天。
       */
      const canDrag = Boolean(this.deps.onMoveTab) && canEditMounts(host)
      if (canDrag) {
        btn.draggable = true
        btn.addEventListener('dragstart', (e) => {
          setDragTab(e.dataTransfer, entry.id)
          wrap.dataset.dragging = '1'
        })
        btn.addEventListener('dragend', () => {
          delete wrap.dataset.dragging
        })
        const placeOf = (e: DragEvent): 'before' | 'after' => {
          const r = wrap.getBoundingClientRect()
          return e.clientX < r.left + r.width / 2 ? 'before' : 'after'
        }
        bindDropTarget(wrap, {
          kind: 'tab',
          effect: 'move',
          targetId: () => entry.id,
          // 拖到自己那格没有意义（模型层也会拒），这里连高亮都不亮。
          accept: (id) => id !== entry.id,
          hint: () => t('ui.dnd.moveTab'),
          mark: (_id, e) => {
            wrap.dataset[placeOf(e) === 'before' ? 'dropBefore' : 'dropAfter'] = '1'
          },
          unmark: () => {
            delete wrap.dataset.dropBefore
            delete wrap.dataset.dropAfter
          },
          onDrop: (id, _target, e) => {
            if (id === entry.id) return
            this.deps.onMoveTab?.(hostRef, id, entry.id, placeOf(e))
          },
        })
      }
      wrap.appendChild(btn)

      // 内置派生栏不可摘：它们不落盘，摘了也没有「摘掉」的落点；local 才有 ×
      if (entry.kind === 'local' && this.deps.onRemoveTab) {
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
      add.title = t('ui.mount.addLocalHint')
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

  /** 一栏的 tab 文案：local 用它自己的 label，derived 由来源字典给 */
  private labelOf(entry: MountEntry): string {
    return entry.kind === 'derived' ? t(BUILTIN_LABEL[entry.source]) : entry.label
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
    if (entry.kind === 'derived') {
      this.loadDerived(host, entry, focusHint)
      return
    }
    /**
     * local 栏**整台都归视图宿主**（大纲也不例外）：抬头（条数/条件/切换/刷新）
     * 由宿主统一画在右侧，条件 chip 与条件树处处可改。
     * 过去大纲走挂载区自己的编辑器，「大纲改不了条件」与「切换下拉忽左忽右」
     * 是同一个根因——两台身体各画各的。
     */
    this.derivedHeadEl.hidden = true
    this.showView(host, entry)
  }

  private loadDerived(host: Block, entry: Extract<MountEntry, { kind: 'derived' }>, focusHint?: string): void {
    const kind = this.deps.derivedKind?.(host, entry.source) ?? 'outline'
    /**
     * **维度不存在**（这一块没有标签 ⇒ 同类；没有可读文本 ⇒ 提及）：tab 常驻，
     * body 里说**原因**，而不是走「条件没匹配到」那套通用空态。
     * 也不建视图宿主：列表/表格在这个维度上同样没有东西可画。
     */
    if (derivedSpecOf(host, this.deps.kb.roots(), entry.source) === null) {
      this.detachView()
      this.renderDerivedHead(host, entry, kind, 0)
      this.showEmpty(
        t(
          entry.source === 'same'
            ? 'ui.mount.empty.sameNoTags'
            : entry.source === 'mentions'
              ? 'ui.mount.empty.mentionsNoText'
              : DERIVED_EMPTY[entry.source],
        ),
      )
      return
    }
    const all = derivedRecordsOf(host, this.deps.kb, entry.source)
    /**
     * kind 过滤只作用于**大纲**：列表/表格走视图宿主的记录源，那里用「类型」列
     * 承担同一件事。否则会出现「抬头条数是过滤后的、表里是全部」的假数字。
     */
    const records =
      entry.source === 'refs' && kind === 'outline' && this.refKind !== 'all'
        ? all.filter((r) => {
            const keys = r.derived?.relKindKeys
            return Array.isArray(keys) && keys.includes(this.refKind)
          })
        : all
    this.renderDerivedHead(host, entry, kind, records.length, all)
    const view = this.viewOf(entry)
    if (view) {
      this.showView(host, entry)
      return
    }
    this.detachView()
    /**
     * 大纲只画**顶层**（祖先与子孙同时命中时，子块由祖先那一行自己展开）：
     * 计数仍按记录条数（与列表/表格同一个数字）。
     */
    const ids = new Set(records.map((r) => r.block.id))
    const roots: Block[] = []
    const contexts = new Map<string, readonly Block[]>()
    for (const r of records) {
      if (r.path.some((p) => ids.has(p.id))) continue
      roots.push(r.block)
      if (r.path.length > 0) contexts.set(r.block.id, r.path)
    }
    const empty =
      entry.source === 'refs' && this.refKind !== 'all'
        ? 'ui.mount.empty.refsKind'
        : DERIVED_EMPTY[entry.source]
    this.loadOutline(entry, { roots, contexts }, focusHint, empty)
  }

  /** 大纲装载（local／派生共用的那一支） */
  private loadOutline(entry: MountEntry, base: MountRoots, focusHint?: string, emptyText?: MsgId): void {
    const plan = expandContexts(base, this.expandedFor(entry.id), (id) => this.deps.kb.pathOf(id), focusHint)
    // 过期的展开 id 当场剪掉：下次再出现同 id 时不该「自己又展开」
    this.expandedByTab.set(entry.id, plan.expanded)
    this.covers = plan.covers
    if (plan.roots.length === 0) {
      this.showEmpty(t(emptyText ?? EMPTY_TEXT[entry.kind]))
      // 空结果也保留这份视图的折叠态：它记的是「哪些行收着」，不是「这次有几行」
      this.block.ed?.loadPage({ roots: [], folded: this.block.ed.doc.folded })
      return
    }
    const ed = this.block.ensureEditor()
    this.emptyEl.hidden = true
    this.editorEl.hidden = false
    delete this.editorEl.dataset.empty
    /**
     * **关联型引用默认折叠**（派生栏专用）：引用／提及／同类这三栏的每一行都是
     * 「因为一条边而出现」—— `[[引用]]`、`#标签`，**全是关联型**，不是靠祖先带进来的
     * （那种叫传递型，得等「命中块的子孙也进结果」才有）。
     * 虎鲸的口径正是：关联型默认折叠（只给那一行），传递型默认展开（好看出属于哪一片）。
     *
     * ⚠️ **只播种一次**（按栏记）：用户手动展开某一行以后不许再覆盖 ——
     *    否则每次重画都把人刚展开的又折回去。
     * ⚠️ **必须写回 `doc.folded`**：挂载区会重画，只在返回值里播种会
     *    「闪一下折着、随即又展开」。
     */
    if (entry.kind === 'derived' && !this.foldSeeded.has(entry.id)) {
      this.foldSeeded.add(entry.id)
      const seeded: FoldState = { ...(ed.doc.folded ?? {}) }
      for (const b of plan.roots) if (hasLiveChildren(b)) seeded[b.id] = true
      ed.doc.folded = seeded
    }
    const folded = unfoldForContext(ed.doc.folded, plan.covers, (id) => this.deps.kb.pathOf(id))
    ed.loadPage({ roots: plan.roots, folded, contexts: plan.contexts, expandedRoots: plan.contextRoots })
    if (plan.focusId) ed.reveal(plan.focusId)
  }

  /**
   * 这一栏**现在选的是哪张视图**；`null` ＝ 大纲。
   *
   * `derived` 栏没有配置：它的看法是设备状态（`derivedKind`），缺省大纲。
   * 列表／表格这两个看法仍然走视图宿主的渲染器，只是那一台不画抬头、也没有「＋」。
   */
  private viewOf(entry: MountEntry): ViewConfig | null {
    if (entry.kind === 'derived') {
      const host = this.deps.host()
      if (!host) return null
      const kind = this.deps.derivedKind?.(host, entry.source) ?? 'outline'
      return kind === 'outline' ? null : { id: `derived:${kind}`, kind }
    }
    const hostRef = this.mountHost()
    const data = this.deps.owners.read({ kind: 'tab', host: hostRef, tabId: entry.id })
    return data ? readViewSet(data).active : null
  }

  /**
   * 派生栏抬头：`引用 · 12 条  [大纲][列表][表格]  ⋯`。
   *
   * 主数字＝**记录条数**（与列表/表格同一个数）：大纲折叠只影响画几行，不改成员。
   * 条件是一句**只读说明**（「指向这一块」）——它没有可编辑的条件，也没有构建器落点。
   */
  private renderDerivedHead(
    host: Block,
    entry: Extract<MountEntry, { kind: 'derived' }>,
    kind: DerivedViewKind,
    count: number,
    all: readonly ViewRecord[] = [],
  ): void {
    const head = this.derivedHeadEl
    head.hidden = false
    head.replaceChildren()

    const title = document.createElement('span')
    title.className = 'mount-derived-title'
    title.textContent = t(BUILTIN_LABEL[entry.source])
    const num = document.createElement('span')
    num.className = 'mount-derived-count'
    num.textContent = t('ui.mount.count', { count })
    const why = document.createElement('span')
    why.className = 'mount-derived-why ui-ellipsis'
    why.textContent = t(DERIVED_WHY[entry.source])
    head.append(title, num, why)

    /**
     * 引用栏的 kind 过滤：只用**这次已经取到的记录**统计（不再扫一遍库），
     * 且只在大纲显示——表格/列表用「类型」列承担同一件事，避免两处筛选各说各的。
     */
    if (entry.source === 'refs' && kind === 'outline' && all.length > 0) {
      const counts = new Map<'inline' | 'property' | 'embed', number>()
      for (const r of all) {
        const keys = r.derived?.relKindKeys
        if (!Array.isArray(keys)) continue
        for (const k of keys) {
          if (k !== 'inline' && k !== 'property' && k !== 'embed') continue
          counts.set(k, (counts.get(k) ?? 0) + 1)
        }
      }
      const kinds = document.createElement('div')
      kinds.className = 'mount-derived-kinds'
      const add = (key: 'all' | 'inline' | 'property' | 'embed', label: string, n: number): void => {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'mount-derived-kind'
        b.dataset.kind = key
        if (this.refKind === key) b.dataset.active = '1'
        b.textContent = n > 0 ? `${label} ${n}` : label
        b.addEventListener('click', () => {
          if (this.refKind === key) return
          this.refKind = key
          this.render()
        })
        kinds.appendChild(b)
      }
      add('all', t('ui.mount.kind.all'), all.length)
      add('inline', t('ui.mount.kind.inline'), counts.get('inline') ?? 0)
      add('property', t('ui.mount.kind.property'), counts.get('property') ?? 0)
      add('embed', t('ui.mount.kind.embed'), counts.get('embed') ?? 0)
      head.appendChild(kinds)
    }

    const seg = document.createElement('div')
    seg.className = 'mount-derived-views'
    const labels: Record<DerivedViewKind, MsgId> = {
      outline: 'ui.view.outline',
      list: 'ui.view.kind.list',
      table: 'ui.view.kind.table',
    }
    for (const k of DERIVED_VIEW_KINDS) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'mount-derived-view'
      b.dataset.kind = k
      if (k === kind) b.dataset.active = '1'
      b.textContent = t(labels[k])
      b.addEventListener('click', () => {
        if (k === kind) return
        this.deps.setDerivedKind?.(host, entry.source, k)
      })
      seg.appendChild(b)
    }
    head.appendChild(seg)

  }

  private showView(host: Block, entry: MountEntry): void {
    /**
     * 大纲的岛根要**从文档里摘掉**，不能 dispose：
     * `EditableBlock.dispose()` 是终态（退订＋卸事件），而摘掉只是为了让同一块
     * 不在这一屏出现两份 `data-block-id`。切回大纲时再挂回去，撤销栈还在。
     */
    this.block.root.remove()
    this.editorEl.hidden = true
    this.emptyEl.hidden = true
    this.viewEl.hidden = false
    if (entry.kind === 'local') {
      // 按栏缓存：切 tab／切看法都不换实例（`mount()` ⇒ `sync()` 自会按激活视图换分支）
      let made = this.tabViews.get(entry.id) ?? null
      if (!made) {
        made = this.deps.createView?.(host, entry) ?? null
        if (made) this.tabViews.set(entry.id, made)
      }
      this.view = made
      this.ownedView = null
      if (made) {
        if (made.root.parentElement !== this.viewEl) this.viewEl.replaceChildren(made.root)
        made.mount()
        return
      }
    } else {
      // 派生栏：看法（kind）烤在实例里，现造现弃
      this.detachView()
      this.viewEl.hidden = false
      const made = this.deps.createView?.(host, entry) ?? null
      this.view = made
      this.ownedView = made
      if (made) {
        this.viewEl.replaceChildren(made.root)
        made.mount()
        return
      }
    }
    // 装配层没给视图体（这一档还没做渲染器）⇒ 给一句实话而不是空屏
    this.viewEl.replaceChildren()
    const p = document.createElement('p')
    p.className = 'tv-unsupported'
    p.textContent = t('ui.view.unsupported')
    this.viewEl.appendChild(p)
  }

  private detachView(): void {
    // 派生栏的实例是现造现弃的；local 栏的实例按栏缓存着，摘下来就行
    this.ownedView?.dispose()
    this.ownedView = null
    if (this.view) this.view.root.remove()
    this.view = null
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

}
