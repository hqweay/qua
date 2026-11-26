/**
 * 块类型：**声明**（本文件）与**绑定**（渲染器、命令）分开。
 *
 * 判据：`_type` 是唯一一个「值必须来自封闭注册表」的块级字段。
 * 属性系统的前提是「值域开放、系统不需要认识它」；类型系统的前提正相反 ——
 * 「值必须被认识，否则没法画」。两个前提互斥 ⇒ 类型不能塞进属性袋，
 * 也不是一条可以由用户随便填的属性值。
 *
 * 为什么把声明与绑定拆开：声明要能物化进库、能被插件读（纯数据、可序列化），
 * 而渲染器是函数、不可序列化，只能留在代码里。把两者塞进同一条记录，
 * 声明就再也没法离开进程。
 *
 * ⚠️ 依赖方向：本模块 → `model.ts`，单向。`model.ts` 是零依赖叶子，
 *    反过来 import 会成环（`blockTypeOf` 与 `DEFAULT_BLOCK_TYPE` 留在那里）。
 */
import { EMBED_TYPE, isEmbedBlock } from '../views/embed.ts'
import {
  DEFAULT_BLOCK_TYPE,
  blockTypeOf,
  hasList,
  isAutomationBlock,
  isJournalBlock,
  isPropDefBlock,
  isQueryBlock,
  type Block,
} from './model.ts'

/**
 * 一个类型的**声明**：纯数据、可序列化、无函数。
 *
 * 类型回答的是「这一行的骨架是什么」，所以它能说的也只有骨架层面的事：
 * 有没有子块、正文可不可写、正文能不能跨行。具体画成什么样是绑定的事。
 */
export interface TypeDecl {
  /** 类型 id（`ns/kebab-name`；`core/*` 保留） */
  id: string
  /**
   * 子块是什么。
   * `content` —— 子块是内容（你组织的；页、普通块）
   * `none`    —— 不许有子块（占位型块）
   */
  children: 'content' | 'none'
  /**
   * 正文可不可写。
   * `editable` —— 正文是内容或名字，可编辑（普通块、页、标签）
   * `readonly` —— 正文不是可编辑内容（纯装饰型块）
   */
  text: 'editable' | 'readonly'
  /**
   * 正文是否允许字面换行（`\n`）。
   * 只有代码块打开：它的正文是代码纯文本，不拆成行内 run；其余类型的正文是单行内容。
   */
  multiline?: boolean
  /**
   * **在紧跟其后的空块行首按退格时，允许把这一块删掉。**
   *
   * 「正文空 + 只读」是**形状**，不是许可：露面与查询块正好长这样，但它们不是
   * 「插入时补的那个光标位」的配对物，删掉会静默丢掉一次露面/一整个查询。
   * 所以删除能力按类型显式声明，默认没有。
   */
  deleteOnBackspace?: boolean
}

/** 分割线的类型 id：出现在声明表、插入入口与渲染绑定三处，只写一份 */
export const DIVIDER_TYPE = 'core/divider'

/** 引文与代码块的类型 id：声明、插入入口与静态投影共用同一份 id */
export const QUOTE_TYPE = 'core/quote'
export const CODE_TYPE = 'core/code'

/**
 * 类型声明表。
 *
 * `outline` 是默认类型（没有 `_type` 的块都是它），所以它必须有一条声明 ——
 * 否则「按声明判能力」会先把绝大多数块判成未知。
 */
export const TYPE_DECLS: Record<string, TypeDecl> = {
  [DEFAULT_BLOCK_TYPE]: { id: DEFAULT_BLOCK_TYPE, children: 'content', text: 'editable' },
  [DIVIDER_TYPE]: { id: DIVIDER_TYPE, children: 'none', text: 'readonly', deleteOnBackspace: true },
  /**
   * **露面块**（镜像／投影）：一行标题 ＋ 一个身体，与代码块同形。
   *
   * 为什么 `children: 'none'`：它的孩子是谁这个问题有两个答案（`children` 还是源的子块），
   * 所以数据上只留一个——子块归源，露面只画。
   *
   * `text: 'editable'`：那一行是**这一次露面的名字**（`content`，可编辑）。它曾经是
   * `readonly`（名字由身体首行承担），代价是光标永远进不去 ⇒ Enter 建兄弟块、
   * `⌘⇧↵` 上建、菜单里的结构项全部落空，只剩「删除」可用。一个没有正文行的块，
   * 键盘路径整条断掉 —— 为省一行标题换来三种块三种形状，不值。
   */
  [EMBED_TYPE]: { id: EMBED_TYPE, children: 'none', text: 'editable' },
  [QUOTE_TYPE]: { id: QUOTE_TYPE, children: 'content', text: 'editable' },
  [CODE_TYPE]: { id: CODE_TYPE, children: 'content', text: 'editable', multiline: true },
}

/**
 * 这一块的类型声明。
 *
 * ⚠️ **不认识的类型降级成默认类型的声明**：未知类型仍然要画出来（兜底渲染），
 *    数据也一个字节不能丢。降级是**读侧**的事：写侧可以写进一个本版不认识的
 *    id（可能是别的版本或插件写的），读的时候不认识就按大纲行对待。
 *
 * ⚠️ **派生身份优先于 `_type`**（2026-11-26 修订）：露面块的身份来自 `props._embed`
 *    （`isEmbedBlock`），它**从来不带 `_type`** —— 所以按 `blockTypeOf` 查会落进默认
 *    类型，把「露面不许有子块」这条声明整个绕过（实测：`insertChild(露面)` 真的建出了
 *    子块，而 `TYPE_DECLS` 里明明写着 `children: 'none'`）。
 *
 *    这不是给露面开特例：**能改骨架的类型写在 `_type`，靠数据派生的身份写在数据里**，
 *    两条都要能回答「这一块长什么样、能装什么」。判据收在这一处，`children`／`text`
 *    的所有消费方（10 处）同时正确 —— 在调用点各判一次必然漏。
 */
export function typeDeclOf(b: Block): TypeDecl {
  if (isEmbedBlock(b)) return TYPE_DECLS[EMBED_TYPE] ?? TYPE_DECLS[DEFAULT_BLOCK_TYPE]!
  return TYPE_DECLS[blockTypeOf(b)] ?? TYPE_DECLS[DEFAULT_BLOCK_TYPE]!
}

/**
 * **这一行的正文能不能写**（打字、拆块、合并、程序化整段替换共用这一条）。
 *
 * `content` 是**这一块在大纲里那一行**说的话：页/标签是描述，查询/自动化是名字，
 * 代码/露面是标题（代码文档在 `_code` 里）。
 *
 * 有两类块的正文不是用户写的字：字段定义的名字（改名走命令）与日记的日期投影；
 * 还有一类块**根本没有正文**（类型声明说 `text: 'readonly'`，例如分割线）。
 * 把别的块的正文并进它们，用户只按了一次退格，换来的是一次**静默改名**
 * （更糟的是往只读的日期行里塞字，而日期行的正文恒空是一条不变量）。
 * 所以要有一道判据挡在所有内容写路径前面 —— **一条**判据，不是每个调用点各判一次。
 *
 * ⚠️ **页与标签的正文可写**：名字住在 `_aliases`，正文是描述。
 * ⚠️ **查询/自动化块不再例外**：名字就是它们那一行，与别的行同一条写路径
 *    （它们不会被合并掉——`mergeIntoPrevPlan` 拒绝有身份或有身体的块）。
 * ⚠️ 住在类型模块而不是 `model.ts`：这条判据要看类型声明，而 `model.ts` 是
 *    零依赖叶子（依赖只能从这边指向它）。放在声明旁边也更顺：它本来就是声明里的一格。
 * ⚠️ **改名不走这条判据**：改名写的是 `_aliases`，它走 `core/alias.ts`。
 */
export function canWriteText(b: Block): boolean {
  return !isJournalBlock(b) && !isPropDefBlock(b) && typeDeclOf(b).text !== 'readonly'
}

/**
 * 写一个块的类型（幂等，返回是否真的改了）。
 *
 * ⚠️ **不认识的值不拒绝**：降级是**读侧**的事（`typeDeclOf` 会把未知类型当默认类型画）。
 *    写侧不该假装认识所有类型 —— 插件或更新版本写进来的 id 在这一层被挡住，
 *    用户看到的会是「设了却没生效」，而原因在另一层。
 * ⚠️ **换类型清旧参数**：参数只对自己的骨架有意义。代码块的语言留在 `_lang`，
 *    转回别的骨架时就成了没人读的旧解释；清掉它，撤销仍一步全回。
 */
export function setBlockType(b: Block, typeId: string): boolean {
  if (blockTypeOf(b) === typeId) return false
  const props = { ...(b.props ?? {}) }
  // 默认类型不落 `_type`：没有这个键就是默认类型，多存一份等于同一件事有两个答案
  if (typeId === DEFAULT_BLOCK_TYPE) delete props._type
  else props._type = typeId
  if (typeId !== CODE_TYPE) delete props._lang
  // 代码文档只对代码骨架有意义；换回普通骨架后它就成了看不见的旧解释
  if (typeId !== CODE_TYPE) delete props._code
  // 属性袋也不留空壳：`{}` 与「没有属性」在快照比较里是两种东西
  if (Object.keys(props).length === 0) delete b.props
  else b.props = props
  return true
}

/**
 * 换骨架的准入：身份块的名字与日记的日期都不住在正文里，改 `_type` 会换掉渲染骨架
 * 却改不动那一格内容；只读类型根本没有可写正文。入口与命令处理器共用这一份判据。
 */
export function canConvertBlockType(b: Block): boolean {
  // 查询/自动化是**有身体的对象**：换骨架会留下一份读不出来的旧配置（条件/定义没有落点）
  return canWriteText(b) && !isQueryBlock(b) && !isAutomationBlock(b) && !hasList(b, 'page') && !hasList(b, 'tag')
}
