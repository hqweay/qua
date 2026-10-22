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
import { DEFAULT_BLOCK_TYPE, blockTypeOf, type Block } from './model.ts'

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
