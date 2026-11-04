/**
 * 一条命中怎么**说**：高亮片段、住哪（祖先链）、来路。
 *
 * 单独成一份的原因：⌘F 浮层与中心搜索面是**同一份搜索的两个尺寸**——
 * 行怎么说只有这一份答案；两处各拼一遍，高亮口径与「住哪」的兜底迟早分叉。
 */
import { blockLabel, type Block } from '../../core/index.ts'
import type { KbClient } from '../../core/kb/types.ts'
import { highlightSnippet } from '../../core/search/query.ts'
import type { FtsSource } from '../../core/search/sources.ts'
import { plainText } from '../../core/model/runs.ts'
import type { SearchHit } from './service.ts'

export interface HitView {
  blockId: string
  /** 高亮片段（正文为空 ⇒ 整行用块名——顶层块没有正文，否则看起来像坏了） */
  parts: { text: string; mark?: boolean }[]
  /** 住哪：祖先链；顶层块没有祖先，用它自己的名字（否则行里只剩一段正文，认不出出处） */
  hint: string
  /** 命中的来路（FTS 才有；扫描降级只搜正文，没有这一格） */
  source?: FtsSource
}

export function describeHit(kb: KbClient, hit: SearchHit, term: string): HitView | null {
  const b: Block | undefined = kb.get(hit.blockId)
  if (!b) return null
  const text = plainText(b.content)
  const parts =
    text.trim() === ''
      ? [{ text: blockLabel(b) }]
      : highlightSnippet(text, term)
  const trail = kb
    .pathOf(b.id)
    .slice(0, -1)
    .map((x) => blockLabel(x))
    .filter((x) => x !== '')
  const hint = trail.length > 0 ? trail.join(' › ') : blockLabel(b)
  return { blockId: b.id, parts, hint, ...(hit.source ? { source: hit.source } : {}) }
}
