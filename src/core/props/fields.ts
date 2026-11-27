/**
 * **字段声明表**：一个字段「是什么」只有这一份答案。
 *
 * 同一件事实从前散在九、十份清单里（可查白名单／字段下拉／值形表／显示名／读法／
 * 算子特判／值控件特判／选项域／记录投影／候选计划）。加一个字段要逐份补，漏一份的
 * 表现各不相同：下拉里有但求值不认、求值认但下拉没有、候选漏行、分组落「未设置」、
 * 值控件给出必然填错的入口。这里把它们收成**一行声明**，各处只做投影。
 *
 * ## 一条声明说的七件事
 *
 * | 字段 | 回答什么 | 消费面 |
 * |---|---|---|
 * | `label` / `kind` / `open` | 叫什么、值形、值域开不开 | 字段下拉、值控件、人话 chip |
 * | `default` / `ownerType` / `normalize` | 缺键读成什么（靠**类型声明**拥有这一栏的槽） | 求值读法、记录投影、候选计划 |
 * | `mandatory` | 读法恒声明（`exists:false` 可精确到空集） | 算子收窄、候选计划 |
 * | `store` | 值住在哪（属性行／块列／身份派生） | 候选计划（穷尽表，漏一支＝编译错） |
 * | `queryable` / `exposed` | 求值器认不认、进不进字段下拉 | `{prop}` 守卫、下拉 |
 * | `choices` | 选项域（静态表或**按库**现查的记录表） | 值控件、分组段头、chip |
 * | `read` | 值投影（缺省＝按 `ownerType` 的类型读法） | 两条求值路径共用 |
 *
 * ## 为什么读法不能「推导」
 *
 * 十个槽里有六个各自问**模型里的唯一判据**（`_date` 走 `journalDate`、`_tags` 只认
 * 活标签…），这些是每槽一段代码，不是表格能表达的。收益不是「消灭函数」，是让这段
 * 代码与它的名字/选项/算子/候选落点**住同一行**——补一个槽只动一处，而不是四处。
 *
 * ## 依赖方向
 *
 * 本模块只 import 模型/身份/基建叶子（外加 `props.ts` 的**类型**）：它不许 import
 * `query`、也不许 import `views`——查询和视图是它的消费者，不是它的上游。值域词汇
 * （类型表、语言表、引述类型表）住各自领域模块，这里只做 `{id,label}` 投影。
 */
import {
  ALIASES_PROP,
  CALLOUT_PROP,
  DEFAULT_BLOCK_TYPE,
  LANG_PROP,
  aliasesOf,
  blockTypeOf,
  isPropDefBlock,
  prop,
  type Block,
} from '../model/model.ts'
import { BELONGS_TO_PROP, isBelongsToRefs } from '../relations/hierarchy.ts'
import { TAGS_PROP, tagIdsOf } from '../identity/tags.ts'
import { journalDate } from '../identity/journal.ts'
import { CODE_TYPE, DIVIDER_TYPE, EMBED_TYPE, QUOTE_TYPE, TYPE_DECLS } from '../model/types.ts'
import { DEFAULT_CALLOUT, calloutGroupChoices, calloutTypesOf, type BlockLookup } from '../infra/callout.ts'
import { codeLangChoices, normalizeStoredLang } from '../infra/code-lang.ts'
import { t, type MsgId } from '../infra/msg.ts'
import type { PropKind } from './props.ts'

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

/** 引擎属性的值（块顶层字段）；不是引擎属性 ⇒ `undefined` */
export function enginePropValue(block: Block, propId: string): unknown {
  if (propId === ENGINE_CREATED) return block.created
  if (propId === ENGINE_MODIFIED) return block.modified
  return undefined
}

/* ------------------------------------------------------------ 声明 */

/** 读一格字段的结果：`declared` 说有没有这一栏，`value` 说值是什么 */
export interface FieldRead {
  declared: boolean
  value: unknown
}

/**
 * **值住在哪**（候选计划按它分派）。
 *
 * 这不是显示概念，是存储事实：候选只许用「与 `read` 同一投影能证明」的存储事实，
 * 证不了就退 `visible`。每个值对应候选层的一个既有计划族；`Record<FieldStore, …>`
 * 穷尽 ⇒ 新增一种落点会编译报错，而不是静默落回「全域」。
 */
export type FieldStore =
  /** `props[id]` 属性行（可叠加 `ownerType`：缺键＝按类型声明的缺省） */
  | 'prop'
  /** `Block.type` 列（缺键＝默认类型） */
  | 'type'
  /** 日记日期：身份派生（`{k:'journal'}` 一族） */
  | 'journal'
  /** 字段定义块（`_kind`） */
  | 'kind'
  /** 地址（`_aliases`） */
  | 'aliases'
  /** 标签归属（`_tags`） */
  | 'tags'
  /** 块顶层毫秒列（`core/created`／`modified`），候选收窄不了 */
  | 'column'

/** 选项域的一项（值存 id、显示现翻译；墓碑由 `format`/值控件决定说法） */
export interface FieldChoice {
  id: string
  label: string
}

/** 一条字段声明（系统槽的元数据；用户定义的属性另走定义块，但投影面相同） */
export interface SystemFieldDecl {
  id: string
  label: MsgId
  kind: PropKind
  store: FieldStore
  /**
   * **靠类型声明拥有这一栏**：只有这个类型的块答「有」，其余块答「没这一栏」；
   * 缺键读成 `default`。记录投影与候选计划都从这一格推，不再各写一条。
   */
  ownerType?: string
  /** 缺键读出来的值（`ownerType` 必须同时给：不然「缺键」没有语义） */
  default?: unknown
  /** 值归一（`ts` → `typescript`）：只改**读出来的值**，不改盘上的键 */
  normalize?: (value: string) => string | undefined
  /**
   * 选项域。**按库现查的记录表要收 `find`**——声明是模块级常量，词表是每库的，
   * 把解析结果缓存进声明就是第二份真相＋多库串味。
   */
  choices?: (find: BlockLookup | undefined) => readonly FieldChoice[]
  /** 值域开放：未知值照原文显示，不标「已删除」（读侧降级不改盘） */
  open?: true
  /** 读法恒声明：`exists:false` 可精确到空集，下拉也不必给这个死项 */
  mandatory?: true
  /** 求值器认（`{prop}` 的白名单；缺省不进） */
  queryable?: true
  /** 进字段下拉（前提：有值控件，即 `kind` 能画出控件且值域可填） */
  exposed?: true
  /** 读法（缺省＝`ownerType` 的类型读法） */
  read?: (block: Block, ctx: { liveTags: ReadonlySet<string> }) => FieldRead
}

const NOT_DECLARED: FieldRead = { declared: false, value: undefined }

/**
 * **类型拥有**的槽的读法：不是那种块 ⇒ 没这一栏；是 ⇒ 缺键读 `default`，再归一。
 *
 * `_callout`／`_lang` 共用这一条；下一个「靠类型声明拥有、缺键走缺省」的槽只加声明。
 */
function readTypeOwned(block: Block, decl: SystemFieldDecl): FieldRead {
  if (decl.ownerType === undefined || blockTypeOf(block) !== decl.ownerType) return NOT_DECLARED
  const raw = prop<unknown>(block, decl.id)
  const base = typeof raw === 'string' && raw !== '' ? raw : decl.default
  const normalized = decl.normalize !== undefined && typeof base === 'string' ? decl.normalize(base) : undefined
  return { declared: true, value: normalized ?? base }
}

/* ------------------------------------------------------------ 类型值的人话 */

/**
 * 块类型的值 → 人话（`TYPE_DECLS` 的封闭值域；值控件、chip、分组段头共用这一份；
 * 未知 id——别的版本或插件写进来的——原样显示）。
 *
 * 与 `TYPE_DECLS` 同一份键集：加一种块类型时这张表跟着长，`arch` 侧由声明完整性断言兜。
 */
const TYPE_VALUE_TEXT: Record<string, MsgId> = {
  [DEFAULT_BLOCK_TYPE]: 'ui.query.type.outline',
  [DIVIDER_TYPE]: 'ui.query.type.divider',
  [EMBED_TYPE]: 'ui.query.type.embed',
  [QUOTE_TYPE]: 'ui.query.type.quote',
  [CODE_TYPE]: 'ui.query.type.code',
}

export function typeValueLabel(id: string): string {
  const key = TYPE_VALUE_TEXT[id]
  return key ? t(key) : id
}

/* ------------------------------------------------------------ 声明表 */

/**
 * **系统槽的十行**。顺序＝字段下拉里系统节的出现顺序（`exposed` 的相对序即此），
 * 可查白名单只是 `queryable` 的过滤——两张清单从此不再各写一遍。
 *
 * 加一行之前先答：它有没有**值控件**（用户能不查文档填出值）？没有就只 `queryable`、
 * 不 `exposed`（`_tags` 的 `eq` 要标签块 id、`core/*` 是毫秒，塞进字段下拉只会得到
 * 「必然填错」的入口）；值是不是靠**类型**拥有（`ownerType`＋`default`）还是靠
 * 属性行（`store:'prop'`）——候选计划据此分派。
 */
export const SYSTEM_FIELDS: readonly SystemFieldDecl[] = [
  {
    id: '_date',
    label: 'ui.query.sysField.date',
    kind: 'date',
    store: 'journal',
    queryable: true,
    exposed: true,
    read: (block) => {
      const date = journalDate(block)
      return typeof date === 'string' && date !== '' ? { declared: true, value: date } : NOT_DECLARED
    },
  },
  {
    id: ALIASES_PROP,
    label: 'ui.query.sysField.aliases',
    kind: 'text',
    store: 'aliases',
    queryable: true,
    exposed: true,
    read: (block) => {
      const names = aliasesOf(block)
      return names.length > 0 ? { declared: true, value: names } : NOT_DECLARED
    },
  },
  {
    /**
     * `_type` 是**必答槽**：缺键＝默认类型（`blockTypeOf` 的读法）。
     * ⇒ `eq` 默认类型能命中没写过类型的块；`exists` 恒真（下拉不给这个死项）。
     *
     * `open:true`：未知 id 是别的版本/插件写进来的**合法数据**，值控件照原文显示，
     * 不标「已删除」——与读侧降级（画法按默认类型）是两件事。
     */
    id: '_type',
    label: 'ui.query.sysField.type',
    kind: 'select',
    store: 'type',
    default: DEFAULT_BLOCK_TYPE,
    mandatory: true,
    open: true,
    queryable: true,
    exposed: true,
    choices: () => Object.keys(TYPE_DECLS).map((id) => ({ id, label: typeValueLabel(id) })),
    read: (block) => ({ declared: true, value: blockTypeOf(block) }),
  },
  {
    /**
     * 只有引述块有这一栏；缺键＝缺省类型。值**原样读出**（自定义类型的 id 是数据）；
     * 「未知 id 显示成哪个名字」是显示层的事，查询不该把旧值改判成别的类型。
     *
     * 值域**不开放**：未知 id ＝ 类型被删了（记录带墓碑仍在表里，解析不到就是真没了），
     * 值控件显示「已删除」比假装它是某一型更诚实。
     */
    id: CALLOUT_PROP,
    label: 'ui.query.sysField.callout',
    kind: 'select',
    store: 'prop',
    ownerType: QUOTE_TYPE,
    default: DEFAULT_CALLOUT,
    queryable: true,
    exposed: true,
    choices: (find) => calloutGroupChoices(calloutTypesOf(find)),
  },
  {
    /**
     * 只有代码块有这一栏；缺键＝纯文本。
     *
     * ⚠️ 值走 **`normalizeStoredLang`**（认识的收成规范名、不认识的原文保留），不是
     * `canonicalLang`——后者是**渲染口径**，把 `zig` 收成 `plain`（不高亮）。用错它，
     * `eq:'plain'` 会命中 `_lang:'zig'`：屏幕写 zig、查询说纯文本。
     *
     * 值域开放：合法语言可以来自插件/新版本，未知值不是「选项被删了」。
     */
    id: LANG_PROP,
    label: 'ui.query.sysField.lang',
    kind: 'select',
    store: 'prop',
    ownerType: CODE_TYPE,
    default: 'plain',
    normalize: normalizeStoredLang,
    open: true,
    queryable: true,
    exposed: true,
    choices: () => codeLangChoices(),
  },
  {
    id: '_kind',
    label: 'ui.query.sysField.kind',
    kind: 'select',
    store: 'kind',
    queryable: true,
    read: (block) => (isPropDefBlock(block) ? { declared: true, value: block.props?._kind } : NOT_DECLARED),
  },
  {
    /**
     * 只认**能解析到块**的标签：屏幕上画出来的标签是这些，悬空的归属（标签进了回收站）
     * 不画。查询若不看这张表，就会出现「屏幕上一个标签都没有、查询却命中它」。
     */
    id: TAGS_PROP,
    label: 'ui.query.sysField.tags',
    kind: 'text',
    store: 'tags',
    queryable: true,
    read: (block, ctx) => {
      const ids = tagIdsOf(block).filter((id) => ctx.liveTags.has(id))
      return ids.length > 0 ? { declared: true, value: ids } : NOT_DECLARED
    },
  },
  {
    /**
     * 与 `_tags` 相反的理由：悬空上级在归属面板上是看得见的（待清理 chip），
     * 过滤成「只有活的」反而让 `exists` 比屏幕宽。
     */
    id: BELONGS_TO_PROP,
    label: 'ui.query.sysField.belongsTo',
    kind: 'text',
    store: 'prop',
    queryable: true,
    read: (block) => {
      const raw = block.props?.[BELONGS_TO_PROP]
      const ids = isBelongsToRefs(raw) ? (raw as string[]) : []
      return ids.length > 0 ? { declared: true, value: ids } : NOT_DECLARED
    },
  },
  {
    id: ENGINE_CREATED,
    label: 'ui.props.createdAt',
    kind: 'date',
    store: 'column',
    mandatory: true,
    queryable: true,
    read: (block) => ({ declared: true, value: block.created }),
  },
  {
    id: ENGINE_MODIFIED,
    label: 'ui.props.modifiedAt',
    kind: 'date',
    store: 'column',
    mandatory: true,
    queryable: true,
    read: (block) => ({ declared: true, value: block.modified }),
  },
]

const FIELD_BY_ID: ReadonlyMap<string, SystemFieldDecl> = new Map(SYSTEM_FIELDS.map((d) => [d.id, d]))

/** 系统的字段声明（`undefined` ＝ 不是系统槽：用户定义的属性走定义块） */
export function systemFieldOf(fieldId: string): SystemFieldDecl | undefined {
  return FIELD_BY_ID.get(fieldId)
}

/**
 * 系统槽的**选项域**（`undefined` ＝ 不是系统槽，或这个槽没有固定值域）。
 *
 * 两个消费面（字段值控件/条件树，分组段头/看板）都从这里取；`find` 交给按库现查的
 * 词汇表（引述类型），声明本身不缓存任何库里的东西。
 */
export function systemFieldChoices(propId: string, find?: BlockLookup): readonly FieldChoice[] | undefined {
  return systemFieldOf(propId)?.choices?.(find)
}

/** `{prop:{id}}` 可以问到的**系统槽白名单**（`queryable` 的投影） */
export const QUERYABLE_SYSTEM_PROPS: readonly string[] = SYSTEM_FIELDS.filter((d) => d.queryable === true).map((d) => d.id)

export function isQueryableSystemProp(propId: string): boolean {
  return systemFieldOf(propId)?.queryable === true
}

/**
 * 系统槽在**条件树里的显示名**（`undefined` ＝ 不是系统槽）。
 *
 * 条件树的下拉只列有值控件的字段，但条件可以由 JSON 写成、或由预设展开而来 ——
 * 那种行要能**如实显示**它问的是什么。没有这一份，白名单里的 id 会在树上被标成
 * 「属性已删除」：求值算它、界面说不存在。
 */
export function systemQueryFieldLabel(propId: string): string | undefined {
  const decl = systemFieldOf(propId)
  return decl === undefined ? undefined : t(decl.label)
}

/**
 * 系统槽的读法：**逐项问模型里的唯一判据**，不读 `props` 裸键。
 *
 * 为什么放在字段读法这一层：`exists`／`eq`／`empty` 三组算子都从 `readField` 拿
 * `{declared, value}`，两条求值路径（纯函数／索引）也共用它。系统槽若各走一条旁路，
 * 「有没有这一栏」就会有两份答案——那一族病（屏幕认、查询不认）已经修过一次。
 */
export function readSystemField(
  block: Block,
  propId: string,
  ctx: { liveTags: ReadonlySet<string> },
): FieldRead | undefined {
  const decl = systemFieldOf(propId)
  if (decl === undefined) return undefined
  return decl.read !== undefined ? decl.read(block, ctx) : readTypeOwned(block, decl)
}
