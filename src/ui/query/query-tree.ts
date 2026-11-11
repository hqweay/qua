/**
 * **条件树**（就地展开的那一版）：组 ＋ 叶子行，任意嵌套，每层一个「非」。
 *
 * 三条口径（与旧弹层构建器的差别写在这里）：
 *   · **不是表单**：叶子行读成一句话（`状态 ≠ 已完成`），控件按内容宽，不铺满整行；
 *   · **树常驻**：草稿活在组件里，收起只是隐藏 DOM，再展开接着改；只有「应用」写一次事务；
 *   · **拆不动就只读 JSON**：树上表达不了的形状显示 canonical JSON ＋ 一句提示，
 *     不猜着拆一半（拆一半再拼回去会悄悄丢掉原意）。
 *
 * 转换（`treeOfSpec`／`specOfTree`）住在 `core/query-tree.ts`，这里只画与收手势。
 * ⚠️ 每级缩进用 `--ui-indent`、竖线用 `--ui-rail`：条件树是块编辑器的一部分，
 *    不是「嵌进来的一张表单」——那两格 token 与正文缩进同源。
 */
import {
  canonicalSpec,
  opsFor,
  SELF,
  specKeyOf,
  specOfTree,
  treeIncomplete,
  treeLeafCount,
  treeOfSpec,
  treeNodeOfRow,
  TREE_ROW_KINDS,
  isQueryableSystemProp,
  systemQueryFieldLabel,
  ENGINE_CREATED,
  ENGINE_MODIFIED,
  todayISO,
  type Block,
  type DraftOp,
  type PropKind,
  type QuerySpec,
  type TreeDraft,
  type TreeGroup,
  type TreeLeaf,
  type TreeRow,
  type TreeRowKind,
  isJournalDate,
} from '../../core/index.ts'
import { t, type MsgId } from '../../core/infra/msg.ts'

export interface QueryTreeDeps {
  /** 当前条件（现读：可能被命令／撤销改过） */
  spec: () => QuerySpec
  fields: () => readonly { id: string; label: string; kind?: PropKind }[]
  /** `select` 属性的选项（值是选项块 id） */
  choices?: (propId: string) => readonly { id: string; label: string }[]
  /** 写条件（一次事务／一轮撤销） */
  apply: (spec: QuerySpec) => void
  /** 应用之后把焦点交回正文（内联树用：这样 ⌘Z 仍落在编辑器上） */
  afterApply?: () => void
  /** 收起内联树／关掉弹层 */
  close?: () => void
  /** 内联树：收起按钮；弹层：关闭按钮 */
  inline?: boolean
  /**
   * 块值选择器。`opts.rootBlock` 为真时候选里多一枚虚拟块「所在块」——
   * 只有条件树要它：属性区给某个块挑引用目标时，「随所在位置变化」没有意义。
   * `owner` 可缺省：它只用于排除自己，枚举候选不需要它（条件树未必有块宿主）。
   */
  pickRef?: (
    owner: Block | undefined,
    propId: string,
    current: string,
    onPick: (targetId: string) => void,
    anchor?: DOMRect,
    trigger?: HTMLElement,
    opts?: { rootBlock?: boolean },
  ) => void
  refLabel?: (targetId: string) => string
  /** 块选择器的宿主（排除自己）；没有也能开 —— 见 `pickRef` */
  owner?: Block
  /** 标签值选择器：候选是库里已有的标签，可搜索；查询是读操作，不许顺手新建 */
  pickTag?: (current: string, onPick: (name: string) => void, anchor?: DOMRect, trigger?: HTMLElement) => void
  /** 标签名还解析得到吗：按名存的条件在改名后会悬空，要给一句实话而不是静默空集 */
  tagExists?: (name: string) => boolean
  /**
   * 显示「最多」那一格；缺省 `true`。
   *
   * 切片编辑用 `false`：切片只是 `QueryNode`，没有 `limit` 的位置——
   * 画出来却存不进去，等于「点了没生效」。
   */
  showOptions?: boolean
}

/** 一行开头的词是**结论**（这行是什么），不是问卷；展开下拉才是问卷 */
const ROW_KIND_TEXT: Record<TreeRowKind, MsgId> = {
  tag: 'ui.query.prefix.tag',
  text: 'ui.query.prefix.text',
  prop: 'ui.query.prefix.prop',
  ref: 'ui.query.prefix.ref',
  is: 'ui.query.prefix.is',
  role: 'ui.query.kind.role',
  day: 'ui.query.kind.day',
  stamp: 'ui.query.kind.stamp',
}

const OP_TEXT: Record<DraftOp, MsgId> = {
  eq: 'ui.query.op.eq',
  neq: 'ui.query.op.neq',
  contains: 'ui.query.op.contains',
  gt: 'ui.query.op.gt',
  gte: 'ui.query.op.gte',
  lt: 'ui.query.op.lt',
  lte: 'ui.query.op.lte',
  exists: 'ui.query.op.exists',
  empty: 'ui.query.op.empty',
}

/** 一行还没填完时给一个默认值：其它留空由用户填 */
function defaultRow(kind: TreeRowKind, field: string): TreeRow {
  if (kind === 'tag') return { kind: 'tag', value: '' }
  if (kind === 'text') return { kind: 'text', value: '' }
  if (kind === 'prop') return { kind: 'prop', field, op: 'eq', value: '' }
  if (kind === 'ref') return { kind: 'ref', target: '' }
  if (kind === 'is') return { kind: 'is', target: '' }
  if (kind === 'role') return { kind: 'role', role: 'journal' }
  if (kind === 'day') {
    // 新加的「某一天」默认「今天」（`{today:{offset:0}}`）：加一行就是一条完整条件
    return { kind: 'day', date: '', rel: 0 }
  }
  // 新加的「时间」默认「创建时间 · 就在今天」：同样是加一行就能应用
  return { kind: 'stamp', field: ENGINE_CREATED, op: 'on', date: todayISO() }
}

function option(value: string, label: string): HTMLOptionElement {
  const o = document.createElement('option')
  o.value = value
  o.textContent = label
  return o
}

function selectEl(
  options: readonly { value: string; label: string }[],
  value: string,
  onChange: (next: string) => void,
  cls: string,
  data?: string,
): HTMLSelectElement {
  const sel = document.createElement('select')
  sel.className = cls
  if (data) sel.dataset.qt = data
  for (const o of options) sel.appendChild(option(o.value, o.label))
  sel.value = value
  sel.addEventListener('change', () => onChange(sel.value))
  return sel
}

function buttonEl(label: string, cls: string, data: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = cls
  b.dataset.qt = data
  b.textContent = label
  return b
}

/** 条件树组件：创建一次、`render()` 可反复调；草稿只在外部条件真变时重置 */
export class QueryTree {
  private readonly box: HTMLElement
  private readonly deps: QueryTreeDeps
  private draft: TreeDraft | null = null
  private painted = false
  private key = ''
  private json = ''
  /** 哪一个组的「加一条」选择器开着（同一时刻只开一个） */
  private pickerFor: TreeGroup | null = null
  /** 刚加了一行：重画后把焦点送进新行 */
  private focusNew = false
  /** 「应用」按钮：填完一行时只更新它，不重画（重画会把焦点冲掉） */
  private applyBtn: HTMLButtonElement | null = null

  constructor(box: HTMLElement, deps: QueryTreeDeps) {
    this.box = box
    this.deps = deps
    this.box.classList.add('qt')
  }

  /**
   * 按当前 spec 重画。
   *
   * `key` 没变就直接返回：草稿还在编辑中，store 的无关通知不该把用户正在敲的字冲掉。
   * 「应用」会先把 `key` 推到新 spec，再调 `deps.apply` —— 这样 apply 同步触发的重画也不会重置。
   */
  render(force = false): void {
    const spec = this.deps.spec()
    const key = specKeyOf(spec)
    if (!force && this.painted && key === this.key) return
    this.key = key
    this.draft = treeOfSpec(spec)
    this.json = JSON.stringify(canonicalSpec(spec), null, 2)
    this.painted = true
    this.paint()
  }

  private apply(): void {
    if (!this.draft) return
    const spec = specOfTree(this.draft)
    this.key = specKeyOf(spec)
    this.painted = true
    this.deps.apply(spec)
    this.deps.afterApply?.()
    // 应用完这一刻草稿又与 spec 相同了：按钮要跟着回到不可点
    this.syncApply()
  }

  /**
   * 一行填完/清空：只更新「应用」的可用性，不重画（重画会把焦点冲掉）。
   * 未填态由那格值控件自己的 placeholder ＋ 下划线表达，不再往行里插一句提示——
   * 一条新加的行必然未填，用警告色和独占一行的文字迎接它，等于把正常初态当错误。
   */
  private syncRow(el: HTMLElement, row: TreeRow): void {
    const rowEl = el.closest<HTMLElement>('.qt-row')
    if (rowEl) {
      if (treeNodeOfRow(row) === null) rowEl.dataset.qtIncomplete = '1'
      else delete rowEl.dataset.qtIncomplete
      rowEl.querySelector('.qt-hint')?.remove()
    }
    this.syncApply()
  }

  /** 草稿与当前 spec 是否不同：没改动就不该给一颗能点的「应用」 */
  private dirty(): boolean {
    if (!this.draft) return false
    return specKeyOf(specOfTree(this.draft)) !== this.key
  }

  private syncApply(): void {
    if (!this.applyBtn || !this.draft) return
    const incomplete = treeIncomplete(this.draft.root)
    this.applyBtn.disabled = incomplete || !this.dirty()
    if (incomplete) this.applyBtn.title = t('ui.query.tree.incomplete')
    else this.applyBtn.removeAttribute('title')
  }

  private paint(): void {
    this.box.replaceChildren()
    this.box.hidden = false
    this.applyBtn = null
    this.box.append(this.headEl())
    if (!this.draft) {
      this.box.append(this.jsonOnlyEl())
      return
    }
    const body = document.createElement('div')
    body.className = 'qt-body'
    body.append(this.groupEl(this.draft.root, 0, null, -1))
    this.box.append(body)
    // 加行／删行／换组这些手势走 paint()，不经过 syncRow —— 重画后要重算一次按钮
    this.syncApply()
    if (this.focusNew) {
      this.focusNew = false
      const rows = this.box.querySelectorAll('.qt-row')
      const last = rows[rows.length - 1]
      // 刚加的行走「值位」优先：未填的是值，不是行种类或方向
      const focusable =
        last?.querySelector<HTMLElement>('[data-qt="value"], [data-qt="ref"]') ??
        last?.querySelector<HTMLElement>('input, select, button')
      focusable?.focus()
    }
  }

  /**
   * 抬头把「提交」与「取多少」收在一起：编辑中的草稿还不是谓词，「应用」是它成为谓词的
   * 那一刻；`limit` 答的是结果批取多少，本来就不该和条件挤成一张带分隔线的表单。
   */
  private headEl(): HTMLElement {
    const head = document.createElement('div')
    head.className = 'qt-head'
    const title = document.createElement('span')
    title.className = 'qt-title'
    title.textContent = t('ui.query.filter')
    const count = document.createElement('span')
    count.className = 'qt-count'
    count.textContent = this.draft ? t('ui.query.tree.count', { count: treeLeafCount(this.draft.root) }) : t('ui.query.builder.json')
    head.append(title, count)

    const spacer = document.createElement('span')
    spacer.className = 'qt-spacer'
    head.append(spacer)
    if (this.deps.showOptions !== false && this.draft) head.append(this.limitEl())

    // 拆不动的形状是只读 JSON：那里没有草稿可以「应用」，连灰着的按钮都不该摆
    if (this.draft) {
      const apply = buttonEl(t('ui.query.builder.apply'), 'qt-apply', 'apply')
      apply.disabled = true
      apply.addEventListener('click', () => {
        this.apply()
        this.painted = true
      })
      this.applyBtn = apply
      head.append(apply)
    }
    if (this.deps.close) {
      const close = buttonEl(
        this.deps.inline ? t('ui.query.tree.collapse') : t('ui.query.builder.cancel'),
        'qt-close',
        'close',
      )
      close.addEventListener('click', () => this.deps.close?.())
      head.append(close)
    }
    return head
  }

  private limitEl(): HTMLElement {
    const wrap = document.createElement('label')
    wrap.className = 'qt-limit-wrap'
    const label = document.createElement('span')
    label.className = 'qt-opt-label'
    label.textContent = t('ui.query.builder.limit')
    const input = document.createElement('input')
    input.type = 'number'
    input.min = '0'
    input.className = 'qt-limit ui-input'
    input.dataset.qt = 'limit'
    input.placeholder = t('ui.query.builder.noLimit')
    input.value = this.draft?.limit === undefined ? '' : String(this.draft.limit)
    input.addEventListener('input', () => {
      if (!this.draft) return
      const n = Number(input.value)
      if (input.value.trim() === '' || !Number.isFinite(n) || n <= 0) delete this.draft.limit
      else this.draft.limit = Math.floor(n)
      this.syncApply()
    })
    wrap.append(label, input)
    return wrap
  }

  private jsonOnlyEl(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'qt-jsononly'
    wrap.dataset.qt = 'jsononly'
    const hint = document.createElement('p')
    hint.className = 'qt-jsonhint'
    hint.textContent = t('ui.query.jsonOnly')
    const pre = document.createElement('pre')
    pre.className = 'qt-json'
    pre.dataset.qt = 'json'
    pre.textContent = this.json
    wrap.append(hint, pre)
    return wrap
  }

  /* ---------------------------------------------------------- 组 */

  private groupEl(group: TreeGroup, depth: number, parent: TreeGroup | null, index: number): HTMLElement {
    const el = document.createElement('div')
    el.className = 'qt-group'
    el.dataset.qt = 'group'
    el.dataset.qtDepth = String(depth)

    const head = document.createElement('div')
    head.className = 'qt-group-head'
    const mode = selectEl(
      [
        { value: 'all', label: t('ui.query.group.and') },
        { value: 'any', label: t('ui.query.group.or') },
      ],
      group.mode,
      (next) => {
        group.mode = next === 'any' ? 'any' : 'all'
        // 根组原本是「单个条件合成出来的包装」：用户主动改了组合方式 ⇒ 它现在是真组
        if (depth === 0 && this.draft) this.draft.synthesizedRoot = false
      },
      'qt-mode',
      'mode',
    )
    mode.title = t(group.mode === 'any' ? 'ui.query.tree.orHint' : 'ui.query.tree.andHint')

    const notLabel = document.createElement('label')
    notLabel.className = 'qt-not'
    const not = document.createElement('input')
    not.type = 'checkbox'
    not.dataset.qt = 'not'
    not.checked = group.not
    not.addEventListener('change', () => {
      group.not = not.checked
    })
    const notText = document.createElement('span')
    notText.textContent = t('ui.query.group.not')
    notLabel.append(not, notText)

    head.append(mode, this.dirEl(group), notLabel)
    /**
     * **空条件不摆组合方式**：一条条件都没有时，「且／或」与「非」是在给不存在的
     * 子项选关系，读起来像一句没说完的话。根组空的时候只留空态与「加一条」。
     * 子组即使空也保留组头（它是用户刚建出来的东西，还要能删／设关系）。
     */
    if (depth === 0 && group.items.length === 0) {
      head.hidden = true
      el.dataset.qtEmptyRoot = '1'
    }
    if (parent) {
      const del = buttonEl('×', 'qt-del', 'del')
      del.title = t('ui.query.builder.removeRow')
      del.addEventListener('click', () => {
        parent.items.splice(index, 1)
        this.pickerFor = null
        this.paint()
      })
      head.append(del)
    }
    el.append(head)

    const children = document.createElement('div')
    children.className = 'qt-children'
    for (let i = 0; i < group.items.length; i++) {
      const child = group.items[i]!
      children.append(
        child.kind === 'group' ? this.groupEl(child, depth + 1, group, i) : this.rowEl(child, group, i),
      )
    }
    if (depth === 0 && group.items.length === 0) children.append(this.emptyEl())
    const add = buttonEl(`＋ ${t('ui.query.tree.add')}`, 'qt-add', 'add')
    add.addEventListener('click', () => {
      this.pickerFor = this.pickerFor === group ? null : group
      this.paint()
    })
    children.append(add)
    if (this.pickerFor === group) children.append(this.pickerEl(group))
    el.append(children)
    return el
  }

  private pickerEl(group: TreeGroup): HTMLElement {
    const picker = document.createElement('div')
    picker.className = 'qt-picker'
    picker.dataset.qt = 'picker'

    const section = (title: string, items: readonly { pick: string; label: string }[]): void => {
      const h = document.createElement('div')
      h.className = 'qt-picker-title'
      h.textContent = title
      picker.append(h)
      for (const item of items) {
        const b = buttonEl(item.label, 'qt-pick', item.pick)
        b.addEventListener('click', () => {
          this.pickerFor = null
          if (item.pick.startsWith('group:')) {
            const mode = item.pick === 'group:any' ? 'any' : 'all'
            group.items.push({
              kind: 'group',
              mode,
              not: item.pick === 'group:not',
              items: [],
            })
            if (this.draft && this.draft.root === group) this.draft.synthesizedRoot = false
          } else if (item.pick.startsWith('preset:')) {
            /**
             * 「方向 ＋ 条件」的两个常用组合：方向是节点上的一格，预设只是**少点两下**的入口，
             * 生成的是同样的行；之后用户改哪一格都行（不是魔法按钮）。
             */
            const row: TreeRow =
              item.pick === 'preset:under-self'
                ? { kind: 'is', target: SELF }
                : item.pick === 'preset:under-today'
                  ? { kind: 'day', date: '', rel: 0 }
                  : { kind: 'day', date: '' }
            group.items.push({ kind: 'leaf', not: false, dir: 'up', row })
            if (this.draft && this.draft.root === group) this.draft.synthesizedRoot = false
            this.focusNew = true
          } else {
            const kind = item.pick.slice('row:'.length) as TreeRowKind
            group.items.push({
              kind: 'leaf',
              not: false,
              row: defaultRow(kind, this.deps.fields()[0]?.id ?? ''),
            })
            this.focusNew = true
          }
          this.paint()
        })
        picker.append(b)
      }
    }

    section(t('ui.query.tree.preset'), [
      { pick: 'preset:under-self', label: t('ui.query.tree.presetUnderSelf') },
      { pick: 'preset:under-today', label: t('ui.query.tree.presetUnderToday') },
      { pick: 'preset:under-day', label: t('ui.query.tree.presetUnderDay') },
    ])
    section(t('ui.query.tree.regroup'), [
      { pick: 'group:all', label: t('ui.query.group.addAnd') },
      { pick: 'group:any', label: t('ui.query.group.addOr') },
      { pick: 'group:not', label: t('ui.query.group.addNot') },
    ])
    section(t('ui.query.tree.changeKind'), [
      { pick: 'row:tag', label: t('ui.query.kind.tag') },
      { pick: 'row:prop', label: t('ui.query.kind.prop') },
      { pick: 'row:text', label: t('ui.query.kind.text') },
      { pick: 'row:ref', label: t('ui.query.kind.ref') },
      { pick: 'row:is', label: t('ui.query.kind.is') },
      { pick: 'row:role', label: t('ui.query.kind.role') },
      { pick: 'row:day', label: t('ui.query.kind.day') },
      { pick: 'row:stamp', label: t('ui.query.kind.stamp') },
    ])
    return picker
  }

  private emptyEl(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'qt-empty'
    wrap.dataset.qt = 'empty'
    const title = document.createElement('strong')
    title.className = 'qt-empty-title'
    title.textContent = t('ui.query.tree.emptyTitle')
    const hint = document.createElement('span')
    hint.className = 'qt-empty-hint'
    hint.textContent = t('ui.query.tree.emptyHint')
    wrap.append(title, hint)
    return wrap
  }

  /* ---------------------------------------------------------- 行 */

  private rowEl(leaf: TreeLeaf, parent: TreeGroup, index: number): HTMLElement {
    const row = leaf.row
    const el = document.createElement('div')
    el.className = 'qt-row'
    el.dataset.qt = 'row'
    el.dataset.qtRow = row.kind
    const incomplete = treeNodeOfRow(row) === null
    if (incomplete) el.dataset.qtIncomplete = '1'

    if (leaf.not) {
      const notLabel = document.createElement('label')
      notLabel.className = 'qt-not qt-not--row'
      const not = document.createElement('input')
      not.type = 'checkbox'
      not.dataset.qt = 'not'
      not.checked = true
      not.addEventListener('change', () => {
        leaf.not = not.checked
        this.paint()
      })
      const notText = document.createElement('span')
      notText.textContent = t('ui.query.group.not')
      notLabel.append(not, notText)
      el.append(notLabel)
    }

    el.append(this.dirEl(leaf))
    const kind = selectEl(
      TREE_ROW_KINDS.map((k) => ({ value: k, label: t(ROW_KIND_TEXT[k]) })),
      row.kind,
      (next) => {
        leaf.row = defaultRow(next as TreeRowKind, this.deps.fields()[0]?.id ?? '')
        this.paint()
      },
      'qt-kind',
      'kind',
    )
    el.append(kind)
    switch (row.kind) {
      case 'tag':
      case 'text':
        el.append(this.textRowControls(row))
        break
      case 'prop':
        el.append(...this.propControls(leaf))
        break
      case 'ref':
      case 'is':
        el.append(this.refControls(row))
        break
      case 'role':
        el.append(
          selectEl(
            [
              { value: 'journal', label: t('ui.query.role.journal') },
              { value: 'page', label: t('ui.query.role.page') },
            ],
            row.role,
            (next) => {
              row.role = next === 'page' ? 'page' : 'journal'
              this.paint()
            },
            'qt-value',
            'role',
          ),
        )
        break
      case 'day':
        el.append(...this.dayControls(row))
        break
      case 'stamp':
        el.append(...this.stampControls(row))
        break
    }

    const del = buttonEl('×', 'qt-del', 'del')
    del.title = t('ui.query.builder.removeRow')
    del.addEventListener('click', () => {
      parent.items.splice(index, 1)
      this.paint()
    })
    el.append(del)
    return el
  }

  /**
   * 系统预填的派生值只显示人话，不给输入框 —— 用户没有机会敲出 `$self`，
   * 「正文里真的含这几个字」与相对语义在数据层同字节的歧义也就碰不到。
   */
  private selfChip(text: string): HTMLElement {
    const chip = document.createElement('span')
    chip.className = 'qt-chip qt-chip--self'
    chip.dataset.qt = 'value'
    chip.textContent = text
    return chip
  }

  private textRowControls(row: Extract<TreeRow, { kind: 'tag' | 'text' }>): HTMLElement {
    if (row.kind === 'tag') {
      if (row.value === SELF) return this.selfChip(t('ui.query.selfTag'))
      const name = row.value
      // 条件按名存：标签一改名就解析不到。给一句实话，别让查询静默变空集
      const missing = name !== '' && this.deps.tagExists?.(name) === false
      const label =
        name === ''
          ? t('ui.query.pickTag')
          : missing
            ? `#${name} · ${t('ui.query.tagMissing')}`
            : `#${name}`
      const b = buttonEl(label, `qt-value qt-chip-btn qt-slot${name === '' ? ' qt-placeholder' : ''}${missing ? ' qt-missing' : ''}`, 'value')
      b.title = t('ui.query.pickTagHint')
      b.addEventListener('click', () => {
        this.deps.pickTag?.(name, (next) => {
          row.value = next
          this.paint()
        }, b.getBoundingClientRect(), b)
      })
      return b
    }
    if (row.value === SELF) return this.selfChip(t('ui.query.selfText'))
    const input = document.createElement('input')
    input.className = 'qt-value ui-input qt-slot'
    input.dataset.qt = 'value'
    input.placeholder = t('ui.query.builder.textHint')
    input.value = row.value
    input.addEventListener('input', () => {
      row.value = input.value
      this.syncRow(input, row)
    })
    return input
  }

  private fieldKind(id: string): PropKind | undefined {
    return this.deps.fields().find((f) => f.id === id)?.kind
  }

  private propControls(leaf: TreeLeaf): HTMLElement[] {
    if (leaf.row.kind !== 'prop') return []
    const row = leaf.row
    const out: HTMLElement[] = []
    const fields = this.deps.fields()
    const fieldOptions = fields.map((f) => ({ value: f.id, label: f.label }))
    if (row.field !== '' && !fields.some((f) => f.id === row.field)) {
      /**
       * 不在下拉里有两种情况，必须分开说：
       *   · **系统槽白名单**（`_date`／`_tags`／`core/created`…）：求值认它 —— 下拉不列是因为
       *     新增条件时不该看到内部 id；这一行由 JSON 或预设而来，如实显示它问的是什么；
       *   · 其余：属性定义真的不在了（删了／拼错了）—— 求值也不认它（一个块都不命中）。
       */
      const sys = isQueryableSystemProp(row.field)
      fieldOptions.push({
        value: row.field,
        label: sys ? (systemQueryFieldLabel(row.field) ?? row.field) : t('ui.query.fieldMissing'),
      })
    }
    out.push(
      selectEl(
        fieldOptions,
        row.field,
        (next) => {
          row.field = next
          row.value = ''
          this.paint()
        },
        'qt-field',
        'field',
      ),
    )
    out.push(
      selectEl(
        opsFor(this.fieldKind(row.field), row.op).map((op) => ({ value: op, label: t(OP_TEXT[op]) })),
        row.op,
        (next) => {
          row.op = next as DraftOp
          if (row.op === 'exists' || row.op === 'empty') row.value = row.value === 'false' ? 'false' : 'true'
          else if (row.value === 'true' || row.value === 'false') row.value = ''
          this.paint()
        },
        'qt-op',
        'op',
      ),
    )
    out.push(this.valueControl(row))
    return out
  }

  private valueControl(row: Extract<TreeRow, { kind: 'prop' }>): HTMLElement {
    // `{prop:{eq:'$self'}}` 是「取所在块同一栏的值」，系统预填；显示成一句人话，不给输入框
    if (row.value === SELF) return this.selfChip(t('ui.query.selfProp'))
    if (row.op === 'exists' || row.op === 'empty') {
      const sel = selectEl(
        [
          { value: 'true', label: t('ui.query.builder.yes') },
          { value: 'false', label: t('ui.query.builder.no') },
        ],
        row.value === 'false' ? 'false' : 'true',
        (next) => {
          row.value = next
          this.syncRow(sel, row)
        },
        'qt-value',
        'value',
      )
      return sel
    }
    const kind = this.fieldKind(row.field)
    if (kind === 'checkbox' && row.op === 'eq') {
      const label = document.createElement('label')
      label.className = 'qt-switch'
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.dataset.qt = 'value'
      input.checked = row.value === 'true'
      input.addEventListener('change', () => {
        row.value = input.checked ? 'true' : 'false'
        this.syncRow(input, row)
      })
      const text = document.createElement('span')
      text.textContent = t(input.checked ? 'ui.query.builder.yes' : 'ui.query.builder.no')
      input.addEventListener('change', () => {
        text.textContent = t(input.checked ? 'ui.query.builder.yes' : 'ui.query.builder.no')
      })
      label.append(input, text)
      return label
    }
    if (kind === 'select') {
      const options = this.deps.choices?.(row.field) ?? []
      const current = row.value
      const sel = document.createElement('select')
      sel.className = 'qt-value'
      sel.dataset.qt = 'value'
      sel.appendChild(option('', t('ui.query.builder.noValue')))
      if (current !== '' && !options.some((c) => c.id === current)) {
        sel.appendChild(option(current, t('ui.query.choiceDeleted')))
      }
      for (const c of options) sel.appendChild(option(c.id, c.label))
      sel.value = current
      sel.addEventListener('change', () => {
        row.value = sel.value
        this.syncRow(sel, row)
      })
      return sel
    }
    if (kind === 'date') {
      if (row.value !== '' && !isJournalDate(row.value)) return this.relativeInput(row)
      const input = document.createElement('input')
      input.type = 'date'
      input.className = 'qt-value'
      input.dataset.qt = 'value'
      input.value = row.value
      input.addEventListener('input', () => {
        row.value = input.value
        this.syncRow(input, row)
      })
      return input
    }
    if (kind === 'ref') {
      const b = this.refButton(row.value, (id) => {
        row.value = id
        this.paint()
      })
      return b
    }
    const input = document.createElement('input')
    input.className = 'qt-value ui-input'
    input.dataset.qt = 'value'
    if (kind === 'number') {
      input.type = 'number'
      input.inputMode = 'decimal'
    }
    input.value = row.value
    input.addEventListener('input', () => {
      row.value = input.value
      this.syncRow(input, row)
    })
    return input
  }

  /** 非日期的日期字面量：原样显示，给一个「相对」标记；裸哨兵已改走 `selfChip` */
  private relativeInput(row: Extract<TreeRow, { kind: 'prop' }>): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'qt-inline'
    const input = document.createElement('input')
    input.className = 'qt-value ui-input'
    input.dataset.qt = 'value'
    input.dataset.qtRelative = '1'
    input.value = row.value
    input.addEventListener('input', () => {
      row.value = input.value
      this.syncRow(input, row)
    })
    const chip = document.createElement('span')
    chip.className = 'qt-chip'
    chip.textContent = t('ui.query.tree.relative')
    wrap.append(input, chip)
    return wrap
  }

  private refControls(row: Extract<TreeRow, { kind: 'ref' | 'is' }>): HTMLElement {
    if (row.kind === 'is') {
      return this.refButton(row.target, (id) => {
        row.target = id
        this.paint()
      })
    }
    return this.refButton(row.target, (id) => {
      row.target = id
      this.paint()
    })
  }

  /**
   * 块值位统一走选择器：「所在块」是候选里的一块，不是一枚独立的魔法按钮。
   * 也**不退成手输 id** —— 那正是让用户去写 `$self` 的口子；没有选择器就明说不可选。
   */
  private refButton(current: string, onPick: (id: string) => void): HTMLElement {
    const label =
      current === ''
        ? t('ui.query.tree.pickBlock')
        : current === SELF
          ? t('ui.query.rootBlock')
          : (this.deps.refLabel?.(current) ?? current)
    const b = buttonEl(label, `qt-value qt-ref qt-slot${current === '' ? ' qt-placeholder' : ''}`, 'ref')
    if (!this.deps.pickRef) {
      b.disabled = true
      b.title = t('ui.query.noBlockPicker')
      return b
    }
    b.addEventListener('click', () => {
      this.deps.pickRef?.(this.deps.owner, '', current, onPick, b.getBoundingClientRect(), b, { rootBlock: true })
    })
    return b
  }

  /**
   * **方向那一格**：叶子与组都能挂，与「非」同构。
   *
   * 缺省「—」（没有关系）；「在…之下」挂组 ＝ 存在同一个上级满足整组（「在…之下 ·（A 且 B）」），
   * 每条叶子各挂 ＝ 祖先链里各找一处——两种形状都编辑得到，
   * 但 chip 与人话要说清它们不是一回事（对 `all` 不满足分配律）。
   */
  private dirEl(node: TreeLeaf | TreeGroup): HTMLElement {
    const sel = selectEl(
      [
        { value: '', label: t('ui.query.dir.self') },
        { value: 'up', label: t('ui.query.dir.up') },
        { value: 'down', label: t('ui.query.dir.down') },
        { value: 'near', label: t('ui.query.dir.near') },
      ],
      node.dir ?? '',
      (next) => {
        if (next === 'up' || next === 'down' || next === 'near') node.dir = next
        else delete node.dir
        // 缺省（没有关系）是**修饰的缺省态**：不显形、不抢读句子的注意力
        sel.dataset.set = node.dir ? '1' : '0'
        // 方向不改行的完整度：只重算「应用」的可用性，不重画（别把用户的焦点冲掉）
        this.syncApply()
      },
      'qt-dir',
      'dir',
    )
    sel.dataset.set = node.dir ? '1' : '0'
    sel.title = t('ui.query.tree.dirHint')
    return sel
  }

  /**
   * 「某一天」行：**一个模式词 ＋ 一个值控件**（方向已上收到 `dirEl`）。
   *
   * 三态：固定日期（`{all:[role,_date]}`）／相对（`{today:{offset}}`，存表达式）／
   * 与所在块同一天（`eq:'$self'`）。它们是同一件事的三种问法，收进一个模式词。
   */
  private dayControls(row: Extract<TreeRow, { kind: 'day' }>): HTMLElement[] {
    const mode = this.dayModeOf(row)
    const sel = selectEl(
      [
        { value: 'abs', label: t('ui.query.pathMode.day') },
        { value: 'rel', label: t('ui.query.pathMode.today') },
        { value: 'host', label: t('ui.query.pathMode.host') },
      ],
      mode,
      (next) => {
        if (next === 'rel') {
          row.date = ''
          row.rel = row.rel ?? 0
        } else if (next === 'host') {
          row.rel = undefined
          row.date = SELF
        } else {
          row.rel = undefined
          if (row.date === SELF || !isJournalDate(row.date)) row.date = ''
        }
        this.paint()
      },
      'qt-day-mode',
      'day-mode',
    )
    return [sel, this.dayValue(row, mode)]
  }

  /**
   * **时间范围**那一行：字段（创建／修改）＋ 问法（就在这一天／从这天起／早于这一天）＋ 日期。
   *
   * 值存绝对毫秒（本地日零点），「就在这一天」展开成「当天零点 ≤ t < 次日零点」两条——
   * 与「某一天」预设同一种做法：一行可以拼成不止一个节点，但字节是确定的。
   */
  private stampControls(row: Extract<TreeRow, { kind: 'stamp' }>): HTMLElement[] {
    const field = selectEl(
      [
        { value: ENGINE_CREATED, label: t('ui.query.stamp.created') },
        { value: ENGINE_MODIFIED, label: t('ui.query.stamp.modified') },
      ],
      row.field,
      (next) => {
        row.field = next === ENGINE_MODIFIED ? 'core/modified' : 'core/created'
        this.syncApply()
      },
      'qt-stamp-field',
      'stamp-field',
    )
    const op = selectEl(
      [
        { value: 'on', label: t('ui.query.stamp.on') },
        { value: 'after', label: t('ui.query.stamp.after') },
        { value: 'before', label: t('ui.query.stamp.before') },
      ],
      row.op,
      (next) => {
        row.op = next === 'after' ? 'after' : next === 'before' ? 'before' : 'on'
        this.syncApply()
      },
      'qt-stamp-op',
      'stamp-op',
    )
    const date = document.createElement('input')
    date.type = 'date'
    date.className = 'qt-value ui-input qt-slot'
    date.dataset.qt = 'value'
    date.value = row.date
    date.addEventListener('input', () => {
      row.date = date.value
      this.syncRow(date, row)
    })
    return [field, op, date]
  }

  private dayModeOf(row: Extract<TreeRow, { kind: 'day' }>): 'abs' | 'rel' | 'host' {
    if (row.date === SELF) return 'host'
    return row.rel !== undefined ? 'rel' : 'abs'
  }

  private dayValue(row: Extract<TreeRow, { kind: 'day' }>, mode: 'abs' | 'rel' | 'host'): HTMLElement {
    // 「这一天」用所在块的日期：`eq:SELF` 是既有形状，显示成一句人话，不给输入框
    if (mode === 'host') return this.selfChip(t('ui.query.selfDate'))
    if (mode === 'rel') {
      const wrap = document.createElement('span')
      wrap.className = 'qt-inline'
      const input = document.createElement('input')
      input.type = 'number'
      input.step = '1'
      input.className = 'qt-value ui-input qt-slot'
      input.dataset.qt = 'value'
      input.value = String(row.rel ?? 0)
      input.addEventListener('input', () => {
        const n = Number(input.value)
        if (input.value.trim() !== '' && Number.isFinite(n)) row.rel = Math.trunc(n)
        this.syncRow(input, row)
      })
      const chip = document.createElement('span')
      chip.className = 'qt-chip'
      chip.textContent = t('ui.query.tree.relative')
      wrap.append(input, chip)
      return wrap
    }
    const input = document.createElement('input')
    input.type = row.date !== '' && !isJournalDate(row.date) ? 'text' : 'date'
    input.className = 'qt-value ui-input qt-slot'
    input.dataset.qt = 'value'
    input.value = row.date
    input.addEventListener('input', () => {
      row.date = input.value
      this.syncRow(input, row)
    })
    return input
  }
}

/** 树的收缩态 chip 文案（`条件 · N 条`）；拆不动的形状给一句「复合条件」 */
export function treeSummary(spec: QuerySpec): string {
  const draft = treeOfSpec(spec)
  if (!draft) return t('ui.query.builder.complex')
  return t('ui.query.tree.summary', { count: treeLeafCount(draft.root) })
}
