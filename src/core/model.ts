/**
 * 模型最小面：块、文档、属性、列表（露面）与地址。
 * **零依赖叶子** — 其它 core 模块只从这里取类型与构造器，反向不允许。
 */

import { uuidv7Hex } from './ids.ts'
import { normalizeRuns, textRuns, type Anno, type Run } from './runs.ts'

/**
 * 「任务做完了没有」的**读法**（不是落盘形状）。
 *
 * 落盘的是一个真实的属性槽（见 `core/props.ts` 的 `todoOf`），这里只是它的
 * 三态投影：查询条件、诊断面、菜单上下文键都按这三个值说话。
 */
export type TodoState = 'todo' | 'done'

/**
 * **列表**：这一块以哪个身份**露面**（页列表 / 标签列表），与「有什么数据」是两套语义。
 *
 * 判据：**地址回答「它是谁」，列表回答「它在哪个列表里出现」。**
 *   · 名字住在 `_aliases`（0..N，首个是主名，全局唯一）；
 *   · 页／标签是**露面**（`_lists`），一个块可以同时进两个列表（兼位），也可以一个都不进。
 *   ⇒ 「有名字」与「是页／标签」因此是两件独立的事：可以有名却不出现在任何列表里，
 *     而页列表与标签列表按 `hasList` 过滤 —— 不再读一个叫 `_roles` 的第二份声明。
 *
 * 为什么「日记／字段定义／查询视图」没有对应的列表值：它们的身份**完全由数据决定**
 * （有 `_date`／有 `_kind`／`_query` 是合法条件）。再存一个标记就是同一件事的第二份答案，
 * 而两份答案可以不一致 —— 派生之后那种状态**结构上不存在**。
 *
 * 「这一行有没有身份」用 `hasIdentity`（名字 ∪ 列表 ∪ 由数据派生的身份），
 * 别拿「列表非空」当判据 —— 日记／定义／查询块的列表集合是空的。
 */
export type BlockList = 'page' | 'tag'

/** 这一块以哪些身份露面（`props._lists`）。无序集合；重复不承载语义。 */
export const LISTS_PROP = '_lists' as const

/** 这一块的地址（`props._aliases`）。有序：**首个是主名**，全局唯一，允许 `/` 分段。 */
export const ALIASES_PROP = '_aliases' as const

/**
 * 这一行自己的头显示什么：主别名叶子（`alias`）还是正文（`text`）。
 *
 * ⚠️ 它**只影响这一行自己的头**：引用／反链永远叫主名叶子，不跟这个开关走
 *    （否则同一块在别处会有两个名字，而地址只有一个）。
 */
export const DISPLAY_PROP = '_display' as const
export type DisplayMode = 'alias' | 'text'

/**
 * 删除时间戳（毫秒）。有它 ＝ 这个块被删了（**原位软删**）。
 *
 * 删除**不摘树**：块带着整棵子树留在原位，只是遍历（`walkForest`）默认不进被删子树，
 * 于是所有读路径一致地看不见它。「回收站」是这个标记的**派生视图**（带标记的块清单），
 * 不是第二个存放处 —— 恢复 ＝ 摘掉标记，块回到原位，内容与祖先链原样接上。
 * 属性而不是独立记录，为的是「一块连同子树」只有一份真相：不存在「树里一份、回收站一份」
 * 的两处状态。
 */
export const DELETED_AT_PROP = '_deletedAt' as const

/**
 * **视图配置**（`ViewConfig[]`，见 `core/view.ts`）：
 * 「这一块怎么看」——列、序、行高、分组、封面。
 *
 * 为什么住在块的系统属性里，而不是节点/视图块：
 *   · 视图不是实体，它是对**同一批块**的一次渲染（与「页/日记/标签都是块」同一条判据）；
 *   · 换设备打开要看到同一张表 ⇒ 它是内容，必须入 KB（滚动/选中/折叠才是外挂状态）。
 * 为什么是数组：一个块可以存多个命名视图，切换只是换个 `_activeView`；
 *   从第一天就是数组，以后加第二个视图不需要迁移。
 */
export const VIEWS_PROP = '_views' as const

/**
 * **当前激活的视图 id**（必须指向 `_views` 里的一项）。
 *
 * `缺失 ＝ 大纲`：大纲不是一种「视图配置」，它是「没有任何激活视图」这一状态 ——
 * 把它也存成一个 kind，切换视图就要写两份事实（存了 kind=outline、又存了激活 id），
 * 而两份能不一致。缺失是**唯一**的「没有」。
 */
export const ACTIVE_VIEW_PROP = '_activeView' as const

/** 这一块被删了吗（只看它自己；整棵子树不可见由遍历的跳过规则保证） */
export function isDeleted(b: Block): boolean {
  return b.props !== undefined && DELETED_AT_PROP in b.props
}

/**
 * 系统属性 id。
 * ⚠️ **`_` 前缀 ＝ 保留区**：用户与插件不得定义，core 定义且不随插件卸载消失。
 * 这里只列当前用到的。
 */
export type SystemPropId =
  | '_type'
  | '_icon'
  | '_date'
  // 地址与露面（语义见文件顶部的「列表」说明；存储位在这里）
  | typeof ALIASES_PROP
  | typeof LISTS_PROP
  | typeof DISPLAY_PROP
  | '_query'
  // 视图配置（见 `core/view.ts`）：一个块怎么看，与它是什么是两件事
  | typeof VIEWS_PROP
  | typeof ACTIVE_VIEW_PROP
  // 字段定义（prop-def）：kind / 声明列表 / 选项的可见范围
  | '_kind'
  | '_fieldDefs'
  /**
   * 一个**选项块**的可见范围（见 `core/props.ts` 的 `choiceScopeOf`）。
   *
   * 选项是定义块的直接子块，所以「它是选项」由位置回答；这一格只回答
   * 「哪些标签的成员看得到它」。三态一个表达式，不做「按标签分槽的值」。
   */
  | '_choiceScope'
  // 自有属性槽：这一块自己登记了哪些属性（见 `core/props.ts` 的 `ownPropIds`）
  | '_ownProps'
  // 字段定义的**编辑位置**（见 `core/props.ts` 的 `uiPositionOf`）
  | '_uiPosition'
  // 归属边（算作）：子块 → 上级的有序 ref 列表（见 `core/hierarchy.ts`）
  | '_belongsTo'
  /**
   * 这块带着哪些标签：**有序的标签块 id 列表**（见 `core/tags.ts` 的 `tagIdsOf`）。
   *
   * 存 id 不存名字：标签块能改名，归属不该跟着失效。
   * 曾经有一个同名槽位用来存「超级标签」的**定义**（没有任何读写路径，已移除）；
   * 现在这一格是**归属**：块上有哪些标签，与「标签能声明哪些字段」是两件事。
   */
  | '_tags'
  /**
   * 这一块的**挂载区配置**：`{ label, spec }[]`（见 `core/mount.ts`）。
   *
   * 它不是内容：tab 上那一栏是「这一块下面挂的看板」，不是子块。所以它既不在 `children` 里，
   * 也不让块变成身份块（不进 `hasIdentity`）——它只是一格结构属性，与 `_tags` 同形。
   */
  | '_mounts'
  // 删除时间戳（有它 ＝ 这一块被删了，见 `DELETED_AT_PROP`）
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
  /**
   * **行内内容 ＝ run 序列**（文本段与不可分的行内原子；见 `core/runs.ts`）。
   * 空块 ＝ `[]`。要一段「纯文本长什么样」用 `plainText(content)` 投影，
   * 别在这里找字符串字段——投影是派生的，存着的只有 runs。
   */
  content: Run[]
  children: Block[]
  /**
   * **这块何时诞生**（墙钟毫秒）。
   *
   * 为什么是**必填字段**而不是一个 `_` 开头的系统属性：`props` 里每一个键都允许缺席，
   * 而且缺席本身是信息（`_date` 缺席＝不是日记、`_deletedAt` 缺席＝没被删）。
   * 创建时间不可能缺席 —— 每块都必然诞生过一次。用属性装它，等于给一件
   * 不可能缺席的事开了一个「缺席」的合法状态，然后每处读代码都要处理那个不存在的分支。
   */
  created: number
  /**
   * **最后一次改动这块**（墙钟毫秒）。
   *
   * 与 `created` 同一条判据（必填字段），另有两条落地约束：
   *   · 只在**显式编辑边界**更新（见 `view/editor.ts` 的 `commitEdit`）：每敲一字更新会让
   *     op 流翻倍，且语义退化成「最后按键时刻」；读操作（打开／聚焦／折叠）一律不算改动。
   *   · 它必须与正文改动**并进同一条** `block.upsert`：一次编辑是一条 op，
   *     多一个属性写就多一条账。这也是它不能住在 `props` 里的另一半理由。
   */
  modified: number
  /**
   * **可引用区间**（按需物化）：只有被别处引用时才存在；没有就保持 `undefined`，
   * 不写空数组（空壳会让「有没有」出现两份答案）。
   */
  annos?: Anno[]
  /**
   * **属性**（属性是块第一公民）：任何块可直接有属性，不需标签即可赋值。
   *
   * ⚠️ **键是「字段定义块的块 id」，不是名字**。定义块自己承载显示名（正文＝label）⇒
   *    改显示名不动任何值、两个插件撞名也天然不冲突（id 空间本来就唯一）。
   * ⚠️ **系统结构位用 `_lowerCamelCase`**（`_type`／`_icon`／`_date`／`_aliases`…）：它们没有
   *    定义块，形状由模型代码解释，也不进属性面板（`ownFieldIds` 按这个前缀过滤）。
   * ⚠️ **命名空间（`ns/name`）在属性上还没有载体**。要落时它属于**定义块的别名**，
   *    不是键——「字段地址」与「内容地址」必须是两张索引：字段显示名允许重名、
   *    不进内容地址空间（`isAddressable` 只看 `_aliases`）。
   *    ⇒ 别把 `ns/name` 当键直接写：键已经是 id，混用会让同一字段有两份值。
   */
  props?: BlockProps
}

/**
 * 这一块以哪些身份露面（`props._lists` 的副本）。
 *
 * 为什么它住在属性袋里，而不是块上的又一个顶层字段：块的内容槽只有四个
 * （`id`／`text`／`children`／`props`）。
 * 多一个顶层字段，每个「整份拷贝一个块」的树操作都会漏掉它一次 ——
 * 复制出来的页只是一块长得像页的普通块，而且**不报错**。
 * 放进 `props` 之后，浅拷贝 `props` 就把列表一起带走了（复制子树那条路另有判据：
 * 身份不随副本走，见 `tree.ts` 的 `IDENTITY_PROPS`）。
 *
 * ⚠️ 顺序不承载语义，它只是集合的存储形状；判定只走 `hasList`。
 * ⚠️ 键名导出只为**一处地图**：整份浅拷属性袋的那条路径必须显式跳过它，
 *    而这个键名若在两处各写一遍字符串，改名时就会漏掉一处。
 */
export function listsOf(b: Block | undefined): BlockList[] {
  const raw = b?.props?.[LISTS_PROP]
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is BlockList => x === 'page' || x === 'tag')
}

/**
 * 这块以某个身份露面吗。
 *
 * ⚠️ 唯一判定入口：列表是集合而不该被读成单值；裸读 `_lists` 会漏掉
 *    「兼位」与「值没写进数组」两种形状。
 */
export function hasList(b: Block | undefined, list: BlockList): boolean {
  return listsOf(b).includes(list)
}

/**
 * 加一个列表（幂等；**追加位置不承载语义**）。
 *
 * 判据：列表是「加/减一个露面位」，不是「在两种东西之间转换」——
 * 所以没有破坏性的「转列表」操作（那会顺手抹掉声明、断层级、改写别人的正文）。
 * ⚠️ 加列表不会自动给地址：调用方必须先写主别名（不变量：列表非空 ⇒ 别名非空）。
 */
export function addList(b: Block, list: BlockList): boolean {
  if (hasList(b, list)) return false
  b.props = { ...(b.props ?? {}), [LISTS_PROP]: [...listsOf(b), list] }
  return true
}

/** 减一个列表（幂等；只动这一格，不碰别的列表与数据） */
export function removeList(b: Block, list: BlockList): boolean {
  if (!hasList(b, list)) return false
  const next = listsOf(b).filter((x) => x !== list)
  const props = { ...(b.props ?? {}) }
  // 不留空数组：空数组会让「在不在列表里」有两份答案（空 vs 没有）
  if (next.length === 0) delete props[LISTS_PROP]
  else props[LISTS_PROP] = next
  // 属性袋也不留空壳：`{}` 与「没有属性」在快照比较里是两种东西
  if (Object.keys(props).length === 0) delete b.props
  else b.props = props
  return true
}

/**
 * 这一块的地址（**原始字符串副本**，顺序即优先级：首个是主名）。
 *
 * 过滤空串：空地址不是地址，留在数组里会让「有没有名字」有两份答案。
 */
export function aliasesOf(b: Block | undefined): string[] {
  const raw = b?.props?.[ALIASES_PROP]
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
}

/**
 * 主名（原始字符串；没有则空串）。
 *
 * ⚠️ 显示与比较是两件事：显示走 `aliasLeaf`／`displayNameOf`（`core/alias.ts`），
 *    比较走 `normalizeAlias`。这里只回答「第一个是哪个」，不做任何归一化。
 */
export function primaryAliasOf(b: Block | undefined): string {
  return aliasesOf(b)[0] ?? ''
}

/* ------------------------------------------------- 由数据派生的身份 */

/**
 * **日记块**：有非空的 `_date`。
 *
 * 判据是数据，不是标记：日期就是它的全部内容，`_date` 在不在是唯一事实。
 * 单独存一个标记会让「有标记、没日期」这种状态存在，而它没有任何合理读法。
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
 * 身份有两个来源，缺一不可：地址（`_aliases`）／露面（`_lists`），以及由数据派生的身份
 * （日记／字段定义／查询视图）。只看列表会漏掉「有名内容块」与后三个 ——
 * 那正是「日记日期行被拆块改写」这类静默回归的形状。
 *
 * 判据落成一句话：**这一行的正文是名字或投影，不是内容**。
 * ⚠️ 页／标签的正文现在**是**可写的描述（见 `canWriteText`），但它们仍有名字，
 *    所以仍算身份块：拆块／合并不能把它们的正文当内容搬走。
 */
export function hasIdentity(b: Block | undefined): boolean {
  return (
    aliasesOf(b).length > 0 ||
    listsOf(b).length > 0 ||
    isJournalBlock(b) ||
    isPropDefBlock(b) ||
    isQueryBlock(b)
  )
}

/**
 * **身份标记**（给外观与诊断面）：列表 ∪ 由数据派生的身份名。
 *
 * 为什么需要它，而不是直接用 `listsOf`：「日记」「定义」「查询」没有列表值，
 * 但**外面还在按这些名字认它们** —— 样式表按 `data-role` 挑行、诊断面按 `roles` 挑块。
 * 让这些读点跟着改判据，等于把「怎么认一块的身份」这条口径复制到每个消费方；
 * 这里一次性把它们转成名字。
 *
 * ⚠️ 这不是「把身份写回块」：标记是**每次现算**的，不落盘、也读不回来。
 * ⚠️ 顺序不承载语义；调用方只该按集合用（`includes`／`~=`）。
 * ⚠️ 别名**不进**这里：地址是「它叫什么」，不是外观要认的身份种类；把它塞进来
 *    会让每个有名内容块都长出一行 `data-role`，样式与冒烟都跟着被污染。
 */
export function identityTags(b: Block | undefined): string[] {
  const tags: string[] = [...listsOf(b)]
  if (isJournalBlock(b)) tags.push('journal')
  if (isPropDefBlock(b)) tags.push('schema')
  if (isQueryBlock(b)) tags.push('query')
  return tags
}

/**
 * **块类型**：决定「长什么样」（判据：改外观 → 类型；换露面 → 列表）。
 *
 * 首期只有默认类型 `outline`：块是大纲里的一行（图标 ＋ 正文/名字）。
 * 列表不参与这里的判定 —— 兼位不该改变外观，只往上叠 chrome。
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
   * **根行的上下文**（面包屑）：root id → 祖先链（从根到父，**不含这一行自己**）。
   *
   * 反链／查询结果里的行可能来自库的任意深度；把「它在哪」画在行首，读者才知道
   * 这一行是「哪一页里的那句话」。子行不需要它——缩进已经表达了父子关系。
   *
   * ⚠️ 派生、视图私有、不入库：路径由 `KbClient.pathOf` 现取，装载时随 `Doc` 一起给。
   * ⚠️ 只有 `roots` 里的块会被查；不在表里 ＝ 这一行没有面包屑（顶层根就是这种）。
   */
  contexts?: ReadonlyMap<string, readonly Block[]>
  /**
   * **哪些根是「展开出来的上下文根」**（不是原始命中行）。
   *
   * 只影响行首那一条控制：这些根可以「收起上下文」退回上一层；普通装载根没有。
   * 与 `contexts` 一样是派生、视图私有、不入库。
   */
  expandedRoots?: ReadonlySet<string>
  /**
   * **这一份装载里，哪个根的子块不归编辑器画**（非大纲视图的宿主）。
   *
   * 判据：有激活的表格/看板/…视图时，children 由那一段的视图宿主渲染；
   * 编辑器只画根行（标题/说明），否则同一批子块会在正文和表格里各画一遍。
   *
   * ⚠️ 它是**这一屏怎么渲染**，不是块的内容：不进库、不进撤销、不是 `Block` 的第五个槽。
   * ⚠️ **不复用 `folded`**：折叠是用户状态（三角要显示「收着」），而这里视图其实展开了；
   *    两者语义不同，共用一个字段会让折叠三角撒谎。
   */
  viewRootId?: string
}

export interface Located {
  parent: Block | null
  index: number
  block: Block
}

export function mkBlock(
  init: string | readonly Run[] = '',
  extra: Partial<Pick<Block, 'props' | 'created' | 'modified'>> = {},
): Block {
  const content = typeof init === 'string' ? textRuns(init) : normalizeRuns(init)
  // 创建时刻的**默认落点**：所有「造一块」的路径都从这里过，只有库外的伪块
  // （反链伪行）与导入/测试显式指定时刻时才各自给值。
  const now = Date.now()
  return { id: uuidv7Hex(), content, children: [], created: now, modified: now, ...extra }
}

/**
 * **写块内容的唯一入口。**
 *
 * 内容有两重身份：普通块的内容是**用户写的字**，身份块的正文是**名字或投影**。
 * 把写入收在一处，是为了让「这次写的是内容还是名字」的判断只有一个落点 ——
 * 否则每加一条写路径都要各自记得它，漏一条就是一次静默改写（块首退格把子块并进
 * 前块时改掉标签名，就是这样发生的）。
 *
 * ⚠️ **新建块不走这里**：`mkBlock` 造出来的块还没有身份，内容随构造一次给定。
 */
export function writeBlockContent(b: Block, content: readonly Run[]): void {
  b.content = normalizeRuns(content)
}

/* ---------------------------------------------------------------- props */

/** 读一条属性（没有就是 `undefined`，**不返回默认值**——默认值属派生层） */
export function prop<T = unknown>(b: Block, id: SystemPropId | string): T | undefined {
  return b.props?.[id] as T | undefined
}

/** 写一条属性（返回新块，**不改入参**；块是不可变替换的，事务快照靠它） */
export function withProp(b: Block, id: SystemPropId | string, value: unknown): Block {
  return { ...b, props: { ...(b.props ?? {}), [id]: value } }
}

/* ---------------------------------------------------------------- 可写容器 */

/**
 * 冷启动的预仓库归一：**journal 天至少要有一个子块**。
 *
 * 空容器 ⇒ 编辑器里一个块都没有 ⇒ **没有地方可以落光标** ⇒ 用户看到的是
 * 「打开了却打不了字」（实机复现过：全新一天的 journal）。
 *
 * ⚠️ 只许在**仓库构建之前**用：此刻还没有 store／事务，补的块随冷启动后的整库落盘
 *   一起进盘。运行时的结构写必须经事务产 op（补块的唯一落点在装配层的装载边界）——
 *   「打开」是读动作，读的时候改模型会让 op 序列缺一段、换库后那块没有行可落。
 */
export function ensureFirstBlock(children: Block[]): Block[] {
  if (children.length === 0) children.push(mkBlock(''))
  return children
}

/* ---------------------------------------------------------------- journal */

/**
 * 日记块：
 *   · **身份 ＝ 有 `_date`**（不存标记）；**内容是日期，由 `_date` 派生显示**（日期**不进 `text`**）
 *   · **日期完全只读**：模型层没有任何写 `_date` 的路径
 *   · **一天一个**：id 由 (本地日) **确定性派生** ⇒ 并发/多设备打开同一天拿到同一个 id，天然幂等
 */
