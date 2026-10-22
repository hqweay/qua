/**
 * 模型最小面：块、文档、属性、角色。
 * **零依赖叶子** — 其它 core 模块只从这里取类型与构造器，反向不允许。
 */

import { uuidv7Hex } from './ids.ts'

/**
 * 「任务做完了没有」的**读法**（不是落盘形状）。
 *
 * 落盘的是一个真实的属性槽（见 `core/props.ts` 的 `todoOf`），这里只是它的
 * 三态投影：查询条件、诊断面、菜单上下文键都按这三个值说话。
 */
export type TodoState = 'todo' | 'done'

/**
 * **角色**：表达「这块在系统里担任什么机制位」，与「有什么数据」是两套语义。
 *
 * ⚠️ 判据：**「是不是某种东西」用角色，「有什么数据」用属性**。
 *   所以「这页是页」不是可以由定义块声明的普通字段 —— 它是系统结构位，
 *   载体是属性袋里的 `props._roles`（`_` 前缀 ＝ 保留区，形状由模型代码解释）。
 *   ⚠️ 判断依据是**谁解释它**，不是它存在哪个袋子里：`_roles` 由模型代码解释、
 *   没有定义块、不进属性面板；普通字段的值由 schema 解释。
 *
 * 注册表是**封闭种类 × 开放条目**：这里只列 core 已用到的，插件可注册自有角色。
 *
 * ⚠️ **准入门槛：角色是「读路径的入口」。** 每一种角色都得有代码按它把块**找出来**——
 *    标签成员找 `tag`、页导航找 `page`。只是为了给渲染层挑一个专用渲染器而存在的角色不合格：
 *    那是「怎么画」的问题（归类型与 `props`），不是「是什么」。
 *
 * **只有两个角色：`page` 页｜`tag` 标签。**
 *
 * 判据：**同一件事只有一个答案。** 一个块是不是日记、是不是字段定义、是不是查询视图，
 * 已经**完全由它身上的数据决定**（有 `_date`／有 `_kind`／`_query` 是合法条件）。
 * 再为它们各存一个角色值，就是同一件事的第二份答案 —— 而两份答案可以不一致：
 * 「带角色但没有数据」时，日记流、索引、渲染会各答一半。改成派生之后，
 * 那种状态**结构上不存在**。
 *
 * 反过来，`page` 与 `tag` 是**纯标记**：没有任何别处的数据能推出它们
 * （有别名 ≠ 是页，实测过；标签是边的一端，边在别处）。
 *
 * ⚠️ `tag` 是**角色**而非类型：标签＝一个带 `tag` 角色的普通块，**它不占据树上的位置**（必须在顶层），
 *    因为它只是指向边的另一端；位置属于内容，名字属于身份。
 * ⚠️ **`tag` 与 `page` 不是同一条规则**：`tag` 不参与组织（必须在顶层），
 *    `page` 是容器、可以被组织（将来 namespace 就是页嵌页）。
 *
 * **兼位**：同一个块可以同时担任多个角色（例：既是标签、又能当页打开）。
 * ⇒ 判定一律走 `hasRole`，**不要**读单个字段做 `===` 比较。
 *
 * 「这一行有没有身份」用 `hasIdentity`（角色 ∪ 由数据派生的身份），
 * 别拿「角色集合非空」当判据 —— 日记／定义／查询块的角色集合现在是空的。
 */
export type Role = 'page' | 'tag'

/**
 * 删除时间戳（毫秒）。有它 ＝ 这个块在回收站里。
 *
 * 它不是「删没删」的开关：树里没有它、回收站里有它，就是删掉了 —— 一份状态只有一个落点。
 * 属性而不是独立的回收站记录，是为了让「一块连同子树」原样搬动：回收站存的就是同一棵子树，
 * 复活时不需要把内容从另一份形状里重新装配一遍。
 */
export const DELETED_AT_PROP = '_deletedAt' as const

/**
 * 系统属性 id。
 * ⚠️ **`_` 前缀 ＝ 保留区**：用户与插件不得定义，core 定义且不随插件卸载消失。
 * 这里只列当前用到的。
 */
export type SystemPropId =
  | '_type'
  | '_icon'
  | '_date'
  | '_alias'
  | '_query'
  | '_queryResult'
  // 角色集合（语义见文件顶部的「角色」说明；存储位在这里）
  | '_roles'
  // 字段定义（prop-def）：kind / 选项目录 / 声明列表
  | '_kind'
  | '_choices'
  | '_fieldDefs'
  // 自有属性槽：这一块自己登记了哪些属性（见 `core/props.ts` 的 `ownPropIds`）
  | '_ownProps'
  // 字段定义的**编辑位置**（见 `core/props.ts` 的 `uiPositionOf`）
  | '_uiPosition'
  // 包含（算作）：子标签 → 父标签的有序 ref 列表
  | '_parentTags'
  // 删除时间戳（有它 ＝ 这块在回收站里，见 `DELETED_AT_PROP`）
  | typeof DELETED_AT_PROP

/**
 * **视图状态：块 id → 收起**。只记「收起的」，展开就是不在表里。
 *
 * 为什么不挂在块上：这一行此刻展开还是收起，**不是这块有什么数据**。
 * 挂在块上的实际代价有三条，都不是理论：
 *   · 它会被树操作当货物搬走（合并时把被并掉的块的折叠态写到前块、复制子树时复制给副本）；
 *   · 它进了撤销栈 ⇒ 折一下再撤销会把折叠撤回去，而用户想撤销的是内容；
 *   · 它随块一起被导出/快照 ⇒ 导出的内容带上了「我上次把哪行收起来了」。
 *
 * 判据与「视图状态外挂、不入内容」同一条：内容按块 id 现读，折叠按块 id 现查。
 */
export type FoldState = Record<string, true>

export interface Block {
  id: string
  text: string
  children: Block[]
  /**
   * **属性**（属性是块第一公民）：任何块可直接有属性，不需标签即可赋值。
   *
   * ⚠️ **键是「字段定义块的块 id」，不是名字**。定义块自己承载显示名（正文＝label）⇒
   *    改显示名不动任何值、两个插件撞名也天然不冲突（id 空间本来就唯一）。
   * ⚠️ **系统结构位用 `_lowerCamelCase`**（`_type`／`_icon`／`_date`／`_roles`…）：它们没有
   *    定义块，形状由模型代码解释，也不进属性面板（`ownFieldIds` 按这个前缀过滤）。
   * ⚠️ **命名空间（`ns/name`）在属性上还没有载体**。要落时它属于**定义块的别名**，
   *    不是键——「字段地址」与「内容地址」必须是两张索引：字段显示名允许重名、
   *    不进内容地址空间（`isAddressable` 只认页与标签）。
   *    ⇒ 别把 `ns/name` 当键直接写：键已经是 id，混用会让同一字段有两份值。
   */
  props?: BlockProps
}

/**
 * 角色集合的存储位（`props._roles`）。
 *
 * 为什么它住在属性袋里，而不是块上的又一个顶层字段：块的内容槽只有四个
 * （`id`／`text`／`children`／`props`）。
 * 多一个顶层字段，每个「整份拷贝一个块」的树操作都会漏掉它一次 ——
 * 复制出来的页只是一块长得像页的普通块，而且**不报错**。
 * 放进 `props` 之后，浅拷贝 `props` 就把角色一起带走了。
 *
 * ⚠️ 存储位不等于语义：读它请走 `hasRole`／`rolesOf`／`identityTags`，
 *    写它请走 `addRole`／`removeRole`。裸读恒 `undefined`（见 `arch-check` 第 21 条）。
 * ⚠️ 顺序不承载语义，它只是集合的存储形状。
 * ⚠️ 键名导出只为**一处地图**：整份浅拷属性袋的那条路径（复制子树）必须显式跳过它，
 *    而这个键名若在两处各写一遍字符串，改名时就会漏掉一处，漏掉的表现是「副本仍是标签」。
 */
export const ROLES_PROP = '_roles' as const

/**
 * 这块有没有某个角色。
 *
 * ⚠️ 唯一判定入口：角色是集合而不该被读成单值，任何 `b.role === 'x'`
 *    或裸读 `b.roles` 都会静默失效（载体变了就恒假），所以那类直接读由 `arch-check` 拦住。
 */
export function hasRole(b: Block | undefined, role: Role): boolean {
  return storedRoles(b)?.includes(role) ?? false
}

/* ------------------------------------------------- 由数据派生的身份 */

/**
 * **日记块**：有非空的 `_date`。
 *
 * 判据是数据，不是角色：日期就是它的全部内容，`_date` 在不在是唯一事实。
 * 单独存一个角色会让「有角色、没日期」这种状态存在，而它没有任何合理读法。
 *
 * ⚠️ 住在 `model.ts`（零依赖叶子）而不是 `journal.ts`：`canWriteText`／`hasIdentity`
 *    要用它，反向 import 会成环。
 */
export function isJournalBlock(b: Block | undefined): boolean {
  if (!b) return false
  const d = prop<string>(b, '_date')
  return typeof d === 'string' && d !== ''
}

/** **字段定义块**：有 `_kind`。定义的种类是它自己的数据，不需要第二份声明 */
export function isPropDefBlock(b: Block | undefined): boolean {
  return b?.props?._kind !== undefined
}

/**
 * **查询视图块**：`_query` 是一个带 `where` 的条件对象。
 *
 * 判据与读条件的那一处（`query-view.ts` 的 `readSpec`）必须是**同一个**：
 * 「能读出条件」和「是不是查询块」若各有一套判据，就会出现读不出条件的查询块。
 */
export function isQueryBlock(b: Block | undefined): boolean {
  if (!b) return false
  const raw = prop<unknown>(b, '_query')
  if (!raw || typeof raw !== 'object') return false
  const where = (raw as { where?: unknown }).where
  return !!where && typeof where === 'object'
}

/**
 * **这一块的正文是名字或投影，不是内容** —— 身份块的总判据。
 *
 * 身份有两个来源，缺一不可：显式角色（页／标签），以及由数据派生的身份
 * （日记／字段定义／查询视图）。只看角色集合会漏掉后三个 ——
 * 它们的角色集合现在是空的，而那正是「日记日期行被拆块改写」这类静默回归的形状。
 *
 * 判据落成一句话：**这一行的正文是名字或投影，不是内容**。
 */
export function hasIdentity(b: Block | undefined): boolean {
  return (
    hasRole(b, 'page') || hasRole(b, 'tag') || isJournalBlock(b) || isPropDefBlock(b) || isQueryBlock(b)
  )
}

/**
 * **身份标记**（给外观与诊断面）：显式角色 ∪ 由数据派生的身份名。
 *
 * 为什么需要它，而不是直接用 `rolesOf`：角色的种类收窄到两个之后，
 * 「日记」「定义」「查询」不再有角色值，但**外面还在按这些名字认它们** ——
 * 样式表按 `data-role` 挑行、诊断面按 `roles` 挑块。让这些读点跟着改判据，
 * 等于把「怎么认一块的身份」这条口径复制到每个消费方；这里一次性把它们转成名字。
 *
 * ⚠️ 这不是「把身份写回块」：标记是**每次现算**的，不落盘、也读不回来。
 * ⚠️ 顺序不承载语义；调用方只该按集合用（`includes`／`~=`）。
 */
export function identityTags(b: Block | undefined): string[] {
  const tags: string[] = [...(storedRoles(b) ?? [])]
  if (isJournalBlock(b)) tags.push('journal')
  if (isPropDefBlock(b)) tags.push('schema')
  if (isQueryBlock(b)) tags.push('query')
  return tags
}

/**
 * 这块的全部角色（**副本**）。
 *
 * 返回副本而不是内部数组：调用方（渲染、诊断面）拿到的是一份可随便改的列表，
 * 改它不会悄悄改到库里的块。
 */
export function rolesOf(b: Block | undefined): Role[] {
  return [...(storedRoles(b) ?? [])]
}

/** 存储里的那份数组（**内部用，不外传**：外传就会被调用方拿去改） */
function storedRoles(b: Block | undefined): Role[] | undefined {
  const raw = b?.props?.[ROLES_PROP]
  return Array.isArray(raw) ? (raw as Role[]) : undefined
}

/**
 * 加一个角色（幂等；**追加位置不承载语义**）。
 *
 * 判据：角色是「加/减一个机制位」，不是「在两种东西之间转换」——
 * 所以没有破坏性的「转角色」操作（那会顺手抹掉声明、断层级、改写别人的正文）。
 */
export function addRole(b: Block, role: Role): boolean {
  if (hasRole(b, role)) return false
  b.props = { ...(b.props ?? {}), [ROLES_PROP]: [...rolesOf(b), role] }
  return true
}

/** 减一个角色（幂等；只动这一个角色，不碰别的角色与数据） */
export function removeRole(b: Block, role: Role): boolean {
  if (!hasRole(b, role)) return false
  const next = rolesOf(b).filter((r) => r !== role)
  const props = { ...(b.props ?? {}) }
  // 不留空数组：空数组会让「有没有角色」有两份答案（空 vs 没有）
  if (next.length === 0) delete props[ROLES_PROP]
  else props[ROLES_PROP] = next
  // 属性袋也不留空壳：`{}` 与「没有属性」在快照比较里是两种东西
  if (Object.keys(props).length === 0) delete b.props
  else b.props = props
  return true
}

/**
 * **块类型**：决定「长什么样」（判据：改外观 → 类型；只换机制位 → 角色）。
 *
 * 首期只有默认类型 `outline`：块是大纲里的一行（图标 ＋ 正文/名字）。
 * 角色不参与这里的判定 —— 兼位不该改变外观，只往上叠 chrome。
 * `_type` 是系统属性；未声明时就是默认类型。
 */
export const DEFAULT_BLOCK_TYPE = 'outline'

export function blockTypeOf(b: Block): string {
  return prop<string>(b, '_type') ?? DEFAULT_BLOCK_TYPE
}

/**
 * 属性袋：键 = **字段定义块的块 id**（系统结构位例外：`_lowerCamelCase`，见 `Block.props`）。
 *
 * ⚠️ 不是 `ns/kebab-name`：命名空间在属性上还没有载体，落点应是定义块的别名。
 */
export type BlockProps = Record<string, unknown>

export interface Doc {
  roots: Block[]
  /**
   * 这份文档的折叠态。**装在 `Doc` 上而不是到处多传一个参数**：`Doc` 是
   * 「编辑器装载的那份东西」的完整描述（roots ＋ 折叠态），各视图各带一份，互不干扰。
   *
   * ⚠️ 它不参与撤销：折叠不是内容改动。
   */
  folded?: FoldState
  /**
   * **回收站**（被删掉的根块，子树完整）。`Doc` 只**共享引用**，不复制：
   * 回收站是库级的，而 `Doc` 是一次装载的形状 —— 与 `roots` 共享森林是同一个道理。
   * 复制一份就会出现「正文视图删的块进这个视图的回收站，别处看不见」。
   */
  trash?: Block[]
}

export interface Located {
  parent: Block | null
  index: number
  block: Block
}

export function mkBlock(text = '', extra: Partial<Pick<Block, 'props'>> = {}): Block {
  return { id: uuidv7Hex(), text, children: [], ...extra }
}

/**
 * **写块正文的唯一入口。**
 *
 * 正文有两重身份：内容块的正文是**内容**，带身份块的正文是**名字**。把写入收在一处，
 * 是为了让「这次写的是内容还是名字」的判断只有一个落点 —— 否则每加一条写路径都要
 * 各自记得它，漏一条就是一次静默改写（块首退格把子块并进前块时改掉标签名，就是这样发生的）。
 *
 * ⚠️ **新建块不走这里**：`mkBlock` 造出来的块还没有身份，正文随构造一次给定。
 */
export function writeBlockText(b: Block, text: string): void {
  b.text = text
}

/* ---------------------------------------------------------------- props */

/** 读一条属性（没有就是 `undefined`，**不返回默认值**——默认值属派生层，承 41/38） */
export function prop<T = unknown>(b: Block, id: SystemPropId | string): T | undefined {
  return b.props?.[id] as T | undefined
}

/** 写一条属性（返回新块，**不改入参**；块是不可变替换的，承 16 事务快照） */
export function withProp(b: Block, id: SystemPropId | string, value: unknown): Block {
  return { ...b, props: { ...(b.props ?? {}), [id]: value } }
}

/* ---------------------------------------------------------------- 可写容器 */

/**
 * 「打开一个容器来编辑」的前置：**它至少要有一个子块**。
 *
 * 空容器 ⇒ 编辑器里一个块都没有 ⇒ **没有地方可以落光标** ⇒ 用户看到的是
 * 「打开了却打不了字」（2026-10-19 实机复现：全新一天的 journal、以及 `core.page/new`）。
 *
 * ⚠️ 这是**模型层**的归一，不是渲染兜底：归一后模型就是真相，落盘与重开一致
 *   （对比「编辑器里凭空合成一个块」——那会让模型与所见分叉）。
 * ⚠️ 代价诚实标注：这是**一次「打开即写」**（读的时候改了模型）。判据是：没有它，
 *   这个容器就不可编辑；而种子数据（`emptyWorkspace`）早就默认「空页也带一个空块」，
 *   运行时路径当时漏了同一条约定。
 */
export function ensureFirstBlock(children: Block[]): Block[] {
  if (children.length === 0) children.push(mkBlock(''))
  return children
}

/* ---------------------------------------------------------------- journal */

/**
 * 日记块：
 *   · **身份 ＝ 有 `_date`**（不存角色值）；**内容是日期，由 `_date` 派生显示**（日期**不进 `text`**）
 *   · **日期完全只读**：模型层没有任何写 `_date` 的路径
 *   · **一天一个**：id 由 (本地日) **确定性派生** ⇒ 并发/多设备打开同一天拿到同一个 id，天然幂等
 */
