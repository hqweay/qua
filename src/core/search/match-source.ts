/**
 * **这一块为什么能匹配这个词**：从「块 + 词」现算出来路，不依赖 FTS 的 `source`。
 *
 * 为什么不能只信 `SearchHit.source`：那是**索引**在命中时标出来的，只有 FTS 路径有；
 * 扫描降级（web、索引还没建好、重建期间）只搜正文与标签，`source` 永远是 `undefined`。
 * 于是同一个词在两个宿主上，左行有「经由 属性」、右列没有——**同一件事两份答案**。
 *
 * 判据落在**同一份来源投影**上（`sourceTextsOf`）：索引行怎么拼文本，这里就怎么判
 * 哪个来源的文本里含这个词。两边共用一份投影 ⇒ 它们不可能给出不同答案。
 *
 * ⚠️ **只按 id 查表，不遍历森林**。这条路径在扫描降级时是**每一条命中**都要走一次的
 *    （`describeHit` 逐行调），而「索引未就绪」在桌面端同样会发生（首次启动、重建期间）。
 *    用 `probeOf(整片森林)` 的话复杂度是 O(整库 × 命中数)：
 *    实测最坏情况（命中在森林末尾、50 条命中一次渲染）5,000 块 5.5ms、10,000 块 5.5ms、
 *    100,000 块 85ms。**真实规模下（个人库半年约 5k–10k）这个数用户感知不到**，
 *    所以这不是「修一个卡顿」，而是**把量级修对**：一条「每条命中走一次」的路径不该是 O(整库)。
 *    它触发的时刻（刚打开库、索引还没建好）恰好是最想搜的时候，也最难归因。
 *    所以这里传 `kb.get`（`lookupBlock` ＝ `index.blocks.get`，O(1)），
 *    与批量建索引那条（一次遍历收齐，那里本来就该是 O(N)）分成两个入口。
 *
 * ⚠️ 扫描路径能命中的来源比 FTS 少（它只搜正文与标签）：这不是这个函数的偏差，
 *    是扫描本身的覆盖面。这里如实回答「按这一份投影，哪些来源含词」——
 *    扫描搜不到别名，于是它也不会说「经由 别名」（不假装命中过）。
 */
import type { Block } from '../model/model.ts'
import { sourceTextsOf } from './rows.ts'
import { parseFtsRowKey, type FtsSource } from './sources.ts'

export interface MatchSource {
  source: FtsSource
  /** 那个来源里含这个词的那一段文本（已按来源拼好，可直接显示或再截） */
  text: string
}

/** 按 id 找块：`kb.get` 走索引表（O(1)），不要传「遍历森林」的实现 */
export type FindBlock = (id: string) => Block | undefined

/**
 * 一块的命中来路（**按来源的固定顺序**：正文在最前，它是默认来路）。
 *
 * @param find 按 id 找块（读门面）
 * @param blockId 被查的那一块
 * @param term 查询词。按空白切成多个词，要求**全部**出现才算这个来源命中——
 *   与查询的 AND 语义一致；否则「经由」会指向一个只含半个词的地方。
 */
export function matchSourcesOf(
  find: FindBlock,
  blockId: string,
  term: string,
): MatchSource[] {
  const terms = term
    .trim()
    .split(/\s+/)
    .map((x) => x.toLowerCase())
    .filter(Boolean)
  if (terms.length === 0) return []
  const out: MatchSource[] = []
  for (const row of sourceTextsOf([blockId], find)) {
    const parsed = parseFtsRowKey(row.key)
    if (!parsed || parsed.blockId !== blockId) continue
    const low = row.text.toLowerCase()
    if (!terms.every((t) => low.includes(t))) continue
    out.push({ source: parsed.source, text: row.text })
  }
  return out
}
