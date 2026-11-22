/**
 * **查询**：一个块要「显示哪些块」的声明。
 *
 * 三层分工，别混：
 *   · **条件**（本文件的 `QuerySpec`）——「选谁、按什么序」，写成 `canonical JSON` 存进块属性 `_query`；
 *   · **结果集**（`runQuery` 的输出）——一次**求值**，**冻结**的是「成员与顺序」；
 *   · **内容**——永远按 `block id` 现读现渲染（D5：集合冻、内容不冻）。
 *
 * ⚠️ 这里零 DOM、零持久化：求值只吃森林（指向边住在块内容里），所以能直接单测。
 * ⚠️ 接索引后本文件是**语义的唯一实现**：`evaluateQuery`（walk）与 `evaluateQueryIds`
 *    （候选迭代）共用同一份 matcher／`applySort`／回退判据；索引路径见 `index-port.ts`
 *    的 `queryByIndex`；`QuerySpec` 仍是那个 canonical JSON。
 */
import { hasList, isAutomationBlock, isJournalBlock, isPropDefBlock, isQueryBlock, type Block, type IdentityKind } from '../model/model.ts'
import { MARK_KINDS, normMarks, plainText, type Content, type Marks } from '../model/runs.ts'
import { walkForest } from '../model/walk.ts'
import { findPath } from '../model/tree.ts'
import { tagIdsOf, tagMemberIds } from '../identity/tags.ts'
import { membersOf } from '../identity/tag-tree.ts'
import { buildAdjacency, type Adjacency } from '../relations/hierarchy.ts'
import { dayStartMs, journalDate, journalDateInChain, journalDays, shiftISO } from '../identity/journal.ts'
import { displayTextOf } from '../identity/alias.ts'
import { fieldTableOf, isQueryableField, readField, type FieldTable } from '../props/props.ts'
import { isRefKind, relationEdgesOfForest, REFERENCE_KINDS, type RefKind, type RelationKind } from '../relations/relations.ts'
import { annotatesPairsOf } from '../relations/annotates.ts'
import { compareRanks } from '../infra/order.ts'
import type { KbClient } from '../kb/types.ts'

/**
 * 本地化字符串比较**只建一次**：旧写法在 `compareValues` 里每次比较都
 * `new Intl.Collator`（或传 options 的 `localeCompare`），排序 10k 命中时
 * 光构造 collator 就有几十万次。只读、无状态，模块级共享安全。
 */
const ZH_COLLATOR = new Intl.Collator('zh-Hans-CN', { numeric: true })

/* ------------------------------------------------------------ 条件形状 */

/**
 * 条件**原子**。够表达「反链」「某标签下的块」「某天之后改过的待办」这类常见诉求，
 * 且每一种都能用一次线性扫描算出来（不用索引）。
 *
 * ⚠️ **能用通用属性条件表达的，就别造专用键**：专用键每多一个，`canonicalSpec` 就要多一支，
 *    漏一处 = 条件存进 `_query` 时被静默丢掉（而丢掉的后果是「条件没变、结果却对不上」）。
 *
 * ⚠️ **待办没有专用键**：三态用属性条件就能写全 ——
 *    「不是任务」＝ `{prop:{id, exists:false}}`、「未完成」＝ `{prop:{id, eq:false}}`、
 *    「已完成」＝ `{prop:{id, eq:true}}`。曾经有一个 `{todo}` 原子，理由是「有槽未填」
 *    （屏幕上画着空心方框的块）用属性条件问不出来；那条理由的病根在**读通道**：
 *    判「有没有这一栏」只看了值，漏了 `_ownProps` 与**标签声明**。
 *    读侧归一之后（`core/props.ts` 的 `readField`）三态只剩一种写法，专用键就是第二份答案。
 *
 * 组合：`{ all: [...] }` / `{ any: [...] }` / `{ not: ... }`，可嵌套。
 * ⚠️ **不加 `mentions`**：未链接提及＝`text` 里出现某个词，那是全文检索的事，
 *    塞进这里会让「引用」与「文本匹配」变成同一个东西，反链语义当场糊掉。
 */
/**
 * `ref` 的值位：字符串＝默认的全部引用 kind；对象＝可收窄到某几类。
 *
 * `inline` 是正文里的 `[[ ]]` 与行内实例胶囊（`#名` 指向记录的那一枚），
 * `property` 是 `kind:'ref'` 的属性值，`embed` 是露面。
 * 标签归属**不在**这里：它是分类（`tag`），不是引用。
 */
export interface RefTarget {
  /** 目标块 id；**缺省＝不限目标**（「这块引用了别的东西」，`{ref}` 不指名） */
  to?: string
  kind?: RefKind | readonly RefKind[]
}

/**
 * 条件里的 ref 目标 id（字符串与对象两态只有一个读法）。
 * 不限目标（对象形态缺 `to`）⇒ `undefined`。
 */
export function refTargetOf(ref: string | RefTarget): string | undefined {
  return typeof ref === 'string' ? ref : ref.to
}

/** 条件里的 ref kind（缺省＝全部引用 kind） */
export function refKindsOf(ref: string | RefTarget): readonly RefKind[] {
  if (typeof ref === 'string') return REFERENCE_KINDS
  if (ref.kind === undefined) return REFERENCE_KINDS
  if (typeof ref.kind === 'string') return [ref.kind]
  return ref.kind
}

/**
 * **身份值域**（`{role}` 的封闭值域）。
 *
 * 一份常量，五处消费（AST 联合、`roleMatches`、条件树解析守卫、`TreeRow`、值下拉）
 * ——加一个值时要改的是**判据**，不是五张清单。缺一份的表现各不相同：少了守卫，
 * 条件树拆不动新值（退化成只读 JSON）；少了判据，行选得出来但恒不命中（更糟：不报错）。
 */
export const ROLE_KINDS = ['journal', 'page', 'tag', 'note', 'schema', 'query', 'automation'] as const
export type RoleKind = (typeof ROLE_KINDS)[number]

/**
 * 编译期集合断言：**外观面身份 ⊆ 查询值域**，且查询专有的差集恰好只有备注一格。
 *
 * 加一种身份却忘了让它可查 ⇒ 编译错；多出一种「不是身份的查询专有值」⇒ 也编译错
 * （要求显式决定它算不算身份）。
 *
 * ⚠️ 两条都是 `export` 的：`noUnusedLocals` 对未使用的 `type` 也报（TS6196），
 *    「导出的类型契约」是让断言留在编译期、又不引入运行时死代码的唯一办法。
 *    消费方就是编译器本身，没有运行时代码会 import 它们。
 */
export type Assert<T extends true> = T
export type QueryOnlyRole = Exclude<RoleKind, IdentityKind>
export type RoleKindsCoverIdentity = Assert<Exclude<IdentityKind, RoleKind> extends never ? true : false>
export type QueryOnlyRolesAreJustNote = Assert<
  Exclude<QueryOnlyRole, 'note'> extends never ? ('note' extends QueryOnlyRole ? true : false) : false
>

/** 是不是一个已知身份值（读侧对未知值降级成只读 JSON，不猜着拆） */
export function isRoleKind(v: unknown): v is RoleKind {
  return typeof v === 'string' && (ROLE_KINDS as readonly string[]).includes(v)
}

export type QueryNode =
  /**
   * 指向 `targetId` 的块（反链的最小形态：只认 id，不认 label）。
   *
   * **不限目标**（对象形态缺 `to`）＝「这块引用了别的东西」：存在任一条指定 kind 的
   * 出向引用边。它**不是恒真条件**——「有引用」是有意义的判定；kind 缺省三类全算
   * （inline／property／embed，与指名时同一口径）。正文里的 `#名` 按**目标身份**分两半：
   * 目标是标签类 ⇒ 分类提及（`tagMention` 边），「分类」的问题由 `{tag}` 原子答；
   * 目标是记录（行内实例胶囊）或普通块 ⇒ 就是引用（`inline` 边），与 `[[ ]]` 同一问。
   * 判据在 `relations.ts` 的边生成处，与渲染层 `refKindOf` 同一份目标身份读法。
   */
  | { ref: string | RefTarget }
  /**
   * 带某个标签的块：值是**标签块 id**（与 `{prop}` 同一条「键是 id」纪律——标签改名不影响查询语义）；
   * id 解析不到活着的标签块就是空集。
   *
   * 两态：字符串＝只算**直读**归属（存量查询的写法，语义不变）；
   * 对象＋`desc:true` ＝ **含子标签**（「算作」：沿下级标签展开成员）。
   * 同一个问题（「这个标签有哪些成员」）在库里有**一条**判据
   * （`identity/tag-tree.ts` 的 `membersOf`）；查询默认问的是更窄的那一问。
   */
  | { tag: string | { id: string; desc?: true } }
  /** 正文包含某串；**空串拒形**（contains 空串恒真，见 `isQueryNode`），对象形态＝「有正文」 */
  | { text: string | { nonempty: true } }
  /**
   * **有子级**（直接子块 ≥1，可见树口径与 `{down}` 同一条：属性定义的子树不进判定）。
   *
   * 只留真值档：`{children:false}` 与 `{not:{children:true}}` 是同一件事的两种字节，
   * 「叶子块」由 `not` 表达 —— 一个语义不许两种形状（与 `{ref}` 不限目标同一条判据：
   * 「没有子级」不是恒真条件，否定是有意义的判定，所以它归「非」那一格管）。
   * children 是结构事实不是属性槽，不进 `{prop}` 白名单——`_children` 会是第二份写法。
   */
  | { children: true }
  /**
   * 某属性**等于某值**，或**有没有这一栏**。
   *
   * 属性条件是**通用路径**：键是定义块的 id（不是名字），所以改显示名不影响查询语义；
   * 类型、日期这类身份位也是 `props` 里的槽，所以同一个条件能把它们都问到。
   * `Object.is` 让 `false` 与 `undefined`（未填）严格区分开。
   *
   * `eq` 与 `exists` **互斥**；同时给时按 `exists` 判（不猜）。
   * 「有没有这一栏」问的是 `core/props.ts` 的 `fieldDeclared`（值 ∪ 自有槽 ∪ 标签声明），
   * 不是「值键在不在」—— 后者会让标签声明的字段、面板刚加的空槽从查询里消失。
   *
   * ⚠️ **id 有守卫**（`core/props.ts` 的 `isQueryableField`）：只认属性定义块的 id
   *    与系统槽白名单（`_date`／`_kind`／`_type`／`_aliases`／`_tags`／
   *    `core/created`／`core/modified`）。系统槽逐项问模型判据，不读 `props` 裸键 ——
   *    否则 `exists` 会比模型宽（`_date: ''` 的块会被当成日记）。
   *
   * ⚠️ **布尔属性声明了就等于 `false`**（勾选框没有「未填」这一态）。所以
   *    `{prop:{id, eq:false}}` 命中「点了但没做完」，也命中「一次都没点过、靠标签声明的」。
   */
  | { prop: { id: string } & PropOp }
  /**
   * **就是这一块**（身份判定，不是成员判定）。
   *
   * 与 `ref` 的分工：`ref` 问「谁引用了它」，这一条问「它自己」。
   */
  | { is: string }
  /**
   * **存在一个祖先**满足这个条件（祖先链**不含自己**）。
   *
   * 方向是独立的一轴，不是另一种组：任意条件都能套进任意方向，
   * 所以「上级匹配所有／任一」「链条里匹配」不必各造一个组。
   * 「在某一天下面」＝ `{up:{all:[{role:'journal'},{prop:{id:'_date',eq:'2026-10-20'}}]}}`；
   * 天自己不会入选——它的祖先链里没有自己。
   */
  | { up: QueryNode }
  /** **存在一个子孙**满足这个条件（子树不含自己） */
  | { down: QueryNode }
  /** 自己／祖先／子孙 **任一处**满足这个条件 */
  | { near: QueryNode }
  /**
   * **（基准 ± offset）那一天的日记块**。相对日期：**存表达式，不存字面量** ——
   * 求值时现算，同一个「今天」隔天就是另一天（固化成 `'YYYY-MM-DD'` 的查询会悄悄说谎）。
   *
   * 判据与 `{prop:{id:'_date', eq:…}}` 同一条：块的 `_date`（journal 身份位）等于
   * 基准日偏移 `offset` 天。所以它包装进 `{up}` 就是「那一天之下的块」，
   * 可进 `any`／`not`，与方向原子照常正交——语言层不为「某天之下」再造第二种写法。
   *
   * ⚠️ 基准从哪来（系统今天／宿主那一天）不是条件的性质，进 `QueryContext.today`
   *    由调用方注入（§`resolveTodayBase`）；条件里没有它的位置，否则「今天」
   *    又要被固化进 `_query`。
   * ⚠️ 值域只有 `_date`：属性类型为日期的**普通字段**仍是绝对日期
   *    （`eq` 收表达式会把值位的字面量契约打破），先不做。
   */
  | { today: { offset: number } }
  /**
   * **是某种东西**的块本身（成员条件）。
   *
   * ⚠️ 与方向原子的分工写死：`{up}`／`{down}` 问的是**位置**（谁在谁下面），
   *    `{role:'journal'}` 问的是**身份**（这块是不是日记）。所以「某一天下面」
   *    不再是 `{journal:日期}`，而是 `{up:{all:[{role:'journal'},{prop:{_date,eq}}]}}`：
   *    方向与条件正交之后，它可进 `any`／`not`，也不偷换候选集。
   * ⚠️ 逐值分发到**既有唯一判据**，不另设第二份答案：journal 的判据只有「`_date` 在不在」，
   *    page／tag 的判据只有「`_lists` 里有没有对应露面」——身份由数据推出，查询问的就是这份判据。
   *    `tag` 的续支由日记的内置栏「当日新建」兑现（它要问「今天开的页或标签」）。
   *    `note`（备注）的判据只有「`_annotates` 在不在」——与日记同构，不认类型标记。
   *    `schema`／`query`／`automation` 是三种由数据派生的身份（`_kind`／`_query`／`_automation`）。
   *    ⇒ 备注可查但**不是身份块**，所以它是查询专有的一格（见文件头的断言）。
   */
  | { role: RoleKind }
  /**
   * **正文里存在一段带这组 marks 的内容**（run.marks ⊇ 给定键值，子集匹配）。
   *
   * 没指定的轴不参与判定——`{mark:{bg:'red'}}` 命中「有红底字的块」，不管它有没有
   * 同时加粗；与 `toggleMark` 的「一格」语义同一条人话。**子集不是全等**：
   * 全等会让「加粗的红字」从「红字」的查询里消失，那不是用户想问的。
   *
   * 参与判定的 run：text／ref／link（给引用加粗是真实格式）；asset 结构上不许带
   * marks（写入红线剥掉），天然不参与。实现＝一次线性扫描。
   *
   * ⚠️ **空 marks 恒真 ⇒ 形状校验拒绝**（`isQueryNode` 判 ill-formed、构建器不产空行）：
   *    `{mark:{}}` 命中全库，一条写歪的条件看起来像「这条条件成立」——同 `{prop}` id 守卫。
   * ⚠️ 与 `{text}` 是**两个独立的存在量化**：`{text:'X'}` ∧ `{mark:{bg}}` ≠ 「X 那段字带红底」
   *    （会伪命中「另一处有红底」的块）。同一段的组合语义将来扩 `{text}` 值位表达，
   *    不在这里造第二种写法。
   * ⚠️ marks 的 canonical 形状复用 `normMarks`（固定键序）——与 run 上的 marks 同一份
   *    归一化口径，`specKey` 与往返断言免费。
   */
  | { mark: Marks }
  /**
   * **正文里有外链 run**；`url` 给了比 contains（大小写不敏），缺省＝「有外链即可」。
   *
   * 「有外链」**不是恒真**（与 `{mark:{}}` 的空值恒真两回事），所以不需要守卫；
   * 但 `url:''` 是伪条件（空串 contains），`canonicalNode` 归一成不带 url。
   */
  | { link: { url?: string } }
  | { all: QueryNode[] }
  | { any: QueryNode[] }
  | { not: QueryNode }

/** 一个排序键：按**属性 id** 取值升/降序（与属性条件同一个理由：键是 id，改名不影响语义） */
/**
 * 属性条件上的**一个算子**（`{prop:{id}}` 与它组合）。
 *
 * 为什么是「一个算子」而不是「一串算子」：多个算子写在同一条上时，
 * `canonicalSpec` 要判 `and` 还是 `or`，而那个问题在**条件树**那一层已经有了答案
 * （`all`／`any`）。在这里再造一个组合层，等于让同一件事有两种写法。
 *
 * 九个算子分三组，语义各不同：
 *
 * | 组 | 算子 | 判据 |
 * |---|---|---|
 * | 值比较 | `eq`／`neq`／`contains`／`gt`／`gte`／`lt`／`lte` | **有这一栏**才比（没有就是不匹配） |
 * | 栏存在 | `exists` | 值 ∪ 自有槽 ∪ 标签声明（`false` ＝ 这块没有这一栏） |
 * | 空/非空 | `empty` | 值算不算空（`undefined`／`null`／`''`／`[]`） |
 *
 * ⚠️ `empty` 与 `exists` **必须分开**：文本字段「有这一栏、还没填」是前者的典型问法，
 *    「这块没有这一栏」是后者。合成一个算子，就再也问不出前者。
 * ⚠️ **布尔属性没有「未填」**：声明了就按 `false` 读（见 `core/props.ts` 的 `readField`）
 *    ⇒ 对它而言 `empty:true` 只剩「这块没有这一栏」一种命中（与 `exists:false` 同义）。
 * ⚠️ `neq` 只对**有这一栏**的块成立（与 `eq` 同一条口径）。「没有这一栏」也算「不等于」
 *    的话，`neq` 会突然变成「绝大多数块」，而那不是用户想问的。
 */
export type PropOp =
  | { eq: unknown }
  | { neq: unknown }
  /** 正文/值里含这一串（数组按任一元素判，其余按字符串化判） */
  | { contains: string }
  | { gt: unknown }
  | { gte: unknown }
  | { lt: unknown }
  | { lte: unknown }
  | { exists: boolean }
  | { empty: boolean }

export interface SortKey {
  by: string
  dir: 'asc' | 'desc'
  /** 只给 `by:'random'` 用：同一份种子 ⇒ 同一个「随机」序（成员顺序是冻结契约的一部分，每次刷新换一批就没法回访） */
  seed?: number
}

/**
 * 整个查询：条件 ＋ 顺序。
 *
 * ⚠️ **没有「范围」**：原 `scope`（这一块之下／全库）已并进方向轴——
 *    「这一块之下」＝条件 `{up:{is:'$self'}}`，「全库」＝没有这条。
 *    两条轴答同一件事必漂移，且方向条件能表达范围表达不了的东西
 *    （`{up:{tag:X}}`、`{not:{up:{is:X}}}`）。语义收窄一处：不再含锚块自己。
 *
 * ⚠️ **没有顶层 `todo`**，也**没有 `{todo}` 原子**：三态由属性条件表达
 *    （见 `QueryNode` 那一段）。曾经两种写法并存，于是同一条语义有两份表示，
 *    能同时写上并静默 AND —— 用户看到的是「条件就写了这一条，结果却像两条」。
 */
export interface QuerySpec {
  where: QueryNode
  /**
   * **成员顺序**：取哪些、按什么序（在 `limit` 之前生效）。
   *
   * ⚠️ 与「显示排序」是两件事：显示排序住在视图配置上（`ViewConfig.table.sort`），
   *    点表头只改当前这批成员的显示序，**不重查**。写 `_query.sort` 会让
   *    「按这一列排一下」变成「换一批行」。
   */
  sort?: SortKey[]
  /** 取多少条（在排序之后截断，所以「取最新的 3 天」取得到）；缺省不限 */
  limit?: number
  /**
   * `{today}` 原子的**基准从哪来**：缺省＝系统今天；`'host'`＝宿主那一天的 `_date`。
   *
   * 锚进 spec 而不进视图配置／设备状态：它改变的是**哪些块命中**（查询语义），
   * 与条件同一个拥有者（`_query`）——换台设备、换个看法，同一份查询的语义不该变。
   * 宿主不是日记块（查询块被搬到普通页）⇒ 按系统今天算（退回缺省语义，
   * 不撒谎也不空集；`$self` 的「永不命中」留给「会命中一切」的危险值，这里不是）。
   */
  todayFrom?: 'host'
}

/* ------------------------------------------------------------ 求值 */

/**
 * **查询上下文**：一次求值相对什么。三件事分开给，不许合并。
 *
 * | 字段 | 回答 |
 * |---|---|
 * | `selfId` | 条件里的 `'$self'` 指谁 |
 * | `excludeIds` | 结果里剔除谁 |
 * | `today` | `{today}` 原子的基准日（`'YYYY-MM-DD'`） |
 *
 * ⚠️ 为什么 `selfId` 不再顺带排除：那是两件事被塞进同一个字段的后果 ——
 *    想解析 `$self`，就不得不把它从结果里去掉；而「查询块自己不该出现在自己的结果里」
 *    与「宿主不该出现在挂载区里」是**各自独立**的两条规则，合并之后只能成对表达。
 * ⚠️ `today` 是**解析完的具体日期**，不是 `'host'` 那个开关：进冻结键的必须是
 *    「这一次求值相对哪天」——跨天之后冻结结果才算真过期。
 */
export interface QueryContext {
  selfId?: string
  excludeIds?: readonly string[]
  today?: string
}

/** 上下文的**稳定串**（冻结结果的判据之一；顺序无关 ⇒ 排序后再拼） */
export function contextKey(ctx: QueryContext): string {
  const ex = [...new Set((ctx.excludeIds ?? []).filter((x) => typeof x === 'string' && x !== ''))].sort()
  return JSON.stringify({ selfId: ctx.selfId ?? null, excludeIds: ex, today: ctx.today ?? null })
}

/**
 * 按上下文求值。**只读**：不写块、不改 `_query`。
 *
 * 走读门面（索引路径），调用方不必持有整片森林。
 */
export function evaluateQuerySpec(
  spec: QuerySpec,
  kb: Pick<KbClient, 'query'>,
  ctx: QueryContext,
): QueryHit[] {
  return kb.query(spec, { selfId: ctx.selfId, excludeIds: ctx.excludeIds, ...(ctx.today ? { today: ctx.today } : {}) })
}

export interface QueryRunInput {
  blocks: readonly Block[]
  /**
   * **宿主块**：条件里的 `'$self'` 按它解析。
   *
   * ⚠️ **它不再顺带把自己从结果里剔除** —— 那是 `excludeIds` 的事。
   *    曾经两件事都随这个字段而来，于是「想解析 `$self`，又不得不排除它」
   *    这种形状无法表达（挂载区的宿主不进结果是位置性质，查询块自己不进结果是
   *    另一条规则，两者曾经只能成对生效）。
   * 普通查询块不传它 ⇒ 条件里的 `$self` 解析不了 ⇒ 空结果（调用方给一行提示）。
   */
  selfId?: string
  /** 结果里剔除这些块（`selfId` 之外的独立一条） */
  excludeIds?: readonly string[]
  /**
   * `{today}` 原子的基准日（`'YYYY-MM-DD'`，本地日历）。
   *
   * 必须由调用方注入、不许在这里读时钟：求值是纯函数（同样输入同样输出），
   * 时钟进来「隔天同结果」就没法单测了（相对日期的验收第一条）。
   */
  today?: string
}

/** 一条结果：块 id ＋ 它在森林里的路径（D8：可编辑列表必须给上下文，否则不知道这条住哪） */
export interface QueryHit {
  blockId: string
  /** 从根到**父块**的祖先链（不含自己）；`[]` ＝ 顶层 */
  path: string[]
}

function walk(blocks: readonly Block[], fn: (b: Block, ancestors: Block[]) => void): void {
  walkForest(blocks, (b, ctx) => {
    /**
     * **属性定义的子树不是内容行**：它的子块是选项、选项的子块是说明 ——
     * 把其中任何一层当查询结果，等于把「这条属性能选什么」当成「库里有这几条内容」。
     *
     * 判据用**祖先链**（不含自己）：`walkForest` 的 visitor 返回 `undefined` 不会剪枝，
     * 只看直接父块会漏掉选项的子块。定义块自己**仍然可查** —— 它是一块有属性的块，
     * `_kind`／`_type` 这类通用属性条件是「哪些定义是日期」的唯一问法。
     */
    const ancestors = ctx.path.slice(0, -1)
    if (ancestors.some(isPropDefBlock)) return
    fn(b, ancestors)
  })
}

/**
 * 谓词环境：`ref`／`tag` 条件已经**按条件收好**的块集合。
 *
 * 为什么单独立一份：求值有两条路 —— 纯函数路径从森林收集，
 * 索引路径从 `IndexPort` 的表里查表；**判定与顺序只有一份**（`evaluateQuery`），
 * 两条路只许在「环境怎么来」上不同。
 */
export interface QueryEnv {
  /**
   * **引用条件的读面：按「目标」查，不按「整份 where」并集**。
   *
   * 从前这里是一个 `Set`（整份条件里所有 `{ref}` 目标的来源并集）——
   * 于是同一份条件出现两个不同目标时互相串味：`{all:[{ref:X},{not:{ref:Y}}]}`
   * 会拿「引用 X 或 Y 的块」当「引用 X 的块」，结果静默变空。
   * 现在判定读当前节点自己的目标（这一步），并集不存在了。
   *
   * 表按需建：`where` 里没有 `{ref}` 时给一个恒 `undefined` 的读面，一趟都不扫。
   */
  refSources: RefSources
  /**
   * `{ref}` **不限目标**的读面。表按需建：`where` 里没有「缺 `to` 的 `{ref}`」时缺省
   * ——缺省读面一个块都不命中（`NO_REF_FROMS`），不会静默放宽成「命中全库」。
   */
  refFroms?: RefFroms
  tags: ReadonlySet<string>
  /**
   * **标签原子直读主体**（事件引擎的 before/after 主体适配专用）：置位时 `{tag}` 判定
   * 读**传入块自己的标签账**，不查 `tags` 成员集。为什么要注入位：reactor 跑在索引修补
   * **之前**，走成员集读到的成员表是事务前的（after 侧会读到旧账）；而 before 侧的主体
   * 根本不在索引里，成员集对它永远为空。两种注入面（直读主体的账 vs 按成员集）是
   * **同一份判据的两个读源**——成员集本身也是从各块的标签账推出来的。
   */
  blockLocalTags?: true
  /**
   * **字段读取表**：判「这块有没有这一栏」要看标签声明与定义 kind，
   * 两条求值路径都必须给同一份（`core/props.ts` 的 `fieldTableOf`）。
   */
  fields: FieldTable
  /**
   * `{today}` 原子的基准日（调用方注入；缺省 ⇒ 相对日期不命中，不猜一个「今天」）。
   *
   * 它住在环境而不是条件里：基准是「这一次求值相对哪天」，同一份条件
   * 隔天该有另一份答案——写进条件就是又把今天固化了一遍。
   */
  today?: string
  /**
   * 结果里剔除这些块。
   *
   * 它不进 spec，因为「看不见自己」是**位置**的性质（挂在这一块下面、或这就是
   * 查询块自己），不是条件的性质：写进条件就成了「同一份条件换个地方求值结果不同」。
   *
   * ⚠️ 与 `selfId` 分开：那条只负责解析 `'$self'`，不再顺带排除。
   */
  excludeIds?: ReadonlySet<string>
}

/**
 * 引用条件的读面：**目标块 → （引用种类 → 来源块集合）**。
 *
 * 没有人指向它时返回 `undefined`（不是空 Map：一条边都没建过的目标不该在表里留格子）。
 * 返回的集合是**只读快照**，调用方不许改。
 */
export type RefSources = (targetId: string) => ReadonlyMap<RelationKind, ReadonlySet<string>> | undefined

/**
 * 「这块自己发过哪些 kinds 的引用边」——`{ref}` **不限目标**时的读面。
 * 与 `RefSources` 同一次扫描顺带建（纯函数路径）；索引路径按块懒查 `outgoing`。
 */
export type RefFroms = (blockId: string) => ReadonlySet<RelationKind>

/** 没有 `{ref}` 条件时的读面：一个块都不命中，且不建表 */
const NO_REF_SOURCES: RefSources = () => undefined

const NO_REF_FROMS: RefFroms = () => new Set()

/**
 * 条件里有没有 `{ref}`。两条求值路径都用它决定「要不要建引用表」——
 * 纯 `tag`／`text` 查询不该为引用条件付一次全林扫描。
 */
export function usesRef(node: QueryNode): boolean {
  if ('all' in node) return node.all.some(usesRef)
  if ('any' in node) return node.any.some(usesRef)
  if ('not' in node) return usesRef(node.not)
  if ('up' in node) return usesRef(node.up)
  if ('down' in node) return usesRef(node.down)
  if ('near' in node) return usesRef(node.near)
  return 'ref' in node
}

/**
 * 条件里有没有「**不限目标**的 `{ref}`」（对象形态缺 `to`）。
 * 两条求值路径都用它决定「要不要建出向表」——指名目标用入向表就够了。
 */
export function usesRefAny(node: QueryNode): boolean {
  if ('all' in node) return node.all.some(usesRefAny)
  if ('any' in node) return node.any.some(usesRefAny)
  if ('not' in node) return usesRefAny(node.not)
  if ('up' in node) return usesRefAny(node.up)
  if ('down' in node) return usesRefAny(node.down)
  if ('near' in node) return usesRefAny(node.near)
  return 'ref' in node && typeof node.ref !== 'string' && node.ref.to === undefined
}

/**
 * 森林里的引用边 → 引用条件的两张读面（按目标 ＋ 按来源）。**整片森林只扫一趟**，
 * 与 `relationEdgesOfForest` 同一份提取口径（正文引用／属性引用／嵌入都算引用）。
 */
function refTablesOfForest(forest: readonly Block[]): { sources: RefSources; froms: RefFroms } {
  const byTarget = new Map<string, Map<RelationKind, Set<string>>>()
  const byFrom = new Map<string, Set<RelationKind>>()
  for (const e of relationEdgesOfForest(forest).edges) {
    let perKind = byTarget.get(e.to)
    if (!perKind) {
      perKind = new Map()
      byTarget.set(e.to, perKind)
    }
    let froms = perKind.get(e.kind)
    if (!froms) {
      froms = new Set()
      perKind.set(e.kind, froms)
    }
    froms.add(e.from)
    let ks = byFrom.get(e.from)
    if (!ks) {
      ks = new Set()
      byFrom.set(e.from, ks)
    }
    ks.add(e.kind)
  }
  const empty: ReadonlySet<RelationKind> = new Set()
  return {
    sources: (targetId) => byTarget.get(targetId),
    froms: (blockId) => byFrom.get(blockId) ?? empty,
  }
}

/**
 * 谓词判定与**顺序**的唯一一份实现：按森林先序走，命中即收，
 * 有 `sort` 时按 spec 排序，最后按 `limit` 截断（先排序后截断——「取最新的 3 天」才取得到）。
 *
 * ⚠️ 顺序是契约的一部分（「冻结」保存的是输出的 `blockId[]`）：缺省按森林先序，
 *    索引的插入顺序在挪位之后会漂移，不能拿来当序；`sort` 是 spec 的一部分，
 *    同值时稳定排序保留森林先序。
 * ⚠️ `forest` 是**位置事实的来源**：候选集可以被 `roots` 收窄（锚点／范围），
 *    但 `{up}` 要看得见锚点上面的祖先、`{down}` 要看得见整棵子树——两者不是一回事。
 */
export function evaluateQuery(
  spec: QuerySpec,
  roots: readonly Block[],
  env: QueryEnv,
  forest: readonly Block[] = roots,
  /**
   * 可选**候选集**：必须是真命中的超集（如顶层单标签的成员集）。
   * 它只跳过不可能命中的块——顺序、真实祖先链、去重、`excludeIds` 仍由下面的 walk 决定。
   */
  candidates?: ReadonlySet<string>,
): QueryHit[] {
  const matcher = createMatcher(forest, env)
  const hits: { blockId: string; path: string[]; block: Block; ancestors: readonly Block[] }[] = []
  /** 收窄过的候选集里，同一块可能既当「后代」又当「候选根」被走到——一条结果只许出现一次 */
  const seen = new Set<string>()
  walk(roots, (b, ancestors) => {
    if (candidates && !candidates.has(b.id)) return
    if (env.excludeIds?.has(b.id)) return
    if (!matcher.matches(spec.where, b)) return
    if (seen.has(b.id)) return
    seen.add(b.id)
    hits.push({ blockId: b.id, path: ancestors.map((a) => a.id), block: b, ancestors })
  })
  applySort(hits, spec.sort, refCountNeeds(spec.sort) ? refTargetCounts(forest) : undefined)
  const size = typeof spec.limit === 'number' ? Math.max(0, spec.limit) : hits.length
  return hits.slice(0, size).map(({ blockId, path }) => ({ blockId, path }))
}

/** 这份排序要不要 `refCount`（全林边扫描）——两条求值路径各自决定从哪里取 */
export function refCountNeeds(sort: readonly SortKey[] | undefined): boolean {
  return sort?.some((s) => s.by === 'refCount') === true
}

/** 目标 → 指向它的边条数（现状口径：**全部关系边**，不只是引用；与 `inboundRefCount` 不同） */
function refTargetCounts(forest: readonly Block[]): ReadonlyMap<string, number> {
  const m = new Map<string, number>()
  for (const e of relationEdgesOfForest(forest).edges) m.set(e.to, (m.get(e.to) ?? 0) + 1)
  return m
}

/* ------------------------------------------------------------ 候选迭代 */

/**
 * 这份条件**只能按森林回答**：方向原子要真实祖先/子树，`children` 要子块表。
 *
 * 候选迭代的契约是「求值不碰森林」——所以整份 spec 只要出现其中任何一个，就整次回退
 * 全林（`evaluateQueryIds` 返回 `undefined`）。这比「只让这个原子不产出候选」更严：
 * 后者会让候选路径在 `all:[tag, {up:…}]` 里悄悄建一棵全库可见树，而 `candidateQueries`
 * 计数还在说「没走全林」。
 */
export function needsForestWalk(node: QueryNode): boolean {
  if ('all' in node) return node.all.some(needsForestWalk)
  if ('any' in node) return node.any.some(needsForestWalk)
  if ('not' in node) return needsForestWalk(node.not)
  if ('up' in node || 'down' in node || 'near' in node) return true
  return 'children' in node
}

/** 候选块的一站：块本体、真实祖先链（root→父）、逐层先序 rank（root→自己） */
export interface CandidateSite {
  block: Block
  ancestors: readonly Block[]
  ranks: readonly number[]
}

/**
 * 候选 id → 位置。三态，别合并：
 *   · `CandidateSite`：可见、链完整；
 *   · `null`：**确实不可见**（不存在／被软删）——它不是命中，跳过是确定的（walk 也不会走到它）；
 *   · `undefined`：可见却拼不出链／缺 rank —— 索引分叉，整次回退，不猜。
 */
export type CandidateLocator = (id: string) => CandidateSite | null | undefined

/**
 * **按候选 id 求值**：判定与顺序语义与 `evaluateQuery` 同一份，只是不遍历森林。
 *
 * 必须原样保留的四条（与 walk 路径逐条相等，测试钉住）：
 *   · 顺序：先按**真实先序 rank** 排（不是候选传入顺序），再 `sort`，最后 `limit`；
 *   · 路径：`QueryHit.path` 是真实 root→parent 链（候选块不能被当成 root）；
 *   · 属性定义的子树不是内容行——用真实祖先链判，不是看直接父块；
 *   · 去重与 `excludeIds`。
 *
 * 可见却定不了位 ⇒ 返回 `undefined`（整次回退），不返回半批结果；**确实不可见**的候选
 * （不存在／被软删）跳过——walk 也不会走到它，那不是「不知道」而是「确定不命中」。
 * `refCount` 排序与方向原子不接受（调用方先判 `needsForestWalk`／`refCountNeeds`）。
 */
export function evaluateQueryIds(
  spec: QuerySpec,
  ids: Iterable<string>,
  env: QueryEnv,
  locate: CandidateLocator,
): QueryHit[] | undefined {
  if (needsForestWalk(spec.where) || refCountNeeds(spec.sort)) return undefined
  const matcher = createMatcher(undefined, env)
  const rows: CandidateSite[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    if (env.excludeIds?.has(id)) continue
    const site = locate(id)
    if (site === undefined) return undefined
    if (site === null) continue
    // 与 `walk()` 同一条：祖先链里有属性定义块 ⇒ 这行不是内容行（定义块自己仍可命中）
    if (site.ancestors.some(isPropDefBlock)) continue
    if (!matcher.matches(spec.where, site.block)) continue
    rows.push(site)
  }
  rows.sort((a, b) => compareRanks(a.ranks, b.ranks))
  applySort(rows, spec.sort, undefined)
  const size = typeof spec.limit === 'number' ? Math.max(0, spec.limit) : rows.length
  return rows.slice(0, size).map((site) => ({
    blockId: site.block.id,
    path: site.ancestors.map((a) => a.id),
  }))
}

/**
 * 排序键可能不止一个：从最后一个键往前排，稳定排序让写在前面的键成为主键。
 *
 * 取值不只属性袋（保留键 H 批：能显示的列也要能排序）——`created`／`modified` 是块字段，
 * `refCount` 是关系事实（引用几处是这一刻的派生，不进属性袋）、一次扫描整林现算，
 * `random` 按 (块 id, 种子) 确定性散列——同一种子同一序，「随机抽 N 条」才回访得回来。
 * `_date` 读**所属的那一天**（`journalDateInChain`）：命中行自己不是日记时，
 * 它住在哪一天下面，那一天就是它的日志时间——只读自己的属性袋会让
 * 「按日志时间排」对日记下的块整体失效（全都取不到值 ＝ 等于没排）。
 * `path`／`matched`／`sharedTags` 仍未接：按什么比要先有语义（path 是深度还是链上名字？）。
 */
function applySort(
  hits: { block: Block; ancestors: readonly Block[] }[],
  sort: readonly SortKey[] | undefined,
  refCounts: ReadonlyMap<string, number> | undefined,
): void {
  if (!sort || sort.length === 0) return
  for (let i = sort.length - 1; i >= 0; i--) {
    const { by, dir, seed } = sort[i]!
    const sign = dir === 'desc' ? -1 : 1
    /**
     * **每个命中每键只算一次**：比较器会被调 O(n log n) 次，`sortValueOf` 里
     * `_date` 要爬祖先链、`random` 要哈希；逐次算等于把排序成本乘上比较次数。
     */
    const values = new Map<object, unknown>()
    const valueOf = (h: { block: Block; ancestors: readonly Block[] }): unknown => {
      if (values.has(h)) return values.get(h)
      const v = sortValueOf(h, by, seed, refCounts)
      values.set(h, v)
      return v
    }
    hits.sort((x, y) => {
      const xv = valueOf(x)
      const yv = valueOf(y)
      if (xv === undefined || yv === undefined) {
        if (xv === undefined && yv === undefined) return 0
        return xv === undefined ? 1 : -1
      }
      return sign * cmpValues(xv, yv)
    })
  }
}

/** 排序键的取值：属性键读属性袋，保留键读块字段与派生量（与保留列键同名同义） */
function sortValueOf(
  hit: { block: Block; ancestors: readonly Block[] },
  by: string,
  seed: number | undefined,
  refCounts: ReadonlyMap<string, number> | undefined,
): unknown {
  const b = hit.block
  if (by === 'created') return b.created
  if (by === 'modified') return b.modified
  if (by === 'refCount') return refCounts?.get(b.id) ?? 0
  if (by === 'random') return randomRankOf(b.id, seed)
  // 「不在任何一天下」＝缺槽（`undefined` ⇒ 排最后）；空串是值，会让 desc 把它排到最前
  if (by === '_date') {
    const d = journalDateInChain(b, hit.ancestors)
    return d === '' ? undefined : d
  }
  return b.props?.[by]
}

/**
 * (块 id, 种子) → 确定性伪随机序值（fnv-1a 的 32 位折叠）。
 *
 * 成员排序与视图显示排序**共用这一份**：两处各写一遍哈希，同一个「随机」在两个面
 * 就会给出两个顺序，而人只会以为其中一个是坏的。同一份种子 ⇒ 同一序——视图刷新、
 * 重开都不应把用户刚认过位置的那批卡重新洗一遍。
 */
export function randomRankOf(id: string, seed: number | undefined): number {
  let h = 2166136261 ^ (seed ?? 0)
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** 值的原生比较：数值按大小、其余按字符串序（`_date` 这类 ISO 串字典序即时间序）。异型值不做承诺 */
function cmpValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const sa = String(a)
  const sb = String(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

/**
 * 指向 `targetId` 的引用来源块（**一条指向边的另一端**，与渲染无关）。
 *
 * 与索引路径共用 `relationEdgesOfForest` 的提取口径：正文引用／属性引用／嵌入
 * 都算「引用」，标签归属与 `#名` 提及不算。纯函数路径是索引路径的参照实现。
 */
export function refSourceIds(
  forest: readonly Block[],
  targetId: string,
  kinds: readonly RefKind[] = REFERENCE_KINDS,
): Set<string> {
  const perKind = refTablesOfForest(forest).sources(targetId)
  const out = new Set<string>()
  for (const kind of kinds) for (const id of perKind?.get(kind) ?? []) out.add(id)
  return out
}

/**
 * 方向原子的求值器。
 *
 * `{up}`／`{down}`／`{near}` 把「条件」与「方向」拆成两轴之后，判定不再只关于这一块，
 * 而是关于「它和它的位置」：
 *   · `up` 需要祖先链（O(深度)，沿父指针向上）；
 *   · `down` 需要「子树里有没有」——**不许对每个候选块各走一遍子树**（那是 O(n²)）。
 *     这里按 (条件节点, 块) 记忆化：一次求值里每对只算一次，总量仍是 O(条件数 × 块数)。
 *
 * 「可见树」与 `walk` 同一口径：属性定义的子树不是内容行，不进祖先／子孙判定。
 * ⚠️ 记忆化以**条件节点对象**为键：同一份条件里两个写法相同的条件各算一次。
 *    条件树很小，这不是问题；拿结构串当键反而会把 `canonicalSpec` 的口径拖进来。
 */
interface Matcher {
  matches(node: QueryNode, block: Block): boolean
}

/**
 * 判定器。`forest` 只在条件含方向原子（`up`/`down`/`near`/`children`）时才用到；
 * **候选求值不传它**（`evaluateQueryIds` 已把这类形状挡掉）——结构上防止候选路径
 * 偷偷建一棵全库可见树。
 */
export function createMatcher(forest: readonly Block[] | undefined, env: QueryEnv): Matcher {
  /** 位置事实（祖先／子孙）**按需**建：纯 `tag`／`text` 查询不该为方向原子付一次全树遍历 */
  interface VisibleTree {
    byId: Map<string, Block>
    parentOf: Map<string, string | null>
    childrenOf: Map<string, Block[]>
  }
  let tree: VisibleTree | undefined
  const visibleTree = (): VisibleTree => {
    if (tree) return tree
    if (!forest) {
      // 内部不变量：候选求值必须先被 `needsForestWalk` 挡掉。走到这里说明守卫漏了
      throw new Error('candidate evaluation cannot build a visible tree')
    }
    const byId = new Map<string, Block>()
    const parentOf = new Map<string, string | null>()
    const childrenOf = new Map<string, Block[]>()
    walkForest(forest, (b, ctx) => {
      if (ctx.path.slice(0, -1).some(isPropDefBlock)) return
      byId.set(b.id, b)
      const parent = ctx.parent
      if (parent && byId.has(parent.id)) {
        parentOf.set(b.id, parent.id)
        const siblings = childrenOf.get(parent.id)
        if (siblings) siblings.push(b)
        else childrenOf.set(parent.id, [b])
      } else {
        parentOf.set(b.id, null)
      }
    })
    tree = { byId, parentOf, childrenOf }
    return tree
  }

  /** (节点 → 块 id → 判定)；`downMemo` 单列，理由同 `down` 的两趟：子树判定与自身判定不是一回事 */
  const hitMemo = new Map<QueryNode, Map<string, boolean>>()
  const downMemo = new Map<QueryNode, Map<string, boolean>>()
  /** 正在算的 (节点, 块)：挡条件树里的环（JSON 构造不出，代码直接构造可能） */
  const busy = new Set<string>()
  const nodeIds = new WeakMap<object, number>()
  let nextNodeId = 0
  const keyOf = (node: QueryNode, blockId: string): string => {
    let id = nodeIds.get(node)
    if (id === undefined) {
      id = nextNodeId
      nextNodeId += 1
      nodeIds.set(node, id)
    }
    return `${id}:${blockId}`
  }
  const readMemo = (
    memo: Map<QueryNode, Map<string, boolean>>,
    node: QueryNode,
    blockId: string,
  ): boolean | undefined => memo.get(node)?.get(blockId)
  const writeMemo = (
    memo: Map<QueryNode, Map<string, boolean>>,
    node: QueryNode,
    blockId: string,
    value: boolean,
  ): void => {
    const forNode = memo.get(node)
    if (forNode) forNode.set(blockId, value)
    else memo.set(node, new Map([[blockId, value]]))
  }

  /** 存在一个祖先满足条件（祖先链不含自己） */
  const hasAncestor = (node: QueryNode, blockId: string): boolean => {
    const { byId, parentOf } = visibleTree()
    let cur = parentOf.get(blockId) ?? null
    while (cur !== null) {
      const parent = byId.get(cur)
      if (parent && matches(node, parent)) return true
      cur = parentOf.get(cur) ?? null
    }
    return false
  }

  /** 存在一个子孙满足条件（子树不含自己） */
  const hasDescendant = (node: QueryNode, blockId: string): boolean => {
    const memoized = readMemo(downMemo, node, blockId)
    if (memoized !== undefined) return memoized
    const { childrenOf } = visibleTree()
    const key = `d${keyOf(node, blockId)}`
    if (busy.has(key)) return false
    busy.add(key)
    let hit = false
    for (const child of childrenOf.get(blockId) ?? []) {
      if (matches(node, child) || hasDescendant(node, child.id)) {
        hit = true
        break
      }
    }
    busy.delete(key)
    writeMemo(downMemo, node, blockId, hit)
    return hit
  }

  const matches = (node: QueryNode, block: Block): boolean => {
    const memoized = readMemo(hitMemo, node, block.id)
    if (memoized !== undefined) return memoized
    const key = `m${keyOf(node, block.id)}`
    if (busy.has(key)) return false
    busy.add(key)
    const result = compute(node, block)
    busy.delete(key)
    writeMemo(hitMemo, node, block.id, result)
    return result
  }

  const compute = (node: QueryNode, block: Block): boolean => {
    if ('all' in node) return node.all.every((n) => matches(n, block))
    if ('any' in node) return node.any.some((n) => matches(n, block))
    if ('not' in node) return !matches(node.not, block)
    if ('is' in node) return block.id === node.is
    if ('up' in node) return hasAncestor(node.up, block.id)
    if ('down' in node) return hasDescendant(node.down, block.id)
    if ('near' in node) {
      return matches(node.near, block) || hasAncestor(node.near, block.id) || hasDescendant(node.near, block.id)
    }
    if ('role' in node) return roleMatches(node.role, block)
    /**
     * 相对日期：与 `{prop:{id:'_date',eq}}` 同一条判据（`_date` 等于基准偏移 `offset` 天），
     * 只是值**现算**。没有基准（调用方没注入）⇒ 不命中——猜一个「今天」
     * 等于把时钟偷偷接回求值器，隔天同结果的验收就没法写了。
     */
    if ('today' in node) {
      return env.today !== undefined && journalDate(block) !== '' && journalDate(block) === shiftISO(env.today, node.today.offset)
    }
    /**
     * 引用条件：**按当前节点自己的目标与 kind** 查表。
     *
     * 不读「整份 where 的并集」——那会让两个不同目标互相串味
     * （`{all:[{ref:X},{not:{ref:Y}}]}` 曾静默变空）。
     */
    if ('ref' in node) {
      const kinds = refKindsOf(node.ref)
      const to = refTargetOf(node.ref)
      // 指名目标：按当前节点自己的目标查入向表，不读「整份 where 的并集」
      if (to !== undefined) {
        const perKind = env.refSources(to)
        if (!perKind) return false
        return kinds.some((kind) => perKind.get(kind)?.has(block.id) === true)
      }
      // 不限目标：这块自己发过任一指定 kind 的出向边。环境没给读面 ⇒ 不命中
      //（调用方按 usesRefAny 接表；缺省读面恒空，不静默放宽成「命中全库」）
      const froms = env.refFroms?.(block.id) ?? NO_REF_FROMS(block.id)
      return kinds.some((kind) => froms.has(kind))
    }
    /**
     * 标签条件：**按边判定**，不扫文本。
     *
     * 标签＝指向标签块的边，判定只在 `core/tags.ts` 里发生（`tagMemberIds`）。
     * 不要在正文上再扫一遍 `#tag`：那会得到「看起来是标签的文本」与「真的是一条边」
     * 两套答案 —— 两条路径对同一个块说法不一，改名也不同步。
     * 名字→标签块只解析一次（`collectTags`），不在逐块判定里查，
     * 否则一次查询会退化成 O(块数 × 条件数) 次森林遍历。
     */
    if ('tag' in node) {
      // 直读注入位：触发器主体的标签账（before 快照／刚写完的活块）是此刻的事实，
      // 索引成员表在这两个时刻都不可信（见 QueryEnv.blockLocalTags 的说明）
      if (env.blockLocalTags === true) return tagIdsOf(block).includes(typeof node.tag === 'string' ? node.tag : node.tag.id)
      return env.tags.has(block.id)
    }
    /**
     * 正文条件：字符串＝包含（投影坐标，原子不占格）；对象形态＝「有正文」——
     * `plainText` 去空白后非空。只有图没有字不算（「正文」这个词问的是字，
     * 问 asset 是另一轴，等真实问法出现再立，不预造）。
     */
    if ('text' in node) {
      if (typeof node.text === 'string') return plainText(block.content).includes(node.text)
      return plainText(block.content).trim() !== ''
    }
    /**
     * 有子级：可见树按需建（与 `{up}`/`{down}` 共用同一份——纯 tag/text 查询
     * 不为它付一次全树遍历）。直接子块，不含孙：那是「有子级」的字面意思，
     * 「子树里有东西」由 `{down}` 答，两条不混。
     */
    if ('children' in node) return (visibleTree().childrenOf.get(block.id)?.length ?? 0) > 0
    if ('mark' in node) return contentHasMarks(block.content, node.mark)
    if ('link' in node) return contentHasLink(block.content, node.link.url)
    if ('prop' in node) {
      /**
       * **守卫**：`{prop}` 只认两种 id —— 属性定义块的 id，或系统槽白名单
       * （`core/props.ts` 的 `isQueryableField`，与构建器的字段下拉同源）。
       *
       * 不认的 id **一个块都不命中**。从前它按 `props` 裸键判：`exists:false` 会命中全库，
       * 于是一个拼错的名字看起来像「这条条件成立」。而条件读不出来时用户只在结果上
       * 看到「数量不对」，没有任何线索指向那条属性。
       *
       * ⚠️ 不认的 id 在条件树里显示成「属性已删除」（`ui.query.fieldMissing`）；
       *    `not` 包着它仍会成立（否定一个无效条件在二值逻辑里就是真），所以文案要说清
       *    是「这条问的属性不在了」，而不是让用户以为是数据问题。
       */
      const op = node.prop
      if (!isQueryableField(op.id, env.fields)) return false
      /**
       * 先问「有没有这一栏」（值 ∪ 自有槽 ∪ 标签声明），再决定比值、比存在性、还是判空。
       *
       * 这样 `eq: false` 与「没有这一栏」是两件事，`eq: undefined` 也不会误命中所有块；
       * 而「面板刚加的槽」与「靠标签声明拿到的字段」都被算成有 —— 它们屏幕上有方框。
       * **值比较这一类（含 `neq`）只对「有这一栏」的块成立** —— 否则 `neq`
       * 会变成「绝大多数块」，而用户想问的是「这些值不是 A 的那几条」。
       */
      const { declared, value: v } = readField(block, node.prop.id, env.fields)
      if ('exists' in op) return declared === op.exists
      if ('empty' in op) return isEmptyValue(v) === op.empty
      if (!declared) return false
      /**
       * 多值字段的 `eq`/`neq` 按**包含**判（数组里有没有这一项）：
       * 一个块可以选多个值，「等于」在用户眼里就是「其中一个是我要的」。
       * 这不是新算子——同一个 `eq` 在单值上是相等、在多值上是包含，
       * 由值形态决定，条件语言不需要为多值再分一套。
       */
      if ('eq' in op) return Array.isArray(v) ? v.some((x) => Object.is(x, op.eq)) : Object.is(v, op.eq)
      if ('neq' in op) return Array.isArray(v) ? !v.some((x) => Object.is(x, op.neq)) : !Object.is(v, op.neq)
      if ('contains' in op) return valueContains(v, op.contains)
      // 比较前先把相对界解析成毫秒（没有基准 ⇒ 不命中，见 resolveRelOps）
      const bounded = resolveRelOps(op, env.today)
      if (bounded === undefined) return false
      return compareOp(v, bounded)
    }
    // 形状不认识（例如旧库里存过的已删原子）⇒ 不命中，不抛。
    // 库里存的那份由 `readSpec` 先验形；能走到这里说明是调用方直接构造的 spec。
    return false
  }

  return { matches }
}

/**
 * role 逐值分发到**既有唯一判据**（与 `identityTags` 调同一批叶子，不造第二份答案）。
 *
 * `Record<RoleKind, …>` 而不是 if 链：if 链 ＋ `return false` 兜底时，加一个值而忘了
 * 补分支**不会报错**——那一格恒不命中，屏幕只表现为「查询结果不对」。收成表之后，
 * 漏一支是编译错误。
 */
const ROLE_MATCHERS: Record<RoleKind, (b: Block) => boolean> = {
  journal: isJournalBlock,
  page: (b) => hasList(b, 'page'),
  tag: (b) => hasList(b, 'tag'),
  note: (b) => annotatesPairsOf(b).length > 0,
  schema: isPropDefBlock,
  query: isQueryBlock,
  automation: isAutomationBlock,
}

/**
 * 判据分发。
 *
 * ⚠️ 参数收 `string` 而不是 `RoleKind`：AST 声明它一定是 `RoleKind`，但**运行时不一定**——
 * 用户库里的旧 JSON、手写 JSON、别的版本写进来的值都能通过读入校验（`isQueryNode`
 * 只判「是字符串」）。不收窄读入校验是刻意的：一个坏值不该让整份条件读不出来。
 * 所以守卫**收在求值侧**：未知值一律不命中，不抛。
 */
function roleMatches(role: string, b: Block): boolean {
  if (!isRoleKind(role)) return false
  return ROLE_MATCHERS[role](b)
}

/**
 * 值算不算「空」。
 *
 * 与 `exists` 分开：对**文本类**字段，`empty:true` 匹配「有这一栏但没有值」**和**
 * 「根本没有这一栏」，而 `exists:false` 只匹配后者 —— 这是两个真问题。
 * 对**布尔**属性不成立：声明了就按 `false` 读，所以 `empty:true` 只剩「没有这一栏」一种命中。
 */
function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null || v === '') return true
  return Array.isArray(v) && v.length === 0
}

/** 含这一串：数组按**任一元素**判（多值字段的常见问法），其余按字符串化判 */
function valueContains(v: unknown, needle: string): boolean {
  const want = needle.toLowerCase()
  if (want === '') return false
  if (Array.isArray(v)) return v.some((x) => String(x).toLowerCase().includes(want))
  return String(v).toLowerCase().includes(want)
}

/**
 * 正文里有没有一段 run 的 marks **盖住** `want`（子集匹配：没指定的轴不参与）。
 * ref/link 的 marks 算数（真实格式）；asset 结构上没有 marks，跳过不是特判。
 */
function contentHasMarks(content: Content, want: Marks): boolean {
  for (const r of content) {
    if (r.t === 'asset') continue
    const m = r.marks
    if (!m) continue
    let covered = true
    for (const k of MARK_KINDS) {
      const w = want[k]
      if (w === undefined) continue
      if (m[k] !== w) {
        covered = false
        break
      }
    }
    if (covered) return true
  }
  return false
}

/** 正文里有没有外链 run；`url` 给了（非空）比 contains，大小写不敏 */
function contentHasLink(content: Content, url: string | undefined): boolean {
  const want = url === undefined ? '' : url.toLowerCase()
  for (const r of content) {
    if (r.t !== 'link') continue
    if (want === '' || r.url.toLowerCase().includes(want)) return true
  }
  return false
}

/**
 * 大小比较的**相对界**：值位可以是 `{rel:{days}}`——本地「今天」零点 ± N 天的毫秒。
 * 与 `{today}` 原子同一条原则：**存表达式不存字面量**，否则「最近 7 天」隔天就说谎。
 * 没有基准（`env.today` 没注入）⇒ 整条不命中：猜一个今天，等于把时钟偷偷接回求值器。
 */
type CmpOp = { gt?: unknown; gte?: unknown; lt?: unknown; lte?: unknown }
function resolveRelOps(op: PropOp, today: string | undefined): CmpOp | undefined {
  const rel = (x: unknown): number | undefined =>
    x !== null && typeof x === 'object' && 'rel' in (x as Record<string, unknown>)
      ? (x as { rel?: { days?: unknown } }).rel?.days as number | undefined ?? undefined
      : undefined
  const hasRel = ['gt', 'gte', 'lt', 'lte'].some((k) => rel((op as Record<string, unknown>)[k]) !== undefined)
  if (!hasRel) return op as CmpOp
  if (today === undefined) return undefined
  const ms = (x: unknown): unknown => {
    const days = rel(x)
    return days === undefined ? x : dayStartMs(shiftISO(today, Math.trunc(days)))
  }
  const out = op as Record<string, unknown>
  return {
    ...op,
    ...('gt' in out ? { gt: ms(out.gt) } : {}),
    ...('gte' in out ? { gte: ms(out.gte) } : {}),
    ...('lt' in out ? { lt: ms(out.lt) } : {}),
    ...('lte' in out ? { lte: ms(out.lte) } : {}),
  }
}

/**
 * `gt`／`gte`／`lt`／`lte`。
 *
 * 数值按数值比（**不退化成字典序**：那样 10 会排在 9 前面），其余按字符串比。
 * 一边是数字一边不是 ⇒ 按字符串比（属性值可能是 `"3"` 这种旧输入遗留）。
 */
function compareOp(v: unknown, op: { gt?: unknown; gte?: unknown; lt?: unknown; lte?: unknown }): boolean {
  const bound = 'gt' in op ? op.gt : 'gte' in op ? op.gte : 'lt' in op ? op.lt : op.lte
  const cmp = compareValues(v, bound)
  // 比不了（类型不在同一个量纲上）⇒ **不匹配**：`true > 5` 不是一个有意义的答案，
  // 而按字符串比会给它一个（`'true' > '5'`），于是勾选框会出现在「评分大于 5」的结果里。
  if (cmp === null) return false
  if ('gt' in op) return cmp > 0
  if ('gte' in op) return cmp >= 0
  if ('lt' in op) return cmp < 0
  return cmp <= 0
}

/**
 * 两个值比大小：两边都是数字按数值、都是字符串按本地化序；**其余返回 `null`（比不了）**。
 *
 * 与 `view.ts` 的 `compareAny` 同形不合并：那边「比不了」也得给个数（显示排序总要有个先后），
 * 这边 `null` 是**契约**——查询拿它判「不匹配」（`true > 5` 不是有意义的结果，不能给数）。
 */
function compareValues(a: unknown, b: unknown): number | null {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  // 属性值可能是 `"3"` 这种旧输入遗留：一边是数字串也按数值比
  if (typeof a === 'string' && typeof b === 'string') {
    return ZH_COLLATOR.compare(a, b)
  }
  if (typeof a === 'number' && typeof b === 'string' && b.trim() !== '' && !Number.isNaN(Number(b))) {
    return a - Number(b)
  }
  if (typeof b === 'number' && typeof a === 'string' && a.trim() !== '' && !Number.isNaN(Number(a))) {
    return Number(a) - b
  }
  return null
}

/**
 * where 的**顶层**就是 `{ role: 'journal' }` 本身（日记流形态）。
 *
 * 只有这个形态允许把候选集换成「库里有哪些天」：**一天一个**是身份口径
 * （坏数据里同一天多块时只取先序第一个，与 `journalDays` 同源），不是范围。
 * 嵌进组合里的 role 是普通谓词，收窄会把其它分支的候选丢掉
 * （比如 `{ not: { role: 'journal' } }` 恰恰要非天的块）。
 */
export function isExactRoleJournal(node: QueryNode): boolean {
  return 'role' in node && node.role === 'journal'
}

/** 属性条件上认得的算子（验形与 `PropOp` 保持同一张表） */
const PROP_OP_KEYS = ['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'exists', 'empty'] as const

/**
 * 落盘/外部送进来的条件**读不读得出来**。
 *
 * 为什么要验：条件语言的形状会变（例如 `{todo}` 原子退场）。旧字节里留着已删的原子时，
 * 求值器只能「不命中」——界面上看起来只是「没有结果」，没有任何线索指向条件。
 * 验形之后，调用方可以把这句话说出来（`readSpec` 返回 `null` ⇒ 那一栏走空态提示），
 * 而不是让一条读不懂的条件悄悄变成空集。
 *
 * ⚠️ 只判**形状**，不判语义：未知的实参值（如 `{role:'page'}`）先放行，由 `roleMatches`
 *    给「不命中」——将来扩值域时不至于把旧条件整条作废。
 * ⚠️ `{prop}` 里有多个算子时放行（求值按 `exists` 优先，见 `PropOp` 的注释）：
 *    那是一条写歪的条件，但它是**读得懂**的，不该被当成「坏了」。
 */
export function isQueryNode(raw: unknown): raw is QueryNode {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const n = raw as Record<string, unknown>
  if ('all' in n) return Array.isArray(n.all) && n.all.every(isQueryNode)
  if ('any' in n) return Array.isArray(n.any) && n.any.every(isQueryNode)
  if ('not' in n) return isQueryNode(n.not)
  if ('is' in n) return typeof n.is === 'string' && n.is !== ''
  if ('up' in n) return isQueryNode(n.up)
  if ('down' in n) return isQueryNode(n.down)
  if ('near' in n) return isQueryNode(n.near)
  if ('today' in n) {
    const t = n.today as { offset?: unknown } | null | undefined
    return !!t && typeof t === 'object' && !Array.isArray(t) && typeof t.offset === 'number'
  }
  if ('ref' in n) {
    if (typeof n.ref === 'string') return true
    const r = n.ref
    if (!r || typeof r !== 'object' || Array.isArray(r)) return false
    const ref = r as Partial<RefTarget>
    if (ref.to !== undefined && (typeof ref.to !== 'string' || ref.to === '')) return false
    if (ref.kind === undefined) return true
    if (typeof ref.kind === 'string') return isRefKind(ref.kind)
    return Array.isArray(ref.kind) && ref.kind.every((k) => isRefKind(k))
  }
  /**
   * 标签条件两态：字符串＝**只算直读**（存量写法不变）；对象＝带 `desc:true` 的
   * 「含子标签」（算作，与同类栏／引用候选同一份闭包）。只认这一个键，未知键拒形——
   * 「写歪了但看起来成立」的条件比没写更危险。
   */
  if ('tag' in n) {
    if (typeof n.tag === 'string') return true
    const tg = n.tag
    if (!tg || typeof tg !== 'object' || Array.isArray(tg)) return false
    const keys = Object.keys(tg)
    if (keys.some((k) => k !== 'id' && k !== 'desc')) return false
    const obj = tg as { id?: unknown; desc?: unknown }
    if (typeof obj.id !== 'string' || obj.id === '') return false
    return obj.desc === undefined || obj.desc === true
  }
  /**
   * 正文条件两态：字符串＝包含，**空串拒形**（`includes('')` 恒真——一条写歪的条件
   * 看起来像「这条条件成立」，与 `{mark:{}}` 同一条守卫；「有正文」有对象形态，不用它）；
   * 对象＝「有正文」，只认 `{nonempty:true}` 这一个形状。
   */
  if ('text' in n) {
    if (typeof n.text === 'string') return n.text !== ''
    return !!n.text && typeof n.text === 'object' && !Array.isArray(n.text) && (n.text as { nonempty?: unknown }).nonempty === true
  }
  if ('children' in n) return n.children === true
  /**
   * `{mark}`：键必须是已知的 mark 键、值轴必须是合法槽名，且**归一化后非空**——
   * 空 marks 恒真（命中全库），一条写歪的条件看起来像「这条条件成立」。
   */
  if ('mark' in n) {
    const m = n.mark
    if (!m || typeof m !== 'object' || Array.isArray(m)) return false
    return normMarks(m as Marks) !== undefined
  }
  if ('link' in n) {
    const p = n.link
    if (!p || typeof p !== 'object' || Array.isArray(p)) return false
    const l = p as { url?: unknown }
    return l.url === undefined || typeof l.url === 'string'
  }
  if ('role' in n) return typeof n.role === 'string'
  if ('prop' in n) {
    const p = n.prop
    if (!p || typeof p !== 'object' || Array.isArray(p)) return false
    const op = p as Record<string, unknown>
    if (typeof op.id !== 'string' || op.id === '') return false
    return PROP_OP_KEYS.some((k) => k in op)
  }
  return false
}

/** 一整份条件读不读得出来（`where` 是必填；`sort`／`limit` 只判形状） */
export function isQuerySpec(raw: unknown): raw is QuerySpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const s = raw as Record<string, unknown>
  if (!isQueryNode(s.where)) return false
  if (s.limit !== undefined && typeof s.limit !== 'number') return false
  if (s.todayFrom !== undefined && s.todayFrom !== 'host') return false
  if (s.sort !== undefined) {
    if (!Array.isArray(s.sort)) return false
    for (const k of s.sort) {
      if (!k || typeof k !== 'object') return false
      const key = k as Record<string, unknown>
      if (typeof key.by !== 'string' || (key.dir !== 'asc' && key.dir !== 'desc')) return false
    }
  }
  return true
}

/**
 * 条件的**canonical 形状**：键序固定、同一语义只有一种写法。
 *
 * 为什么单一来源：`_query` 与视图切片（`_views[].filter`）都要进 KB、都要能比较
 * 「条件变没变」（冻结的 `specKey` 就是它）。两份 canonical 会让同一份条件的键序
 * 随对象字面量写法漂移，于是「改一次写的顺序」就被判成「条件变了」。
 *
 * ⚠️ **每一种 `QueryNode` 都要在这里有一支**，否则存进 `_query`／`_views` 时会被静默丢掉。
 *    丢掉的后果不是报错，而是「条件看起来没变、结果却对不上」——所以这一支必须与
 *    上面的联合类型逐条对齐，加一个新原子时两处一起加。
 */
export function canonicalNode(n: QueryNode): QueryNode {
  if ('all' in n) return { all: n.all.map(canonicalNode) }
  if ('any' in n) return { any: n.any.map(canonicalNode) }
  if ('not' in n) return { not: canonicalNode(n.not) }
  if ('ref' in n) {
    if (typeof n.ref === 'string') return { ref: n.ref }
    const kinds =
      n.ref.kind === undefined
        ? undefined
        : [...new Set(typeof n.ref.kind === 'string' ? [n.ref.kind] : n.ref.kind)].sort()
    return {
      ref: {
        ...(n.ref.to === undefined ? {} : { to: n.ref.to }),
        ...(kinds === undefined ? {} : { kind: kinds }),
      },
    }
  }
  if ('tag' in n) {
    // 对象形态只在 `desc:true` 时保留（canonical：缺省不带 `desc`），其余压回字符串——
    // 同一个语义不许两种字节，`specKey` 靠这条判「条件变了没有」
    if (typeof n.tag === 'string') return { tag: n.tag }
    return n.tag.desc === true ? { tag: { id: n.tag.id, desc: true } } : { tag: n.tag.id }
  }
  if ('text' in n) return typeof n.text === 'string' ? { text: n.text } : { text: { nonempty: true } }
  if ('children' in n) return { children: true }
  if ('mark' in n) return { mark: normMarks(n.mark) ?? {} }
  if ('link' in n) return n.link.url ? { link: { url: n.link.url } } : { link: {} }
  /**
   * 属性条件**逐算子原样带走**，不补默认值（补了两种写法就不再等价）。
   *
   * ⚠️ 每加一个算子，这里必须加一支：漏掉的那一支会被静默丢掉，
   *    表现是「条件看起来没变、结果却对不上」。
   */
  if ('prop' in n) {
    const { id } = n.prop
    const op = n.prop
    if ('exists' in op) return { prop: { id, exists: op.exists } }
    if ('empty' in op) return { prop: { id, empty: op.empty } }
    if ('eq' in op) return { prop: { id, eq: op.eq } }
    if ('neq' in op) return { prop: { id, neq: op.neq } }
    if ('contains' in op) return { prop: { id, contains: op.contains } }
    if ('gt' in op) return { prop: { id, gt: op.gt } }
    if ('gte' in op) return { prop: { id, gte: op.gte } }
    if ('lt' in op) return { prop: { id, lt: op.lt } }
    return { prop: { id, lte: op.lte } }
  }
  if ('is' in n) return { is: n.is }
  if ('up' in n) return { up: canonicalNode(n.up) }
  if ('down' in n) return { down: canonicalNode(n.down) }
  if ('near' in n) return { near: canonicalNode(n.near) }
  if ('today' in n) return { today: { offset: n.today.offset } }
  return { role: n.role }
}

/**
 * 空字段表：条件里没有 `{prop}` 也没有 `$self` 时用它。
 *
 * 只读（消费者只查不改）；不共享可变状态——各 Map/Set 都是空容器，
 * 即便有人误写也只会写进这一次求值的空表。
 */
const EMPTY_FIELD_TABLE: FieldTable = {
  byTag: new Map(),
  liveTags: new Set(),
  kinds: new Map(),
  defaults: new Map(),
  byUse: new Map(),
  cardinality: new Map(),
}

/**
 * 求值一次。**纯函数**：同样的输入永远同样的输出顺序（按森林的先序），
 * 这样「冻结」只要保存输出的 `blockId[]` 就够了（D4：冻结成员与顺序）。
 *
 * ⚠️ 索引路径（`index-port.ts` 的 `queryByIndex`）与环境收集方式不同；可枚举形状走
 *    `evaluateQueryIds`（候选迭代），判定与排序规则共用本文件，结果与这里逐条相等（测试钉住）。
 * ⚠️ `'$self'` 的解析只有一份（`resolveSelfSpec`），两条路径都在**求值第一行**调它。
 */
export function runQuery(spec: QuerySpec, input: QueryRunInput): QueryHit[] {
  const host = input.selfId !== undefined ? findById(input.blocks, input.selfId) : undefined
  const selfUsed = usesSelf(spec.where)
  // 含 `$self` 却没有宿主 ⇒ 空结果。**不退回全库**：那会把「看不懂的指代」变成一次大范围命中，
  // 而用户看到的只是「结果不对」，没有任何线索指向条件。
  if (!host && selfUsed) return []
  // 字段表只服务 `{prop}` 与 `$self` 解析：纯 role/tag/text 查询不必扫两趟全库
  const fields = selfUsed || usesProp(spec.where) ? fieldTableOf(input.blocks) : EMPTY_FIELD_TABLE
  const q = host ? resolveSelfSpec(spec, host, input.blocks, fields) : spec
  const refTables = usesRef(q.where) ? refTablesOfForest(input.blocks) : undefined
  const env: QueryEnv = {
    refSources: refTables?.sources ?? NO_REF_SOURCES,
    ...(refTables && usesRefAny(q.where) ? { refFroms: refTables.froms } : {}),
    tags: collectTags(q.where, input.blocks),
    fields,
    ...(input.today ? { today: input.today } : {}),
    ...(input.excludeIds && input.excludeIds.length > 0 ? { excludeIds: new Set(input.excludeIds) } : {}),
  }
  const roots: readonly Block[] = input.blocks

  /**
   * 成员条件的候选集：顶层就是 `{role:'journal'}` 时，「库里有哪些天」的**一天一个**
   * 口径就是候选集（同一天多块的坏数据只取先序第一个）。
   * 它不是范围条件：判定不做任何特殊处理，换掉的只是同一批块去掉重复后的集合。
   *
   * ⚠️ 用**候选集**而不是 `roots`：把候选块当 root 会把 `QueryHit.path` 截成 `[]`。
   *    路径是真实 root→parent 链（`pathFixture` 的嵌套日用例钉住）。
   */
  const journalCandidates = isExactRoleJournal(q.where)
    ? new Set(journalDays(input.blocks).map((day) => day.id))
    : undefined
  return evaluateQuery(q, roots, env, input.blocks, journalCandidates)
}

/* ------------------------------------------------------------ `$self`：相对条件 */

/**
 * 条件里有没有 `'$self'` 这个**字符串哨兵**。
 *
 * 为什么是字符串而不是新原子：`canonicalSpec` 逐条列了每一种条件、只存字面量——
 * 加一个 `{self:true}` 原子就要两边一起加，而它表达的东西本来就能用**已有的值位**说清
 * （「指向我」「我这天」「我的标签」「我的可读文本」）。哨兵只是这些值位的一个特殊取值。
 */
export function usesSelf(node: QueryNode): boolean {
  if ('all' in node) return node.all.some(usesSelf)
  if ('any' in node) return node.any.some(usesSelf)
  if ('not' in node) return usesSelf(node.not)
  if ('up' in node) return usesSelf(node.up)
  if ('down' in node) return usesSelf(node.down)
  if ('near' in node) return usesSelf(node.near)
  if ('is' in node) return node.is === SELF
  if ('ref' in node) return refTargetOf(node.ref) === SELF
  if ('tag' in node) return node.tag === SELF
  if ('text' in node) return node.text === SELF
  if ('prop' in node) return 'eq' in node.prop && node.prop.eq === SELF
  return false
}

/**
 * 条件里有没有 `{prop}` 节点（含嵌套在 all/any/not/方向原子里的）。
 *
 * 字段表只服务 `{prop}` 判定与 `$self` 解析；纯 `{role}`／`{tag}`／`{text}`
 * 查询带一张表只是白扫两趟森林（日记流每次装载都会付）。
 */
function usesProp(node: QueryNode): boolean {
  if ('all' in node) return node.all.some(usesProp)
  if ('any' in node) return node.any.some(usesProp)
  if ('not' in node) return usesProp(node.not)
  if ('up' in node) return usesProp(node.up)
  if ('down' in node) return usesProp(node.down)
  if ('near' in node) return usesProp(node.near)
  return 'prop' in node
}

/** 哨兵字面量：条件里写它 ＝ 「这一块自己」的这一侧面 */
export const SELF = '$self'

/**
 * 条件里有没有 `{today}` 原子（相对日期）。
 *
 * 调用方用它决定两件事：要不要注入基准日、抬头要不要给「按本页日期」的锚。
 * 没有 `{today}` 的查询带一个 today 上下文只是白算，还会让冻结键天天变。
 */
export function usesToday(node: QueryNode): boolean {
  if ('all' in node) return node.all.some(usesToday)
  if ('any' in node) return node.any.some(usesToday)
  if ('not' in node) return usesToday(node.not)
  if ('up' in node) return usesToday(node.up)
  if ('down' in node) return usesToday(node.down)
  if ('near' in node) return usesToday(node.near)
  return 'today' in node
}

/**
 * 相对日期的**基准日**：锚在宿主上 ⇒ 宿主那一天的 `_date`；否则系统今天。
 *
 * 宿主没有日期（查询块被搬到普通页／投影到非日记页）⇒ **退回系统今天**：
 * 「按本页日期」问不出来的时候给出缺省语义，而不是空集——`$self` 的
 * 「永不命中」留给「会把一切命中」的危险值（空文本/空值），这里不是。
 */
export function resolveTodayBase(spec: QuerySpec, hostDate: string | undefined, systemToday: string): string {
  return spec.todayFrom === 'host' && hostDate !== undefined && hostDate !== '' ? hostDate : systemToday
}

/**
 * 把条件里的 `'$self'` 解析成**宿主的这一侧面**。纯函数，不改入参。
 *
 * | 条件 | 解析成 |
 * |---|---|
 * | `{is:'$self'}` | 宿主自己 |
 * | `{ref:'$self'}` | 指向宿主 id |
 * | `{tag:'$self'}` | 宿主带的那几个标签（`any` 并集） |
 * | `{text:'$self'}` | 宿主的可读文本（`displayTextOf`） |
 * | `{prop:{id, eq:'$self'}}` | 宿主**同一属性**的值（没有这一栏／值为空 ⇒ 永不命中） |
 *
 * 「在某一天下面」不再有专用值位：它是 `{up:{all:[{role:'journal'},{prop:{id:'_date',eq:'$self'}}]}}`
 * —— 日期本身用通用属性条件问，`$self` 只回答「宿主那一格的值」。
 *
 * ⚠️ **解析只写这一处**：纯函数路径与索引路径在求值第一行调它。写第二份就会得到
 *    「同一个 tab 在两条路径下结果不同」，而那是不报错的。
 * ⚠️ 解析出**空值**（宿主没有这一栏／可读文本／标签为空）⇒ 换成一条**永不命中**的条件，
 *    而不是把空串当成值去比 —— `{text:''}` 会命中所有块，`{eq:''}` 同理。
 * ⚠️ `{tag}` 按**标签块 id**存（与 `_tags` 同一条口径），宿主的标签 id 直接进 `any`；
 *    森林仍要传（`eq:'$self'` 的字段表按需建）。
 */
export function resolveSelfSpec(spec: QuerySpec, host: Block, forest: readonly Block[], provided?: FieldTable): QuerySpec {
  const hostTagIds = tagIdsOf(host)
  /** 字段表按需建：只有 `eq:'$self'` 需要它；调用方已有缓存时传进来，不重复扫两趟 */
  let fields: FieldTable | undefined = provided
  const node = (n: QueryNode): QueryNode => {
    if ('all' in n) return { all: n.all.map(node) }
    if ('any' in n) return { any: n.any.map(node) }
    if ('not' in n) return { not: node(n.not) }
    if ('up' in n) return { up: node(n.up) }
    if ('down' in n) return { down: node(n.down) }
    if ('near' in n) return { near: node(n.near) }
    if ('is' in n) return { is: n.is === SELF ? host.id : n.is }
    if ('ref' in n) {
      if (typeof n.ref === 'string') return { ref: n.ref === SELF ? host.id : n.ref }
      // 不限目标（缺 `to`）没有 `$self` 可解析，原样带走——不给它注入 `to: undefined`
      if (n.ref.to === undefined) return n
      return { ref: { ...n.ref, to: n.ref.to === SELF ? host.id : n.ref.to } }
    }
    if ('prop' in n) {
      if (!('eq' in n.prop) || n.prop.eq !== SELF) return n
      fields ??= fieldTableOf(forest)
      const { declared, value } = readField(host, n.prop.id, fields)
      if (!declared || value === undefined || value === null || value === '') return NEVER
      return { prop: { id: n.prop.id, eq: value } }
    }
    if ('tag' in n) {
      const id = typeof n.tag === 'string' ? n.tag : n.tag.id
      const desc = typeof n.tag === 'string' ? false : n.tag.desc === true
      if (id !== SELF) return { tag: n.tag }
      if (hostTagIds.length === 0) return NEVER
      // `$self` 是对每个宿主标签分别展开的：`desc` 跟着每一支走，不在这里丢
      return { any: hostTagIds.map((tid) => (desc ? { tag: { id: tid, desc: true } } : { tag: tid })) }
    }
    if ('text' in n) {
      if (n.text !== SELF) return { text: n.text }
      const text = displayTextOf(host)
      return text === '' ? NEVER : { text }
    }
    return n
  }
  return { ...spec, where: node(spec.where) }
}

/**
 * **这个条件一条都匹配不到吗**（空条件树）。
 *
 * 「还没有条件」在模型里就是 `{any: []}`（`[].some` ＝ false）。界面要能把
 * 它与「有条件但没命中」说成两句不同的话：前者是「去加一条条件」，后者是
 * 「这批条件没有结果」——同一屏两种空，用户下一步做的事完全不同。
 */
export function isEmptyWhere(node: QueryNode): boolean {
  return 'any' in node && node.any.length === 0
}

/**
 * 「永不命中」的条件：`{any: []}` 的判定是 `[].some(...)` ＝ `false`。
 *
 * ⚠️ 不用 `{all: []}`：那是**恒真**（`[].every(...)`），正好相反。
 */
const NEVER: QueryNode = { any: [] }


/**
 * 满足 `tag` 条件的**块 id** 集合（一次性算出，避免每个块都扫一遍森林）。
 *
 * ⚠️ 标签名先解析成标签块 id，再按归属查：认 id 不认名字 ⇒ 标签改名不影响查询语义。
 *    名字解析不到 ⇒ **空集**（那个标签还不存在，自然没有块带它）—— 不是「当文本搜」。
 */
function collectTags(node: QueryNode, forest: readonly Block[]): Set<string> {
  const out = new Set<string>()
  /** 「含子标签」那几支共用的邻接表（`membersOf` 缺省每次现建一张） */
  let adj: Adjacency | undefined
  const visit = (n: QueryNode): void => {
    if ('all' in n) n.all.forEach(visit)
    else if ('any' in n) n.any.forEach(visit)
    else if ('not' in n) visit(n.not)
    else if ('up' in n) visit(n.up)
    else if ('down' in n) visit(n.down)
    else if ('near' in n) visit(n.near)
    else if ('tag' in n) {
      // 条件里的值就是**标签块 id**；id 解析不到活着的标签块 ⇒ 空集（那个标签不存在，自然没有块带它）—— 不是「当文本搜」
      const id = typeof n.tag === 'string' ? n.tag : n.tag.id
      const desc = typeof n.tag === 'string' ? false : n.tag.desc === true
      const tag = findById(forest, id)
      if (!tag || !hasList(tag, 'tag')) return
      if (!desc) {
        for (const m of tagMemberIds(tag.id, forest)) out.add(m)
        return
      }
      // 「含子标签」不在这里另写一套闭包：成员判据只有 `tag-tree.ts` 那份（同类栏／引用候选同源）
      adj ??= buildAdjacency(forest)
      for (const m of membersOf(tag.id, forest, adj)) out.add(m)
    }
  }
  visit(node)
  return out
}

/** 在森林里按 id 找块。复用 `tree.ts` 的 `findPath`（不另写一份遍历） */
export function findById(blocks: readonly Block[], id: string): Block | undefined {
  const path = findPath(blocks, id)
  return path ? path[path.length - 1] : undefined
}
