/**
 * **视图选项面板（四轴一个面）**：筛选 / 排序 / 分组 / 显示。
 *
 * 一台面板、两处挂载（视图抬头的「选项」按钮与块菜单的「视图选项…」）——
 * 各画一份的下场是「同一个轴在两个落点里说法不同」。可用性只有一张答案表
 * （`axesFor`）：面板显示哪几个 section、命令层放行哪些写、读路径保留哪些配置，
 * 三处读同一份矩阵。
 *
 * 各 section 的落盘分工（与命令族一一对应）：
 *   · 筛选 → `core.view/set-filter`（query 源＝切片；children 记录视图＝显示掩码）
 *   · 排序 → `core.view/set-sort`（多键，数组序即优先级）；默认大纲（query 源）
 *     没有显示序可写，这一节编辑的是**成员顺序**（`core.query/set-spec` 的 `sort`）——
 *     大纲的行序就是模型序，两种「序」在这张看法上是同一个东西
 *   · 分组 → `core.view/set-group`（按值／结构两个来源互斥）
 *   · 显示 → 三态「跟随默认 / 编辑默认 / 自定义」；自定义写 `core.view/set-display`
 *     （默认看法写 `_defaultDisplayProps`）；「编辑默认」调声明层选择器
 *     （`_childProps` 的写口不变），只在声明真正生效的组合给（children 源的大纲/卡片）
 */
import { t } from '../../core/infra/msg.ts'
import { sectionInfo } from '../../view/info.ts'
import type { ViewConfig, ViewOwnerRef, ViewRecord } from '../../core/index.ts'
import type { QueryNode } from '../../core/query/query.ts'
import type { Source, ViewAxis } from '../../core/views/view.ts'
import {
  CHILDREN_COLUMN,
  CREATED_COLUMN,
  MODIFIED_COLUMN,
  PATH_COLUMN,
  TAGS_COLUMN,
  axesFor,
  groupChoicesOf,
  groupsByStructure,
} from '../../core/views/view.ts'
import {
  EMPTY_QUICK_FILTER,
  chipsOfFilter,
  quickFilterAdd,
  quickFilterDrop,
  quickFilterNode,
  type QuickFilterAtom,
  type QuickFilterState,
} from '../../core/views/quick-filter.ts'
import { renderQuickFilter } from '../chrome/quick-filter.ts'
import { paintSortRows } from './sort-rows.ts'

/** 结构分组在分组下拉里的 UI-only 哨兵（落盘的是 `groupByStructure:true`，不是这个值） */
export const STRUCTURE_GROUP = '\u0000structure'

/** 显示清单的一行候选：键 ＋ 显示名 */
interface PropRow {
  key: string
  label: string
}

export interface ViewOptionsDeps {
  owner: ViewOwnerRef
  /** 配哪一张：命名视图 id；`''` ＝ 默认看法（活读：切视图不换面板） */
  viewId: () => string
  /**
   * 活配置现读（每次手势后重画要用新值，不留快照）：
   * `filter` ＝ 这一张此刻生效的条件（命名视图的切片/掩码；默认看法的 `_defaultFilter`）；
   * `display` ＝ 这一张此刻的显示白名单（命名视图的 `displayProps`；默认看法的 `_defaultDisplayProps`）。
   */
  read: () => {
    view: ViewConfig | null
    source: Source
    filter: QueryNode | null
    display?: string[]
    /** 默认大纲的行首路径此刻关没关（只 query 源有意义；与 `paths` 轴配套） */
    pathsHidden?: boolean
  }
  /** 属性定义（排序键与显示清单的候选主体） */
  fields: () => readonly { id: string; label: string }[]
  /** 记录（分组候选的覆盖率分母） */
  records: () => readonly ViewRecord[]
  /** 未筛结果（快速筛选的候选：用它当候选源，「摘一颗一切回来」才有参照） */
  filterCandidates: () => readonly ViewRecord[]
  /** chip 的显示名（页按 id 现解析；标签原子本来就是名字） */
  atomLabel: (atom: QuickFilterAtom) => string
  /** 多值判据（分组候选的尾注；缺省只认 `_tags`） */
  cardinalityOf?: (propId: string) => 'one' | 'many'
  invoke: (name: string, args: Record<string, unknown>) => void
  /** 「编辑默认」：声明层选择器（`_childProps` 写口不变；面板不自己画第二份） */
  openChildProps?: (blockId: string) => void
  /** 复杂条件交给条件构建器（chips 认不出时给；query 源才有） */
  openBuilder?: () => void
  /**
   * **跟随默认时的生效显示键**（进入自定义编辑态的预选基线）：
   * 表格＝计算列；rich 看法＝这批记录里真有值的键（声明链效果的近似）。
   * 只用于画勾选框的初态，不写盘——首次勾选才落白名单。
   */
  displayDefaults?: () => string[]
  /** 写完把焦点交回正文（撤销的键位挂在编辑器焦点上） */
  afterApply?: () => void
  onClose?: () => void
}

export class ViewOptionsPanel {
  readonly root: HTMLElement
  private readonly deps: ViewOptionsDeps
  /** 自定义编辑态（跟随默认下点「自定义」进入；只影响勾选清单是否展开，不写盘） */
  private displayEditing = false

  constructor(deps: ViewOptionsDeps) {
    this.deps = deps
    this.root = document.createElement('div')
    this.root.className = 'vopt'
  }

  /** 现画全部 section（每次手势后由持有方重调；配置一律现读，不留快照） */
  render(): void {
    const { view, source, filter, display, pathsHidden } = this.deps.read()
    const axes = axesFor(source, view?.kind ?? 'outline')
    this.root.replaceChildren()
    this.renderFilter(axes, source, filter)
    this.renderSort(axes, source, view)
    this.renderGroup(axes, source, view)
    this.renderPaths(axes, pathsHidden === true)
    this.renderDisplay(axes, source, view, display)
  }

  /* ---------------------------------------------------------- 通用件 */

  private section(title: string, tip?: string): HTMLElement {
    const box = document.createElement('div')
    box.className = 'vopt-section'
    const head = document.createElement('div')
    head.className = 'vopt-title'
    head.textContent = title
    // 这一段的语义解释退到段头 ⓘ：解释没有操作权，不占正文行的宽度
    if (tip) head.append(sectionInfo(tip))
    const body = document.createElement('div')
    body.className = 'vopt-body'
    box.append(head, body)
    this.root.append(box)
    return body
  }

  private note(text: string): HTMLElement {
    const el = document.createElement('div')
    el.className = 'vopt-note'
    el.textContent = text
    return el
  }

  private refresh(): void {
    this.render()
    this.deps.afterApply?.()
  }

  /* ---------------------------------------------------------- 筛选 */

  private renderFilter(axes: readonly ViewAxis[], source: Source, filter: QueryNode | null): void {
    if (!axes.includes('filter')) return
    const body = this.section(t('ui.view.opt.filter'))
    const chips = chipsOfFilter(filter)
    if (!chips) {
      // 认不出 chips 的形状（嵌套树／正文条件）：不假装能编辑，交给条件构建器
      if (source.kind === 'query' && this.deps.openBuilder) {
        body.append(this.note(t('ui.view.opt.filterComplex')))
        const edit = document.createElement('button')
        edit.type = 'button'
        edit.className = 'ui-btn vopt-apply'
        edit.textContent = t('ui.view.opt.filterEdit')
        edit.addEventListener('click', () => {
          this.deps.openBuilder?.()
          this.deps.onClose?.()
        })
        body.append(edit)
      }
      return
    }
    renderQuickFilter(body, {
      records: () => this.deps.filterCandidates(),
      state: () => chipsOfFilter(this.deps.read().filter) ?? EMPTY_QUICK_FILTER,
      labelOf: (atom) => this.deps.atomLabel(atom),
      onAdd: (atom, to) => this.writeFilter(quickFilterAdd(chipsOfFilter(this.deps.read().filter) ?? EMPTY_QUICK_FILTER, atom, to)),
      onDrop: (atom) => this.writeFilter(quickFilterDrop(chipsOfFilter(this.deps.read().filter) ?? EMPTY_QUICK_FILTER, atom)),
      onClear: () => {
        this.deps.invoke('core.view/set-filter', {
          owner: this.deps.owner,
          viewId: this.deps.viewId(),
          filter: null,
        })
        this.refresh()
      },
      search: true,
    })
    if (source.kind === 'children') {
      // 掩码语义要说清：筛掉的行不是删除，清除就回来
      body.append(this.note(t('ui.view.opt.maskHint')))
    }
  }

  private writeFilter(next: QuickFilterState | null): void {
    if (!next) return
    this.deps.invoke('core.view/set-filter', {
      owner: this.deps.owner,
      viewId: this.deps.viewId(),
      filter: quickFilterNode(next),
    })
    this.refresh()
  }

  /**
   * **行首路径显隐**（默认大纲的密度出口）：只 query 源有这一段——命中行的位置投影
   * 每条独占一格，来源一多就是噪声；children 大纲的行住在真树上，位置由缩进表达。
   * 与派生栏镜头的 seg 同一套面板语言（307 同一台）。
   */
  private renderPaths(axes: readonly ViewAxis[], hidden: boolean): void {
    if (!axes.includes('paths')) return
    const body = this.section(t('ui.view.opt.paths'))
    const seg = document.createElement('div')
    seg.className = 'vopt-seg'
    for (const [on, label] of [
      [true, 'ui.view.opt.pathsShow'],
      [false, 'ui.view.opt.pathsHide'],
    ] as const) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'ui-btn vopt-seg-btn'
      if (on === !hidden) b.dataset.active = '1'
      b.textContent = t(label)
      b.addEventListener('click', () => {
        if (on === !hidden) return
        this.deps.invoke('core.view/set-paths', { owner: this.deps.owner, showPaths: on ? null : false })
        this.refresh()
      })
      seg.appendChild(b)
    }
    body.appendChild(seg)
  }

  /* ---------------------------------------------------------- 排序 */

  /** 能排序的键：保留键 ＋ 属性定义（取值与实现都在 query 侧，这里只管名字） */
  private sortKeys(): readonly { id: string; label: string }[] {
    return [
      { id: 'created', label: t('ui.query.sortKey.created') },
      { id: 'modified', label: t('ui.query.sortKey.modified') },
      { id: '_date', label: t('ui.query.sortKey.date') },
      { id: 'refCount', label: t('ui.query.sortKey.refCount') },
      { id: 'random', label: t('ui.query.sortKey.random') },
      ...this.deps.fields().map((f) => ({ id: f.id, label: f.label })),
    ]
  }

  private renderSort(axes: readonly ViewAxis[], source: Source, view: ViewConfig | null): void {
    if (axes.includes('sort') && view !== null) {
      const body = this.section(t('ui.view.opt.sort'))
      paintSortRows(body, this.sortKeys(), (view.sort ?? []).map((s) => ({ ...s })), (draft) => {
        this.deps.invoke('core.view/set-sort', { owner: this.deps.owner, viewId: this.deps.viewId(), sort: draft })
        this.refresh()
      })
      return
    }
    // 默认大纲（query 源）：没有显示序可写；成员顺序（取哪些、按什么序）仍是查询的一部分
    if (view === null && source.kind === 'query') {
      const spec = source.spec
      const body = this.section(t('ui.view.opt.memberSort'), t('ui.view.opt.memberSortHint'))
      paintSortRows(body, this.sortKeys(), (spec.sort ?? []).map((s) => ({ ...s })), (draft) => {
        const next = { ...spec }
        if (draft.length > 0) next.sort = draft.map((s) => ({ ...s }))
        else delete next.sort
        this.deps.invoke('core.query/set-spec', { owner: this.deps.owner, spec: next })
        this.deps.afterApply?.()
      })
    }
  }


  /* ---------------------------------------------------------- 分组 */

  private renderGroup(axes: readonly ViewAxis[], source: Source, view: ViewConfig | null): void {
    if (!axes.includes('group') || view === null) return
    const body = this.section(t('ui.view.opt.group'))
    const cards = view.kind === 'cards'
    // 「按一级子块」只对 children 源的卡片成立：组是容器的直接子块（query 命中是平的）
    const structureOk = cards && source.kind === 'children'
    const choices = groupChoicesOf(this.deps.records(), {
      fields: this.deps.fields(),
      ...(this.deps.cardinalityOf ? { cardinalityOf: this.deps.cardinalityOf } : {}),
    }).filter((c) => !(cards && c.multi))
    const select = document.createElement('select')
    select.className = 'ui-input vopt-group'
    const none = document.createElement('option')
    none.value = ''
    none.textContent = t('ui.query.group.none')
    select.append(none)
    if (structureOk) {
      const o = document.createElement('option')
      o.value = STRUCTURE_GROUP
      o.textContent = t('ui.query.group.structure')
      select.append(o)
    }
    for (const c of choices) {
      const o = document.createElement('option')
      o.value = c.key
      o.textContent = `${c.label}（${c.count}／${c.total}）`
      select.append(o)
    }
    select.value = groupsByStructure(view) ? STRUCTURE_GROUP : (view.groupBy ?? '')
    if (![...select.options].some((o) => o.value === select.value)) {
      // 存着的分组键不在候选里（这批结果没有这一栏了）⇒ 显示「无分组」，不悄悄改配置
      select.value = ''
    }
    select.onchange = () => {
      const picked = select.value
      const structure = picked === STRUCTURE_GROUP
      this.deps.invoke('core.view/set-group', {
        owner: this.deps.owner,
        viewId: this.deps.viewId(),
        groupBy: structure ? '' : picked,
        ...(structure ? { structure: true } : {}),
      })
      this.refresh()
    }
    body.append(select)
  }

  /* ---------------------------------------------------------- 显示（三态） */

  private renderDisplay(axes: readonly ViewAxis[], source: Source, view: ViewConfig | null, display?: string[]): void {
    if (!axes.includes('display')) return
    const body = this.section(t('ui.view.opt.display'), t('ui.view.opt.defaultHint'))
    const whitelist = display
    const custom = whitelist !== undefined
    // 三态：「跟随默认」＝缺省（rich 默认/计算列）；「编辑默认」＝声明层；
    // 「自定义」＝白名单覆写（空选＝只标题）
    const seg = document.createElement('div')
    seg.className = 'vopt-seg'
    const editing = custom || this.displayEditing
    seg.append(
      this.segBtn(t('ui.view.opt.followDefault'), !editing, () => {
        this.displayEditing = false
        if (custom) {
          this.deps.invoke('core.view/set-display', { owner: this.deps.owner, viewId: this.deps.viewId(), props: null })
        }
        this.refresh()
      }),
    )
    // 「编辑默认」只在声明真正生效的组合给：children 源（声明喂的是直接子块）的大纲与卡片。
    // 表格的缺省是计算列、query 命中的声明各在各的父块——这些组合里调它等于没按
    const declarationApplies = source.kind === 'children' && (view === null || view.kind === 'cards')
    if (declarationApplies && this.deps.openChildProps && this.deps.owner.kind === 'block') {
      seg.append(
        this.segBtn(t('ui.view.opt.editDefault'), false, () => {
          this.deps.openChildProps?.((this.deps.owner as { blockId: string }).blockId)
        }),
      )
    }
    seg.append(
      this.segBtn(t('ui.view.opt.custom'), custom, () => {
        // 进入编辑态**不写盘**：勾选清单按当前生效显示预选，首次勾选才落白名单——
        // 「点开看看」不该让显示跳变（配置写一条撤销，但没动过的配置不该产生撤销）
        if (!editing) {
          this.displayEditing = true
          this.render()
        }
      }),
    )
    body.append(seg)

    if (!editing) return
    // 勾选清单：基线＝白名单（已在自定义态）或当前生效显示（编辑态预选）；
    // 勾选即写（整份替换）；全不勾 ＝ 只标题
    const base = whitelist ?? (this.deps.displayDefaults?.() ?? [])
    const list = document.createElement('div')
    list.className = 'vopt-props'
    for (const r of this.displayCandidates()) {
      const row = document.createElement('label')
      row.className = 'qcp-row'
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = base.includes(r.key)
      box.addEventListener('change', () => {
        const current = this.deps.read().display ?? this.deps.displayDefaults?.() ?? []
        const next = box.checked ? [...current, r.key] : current.filter((k) => k !== r.key)
        this.deps.invoke('core.view/set-display', { owner: this.deps.owner, viewId: this.deps.viewId(), props: next })
        this.refresh()
      })
      row.append(box, document.createTextNode(r.label))
      list.append(row)
    }
    body.append(list)
    body.append(this.note(t('ui.view.opt.emptyIsTitle')))
  }

  private segBtn(label: string, active: boolean, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'ui-btn vopt-seg-btn'
    b.textContent = label
    if (active) b.dataset.active = '1'
    b.addEventListener('click', onClick)
    return b
  }

  /** 自定义清单的候选：属性定义 ＋ 保留投影键（它们是「这条记录的某一面」，随取随有） */
  private displayCandidates(): readonly PropRow[] {
    return [
      { key: TAGS_COLUMN, label: t('ui.props.tagsTitle') },
      { key: CHILDREN_COLUMN, label: t('ui.view.col.children') },
      { key: CREATED_COLUMN, label: t('ui.props.createdAt') },
      { key: MODIFIED_COLUMN, label: t('ui.props.modifiedAt') },
      { key: PATH_COLUMN, label: t('ui.view.col.path') },
      ...this.deps.fields().map((f) => ({ key: f.id, label: f.label })),
    ]
  }
}
