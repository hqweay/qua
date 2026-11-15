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
  read: () => { view: ViewConfig | null; source: Source; filter: QueryNode | null; display?: string[] }
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
  /** chips 认不出的复杂条件：交给条件构建器（query 源才有） */
  openBuilder?: () => void
  /** 写完把焦点交回正文（撤销的键位挂在编辑器焦点上） */
  afterApply?: () => void
  onClose?: () => void
}

export class ViewOptionsPanel {
  readonly root: HTMLElement
  private readonly deps: ViewOptionsDeps

  constructor(deps: ViewOptionsDeps) {
    this.deps = deps
    this.root = document.createElement('div')
    this.root.className = 'vopt'
  }

  /** 现画全部 section（每次手势后由持有方重调；配置一律现读，不留快照） */
  render(): void {
    const { view, source, filter, display } = this.deps.read()
    const axes = axesFor(source, view?.kind ?? 'outline')
    this.root.replaceChildren()
    this.renderFilter(axes, source, filter)
    this.renderSort(axes, source, view)
    this.renderGroup(axes, source, view)
    this.renderDisplay(axes, source, view, display)
  }

  /* ---------------------------------------------------------- 通用件 */

  private section(title: string): HTMLElement {
    const box = document.createElement('div')
    box.className = 'vopt-section'
    const head = document.createElement('div')
    head.className = 'vopt-title'
    head.textContent = title
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
      this.paintSortRows(body, (view.sort ?? []).map((s) => ({ ...s })), (draft) => {
        this.deps.invoke('core.view/set-sort', { owner: this.deps.owner, viewId: this.deps.viewId(), sort: draft })
        this.refresh()
      })
      return
    }
    // 默认大纲（query 源）：没有显示序可写；成员顺序（取哪些、按什么序）仍是查询的一部分
    if (view === null && source.kind === 'query') {
      const spec = source.spec
      const body = this.section(t('ui.view.opt.memberSort'))
      body.append(this.note(t('ui.view.opt.memberSortHint')))
      this.paintSortRows(body, (spec.sort ?? []).map((s) => ({ ...s })), (draft) => {
        const next = { ...spec }
        if (draft.length > 0) next.sort = draft.map((s) => ({ ...s }))
        else delete next.sort
        this.deps.invoke('core.query/set-spec', { owner: this.deps.owner, spec: next })
        this.deps.afterApply?.()
      })
    }
  }

  /** 多键排序的行编辑器（字段 ＋ 方向 ＋ 上移/下移/移除；次序即优先级）。落盘交给 `apply` */
  private paintSortRows(
    body: HTMLElement,
    draft: { by: string; dir: 'asc' | 'desc' }[],
    apply: (draft: { by: string; dir: 'asc' | 'desc' }[]) => void,
  ): void {
    const repaint = (): void => {
      body.replaceChildren()
      this.paintSortRows(body, draft, apply)
    }
    const fields = this.sortKeys()
    draft.forEach((s, i) => {
      const row = document.createElement('div')
      row.className = 'qsp-row'
      const col = document.createElement('select')
      col.className = 'qsp-field ui-input'
      for (const f of fields) {
        const o = document.createElement('option')
        o.value = f.id
        o.textContent = f.label
        col.append(o)
      }
      col.value = s.by
      col.onchange = () => {
        draft[i] = { ...s, by: col.value }
        repaint()
      }
      const dir = document.createElement('select')
      dir.className = 'qsp-dir ui-input'
      for (const [v, key] of [
        ['asc', 'ui.view.sortAsc'],
        ['desc', 'ui.view.sortDesc'],
      ] as const) {
        const o = document.createElement('option')
        o.value = v
        o.textContent = t(key)
        dir.append(o)
      }
      dir.value = s.dir
      dir.onchange = () => {
        draft[i] = { ...s, dir: dir.value === 'desc' ? 'desc' : 'asc' }
        repaint()
      }
      const ops = document.createElement('span')
      ops.className = 'qsp-ops'
      for (const [label, disabled, act] of [
        ['↑', i === 0, (): void => {
          ;[draft[i - 1], draft[i]] = [draft[i]!, draft[i - 1]!]
        }],
        ['↓', i === draft.length - 1, (): void => {
          ;[draft[i + 1], draft[i]] = [draft[i]!, draft[i + 1]!]
        }],
        ['×', false, (): void => {
          draft.splice(i, 1)
        }],
      ] as const) {
        const b = document.createElement('button')
        b.type = 'button'
        b.textContent = label
        b.disabled = disabled
        b.addEventListener('click', () => {
          act()
          repaint()
        })
        ops.append(b)
      }
      row.append(col, dir, ops)
      body.append(row)
    })
    // 添加一行：只列还没在用的字段；选了当场落一行（方向缺省升序，行内可改）
    const unused = fields.filter((f) => !draft.some((s) => s.by === f.id))
    const add = document.createElement('select')
    add.className = 'qsp-add ui-input'
    const placeholder = document.createElement('option')
    placeholder.value = ''
    placeholder.textContent = t('ui.query.sortAdd')
    add.append(placeholder)
    for (const f of unused) {
      const o = document.createElement('option')
      o.value = f.id
      o.textContent = f.label
      add.append(o)
    }
    add.disabled = unused.length === 0
    add.onchange = () => {
      if (add.value === '') return
      draft.push({ by: add.value, dir: 'asc' })
      repaint()
    }
    body.append(add)
    const applyBtn = document.createElement('button')
    applyBtn.type = 'button'
    applyBtn.className = 'qsp-apply ui-btn'
    applyBtn.textContent = t('ui.query.builder.apply')
    applyBtn.addEventListener('click', () => apply(draft))
    body.append(applyBtn)
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
    const body = this.section(t('ui.view.opt.display'))
    const whitelist = display
    const custom = whitelist !== undefined
    // 三态：「跟随默认」＝缺省（rich 默认/计算列）；「编辑默认」＝声明层；
    // 「自定义」＝白名单覆写（空选＝只标题）
    const seg = document.createElement('div')
    seg.className = 'vopt-seg'
    seg.append(
      this.segBtn(t('ui.view.opt.followDefault'), !custom, () => {
        if (!custom) return
        this.deps.invoke('core.view/set-display', { owner: this.deps.owner, viewId: this.deps.viewId(), props: null })
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
    seg.append(this.segBtn(t('ui.view.opt.custom'), custom, () => {}))
    body.append(seg)

    if (!custom) {
      body.append(this.note(t('ui.view.opt.defaultHint')))
      return
    }
    // 自定义清单：勾选即写（整份替换）；全不勾 ＝ 只标题
    const list = document.createElement('div')
    list.className = 'vopt-props'
    for (const r of this.displayCandidates()) {
      const row = document.createElement('label')
      row.className = 'qcp-row'
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = (whitelist ?? []).includes(r.key)
      box.addEventListener('change', () => {
        const current = this.deps.read().display ?? []
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
    b.className = 'vopt-seg-btn'
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
