/**
 * 模型最小面：块、文档、属性、角色。
 * **零依赖叶子** — 其它 core 模块只从这里取类型与构造器，反向不允许。
 */

import { uuidv7Hex } from './ids.ts'
export type TodoState = 'todo' | 'done'

/**
 * **角色**：表达「这块在系统里担任什么机制位」，**不是属性**。
 *
 * ⚠️ 判据：**「是不是某种东西」用角色，「有什么数据」用属性**。
 *   所以「这页是页」不是 `_role` 属性 —— 曾经的 `_page` 标记属性已经改成角色 `_page` → 角色 `page`。
 *   角色是块上的**一等声明**；属性表里不存在 `_role`。
 *
 * 注册表是**封闭种类 × 开放条目**：这里只列 core 已用到的，插件可注册自有角色。
 */
/**
 * `page` 页｜`journal` 日记｜`backref` 反链项（右槽默认内容）｜`favorites` 收藏容器块｜
 * `query` 查询视图｜`tag` 标签｜`schema` 字段定义
 *
 * ⚠️ `backref` 是**角色**而不是类型：反链项没有专属渲染行为，只是「一条指向我的引用」。
 * ⚠️ `favorites` 也只是**角色**：容器就是一个普通块（名字 = 正文，内部存一列有序引用边），
 * 没有新实体、没有新数组。
 * ⚠️ `tag` 同理：标签＝一个带 `tag` 角色的普通块，**它不占据树上的位置**（必须在顶层），
 *    因为它只是指向边的另一端；位置属于内容，名字属于身份。
 * ⚠️ `schema` 同理：字段定义也是一个块（正文 = 显示名），不是新表、不是新容器。
 * ⚠️ **`tag`／`schema`／`journal` 与 `page` 不是同一条规则**：前三个**不参与组织**（必须在顶层），
 *    `page` 是容器、可以被组织（将来 namespace 就是页嵌页）。
 *
 * **兼位**：同一个块可以同时担任多个角色（例：既是标签、又能当页打开）。
 * ⇒ 判定一律走 `hasRole`，**不要**读单个字段做 `===` 比较。
 */
export type Role = 'page' | 'journal' | 'backref' | 'favorites' | 'query' | 'tag' | 'schema'

/**
 * 系统属性 id。
 * ⚠️ **`_` 前缀 ＝ 保留区**：用户与插件不得定义，core 定义且不随插件卸载消失。
 * 这里只列当前用到的。
 */
export type SystemPropId =
  | '_type'
  | '_icon'
  | '_date'
  | '_tags'
  | '_alias'
  | '_query'
  | '_queryResult'
  // 字段定义（prop-def）：kind / 选项目录 / 声明列表
  | '_kind'
  | '_choices'
  | '_fieldDefs'
  // 包含（算作）：子标签 → 父标签的有序 ref 列表
  | '_parentTags'

export interface Block {
  id: string
  text: string
  children: Block[]
  /** 大纲折叠：折叠后子树不挂 DOM（**折叠态随模型快照/持久化**） */
  collapsed?: boolean
  /** 待办（demo 加的一点「产品感」，不引入新抽象） */
  todo?: TodoState
  /**
   * **属性**（属性是块第一公民）：任何块可直接有属性，不需标签即可赋值。
   *
   * ⚠️ **键是「字段定义块的块 id」，不是名字**。定义块自己承载显示名（正文＝label）⇒
   *    改显示名不动任何值、两个插件撞名也天然不冲突（id 空间本来就唯一）。
   * ⚠️ **系统结构位用 `_lowerCamelCase`**（`_type`／`_icon`／`_date`…）：它们没有定义块，
   *    形状由模型代码解释，也不进属性面板（`ownFieldIds` 按这个前缀过滤）。
   * ⚠️ **命名空间（`ns/name`）在属性上还没有载体**。要落时它属于**定义块的别名**，
   *    不是键——「字段地址」与「内容地址」必须是两张索引：字段显示名允许重名、
   *    不进内容地址空间（`isAddressable` 只认页与标签）。
   *    ⇒ 别把 `ns/name` 当键直接写：键已经是 id，混用会让同一字段有两份值。
   * ⚠️ 与 `roles`／`collapsed`／`todo` 的分工：那三个不是属性。
   */
  props?: BlockProps
  /**
   * **角色**（28 ）：语义机制位，不是属性。一个块可以同时兼多个机制位
   * （例：既是标签、又能当页打开）。
   *
   * ⚠️ **顺序不承载语义** —— 它只是集合的存储形状，不是优先级。
   *    判定一律 `hasRole`；不要按位置取「主角色」，那会变成一条隐式规则。
   * ⚠️ 这是**实现载体**：语义上角色来自角色注册表，接内核后由独立声明承载。
   */
  roles?: Role[]
}

/**
 * 这块有没有某个角色。
 *
 * ⚠️ 唯一判定入口：`roles` 改多值之后，任何 `b.role === 'x'` 都会静默失效
 *    （字段不存在 ⇒ 永远 false），所以那类直接比较由 `arch-check` 拦住。
 */
export function hasRole(b: Block | undefined, role: Role): boolean {
  return b?.roles?.includes(role) ?? false
}

/**
 * 加一个角色（幂等；**追加位置不承载语义**）。
 *
 * 判据：角色是「加/减一个机制位」，不是「在两种东西之间转换」——
 * 所以没有破坏性的「转角色」操作（那会顺手抹掉声明、断层级、改写别人的正文）。
 */
export function addRole(b: Block, role: Role): boolean {
  if (hasRole(b, role)) return false
  b.roles = [...(b.roles ?? []), role]
  return true
}

/** 减一个角色（幂等；只动这一个角色，不碰别的角色与数据） */
export function removeRole(b: Block, role: Role): boolean {
  if (!hasRole(b, role)) return false
  const next = (b.roles ?? []).filter((r) => r !== role)
  if (next.length === 0) delete b.roles
  else b.roles = next
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
}

export interface Located {
  parent: Block | null
  index: number
  block: Block
}

export function mkBlock(text = '', extra: Partial<Pick<Block, 'collapsed' | 'todo'>> = {}): Block {
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

/**
 * **这一块的正文是不是「内容」** —— 内容写路径（合并、拆块、区间替换）只许写内容。
 *
 * 有一类块的正文是**名字或投影**，不是内容：标签名、字段定义的名字、日记的日期投影。
 * 把别的块的正文并进它们，用户只按了一次退格，换来的是一次**静默改名**
 * （更糟的是往只读的日期行里塞字，而日期行的正文恒空是一条不变量）。
 * 所以要有一道判据挡在所有内容写路径前面。
 *
 * ⚠️ **`page` 不在这条里**：页的正文也是名字，但页是**容器**、它的行本来就允许直接编辑
 *    （在页名上打字就是改名）⇒ 不在这里拦。
 * ⚠️ **改名不走这条判据**：改名本来就是要写名字，它走 `renameBlock`。
 */
export function canWriteText(b: Block): boolean {
  return !hasRole(b, 'tag') && !hasRole(b, 'schema') && !hasRole(b, 'journal')
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
 * 日记块（32 ）：
 *   · **角色 ＝ `journal`**；**内容是日期，由 `_date` 派生显示**（日期**不进 `text`**）
 *   · **日期完全只读**：模型层没有任何写 `_date` 的路径
 *   · **一天一个**：id 由 (本地日) **确定性派生** ⇒ 并发/多设备打开同一天拿到同一个 id，天然幂等
 */
