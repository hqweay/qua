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
  ALIASES_PROP,
  COLOR_PROP,
  ICON_PROP,
  aliasesOf,
  isDeleted,
  hasList,
  isPropDefBlock,
  prop,
  type Block,
  type BlockProps,
  type ClosureState,
} from '../model/model.ts'
import { displayNameOf } from '../identity/alias.ts'
import { plainText, textRuns, type RefRun } from '../model/runs.ts'
import { walkForest } from '../model/walk.ts'
import { derivedId, pad, uuidv7Hex } from '../model/ids.ts'
import { journalDate, todayISO } from '../identity/journal.ts'
import { allTags, resolveTagIds, TAGS_PROP, tagIdsOf, tagsById } from '../identity/tags.ts'
import { t } from '../infra/msg.ts'
import { checkExternalUrl } from '../relations/link.ts'

/**
 * 选项记录域：类型、形状判据、墓碑、作用域住 `./choices.ts`；
 * 本文件从那里再导出，**对外的符号名不变**（`core/index.ts` 只转一手）。
 */
export {
  CHOICES_PROP,
  CHOICE_SCOPE_PROP,
  choiceScopeOf,
  choiceVisible,
  choicesOf,
  allChoicesOf,
  isChoicesValue,
  newChoiceId,
  parseChoiceScope,
  parseChoices,
  patchChoice,
  setChoices,
  type ChoiceScope,
  type PropChoice,
} from './choices.ts'
import {
  CHOICE_SCOPE_PROP,
  allChoicesOf,
  choiceScopeOf,
  choiceVisible,
  choicesOf,
  parseChoiceScope,
  type ChoiceScope,
  type PropChoice,
} from './choices.ts'
/**
 * `ref` 的候选域（`_refTags` 软约束）住 `./ref-target.ts`；本文件再导出，
 * **对外的符号名不变**（`core/index.ts` 只转一手）。
 */
export { REF_TAGS_PROP, isRefTagIds, refTagIds, refTagNames, refTargetScope } from './ref-target.ts'

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
 * 选项块与定义块一样是**核心词汇**：`closureOf`、⌘↵ 切换、种子查询都要按 id 认「完成」，
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
  /**
   * **活着的**标签块 id（与 `tagsOf` 同一趟扫描得到的那些）。
   *
   * 判 `_tags` 这一档「有没有标签」要它：屏幕上画出来的标签是**能解析到块**的那些，
   * 悬空的归属（标签进了回收站）不画。查询若不看这张表，就会出现
   * 「屏幕上一个标签都没有、`{prop:{id:'_tags',exists:true}}` 却命中它」。
   */
  liveTags: ReadonlySet<string>
  /** 属性 id → kind（来自定义块） */
  kinds: ReadonlyMap<string, PropKind>
  /** 属性 id → 缺省值（定义块写了 `_default` 才有；`readField` 对「已声明未填」按它取值） */
  defaults: ReadonlyMap<string, unknown>
  /**
   * **唯一**扮演「关闭」角色的定义（`_use: 'closure'` ＋ 合法 `_check`）。
   * 库级概念：没有「多个完成型属性取第一条」的裁决。
   */
  closure?: { defId: string; on: string; off: string }
  /** 属性 id → 基数（缺省 `one`；定义块写了 `_cardinality: 'many'` 才是多值） */
  cardinality: ReadonlyMap<string, Cardinality>
}

/** 从森林建一份字段读取表（标签声明 ＋ 定义 kind／缺省值各扫一趟） */
export function fieldTableOf(forest: readonly Block[]): FieldTable {
  const byTag = new Map<string, readonly string[]>()
  const liveTags = new Set<string>()
  for (const tag of allTags(forest)) {
    liveTags.add(tag.id)
    byTag.set(tag.id, declaredFieldIds(tag))
  }
  const kinds = new Map<string, PropKind>()
  const defaults = new Map<string, unknown>()
  const cardinality = new Map<string, Cardinality>()
  let closure: FieldTable['closure']
  for (const def of allPropDefs(forest)) {
    kinds.set(def.id, propKindOf(def))
    const dflt = prop<unknown>(def, DEFAULT_PROP)
    if (dflt !== undefined) defaults.set(def.id, dflt)
    const card = cardinalityOf(def)
    if (card === 'many') cardinality.set(def.id, card)
    // 写入路径保证最多一个 closure；坏数据带多个时按先序取第一个，不抛错
    if (!closure && useOf(def) === 'closure') {
      const check = checkOf(def)
      if (check) closure = { defId: def.id, on: check.on, off: check.off }
    }
  }
  return { byTag, liveTags, kinds, defaults, cardinality, ...(closure ? { closure } : {}) }
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
 *    查询、看板分组、`closureOf` 都走这里 ⇒ 同一块在所有读法里是同一个答案。
 */
export function readField(block: Block, propId: string, table: FieldTable): FieldRead {
  // 系统槽（`_date`／`_kind`／`_tags`…）走模型判据，不读 `props` 裸键
  const system = readSystemField(block, propId, table)
  if (system) return system
  const has = block.props !== undefined && propId in block.props
  if (has) return { declared: true, value: block.props?.[propId] }
  const declared = fieldDeclared(block, propId, table)
  if (!declared) return { declared, value: undefined }
  if (table.kinds.get(propId) === 'checkbox') return { declared, value: false }
  return { declared, value: table.defaults.get(propId) }
}

/**
 * **关闭态**的派生读法：唯一扮演 `closure` 角色的定义（＋标签声明）。
 *
 * 三态与值这样对上：
 *   · 值＝该定义 `_check.on` ⇒ `'closed'`（关闭了）；
 *   · 其余任何已声明形态 ⇒ `'open'`（**有关闭态、还没关闭**）——未填、进行中、
 *     以及**靠标签声明拿到这一栏还没填**的块（读侧缺省读出缺省项）；
 *   · 没有 closure 定义，或这块没有那一栏 ⇒ `undefined`（这一行没有关闭态）。
 *
 * ⚠️ **判据是「有没有这一栏」（`readField`），不是「有没有值」。** 把「未填」并进
 *    `undefined` 会让刚挂上的开关立刻消失 —— 屏幕上画着空心方框、查询查不到它。
 *
 * ⚠️ 必须传 `FieldTable`：只认 `_ownProps` 会漏掉**标签声明**那一半。那种块屏幕上是
 *    未关闭、模型里却没有关闭态 —— 同一个块两种答案，且没有任何一层报错。
 *
 * ⚠️ **角色不是类型**：这里一个字都不提「任务」。`#任务` 是种子给「closure 角色 +
 *    标签声明」起的一个约定名；换一套词汇（`#书` ＋ `读完`）零代码。
 *
 * ⚠️ **不再有「第一条完成型属性」**：`_use: 'closure'` 全局唯一（写入路径保证），
 *    `closureOf` 只认这一条；两个属性的歧义在模型层就不存在。
 */
export function closureOf(block: Block, table: FieldTable): ClosureState | undefined {
  const closure = table.closure
  if (!closure) return undefined
  const { declared, value } = readField(block, closure.defId, table)
  if (!declared) return undefined
  return singleValueOf(value) === closure.on ? 'closed' : 'open'
}

/**
 * **七个 kind**（集合封闭）：判据是**值的存储形状**（或校验/查询算子的
 * 本质）不同；只是编辑器/渲染增强的归**格式**。
 *
 *   text（含 url/email/phone 格式）／number／date（含 datetime 格式）／checkbox／
 *   select（记录域）／ref（任意块 id）／asset（两态来源引用）
 *
 * ⚠️ `url`／`datetime`／`image`／`email`／`phone` **不是 kind**：它们各自只是某个
 *    kind 的格式。把其中任何一个写成 kind 都是退回了旧形状。
 */
export type PropKind = 'text' | 'number' | 'date' | 'checkbox' | 'select' | 'ref' | 'asset'

export const PROP_KINDS: readonly PropKind[] = ['text', 'number', 'date', 'checkbox', 'select', 'ref', 'asset']

/**
 * 已退役的 kind 名（只给**读路径**认）：
 * `url` 降格成 `text` 的 `url` 格式。旧桌面库的 `_kind: 'url'`
 * 仍在磁盘上，冷启动不能判 corrupt —— 所以形状判据宽容它，`propKindOf` 归一成 text。
 */
const LEGACY_KINDS: readonly string[] = ['url']

/** 形状判据（含退役名）：**落盘校验与写侧入口共用**，退役名不算坏形状 */
export function isPropKind(v: unknown): v is PropKind {
  return typeof v === 'string' && ((PROP_KINDS as readonly string[]).includes(v) || LEGACY_KINDS.includes(v))
}

/** 当前这一代的 kind（不含退役名）：新建定义只许走这里 */
export function isCurrentPropKind(v: unknown): v is PropKind {
  return typeof v === 'string' && (PROP_KINDS as readonly string[]).includes(v)
}

/** 定义块上的**格式**槽（同值形状内的约束与渲染增强；展示不落盘，格式是类型的一部分） */
export const FORMAT_PROP = '_format'

/**
 * **kind 注册表**：一条声明说清这个 kind 能装什么。
 *
 * 为什么要一张表而不是散装 `if (kind === 'select')`：值形状、格式允许集、基数允许集
 * 是**同一件事的三个面**，散在编辑器/查询/渲染各写一份，迟早有一份漏掉——
 * 那时出现的症状是「界面上能填、查询算不出来」。
 *
 * `formats` 用封闭集：写进去一个不在表里的格式就是坏形状（读侧回落 undefined）。
 * 空数组 ＝ 这个 kind 没有格式轴。
 */
export interface PropKindSpec {
  /** 值的标量形状（多值时逐项校验）；**空值判定不在这里**（`hasValue` 管） */
  isValue: (v: unknown) => boolean
  /** 允许的格式（空＝没有格式轴） */
  formats: readonly string[]
  /** 允许多值（`_cardinality: 'many'`）；`false` 时写路径挡住 */
  many: boolean
}

const isStringValue = (v: unknown): boolean => typeof v === 'string'

export const PROP_KIND_SPECS: Readonly<Record<PropKind, PropKindSpec>> = {
  // 格式轴：plain（缺省）／url／email／phone —— 都在同一个字符串形状里
  text: { isValue: isStringValue, formats: ['plain', 'url', 'email', 'phone'], many: true },
  // 按真数字存：排序与 gt/lt 的正确性是 kind 的第一职责；单位/小数位格式**未拍板**（原样放行）
  number: { isValue: (v) => typeof v === 'number' && Number.isFinite(v), formats: [], many: true },
  date: { isValue: isStringValue, formats: ['date', 'datetime'], many: false },
  checkbox: { isValue: (v) => typeof v === 'boolean', formats: [], many: false },
  // 值＝记录 id（不透明）；域住在定义块的 `_choices`
  select: { isValue: isStringValue, formats: [], many: true },
  // 值＝任意块 id；实体档（inline 岛）是看法层的事，不改值形状
  ref: { isValue: isStringValue, formats: [], many: true },
  // 两态来源引用：资产库 hash 或 http(s) URL —— 同一个字符串形状，按 scheme 现算分派
  asset: { isValue: isStringValue, formats: ['image', 'file', 'any'], many: true },
}

export function kindSpecOf(kind: PropKind): PropKindSpec {
  return PROP_KIND_SPECS[kind]
}

/** 这个 kind 允许多值吗（基数轴的 per-kind 允许集） */
export function allowsMany(kind: PropKind): boolean {
  return PROP_KIND_SPECS[kind].many
}

/**
 * 一格的标量值合不合这个 kind 的形状。
 *
 * ⚠️ 只管**形状**，不管「有没有值」：空串／空数组是「没填」，由 `hasValue` 判。
 *    多值的每一项过这一关，数组本身在这一关之外（`valuesOk`）。
 */
export function isKindValue(kind: PropKind, value: unknown): boolean {
  return PROP_KIND_SPECS[kind].isValue(value)
}

/** 一格值（单值或多值）整体合不合：多值时逐项校验，空数组合法（＝没填） */
export function valuesOk(kind: PropKind, value: unknown): boolean {
  if (Array.isArray(value)) return value.every((v) => isKindValue(kind, v))
  return isKindValue(kind, value)
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

/**
 * 定义的 kind（落盘缺省按 text：旧数据/手写定义不该让面板整段消失）。
 *
 * ⚠️ **退役名在这里归一**：`_kind: 'url'` 读成 `text`（格式由 `formatOf` 给 `url`）。
 *    这是读路径兼容，不是迁移 —— 磁盘上的那个字符串不动。
 */
export function propKindOf(def: Block): PropKind {
  const k = prop<unknown>(def, '_kind')
  if (k === 'url') return 'text'
  return isCurrentPropKind(k) ? k : 'text'
}

/**
 * 定义的格式（`_format`）：同值形状内的约束与渲染增强。
 *
 * 三种「没有格式」要分开：
 *   · 这个 kind 没有格式轴（checkbox/select/ref）⇒ 写了也不认，返回 undefined；
 *   · 格式名不在允许集里（坏数据）⇒ 回落 undefined（按缺省格式画，不崩）；
 *   · 旧形状的 `_kind: 'url'` 没写过 `_format` ⇒ 按 `url` 解释（遗留值在场）。
 *
 * `number` 的单位/小数位格式**未拍板**：这一格原样放行，等拍板后再收窄。
 */
export function formatOf(def: Block): string | undefined {
  const kind = propKindOf(def)
  const raw = prop<unknown>(def, FORMAT_PROP)
  if (kind === 'number') return typeof raw === 'string' && raw !== '' ? raw : undefined
  const spec = PROP_KIND_SPECS[kind]
  if (spec.formats.length === 0) return undefined
  if (typeof raw === 'string' && spec.formats.includes(raw)) return raw
  if (kind === 'text' && prop<unknown>(def, '_kind') === 'url') return 'url'
  return undefined
}

/** 格式名的形状（写侧用）：非空字符串；按 kind 的允许集收窄在命令层做 */
export function isFormatValue(v: unknown): boolean {
  return typeof v === 'string' && v !== ''
}

/* ------------------------------------------------------------ 格式与值校验 */

/**
 * `text` 的四种格式（`_format` 的允许集）。
 *
 * `url` 是**格式**不是 kind：多链接＝`text + url + many`。这条判据来自
 * 「值的存储形状不同才算 kind」—— 链接与纯文本都是字符串，只是校验与画法不同。
 */
export type TextFormat = 'plain' | 'url' | 'email' | 'phone'

export const TEXT_FORMATS: readonly TextFormat[] = ['plain', 'url', 'email', 'phone']

export function isTextFormat(v: unknown): v is TextFormat {
  return typeof v === 'string' && (TEXT_FORMATS as readonly string[]).includes(v)
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** 电话按「宽松形状」收：国家码、括号、空格、连字符都合法，不猜哪种规范 */
const PHONE_SHAPE = /^[+()\d][+()\d\s-]{2,}$/

/**
 * 一格文本值合不合声明的格式。
 *
 * **空串恒合法**：空是「没填」，不是「格式错」—— 把清空挡在格式校验里，
 * 用户就永远填不了第二遍（先得把错的那半截清掉，而清空也算错）。
 *
 * `url` 只收 `http:`／`https:`（与「打开链接」同一份白名单，
 * `relations/link.ts:checkExternalUrl`）：这里放行的协议，插入端和打开端都放行。
 */
export function textFormatOk(format: string | undefined, value: string): boolean {
  const s = value.trim()
  if (s === '') return true
  if (format === 'url') return checkExternalUrl(s).ok
  if (format === 'email') return EMAIL_SHAPE.test(s)
  if (format === 'phone') return PHONE_SHAPE.test(s)
  return true
}

/**
 * `asset` 的值：两态来源引用（内态资产库 hash ／ 外态 http(s) URL）。
 *
 * 判据只看**形状**，不看字节在不在库：本地性是值的状态维度，不是 kind 维度。
 * 缺失/腐烂是**显示态**（真图／缺失／不可用三态），不是写不进去的理由。
 *
 * 两态怎么分派也只在这里判一次：渲染侧拿 `assetRefKindOf` 决定「查索引」还是
 * 「直接用这个地址」，与写侧共用同一份协议白名单（`checkExternalUrl`）——
 * 分开放会写出「能存进去但画不出来」或「画得出来但存不进去」的值。
 */
export type AssetRefKind = 'internal' | 'external'

export function assetRefKindOf(v: unknown): AssetRefKind | null {
  if (typeof v !== 'string' || v === '') return null
  if (/^[0-9a-f]{16,}$/i.test(v)) return 'internal'
  return checkExternalUrl(v).ok ? 'external' : null
}

export function isAssetRef(v: unknown): boolean {
  return assetRefKindOf(v) !== null
}

/**
 * 一格 `asset` 值 → 一串合法引用（**单值与多值同一条读法**）。
 *
 * 显示面与值控件都从这里读：直接用 `String(value)` 会把多值数组压成 `a,b`，
 * 下一次写入就把 List 抹成单值。坏形状不进显示面，但也不改值（写路径才管值）。
 */
export function assetRefsOf(value: unknown): string[] {
  return valueListOf(value).filter((ref) => assetRefKindOf(ref) !== null)
}


/* ------------------------------------------------------------ 选项（select） */

/*
 * 选项**不再是块**：记录域、墓碑、可见性判据住在 `./choices.ts`，
 * 本文件只消费它。这里保留哪些东西、为什么：
 *
 *   · `choicesOf` / `allChoicesOf` / `choiceScopeOf` / `choiceVisible` —— 再导出，
 *     调用方（面板、表格、gutter）读到的仍是同一份语义，只是元素从 Block 换成记录；
 *   · `choiceDisplayLabel` / `choicesForDef` / `choiceCells` —— 留在这一层，因为它们
 *     要「定义块的标签作用域」＋「同名判据」这两样本文件已有的东西；
 *   · 旧形状遗留（桌面真机库的选项子块）由 `choiceById` 的**块兜底**读出来，
 *     不写迁移：值指向的旧块还在森林里 ⇒ 名字仍读得出。
 */

/**
 * 属性定义的**用途**（系统属性）：这条属性拿来干什么。
 *
 * 现在只有 `closure`（这条属性的 on 值表示「关闭」）。优先级等角色先作为普通 select，
 * 等有应用级消费者（任务表／快捷键／默认模板）再扩这个联合——不要为假设的用途先造枚举值。
 *
 * **角色不是类型**：「任务」是种子内容（`#任务` ＋ 标签声明），不是模型概念。
 *
 * 用途与显示分开：`_use` 说语义，`_check` 说怎么编辑/显示。
 */
export type PropUse = 'closure'

export const USE_PROP = '_use'

/**
 * 旧库遗留的用途名（`status` 是这次改名之前的写法）。
 *
 * 与 `LEGACY_KINDS` 同一条理由：浏览器库靠版本号作废，**桌面库的旧值仍在盘上**，
 * 冷启动不能把它判成坏形状、也不能静默丢掉关闭态。只在读路径认，写路径只写新值。
 */
const LEGACY_USE: readonly string[] = ['status']

export function isUseValue(v: unknown): boolean {
  return typeof v === 'string' && (v === 'closure' || LEGACY_USE.includes(v))
}

/** 定义的用途；不是 `select`／没写／未知值 ⇒ 缺席（普通属性） */
export function useOf(def: Block | undefined): PropUse | undefined {
  if (!def || propKindOf(def) !== 'select') return undefined
  const v = prop<string>(def, USE_PROP)
  return v === 'closure' || (typeof v === 'string' && LEGACY_USE.includes(v)) ? 'closure' : undefined
}

/**
 * 勾选框映射（系统属性）：勾选写 `on`、取消写 `off`。
 *
 * 它是**显示/编辑**映射，不自动等于关闭态：`_use: 'closure'` 时才驱动
 * `closureOf`/删除线/⌘↵；没有 `_use` 就只是一个普通的两态开关（如「已读/未读」）。
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
 * 把一格值读成**值列表**（任意 kind 的多值读法）。
 *
 * 与 `valueListOf` 的分工：那个只服务「值是 id 字符串」的 kind（select／ref／asset），
 * 这个不滤类型 —— `number` 多值存的是数字数组，走 `valueListOf` 会读成空列表，
 * 屏幕上就成了「有值但显示待填」。
 *
 * 单值一律视为「只有一项」：多值定义刚打开时旧块还没被写过（`valueListOf` 同一口径）。
 */
export function valueItemsOf(value: unknown): unknown[] {
  if (value === undefined || value === null || value === '') return []
  if (!Array.isArray(value)) return [value]
  return value.filter((v) => v !== undefined && v !== null && v !== '')
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
 * ⚠️ 判据本体住在 `./choices.ts`（记录与遗留块共用同一份）：这里只再导出，
 *    免得两条读路径对「什么算合法作用域」各有一个答案。
 */

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
 * **「这个块能选哪些选项」的唯一实现**（记录序）。
 *
 * 适用性来自块自己打着的标签（`_fieldDefs` 的声明），可见性来自记录的 `scope`。
 * 属性面板与表格都必须走这里 —— 两处各写一遍 filter 就会出现
 * 「同一块在两个视图里能选的东西不一样」。
 */
export function choicesForDef(block: Block, def: Block, tagById: (id: string) => Block | undefined): PropChoice[] {
  if (propKindOf(def) !== 'select') return []
  const tagIds = tagIdSetOf(block, tagById)
  return choicesOf(def).filter((c) => choiceVisible(c, tagIds))
}

/**
 * 这个块在某个属性上**能选**的选项（记录序）。
 *
 * 定义缺失或不是 `select` ⇒ 空数组（控件空态，不是崩）。
 */
export function choicesFor(block: Block, propId: string, forest: readonly Block[]): PropChoice[] {
  const def = findPropDef(forest, propId)
  if (!def) return []
  const byId = tagsById(forest)
  return choicesForDef(block, def, (id) => byId.get(id))
}

/**
 * 读 `select` 行时要用的三件查找。
 *
 * 默认从整片森林现建；表格那种「一格一次」的调用方可以传一份**一次算好**的
 * （`find` 要能找到已删的记录：当前值可能指向一条墓碑），否则 N 个格子就是
 * N 次全库扫。
 */
export interface ChoiceLookup {
  /** 按 id 找选项（**含墓碑**；旧形状遗留块会投影成记录） */
  find: (id: string) => PropChoice | undefined
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
 * 旧形状遗留的选项块 → 记录（**只读投影，不落盘**）。
 *
 * 桌面真机库升级后，`def.children` 里那些选项子块还在（桌面不吃
 * `WORKSPACE_VERSION`），而值仍指着它们的 id。读路径要读得出名字，否则
 * 每一块的任务状态都会显示「选项已删除」。这条投影就是「遗留值在场」的实现：
 * 有 id、有名字、有作用域、软删的带墓碑 —— 新写入一概不再产生这种块。
 */
export function legacyChoiceOf(b: Block): PropChoice {
  const label = plainText(b.content).trim() || b.id.slice(-6)
  const scope = parseChoiceScope(prop<unknown>(b, CHOICE_SCOPE_PROP))
  const icon = prop<string>(b, ICON_PROP)
  const color = prop<string>(b, COLOR_PROP)
  return {
    id: b.id,
    label,
    ...(icon ? { icon } : {}),
    ...(color ? { color } : {}),
    ...(scope ? { scope } : {}),
    ...(isDeleted(b) ? { deleted: true as const } : {}),
  }
}

/**
 * **可增量修补**的选项查找表（表格按 blockId 局部修补行，不能每格扫全库）。
 *
 * 两张表各管一件事：
 *   · `records` —— 定义块 `_choices` 里的记录（一趟扫全部定义块建好，含墓碑）；
 *   · `blocks` —— 全库块（标签名 ＋ **旧形状遗留选项**的兜底）。
 *
 * `find` 先查记录、再回落块：新形状里同一 id 只会在其中一张表出现，回落不会遮蔽。
 * 增量修补只服务块那一侧（`remember` 的入参本来就是块 id）——记录不通过 `store.find`
 * 增长，新加选项时调用方会重建整表。
 */
export class ChoiceLookupIndex {
  private records = new Map<string, PropChoice>()
  private byId = new Map<string, Block>()
  private tagById = new Map<string, Block>()

  /** 整表重建（含软删的块与标签、含墓碑的记录：名字要显示得出来） */
  rebuild(forest: readonly Block[]): void {
    this.records.clear()
    this.byId.clear()
    this.tagById.clear()
    walkForest(
      forest,
      (b) => {
        this.byId.set(b.id, b)
        if (hasList(b, 'tag')) this.tagById.set(b.id, b)
        // 定义块顺手把记录收进来：同一趟遍历，不另走一遍
        for (const c of allChoicesOf(b)) this.records.set(c.id, c)
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
      find: (id) => {
        const record = this.records.get(id)
        if (record) return record
        const block = this.byId.get(id)
        return block ? legacyChoiceOf(block) : undefined
      },
      tagById: (id) => this.tagById.get(id),
      tagName: (id) => {
        const tag = this.tagById.get(id)
        return tag ? displayNameOf(tag) : id.slice(-6)
      },
    }
  }
}

/**
 * 按 id 找选项（**含墓碑**）：当前值可能指向一个已经不提供选择的选项，
 * 控件仍要显示它的名字，而不是把值静默清掉。
 *
 * 两级：先找定义块上的记录（新形状），再回落森林里的块（旧形状遗留，267.9.1）。
 */
export function choiceById(forest: readonly Block[], choiceId: string): PropChoice | undefined {
  if (choiceId === '') return undefined
  let record: PropChoice | undefined
  let legacy: Block | undefined
  walkForest(
    forest,
    (b) => {
      const hit = allChoicesOf(b).find((c) => c.id === choiceId)
      if (hit) {
        record = hit
        return false
      }
      if (b.id === choiceId) {
        legacy = b
        return false
      }
    },
    { includeDeleted: true },
  )
  if (record) return record
  return legacy ? legacyChoiceOf(legacy) : undefined
}

/** 同一属性下的选项是否重名（**同名不是错**：身份是 id，名字只是显示） */
function duplicateChoiceName(def: Block, choice: PropChoice): boolean {
  const name = choice.label.trim()
  return choicesOf(def).filter((c) => c.label.trim() === name).length > 1
}

/** 选项的作用域后缀（同名说明用） */
function scopeSuffix(scope: ChoiceScope, tagName: (id: string) => string): string {
  const tags = scope.mode === 'all' ? '' : scope.tags.map((id) => `#${tagName(id)}`).join('、')
  if (scope.mode === 'all') return t('ui.props.choice.scopeAllSuffix')
  if (tags === '') return t('ui.props.choice.scopeNoTagsSuffix')
  return scope.mode === 'only'
    ? t('ui.props.choice.scopeOnlySuffix', { tags })
    : t('ui.props.choice.scopeExceptSuffix', { tags })
}

/**
 * **选项的显示名**（属性面板、表格、选项编辑器都只走这一个入口）。
 *
 * 选项名就是记录里的 `label`；同一属性下有同名选项时追加作用域，
 * 仍重名再补短 id —— 两个同名选项必须能被指着说清楚是哪一条。
 */
export function choiceDisplayLabel(choice: PropChoice, def: Block, tagName: (id: string) => string): string {
  const name = choice.label.trim() || choice.id.slice(-6)
  if (!duplicateChoiceName(def, choice)) return name
  const label = `${name}${scopeSuffix(choiceScopeOf(choice), tagName)}`
  const again = choicesOf(def).filter((c) => `${c.label.trim() || c.id.slice(-6)}${scopeSuffix(choiceScopeOf(c), tagName)}` === label)
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
  | 'choices'
  | 'currentChoiceLabel'
  | 'currentChoiceDeleted'
  | 'currentChoiceLabels'
  | 'currentChoices'
  | 'currentChoiceIds'
> {
  const look = lookup ?? choiceLookupOf(forest)
  const choices = choicesForDef(block, def, look.tagById)
  const value = valueOf(block, propId)
  // 多值：每一格都显示名字（含墓碑/隐藏的值），缺失项用「已删除」兜底
  if (cardinalityOf(def) === 'many') {
    const ids = valueListOf(value)
    if (ids.length === 0) return { choices }
    const set = new Set(ids)
    // 顺序用**含墓碑的完整记录序**：值指向已删记录时它仍占原位
    const all = allChoicesOf(def)
    const known = new Set(all.map((c) => c.id))
    // 显示顺序＝**选项序**；不在定义里的旧值（遗留块/另一个库/已 purge）按值序排在末尾
    const ordered = [...all.filter((c) => set.has(c.id)).map((c) => c.id), ...ids.filter((id) => !known.has(id))]
    const currentChoices: PropChoice[] = []
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
    return { choices, currentChoices, currentChoiceLabels, currentChoiceIds: ordered }
  }
  const id = singleValueOf(value)
  if (id === '') return { choices }
  const current = look.find(id)
  // 真没了（purge／值来自另一个库）：没有名字可显示，UI 用「选项已删除」兜底
  if (!current) return { choices }
  const currentChoiceLabel = choiceDisplayLabel(current, def, look.tagName)
  return current.deleted === true
    ? { choices, currentChoiceLabel, currentChoiceDeleted: true }
    : { choices, currentChoiceLabel }
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

/* ------------------------------------------------------------ `{prop}` 能问什么 */

/**
 * `{prop:{id}}` 可以问到的**系统槽白名单**。
 *
 * 为什么不是「只许属性定义块」：`_date`／`_kind`／`_type` 是「哪一天／哪些定义是日期／
 * 哪种块类型」的唯一问法，砍掉就是能力退化（`query.ts` 的 `walk` 注释：定义块自己仍然可查）。
 * 为什么又必须有边界：不设白名单时任何 `_xxx` 都能写进条件，而判定读的是
 * **`props` 里有没有这个键**——比模型判据宽，于是出现「屏幕说不是日记、查询说是日记」
 * （`_date: ''` 的块就是这一例）。
 *
 * ⚠️ 白名单里的每一项都由 `readSystemField` 逐项问**模型里的唯一判据**，
 *    不许退回去读 `props` 裸键。加一项时两处一起加。
 */
export const QUERYABLE_SYSTEM_PROPS: readonly string[] = [
  '_date',
  '_kind',
  '_type',
  ALIASES_PROP,
  TAGS_PROP,
  ENGINE_CREATED,
  ENGINE_MODIFIED,
]

export function isQueryableSystemProp(propId: string): boolean {
  return QUERYABLE_SYSTEM_PROPS.includes(propId)
}

/**
 * `{prop}` 的 id 认不认：**属性定义块 id ∪ 系统槽白名单**。
 *
 * 定义块清单是 `table.kinds`（由 `allPropDefs` 建，含引擎合成定义、排除回收站里的）——
 * 与构建器的字段下拉**同源**，不会出现「下拉里有、求值不认」。
 *
 * ⚠️ 这条判据的消费者是求值器：不认的 id 不命中任何块（见 `query.ts` 的 `compute`）。
 *    不这样做的话，`exists:false` 会静默命中全库——一个拼错的属性名看起来像「这条条件成立」。
 */
export function isQueryableField(propId: string, table: FieldTable): boolean {
  return isQueryableSystemProp(propId) || table.kinds.has(propId)
}

/**
 * 系统槽在**条件树里的显示名**（`undefined` ＝ 不是系统槽）。
 *
 * 条件树的下拉只列属性定义块（用户新增条件时不该看到 `_date` 这类内部 id），
 * 但条件可以由 JSON 写成、或由预设展开而来 —— 那种行要能**如实显示**它问的是什么。
 * 没有这一份，白名单里的 id 会在树上被标成「属性已删除」：求值算它、界面说不存在。
 */
export function systemQueryFieldLabel(propId: string): string | undefined {
  if (propId === '_date') return t('ui.query.sysField.date')
  if (propId === '_kind') return t('ui.query.sysField.kind')
  if (propId === '_type') return t('ui.query.sysField.type')
  if (propId === ALIASES_PROP) return t('ui.query.sysField.aliases')
  if (propId === TAGS_PROP) return t('ui.query.sysField.tags')
  if (propId === ENGINE_CREATED) return t('ui.props.createdAt')
  if (propId === ENGINE_MODIFIED) return t('ui.props.modifiedAt')
  return undefined
}

/**
 * 系统槽的读法：**逐项问模型里的唯一判据**，不读 `props` 裸键。
 *
 * 为什么放在字段读法这一层：`exists`／`eq`／`empty` 三组算子都从 `readField` 拿
 * `{declared, value}`，两条求值路径（纯函数／索引）也共用它。系统槽若各走一条旁路，
 * 「有没有这一栏」就会有两份答案——那一族病（屏幕认、查询不认）已经修过一次。
 *
 * | 槽 | 判据 | 值 |
 * |---|---|---|
 * | `_date` | `journalDate(b) !== ''`（`isJournalBlock` 同一份） | 日期串 |
 * | `_kind` | `isPropDefBlock(b)` | `text`／`date`… |
 * | `_type` | 顶层 `_type` 槽在（**开放性**：未知 id 合法） | 类型 id |
 * | `_aliases` | `aliasesOf(b)` 非空 | 地址数组（`eq` 按任一元素判） |
 * | `_tags` | 归属边里**有活着的标签**（屏幕画得出来的那些） | 标签块 id 数组 |
 * | `core/created`／`core/modified` | 必填字段，恒在 | 墙钟毫秒 |
 */
function readSystemField(block: Block, propId: string, table: FieldTable): FieldRead | undefined {
  if (propId === '_date') {
    const date = journalDate(block)
    return typeof date === 'string' && date !== ''
      ? { declared: true, value: date }
      : { declared: false, value: undefined }
  }
  if (propId === '_kind') {
    return isPropDefBlock(block)
      ? { declared: true, value: block.props?._kind }
      : { declared: false, value: undefined }
  }
  if (propId === '_type') {
    const type = block.props?._type
    return type === undefined ? { declared: false, value: undefined } : { declared: true, value: type }
  }
  if (propId === ALIASES_PROP) {
    const names = aliasesOf(block)
    return names.length > 0 ? { declared: true, value: names } : { declared: false, value: undefined }
  }
  if (propId === TAGS_PROP) {
    const ids = tagIdsOf(block).filter((id) => table.liveTags.has(id))
    return ids.length > 0 ? { declared: true, value: ids } : { declared: false, value: undefined }
  }
  if (isEngineProp(propId)) return { declared: true, value: enginePropValue(block, propId) }
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
 * **传递型引用**：正文**只有一枚引用**的块（没有可见文字、没有别的原子）——它只是
 * 「指到那个块的一跳」，透传目标块的显示声明。
 *
 * 判据：**投影（`plainText`）无可见文字** ＋ 恰一枚 `ref` run ＋ 没有第三种原子。
 * 「恰一枚 run」的初版判据踩了真机：引用后跟一个空格（`[ref, text(' ')]`）看起来
 * 就是「只有引用」，却因多一枚空白 run 被判掉——可见文字为空才是用户心智里的
 * 「只有引用」，空白段不算字。正文里有**非空白**的字 ⇒ 引用只是提及
 * （「今天看了 LifeLog 的设计」不该让子块长出时间戳）。悬空引用（`to` 缺）⇒
 * 不透传——声明跟身份走，身份没了就没有透传的方向。
 */
export function passThroughRefTarget(block: Block): string | null {
  if (plainText(block.content).trim() !== '') return null
  const refs: RefRun[] = []
  for (const r of block.content) {
    if (r.t === 'text') continue
    if (r.t !== 'ref') return null
    refs.push(r)
  }
  if (refs.length !== 1) return null
  return refs[0].to ?? null
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
/** 解析链的查找环境（tags 与全库 byId，一次森林遍历的查找表） */
export interface ChildPropsLookup {
  tags: ReadonlyMap<string, Block>
  blocks: ReadonlyMap<string, Block>
}

/** 从整片森林建查找环境（`belowFieldsFor`／`fieldRowsWithParent`／诊断共用一份构建）。
 *
 * ⚠️ blocks 表必须**递归全库**（`walkForest`），不是顶层一遍——传递目标常是
 * 嵌在子树里的普通块，只建顶层会让「引用目标=非顶层块」的透传静默查空
 * （真机踩过：目标页在顶层命中、目标普通块嵌在子树查空，表现为「引用页生效、
 * 引用块不生效」）。`tagsById` 自带全库递归，不用另处理。 */
export function childPropsLookupOf(
  forest: readonly Block[],
  /**
   * 复用**既有的全库 byId 表**（`store.index.blocks`：活引用、增量维护）。
   * 省掉每次渲染批量的全库 walkForest＋Map 重建——热路径渲染不该每次 O(N) 建表。
   * 缺省（纯函数/单测路径）才自己 walk 一遍。
   */
  blocksById?: ReadonlyMap<string, Block>,
): ChildPropsLookup {
  let blocks: Map<string, Block>
  if (blocksById) {
    blocks = blocksById as Map<string, Block>
  } else {
    blocks = new Map()
    walkForest(forest, (b) => {
      blocks.set(b.id, b)
    })
  }
  return { tags: tagsById(forest), blocks }
}

export function childDisplayPropsResolved(
  parent: Block | null | undefined,
  lookup: ChildPropsLookup,
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

/** 块下属性行：批级派生（整屏一次扫库，行级只查表） */
export function belowFieldsFor(
  blocks: readonly Block[],
  forest: readonly Block[],
  /** 行的模型父块（`_childProps` 显示声明的来源）；省略 ⇒ 行为与旧签名完全一致 */
  parentOf?: (id: string) => Block | null | undefined,
  blocksById?: ReadonlyMap<string, Block>,
): Map<string, BelowFields> {
  const defs = new Map(allPropDefs(forest).map((d) => [d.id, d]))
  const tags = tagsById(forest)
  const lookup = childPropsLookupOf(forest, blocksById)
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
    const waiting: FieldRow[] = []
    for (const row of rows.values()) {
      if (isGutterRow(row)) continue
      if (row.filled) visible.push(row)
      else waiting.push(row)
    }
    if (visible.length > 0) out.set(block.id, { rows: visible, pending: waiting.length, pendingRows: waiting })
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
  /** `select`：用途；只有 `status` 时这个勾选框同时是任务开关（划线/⌘↵） */
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
 * 只认库级唯一的**关闭态角色**（`_use: 'closure'` ＋ 合法 `_check`）：
 * 它是「这一行关闭了没有」的唯一答案，`⌘↵` 就是这个动作的快捷通道。
 *
 * ⚠️ **不退回普通两态字段**（无 `_use` 的 `_check`、布尔开关）：同一行可能有两个
 *    长得一样的方框，按「第一个」取就是一个用户看不见的优先级规则；`⌘↵` 一旦
 *    能切它们，「这一下切的是哪个」就没有可解释的答案。普通两态只由它自己那一下点击切。
 * ⚠️ 这里返回 `undefined` **不等于「什么都别做」**：调用方的人话是「这一行还不是任务 ⇒
 *    先把它变成任务（落核心任务状态，待办）」，与「第一次按 ⌘↵ 变成待办」同一手感。
 */
export function closureTargetField(fields: readonly GutterField[]): GutterField | undefined {
  return fields.find((f) => f.use === 'closure' && f.check !== undefined)
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
