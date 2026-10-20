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
 * `page` 页｜`journal` 日记｜`backref` 反链项（右槽默认内容）｜`favorites` 收藏容器块
 *
 * ⚠️ `backref` 是**角色**而不是类型：反链项没有专属渲染行为，只是「一条指向我的引用」。
 * ⚠️ `favorites` 也只是**角色**：容器就是一个普通块（名字 = 正文，内部存一列有序引用边），
 * 没有新实体、没有新数组。
 */
export type Role = 'page' | 'journal' | 'backref' | 'favorites' | 'query'

/**
 * 系统属性 id。
 * ⚠️ **`_` 前缀 ＝ 保留区**：用户与插件不得定义，core 定义且不随插件卸载消失。
 * 这里只列当前用到的。
 */
export type SystemPropId = '_type' | '_icon' | '_date' | '_tags' | '_query' | '_queryResult'

export interface Block {
  id: string
  text: string
  children: Block[]
  /** 大纲折叠：折叠后子树不挂 DOM（**折叠态随模型快照/持久化**） */
  collapsed?: boolean
  /** 待办（demo 加的一点「产品感」，不引入新抽象） */
  todo?: TodoState
  /**
   * **属性**（承 28 「属性是块第一公民」）：任何块可直接有属性，不需标签即可赋值。
   * 键是属性 id —— **系统属性以 `_` 开头**，插件属性走 `ns/name`。
   * ⚠️ 与 `role`／`collapsed`／`todo` 的分工：那三个不是属性。
   */
  props?: BlockProps
  /**
   * **角色**（28 ）：语义机制位，不是属性。一块可以同时兼多个机制位（如 journal 也可当页）。
   * ⚠️ 这是**实现载体**：语义上角色来自角色注册表，接内核后由 `_tags` 之外的独立声明承载。
   */
  role?: Role
}

/** 属性袋：键 = 属性 id（系统属性 `_lowerCamelCase`，插件属性 `ns/kebab-name`） */
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
