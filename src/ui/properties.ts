/**
 * **块属性区**：块属性是块的第一公民。
 *
 * 三词分工（定义在 `core/props.ts` 顶部）：**属性**是全局定义，**标签属性**是
 * 某个标签声明了哪些属性，**块属性**是这个块自己有哪些属性的值。
 * 本组件画的是「这个块有哪些属性的值」，顺带把「标签属性」的清单也画出来。
 *
 * 形状是**块属性一段 ＋ 标签属性一段**，段内平铺：
 *   · 块属性：同一 `propId` 只出现一次（被多个标签声明属性时**来源并列**）；
 *   · 每行标来源：`来自 #A、#B`，没有标签声明就标「本块自有」；
 *   · 声明了但没填 ⇒ 仍出现在块属性里，显示「待填」占位（这正是标签属性的意义）；
 *   · 顺序由数据层给（标签正文顺序 × `_fieldDefs` 顺序），本组件不重排。
 *
 * ⚠️ 为什么块属性段内不分节：同一条属性出现在两节里会重复；只放一节又会让来源随标签顺序变化。
 *    平铺 ＋ 多来源标注两个问题都没有（顺序只影响行序）。
 * ⚠️ 但**声明**必须另成一段：它写 `_fieldDefs`、不是这一块的值；画成同一种行会让人
 *    把它当成另一条属性（也会诱导两个 picker 共用去重集合）。
 * ⚠️ 组件不写模型：所有写入经注入的回调（由装配层转成命令）。
 */
import type { Block } from '../core/index.ts'
import { plainText } from '../core/runs.ts'
import type { Dangling, FieldRow, PropKind } from '../core/index.ts'
import type { PropCreateMode } from '../core/ports.ts'
import {
  choiceDisplayLabel,
  clockLabel,
  displayNameOf,
  declaredFieldIds,
  hasList,
  isPropDef,
  normalizeAlias,
  PROP_KINDS,
  propKindOf,
  propLabel,
} from '../core/index.ts'
import { t } from '../core/msg.ts'
import { ChoicesEditor, type ChoiceActions } from './choices-editor.ts'

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
  /**
   * **打开一个指向某块的露面**（这一行里只有标签名用它）。
   *
   * 判据与正文里的标签 chip 是同一条：**一份归属的每一处露面，点名字都打开它**。
   * 不注入的话，同一个标签在正文里能点、在属性区点了没反应 —— 同一件事有两种行为，
   * 每一次都要重新猜一遍哪个能点。
   */
  openRef: (to: string, mods: { shiftKey: boolean }) => void
  /** 森林里全部定义（「添加已有属性」用） */
  defs: () => Block[]
  /** 短 id（未知属性的显示） */
  shortId: (id: string) => string
  setValue: (b: Block, propId: string, value: unknown) => void
  clearValue: (b: Block, propId: string) => void
  /** 把已有属性加进**这一块自己的值槽**（`_ownProps`） */
  addOwnProp: (b: Block, propId: string) => void
  /** 新建一条定义并加进**这一块自己的值槽**（`mode: 'new'` ＝ 同名也新建） */
  createOwnDef: (b: Block, label: string, kind: PropKind, mode?: PropCreateMode) => void
  /** 把已有属性**声明给成员**（标签属性／字段声明，写 `_fieldDefs`；只有页/标签能声明） */
  declareProp: (b: Block, propId: string) => void
  /** 新建一条定义并**声明给成员**（标签属性／字段声明） */
  createDeclaredDef: (b: Block, label: string, kind: PropKind, mode?: PropCreateMode) => void
  /**
   * 页/标签**声明给成员**的那些属性定义（`_fieldDefs` 的活块）。
   *
   * ⚠️ 与「这一块自己有哪些值」是两件事：在页/标签上点自己的添加入口做的是**声明**，
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
  /**
   * 标签块的显示名（选项作用域徽标里的 `#名`）。
   *
   * 由装配层注入（`kb.get` 是 O(1) 的索引读）：UI 不该为了一个名字去扫整片森林。
   */
  tagName: (id: string) => string
  /** 按 id 取块（选项编辑器判「来源标签还在不在」） */
  blockById: (id: string) => Block | undefined
  /** 全部标签（选项作用域的勾选候选） */
  allTags: () => readonly Block[]
  /**
   * `propId → 显示名`（同名属性带声明来源，仍重名再带短 id）。
   *
   * 由装配层用 `propDisplayLabels` 一次算好：UI 逐行扫森林会把这个面板变成 O(n²)，
   * 而且显示名会出现两种口径。
   */
  propLabels: () => ReadonlyMap<string, string>
  /** `propId → 声明它的标签`（picker 的「本标签／未声明／其他标签」分组用） */
  fieldDeclarations: () => ReadonlyMap<string, readonly Block[]>
  /** 选项的写入口（命令；组件不直接改块） */
  choices: ChoiceActions
  toast: (text: string, kind?: 'ok' | 'warn' | 'info') => void
}

/**
 * 一行字段编辑需要的**最小能力**：读写值、解析 / 选择 `ref` 目标。
 *
 * 单独收窄是为了让「属性区」与「行内实例浮层」共用同一个行渲染器：
 * 后者不需要标签行、归属行、系统信息，只需要这一组回调。
 */
export type FieldRowDeps = Pick<PropertiesDeps, 'shortId' | 'setValue' | 'clearValue' | 'pickRef' | 'refLabel'> & {
  /** 标签名解析（选项显示名的 `#名`）；缺省显示短 id */
  tagName?: (id: string) => string
  /** 打开属性定义块（普通块的属性名可点：改选项去定义页，不在块上再开一个编辑面） */
  openRef?: PropertiesDeps['openRef']
}

/**
 * 值控件要的那一小撮能力：`ref` 要选择器与显示名，`select` 要标签名。
 *
 * 全都可以缺省：表格格子里没有属性区那套依赖时，控件退化成只读/短 id 显示，
 * 而不是「点了报错」。
 */
export type CellEditorDeps = Partial<Pick<FieldRowDeps, 'pickRef' | 'refLabel' | 'tagName'>>

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
 *
 * ⚠️ **属性区与表格单元格共用这一份**：两处各写一套控件，迟早出现
 *    「面板里 Enter 能提交、表格里不能」这种只在某处复现的分叉。
 */
export function makeCellEditor(
  row: FieldRow,
  commit: (v: unknown) => void,
  deps?: CellEditorDeps,
  owner?: Block,
): HTMLElement {
  const kind = row.kind
  /**
   * **同一个值不重复提交**。
   *
   * 控件会给两条提交路径：`change`（失焦/选择）与 Enter（表格里显式派一次 `change`）。
   * 用键盘在输入框里敲完直接 Enter 时两条都会走到 —— 第二次提交的值与第一次相同，
   * 于是产出一次「零 op 的事务」，把 `lastOps` 冲成空数组：
   * 账面上「改了却没写」，而实际写了。这里按**控件自己记住的最后一个值**去重。
   */
  let last: unknown = row.value
  const same = (a: unknown, b: unknown): boolean => {
    const ea = a === undefined || a === null || a === ''
    const eb = b === undefined || b === null || b === ''
    if (ea && eb) return true
    return a === b
  }
  const send = (v: unknown): void => {
    if (same(last, v)) return
    last = v
    commit(v)
  }
  if (kind === 'checkbox') {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'prop-check'
    /**
     * **三态**：有槽没勾（`false`）与没有这一槽（`undefined`）是两件事 ——
     * 「是任务但没填」与「不是任务」在待办条件里分得开，靠的就是这两位。
     * 浏览器只能画两态 ⇒ 用 `indeterminate` 把「没有值」画出来。
     */
    box.checked = row.value === true
    box.indeterminate = row.value === undefined || row.value === null
    box.addEventListener('change', () => send(box.checked))
    return box
  }
  /**
   * `ref`：显示目标的名字，点一下换目标。
   *
   * ⚠️ **不提供手打 id 的输入框**：32 位 hex 没人记得住，让它可编辑等于让人拼手速。
   *    值的形状仍然是「一个块 id」（模型层不变），只是入口换成了选择器。
   */
  if (kind === 'ref' && deps?.pickRef && owner) {
    const pick = deps.pickRef
    const current = row.value === undefined || row.value === null ? '' : String(row.value)
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'prop-input prop-ref'
    btn.dataset.refId = current
    btn.textContent = current === '' ? t('ui.props.pending') : (deps.refLabel?.(current) ?? current)
    btn.addEventListener('click', () => {
      pick(owner, row.propId, current, (targetId) => send(targetId === '' ? undefined : targetId), btn.getBoundingClientRect())
    })
    return btn
  }
  if (kind === 'select') {
    const sel = document.createElement('select')
    sel.className = 'prop-input'
    /**
     * 选项只从 `row.choices` 来（派生好的一份）：UI 不认识「选项目录存在哪」，
     * 也就不会出现「属性面板与表格各读一处、两处能不一致」。
     */
    const choices = row.choices ?? []
    const current = row.value === undefined || row.value === null ? '' : String(row.value)
    const tagName = deps?.tagName ?? ((id: string) => id.slice(-6))
    const empty = document.createElement('option')
    empty.value = ''
    empty.textContent = t('ui.props.pending')
    sel.appendChild(empty)
    for (const c of choices) {
      const o = document.createElement('option')
      o.value = c.id
      o.textContent = row.def ? choiceDisplayLabel(c, row.def, tagName) : plainText(c.content).trim() || c.id.slice(-6)
      sel.appendChild(o)
    }
    /**
     * **当前值不在可见选项里**（作用域隐藏 / 选项软删 / 值来自另一个库）时，
     * 仍然画出来并保持选中：值在模型里还在，控件不许替用户把它丢掉。
     * 用户可显式切走或清空 —— 那是他的动作，不是这一次渲染的副作用。
     */
    if (current !== '' && !choices.some((c) => c.id === current)) {
      const o = document.createElement('option')
      o.value = current
      o.textContent = row.currentChoiceLabel ?? t('ui.props.choice.deleted')
      o.dataset.missing = '1'
      o.title = row.currentChoiceLabel ? t('ui.props.choice.notInScope') : t('ui.props.choice.deleted')
      sel.appendChild(o)
    }
    sel.value = current
    sel.addEventListener('change', () => send(sel.value === '' ? undefined : sel.value))
    return sel
  }
  const input = document.createElement('input')
  input.className = 'prop-input'
  input.type = kind === 'date' ? 'date' : 'text'
  if (kind === 'number') input.inputMode = 'decimal'
  input.placeholder = t('ui.props.pending')
  input.value = row.value === undefined || row.value === null ? '' : String(row.value)
  input.addEventListener('change', () => {
    if (input.value === '') {
      send(undefined)
      return
    }
    /**
     * **数字提交的是 `number`**（不是字符串）：排序与统计按值比，字符串会退化成字典序
     * （`10` 排在 `9` 前面），而且从表面看只是「顺序有点怪」。
     * 解析失败 ⇒ 不写（回退原值，一次 op 都不产）。
     */
    if (kind === 'number') {
      const n = Number(input.value)
      if (!Number.isFinite(n)) {
        input.value = row.value === undefined || row.value === null ? '' : String(row.value)
        return
      }
      send(n)
      return
    }
    send(input.value)
  })
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
  opts: { labelCount?: ReadonlyMap<string, number>; showSource?: boolean; labels?: ReadonlyMap<string, string> } = {},
): HTMLElement {
  const el = document.createElement('div')
  el.className = 'prop-row ui-row'
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
  // 有 `labels` 就用它（同名属性带声明来源；仍重名带短 id）——只在一个地方决定「这一行叫什么」
  const shown = opts.labels?.get(row.propId) ?? disambiguated
  name.textContent = row.def ? shown : t('ui.props.unknown', { id: deps.shortId(row.propId) })
  /**
   * **属性名指向定义块**。普通块上只画值控件：要改选项/类型，点名字去定义页，
   * 不在块上再开第三个编辑面（同一个东西三处可改＝三处都能不同步）。
   */
  if (row.def && deps.openRef) {
    name.dataset.refTo = row.def.id
    name.title = t('ui.props.openDef')
    name.addEventListener('click', (e) => deps.openRef!(row.def!.id, { shiftKey: e.shiftKey }))
  }
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
    makeCellEditor(
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
  /**
   * 哪个添加表单开着：`own`（这一块自己的值）／`declared`（标签属性／字段声明）／`null`。
   *
   * ⚠️ 不能是一个布尔：两个入口写的是两个槽，同时开着会让「点了哪个」变得不可知。
   */
  private formOpen: 'own' | 'declared' | null = null
  /**
   * 选项编辑器的两个实例（各自记住「哪个作用域面板展开着」）。
   *
   * 状态必须**在面板里**而不是组件 DOM 里：勾一个标签会写一次模型，
   * 卡片随后整体重画 —— 状态存在 DOM 上就会被这次重画连根拔掉。
   */
  private readonly choicesFull: ChoicesEditor
  private readonly choicesTag: ChoicesEditor
  /** 标签视角打开的是哪条属性的选项（`chip` 上的「选项」按钮切换它） */
  private tagChoices: { def: Block; owner: Block } | null = null

  constructor(els: PropertiesEls, deps: PropertiesDeps) {
    this.els = els
    this.deps = deps
    const base = {
      tagById: (id: string) => this.deps.blockById(id),
      tags: () => this.deps.allTags(),
      write: this.deps.choices,
      tagName: (id: string) => this.deps.tagName(id),
    }
    this.choicesFull = new ChoicesEditor({
      ...base,
      // 全量视角：属性卡的主体**就是**那条 select 定义时才画
      def: () => this.selectDef(),
      focusTag: () => '',
    })
    this.choicesTag = new ChoicesEditor({
      ...base,
      def: () => this.tagChoices?.def,
      // 页的字段段没有「标签作用域」可言（`_fieldDefs` 在页上还没有消费方）：走全量视角
      focusTag: () => {
        const open = this.tagChoices
        return open && hasList(open.owner, 'tag') ? open.owner.id : ''
      },
    })
    this.els.add.textContent = t('ui.props.addShort')
    this.els.add.title = t('ui.props.add')
    this.els.add.addEventListener('click', () => {
      this.formOpen = this.formOpen === 'own' ? null : 'own'
      this.render()
    })
  }

  /** 主体是一条 `select` 定义时，属性卡里画它的选项编辑器 */
  private selectDef(): Block | undefined {
    const target = this.deps.target()
    return target && isPropDef(target) && propKindOf(target) === 'select' ? target : undefined
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
     * ⚠️ 判据是入口而不是内容：一个块总能加属性，而「＋ 添加属性」就在这一区里。
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
    const labels = this.deps.propLabels()

    for (const row of rows) {
      this.els.body.appendChild(makeFieldRow(row, target, this.deps, { labelCount, labels }))
    }

    /**
     * **入口和表单都紧贴它们写的那一组**。
     *
     * `els.add` 原来挂在 body 外面（卡片最下面），结果是：点「＋ 添加属性」以后，
     * 表单长在「声明给成员」段**下面** —— 看起来像在给声明段加东西。
     * 现在 own 的行、按钮、表单在同一个位置，声明段另起一段（`buildDeclared`）。
     */
    this.els.body.appendChild(this.els.add)
    if (this.formOpen === 'own') this.els.body.appendChild(this.buildForm(target))

    /**
     * **标签属性**（标签）／**字段声明**（页）：只有页/标签有。
     *
     * 与上面那一段是两件事：那一段是「这一块自己的值」，这一段是「我的成员会有哪些格子」。
     * 页/标签上点这一段自己的入口做的正是**声明**，所以不画这一段，那次点击就没有可见结果。
     */
    if (hasList(target, 'page') || hasList(target, 'tag')) {
      this.els.body.appendChild(this.buildDeclared(target))
    }

    /**
     * **select 定义的选项编辑器**：这条属性「能选什么」就是它自己的子块。
     * 主体是定义块时画在这里（属性行之后、系统信息之前），改完立刻看得到。
     */
    if (this.selectDef()) {
      this.choicesFull.render()
      this.els.body.appendChild(this.choicesFull.root)
    }

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
    box.className = 'prop-row prop-system ui-row'
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
   * **标签属性**（标签）／**字段声明**（页）：只有页/标签有这一段。
   *
   * 判据：声明是「我的成员/子块会有这一格」，不是「给这一块设一个值」——
   * 所以这一段只有清单和解除，没有值控件。值仍旧只在成员块上。
   *
   * ⚠️ 这一段**自带**自己的添加入口：它写的是 `_fieldDefs`，而「＋ 添加属性」写的是
   *    `_ownProps`。两个槽两个入口，共用一个入口就必须按块类型猜意图，而标签块恰好两个都需要。
   *
   * ⚠️ 这一段**不是一条属性行**（`props-section`，不是 `prop-row`）：视觉上它必须和
   *    「这一块自己的值」分开，否则用户会把声明当成另一条属性 —— 去重也就跟着混了。
   *
   * ⚠️ 解除声明**不动值**：成员块上已有的值落回「本块自有」，重新声明后自动回来。
   */
  private buildDeclared(target: Block): HTMLElement {
    const isTag = hasList(target, 'tag')
    const section = document.createElement('section')
    // `prop-declared` 是既有断言的选择器锚点（`.prop-declared [data-declared-prop-id]`），
    // `props-declared` 是这一段自己的名字（新的断言与样式用它）
    section.className = 'prop-declared props-declared props-section'
    section.dataset.declaredSection = isTag ? 'tag' : 'page'

    const head = document.createElement('div')
    head.className = 'props-section-head'
    const title = document.createElement('span')
    title.className = 'props-section-title'
    title.textContent = t(isTag ? 'ui.props.tagPropsTitle' : 'ui.props.pageFieldsTitle')
    head.appendChild(title)
    if (isTag) {
      const hint = document.createElement('span')
      hint.className = 'props-section-hint'
      hint.textContent = t('ui.props.tagPropsHint')
      head.appendChild(hint)
    }
    section.appendChild(head)

    const list = document.createElement('div')
    list.className = 'props-declared-list'
    const defs = this.deps.declaredFields(target)
    if (defs.length === 0) {
      const empty = document.createElement('span')
      empty.className = 'props-empty'
      empty.textContent = t(isTag ? 'ui.props.tagPropsEmpty' : 'ui.props.pageFieldsEmpty')
      list.appendChild(empty)
    }
    for (const def of defs) {
      const chip = document.createElement('span')
      chip.className = 'props-tag'
      chip.dataset.declaredPropId = def.id
      const text = document.createElement('span')
      text.textContent = `${this.deps.propLabels().get(def.id) ?? (plainText(def.content).trim() || def.id)} · ${t(`ui.props.kind.${propKindOf(def)}`)}`
      /**
       * `select` 的一条声明带「选项」入口：选项是定义块的子块，而标签视角只该看
       * 「对本标签可见」的那几条。**就地展开**在清单下面 —— 再开一层抽屉会让
       * 「现在在改谁」要看两处抬头才知道。
       */
      if (propKindOf(def) === 'select') {
        const opt = document.createElement('button')
        opt.type = 'button'
        opt.className = 'props-tag-choice'
        opt.dataset.declaredChoices = def.id
        opt.textContent = t('ui.props.choice.open')
        opt.title = t('ui.props.choice.openTitle')
        opt.addEventListener('click', () => {
          const open = this.tagChoices
          this.tagChoices = open && open.def.id === def.id && open.owner.id === target.id ? null : { def, owner: target }
          this.render()
        })
        chip.append(opt)
      }
      const del = document.createElement('button')
      del.type = 'button'
      del.className = 'props-tag-x'
      del.title = t('ui.props.undeclare')
      del.textContent = '×'
      del.addEventListener('click', () => this.deps.undeclareField(target, def.id))
      chip.append(text, del)
      list.appendChild(chip)
    }
    section.appendChild(list)

    const openChoices = this.tagChoices && this.tagChoices.owner.id === target.id ? this.tagChoices : null
    if (openChoices) {
      this.choicesTag.render()
      section.appendChild(this.choicesTag.root)
    }

    /**
     * 这一段的添加入口。`data-declare-add` 是给断言认「这是声明那一个，不是自己的值那一个」的。
     * 形状与「＋ 添加属性」相同（`.props-add`），但位置在它自己的清单下面。
     */
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'props-add props-declare-add'
    add.dataset.declareAdd = '1'
    add.textContent = t(isTag ? 'ui.props.addTagProp' : 'ui.props.addPageField')
    add.title = t(isTag ? 'ui.props.addTagPropTitle' : 'ui.props.addPageFieldTitle')
    add.addEventListener('click', () => {
      this.formOpen = this.formOpen === 'declared' ? null : 'declared'
      this.render()
    })
    section.appendChild(add)

    if (this.formOpen === 'declared') section.appendChild(this.buildDeclareForm(target))
    return section
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
    row.className = 'prop-row prop-belongs ui-row'
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
      prune.className = 'ghost'
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
    row.className = 'prop-row prop-tags ui-row'
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
      const name = displayNameOf(tag)
      text.textContent = `#${name}`
      /**
       * **只有名字可点**，`×` 不在里面：一枚 chip 上两个命中区会互相抢 ——
       * 点「摘掉」时顺手把标签页也打开了是最烦的一种。摘除仍只有 `×` 一个入口。
       * 契约与正文 chip 相同（`data-ref-to`），所以「点名字＝打开它」只有一句话。
       */
      text.dataset.refTo = tag.id
      text.className = 'props-tag-name'
      text.title = t('ui.chip.tagTitle', { label: name })
      text.addEventListener('click', (e) => this.deps.openRef(tag.id, { shiftKey: e.shiftKey }))
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
   * **添加「这一块自己的」属性**：选已有定义（默认复用）或新建一个。
   *
   * ⚠️ 这个表单只管一件事：往 `_ownProps` 里加一条。**标签属性／字段声明**有它自己的入口
   *    （`buildDeclareForm`），因为那是写另一个槽（`_fieldDefs`）、长在另一段下面。
   *    曾经这两件事共用一个表单，靠「这个块有没有 page/tag 露面」猜用户要哪个 ——
   *    于是标签块永远加不了自己的属性（真踩过）。
   *
   * ⚠️ **类型只属于「新建定义」，不属于「给这一块加一条属性」**：`_kind` 住在定义块上、
   *    全库一份，而「用这个」只吃一个 `propId`——选已有属性能配类型是假的。
   *    所以两件事分两行画：第一行选/复用，第二行（只在「新建」时出现）才是名字＋类型。
   */
  private buildForm(target: Block): HTMLElement {
    return this.buildAddForm(target, {
      slot: 'own',
      className: 'props-form props-form--own',
      pick: t('ui.props.pick'),
      use: t('ui.props.use'),
      onUse: (propId) => this.deps.addOwnProp(target, propId),
      onCreate: (label, kind, mode) => this.deps.createOwnDef(target, label, kind, mode),
    })
  }

  /**
   * **添加标签属性 / 字段声明**（只有页/标签有这个入口）。
   *
   * 与 `buildForm` 的差别是「挂到哪个槽」、`slot` 的去重口径和文案；形状完全共用一份 ——
   * 两处各写一份表单迟早会长出两种键盘行为（Enter 提交 / Esc 取消 / 新建哨兵）。
   */
  private buildDeclareForm(target: Block): HTMLElement {
    const isTag = hasList(target, 'tag')
    return this.buildAddForm(target, {
      slot: 'declared',
      className: 'props-form props-form--declared',
      pick: t(isTag ? 'ui.props.pickTagProp' : 'ui.props.pickPageField'),
      use: t('ui.props.useDeclared'),
      onUse: (propId) => this.deps.declareProp(target, propId),
      onCreate: (label, kind, mode) => this.deps.createDeclaredDef(target, label, kind, mode),
    })
  }

  /**
   * 两个添加入口共用的表单形状。
   *
   * 差异只有四处（槽 / 外层类名 / 两条按钮文案 / 两个回调），所以收成一份：
   * 「选已有 → 用这个」「新建 → 名字＋类型」这两个形态是同一个交互，
   * 分两份写就会出现「一个表单 Enter 能用、另一个不能」。
   *
   * **同名不是错**：输入已有同名同 kind 时，两个动作同时可见 ——
   * 复用（默认，误复用可无损改回）与新建同名属性（另一个 `propId`，各自有值）。
   */
  private buildAddForm(
    target: Block,
    opts: {
      /** 这个表单写哪个槽：own ＝ `_ownProps`，declared ＝ `_fieldDefs` */
      slot: 'own' | 'declared'
      className: string
      pick: string
      use: string
      onUse: (propId: string) => void
      onCreate: (label: string, kind: PropKind, mode?: PropCreateMode) => void
    },
  ): HTMLElement {
    const form = document.createElement('form')
    form.className = opts.className
    form.addEventListener('submit', (e) => e.preventDefault())

    /** 「新建定义」的哨兵值：它不是任何真实定义的 id，只用来把下拉切到第二行 */
    const NEW_OPTION = '__new__'

    const pick = document.createElement('select')
    pick.className = 'prop-input props-pick'
    const placeholder = document.createElement('option')
    placeholder.value = ''
    placeholder.textContent = opts.pick
    pick.appendChild(placeholder)
    /**
     * **每个表单只按自己写的那个槽去重，两个槽互不占位。**
     *
     *   · `own` 写 `_ownProps`：已经在本块的行里（`fieldRows`，含标签声明来的行）就不可再加；
     *   · `declared` 写 `_fieldDefs`：只有已经声明过才不可再加。
     *
     * 所以：
     *   · 标签把 P 声明给成员后，标签自己**仍可以**有一条 P 的值（声明不占值槽）；
     *   · 本块已经有 P 的值/行，也**仍可以**把 P 声明给成员（值不让声明失效）。
     *
     * 曾经两个表单共用一套 `used = rows ∪ declared`：两个方向互相挡住，用户报的就是这个。
     * 这些项**留在列表里但不可选**，而不是从列表里删掉：小库的下拉会变空，
     * 用户分不清「库里没有这条属性」与「本块已经有了」。
     */
    const defs = this.deps.defs()
    const labels = this.deps.propLabels()
    const declarations = this.deps.fieldDeclarations()
    const rows = new Set(this.deps.rows(target).map((r) => r.propId))
    const declared = hasList(target, 'page') || hasList(target, 'tag') ? new Set(declaredFieldIds(target)) : new Set<string>()

    /**
     * picker 分组：**本标签 / 未声明 / 其他标签**。
     * 它只是 `_fieldDefs` 的分组视图，不是第二份归属；其他标签的属性**不隐藏**
     * （藏起来会让下拉看起来是空的，用户以为库里没有那条属性）。
     */
    const ownTags =
      opts.slot === 'declared' ? (hasList(target, 'page') || hasList(target, 'tag') ? [target] : []) : [...this.deps.tags(target)]
    const ownIds = new Set(ownTags.map((tag) => tag.id))
    const groupOf = (def: Block): 0 | 1 | 2 => {
      const declaring = declarations.get(def.id) ?? []
      if (declaring.some((tag) => ownIds.has(tag.id))) return 0
      return declaring.length === 0 ? 1 : 2
    }
    const groupLabels = [t('ui.props.groupOwn'), t('ui.props.groupUndeclared'), t('ui.props.groupOther')]
    const groups: HTMLOptGroupElement[] = groupLabels.map((label) => {
      const g = document.createElement('optgroup')
      g.label = label
      return g
    })
    const shownOf = (def: Block): string => labels.get(def.id) ?? (plainText(def.content).trim() || def.id)

    for (const def of defs) {
      let mark = ''
      let disabled = false
      if (opts.slot === 'own') {
        if (rows.has(def.id)) {
          mark = t('ui.props.alreadyOn')
          disabled = true
        } else if (declared.has(def.id)) {
          // 已经声明给成员，但自己的值槽还空着：这一条**可选中**（只是标出来由）
          mark = t(hasList(target, 'tag') ? 'ui.props.isTagProp' : 'ui.props.isFieldDecl')
        }
      } else if (declared.has(def.id)) {
        mark = t('ui.props.declaredOn')
        disabled = true
      }
      const o = document.createElement('option')
      o.value = def.id
      o.textContent = `${shownOf(def)} · ${t(`ui.props.kind.${propKindOf(def)}`)}${mark ? `（${mark}）` : ''}`
      o.disabled = disabled
      groups[groupOf(def)]!.appendChild(o)
    }
    for (const g of groups) if (g.childElementCount > 0) pick.appendChild(g)
    const newOption = document.createElement('option')
    newOption.value = NEW_OPTION
    newOption.textContent = t('ui.props.newOption')
    pick.appendChild(newOption)

    const pickBtn = document.createElement('button')
    pickBtn.type = 'button'
    pickBtn.className = 'props-use'
    pickBtn.textContent = opts.use
    pickBtn.addEventListener('click', () => {
      if (!pick.value || pick.value === NEW_OPTION) return
      opts.onUse(pick.value)
      this.closeForm()
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

    /**
     * **AO4：同一个名字可以有两个 `propId`。**
     *
     * 默认复用（错了好改），但「新建同名属性」也必须当下可见 ——
     * 藏进对话框的那一下会被当成「复用失败」，而用户真正要的是另一个定义。
     */
    const matchNow = (): Block | undefined => {
      const name = normalizeAlias(label.value.trim())
      if (name === '') return undefined
      return defs.find((d) => propKindOf(d) === (kind.value as PropKind) && normalizeAlias(propLabel(d)) === name)
    }
    const ao4 = document.createElement('div')
    ao4.className = 'props-ao4'
    ao4.hidden = true
    ao4.dataset.ao4 = '1'
    const reuse = document.createElement('button')
    reuse.type = 'button'
    reuse.className = 'props-reuse'
    reuse.dataset.ao4Reuse = '1'
    const fresh = document.createElement('button')
    fresh.type = 'button'
    fresh.className = 'props-create-new'
    fresh.dataset.ao4New = '1'
    fresh.textContent = t('ui.props.createSameName')
    ao4.append(reuse, fresh)

    const commit = (mode: 'auto' | 'new'): void => {
      const name = label.value.trim()
      if (name === '') {
        this.deps.toast(t('ui.props.needLabel'), 'warn')
        return
      }
      const k = kind.value as PropKind
      const match = matchNow()
      opts.onCreate(name, k, mode === 'new' ? 'new' : match ? 'reuse' : undefined)
      this.closeForm()
    }

    const create = document.createElement('button')
    create.type = 'submit'
    create.className = 'props-create'
    create.textContent = t('ui.props.create')
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      commit('auto')
    })

    /** 名字/类型一变就重算：有同名同 kind ⇒ 两个动作，默认 Enter 走复用 */
    const syncAo4 = (): void => {
      const match = matchNow()
      if (!match) {
        ao4.hidden = true
        create.hidden = false
        return
      }
      const declaring = declarations.get(match.id) ?? []
      const source = declaring.length > 0 ? declaring.map((tag) => `#${displayNameOf(tag)}`).join('、') : t('ui.props.own')
      reuse.textContent = t('ui.props.reuseNamed', { label: shownOf(match), source })
      ao4.hidden = false
      create.hidden = true
    }
    reuse.addEventListener('click', () => commit('auto'))
    fresh.addEventListener('click', () => commit('new'))
    label.addEventListener('input', syncAo4)
    kind.addEventListener('change', syncAo4)
    label.addEventListener('keydown', (e) => {
      // 组合期只让输入法自己处理（Enter 常常是选词那一下）
      if (e.key !== 'Enter' || e.isComposing) return
      e.preventDefault()
      commit('auto')
    })

    // 新建组整块占一行：它的三个控件只一起出现，不能和第一行的「用这个」混排
    const newGroup = document.createElement('div')
    newGroup.className = 'props-new-group'
    newGroup.hidden = true
    newGroup.append(label, kind, create, ao4)

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
    cancel.addEventListener('click', () => this.closeForm())

    // 库里一条定义都没有时，空下拉是死路：直接切到「新建」并展开第二行。
    // ⚠️ 只有「没有定义」才算死路；「定义都在本块上」不是 —— 下拉里那些灰掉的项
    //    正是用户要的答案（本块已经有它，只是入口不在这个面板）。
    if (defs.length === 0) pick.value = NEW_OPTION
    syncShape()
    syncAo4()

    for (const el of [pick, pickBtn, cancel, newGroup]) form.appendChild(el)
    return form
  }

  /** 关掉当前打开的那个添加表单并重画（两个入口共用一份状态） */
  private closeForm(): void {
    this.formOpen = null
    this.render()
  }
}
