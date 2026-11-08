/**
 * **属性（property）、标签属性（tag properties）、块属性（block properties）**。
 *
 * 三个词指的是三样东西，别混：
 *   · **属性** —— 那个全局定义：一个住在森林顶层的普通块，正文＝显示名、`_kind`＝种类；
 *   · **标签属性** —— 某个标签（或页）**声明**了哪些属性可用（`_fieldDefs`）；
 *   · **块属性** —— 某个块自己有哪些属性的**值**（`props[propId]`）。
 *
 * 根不变量：**属性的身份是全局 `propId`，不是它的名字。**
 *   · `propId` ＝ 定义块的 **id**（不另造 id 空间）；
 *   · 定义块不能住在任何一个使用者的子树里，否则删掉那个标签会带走别人的定义；
 *   · 声明只提供「可用性」，值永远在**块上**（一块一槽）。
 *
 * 标签属性**不向成员继承**：`fieldRows` 只算**块实际打着的标签**，没有祖先闭包。
 * ⇒ 叫「标签属性」说的是「这个标签名下的属性清单」，不是「所有成员都有的属性」。
 *
 * ⚠️ `_fieldDefs` 里存的是 **ref（id）**，不是名字：改名零迁移，重名不撞车。
 * ⚠️ 本文件零 DOM：属性面板只消费这里的派生结果，写入通过命令。
 */
import {
  ICON_PROP,
  isDeleted,
  hasList,
  isPropDefBlock,
  prop,
  type Block,
  type BlockProps,
  type TodoState,
} from '../model/model.ts'
import { displayNameOf } from '../identity/alias.ts'
import { plainText, textRuns } from '../model/runs.ts'
import { walkForest } from '../model/walk.ts'
import { derivedId, pad, uuidv7Hex } from '../model/ids.ts'
import { todayISO } from '../identity/journal.ts'
import { allTags, resolveTagIds, tagIdsOf, tagsById } from '../identity/tags.ts'
import { t } from '../infra/msg.ts'

/**
 * 两个属性值是不是同一件事（**结构相等**：属性值可以是数组／对象，`Object.is` 不够）。
 *
 * 判据用途：只有真变了才算一次改动（写时刻、发 `prop.set`）。
 */
function sameValue(a: unknown, b: unknown): boolean {
  return Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b)
}

/** 声明列表的系统属性（有序 ref 列表；pos ＝ 数组下标） */
export const FIELD_DEFS_PROP = '_fieldDefs'

/** `_fieldDefs` 的形状判据（读路径与落盘校验共用同一份）：非空字符串数组（ref＝定义块 id，悬空合法） */
export function isFieldDefRefs(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x !== '')
}

/**
 * **一个属性在哪儿被顺手改**（定义块上的系统属性）。
 *
 * 两个值：
 *   · `block-left` —— **快捷入口**画在块左侧的 gutter。给「一次点击就能改」的高频二元开关用；
 *   · `panel`（缺省）—— 只在右侧属性面板里，需要展开、填值。
 *
 * ⚠️ 它决定的是**入口画在哪**，不是「只有那一处能改」。曾经的规则是「一个值不开两个编辑面」
 *    ⇒ 归 `block-left` 的行从面板里排除，面板只写一句「在块左侧编辑」。那一句是死路：
 *    用户在卡里看到这条属性、却改不了它，得先想起来「左侧还有个小方框」。
 *    现在两处共存，前提是**读同一份行派生、写同一条命令、写完两边都重画**
 *    （`fieldRows` 是那份派生，`gutterFieldsOf` 只是它的一个视图）。
 */
export type UiPosition = 'block-left' | 'panel'

export const UI_POSITION_PROP = '_uiPosition'

/** `_uiPosition` 的形状判据（读路径与落盘校验共用同一份）：两值之一（缺省 `panel` 不落盘） */
export function isUiPositionValue(v: unknown): boolean {
  return v === 'block-left' || v === 'panel'
}

/**
 * 定义块声明的编辑位置：`block-left` ＝ 块标后的图标；`panel`（缺省）＝ 不上图标。
 *
 * ⚠️ `panel` **不是**「只在属性面板」：有值时它落在**块下属性行**。
 *    取消 `block-left` 勾选就是把这一条从图标挪到块下，而不是把它藏起来。
 */
export function uiPositionOf(def: Block | undefined): UiPosition {
  return def && prop<string>(def, UI_POSITION_PROP) === 'block-left' ? 'block-left' : 'panel'
}

/* ------------------------------------------------------------ 核心词汇 */

/**
 * **「任务状态」**：这件事做完了没有。
 *
 * 它是**全局属性**，不是块上的裸字段、也不是 `_` 结构槽 —— 判据：值域与语义是**用户词汇**
 * （「做完了」是什么意思，是给人看的），而且要能进查询、进导出、进属性面板。
 * 凡是「有定义块承载值域」的都走 prop-def，所以这里有定义块、有一个稳定 propId。
 *
 * ⚠️ id 由名字确定性派生：代码在重开之后要靠它找到这个定义，而名字是可改的
 *    （改显示名不动任何值，这是属性设计的前提）。
 * ⚠️ 定义块的正文（显示名）与标签名是**数据**，住在 `seed.ts` —— 它们会成为库里的内容，
 *    不是界面文案；界面语言变了，已存在的块名不会跟着变。
 */
export const TASK_STATUS_PROP_ID = derivedId('prop', 'core/task-status')

/**
 * 任务状态的三个**选项 id**（select 的选项＝定义块的直接子块，值存选项块 id）。
 *
 * 选项块与定义块一样是**核心词汇**：`todoOf`、⌘↵ 切换、种子查询都要按 id 认「完成」，
 * 不能按正文认（显示名可改，改显示名不动任何值）。kind 前缀 `choice` 与定义块的
 * `prop` 分域哈希，同名不撞。
 */
export const TASK_STATUS_TODO_ID = derivedId('choice', 'core/task-status/todo')
export const TASK_STATUS_DOING_ID = derivedId('choice', 'core/task-status/doing')
export const TASK_STATUS_DONE_ID = derivedId('choice', 'core/task-status/done')
/** 「放弃」：这件事**关掉**且没做成 —— 与「完成」同属终态，种子查询把两者都算关闭 */
export const TASK_STATUS_ABANDONED_ID = derivedId('choice', 'core/task-status/abandoned')

/**
 * 定义块上的**缺省值**槽：声明了这一栏却没填的块，读侧按它取值（select 存选项块 id）。
 * 没写这一槽的定义，未填仍是未填 —— 看板落「未设置」列、`empty` 照常可用。
 * 归一发生在 `readField`（读侧），与布尔属性「声明即 `false`」是同一条原理。
 */
export const DEFAULT_PROP = '_default'

/** `_default` 的值判据：缺省是**单个标量**（select 的选项 id 是字符串；数字/布尔字段是字面量）。 */
export function isDefaultValue(v: unknown): boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
}

/**
 * **一次算好的字段读取表**：谁声明了哪些属性、每个属性是什么 kind。
 *
 * 为什么要一张表：判断「这块有没有这一栏」要同时看三处 —— 块上的值、块的
 * `_ownProps`（自有槽）、**它打的标签上的 `_fieldDefs`**。前两处住在块上，
 * 第三处要沿标签查；逐块现查就是每次全库扫一遍。调用方**建一次、传下去**。
 *
 * ⚠️ 建一张表要扫两趟森林（标签块、定义块）。放在循环里调就会退化成 O(n²) ——
 *    与 `gutterFieldsOf` 那条警告同因。
 */
export interface FieldTable {
  /** 标签块 id → 它声明的属性 id（有序） */
  byTag: ReadonlyMap<string, readonly string[]>
  /** 属性 id → kind（来自定义块） */
  kinds: ReadonlyMap<string, PropKind>
  /** 属性 id → 缺省值（定义块写了 `_default` 才有；`readField` 对「已声明未填」按它取值） */
  defaults: ReadonlyMap<string, unknown>
  /**
   * **唯一**的「任务状态」定义（`_use: 'status'` ＋ 合法 `_check`）。
   * 库级概念：没有「多个完成型属性取第一条」的裁决。
   */
  status?: { defId: string; on: string; off: string }
  /** 属性 id → 基数（缺省 `one`；定义块写了 `_cardinality: 'many'` 才是多值） */
  cardinality: ReadonlyMap<string, Cardinality>
}

/** 从森林建一份字段读取表（标签声明 ＋ 定义 kind／缺省值各扫一趟） */
export function fieldTableOf(forest: readonly Block[]): FieldTable {
  const byTag = new Map<string, readonly string[]>()
  for (const tag of allTags(forest)) byTag.set(tag.id, declaredFieldIds(tag))
  const kinds = new Map<string, PropKind>()
  const defaults = new Map<string, unknown>()
  const cardinality = new Map<string, Cardinality>()
  let status: FieldTable['status']
  for (const def of allPropDefs(forest)) {
    kinds.set(def.id, propKindOf(def))
    const dflt = prop<unknown>(def, DEFAULT_PROP)
    if (dflt !== undefined) defaults.set(def.id, dflt)
    const card = cardinalityOf(def)
    if (card === 'many') cardinality.set(def.id, card)
    // 写入路径保证最多一个 status；坏数据带多个时按先序取第一个，不抛错
    if (!status && useOf(def) === 'status') {
      const check = checkOf(def)
      if (check) status = { defId: def.id, on: check.on, off: check.off }
    }
  }
  return { byTag, kinds, defaults, cardinality, ...(status ? { status } : {}) }
}

/**
 * **「这一块有没有这一栏」的唯一判据**（值 ≥ 自有槽 ≥ 标签声明）。
 *
 * 三处来源是**同一个问题的三种存储形态**，不是三个问题：
 *   · 有值（含 `false`）：写过的块；
 *   · `_ownProps`：面板「加一条属性」只登记槽、不写值；
 *   · 标签的 `_fieldDefs`：成员自动获得这一栏，块上什么都不写（成员是动态的）。
 *
 * ⚠️ 只认前两处就会出现「屏幕上一个空心方框、查询说这块没有这一栏」——
 *    `gutterFields`（画方框）读的是本函数，查询的 `exists` 也必须读它。
 */
export function fieldDeclared(block: Block, propId: string, table: FieldTable): boolean {
  if (block.props !== undefined && propId in block.props) return true
  if (ownPropIds(block).includes(propId)) return true
  for (const tagId of tagIdsOf(block)) {
    if (table.byTag.get(tagId)?.includes(propId) === true) return true
  }
  return false
}

/** 读一格字段的结果：`declared` 说有没有这一栏，`value` 说值是什么 */
export interface FieldRead {
  declared: boolean
  value: unknown
}

/**
 * 读一格字段。两类「没填过」在**读侧**归一：
 *
 * · **布尔属性没有「未填」这一态**：声明了就等价于 `false`；
 * · 定义写了**缺省值**（`_default`）的：声明了就按缺省读（select 是选项块 id）。
 *
 * 为什么归一必须在这里、而不是在各写路径上「声明时补写」：
 * 标签声明的属性**落不到成员块上**（成员是动态的，且每来一个新成员都要补写一遍）。
 * 写路径只能覆盖自有槽；读侧归一才覆盖两种来源。写路径也不必造一个用户没做过的值 ——
 * 数据里「没点过」仍然是没点过，**解释**上由归一口径给出（布尔是未完成、带缺省的是缺省项）。
 *
 * ⚠️ 归一只对「没写过值」的块生效；没有缺省的定义，未填仍是未填（`undefined`）。
 *    查询、看板分组、`todoOf` 都走这里 ⇒ 同一块在所有读法里是同一个答案。
 */
export function readField(block: Block, propId: string, table: FieldTable): FieldRead {
  const has = block.props !== undefined && propId in block.props
  if (has) return { declared: true, value: block.props?.[propId] }
  const declared = fieldDeclared(block, propId, table)
  if (!declared) return { declared, value: undefined }
  if (table.kinds.get(propId) === 'checkbox') return { declared, value: false }
  return { declared, value: table.defaults.get(propId) }
}

/**
 * 「任务」的派生读法：**库里唯一的 status 定义**。
 *
 * 三态与值这样对上：
 *   · 值＝该定义 `_check.on` ⇒ `'done'`（做完了）；
 *   · 其余任何已声明形态 ⇒ `'todo'`（**是任务、还没做完**）——待办、进行中、
 *     以及**靠标签声明拿到这一栏还没填**的块（读侧缺省读出缺省项）；
 *   · 没有 status 定义，或这块没有那一栏 ⇒ `undefined`（这块压根不是任务）。
 *
 * ⚠️ **判据是「有没有这一栏」（`readField`），不是「有没有值」。** 把「未填」并进
 *    `undefined` 会让刚挂上的任务立刻不算任务 —— 屏幕上画着空心方框、查询查不到它。
 *
 * ⚠️ 必须传 `FieldTable`：只认 `_ownProps` 会漏掉**标签声明**那一半，而「任务」这个
 *    种子标签正是用 `declareField` 把这一栏给到成员的。那种块屏幕上是未完成、模型里
 *    却不是任务 —— 同一个块两种答案，且没有任何一层报错。
 *
 * ⚠️ **不再有「第一条完成型属性」**：`_use: 'status'` 全局唯一（写入路径保证），
 *    `todoOf` 只认这一条；两个属性的歧义在模型层就不存在。
 */
export function todoOf(block: Block, table: FieldTable): TodoState | undefined {
  const status = table.status
  if (!status) return undefined
  const { declared, value } = readField(block, status.defId, table)
  if (!declared) return undefined
  return singleValueOf(value) === status.on ? 'done' : 'todo'
}

export type PropKind = 'text' | 'number' | 'date' | 'checkbox' | 'select' | 'ref' | 'url'

export const PROP_KINDS: readonly PropKind[] = ['text', 'number', 'date', 'checkbox', 'select', 'ref', 'url']

export function isPropKind(v: unknown): v is PropKind {
  return typeof v === 'string' && (PROP_KINDS as readonly string[]).includes(v)
}

/* ------------------------------------------------------------ 定义块 */

/**
 * 造一个属性定义块（**森林顶层**，正文＝显示名；`propId` 就是它的 id）。
 *
 * `id` 只给**核心词汇**用：它们的 id 必须跨重开稳定（名字 → id 走 `derivedId`），
 * 而普通用户新建的定义仍拿到随机 id —— 那条路不需要、也不该承诺稳定性。
 * 参数放在最后，现有调用点（`label`／`kind`／`extra`）不受影响。
 */
export function mkPropDef(label: string, kind: PropKind = 'text', extra: BlockProps = {}, id?: string): Block {
  const now = Date.now()
  return {
    id: id ?? uuidv7Hex(),
    content: textRuns(label),
    children: [],
    created: now,
    modified: now,
    props: { _kind: kind, ...extra },
  }
}

/** 是不是属性定义块（**看数据 `_kind`**，不看名字、也没有额外的标记） */
export function isPropDef(b: Block): boolean {
  return isPropDefBlock(b)
}

/** 定义块上的显示名（**正文即 label**，不存第二份） */
export function propLabel(def: Block): string {
  return plainText(def.content).trim()
}

/** 定义的 kind（落盘缺省按 text：旧数据/手写定义不该让面板整段消失） */
export function propKindOf(def: Block): PropKind {
  const k = prop<unknown>(def, '_kind')
  return isPropKind(k) ? k : 'text'
}

/* ------------------------------------------------------------ 选项（select） */

/**
 * **一个 `select` 属性能选哪些值 ＝ 定义块的直接子块。**
 *
 * 没有 `_choiceOf` 之类的新标记：父块是定义 ⇒ 它的直接子块就是选项。
 * 角色由位置派生，与「外观按类型、chrome 按身份」同一条判据 ——
 * 另存一份「这是选项」的声明，就会多出一份能与位置不一致的答案。
 *
 * 软删的选项不算：它们留在原位等恢复，但此刻不提供选择。
 */
export function choicesOf(def: Block): Block[] {
  return def.children.filter((c) => !isDeleted(c))
}



/**
 * 一个选项的可见范围（**唯一的可见性来源**）。
 *
 * 三态互斥，所以没有「既 only 又 except」的冲突态，也没有优先级规则。
 * 缺省/坏值按 `all`：旧数据或手写数据不该让控件整片空掉。
 */
export type ChoiceScope = { mode: 'all' } | { mode: 'only'; tags: string[] } | { mode: 'except'; tags: string[] }

/** 选项作用域住在选项块上（系统属性；形状见 `ChoiceScope`） */
export const CHOICE_SCOPE_PROP = '_choiceScope'

/**
 * 属性定义的**用途**（系统属性）：这条属性拿来干什么。
 *
 * 现在只有 `status`（任务状态）。优先级先作为普通 select，等有应用级消费者
 * （任务表／快捷键／默认任务模板）再扩这个联合——不要为假设的用途先造枚举值。
 *
 * 用途与显示分开：`_use` 说语义，`_check` 说怎么编辑/显示。
 */
export type PropUse = 'status'

export const USE_PROP = '_use'

export function isUseValue(v: unknown): boolean {
  return v === 'status'
}

/** 定义的用途；不是 `select`／没写／未知值 ⇒ 缺席（普通属性） */
export function useOf(def: Block | undefined): PropUse | undefined {
  if (!def || propKindOf(def) !== 'select') return undefined
  return prop<string>(def, USE_PROP) === 'status' ? 'status' : undefined
}

/**
 * 勾选框映射（系统属性）：勾选写 `on`、取消写 `off`。
 *
 * 它是**显示/编辑**映射，不自动等于任务：`_use: 'status'` 时才驱动
 * `todoOf`/删除线/⌘↵；没有 `_use` 就只是一个普通的两态开关（如「已读/未读」）。
 */
export interface CheckSpec {
  on: string
  off: string
}

export const CHECK_PROP = '_check'

/** 形状判据：两个非空、互不相同的选项 id（悬空 id 合法——软删的选项还在树上） */
export function parseCheckSpec(v: unknown): CheckSpec | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const raw = v as { on?: unknown; off?: unknown }
  if (typeof raw.on !== 'string' || raw.on === '') return null
  if (typeof raw.off !== 'string' || raw.off === '') return null
  if (raw.on === raw.off) return null
  return { on: raw.on, off: raw.off }
}

export function isCheckValue(v: unknown): boolean {
  return parseCheckSpec(v) !== null
}

/** 定义的勾选框映射；不是 `select`／多值／坏形状 ⇒ 缺席（退回普通 select） */
export function checkOf(def: Block | undefined): CheckSpec | undefined {
  if (!def || propKindOf(def) !== 'select') return undefined
  if (cardinalityOf(def) === 'many') return undefined
  return parseCheckSpec(prop<unknown>(def, CHECK_PROP)) ?? undefined
}

/**
 * 字段的**基数**：`one`（缺省）／`many`。
 *
 * 多值只对 `select` 有意义：值是一个选项 id 数组（顺序按选项兄弟序），
 * 不是新的 kind —— 单选/多选共用同一套选项与同一份值域。
 */
export type Cardinality = 'one' | 'many'

/** 定义块上的基数槽（系统属性；缺省 `one` 不落盘） */
export const CARDINALITY_PROP = '_cardinality'

export function isCardinalityValue(v: unknown): boolean {
  return v === 'one' || v === 'many'
}

/** 定义块的基数（缺省 `one`：没写就是单值） */
export function cardinalityOf(def: Block | undefined): Cardinality {
  return def && prop<string>(def, CARDINALITY_PROP) === 'many' ? 'many' : 'one'
}

/**
 * 把一格值读成**选项 id 列表**（多值读法的唯一入口）。
 *
 * 兼容两种历史形状：单值（string）在读多值时视为「只有一个」，数组则逐项过滤。
 * 写路径始终写数组；这条兼容只服务「单值定义刚切成多值、旧块还没被写过」的瞬间，
 * 不做第二份存储。
 */
export function valueListOf(value: unknown): string[] {
  if (typeof value === 'string') return value === '' ? [] : [value]
  if (!Array.isArray(value)) return []
  return value.filter((x): x is string => typeof x === 'string' && x !== '')
}

/**
 * 把一格值读成**单个选项 id**（单值读法的唯一入口）。
 *
 * 数组只在「多值定义切回单值」的过渡期出现（切换命令会挡住仍有 >1 个值的库）；
 * 取第一个是安全的降级，下一次写值就归一成 string。
 */
export function singleValueOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : ''
  return ''
}

/**
 * 把一格未知值读成三态作用域；`null` ＝ 形状不认识（命令层据此拒绝写入）。
 *
 * 归一化只做一件不承载语义的事：标签去重。**空集合保留**：编辑作用域时会经过
 * 「刚切到 only、还没勾标签」的中间态，把它归一成 `all` 会让复选框整片禁用，
 * 用户再也选不上标签。空集本身有明确含义（only ＝ 谁都看不见）。
 * **悬空的标签 id 也原样保留**：标签被删不等于作用域失效 —— 静默摘掉会让一个
 * `only` 悄悄变成「所有人都能选」。
 */
export function parseChoiceScope(raw: unknown): ChoiceScope | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const v = raw as { mode?: unknown; tags?: unknown }
  if (v.mode === 'all') return { mode: 'all' }
  if (v.mode !== 'only' && v.mode !== 'except') return null
  if (!Array.isArray(v.tags)) return null
  const tags = [...new Set(v.tags.filter((x): x is string => typeof x === 'string' && x !== ''))]
  return { mode: v.mode, tags }
}

/** 选项的可见范围；坏值回落「所有用这个属性的块都能选它」 */
export function choiceScopeOf(choice: Block): ChoiceScope {
  return parseChoiceScope(prop<unknown>(choice, CHOICE_SCOPE_PROP)) ?? { mode: 'all' }
}

/**
 * 这个选项对一组标签可见吗。
 *
 * 多标签取**并集**：`only` 任一命中即可见，`except` 任一命中即隐藏。
 * 空标签集：`all` 可见、`only` 不可见、`except` 可见（没有要排除的）。
 */
export function choiceVisible(choice: Block, tagIds: ReadonlySet<string>): boolean {
  const scope = choiceScopeOf(choice)
  if (scope.mode === 'all') return true
  const hit = scope.tags.some((id) => tagIds.has(id))
  return scope.mode === 'only' ? hit : !hit
}

/**
 * 一块带着哪些标签 id（**标签页编辑时把自身算进去**：只看自己的选项）。
 *
 * **软删的标签不提供作用域**：块上仍留着它的 id（摘标签不自动清值），但它已经不再
 * 是一格分类 —— 把它算进 tag 集会让 `only [已删标签]` 的选项继续可见。
 * 这里拿到的是「含软删」的查找（表格要显示旧名），所以必须自己判一次。
 */
function tagIdSetOf(block: Block, tagById: (id: string) => Block | undefined): Set<string> {
  const out = new Set<string>()
  for (const id of tagIdsOf(block)) {
    const tag = tagById(id)
    if (tag && !isDeleted(tag)) out.add(id)
  }
  if (hasList(block, 'tag') && !isDeleted(block)) out.add(block.id)
  return out
}

/**
 * **「这个块能选哪些选项」的唯一实现**（兄弟顺序）。
 *
 * 适用性来自块自己打着的标签（`_fieldDefs` 的声明），可见性来自每个选项的
 * `_choiceScope`。属性面板与表格都必须走这里 —— 两处各写一遍 filter 就会出现
 * 「同一块在两个视图里能选的东西不一样」。
 */
export function choicesForDef(block: Block, def: Block, tagById: (id: string) => Block | undefined): Block[] {
  if (propKindOf(def) !== 'select') return []
  const tagIds = tagIdSetOf(block, tagById)
  return choicesOf(def).filter((c) => choiceVisible(c, tagIds))
}

/**
 * 这个块在某个属性上**能选**的选项（兄弟顺序）。
 *
 * 定义缺失或不是 `select` ⇒ 空数组（控件空态，不是崩）。
 */
export function choicesFor(block: Block, propId: string, forest: readonly Block[]): Block[] {
  const def = findPropDef(forest, propId)
  if (!def) return []
  const byId = tagsById(forest)
  return choicesForDef(block, def, (id) => byId.get(id))
}

/**
 * 读 `select` 行时要用的三件查找。
 *
 * 默认从整片森林现建；表格那种「一格一次」的调用方可以传一份**一次算好**的
 * （`find` 要能找到软删的选项：当前值可能指向一条已删的），否则 N 个格子就是
 * N 次全库扫。
 */
export interface ChoiceLookup {
  /** 按 id 找块（**含软删**） */
  find: (id: string) => Block | undefined
  /** 按 id 找标签（作用域的名字） */
  tagById: (id: string) => Block | undefined
  /** 标签显示名（缺失时给短 id） */
  tagName: (id: string) => string
}

/** 从森林建一份查找：**一趟扫完**（`find`／`tagById` 都含软删的块） */
export function choiceLookupOf(forest: readonly Block[]): ChoiceLookup {
  const idx = new ChoiceLookupIndex()
  idx.rebuild(forest)
  return idx.lookup()
}

/**
 * **可增量修补**的选项查找表（表格按 blockId 局部修补行，不能每格扫全库）。
 *
 * 「软删」与「purge」在 `store.find` 眼里都是 `undefined`（索引看不见被删的块），
 * 所以增量修补必须自己判：
 *   · 表里那份**带删除标记** ⇒ 软删，留着（当前值要显示旧名 ＋ 「已删除」）；
 *   · 表里那份没有删除标记、树里也找不到 ⇒ 已被 purge，必须摘掉 ——
 *     否则当前值会拿一个已经不在树上的旧对象当「还在」，显示旧名而不是「选项已删除」。
 */
export class ChoiceLookupIndex {
  private byId = new Map<string, Block>()
  private tagById = new Map<string, Block>()

  /** 整表重建（含软删的块与标签：名字要显示得出来） */
  rebuild(forest: readonly Block[]): void {
    this.byId.clear()
    this.tagById.clear()
    walkForest(
      forest,
      (b) => {
        this.byId.set(b.id, b)
        if (hasList(b, 'tag')) this.tagById.set(b.id, b)
      },
      { includeDeleted: true },
    )
  }

  /** 增量：把这一块放回表里；软删的留着，purge 的摘掉 */
  remember(id: string, find: (id: string) => Block | undefined): void {
    const b = find(id)
    if (b) {
      this.byId.set(id, b)
      if (hasList(b, 'tag')) this.tagById.set(id, b)
      return
    }
    const old = this.byId.get(id)
    if (old && isDeleted(old)) return
    this.byId.delete(id)
    this.tagById.delete(id)
  }

  lookup(): ChoiceLookup {
    return {
      find: (id) => this.byId.get(id),
      tagById: (id) => this.tagById.get(id),
      tagName: (id) => {
        const tag = this.tagById.get(id)
        return tag ? displayNameOf(tag) : id.slice(-6)
      },
    }
  }
}

/**
 * 按 id 找选项块（**含软删**）：当前值可能指向一个已经不提供选择的选项，
 * 控件仍要显示它的名字，而不是把值静默清掉。
 */
export function choiceById(forest: readonly Block[], choiceId: string): Block | undefined {
  if (choiceId === '') return undefined
  let hit: Block | undefined
  walkForest(
    forest,
    (b) => {
      if (b.id !== choiceId) return
      hit = b
      return false
    },
    { includeDeleted: true },
  )
  return hit
}

/** 同一属性下的选项是否重名（**同名不是错**：身份是 id，名字只是显示） */
function duplicateChoiceName(def: Block, choice: Block): boolean {
  const name = plainText(choice.content).trim()
  const same = choicesOf(def).filter((c) => plainText(c.content).trim() === name)
  return same.length > 1
}

/**
 * **选项的显示名**（属性面板、表格、选项编辑器都只走这一个入口）。
 *
 * 选项名就是它自己的正文；同一属性下有同名选项时追加作用域，
 * 仍重名再补短 id —— 两个同名选项必须能被指着说清楚是哪一条。
 */
export function choiceDisplayLabel(choice: Block, def: Block, tagName: (id: string) => string): string {
  const name = plainText(choice.content).trim() || choice.id.slice(-6)
  if (!duplicateChoiceName(def, choice)) return name
  const scope = choiceScopeOf(choice)
  const tags = scope.mode === 'all' ? '' : scope.tags.map((id) => `#${tagName(id)}`).join('、')
  const suffix =
    scope.mode === 'all'
      ? t('ui.props.choice.scopeAllSuffix')
      : tags === ''
        ? t('ui.props.choice.scopeNoTagsSuffix')
        : scope.mode === 'only'
          ? t('ui.props.choice.scopeOnlySuffix', { tags })
          : t('ui.props.choice.scopeExceptSuffix', { tags })
  const label = `${name}${suffix}`
  const again = choicesOf(def).filter((c) => {
    const sc = choiceScopeOf(c)
    const tg = sc.mode === 'all' ? '' : sc.tags.map((id) => `#${tagName(id)}`).join('、')
    const suf =
      sc.mode === 'all'
        ? t('ui.props.choice.scopeAllSuffix')
        : tg === ''
          ? t('ui.props.choice.scopeNoTagsSuffix')
          : sc.mode === 'only'
            ? t('ui.props.choice.scopeOnlySuffix', { tags: tg })
            : t('ui.props.choice.scopeExceptSuffix', { tags: tg })
    return `${plainText(c.content).trim() || c.id.slice(-6)}${suf}` === label
  })
  return again.length > 1 ? `${label}（${choice.id.slice(-6)}）` : label
}

/**
 * **属性显示名**（`propId → label`）：同名属性带声明来源。
 *
 * 同名不同 `propId` 是合法的（AO4）；不标来源时两行长得一模一样，用户分不出
 * 改的是哪一个。来源是**派生的**（标签的 `_fieldDefs`），不是第二份存储。
 * picker、属性卡、字段抽屉、表格列头都吃这一张表。
 */
export function propDisplayLabels(forest: readonly Block[]): Map<string, string> {
  const defs = allPropDefs(forest)
  const declaredBy = new Map<string, Block[]>()
  for (const tag of allTags(forest)) {
    for (const propId of declaredFieldIds(tag)) {
      const list = declaredBy.get(propId)
      if (list) list.push(tag)
      else declaredBy.set(propId, [tag])
    }
  }
  const byLabel = new Map<string, Block[]>()
  for (const def of defs) {
    const label = propLabel(def) || def.id
    const list = byLabel.get(label)
    if (list) list.push(def)
    else byLabel.set(label, [def])
  }
  const out = new Map<string, string>()
  for (const def of defs) {
    const label = propLabel(def) || def.id
    if ((byLabel.get(label) ?? []).length <= 1) {
      out.set(def.id, label)
      continue
    }
    const tags = declaredBy.get(def.id) ?? []
    const source = tags.length > 0 ? ` · ${tags.map((tag) => `#${displayNameOf(tag)}`).join('、')}` : t('ui.props.undeclaredSuffix')
    out.set(def.id, `${label}${source}`)
  }
  /**
   * **追加来源后仍可能重名**：两个都未声明、或两个都被同一个标签声明。
   * 显示名的作用是「用户指着它说清是哪一个」——同一张表里两个相同的名字，
   * 那张表就没完成这件事。最后一步补短 id（id 是身份，显示名只是它的投影）。
   */
  const clashes = new Map<string, string[]>()
  for (const [id, label] of out) {
    const list = clashes.get(label)
    if (list) list.push(id)
    else clashes.set(label, [id])
  }
  for (const [label, ids] of clashes) {
    if (ids.length <= 1) continue
    for (const id of ids) out.set(id, `${label}（${id.slice(-6)}）`)
  }
  return out
}

/**
 * `select` 行的派生（**属性面板与表格共用这一份**）。
 *
 * `choices` 是「这个块此刻能选的」；`currentChoiceLabel` 是「值指向的那一个叫什么」
 * —— 即使它已被作用域隐藏或软删（后者再带 `currentChoiceDeleted`，控件据此标「已删除」）。
 * 两者分开，才做得到「当前值照常显示、不静默丢值」。
 */
export function choiceCells(
  block: Block,
  propId: string,
  def: Block,
  forest: readonly Block[],
  lookup?: ChoiceLookup,
): Pick<
  FieldRow,
  'choices' | 'currentChoiceLabel' | 'currentChoiceDeleted' | 'currentChoiceLabels' | 'currentChoices'
> {
  const look = lookup ?? choiceLookupOf(forest)
  const choices = choicesForDef(block, def, look.tagById)
  const value = valueOf(block, propId)
  // 多值：每一格都显示名字（含软删/隐藏的值），缺失项用「已删除」兜底
  if (cardinalityOf(def) === 'many') {
    const ids = valueListOf(value)
    if (ids.length === 0) return { choices }
    const set = new Set(ids)
    const known = new Set(def.children.map((c) => c.id))
    // 显示顺序＝**选项兄弟序**；不在定义里的旧值（另一个库/已 purge）按值序排在末尾
    const ordered = [...def.children.filter((c) => set.has(c.id)).map((c) => c.id), ...ids.filter((id) => !known.has(id))]
    const currentChoices: Block[] = []
    const currentChoiceLabels: string[] = []
    for (const id of ordered) {
      const current = look.find(id)
      if (!current) {
        currentChoiceLabels.push(t('ui.props.choice.deleted'))
        continue
      }
      currentChoices.push(current)
      currentChoiceLabels.push(choiceDisplayLabel(current, def, look.tagName))
    }
    return { choices, currentChoices, currentChoiceLabels }
  }
  const id = singleValueOf(value)
  if (id === '') return { choices }
  const current = look.find(id)
  // 真没了（purge／值来自另一个库）：没有名字可显示，UI 用「选项已删除」兜底
  if (!current) return { choices }
  const currentChoiceLabel = choiceDisplayLabel(current, def, look.tagName)
  return isDeleted(current) ? { choices, currentChoiceLabel, currentChoiceDeleted: true } : { choices, currentChoiceLabel }
}

/* ------------------------------------------------------------ 引擎属性（core/*） */

/**
 * **引擎属性**：值住在块的**顶层字段**（`created`/`modified`，引擎记账的必填字段），
 * 不是 `props` 袋里的一格；但以属性定义的面目进所有显示面（属性行/面板/清单）。
 *
 * · **id 即词汇**（跨库稳定，与 `derivedId` 的核心词汇同一档）；定义是**合成对象**，
 *   不在森林里——它们没有定义页可编辑，只提供 label/kind 给行构造；
 * · **只读**：`setValue` 拒绝（值由引擎记账，写入没有语义）；
 * · 消费面（`fieldRowText`／面板）**先按 engine 分支**，再走各自的 kind 分支——
 *   合成定义的 kind 只是兜底，漏了分支的画法会把毫秒数当普通值画出来。
 */
export const ENGINE_CREATED = 'core/created'
export const ENGINE_MODIFIED = 'core/modified'

export function isEngineProp(propId: string): boolean {
  return propId === ENGINE_CREATED || propId === ENGINE_MODIFIED
}

let engineDefs: Block[] | null = null
/** 引擎属性的合成定义（模块级缓存；id 稳定 ⇒ 三处消费共享同一批对象） */
export function enginePropDefs(): Block[] {
  engineDefs ??= [
    mkPropDef(t('ui.props.createdAt'), 'date', {}, ENGINE_CREATED),
    mkPropDef(t('ui.props.modifiedAt'), 'date', {}, ENGINE_MODIFIED),
  ]
  return engineDefs
}

/** 引擎属性的值（块顶层字段）；不是引擎属性 ⇒ `undefined` */
export function enginePropValue(block: Block, propId: string): unknown {
  if (propId === ENGINE_CREATED) return block.created
  if (propId === ENGINE_MODIFIED) return block.modified
  return undefined
}

/**
 * 引擎属性行的显示文本：**今天写的只给时刻，往日带上日期**——
 * 记录基本是当天写的（lifelog 的主读法），翻旧账时日期才有信息增量。
 */
export function enginePropText(propId: string, ms: number): string {
  if (!isEngineProp(propId)) return ''
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const d = new Date(ms)
  const hm = `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}`
  return todayISO(d) === todayISO() ? hm : `${todayISO(d).slice(5)} ${hm}`
}

/** 森林里全部属性定义（先序）＋ 引擎属性的合成定义 */
export function allPropDefs(forest: readonly Block[]): Block[] {
  // ⚠️ 拷贝一份再 push：直接拿缓存数组的引用，会把森林里的定义永久攒进缓存
  // （第一次调用后每次调用都多一批——实测把 seed 的任务状态 def 攒进去，
  // 抢走了后续调用里真正的 status 定义）
  const out: Block[] = [...enginePropDefs()]
  walkForest(forest, (b) => {
    if (isPropDef(b)) out.push(b)
  })
  return out
}

/** 按 `propId` 找定义（`propId` 就是块 id） */
export function findPropDef(forest: readonly Block[], propId: string): Block | undefined {
  return allPropDefs(forest).find((d) => d.id === propId)
}

/* ------------------------------------------------------------ 声明 */

/** 一个标签/页声明了哪些属性 —— 即它的标签属性清单（有序 ref 列表；悬空 ref 不静默补，交给解析方跳过） */
export function declaredFieldIds(owner: Block): string[] {
  const raw = prop<unknown>(owner, FIELD_DEFS_PROP)
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === 'string')
}

/**
 * 把一条属性声明到标签/页上，从此成为它的标签属性（幂等；追加到末尾 ＝ 显示顺序）。
 *
 * **只有标签能声明属性**：声明必须有自动获得方 —— 标签的成员。
 *
 * ⚠️ **页不再能声明**（v29）。它曾经可以，但那一格写进去**没有任何消费方**：
 *    页的子块并不会因此获得那些字段。一个能写、没人读的值比没有更糟 ——
 *    用户会以为「声明了，成员就有这一格了」。继承是另一个设计
 *    （要先定「页的子块」与「标签的成员」谁说了算），在定下来之前这一格不可写。
 *
 * ⚠️ 判据是**露面**（`hasList`），不是「有名字」：一个有名内容块不该凭空获得
 *    「成员自动继承这些字段」的语义。
 * 返回值说明有没有真的改动。
 */
export function declareField(owner: Block, propId: string): boolean {
  if (!hasList(owner, 'tag')) return false
  const ids = declaredFieldIds(owner)
  if (ids.includes(propId)) return false
  owner.props = { ...(owner.props ?? {}), [FIELD_DEFS_PROP]: [...ids, propId] }
  return true
}

/** 解除声明（**只解除这一条**；定义块与成员块上的值都不动） */
export function undeclareField(owner: Block, propId: string): boolean {
  const ids = declaredFieldIds(owner)
  if (!ids.includes(propId)) return false
  owner.props = { ...(owner.props ?? {}), [FIELD_DEFS_PROP]: ids.filter((id) => id !== propId) }
  return true
}

/** 一个标签/页声明的属性定义（按声明顺序；解析不到的定义跳过 —— 悬空 ref 是状态） */
export function declaredFields(owner: Block, forest: readonly Block[]): Block[] {
  const byId = new Map(allPropDefs(forest).map((d) => [d.id, d]))
  const out: Block[] = []
  for (const id of declaredFieldIds(owner)) {
    const d = byId.get(id)
    if (d) out.push(d)
  }
  return out
}

/* ----------------------------------------------------- 标签属性与块属性 */

/** 自有属性槽的系统属性（有序 ref 列表；pos ＝ 数组下标） */
export const OWN_PROPS_PROP = '_ownProps'

/** `_ownProps` 的形状判据（读路径与落盘校验共用同一份）：非空字符串数组（槽位的 propId，悬空合法） */
export function isOwnPropSlots(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x !== '')
}

/** 这一块自己登记了哪些属性（**有没有**，与**有没有值**是两个问题） */
export function ownPropIds(block: Block): string[] {
  const raw = prop<unknown>(block, OWN_PROPS_PROP)
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === 'string')
}

/**
 * **子块行内属性显示**的声明槽（父块上的系统属性；有序 propId 列表）。
 *
 * 「我的**直接子块**行内显示这些属性」——同类大纲工具「节点元数据」的同构物，但它不是
 * `declareField`（v29 收掉的「页声明」）那件事：**字段不继承、值不落子块**，
 * 声明的只是显示；显示凭**位置**（在声明块直接之下），值各自读子块自己的。
 * 这就是它与「标签声明（成员有这一格）」的分界，也是它没有移动语义坑的原因
 * （没有隐式写，子块上一个字节都不多）。
 */
export const CHILD_PROPS_PROP = '_childProps'

/** `_childProps` 的形状判据（读路径与落盘校验共用同一份）：非空字符串数组（同 `_ownProps` 形状） */
export function isChildPropsValue(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x !== '')
}

/** 父块声明给直接子块显示的属性（去重保序；悬空 id 原样保留，行构造时按「无定义」兜底） */
export function childDisplayProps(parent: Block | null | undefined): string[] {
  const raw = parent ? prop<unknown>(parent, CHILD_PROPS_PROP) : undefined
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.filter((x): x is string => typeof x === 'string' && x !== ''))]
}

/**
 * **传递型引用**：正文**只有一枚引用**的块（没有别的文字与原子）——它只是
 * 「指到那个块的一跳」，透传目标块的显示声明。
 *
 * 判据从严：`content` 恰好一枚 run 且是 `ref`。正文里有别的字 ⇒ 引用只是提及
 * （「今天看了 LifeLog 的设计」不该让子块长出时间戳）。悬空引用（`to` 缺）⇒
 * 不透传——声明跟身份走，身份没了就没有透传的方向。
 */
export function passThroughRefTarget(block: Block): string | null {
  if (block.content.length !== 1) return null
  const r = block.content[0]
  return r.t === 'ref' && r.to ? r.to : null
}

/**
 * 显示声明的**解析链**：父块自己的声明 ∪ 父块各**标签**的声明 ∪ **传递目标的链**
 * （按上列顺序，去重）。
 *
 * 与 `_fieldDefs`（标签声明字段给成员）完全同构——数据槽换成显示槽。同一个槽自动
 * 覆盖几个读者：标签块自己当容器（父链命中）、任意块打了标签（标签链命中）、
 * **传递型引用块**（正文只有一枚引用 ⇒ 沿目标递归，`seen` 防环）。
 * **不做标签继承**（标签的标签不传递）——与「不做继承、多标签并集」同一拍板。
 * 正文里有别的字的引用不透传（见 `passThroughRefTarget`）：引用是内容，透传只认
 * 「这一块就是一跳」的形状。
 */
export function childDisplayPropsResolved(
  parent: Block | null | undefined,
  lookup: { tags: ReadonlyMap<string, Block>; blocks: ReadonlyMap<string, Block> },
  seen: ReadonlySet<string> = new Set(),
): string[] {
  if (!parent || seen.has(parent.id)) return []
  const nextSeen = new Set(seen).add(parent.id)
  const out = childDisplayProps(parent)
  for (const tag of resolveTagIds(parent, lookup.tags)) {
    for (const propId of childDisplayProps(tag)) {
      if (!out.includes(propId)) out.push(propId)
    }
  }
  const target = passThroughRefTarget(parent)
  if (target) {
    for (const propId of childDisplayPropsResolved(lookup.blocks.get(target) ?? null, lookup, nextSeen)) {
      if (!out.includes(propId)) out.push(propId)
    }
  }
  return out
}

/**
 * 给**普通块**加一条自有属性（幂等；追加到末尾 ＝ 显示顺序）。
 *
 * 为什么要一个槽位，而不是写个空值占位：`props[propId] = ''` 会让「键在不在」与
 * 「值空不空」变成同一个问题的两个答案，而 `hasValue` 判的是后者 —— 于是行显示「待填」，
 * 值却已经写进库了。槽位是**声明**，值仍旧只在 `props[propId]` 里，两者各答各的问题。
 *
 * 与标签的 `_fieldDefs` 同构：标签说「我的成员有这些属性」，块说「我自己有这些属性」。
 * 判据也一致：都存有序 id 列表、都不写假值。
 */
export function declareOwnProp(block: Block, propId: string): boolean {
  const ids = ownPropIds(block)
  if (ids.includes(propId)) return false
  block.props = { ...(block.props ?? {}), [OWN_PROPS_PROP]: [...ids, propId] }
  return true
}

/**
 * 块上**自有**的属性 id（有序）：登记过的槽位在前，其后是有值但没登记的
 * （值先于声明写入的路径、以及手工写进去的数据），系统属性不算。
 *
 * ⚠️ 「这块有没有这条属性」只走这一个读法：槽位算、有值也算。只认值会让
 *    刚加还没填的行从面板里消失；只认槽位则会让任何写进来的值因为没有登记而不可见。
 */
export function ownFieldIds(block: Block): string[] {
  const out = ownPropIds(block)
  for (const k of Object.keys(block.props ?? {})) {
    if (k.startsWith('_') || out.includes(k)) continue
    out.push(k)
  }
  return out
}

/**
 * **块中拆分（Enter）时的属性分家：值属性随前半走，身份留在原块。**
 *
 * 「是任务」「优先级」这类值属性说的是**这一行写的那句话**；拆开后那句话是
 * 前半（上方新块），下半只是续文 —— 让续文继承任务标记，读起来就是
 * 「后半莫名其妙带了个方框」。自有槽（`_ownProps`）跟着值一起走：
 * 槽是值的声明，两者分开会让「这一栏在不在」在两块上各答一半。
 *
 * `_` 开头的系统属性（地址、露面、日期、查询…）是**块身份**，不属于内容 ——
 * 原块保 id，身份也保在原块；标签声明（`_tags`／`_fieldDefs`）同理不搬，
 * 所以靠标签拿到这一栏的块拆开后两半都还带着声明，这是分类的本义，不是 bug。
 */
export function splitPropsForEnter(
  props: BlockProps | undefined,
): { moved: BlockProps | undefined; kept: BlockProps | undefined } {
  if (!props) return { moved: undefined, kept: undefined }
  const moved: BlockProps = {}
  const kept: BlockProps = {}
  for (const [k, v] of Object.entries(props)) {
    if (k === OWN_PROPS_PROP || !k.startsWith('_')) moved[k] = v
    else kept[k] = v
  }
  return {
    moved: Object.keys(moved).length > 0 ? moved : undefined,
    kept: Object.keys(kept).length > 0 ? kept : undefined,
  }
}

export function valueOf(block: Block, propId: string): unknown {
  return block.props?.[propId]
}

export function hasValue(block: Block, propId: string): boolean {
  const v = valueOf(block, propId)
  if (v === undefined || v === null) return false
  if (typeof v === 'string' && v === '') return false
  if (Array.isArray(v) && v.length === 0) return false
  return true
}

/** 属性面板的一行（派生，不落库） */
export interface FieldRow {
  propId: string
  /** 显示名：定义块的正文；定义缺失时退回 propId（数据不静默消失） */
  label: string
  kind: PropKind
  /** 值形态：`one`（缺省）／`many`（`select` 的多值） */
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
   * `select` 行：这个块此刻能选的选项（`choicesFor` 的结果，兄弟顺序）。
   *
   * UI **不许**再读定义块上的任何「选项目录」——「这个块有哪些选项」只有这一个读法，
   * 属性面板与表格都吃它。
   */
  choices?: Block[]
  /**
   * `select` 行：当前值对应的选项名（**即使它被作用域隐藏或已软删**）。
   *
   * 找不到（选项真的没了／值来自另一个库）时缺席，由 UI 用字典兜底
   * 「选项已删除」——值本身不动，用户可显式清空。
   */
  currentChoiceLabel?: string
  /** `select` 行：当前值指向的选项**已被软删**（控件显示旧名 ＋ 「已删除」标记） */
  currentChoiceDeleted?: boolean
  /** `select` 多值行：当前值指向的选项名（顺序＝选项兄弟序；缺失项用「已删除」兜底） */
  currentChoiceLabels?: string[]
  /** `select` 多值行：当前值指向的选项块（含软删；缺失项不在里面） */
  currentChoices?: Block[]
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
export function fieldRows(block: Block, forest: readonly Block[]): FieldRow[] {
  const defs = new Map(allPropDefs(forest).map((d) => [d.id, d]))
  const tags = tagsById(forest)
  const rows = new Map<string, FieldRow>()
  let order = 0

  /** 同一份行派生里补 `select` 的几格：值控件的选项与当前值名字都从这里来 */
  let look: ChoiceLookup | undefined
  const lazyLook = (): ChoiceLookup => (look ??= choiceLookupOf(forest))

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
): FieldRow[] {
  const rows = fieldRows(block, forest)
  if (!parent) return rows
  const defs = new Map(allPropDefs(forest).map((d) => [d.id, d]))
  let order = (rows[rows.length - 1]?.order ?? -1) + 1
  let look: ChoiceLookup | undefined
  const lazyLook = (): ChoiceLookup => (look ??= choiceLookupOf(forest))
  const merged = [...rows]
  const lookup = { tags: tagsById(forest), blocks: new Map(forest.map((b) => [b.id, b])) }
  for (const propId of childDisplayPropsResolved(parent, lookup)) {
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
}

/** 块下属性行：批级派生（整屏一次扫库，行级只查表） */
export function belowFieldsFor(
  blocks: readonly Block[],
  forest: readonly Block[],
  /** 行的模型父块（`_childProps` 显示声明的来源）；省略 ⇒ 行为与旧签名完全一致 */
  parentOf?: (id: string) => Block | null | undefined,
): Map<string, BelowFields> {
  const defs = new Map(allPropDefs(forest).map((d) => [d.id, d]))
  const tags = tagsById(forest)
  // 传递型引用的解析要按 id 找目标块（与 tags 同一次森林遍历的成本档）
  const lookup = { tags, blocks: new Map(forest.map((b) => [b.id, b])) }
  let look: ChoiceLookup | undefined
  const lazyLook = (): ChoiceLookup => (look ??= choiceLookupOf(forest))
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

    const visible: FieldRow[] = []
    let pending = 0
    for (const row of rows.values()) {
      if (isGutterRow(row)) continue
      if (row.filled) visible.push(row)
      else pending++
    }
    if (visible.length > 0) out.set(block.id, { rows: visible, pending })
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
  /** 字段基数（`one`／`many`；只有 `select` 可能是 `many`） */
  cardinality: Cardinality
  /**
   * `select`（单值）：当前值指向的选项（**含软删**）。渲染方据此取图标与显示名；
   * 值缺失／值不是选项 id ⇒ 缺席。
   */
  choice?: Block
  /**
   * `select`（多值）：被选中的选项，**按选项兄弟序**（含软删/已隐藏——值还在就要显示）。
   * 渲染方据此画多枚图标；空数组＝未填。
   */
  picked?: Block[]
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
  /** `select`：用途；只有 `status` 时这个勾选框同时是任务开关（划线/⌘↵） */
  use?: PropUse
}

/** 当前值指向的选项（含软删：值还在，显示不能丢）；不是选项 id ⇒ 缺席 */
function choiceByValue(def: Block, value: unknown): Block | undefined {
  const id = singleValueOf(value)
  if (id === '') return undefined
  return def.children.find((c) => c.id === id)
}

/** 多值：按选项兄弟序取回被选中的选项（含软删/已隐藏，值还在就要显示） */
function pickedChoicesOf(def: Block, value: unknown): Block[] {
  const ids = new Set(valueListOf(value))
  if (ids.size === 0) return []
  return def.children.filter((c) => ids.has(c.id))
}

/** 块左侧画哪个图标：选项自己的 `_icon` 优先，缺省退回定义块上的 `_icon` */
function gutterIconOf(def: Block, choice: Block | undefined): string | undefined {
  return (choice ? prop<string>(choice, ICON_PROP) : undefined) ?? prop<string>(def, ICON_PROP)
}

/** 一行字段 → gutter 上的一件（两个派生入口共用，避免逐行/批量两种形状漂移） */
function gutterFieldOf(
  row: { propId: string; def: Block; kind: PropKind; value: unknown; filled: boolean },
): GutterField {
  const cardinality = row.kind === 'select' ? cardinalityOf(row.def) : 'one'
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
export function gutterFieldsOf(block: Block, forest: readonly Block[]): GutterField[] {
  // 口径必须与批量的 `gutterFieldsFor` 一致：它吃的是同一份 `fieldRows`（声明 ∪ 自有、同 id 一行），
  // 只是「扫库」在行级重复做了一遍 —— 所以单块用它、整屏用批量。
  const out: GutterField[] = []
  for (const row of fieldRows(block, forest)) {
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
): Map<string, GutterField[]> {
  // 定义块与标签块各扫**一次**：行级只查表
  const defs = new Map(allPropDefs(forest).map((d) => [d.id, d]))
  const tagById = tagsById(forest)

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

/* ------------------------------------------------------------ 写值 */

/**
 * 写一个值（**一块一槽**：键是 propId；不碰任何标签）。
 *
 * **顺带记改动时刻**：属性值住在属性袋里、时刻住在块上，而写属性的事务按属性袋的差异
 * 发 `prop.set` —— 它不会去看时刻变了没有。不在这里一起写，就会得到一条「值变了、
 * 修改时间是旧的」的账，而面板上那一行最显眼。
 * ⚠️ 只认「值真的变了」：点一下已经选中的那个选项不是一次改动。
 */
export function setValue(block: Block, propId: string, value: unknown): void {
  // 引擎属性只读：值由引擎记账，写入没有语义（静默 no-op ⇒ 零 op、不进撤销）
  if (isEngineProp(propId)) return
  const prev = block.props?.[propId]
  block.props = { ...(block.props ?? {}), [propId]: value }
  if (!sameValue(prev, value)) block.modified = Date.now()
}

/**
 * 「清空值」之后这一栏还该不该在？
 *
 * 定义给了 `_default` ⇒ 「未填」是定义明确支持的状态（读侧有答案：读缺省），
 * 清空应该停在「待填」，而不是把整栏摘掉 —— 任务状态就是这类：清空后块仍是
 * 任务（方框还在、读出「待办」），摘栏走它专属的「取消待办」。
 * 没有缺省的定义，未填没有读侧答案，自有栏的清空就是它唯一的退路。
 */
export function clearKeepsField(def: Block | undefined): boolean {
  return def !== undefined && prop<unknown>(def, DEFAULT_PROP) !== undefined
}

/**
 * 删一个值（只删这一槽；标签的声明与定义都不动）。
 *
 * ⚠️ **自有属性槽默认跟着一起删**：对普通块来说「这条属性」是用户手动加进来的，清空值
 *    是这个动作唯一的退路 —— 留下一个永远「待填」的行，用户就再也没法把它去掉。
 *    标签声明的属性正相反：声明在标签上，值清空后行仍在（那才是「待填」的意义）。
 *
 * ⚠️ `keepField`（清空后留栏）：定义给了缺省值的字段（`clearKeepsField`）走这一档 ——
 *    没槽的当场补登记（值先于槽写入的旧块也有份），行回到「待填」。
 *    「摘掉整栏」对这类字段另有专属命令（如「取消待办」），不带这个选项。
 */
export function clearValue(block: Block, propId: string, opts: { keepField?: boolean } = {}): void {
  // 引擎属性只读：与 `setValue` 同一条闸（清空同样没有语义）
  if (isEngineProp(propId)) return
  const hadSlot = ownPropIds(block).includes(propId)
  const hadValue = block.props !== undefined && propId in block.props
  if (!hadValue && !hadSlot && !opts.keepField) return
  const next = { ...(block.props ?? {}) }
  delete next[propId]
  if (opts.keepField) {
    if (!hadSlot) next[OWN_PROPS_PROP] = [...ownPropIds(block), propId]
  } else if (hadSlot) {
    const slots = ownPropIds(block).filter((id) => id !== propId)
    if (slots.length === 0) delete next[OWN_PROPS_PROP]
    else next[OWN_PROPS_PROP] = slots
  }
  // 属性袋不留空壳：`{}` 与「没有属性」在快照比较里是两种东西
  if (Object.keys(next).length === 0) delete block.props
  else block.props = next
  // 摘一个值是一次改动（早退那条路径已经保证「本来就没有」走不到这里）
  block.modified = Date.now()
}

/* ------------------------------------------------------------ 摘标签后的清理 */

/**
 * 摘掉一个标签后，**可清理**的值有哪些。
 *
 * 判据（与「值留存」口径配套）：
 *   · 该标签声明了它；② 块上有值；③ **剩余标签都不声明它**（被别处声明 ⇒ 不是这一节的值）。
 * 摘标签**默认不清理**（值留存）—— 本函数只回答「清理的话会清哪些」，由用户决定。
 */
export function cleanableValues(block: Block, removedTag: Block, forest: readonly Block[]): string[] {
  const declared = declaredFieldIds(removedTag)
  if (declared.length === 0) return []
  const remaining = resolveTagIds(block, tagsById(forest)).filter((t) => t.id !== removedTag.id)
  const stillDeclared = new Set(remaining.flatMap((t) => declaredFieldIds(t)))
  return declared.filter((pid) => hasValue(block, pid) && !stillDeclared.has(pid))
}

/* ------------------------------------------------------------ 任务状态词汇 */

/**
 * 全部选项 id（**值域的权威清单**：按需物化补选项、种子查询认终态都走它）。
 *
 * 选项**块**的构造器在 `fixtures/task-vocabulary.ts`——显示名是库内容（数据，不是
 * 文案），与种子内容同住；这里只放代码要按 id 认的确定性 id。
 */
export const TASK_STATUS_CHOICE_IDS = [
  TASK_STATUS_TODO_ID,
  TASK_STATUS_DOING_ID,
  TASK_STATUS_DONE_ID,
  TASK_STATUS_ABANDONED_ID,
] as const
