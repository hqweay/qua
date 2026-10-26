/**
 * **块属性区**：块属性是块的第一公民。
 *
 * 三词分工（定义在 `core/props.ts` 顶部）：**属性**是全局定义，**标签属性**是
 * 某个标签声明了哪些属性，**块属性**是这个块自己有哪些属性的值。
 * 本组件画的是「这个块有哪些属性的值」，顺带把「标签属性」的清单也画出来。
 *
 * 形状是**一个平铺列表**，不是按标签分节：
 *   · 同一 `propId` 只出现一次（被多个标签声明属性时**来源并列**）；
 *   · 每行标来源：`来自 #A、#B`，没有标签声明就标「本块自有」；
 *   · 声明了但没填 ⇒ 仍在列表里，显示「待填」占位（这正是标签属性的意义）；
 *   · 顺序由数据层给（标签正文顺序 × `_fieldDefs` 顺序），本组件不重排。
 *
 * ⚠️ 为什么不分节：同一条属性出现在两节里会重复；只放一节又会让来源随标签顺序变化。
 *    平铺 ＋ 多来源标注两个问题都没有（顺序只影响行序）。
 * ⚠️ 组件不写模型：所有写入经注入的回调（由装配层转成命令）。
 */
import type { Block } from '../core/index.ts'
import { plainText } from '../core/runs.ts'
import type { Dangling, FieldRow, PropKind } from '../core/index.ts'
import { clockLabel, displayNameOf, declaredFieldIds, hasList, PROP_KINDS, propKindOf } from '../core/index.ts'
import { t } from '../core/msg.ts'

export interface PropertiesDeps {
  /**
   * 属性区画在哪个块上 —— **这一屏唯一的主体**（中心槽的当前对象）。
   *
   * 不是「光标所在的块」：见装配层 `subject()` 的注释（布局跳、位置与主体不符、
   * 与 `activeId` 形成两套主体）。`null` ⇒ 没有单一主体（多根视图），整区收起。
   */
  target: () => Block | null | undefined
  /** 派生行（core 算好：标签属性 ∪ 块属性，同一 propId 只一行） */
  rows: (b: Block) => FieldRow[]
  /**
   * 这块带着哪些标签（`props._tags` 的活块）。
   *
   * ⚠️ 与「标签属性」不是一回事：标签是**分类归属**，标签属性是那个标签声明了哪些字段。
   *    同一个标签可以只当分类（没有字段）。
   */
  tags: (b: Block) => Block[]
  /** 挂一个标签（只写归属；行内露面由「正文里敲 `#名`」产生） */
  addTag: (b: Block, name: string) => void
  /** 摘掉一个标签（连带收掉它在正文里的露面） */
  removeTag: (b: Block, tagId: string) => void
  /** 森林里全部定义（「添加已有属性」用） */
  defs: () => Block[]
  /** 短 id（未知属性的显示） */
  shortId: (id: string) => string
  setValue: (b: Block, propId: string, value: unknown) => void
  clearValue: (b: Block, propId: string) => void
  /** 把已有属性声明到 owner（页/标签），成为它的标签属性；普通块则登记一条自有属性槽 */
  addField: (b: Block, propId: string) => void
  /**
   * 新建定义（可同时声明成标签属性/加块属性槽）。
   *
   * ⚠️ 收的是**名字**，不是 `propId`：这条命令是「先造定义」，id 由模型现生成。
   *    把它写成 `propId` 会让 `label` 永远是空串 ⇒ handler 早退、点了完全没反应（真踩过）。
   */
  createDef: (b: Block, label: string, kind: PropKind) => void
  /**
   * 页/标签**声明给成员**的那些属性定义（`_fieldDefs` 的活块）。
   *
   * ⚠️ 与「这一块自己有哪些值」是两件事：在页上点「添加属性」做的是**声明**，
   *    页自己没有值，所以不会在块属性里长出任何一行。没有这一段，那次点击就没有可见结果。
   */
  declaredFields: (b: Block) => Block[]
  /** 解除一条声明（只摘清单；成员块上的值一个字节不动） */
  undeclareField: (b: Block, propId: string) => void
  /**
   * **给 `ref` 类型的值选一个目标块**（装配层弹出选择器，选中后回调写值）。
   *
   * 为什么必须走注入：选择器要读**整片森林**（页、标签、任意块），
   * 而属性区只认识「当前这一块」——它也拿不到 DOM 之外的浮层。
   * 不注入的话，`ref` 只能让用户手打 32 位 id，那等于没有这个类型。
   */
  pickRef: (b: Block, propId: string, current: string, onPick: (targetId: string) => void, anchor?: DOMRect) => void
  /**
   * **这一块归在谁下面**（`props._belongsTo` 的活块，有序）。
   *
   * ⚠️ 与「标签」那一行不是一回事：标签是分类（instance-of），归属是 filed-under。
   *    一条归属边可以连任何块；**跨类的那条边只在这里看得见**（归属树按露面筛子项）。
   */
  belongsTo: (b: Block) => Block[]
  /** 悬空上级的两态（回收站里的不能清、真没了的能清） */
  belongsDangling: (b: Block) => Dangling
  /** 加一条归属（按名字在页／标签里找；找不到就提示） */
  addBelong: (b: Block, name: string) => void
  /** 删一条归属（只动这一块；不碰名字、不碰它的子块） */
  removeBelong: (b: Block, parentId: string) => void
  /** 清理「上级真没了」的那些 */
  pruneBelongs: (b: Block) => void
  /** 把一个块 id 变成人能读的名字（`ref` 值的显示） */
  refLabel: (targetId: string) => string
  toast: (text: string, kind?: 'ok' | 'warn' | 'info') => void
}

/**
 * 一行字段编辑需要的**最小能力**：读写值、解析 / 选择 `ref` 目标。
 *
 * 单独收窄是为了让「属性区」与「行内实例浮层」共用同一个行渲染器：
 * 后者不需要标签行、归属行、系统信息，只需要这一组回调。
 */
export type FieldRowDeps = Pick<PropertiesDeps, 'shortId' | 'setValue' | 'clearValue' | 'pickRef' | 'refLabel'>

export interface PropertiesEls {
  /** 卡片本身：`hidden` 与否表达「有没有主体」 */
  root: HTMLElement
  /**
   * 卡片标题。**由装配层写当前对象的名字**（`displayNameOf`），面板不写死「块属性」——
   * 标题要回答「现在在改谁」，而这个名字每个主体都不一样。
   */
  title: HTMLElement
  body: HTMLElement
  add: HTMLButtonElement
}

/**
 * 一行值的编辑器（按 kind）。返回控件元素。
 *
 * `ref` 与其它类型不同：它不是「输入一个值」，而是**选一个块**。
 * 所以它需要 deps（弹选择器、解析显示名），不能只靠 `commit`。
 */
function valueEditor(
  row: FieldRow,
  commit: (v: unknown) => void,
  deps?: Pick<FieldRowDeps, 'pickRef' | 'refLabel'>,
  owner?: Block,
): HTMLElement {
  const kind = row.kind
  if (kind === 'checkbox') {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'prop-check'
    box.checked = row.value === true
    box.addEventListener('change', () => commit(box.checked))
    return box
  }
  /**
   * `ref`：显示目标的名字，点一下换目标。
   *
   * ⚠️ **不提供手打 id 的输入框**：32 位 hex 没人记得住，让它可编辑等于让人拼手速。
   *    值的形状仍然是「一个块 id」（模型层不变），只是入口换成了选择器。
   */
  if (kind === 'ref' && deps && owner) {
    const current = row.value === undefined || row.value === null ? '' : String(row.value)
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'prop-input prop-ref'
    btn.dataset.refId = current
    btn.textContent = current === '' ? t('ui.props.pending') : deps.refLabel(current)
    btn.addEventListener('click', () => {
      deps.pickRef(owner, row.propId, current, (targetId) => commit(targetId === '' ? undefined : targetId), btn.getBoundingClientRect())
    })
    return btn
  }
  if (kind === 'select') {
    const sel = document.createElement('select')
    sel.className = 'prop-input'
    const choices = Array.isArray(row.def?.props?._choices) ? (row.def!.props!._choices as string[]) : []
    const opts = [...choices]
    const current = row.value === undefined || row.value === null ? '' : String(row.value)
    if (current !== '' && !opts.includes(current)) opts.unshift(current)
    const empty = document.createElement('option')
    empty.value = ''
    empty.textContent = t('ui.props.pending')
    sel.appendChild(empty)
    for (const c of opts) {
      const o = document.createElement('option')
      o.value = c
      o.textContent = c
      sel.appendChild(o)
    }
    sel.value = current
    sel.addEventListener('change', () => commit(sel.value === '' ? undefined : sel.value))
    return sel
  }
  const input = document.createElement('input')
  input.className = 'prop-input'
  input.type = kind === 'date' ? 'date' : 'text'
  if (kind === 'number') input.inputMode = 'decimal'
  input.placeholder = t('ui.props.pending')
  input.value = row.value === undefined || row.value === null ? '' : String(row.value)
  input.addEventListener('change', () => commit(input.value === '' ? undefined : input.value))
  return input
}

/**
 * **一行字段**：标签名（含来源）＋ 按 kind 的值控件 ＋ 清空。
 *
 * 属性区与行内实例浮层共用这一份：一处改了行布局，两处一起变。
 * `labelCount` 用来消歧「同名不同 propId」——两个字段都叫「状态」时，
 * 只靠 label 用户分不出改的是哪一个。
 */
export function makeFieldRow(
  row: FieldRow,
  target: Block,
  deps: FieldRowDeps,
  opts: { labelCount?: ReadonlyMap<string, number>; showSource?: boolean } = {},
): HTMLElement {
  const el = document.createElement('div')
  el.className = 'prop-row'
  el.dataset.propId = row.propId
  if (!row.filled) el.dataset.pending = '1'

  const label = document.createElement('label')
  label.className = 'prop-label'
  const name = document.createElement('span')
  name.className = 'prop-name'
  const source = row.sources.length
    ? t('ui.props.source', { tags: row.sources.map((s) => `#${displayNameOf(s)}`).join('、') })
    : t('ui.props.own')
  const duplicated = (opts.labelCount?.get(row.label) ?? 0) > 1
  const disambiguated = duplicated ? `${row.label}（${row.sources[0] ? displayNameOf(row.sources[0]) : t('ui.props.own')}）` : row.label
  name.textContent = row.def ? disambiguated : t('ui.props.unknown', { id: deps.shortId(row.propId) })
  label.appendChild(name)
  if (opts.showSource !== false) {
    const src = document.createElement('span')
    src.className = 'prop-source'
    src.textContent = source
    label.appendChild(src)
  }

  const value = document.createElement('span')
  value.className = 'prop-value'
  value.appendChild(
    valueEditor(
      row,
      (v) => {
        if (v === undefined) deps.clearValue(target, row.propId)
        else deps.setValue(target, row.propId, v)
      },
      deps,
      target,
    ),
  )

  const clear = document.createElement('button')
  clear.type = 'button'
  clear.className = 'prop-clear ghost'
  clear.title = t('ui.props.clear')
  clear.textContent = '×'
  clear.addEventListener('click', () => deps.clearValue(target, row.propId))

  el.append(label, value, clear)
  return el
}

export class PropertiesPanel {
  private readonly els: PropertiesEls
  private readonly deps: PropertiesDeps
  private formOpen = false

  constructor(els: PropertiesEls, deps: PropertiesDeps) {
    this.els = els
    this.deps = deps
    this.els.add.textContent = t('ui.props.addShort')
    this.els.add.title = t('ui.props.add')
    this.els.add.addEventListener('click', () => {
      this.formOpen = !this.formOpen
      this.render()
    })
  }

  render(): void {
    const target = this.deps.target()
    if (!target) {
      this.els.root.hidden = true
      delete this.els.root.dataset.targetBlockId
      return
    }
    /**
     * **全部属性行都在这一张卡里可编辑**，包括 `_uiPosition: 'block-left'` 的那些。
     *
     * 曾经的规则是「一个值不开两个编辑面」⇒ 归 gutter 的行从这里排除，只留一句
     * 「在块左侧编辑」。实际用起来那一句就是死路：任务状态是最高频的属性，而用户
     * 在这个卡片里看到它、却改不了它，得先想起来「左侧还有个小方框」。
     *
     * 改成两面共存的前提是**两面读写同一份东西**：行的派生是同一个 `fieldRows`
     * （`gutterFieldsOf` 是它的一个视图）、写是同一类 `core.props/set-value`、
     * 写完两边都重画（`writeProps` 会 `repaintBlock` ＋ `scheduleProperties`）。
     * ⇒ 「面板改了 gutter 没跟上」这个当初的理由不再成立，所以互斥可以撤。
     *
     * ⚠️ `_uiPosition` 仍然有意义：它决定**快捷入口画在哪**（高频二元开关要在行上够得着），
     *    不是「只有那一处能改」。
     */
    const rows = this.deps.rows(target)
    /**
     * **有当前对象就显示**，不因为「没有行」而收起。
     *
     * ⚠️ 判据是入口而不是内容：一个块总能加属性，而「＋ 添加块属性」就在这一区的抬头上。
     *    按行数收起过一次，结果普通块在加第一条属性之前面板根本不出现 —— 那个加号也就
     *    没了，于是「给一个空块加第一个属性」这条路径根本走不通。
     */
    this.els.root.hidden = false
    // 诊断/冒烟面：面板现在画在哪一块上（收起时删掉，避免读到上一次的目标）
    this.els.root.dataset.targetBlockId = target.id
    this.els.body.replaceChildren()

    // 标签在第一行：它是**分类**，比「有哪些字段」更先决定这一块是什么
    this.els.body.appendChild(this.buildTags(target))
    // 归属紧随其后：与标签并列的另一种「它是谁的」。任何块都有这一行
    this.els.body.appendChild(this.buildBelongs(target))

    if (rows.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'props-empty'
      empty.textContent = t('ui.props.empty')
      this.els.body.appendChild(empty)
    }

    // 同名不同 propId 必须能区分（C4）：两行 label 一样时把来源带进显示名
    const labelCount = new Map<string, number>()
    for (const r of rows) labelCount.set(r.label, (labelCount.get(r.label) ?? 0) + 1)

    for (const row of rows) {
      this.els.body.appendChild(makeFieldRow(row, target, this.deps, { labelCount }))
    }

    /**
     * **声明给成员的属性**（只有页/标签有）。
     *
     * 与上面那一段是两件事：那一段是「这一块自己的值」，这一段是「我的成员会有哪些格子」。
     * 页/标签上点「添加属性」做的正是**声明**，所以不画这一段，那次点击就没有可见结果。
     */
    if (hasList(target, 'page') || hasList(target, 'tag')) {
      this.els.body.appendChild(this.buildDeclared(target))
    }

    if (this.formOpen) this.els.body.appendChild(this.buildForm(target))
    // 系统信息在**最后**：它是这一块的出生与改动记录，不是可编辑的数据
    this.els.body.appendChild(this.buildSystem(target))
  }

  /**
   * **系统信息**（只读）：创建时间／修改时间两行。
   *
   * 为什么单独成段而不是混进属性行：它们**不是属性**（不在属性袋里，也没有定义块），
   * 面板的每一行都带「编辑控件 ＋ 清除按钮」，把只读事实塞进那种行里，用户会去点、
   * 点了没反应。判据是「可见但只读」由**通道**提供 —— 这一段就没有输入控件。
   */
  private buildSystem(target: Block): HTMLElement {
    const box = document.createElement('div')
    box.className = 'prop-row prop-system'
    const label = document.createElement('label')
    label.className = 'prop-label'
    const name = document.createElement('span')
    name.className = 'prop-name'
    name.textContent = t('ui.props.systemTitle')
    label.append(name)

    const value = document.createElement('span')
    value.className = 'prop-value prop-system-value'
    for (const [key, at] of [
      ['created', target.created],
      ['modified', target.modified],
    ] as const) {
      const line = document.createElement('span')
      line.className = 'prop-system-line'
      line.dataset.systemField = key
      line.textContent = `${t(key === 'created' ? 'ui.props.createdAt' : 'ui.props.modifiedAt')} ${clockLabel(at) || t('ui.props.timeUnknown')}`
      value.appendChild(line)
    }
    box.append(label, value)
    return box
  }

  /**
   * **声明给成员的属性**（只有页/标签有这一段）。
   *
   * 判据：声明是「我的成员/子块会有这一格」，不是「给这一块设一个值」——
   * 所以这一段只有清单和解除，没有值控件。值仍旧只在成员块上。
   *
   * ⚠️ 解除声明**不动值**：成员块上已有的值落回「本块自有」，重新声明后自动回来。
   * ⚠️ 这段与「字段声明」抽屉（`ui/fields-editor.ts`）看的是同一份 `_fieldDefs`：
   *    抽屉里还能**从全部定义里挑一条**加，这里只列已声明 ＋ 解除。
   *    多出来的「添加」入口在抬头的「＋ 属性」里（选已有／新建都走它）。
   */
  private buildDeclared(target: Block): HTMLElement {
    const row = document.createElement('div')
    row.className = 'prop-row prop-declared'
    const label = document.createElement('label')
    label.className = 'prop-label'
    const name = document.createElement('span')
    name.className = 'prop-name'
    name.textContent = t('ui.props.declaredTitle')
    label.append(name)
    const hint = document.createElement('span')
    hint.className = 'prop-source'
    hint.textContent = t('ui.props.declaredHint')
    label.append(hint)

    const value = document.createElement('span')
    value.className = 'prop-value props-tag-value'
    const defs = this.deps.declaredFields(target)
    if (defs.length === 0) {
      const empty = document.createElement('span')
      empty.className = 'props-empty'
      empty.textContent = t('ui.props.declaredEmpty')
      value.appendChild(empty)
    }
    for (const def of defs) {
      const chip = document.createElement('span')
      chip.className = 'props-tag'
      chip.dataset.declaredPropId = def.id
      const text = document.createElement('span')
      text.textContent = `${plainText(def.content).trim() || def.id} · ${t(`ui.props.kind.${propKindOf(def)}`)}`
      const del = document.createElement('button')
      del.type = 'button'
      del.className = 'props-tag-x'
      del.title = t('ui.props.undeclare')
      del.textContent = '×'
      del.addEventListener('click', () => this.deps.undeclareField(target, def.id))
      chip.append(text, del)
      value.appendChild(chip)
    }

    row.append(label, value)
    return row
  }

  /**
   * **这一块归在谁下面**（`props._belongsTo`）。
   *
   * 判据：**能配在任何块上的关系，住在属性区**；只有某类块才有的关系（成员）住在那个块的面板里。
   * 所以这一行对**每个**块都出现，而标签面板只剩「成员」。
   *
   * 两种悬空必须分开显示：上级在回收站（等它复活，边会自己接回）与上级真没了（可清理）。
   * 都画成「已删除」会让人一点清理就把能复活的边清掉。
   */
  private buildBelongs(target: Block): HTMLElement {
    const row = document.createElement('div')
    row.className = 'prop-row prop-belongs'
    const label = document.createElement('label')
    label.className = 'prop-label'
    const name = document.createElement('span')
    name.className = 'prop-name'
    name.textContent = t('ui.belongs.title')
    label.append(name)

    const value = document.createElement('span')
    value.className = 'prop-value props-tag-value'

    const chip = (id: string, text: string, title: string): HTMLElement => {
      const el = document.createElement('span')
      el.className = 'props-tag'
      el.dataset.belongsId = id
      const t0 = document.createElement('span')
      t0.textContent = text
      t0.title = title
      const del = document.createElement('button')
      del.type = 'button'
      del.className = 'props-tag-x'
      del.title = t('ui.belongs.remove')
      del.textContent = '×'
      del.addEventListener('click', () => this.deps.removeBelong(target, id))
      el.append(t0, del)
      return el
    }

    for (const p of this.deps.belongsTo(target)) {
      const n = displayNameOf(p).trim()
      value.appendChild(chip(p.id, n === '' ? this.deps.shortId(p.id) : n, p.id))
    }
    const dangling = this.deps.belongsDangling(target)
    for (const id of dangling.revivable) {
      const el = chip(id, `${this.deps.shortId(id)}${t('ui.belongs.revivable')}`, t('ui.belongs.revivableHint'))
      el.dataset.dangling = 'revivable'
      value.appendChild(el)
    }
    for (const id of dangling.gone) {
      const el = chip(id, `${this.deps.shortId(id)}${t('ui.belongs.deleted')}`, t('ui.belongs.deletedHint'))
      el.dataset.dangling = 'gone'
      value.appendChild(el)
    }
    if (dangling.gone.length > 0) {
      const prune = document.createElement('button')
      prune.type = 'button'
      prune.className = 'tagpanel-action ghost'
      prune.dataset.pruneBelongs = '1'
      prune.textContent = t('ui.belongs.prune', { count: dangling.gone.length })
      prune.addEventListener('click', () => this.deps.pruneBelongs(target))
      value.appendChild(prune)
    }

    const input = document.createElement('input')
    input.className = 'prop-input props-tag-input'
    input.placeholder = t('ui.belongs.placeholder')
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      const parentName = input.value.trim()
      if (parentName === '') return
      this.deps.addBelong(target, parentName)
      input.value = ''
    })
    value.appendChild(input)

    row.append(label, value)
    return row
  }

  /**
   * **这块的标签**（块级归属）。
   *
   * 这一行只读 `props._tags`：它是「我有哪些分类」，不是「它在正文里出现在哪」。
   * 正文里敲 `#名` 是**提及**（插一枚 ref run），不写归属、也不会出现在这一行；
   * 两者唯一的交叠是显示：同一行里已经提过的标签，行右端不再重复画 chip。
   *
   * ⚠️ 摘标签不只删这一行：正文里那枚 `#名` 也要收掉（`deps.removeTag` 负责），
   *    否则归属没了、正文里还挂着一个看起来像标签的东西。
   */
  private buildTags(target: Block): HTMLElement {
    const row = document.createElement('div')
    row.className = 'prop-row prop-tags'
    const label = document.createElement('label')
    label.className = 'prop-label'
    const name = document.createElement('span')
    name.className = 'prop-name'
    name.textContent = t('ui.props.tagsTitle')
    label.append(name)

    const value = document.createElement('span')
    value.className = 'prop-value props-tag-value'
    for (const tag of this.deps.tags(target)) {
      const chip = document.createElement('span')
      chip.className = 'props-tag'
      chip.dataset.panelTagId = tag.id
      const text = document.createElement('span')
      text.textContent = `#${displayNameOf(tag)}`
      const del = document.createElement('button')
      del.type = 'button'
      del.className = 'props-tag-x'
      del.title = t('ui.props.tagRemove')
      del.textContent = '×'
      del.addEventListener('click', () => this.deps.removeTag(target, tag.id))
      chip.append(text, del)
      value.appendChild(chip)
    }
    const input = document.createElement('input')
    input.className = 'prop-input props-tag-input'
    input.placeholder = t('ui.props.tagPlaceholder')
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      const tagName = input.value.trim()
      if (tagName === '') return
      this.deps.addTag(target, tagName)
      input.value = ''
    })
    value.appendChild(input)

    row.append(label, value)
    return row
  }

  /**
   * 添加块属性：选已有定义（默认复用）或新建一个。
   *
   * ⚠️ **类型只属于「新建定义」，不属于「给这一块加一条属性」**：`_kind` 住在定义块上、
   *    全库一份，而 `addField` 只吃一个 `propId`——选已有属性能配类型是假的。
   *    所以两件事分两行画：第一行选/复用，第二行（只在「新建」时出现）才是名字＋类型。
   */
  private buildForm(target: Block): HTMLElement {
    const form = document.createElement('form')
    form.className = 'props-form'
    form.addEventListener('submit', (e) => e.preventDefault())

    /** 「新建定义」的哨兵值：它不是任何真实定义的 id，只用来把下拉切到第二行 */
    const NEW_OPTION = '__new__'

    const pick = document.createElement('select')
    pick.className = 'prop-input props-pick'
    const placeholder = document.createElement('option')
    placeholder.value = ''
    placeholder.textContent = t('ui.props.pick')
    pick.appendChild(placeholder)
    /**
     * **「已有」＝ 这一块已经有这条属性**，而它的入口不一定在这个面板：
     * 标签声明的、块上已有值的都算；页/标签自己**声明过**的也算 ——
     * 否则选它只会再声明一次（`declareField` 幂等），点了像没反应。
     *
     * 这些项**留在列表里但不可选**，而不是从列表里删掉：
     * 删掉之后，一个只有两三条定义的小库会得到空下拉 ——
     * 用户分不清「库里没有这条属性」与「本块已经有了」。
     */
    const defs = this.deps.defs()
    const used = new Set(this.deps.rows(target).map((r) => r.propId))
    const declared = hasList(target, 'page') || hasList(target, 'tag') ? new Set(declaredFieldIds(target)) : new Set<string>()
    for (const def of defs) {
      const mark = used.has(def.id)
        ? t('ui.props.alreadyOn')
        : declared.has(def.id)
          ? t('ui.props.declaredOn')
          : ''
      const o = document.createElement('option')
      o.value = def.id
      o.textContent = `${plainText(def.content).trim() || def.id} · ${t(`ui.props.kind.${propKindOf(def)}`)}${mark ? `（${mark}）` : ''}`
      o.disabled = mark !== ''
      pick.appendChild(o)
    }
    const newOption = document.createElement('option')
    newOption.value = NEW_OPTION
    newOption.textContent = t('ui.props.newOption')
    pick.appendChild(newOption)

    const pickBtn = document.createElement('button')
    pickBtn.type = 'button'
    pickBtn.className = 'props-use'
    pickBtn.textContent = t('ui.props.use')
    pickBtn.addEventListener('click', () => {
      if (!pick.value || pick.value === NEW_OPTION) return
      this.deps.addField(target, pick.value)
      this.formOpen = false
      this.render()
    })

    const label = document.createElement('input')
    label.className = 'prop-input'
    label.placeholder = t('ui.props.newLabel')
    const kind = document.createElement('select')
    kind.className = 'prop-input'
    for (const k of PROP_KINDS) {
      const o = document.createElement('option')
      o.value = k
      o.textContent = t(`ui.props.kind.${k}`)
      kind.appendChild(o)
    }
    const create = document.createElement('button')
    create.type = 'submit'
    create.className = 'props-create'
    create.textContent = t('ui.props.create')
    create.addEventListener('click', () => {
      const name = label.value.trim()
      if (name === '') {
        this.deps.toast(t('ui.props.needLabel'), 'warn')
        return
      }
      this.deps.createDef(target, name, kind.value as PropKind)
      this.formOpen = false
      this.render()
    })

    // 新建组整块占一行：它的三个控件只一起出现，不能和第一行的「用这个」混排
    const newGroup = document.createElement('div')
    newGroup.className = 'props-new-group'
    newGroup.hidden = true
    newGroup.append(label, kind, create)

    /** 形态跟着下拉走：占位空值两者都藏，选哨兵露新建组，选真实定义露「用这个」 */
    const syncShape = (): void => {
      const isNew = pick.value === NEW_OPTION
      newGroup.hidden = !isNew
      pickBtn.hidden = !pick.value || isNew
    }
    pick.addEventListener('change', syncShape)

    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'ghost'
    cancel.textContent = t('ui.props.cancel')
    cancel.addEventListener('click', () => {
      this.formOpen = false
      this.render()
    })

    // 库里一条定义都没有时，空下拉是死路：直接切到「新建」并展开第二行。
    // ⚠️ 只有「没有定义」才算死路；「定义都在本块上」不是 —— 下拉里那些灰掉的项
    //    正是用户要的答案（本块已经有它，只是入口不在这个面板）。
    if (defs.length === 0) pick.value = NEW_OPTION
    syncShape()

    for (const el of [pick, pickBtn, cancel, newGroup]) form.appendChild(el)
    return form
  }
}
