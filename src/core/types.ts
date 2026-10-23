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
import {
  DEFAULT_BLOCK_TYPE,
  blockTypeOf,
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
   * 现在全是 `false`；多行是给将来的代码块留的能力位。
   */
  multiline?: boolean
}

/** 分割线的类型 id：出现在声明表、插入入口与渲染绑定三处，只写一份 */
export const DIVIDER_TYPE = 'core/divider'

/**
 * 类型声明表。
 *
 * `outline` 是默认类型（没有 `_type` 的块都是它），所以它必须有一条声明 ——
 * 否则「按声明判能力」会先把绝大多数块判成未知。
 */
export const TYPE_DECLS: Record<string, TypeDecl> = {
  [DEFAULT_BLOCK_TYPE]: { id: DEFAULT_BLOCK_TYPE, children: 'content', text: 'editable' },
  [DIVIDER_TYPE]: { id: DIVIDER_TYPE, children: 'none', text: 'readonly' },
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
 * **这一块的正文是不是「内容」** —— 内容写路径（合并、拆块、区间替换）只许写内容。
 *
 * 有一类块的正文是**名字或投影**，不是内容：字段定义的名字、日记的日期投影；
 * 还有一类块**根本没有正文**（类型声明说 `text: 'readonly'`，例如分割线）。
 * 把别的块的正文并进它们，用户只按了一次退格，换来的是一次**静默改名**
 * （更糟的是往只读的日期行里塞字，而日期行的正文恒空是一条不变量）。
 * 所以要有一道判据挡在所有内容写路径前面 —— **一条**判据，不是每个调用点各判一次。
 *
 * ⚠️ **页与标签的正文现在可写**：名字住在 `_aliases`，正文是描述。
 *    旧模型把标签名放在正文里，所以这里拦过 `tag`；现在拦它就等于
 *    「标签不能写描述」，而地址早已不受正文影响。
 * ⚠️ 住在类型模块而不是 `model.ts`：这条判据现在要看类型声明，而 `model.ts` 是
 *    零依赖叶子（依赖只能从这边指向它）。放在声明旁边也更顺：它本来就是声明里的一格。
 * ⚠️ **改名不走这条判据**：改名写的是 `_aliases`，它走 `core/alias.ts`。
 */
export function canWriteText(b: Block): boolean {
  return (
    !isJournalBlock(b) &&
    !isPropDefBlock(b) &&
    !isQueryBlock(b) &&
    typeDeclOf(b).text !== 'readonly'
  )
}

/**
 * 写一个块的类型（幂等，返回是否真的改了）。
 *
 * ⚠️ **不认识的值不拒绝**：降级是**读侧**的事（`typeDeclOf` 会把未知类型当默认类型画）。
 *    写侧不该假装认识所有类型 —— 插件或更新版本写进来的 id 在这一层被挡住，
 *    用户看到的会是「设了却没生效」，而原因在另一层。
 * ⚠️ **换类型不处理参数**：类型声明的参数是同一骨架里的取值，换骨架时旧参数会失去意义。
 *    现在还没有任何带参数的类型，等有第一个时再定规则 —— 这是**登记**，不是待办。
 */
export function setBlockType(b: Block, typeId: string): boolean {
  if (blockTypeOf(b) === typeId) return false
  const props = { ...(b.props ?? {}) }
  // 默认类型不落 `_type`：没有这个键就是默认类型，多存一份等于同一件事有两个答案
  if (typeId === DEFAULT_BLOCK_TYPE) delete props._type
  else props._type = typeId
  // 属性袋也不留空壳：`{}` 与「没有属性」在快照比较里是两种东西
  if (Object.keys(props).length === 0) delete b.props
  else b.props = props
  return true
}
