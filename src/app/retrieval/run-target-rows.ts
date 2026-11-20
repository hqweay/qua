/**
 * **「运行自动化」的目标行源**（块身体上的运行按钮）：目标可以是**任意块**——
 * 自动化作用于块（旗舰用例的目标是一块任务，不是页），收窄到页/标签是错的。
 *
 * 排序按意图概率（与「关联到…」同一族）：
 *   空词 ⇒ 页/标签先列（可浏览的默认集）；有词 ⇒ 名字命中（页/标签 → 带地址的块）
 *   → 正文命中（片段高亮 ＋ 住哪）。
 *
 * ⚠️ 与两个触发源一样是整片森林线性扫（临时实现）：目录在**一次打开**里建一遍，
 *    接索引时换掉这一处即可，调用点不变。
 * ⚠️ 只回答「列出哪些候选」：运行那一笔在 `core.automation/run` 的 guards 里
 *    （条件不满足 ⇒ 灰态说明的同一份判据）。
 */
import {
  blockLabel,
  displayNameOf,
  flatten,
  hasList,
  iconOf,
  isAddressable,
  plainText,
  type Block,
} from '../../core/index.ts'
import type { KbClient } from '../../core/kb/types.ts'
import { highlightSnippet, markTerms, termsMatch } from '../../core/search/query.ts'
import { matchedNameOf } from '../../core/search/match-source.ts'
import type { Row } from '../../ui/overlay/layers.ts'

/** 一组最多列这么多：一个词的正文命中可能成百上千 */
const CAP = 10

function snippet(text: string): string {
  const s = text.trim().replace(/\s+/g, ' ')
  return s.length > 60 ? `${s.slice(0, 60)}…` : s
}

export interface RunTargetRowsDeps {
  kb: KbClient
  /** 发起运行的自动化块：不能以自己为目标（防自改），不进候选 */
  automationId: string
}

export function runTargetRows(deps: RunTargetRowsDeps): (query: string) => Row[] {
  const { kb, automationId } = deps
  const find = (id: string) => kb.get(id)
  const all = flatten({ roots: [...kb.roots()] }).filter((b) => b.id !== automationId)
  const nameOf = (b: Block): string => displayNameOf(b).trim() || blockLabel(b, find) || snippet(plainText(b.content))
  const trailOf = (b: Block): string => {
    const trail = kb
      .pathOf(b.id)
      .slice(0, -1)
      .map((x) => blockLabel(x, find))
      .filter((x) => x !== '')
    return trail.length > 0 ? trail.join(' › ') : ''
  }
  const rowOf = (b: Block, label: string, parts: Row['parts'], group: string, hint: string): Row => ({
    id: b.id,
    label,
    ...(parts ? { parts } : {}),
    hint,
    icon: iconOf(b) ?? '',
    group,
  })

  return (query: string): Row[] => {
    const raw = query.trim()
    const rows: Row[] = []

    /** 名字命中：页/标签在前（身份块的名字就是身份），带地址的普通块随后 */
    let named = 0
    for (const b of all) {
      const identity = hasList(b, 'page') || hasList(b, 'tag')
      const hit = raw === '' ? null : matchedNameOf(b, raw)
      if (raw !== '' && !hit) continue
      if (!identity && !isAddressable(b)) continue
      if (raw === '' && !identity) continue
      if (named++ >= CAP) break
      const name = hit?.text ?? nameOf(b)
      rows.push(rowOf(b, name, markTerms(name, raw), identity ? 'pick/1-identity' : 'pick/2-named', trailOf(b)))
    }

    /** 正文命中：片段高亮 ＋ 祖先链——同一段字出现几处也分得清 */
    if (raw !== '') {
      let textHits = 0
      for (const b of all) {
        if (textHits >= CAP) break
        if (hasList(b, 'page') || hasList(b, 'tag') || isAddressable(b)) continue
        const text = plainText(b.content)
        if (text.trim() === '' || !termsMatch(text, raw)) continue
        textHits++
        rows.push(rowOf(b, snippet(text), highlightSnippet(text, raw, 72), 'pick/3-text', trailOf(b)))
      }
    }
    return rows
  }
}
