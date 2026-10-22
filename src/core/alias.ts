/**
 * **地址**：一个块用什么名字被找到（页名、标签名共用同一个名字空间）。
 *
 * 口径（方案 A）：
 *   · 地址（`_alias`）与正文（`text`）分离：地址负责「找到」，正文原样保留；
 *   · **同名必同一块**——页与标签不再各有一套名字空间；
 *   · 归一化（去空白、大小写折叠）**只在本文件定义一次**，所有查找都走它。
 *
 * ⚠️ 归一化只影响**比较**，不写回：`# 设计 ` 找到的是「设计」，块上的正文不会被改写。
 * ⚠️ 派生地址（`aliasOf`）在没写 `_alias` 时回落到正文 —— 首版一个块一个名字，
 *    `_alias` 是留给「地址与正文不同」的显式声明，不是第二份必须同步的真相。
 */
import { hasRole, prop, writeBlockText, type Block } from './model.ts'

/** 地址属性（系统属性；用户不可见） */
export const ALIAS_PROP = '_alias'

/** 地址的规范化 —— **唯一定义点**（tag 名、页名、`[[ ]]` 查找共用） */
export function normalizeAlias(name: string): string {
  return name.trim().toLowerCase()
}

/** 块的地址（原样，未规范化）：显式 `_alias` 优先，否则就是正文 */
export function aliasOf(b: Block): string {
  const raw = prop<unknown>(b, ALIAS_PROP)
  return typeof raw === 'string' && raw.trim() !== '' ? raw : b.text
}

/** 块的地址（规范化后的比较键） */
export function addressOf(b: Block): string {
  return normalizeAlias(aliasOf(b))
}

/**
 * 能被地址找到的块 —— **页与标签**。
 *
 * `schema` 块的正文是字段显示名（允许重名），不进地址空间；
 * 普通内容块也没有地址（它靠块 id 被引用）。
 */
export function isAddressable(b: Block): boolean {
  return hasRole(b, 'page') || hasRole(b, 'tag')
}

/**
 * 按地址找块（先序第一个命中）。
 *
 * `accept` 让调用方收窄范围（例如「只找带 tag 角色的」），但**比较永远走同一个规范化**。
 */
export function findByAlias(
  forest: readonly Block[],
  name: string,
  accept: (b: Block) => boolean = isAddressable,
): Block | undefined {
  const want = normalizeAlias(name)
  if (want === '') return undefined
  let found: Block | undefined
  const walk = (b: Block): boolean => {
    if (accept(b) && addressOf(b) === want) {
      found = b
      return true
    }
    for (const c of b.children) if (walk(c)) return true
    return false
  }
  for (const b of forest) if (walk(b)) break
  return found
}

/**
 * 给一个块写显式地址。
 *
 * ⚠️ 只写地址、不动正文：地址与正文是两个东西（正文可能带大小写与空白）。
 * ⚠️ 违反「同名必同一块」的写入由调用方先查 `findByAlias` 再决定（合并/复用/拒绝）。
 */
export function setAlias(b: Block, name: string): void {
  b.props = { ...(b.props ?? {}), [ALIAS_PROP]: name }
}

/** 改地址时同步正文（页/标签的显示名就是正文；两处一起改，避免出现「名字变了地址没变」） */
export function renameBlock(b: Block, name: string): void {
  writeBlockText(b, name)
  const raw = prop<unknown>(b, ALIAS_PROP)
  if (typeof raw === 'string' && raw.trim() !== '') setAlias(b, name)
}
