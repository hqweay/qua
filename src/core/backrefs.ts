/**
 * 反链计算 —— **纯逻辑，零 DOM**。
 *
 * 判据：右槽默认显示「谁指向了当前对象」。这是对**指向边**的一次查询，
 * 不是某个组件的事。所以算法住在这里、可脱离 DOM 单测；渲染在 `ui/`。
 *
 * ⚠️ 指向边的数据源是块内容里的引用 run——引用与标签露面都是边。
 *   **算法本身不关心边存在哪**：从 `core/index-port.ts` 的索引里查，形状不变。
 * ⚠️ 指向不存在的目标（`dangling`）**不算**入向边，但也**不许静默**——
 *   由调用方在界面上呈现（这里只返回能解析的）。
 */
import type { Block } from './index.ts'
import { incomingCount, incomingIds, rebuild, type Index } from './index-port.ts'
import { plainText } from './runs.ts'

/** 一条反链：谁指向了我。`pageId` 是来源所在的页（点开它）*/
export interface BackrefSource {
  /** 来源页的 id */
  pageId: string
  /** 引用**发生处的那个块**的正文（比页名更有信息量） */
  text: string
  /** 该页里共有几处指向我 */
  count: number
}

export interface BackrefInput {
  /** 块森林（找来源页与命中块；指向边住在块内容里） */
  blocks: Block[]
  /** 被指向的对象（当前页） */
  targetId: string
  /**
   * **预建索引**（可选）：装配层传 `store.index` ⇒ 走查表，不再扫全库。
   * 不传就现场建一份（单测与一次性调用够用，但别在渲染循环里这么干）。
   */
  index?: Index
}

/**
 * 扫出所有指向 `targetId` 的入向边，按「来源页」聚合成一条。
 *
 * 聚合判据：同一页里的多处引用**合成一条**（一个窗口对应一个来源，
 * 而不是一处引用一个窗口）。条数用 `count` 表达，不重复占列表位。
 */
export function backrefsOf(input: BackrefInput): BackrefSource[] {
  const { blocks, targetId } = input
  const idx = input.index ?? rebuild(blocks)

  // 1) **查表**拿到所有指向目标的源块（引用与标签都是指向边，索引里已经合并）
  const sources = incomingIds(idx, targetId)
  if (sources.length === 0) return []

  // 2) 归到「来源页」：`pageOf` 直接给归属，不用再遍历森林；`incomingCount` 保住「几处」
  const byPage = new Map<string, { count: number; firstText: string | null }>()
  for (const blockId of sources) {
    const pageId = idx.pageOf.get(blockId)
    const hit = idx.blocks.get(blockId)
    if (!pageId || !hit) continue
    const acc = byPage.get(pageId) ?? { count: 0, firstText: null }
    acc.count += incomingCount(idx, targetId, blockId)
    if (acc.firstText === null) acc.firstText = plainText(hit.content).trim()
    byPage.set(pageId, acc)
  }

  const out: BackrefSource[] = []
  for (const [pageId, acc] of byPage) {
    if (pageId === targetId) continue
    const page = idx.blocks.get(pageId)
    if (!page) continue
    out.push({
      pageId,
      // 命中块为空时退回页名（那也比空字符串好）
      text: acc.firstText !== null && acc.firstText !== '' ? acc.firstText : plainText(page.content),
      count: acc.count,
    })
  }
  return out
}

/**
 * **块级反链**（下一层／反链 view block）：返回「引用发生处的那个块」，
 * 而不是按来源页聚合。视图要原地编辑源块，所以必须拿到 block id。
 *
 * 与 `backrefsOf` 的分工：那个给右槽的「页级摘要」；这个给可编辑的反链视图。
 * 同一块多次引用 ⇒ 一行 + count；不同块各自一行。
 */
export interface BackrefBlock {
  blockId: string
  /** 所在顶层页（上下文/跳转用） */
  pageId: string
  text: string
  count: number
}

export function backrefBlocks(input: BackrefInput): BackrefBlock[] {
  const idx = input.index ?? rebuild(input.blocks)
  const out: BackrefBlock[] = []
  // 查表：源块清单 ＋ 次数 ＋ 归属页，全在索引里，不再遍历森林
  for (const blockId of incomingIds(idx, input.targetId)) {
    const hit = idx.blocks.get(blockId)
    const pageId = idx.pageOf.get(blockId)
    if (!hit || !pageId) continue
    out.push({ blockId, pageId, text: plainText(hit.content), count: incomingCount(idx, input.targetId, blockId) })
  }
  // 顺序：按源块在森林里的先序（`incomingIds` 是引用 run 的顺序，与原实现的「森林先序」不同，
  // 但两者都稳定可复现；这里显式声明，免得以后有人以为是巧合）
  return out
}
