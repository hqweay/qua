/**
 * 索引行的**来源维度**：一块的「可搜文本」不止正文——地址（别名）、标签归属、
 * 属性值、链接与引用都能是命中的来路。一个来源一行，行与行互相独立：
 * 删掉别名只动别名行，改正文不碰标签行。
 *
 * 为什么单独一个文件：`rows.ts` 的计划逻辑依赖模型与存储类型，而这两把钥匙
 * （键的拼法、来源的清单）还要被**装载层**（把库里的映射行读回内存）与
 * **查询层**（把命中标上来路）使用——它们不该为此拖着模型依赖。
 * 这里零依赖：来源是一份封闭清单，键是 `块 id + 来源` 的稳定拼法。
 */

/** 一条索引行来自哪里（封闭清单：加来源要同时过计划、文本、装载三关） */
export type FtsSource = 'content' | 'alias' | 'tag' | 'prop' | 'link'

export const FTS_SOURCES: readonly FtsSource[] = ['content', 'alias', 'tag', 'prop', 'link']

/**
 * 一条索引行的身份：`块 id + 来源`。
 *
 * `BlockFTSMap` 的主键是这一对，内存映射也用它当键。分隔符用 `\u0000`：
 * 块 id 是 32 位 hex（或由它派生），控制字符不会出现在任何 id 里，
 * 所以拼出的键**总能无歧义地拆回去**。
 */
export function ftsRowKey(blockId: string, source: FtsSource): string {
  return `${blockId}\u0000${source}`
}

/** 拆回「块 id ＋ 来源」；来源不认识（旧数据／坏行）⇒ `null`，调用方整行丢弃 */
export function parseFtsRowKey(key: string): { blockId: string; source: FtsSource } | null {
  const at = key.indexOf('\u0000')
  if (at < 0) return null
  const blockId = key.slice(0, at)
  const source = key.slice(at + 1) as FtsSource
  if (blockId === '' || !FTS_SOURCES.includes(source)) return null
  return { blockId, source }
}
