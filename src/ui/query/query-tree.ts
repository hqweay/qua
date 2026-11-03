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
  specKeyOf,
  specOfTree,
  treeIncomplete,
  treeLeafCount,
  treeOfSpec,
  treeNodeOfRow,
  TREE_ROW_KINDS,
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
  pickRef?: (owner: Block, propId: string, current: string, onPick: (targetId: string) => void, anchor?: DOMRect) => void
  refLabel?: (targetId: string) => string
  /** 块选择器的宿主（排除自己） */
  owner?: Block
  /**
   * 显示「条数／排序」两格；缺省 `true`。
   *
   * 切片编辑用 `false`：切片只是 `QueryNode`，没有 `limit`／`sort` 的位置——
   * 画出来却存不进去，等于「点了没生效」。
   */
  showOptions?: boolean
}

const ROW_KIND_TEXT: Record<TreeRowKind, MsgId> = {
  todo: 'ui.query.kind.todo',
  tag: 'ui.query.kind.tag',
  text: 'ui.query.kind.text',
  prop: 'ui.query.kind.prop',
  ref: 'ui.query.kind.ref',
  is: 'ui.query.kind.is',
  role: 'ui.query.kind.role',
  path: 'ui.query.kind.path',
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

/** 一行还没填完时给一个默认值：布尔没有「未填」态，其它留空由用户填 */
function defaultRow(kind: TreeRowKind, field: string): TreeRow {
  if (kind === 'todo') return { kind: 'todo', value: 'todo' }
  if (kind === 'tag') return { kind: 'tag', value: '' }
  if (kind === 'text') return { kind: 'text', value: '' }
  if (kind === 'prop') return { kind: 'prop', field, op: 'eq', value: '' }
  if (kind === 'ref') return { kind: 'ref', target: '' }
  if (kind === 'is') return { kind: 'is', target: '' }
  if (kind === 'role') return { kind: 'role', role: 'journal' }
  return { kind: 'path', by: 'journal', date: '', blockId: '' }
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
  }

  /** 一行填完/清空：更新那一行的未填标记与「应用」的可用性，不重画（保焦点） */
  private syncRow(el: HTMLElement, row: TreeRow): void {
    const rowEl = el.closest<HTMLElement>('.qt-row')
    if (rowEl) {
      const incomplete = treeNodeOfRow(row) === null
      if (incomplete) rowEl.dataset.qtIncomplete = '1'
      else delete rowEl.dataset.qtIncomplete
      let hint = rowEl.querySelector<HTMLElement>('.qt-hint')
      if (incomplete) {
        if (!hint) {
          hint = document.createElement('span')
          hint.className = 'qt-hint'
          hint.textContent = t('ui.query.tree.incomplete')
          const del = rowEl.querySelector('.qt-del')
          if (del) rowEl.insertBefore(hint, del)
          else rowEl.append(hint)
        }
      } else hint?.remove()
    }
    this.syncApply()
  }

  private syncApply(): void {
    if (!this.applyBtn || !this.draft) return
    const incomplete = treeIncomplete(this.draft.root)
    this.applyBtn.disabled = incomplete
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
    if (this.deps.showOptions !== false) body.append(this.optionsEl(this.draft))
    body.append(this.footEl())
    this.box.append(body)
    if (this.focusNew) {
      this.focusNew = false
      const rows = this.box.querySelectorAll('.qt-row')
      const last = rows[rows.length - 1]
      const focusable = last?.querySelector<HTMLElement>('input, select, button')
      focusable?.focus()
    }
  }

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

    head.append(mode, notLabel)
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
      { pick: 'row:path', label: t('ui.query.kind.path') },
      { pick: 'row:role', label: t('ui.query.kind.role') },
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
      case 'todo':
        el.append(this.todoControls(row))
        break
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
          selectEl([{ value: 'journal', label: t('ui.query.role.journal') }], row.role, () => {}, 'qt-value', 'role'),
        )
        break
      case 'path':
        el.append(...this.pathControls(row))
        break
    }

    if (incomplete) {
      const hint = document.createElement('span')
      hint.className = 'qt-hint'
      hint.textContent = t('ui.query.tree.incomplete')
      el.append(hint)
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

  private todoControls(row: Extract<TreeRow, { kind: 'todo' }>): HTMLElement {
    const sel = selectEl(
      [
        { value: 'todo', label: t('ui.query.todo.todo') },
        { value: 'done', label: t('ui.query.todo.done') },
        { value: 'none', label: t('ui.query.todo.none') },
      ],
      row.value,
      (next) => {
        row.value = next === 'done' || next === 'none' ? next : 'todo'
        this.syncRow(sel, row)
      },
      'qt-value',
      'todo',
    )
    return sel
  }

  private textRowControls(row: Extract<TreeRow, { kind: 'tag' | 'text' }>): HTMLElement {
    if (row.kind === 'tag') {
      const hash = document.createElement('span')
      hash.className = 'qt-hash'
      hash.textContent = '#'
      const input = document.createElement('input')
      input.className = 'qt-value ui-input'
      input.dataset.qt = 'value'
      input.placeholder = t('ui.query.builder.tagHint')
      input.value = row.value
      input.addEventListener('input', () => {
        row.value = input.value
        this.syncRow(input, row)
      })
      const wrap = document.createElement('span')
      wrap.className = 'qt-inline'
      wrap.append(hash, input)
      return wrap
    }
    const input = document.createElement('input')
    input.className = 'qt-value ui-input'
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
      fieldOptions.push({ value: row.field, label: t('ui.query.fieldMissing') })
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

  /** 非日期的日期值（例如 `$self`）：原样显示，给一个「相对」标记；C 批会换成正式控件 */
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

  private refButton(current: string, onPick: (id: string) => void): HTMLElement {
    const label =
      current === ''
        ? t('ui.query.tree.pickBlock')
        : current === '$self'
          ? t('ui.query.tree.selfBlock')
          : (this.deps.refLabel?.(current) ?? current)
    const b = buttonEl(label, 'qt-value qt-ref', 'ref')
    b.addEventListener('click', () => {
      const owner = this.deps.owner
      if (!this.deps.pickRef || !owner) return
      this.deps.pickRef(owner, '', current, onPick, b.getBoundingClientRect())
    })
    if (!this.deps.pickRef || !this.deps.owner) {
      // 没有块选择器（例如 local tab 没有块宿主）：退化成手输 id，不把入口藏掉
      const input = document.createElement('input')
      input.className = 'qt-value ui-input'
      input.dataset.qt = 'value'
      input.placeholder = current
      input.value = current
      input.addEventListener('input', () => onPick(input.value))
      return input
    }
    return b
  }

  private pathControls(row: Extract<TreeRow, { kind: 'path' }>): HTMLElement[] {
    const out: HTMLElement[] = []
    out.push(
      selectEl(
        [
          { value: 'journal', label: t('ui.query.tree.pathDay') },
          { value: 'block', label: t('ui.query.tree.pathBlock') },
        ],
        row.by,
        (next) => {
          row.by = next === 'block' ? 'block' : 'journal'
          if (row.by === 'journal') row.dir = 'up' // 天的形状只有「之上」一个方向
          this.paint()
        },
        'qt-path-by',
        'path-by',
      ),
    )
    if (row.by === 'block') {
      out.push(
        selectEl(
          [
            { value: 'up', label: t('ui.query.tree.dirUp') },
            { value: 'down', label: t('ui.query.tree.dirDown') },
            { value: 'near', label: t('ui.query.tree.dirNear') },
          ],
          row.dir ?? 'up',
          (next) => {
            row.dir = next === 'up' ? undefined : (next as 'down' | 'near')
            this.paint()
          },
          'qt-path-dir',
          'path-dir',
        ),
      )
      out.push(
        this.refButton(row.blockId, (id) => {
          row.blockId = id
          this.paint()
        }),
      )
      // 「这一块」＝`$self`（宿主／所在容器）：随手查询的锚就住这一格里
      const self = buttonEl(t('ui.query.tree.selfBlock'), 'qt-value qt-ref', 'ref-self')
      self.title = t('ui.query.tree.selfHint')
      self.addEventListener('click', () => {
        row.blockId = '$self'
        this.paint()
      })
      out.push(self)
      return out
    }
    if (row.date !== '' && !isJournalDate(row.date)) {
      const wrap = document.createElement('span')
      wrap.className = 'qt-inline'
      const input = document.createElement('input')
      input.className = 'qt-value ui-input'
      input.dataset.qt = 'value'
      input.dataset.qtRelative = '1'
      input.value = row.date
      input.addEventListener('input', () => {
        row.date = input.value
        this.syncRow(input, row)
      })
      const chip = document.createElement('span')
      chip.className = 'qt-chip'
      chip.textContent = t('ui.query.tree.relative')
      wrap.append(input, chip)
      out.push(wrap)
      return out
    }
    const input = document.createElement('input')
    input.type = 'date'
    input.className = 'qt-value'
    input.dataset.qt = 'value'
    input.value = row.date
    input.addEventListener('input', () => {
      row.date = input.value
      this.syncRow(input, row)
    })
    out.push(input)
    return out
  }

  /* ---------------------------------------------------------- 范围/上限/顺序 */

  private optionsEl(draft: TreeDraft): HTMLElement {
    const row = document.createElement('div')
    row.className = 'qt-opts'

    const labelOf = (text: string): HTMLSpanElement => {
      const s = document.createElement('span')
      s.className = 'qt-opt-label'
      s.textContent = text
      return s
    }

    const limit = document.createElement('label')
    limit.className = 'qt-opt qt-opt--limit'
    limit.append(labelOf(t('ui.query.builder.limit')))
    const limitInput = document.createElement('input')
    limitInput.type = 'number'
    limitInput.min = '0'
    limitInput.className = 'qt-limit ui-input'
    limitInput.dataset.qt = 'limit'
    limitInput.placeholder = t('ui.query.builder.noLimit')
    limitInput.value = draft.limit === undefined ? '' : String(draft.limit)
    limitInput.addEventListener('input', () => {
      const n = Number(limitInput.value)
      if (limitInput.value.trim() === '' || !Number.isFinite(n) || n <= 0) delete draft.limit
      else draft.limit = Math.floor(n)
    })
    limit.append(limitInput)
    row.append(limit)

    const sort = document.createElement('label')
    sort.className = 'qt-opt qt-opt--sort'
    sort.append(labelOf(t('ui.query.builder.sort')))
    const fields = this.deps.fields()
    const col = selectEl(
      [{ value: '', label: t('ui.query.builder.sortNone') }, ...fields.map((f) => ({ value: f.id, label: f.label }))],
      draft.sort?.by ?? '',
      (next) => {
        draft.sort = next === '' ? undefined : { by: next, dir: draft.sort?.dir ?? 'asc' }
        if (next === '') delete draft.sort
        // 没选排序列时方向没有意义；选了之后当场解锁（这个控件不重画整棵树）
        dir.disabled = draft.sort === undefined
      },
      'qt-sort-col',
      'sort',
    )
    const dir = selectEl(
      [
        { value: 'asc', label: t('ui.view.sortAsc') },
        { value: 'desc', label: t('ui.view.sortDesc') },
      ],
      draft.sort?.dir ?? 'asc',
      (next) => {
        if (!draft.sort) return
        draft.sort = { by: draft.sort.by, dir: next === 'desc' ? 'desc' : 'asc' }
      },
      'qt-sort-dir',
      'sort-dir',
    )
    dir.disabled = draft.sort === undefined
    const controls = document.createElement('span')
    controls.className = 'qt-opt-controls'
    controls.append(col, dir)
    sort.append(controls)
    row.append(sort)
    return row
  }

  private footEl(): HTMLElement {
    const foot = document.createElement('div')
    foot.className = 'qt-foot'
    const apply = buttonEl(t('ui.query.builder.apply'), 'qt-apply ui-btn', 'apply')
    const incomplete = this.draft ? treeIncomplete(this.draft.root) : true
    apply.disabled = incomplete
    if (incomplete) apply.title = t('ui.query.tree.incomplete')
    this.applyBtn = apply
    apply.addEventListener('click', () => {
      this.apply()
      this.painted = true
    })
    foot.append(apply)
    return foot
  }
}

/** 树的收缩态 chip 文案（`条件 · N 条`）；拆不动的形状给一句「复合条件」 */
export function treeSummary(spec: QuerySpec): string {
  const draft = treeOfSpec(spec)
  if (!draft) return t('ui.query.builder.complex')
  return t('ui.query.tree.summary', { count: treeLeafCount(draft.root) })
}
