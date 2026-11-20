/**
 * 属性的**行派生**（UI 投影层）：面板行（`FieldRow`）、块下行（`BelowFields`）、
 * gutter 件（`GutterField`）。「算值」住 `props.ts`，「算行」住这里——
 * 本文件吃 `props.ts` 的读路径词汇，`props.ts` 从这里再导出，**对外的符号名不变**
 * （`core/index.ts` 只转一手）。
 *
 * 为什么单独一个文件：三个画法（属性面板／块下行／gutter）吃的是**同一份行派生**，
 * 各自只做过滤——行的构造只有一个地方（`fieldRowOf`），同一条属性在三个面上
 * 不会给出不同答案。这一层零 DOM、不落库。
 */
import { allChoicesOf, type PropChoice } from './choices.ts'
import { slotUseOf } from './uses.ts'
import { ICON_PROP, prop, type Block } from '../model/model.ts'
import { resolveTagIds, tagsById } from '../identity/tags.ts'
import {
  allPropDefs,
  cardinalityOf,
  checkOf,
  choiceCells,
  choiceLookupOf,
  childDisplayPropsResolved,
  childPropsLookupOf,
  declaredFieldIds,
  enginePropValue,
  formatOf,
  hasValue,
  isEngineProp,
  ownFieldIds,
  propKindOf,
  propLabel,
  singleValueOf,
  uiPositionOf,
  useOf,
  valueListOf,
  valueOf,
  type Cardinality,
  type CheckSpec,
  type ChildPropsLookup,
  type ChoiceLookup,
  type PropKind,
  type PropUse,
} from './props.ts'

/**
 * **一批行派生共用的扫库结果**（定义块、标签块、父块声明查找、select 选项表）。
 *
 * 为什么需要它：`fieldRows`／`gutterFieldsOf`／`gutterFieldsFor`／`belowFieldsFor`
 * 各自都从 `forest` 扫一遍定义块与标签块。单行重画同时要 gutter 与块下行时，
 * 同一次扫库被做了四遍——块越多，这笔固定成本越像「每键全库」。把这一份结果
 * 显式传给它们，扫库就退化成每批一次。
 *
 * ⚠️ **只在一次渲染批里共用**，不跨事务缓存：内容改动也会推进 `store.revision`，
 *    拿它当缓存键等于每键都失效。真正的跨事务缓存要等「属性/结构/可见性各自
 *    的修订号」都补齐（目前只有结构、属性两个），这里不做半套。
 */
export interface RowDerive {
  defs: Map<string, Block>
  tags: Map<string, Block>
  /** 父块声明查找（`_childProps`）；给了 `blocksById` 才能建，省掉一次全库 walk */
  lookup?: ChildPropsLookup
  /** `select` 选项表的惰性缓存（gutter 与块下行共用一份） */
  look?: ChoiceLookup
}

/**
 * 建一份 `RowDerive`。
 *
 * `blocksById` 传 **store 的 byId 表**（`store.index.blocks`，活引用、增量维护）：
 * 传了就不再自己走一遍森林建 id 表。
 */
export function rowDeriveOf(forest: readonly Block[], blocksById?: ReadonlyMap<string, Block>): RowDerive {
  const derive: RowDerive = {
    defs: new Map(allPropDefs(forest).map((d) => [d.id, d])),
    tags: tagsById(forest),
  }
  if (blocksById) derive.lookup = { tags: derive.tags, blocks: blocksById }
  return derive
}
/** 属性面板的一行（派生，不落库） */
export interface FieldRow {
  propId: string
  /** 显示名：定义块的正文；定义缺失时退回 propId（数据不静默消失） */
  label: string
  kind: PropKind
  /** 格式（同值形状内的约束与画法；缺省＝该 kind 的缺省格式） */
  format?: string
  /** 值形态：`one`（缺省）／`many` */
  cardinality: Cardinality
  value: unknown
  /** 有值 ⇔ 不是「待填」 */
  filled: boolean
  /** 定义块（缺失＝悬空定义，仍显示值） */
  def?: Block
  /** 直接标签里**声明了这条属性**的那些（按正文顺序）；空＝本块自有 */
  sources: Block[]
  /** 稳定排序键（声明的先后；同 propId 取最早那次） */
  order: number
  /**
   * `select` 行：这个块此刻能选的选项（`choicesFor` 的结果，记录序）。
   *
   * UI **不许**再读定义块上的任何「选项目录」——「这个块有哪些选项」只有这一个读法，
   * 属性面板与表格都吃它。
   */
  choices?: PropChoice[]
  /**
   * `select` 行：当前值对应的选项名（**即使它被作用域隐藏或已删**）。
   *
   * 找不到（选项真的没了／值来自另一个库）时缺席，由 UI 用字典兜底
   * 「选项已删除」——值本身不动，用户可显式清空。
   */
  currentChoiceLabel?: string
  /** `select` 行：当前值指向的选项**已删（墓碑）**（控件显示旧名 ＋ 「已删除」标记） */
  currentChoiceDeleted?: boolean
  /** `select` 多值行：当前值指向的选项名（顺序＝选项序；缺失项用「已删除」兜底） */
  currentChoiceLabels?: string[]
  /** `select` 多值行：当前值指向的选项（含墓碑；缺失项不在里面） */
  currentChoices?: PropChoice[]
  /**
   * `select` 多值行：当前值的 id，**与 `currentChoiceLabels` 逐项对齐**。
   *
   * 多值 chips 摘除某一项要按 id 摘：只靠标签文本反查会撞名（同名选项合法），
   * 靠 `valueListOf` 又与显示序不一致（显示按选项序、值按写入序）。
   */
  currentChoiceIds?: string[]
}

/**
 * 块属性的全部行：**标签属性 ∪ 块属性**，同一个 `propId` 只出现一次。
 *
 * ⚠️ **只算直接标签**：`#演员` 的成员不会因为 `#人物` 声明了属性就冒出那些属性。
 *    「算作」只影响成员列表（`core/tag-tree.ts` 的 `membersOf`），不影响这里。
 * ⚠️ 顺序：标签按打的先后、标签内按 `_fieldDefs` 顺序；同一 `propId` 取**最早那次**声明，
 *    因此多标签声明同一属性时行序不会随标签集合抖动（只随标签顺序变）。
 * ⚠️ 块属性排在标签属性之后：顺序由写入路径决定（先声明后显示），性质上两类现在都可能「待填」。
 */
export function fieldRows(block: Block, forest: readonly Block[], derive?: RowDerive): FieldRow[] {
  const defs = derive?.defs ?? new Map(allPropDefs(forest).map((d) => [d.id, d]))
  const tags = derive?.tags ?? tagsById(forest)
  const rows = new Map<string, FieldRow>()
  let order = 0

  /** 同一份行派生里补 `select` 的几格：值控件的选项与当前值名字都从这里来 */
  let look: ChoiceLookup | undefined
  const lazyLook = (): ChoiceLookup =>
    derive ? (derive.look ??= choiceLookupOf(forest)) : (look ??= choiceLookupOf(forest))

  for (const tag of resolveTagIds(block, tags)) {
    for (const propId of declaredFieldIds(tag)) {
      const existing = rows.get(propId)
      if (existing) {
        existing.sources.push(tag)
        continue
      }
      rows.set(propId, fieldRowOf(block, propId, defs.get(propId), [tag], order++, forest, lazyLook))
    }
  }

  for (const propId of ownFieldIds(block)) {
    if (rows.has(propId)) continue
    rows.set(propId, fieldRowOf(block, propId, defs.get(propId), [], order++, forest, lazyLook))
  }

  return [...rows.values()].sort((a, b) => a.order - b.order)
}

/**
 * 单块行 ＋ **父块声明**（`_childProps`）的并入（面板/只读门面用；渲染批级走
 * `belowFieldsFor` 的同一条合并）。父块声明排在子块自己的行之后——它是环境给的
 * 注记，不是这一块的内容；子块已有的 propId 不重复出（自己的行优先）。
 */
export function fieldRowsWithParent(
  block: Block,
  forest: readonly Block[],
  parent: Block | null | undefined,
  blocksById?: ReadonlyMap<string, Block>,
): FieldRow[] {
  const rows = fieldRows(block, forest)
  if (!parent) return rows
  const defs = new Map(allPropDefs(forest).map((d) => [d.id, d]))
  let order = (rows[rows.length - 1]?.order ?? -1) + 1
  let look: ChoiceLookup | undefined
  const lazyLook = (): ChoiceLookup => (look ??= choiceLookupOf(forest))
  const merged = [...rows]
  for (const propId of childDisplayPropsResolved(parent, childPropsLookupOf(forest, blocksById))) {
    if (merged.some((r) => r.propId === propId)) continue
    merged.push(fieldRowOf(block, propId, defs.get(propId), [], order++, forest, lazyLook))
  }
  return merged.sort((a, b) => a.order - b.order)
}

/**
 * 一行属性的**唯一构造点**：面板、gutter、块下行都吃它，各自只做过滤。
 *
 * 三处各拼一份行对象时，最先漂的是 `select` 的选项格（面板有、块下行没有 ⇒
 * 同一个值在两个面上一个能改一个只显示）。所以构造只在这里。
 */
function fieldRowOf(
  block: Block,
  propId: string,
  def: Block | undefined,
  sources: Block[],
  order: number,
  forest: readonly Block[],
  look: () => ChoiceLookup,
): FieldRow {
  const row: FieldRow = {
    propId,
    label: def ? propLabel(def) || propId : propId,
    kind: def ? propKindOf(def) : 'text',
    ...(def && formatOf(def) !== undefined ? { format: formatOf(def) } : {}),
    cardinality: def ? cardinalityOf(def) : 'one',
    // 引擎属性的值住在块顶层字段，`valueOf` 只读 props 袋 ⇒ 这里一处桥接
    value: isEngineProp(propId) ? enginePropValue(block, propId) : valueOf(block, propId),
    filled: isEngineProp(propId) ? true : hasValue(block, propId),
    def,
    sources,
    order,
  }
  if (!def || row.kind !== 'select') return row
  const cells = choiceCells(block, propId, def, forest, look())
  row.choices = cells.choices
  if (cells.currentChoiceLabel !== undefined) row.currentChoiceLabel = cells.currentChoiceLabel
  if (cells.currentChoiceDeleted === true) row.currentChoiceDeleted = true
  if (cells.currentChoiceLabels !== undefined) row.currentChoiceLabels = cells.currentChoiceLabels
  if (cells.currentChoices !== undefined) row.currentChoices = cells.currentChoices
  if (cells.currentChoiceIds !== undefined) row.currentChoiceIds = cells.currentChoiceIds
  return row
}

/**
 * **块下属性行**的派生：有值、且**没有画在块标后**的行。
 *
 * 与 `gutterFieldsOf`／面板吃同一份 `fieldRows`，只做过滤 —— 三个画法对同一条属性
 * 不会给出不同答案。
 *
 * 判据与 `block-dom` 的 gutter 分支**逐字对应**（只有 `select`／`checkbox` 会画图标）：
 * 手写一个 `block-left` 的 text 属性不会画图标，那它就得在块下行出现，不能两头都没有。
 *
 * 空值（声明了但没填）不进行，只记数：块下行是**定高一行**，用占位符铺满会把额度
 * 吃光（「负责人 — · 截止 — · 优先级 —」）；待填的可发现性交给面板与 `+N` 提示。
 * ⇒ 没有任何有值属性的块**不出这一行**（不靠空行表达 schema）。
 */
export interface BelowFields {
  /** 要画出来的行（有值、未上 gutter），顺序与面板一致 */
  rows: FieldRow[]
  /** 没值但声明过的行数（面板里能看到「待填」） */
  pending: number
  /**
   * 没值但声明过的行本体（**只在「一栏一行」档用**）。
   *
   * 判据：`list` 是「让我读完这块」——藏着待填的栏等于没读全（用户切过去
   * 发现栏反而变少）。摘要档仍只显示条数（`pending`），因为它要的是认出这块。
   *
   * ⚠️ 它不改变「没有任何有值属性就不出这一格」那条既有判据：块下空间是
   *    「有东西可看」才占的，全空的声明由 `+N`／面板承担。
   */
  pendingRows: FieldRow[]
}

/**
 * **块下属性区的两档密度**：`summary` ＝ 一行摘要（多出来的收进 `+N`）／
 * `list` ＝ 一栏一行全显。
 *
 * 它是**看法**，不是值的形状：文档「这一块长多高」由读者与屏幕决定，
 * 所以档位住设备态（见 `Prefs.propsDensity`），单块的临时展开住 `propsExpanded`。
 */
export type PropsLineDensity = 'summary' | 'list'

/**
 * 块下属性区**画几行**（`0` ＝ 这一格整块不画）。
 *
 * ⚠️ **渲染与虚拟化估高吃同一份判据**：两处各算一遍（一处按「有没有属性行」的布尔、
 *    另一处按档位），长文档的滚动条就会系统性偏小或偏大——而那种偏差不会报错，
 *    只在滚到底部时露出来。
 *
 * `summary` 恒 1 行（超出 `cap` 的收进 `+N`）；`list` 与「单块展开了」都是
 * 「一栏一行」＝ 有值的行数。
 */
export function belowFieldsRows(
  fields: Pick<BelowFields, 'rows' | 'pendingRows'> | undefined,
  density: PropsLineDensity,
  expanded = false,
): number {
  const n = fields?.rows.length ?? 0
  if (n === 0) return 0
  // 一栏一行时把**待填**也画出来（读全档不许藏东西）；摘要档只画一行
  if (density === 'list' || expanded) return n + (fields?.pendingRows.length ?? 0)
  return 1
}

/**
 * 块下行要露出什么的**附加口径**（视图白名单与露面约束）。
 *
 * 缺省（不传）时行为与「rich 默认」逐字一致：只来自标签声明／自有属性／父块声明。
 */
export interface BelowFieldsScope {
  /**
   * **显式要的栏**（视图白名单，已映射成 propId）：即使没有值、没有声明也产出一行。
   * 无值进 `pendingRows`（`+N`／一栏一行仍看得见），不静默消失。
   */
  wanted?: readonly string[]
  /**
   * gutter 行（`_uiPosition: block-left` 且有图标形）也进块下行。
   * 卡片没有块标与 gutter，块下行是这些属性**唯一**的露面。
   */
  includeGutter?: boolean
}

/** 块下属性行：批级派生（整屏一次扫库，行级只查表） */
export function belowFieldsFor(
  blocks: readonly Block[],
  forest: readonly Block[],
  /** 行的模型父块（`_childProps` 显示声明的来源）；省略 ⇒ 行为与旧签名完全一致 */
  parentOf?: (id: string) => Block | null | undefined,
  blocksById?: ReadonlyMap<string, Block>,
  scope: BelowFieldsScope = {},
  derive?: RowDerive,
): Map<string, BelowFields> {
  const defs = derive?.defs ?? new Map(allPropDefs(forest).map((d) => [d.id, d]))
  const tags = derive?.tags ?? tagsById(forest)
  const lookup = derive?.lookup ?? childPropsLookupOf(forest, blocksById)
  let look: ChoiceLookup | undefined
  const lazyLook = (): ChoiceLookup =>
    derive ? (derive.look ??= choiceLookupOf(forest)) : (look ??= choiceLookupOf(forest))
  const out = new Map<string, BelowFields>()

  for (const block of blocks) {
    const rows = new Map<string, FieldRow>()
    let order = 0
    for (const tag of resolveTagIds(block, tags)) {
      for (const propId of declaredFieldIds(tag)) {
        const existing = rows.get(propId)
        if (existing) {
          existing.sources.push(tag)
          continue
        }
        rows.set(propId, fieldRowOf(block, propId, defs.get(propId), [tag], order++, forest, lazyLook))
      }
    }
    for (const propId of ownFieldIds(block)) {
      if (rows.has(propId)) continue
      rows.set(propId, fieldRowOf(block, propId, defs.get(propId), [], order++, forest, lazyLook))
    }
    // 父块声明（`_childProps`，含父块标签的声明）排在子块自己的行之后；
    // 子块已有的 propId 不重复出。有值才显示是同一条纪律（engine 行恒有值；
    // 普通属性子块没填就不出空行）
    const parent = parentOf?.(block.id) ?? null
    for (const propId of childDisplayPropsResolved(parent, lookup)) {
      if (rows.has(propId)) continue
      rows.set(propId, fieldRowOf(block, propId, defs.get(propId), [], order++, forest, lazyLook))
    }
    // 白名单在场＝**显式要这几栏**：没有声明、没有值的也补一行（待填也要看得见）
    if (scope.wanted !== undefined) {
      for (const propId of scope.wanted) {
        if (rows.has(propId)) continue
        rows.set(propId, fieldRowOf(block, propId, defs.get(propId), [], order++, forest, lazyLook))
      }
    }

    const visible: FieldRow[] = []
    const waiting: FieldRow[] = []
    for (const row of rows.values()) {
      if (scope.includeGutter !== true && isGutterRow(row)) continue
      if (row.filled) visible.push(row)
      else waiting.push(row)
    }
    // 没有任何有值属性就不出这一格；只有**显式要的栏**留下待填的痕迹
    if (visible.length > 0 || (scope.wanted !== undefined && waiting.length > 0)) {
      out.set(block.id, { rows: visible, pending: waiting.length, pendingRows: waiting })
    }
  }
  return out
}

/**
 * 按显示白名单收窄一批块下行（`undefined` ＝ 不覆写，原样拷贝返回）。
 *
 * 空数组是合法白名单（＝只标题）：整批清空。`pending`／`pendingRows` 也按白名单重算——
 * 只筛 `rows` 会把「待填」的计数漏在外面：清空白名单之后那一块仍然露出 `+3`，
 * 而屏幕上一条属性都没有。
 */
export function constrainBelowFields(
  below: ReadonlyMap<string, BelowFields>,
  allowed: readonly string[] | undefined,
): Map<string, BelowFields> {
  if (allowed === undefined) return new Map(below)
  const ok = new Set(allowed)
  const out = new Map<string, BelowFields>()
  for (const [id, data] of below) {
    const rows = data.rows.filter((r) => ok.has(r.propId))
    const pendingRows = data.pendingRows.filter((r) => ok.has(r.propId))
    if (rows.length === 0 && pendingRows.length === 0) continue
    out.set(id, { rows, pending: pendingRows.length, pendingRows })
  }
  return out
}

/** 这条行会不会被画成块标后的图标（判据与 `block-dom` 的 gutter 分支同一份） */
function isGutterRow(row: FieldRow): boolean {
  if (!row.def) return false
  if (uiPositionOf(row.def) !== 'block-left') return false
  return row.kind === 'select' || row.kind === 'checkbox'
}

/** 属性 id 集合（模型口径的 `fieldsOf`：标签属性 ∪ 块属性） */
export function fieldIdsOf(block: Block, forest: readonly Block[]): string[] {
  return fieldRows(block, forest).map((r) => r.propId)
}

/** gutter 上的一件（派生，不落库） */
export interface GutterField {
  propId: string
  /** 定义块（必在：没有定义的行不进 gutter —— 没有 kind 就不知道该画成什么） */
  def: Block
  kind: PropKind
  value: unknown
  /** 有没有值。渲染方用它区分「未填」与「已填」，**不是**准入条件 */
  filled: boolean
  /** 字段基数（全 kind 轴；`select` 之外也可能是 `many`——多值不是 kind，是基数） */
  cardinality: Cardinality
  /**
   * `select`（单值）：当前值指向的选项（**含墓碑**）。渲染方据此取图标与显示名；
   * 值缺失／值不是选项 id ⇒ 缺席。
   */
  choice?: PropChoice
  /**
   * `select`（多值）：被选中的选项，**按选项序**（含墓碑/已隐藏——值还在就要显示）。
   * 渲染方据此画多枚图标；空数组＝未填。
   */
  picked?: PropChoice[]
  /**
   * 画在块左侧的图标：`select`（单值）＝ 选项 `_icon` ?? 定义 `_icon`。
   * `checkbox` 不吃这一格——它的图形由勾选状态决定（方框／勾）。
   */
  icon?: string
  /**
   * `select`：勾选框映射（`_check`）。有它 ⇒ 画成勾选框（勾选/取消写 on/off）；
   * 没有 ⇒ 普通值，点击打开选项菜单。
   */
  check?: CheckSpec
  /** `select`：用途；`closure` 时这个勾选框同时是关闭态开关（划线/⌘↵） */
  use?: PropUse
}

/** 当前值指向的选项（含墓碑：值还在，显示不能丢）；不是选项 id ⇒ 缺席 */
function choiceByValue(def: Block, value: unknown): PropChoice | undefined {
  const id = singleValueOf(value)
  if (id === '') return undefined
  return allChoicesOf(def).find((c) => c.id === id)
}

/** 多值：按选项序取回被选中的选项（含墓碑/已隐藏，值还在就要显示） */
function pickedChoicesOf(def: Block, value: unknown): PropChoice[] {
  const ids = new Set(valueListOf(value))
  if (ids.size === 0) return []
  return allChoicesOf(def).filter((c) => ids.has(c.id))
}

/** 块左侧画哪个图标：选项自己的图标优先，缺省退回定义块上的 `_icon` */
function gutterIconOf(def: Block, choice: PropChoice | undefined): string | undefined {
  return choice?.icon ?? prop<string>(def, ICON_PROP)
}

/** 一行字段 → gutter 上的一件（两个派生入口共用，避免逐行/批量两种形状漂移） */
function gutterFieldOf(
  row: { propId: string; def: Block; kind: PropKind; value: unknown; filled: boolean },
): GutterField {
  const cardinality = cardinalityOf(row.def)
  const many = cardinality === 'many'
  const choice = row.kind === 'select' && !many ? choiceByValue(row.def, row.value) : undefined
  const picked = row.kind === 'select' && many ? pickedChoicesOf(row.def, row.value) : undefined
  const icon = gutterIconOf(row.def, choice)
  const check = row.kind === 'select' ? checkOf(row.def) : undefined
  const use = check ? useOf(row.def) : undefined
  return {
    propId: row.propId,
    def: row.def,
    kind: row.kind,
    value: row.value,
    filled: row.filled,
    cardinality,
    ...(choice ? { choice } : {}),
    ...(picked ? { picked } : {}),
    ...(icon ? { icon } : {}),
    ...(check ? { check } : {}),
    ...(use ? { use } : {}),
  }
}

/**
 * **`⌘↵`（切换待办）该切哪一格**——单块与批量共用的唯一判据。
 *
 * 目标用途来自 `keymap` 消费者槽：关闭态是**内建的第一个** keymap 消费者，于是
 * 「这一行关闭了没有」只有一个答案。取「槽里第一个」而不是「所有挂 keymap 的用途」，
 * 是因为同一格动作不能按字段顺序随机落到两枚方框之一——那是用户看不见的优先级规则。
 *
 * ⚠️ **不退回普通两态字段**（无 `_use` 的 `_check`、布尔开关）：同一行可能有两个
 *    长得一样的方框，按「第一个」取就是一个用户看不见的优先级规则；`⌘↵` 一旦
 *    能切它们，「这一下切的是哪个」就没有可解释的答案。普通两态只由它自己那一下点击切。
 * ⚠️ 这里返回 `undefined` **不等于「什么都别做」**：调用方的人话是「这一行还不是任务 ⇒
 *    先把它变成任务（落核心任务状态，待办）」，与「第一次按 ⌘↵ 变成待办」同一手感。
 */
export function closureTargetField(fields: readonly GutterField[]): GutterField | undefined {
  const use = slotUseOf('keymap')
  if (use === undefined) return undefined
  return fields.find((f) => f.use === use && f.check !== undefined)
}

/**
 * 这个块上**该在 gutter 画快捷入口**的属性。
 *
 * 为什么和 `fieldRows` 分开而写在 core：gutter 与右侧面板吃的是**同一份行派生**
 * （声明 ∪ 自有、同一 propId 只一行）。若各写一套过滤，两个编辑面迟早会对同一条属性
 * 给出不同答案（一边有值、一边说待填）。
 *
 * 判据：定义声明了 `_uiPosition: 'block-left'` ⇒ gutter 上画**快捷入口**，**不管有没有值**。
 *
 * ⚠️ 「有值」不是准入条件，这是这条规则的全部要点：gutter 上要出现的是
 *    **这个块有这条属性**，不是「这条属性有值」。前者是**入口**，后者是**状态**。
 *    要求有值就变成「第一个值必须先在别处填」——而这类属性存在的理由正是
 *    「一次点击就能改」的高频二元开关，没有第一下就没有第二下。
 *    ⇒ 未填的行照样返回，`filled` 交给渲染方决定怎么画（空心／不画／灰掉）。
 *
 * ⚠️ 调用方是**那一列的局部渲染**（只认一个块），不是整片森林的装饰层。
 *    整屏渲染请用批量的 `gutterFieldsFor`：本函数每调一次都要重扫定义块与标签块，
 *    逐行调就是 O(n²)。
 * ⚠️ 右侧面板用的是**同一份行派生**（见 `ui/properties.ts`），而且现在**也画全部行**：
 *    `_uiPosition` 只决定快捷入口在哪，不排除另一个编辑面。两面读同一份、写同一条命令、
 *    写完两边都重画，所以不会出现「一边改了、另一边没跟上」。
 */
export function gutterFieldsOf(block: Block, forest: readonly Block[], derive?: RowDerive): GutterField[] {
  // 口径必须与批量的 `gutterFieldsFor` 一致：它吃的是同一份 `fieldRows`（声明 ∪ 自有、同 id 一行），
  // 只是「扫库」在行级重复做了一遍 —— 所以单块用它、整屏用批量。
  const out: GutterField[] = []
  for (const row of fieldRows(block, forest, derive)) {
    if (!row.def) continue
    if (uiPositionOf(row.def) !== 'block-left') continue
    out.push(
      gutterFieldOf({
        propId: row.propId,
        def: row.def,
        kind: row.kind,
        value: row.value,
        filled: row.filled,
      }),
    )
  }
  return out
}

/**
 * 一次渲染批里所有该在 gutter 编辑的属性：**一次扫库，逐行分发**。
 *
 * 为什么不复用 `gutterFieldsOf` 逐行算：它每次调用都要重新扫一遍定义块与标签块，
 * 于是整屏渲染从 O(n) 变成 O(n²)。这里把「扫库」提到批级，行级只做查表。
 *
 * 返回 `Map<blockId, GutterField[]>`；没有 gutter 属性的块**不出现在 map 里**
 * （空数组与缺席同义，少一次存在性判断）。
 *
 * 行的口径与 `fieldRows` 一致：**标签属性在前（按标签的先后、标签内按声明顺序），
 * 块属性在后**，同一 `propId` 只出现一次。
 */
export function gutterFieldsFor(
  blocks: readonly Block[],
  forest: readonly Block[],
  derive?: RowDerive,
): Map<string, GutterField[]> {
  // 定义块与标签块各扫**一次**：行级只查表（同一批里给了 `RowDerive` 就复用）
  const defs = derive?.defs ?? new Map(allPropDefs(forest).map((d) => [d.id, d]))
  const tagById = derive?.tags ?? tagsById(forest)

  const out = new Map<string, GutterField[]>()
  for (const block of blocks) {
    const fields = new Map<string, GutterField>()
    const take = (propId: string): void => {
      if (fields.has(propId)) return
      const def = defs.get(propId)
      // 没有定义就不知道该画成什么，不进 gutter（与 `fieldRows` 跳过悬空定义同因）
      if (!def) return
      if (uiPositionOf(def) !== 'block-left') return
      fields.set(
        propId,
        gutterFieldOf({
          propId,
          def,
          kind: propKindOf(def),
          value: valueOf(block, propId),
          filled: hasValue(block, propId),
        }),
      )
    }
    for (const tag of resolveTagIds(block, tagById)) for (const propId of declaredFieldIds(tag)) take(propId)
    for (const propId of ownFieldIds(block)) take(propId)
    if (fields.size > 0) out.set(block.id, [...fields.values()])
  }
  return out
}
