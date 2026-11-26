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
import { EMBED_TYPE } from '../views/embed.ts'
import {
  CALLOUT_PROP,
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
/**
 * 引述块是**行容器**：它的正文是抬头（可选标题），真正的文字住在子块里——
 * 每一行一个块，各有 id ⇒ 可单独引用。判据只认类型；外观变体住 `_callout`。
 */
export function isQuoteContainer(b: Block): boolean {
  return blockTypeOf(b) === QUOTE_TYPE
}
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
   * **露面块**（镜像／投影）：它自己不写正文、不能有子块。
   *
   * 为什么 `children: 'none'`：它的孩子是谁这个问题有两个答案（`children` 还是源的子块），
   * 所以数据上只留一个——子块归源，露面只画。
   * 正文只读：那一行画的是「这次露面」的抬头与身体，不是用户写的字。
   */
  [EMBED_TYPE]: { id: EMBED_TYPE, children: 'none', text: 'readonly' },
  /** 引述是**行容器**：抬头只画变体徽章，正文住在子块里，每行一个块（可单独引用）。抬头正文只读，不会在徽章后面打字。 */
  [QUOTE_TYPE]: { id: QUOTE_TYPE, children: 'content', text: 'readonly' },
  [CODE_TYPE]: { id: CODE_TYPE, children: 'content', text: 'editable', multiline: true },
}

/**
 * 这一块的类型声明。
 *
 * ⚠️ **不认识的类型降级成默认类型的声明**：未知类型仍然要画出来（兜底渲染），
 *    数据也一个字节不能丢。降级是**读侧**的事：写侧可以写进一个本版不认识的
 *    id（可能是别的版本或插件写的），读的时候不认识就按大纲行对待。
 */
export function typeDeclOf(b: Block): TypeDecl {
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
 * ⚠️ **查询/自动化块的正文也可写**：名字就是它们那一行，与别的行同一条写路径
 *    （它们不会被合并掉——`mergeIntoPrevPlan` 拒绝有身份或有身体的块）。
 *    ⇒ 但**「按区间改写」不是这条路**：把正文里命中的词转成引用会**原地改掉名字**，
 *    那是另一件事，判据是 `canRewriteContent`（见下），不在这里放行。
 * ⚠️ 住在类型模块而不是 `model.ts`：这条判据要看类型声明，而 `model.ts` 是
 *    零依赖叶子（依赖只能从这边指向它）。放在声明旁边也更顺：它本来就是声明里的一格。
 * ⚠️ **改名不走这条判据**：改名写的是 `_aliases`，它走 `core/alias.ts`。
 */
export function canWriteText(b: Block): boolean {
  return !isJournalBlock(b) && !isPropDefBlock(b) && typeDeclOf(b).text !== 'readonly'
}

/**
 * **这一行的正文能不能按区间改写**（把命中的词换成引用、把选区转成引用……）。
 *
 * 与 `canWriteText` 回答的不是同一个问题，别合并：
 *   · `canWriteText` 问「这一行有没有可写的正文」——查询块的名字**是**正文，答「有」；
 *   · 这条问「能不能只改其中一段」——名字是一个**整体**，切掉一段再拼回去就是
 *     一次静默改名（`转换守卫页STU 查询块` → ` 查询块`，一个字节的报错都没有）。
 *     用户要改名字，走的是「正对着这一行打字」，不是「把某个词转成引用」。
 *
 * 判据与 `canWriteText` 只差一条：正文是**名字**的块（查询／自动化）不给区间改写。
 * 页与标签的正文是描述（名字在 `_aliases`），照常可改。
 */
export function canRewriteContent(b: Block): boolean {
  return canWriteText(b) && !isQueryBlock(b) && !isAutomationBlock(b)
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
  // 引述变体同理：转回正文后它只是一份没人读的旧解释
  if (typeId !== QUOTE_TYPE) delete props[CALLOUT_PROP]
  // 属性袋也不留空壳：`{}` 与「没有属性」在快照比较里是两种东西
  if (Object.keys(props).length === 0) delete b.props
  else b.props = props
  return true
}

/**
 * 换骨架的准入：身份块的名字与日记的日期都不住在正文里，改 `_type` 会换掉渲染骨架
 * 却改不动那一格内容；只读类型根本没有可写正文。入口与命令处理器共用这一份判据。
 *
 * 引述是**行容器**：抬头只读（变体徽章），但它的子块是可写内容，换骨架仍有意义
 * （例如转回正文摘掉竖线）。否则引述一旦造成就没有回头路。
 */
export function canConvertBlockType(b: Block): boolean {
  // 查询/自动化是**有身体的对象**：换骨架会留下一份读不出来的旧配置（条件/定义没有落点）
  return (
    (canWriteText(b) || isQuoteContainer(b)) &&
    !isQueryBlock(b) &&
    !isAutomationBlock(b) &&
    !hasList(b, 'page') &&
    !hasList(b, 'tag')
  )
}
