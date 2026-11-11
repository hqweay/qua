/**
 * 提及栏「候选引用」的片段格：片段行上高亮名字出现处，每处一颗一键转换按钮。
 *
 * 列表与表格的命中列共用这一份画法（两处各写一套，迟早画出两种高亮）。
 * 数据由提及栏现算（`mentionSpots`／`mentionSnippet` 派生值）；这一层只画与转发——
 * 转换走命令面（一条内容写、一次撤销），不在这里碰模型。
 *
 * 高亮是**片段行上的按钮**，不进可编辑体：编辑器里的行内装饰要另一套机制，
 * 那是另一个立项的事。
 */
import { t } from '../../core/infra/msg.ts'
import type { TextPart } from '../../core/search/query.ts'
import type { MentionSpot } from '../../core/relations/mention.ts'
import type { ViewRecord } from '../../core/index.ts'

/** 一条记录上的候选引用数据（提及栏现算；别的源没有这两格） */
export interface MentionDerived {
  parts: TextPart[]
  spots: MentionSpot[]
}

/** 记录上有没有可转换的提及（有 ⇒ 命中列画片段而不是词） */
export function mentionDerivedOf(r: ViewRecord): MentionDerived | null {
  const d = r.derived
  if (!d) return null
  const parts = d.mentionSnippet
  const spots = d.mentionSpots
  if (!Array.isArray(parts) || parts.length === 0 || !Array.isArray(spots) || spots.length === 0) return null
  return { parts: parts as TextPart[], spots: spots as MentionSpot[] }
}

/**
 * 把片段画进一格：命中段是按钮，点击＝把那一处换成一枚引用。
 *
 * ⚠️ 第 k 个 mark ⇄ `spots[k]`：core 构建片段时按出现处顺序标 mark，
 *    被窗口截掉的只在尾部——这条约定不成立时按钮会接错处，改动片段构建要先看那条注释。
 */
export function renderMentionField(into: HTMLElement, m: MentionDerived, onConvert: (spot: MentionSpot) => void): void {
  into.classList.add('mention-field')
  into.replaceChildren()
  let k = 0
  for (const p of m.parts) {
    if (p.mark !== true) {
      into.appendChild(document.createTextNode(p.text))
      continue
    }
    const spot = m.spots[k++]
    if (!spot) break
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'mention-hit'
    b.textContent = p.text
    b.dataset.tip = t('ui.mount.mention.convert')
    b.addEventListener('click', (e) => {
      // 行/格上还有别的点击语义（打开块）：转换是按钮自己的动作，不许冒上去
      e.stopPropagation()
      onConvert(spot)
    })
    into.appendChild(b)
  }
}
