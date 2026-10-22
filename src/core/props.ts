/**
 * **属性定义（prop-def）与字段集合**。
 *
 * 根不变量：**字段的身份是全局 `propId`，不是它的名字。**
 *   · `propId` ＝ prop-def 块的 **id**（不另造 id 空间）；
 *   · 定义是一个普通块（正文＝显示名，`_kind` 是它的种类），住在森林顶层 ——
 *     不能住在任何一个使用者的子树里，否则删掉那个标签会带走别人的定义；
 *   · 标签/页用 `_fieldDefs`（有序 ref 列表）**声明**它可用的字段；
 *   · 值永远在**块上** `props[propId]`（一块一槽），声明只提供「可用性」。
 *
 * 字段继承**不做**：`fieldsOf` 只算**块实际打着的标签**，没有祖先闭包。
 *
 * ⚠️ `_fieldDefs` 里存的是 **ref（id）**，不是名字：改名零迁移，重名不撞车。
 * ⚠️ 本文件零 DOM：属性面板只消费这里的派生结果，写入通过命令。
 */
import { hasRole, isPropDefBlock, prop, type Block, type BlockProps } from './model.ts'
import { walkForest } from './walk.ts'
import { uuidv7Hex } from './ids.ts'
import type { Atom } from './annotations.ts'
import { tagsOf } from './tags.ts'

/** 声明列表的系统属性（有序 ref 列表；pos ＝ 数组下标） */
export const FIELD_DEFS_PROP = '_fieldDefs'

export type PropKind = 'text' | 'number' | 'date' | 'checkbox' | 'select' | 'ref' | 'url'

export const PROP_KINDS: readonly PropKind[] = ['text', 'number', 'date', 'checkbox', 'select', 'ref', 'url']

export function isPropKind(v: unknown): v is PropKind {
  return typeof v === 'string' && (PROP_KINDS as readonly string[]).includes(v)
}

/* ------------------------------------------------------------ 定义块 */

/**
 * 造一个字段定义块（**森林顶层**，正文＝显示名；`propId` 就是它的 id）。
 *
 * `id` 只给**核心词汇**用：它们的 id 必须跨重开稳定（名字 → id 走 `derivedId`），
 * 而普通用户新建的定义仍拿到随机 id —— 那条路不需要、也不该承诺稳定性。
 * 参数放在最后，现有调用点（`label`／`kind`／`extra`）不受影响。
 */
export function mkPropDef(label: string, kind: PropKind = 'text', extra: BlockProps = {}, id?: string): Block {
  return {
    id: id ?? uuidv7Hex(),
    text: label,
    children: [],
    props: { _kind: kind, ...extra },
  }
}

/** 是不是字段定义块（**看数据 `_kind`**，不看名字、也没有额外的角色值） */
export function isPropDef(b: Block): boolean {
  return isPropDefBlock(b)
}

/** 定义块上的显示名（**正文即 label**，不存第二份） */
export function propLabel(def: Block): string {
  return def.text.trim()
}

/** 定义的 kind（落盘缺省按 text：旧数据/手写定义不该让面板整段消失） */
export function propKindOf(def: Block): PropKind {
  const k = prop<unknown>(def, '_kind')
  return isPropKind(k) ? k : 'text'
}

/** 定义的选项目录（select 用；`_choices` 是字符串数组） */
export function propChoices(def: Block): string[] {
  const raw = prop<unknown>(def, '_choices')
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
}

/** 森林里全部字段定义（先序） */
export function allPropDefs(forest: readonly Block[]): Block[] {
  const out: Block[] = []
  walkForest(forest, (b) => {
    if (isPropDef(b)) out.push(b)
  })
  return out
}

/** 按 `propId` 找定义（`propId` 就是块 id） */
export function findPropDef(forest: readonly Block[], propId: string): Block | undefined {
  return allPropDefs(forest).find((d) => d.id === propId)
}

/* ------------------------------------------------------------ 声明 */

/** 一个标签/页声明了哪些字段（有序 ref 列表；悬空 ref 不静默补，交给解析方跳过） */
export function declaredFieldIds(owner: Block): string[] {
  const raw = prop<unknown>(owner, FIELD_DEFS_PROP)
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === 'string')
}

/**
 * 在标签/页上声明一个字段（幂等；追加到末尾 ＝ 显示顺序）。
 *
 * **只有页与标签能声明字段**：声明必须有自动获得方（标签的成员、页的子块），
 * 普通块没有 ⇒ 无消费方的声明是噪音。返回值说明有没有真的改动。
 */
export function declareField(owner: Block, propId: string): boolean {
  if (!hasRole(owner, 'page') && !hasRole(owner, 'tag')) return false
  const ids = declaredFieldIds(owner)
  if (ids.includes(propId)) return false
  owner.props = { ...(owner.props ?? {}), [FIELD_DEFS_PROP]: [...ids, propId] }
  return true
}

/** 解除声明（**只解除这一条**；定义块与成员块上的值都不动） */
export function undeclareField(owner: Block, propId: string): boolean {
  const ids = declaredFieldIds(owner)
  if (!ids.includes(propId)) return false
  owner.props = { ...(owner.props ?? {}), [FIELD_DEFS_PROP]: ids.filter((id) => id !== propId) }
  return true
}

/** 一个标签/页声明的字段定义（按声明顺序；解析不到的定义跳过 —— 悬空 ref 是状态） */
export function declaredFields(owner: Block, forest: readonly Block[]): Block[] {
  const byId = new Map(allPropDefs(forest).map((d) => [d.id, d]))
  const out: Block[] = []
  for (const id of declaredFieldIds(owner)) {
    const d = byId.get(id)
    if (d) out.push(d)
  }
  return out
}

/* ------------------------------------------------------------ 字段集合 */

/** 块上**自有**的属性 id（`props` 里非系统属性；有值就必然出现在这里） */
export function ownFieldIds(block: Block): string[] {
  return Object.keys(block.props ?? {}).filter((k) => !k.startsWith('_'))
}

export function valueOf(block: Block, propId: string): unknown {
  return block.props?.[propId]
}

export function hasValue(block: Block, propId: string): boolean {
  const v = valueOf(block, propId)
  if (v === undefined || v === null) return false
  if (typeof v === 'string' && v === '') return false
  if (Array.isArray(v) && v.length === 0) return false
  return true
}

/** 属性面板的一行（派生，不落库） */
export interface FieldRow {
  propId: string
  /** 显示名：定义块的正文；定义缺失时退回 propId（数据不静默消失） */
  label: string
  kind: PropKind
  value: unknown
  /** 有值 ⇔ 不是「待填」 */
  filled: boolean
  /** 定义块（缺失＝悬空定义，仍显示值） */
  def?: Block
  /** 直接标签里**声明了这个字段**的那些（按正文字段顺序）；空＝本块自有 */
  sources: Block[]
  /** 稳定排序键（声明的先后；同 propId 取最早那次） */
  order: number
}

/**
 * 属性区的全部行：**声明的字段 ∪ 块自有字段**，同一个 `propId` 只出现一次。
 *
 * ⚠️ **只算直接标签**：`#演员` 的成员不会因为 `#人物` 声明了字段就冒出那些字段。
 *    「算作」只影响成员列表（`core/tag-tree.ts` 的 `membersOf`），不影响这里。
 * ⚠️ 顺序：标签按正文顺序、标签内按 `_fieldDefs` 顺序；同一 `propId` 取**最早那次**声明，
 *    因此多标签声明同一字段时行序不会随标签集合抖动（只随正文里标签先后变）。
 * ⚠️ 块自有字段排在声明字段之后（两类性质不同：前者必有值，后者可能「待填」）。
 */
export function fieldRows(block: Block, forest: readonly Block[], atoms: readonly Atom[]): FieldRow[] {
  const defs = new Map(allPropDefs(forest).map((d) => [d.id, d]))
  const rows = new Map<string, FieldRow>()
  let order = 0

  for (const tag of tagsOf(block.id, forest, atoms)) {
    for (const propId of declaredFieldIds(tag)) {
      const existing = rows.get(propId)
      if (existing) {
        existing.sources.push(tag)
        continue
      }
      const def = defs.get(propId)
      rows.set(propId, {
        propId,
        label: def ? propLabel(def) || propId : propId,
        kind: def ? propKindOf(def) : 'text',
        value: valueOf(block, propId),
        filled: hasValue(block, propId),
        def,
        sources: [tag],
        order: order++,
      })
    }
  }

  for (const propId of ownFieldIds(block)) {
    if (rows.has(propId)) continue
    const def = defs.get(propId)
    rows.set(propId, {
      propId,
      label: def ? propLabel(def) || propId : propId,
      kind: def ? propKindOf(def) : 'text',
      value: valueOf(block, propId),
      filled: hasValue(block, propId),
      def,
      sources: [],
      order: order++,
    })
  }

  return [...rows.values()].sort((a, b) => a.order - b.order)
}

/** 字段 id 集合（模型口径的 `fieldsOf`：声明的 ∪ 自有的） */
export function fieldIdsOf(block: Block, forest: readonly Block[], atoms: readonly Atom[]): string[] {
  return fieldRows(block, forest, atoms).map((r) => r.propId)
}

/* ------------------------------------------------------------ 写值 */

/** 写一个值（**一块一槽**：键是 propId；不碰任何标签） */
export function setValue(block: Block, propId: string, value: unknown): void {
  block.props = { ...(block.props ?? {}), [propId]: value }
}

/** 删一个值（只删这一槽；声明与定义都不动） */
export function clearValue(block: Block, propId: string): void {
  if (!block.props || !(propId in block.props)) return
  const next = { ...block.props }
  delete next[propId]
  block.props = next
}

/* ------------------------------------------------------------ 摘标签后的清理 */

/**
 * 摘掉一个标签后，**可清理**的值有哪些。
 *
 * 判据（与「值留存」口径配套）：
 *   · 该标签声明了它；② 块上有值；③ **剩余标签都不声明它**（被别处声明 ⇒ 不是这一节的值）。
 * 摘标签**默认不清理**（值留存）—— 本函数只回答「清理的话会清哪些」，由用户决定。
 */
export function cleanableValues(block: Block, removedTag: Block, forest: readonly Block[], atoms: readonly Atom[]): string[] {
  const declared = declaredFieldIds(removedTag)
  if (declared.length === 0) return []
  const remaining = tagsOf(block.id, forest, atoms).filter((t) => t.id !== removedTag.id)
  const stillDeclared = new Set(remaining.flatMap((t) => declaredFieldIds(t)))
  return declared.filter((pid) => hasValue(block, pid) && !stillDeclared.has(pid))
}
