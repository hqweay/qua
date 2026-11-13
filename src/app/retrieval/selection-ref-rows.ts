/**
 * **「关联到…」的候选行源**（划选气泡的逃逸口）。
 *
 * 与 `@` 源同形（`query => Row[]`），但意图不同：`@` 是「打着字顺手补一个名字」，
 * 这里是「已经选好一段字，要给它挑一个去处」。所以排序按**意图概率**：
 *   精确同名地址（默认项）→ 名字含该词的页/标签 → 正文含该词的块 → 新建。
 *
 * 行的 `parts` 直接吃 `highlightSnippet` 的结构化片段 —— 浮层的 `<mark>` 渲染
 * 就是为这个形状准备的，不需要在第二处再拼一遍高亮。
 *
 * ⚠️ 只回答「列出哪些候选」，**不写库**：选中之后走 `core.editor/selection-to-ref`，
 *    建目标与替换正文在那一笔事务里。查询过程中零副作用（撤销栈里不该有搜索步）。
 *
 * ⚠️ 与 `@` 源一样是整片森林线性扫（临时实现）：目录在**一次打开**里建一遍，
 *    接索引时换掉这一处即可，接口与两个调用点都不变。
 */
import {
  addressesOf,
  blockLabel,
  displayNameOf,
  flatten,
  hasList,
  plainText,
  type Block,
} from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import type { KbClient } from '../../core/kb/types.ts'
import { highlightSnippet } from '../../core/search/query.ts'
import type { Row } from '../../ui/overlay/layers.ts'

/** 一组最多列这么多：划选的是一两个词，正文命中可能成百上千 */
const CAP = 10

function snippet(text: string): string {
  const s = text.trim().replace(/\s+/g, ' ')
  return s.length > 60 ? `${s.slice(0, 60)}…` : s
}

export interface SelectionRefRowsDeps {
  kb: KbClient
  /** 正在划选的宿主块：不进候选（引用自己没有意义） */
  selfId: string
}

export function selectionRefRows(deps: SelectionRefRowsDeps): (query: string) => Row[] {
  const { kb, selfId } = deps
  const find = (id: string) => kb.get(id)
  const all = flatten({ roots: [...kb.roots()] }).filter((b) => b.id !== selfId)
  const nameOf = (b: Block): string => displayNameOf(b).trim() || blockLabel(b, find) || snippet(plainText(b.content))
  const trailOf = (b: Block): string => {
    const trail = kb
      .pathOf(b.id)
      .slice(0, -1)
      .map((x) => blockLabel(x, find))
      .filter((x) => x !== '')
    return trail.length > 0 ? trail.join(' › ') : nameOf(b)
  }

  return (query: string): Row[] => {
    const raw = query.trim()
    const q = raw.toLowerCase()
    const rows: Row[] = []

    /** ① 精确同名地址：老的一键行为在这里成为**默认项**（打开即选中，↵ 即完成） */
    const exact = raw === '' ? undefined : kb.resolveAlias(raw)
    if (exact && exact.id !== selfId) {
      rows.push({
        id: `selref/exact/${exact.id}`,
        label: nameOf(exact),
        hint: t('ui.selRef.exactHint'),
        icon: hasList(exact, 'page') ? 'lucide:file' : 'lucide:list-tree',
        group: 'selref/1-exact',
        pick: { kind: 'block', id: exact.id, name: nameOf(exact) },
      })
    }

    /** ② 名字含该词的页／标签：身份块，显示名就是它们的身份 */
    let named = 0
    for (const b of all) {
      if (b.id === exact?.id || !(hasList(b, 'page') || hasList(b, 'tag'))) continue
      if (q !== '' && !addressesOf(b).some((a) => a.toLowerCase().includes(q)) && !nameOf(b).toLowerCase().includes(q)) {
        continue
      }
      if (named++ >= CAP) break
      rows.push({
        id: `selref/page/${b.id}`,
        label: nameOf(b),
        hint: trailOf(b),
        icon: hasList(b, 'tag') ? 'lucide:hash' : 'lucide:file',
        group: 'retrieval/1-page',
        pick: { kind: 'block', id: b.id, name: nameOf(b) },
      })
    }

    /** ③ 正文含该词的普通块：片段高亮 ＋ 住哪（祖先链），同一段字出现几处也分得清 */
    let content = 0
    for (const b of all) {
      if (b.id === exact?.id || hasList(b, 'page') || hasList(b, 'tag')) continue
      const text = plainText(b.content)
      if (text.trim() === '') continue
      if (q !== '' && !text.toLowerCase().includes(q)) continue
      if (content++ >= CAP) break
      const parts = q === '' ? [{ text: snippet(text) }] : highlightSnippet(text, raw, 72)
      rows.push({
        id: `selref/block/${b.id}`,
        label: snippet(text),
        parts,
        hint: trailOf(b),
        icon: 'lucide:list-tree',
        group: 'retrieval/2-block',
        pick: { kind: 'block', id: b.id, name: snippet(text) },
      })
    }

    /**
     * ④ 新建：↵ 与一键默认同义（没有同名地址时就是建页），⌥↵ 强制建普通块。
     *    两种「新建」在这个模型里是同一个形状参数（打不打 `page` 露面），
     *    所以是一行 ＋ 修饰键，不是两行。
     *
     * **没有精确同名时排最前**：浮层首项预选，↵ 就严格等价于气泡那颗一键按钮
     * （有同名＝复用、没同名＝建页）。逃逸口因此不额外收一次决策的税。
     */
    if (raw !== '') {
      const fresh: Row = {
        id: 'selref/new',
        label: t('ui.selRef.new', { name: raw }),
        hint: t('ui.selRef.newHint'),
        icon: 'lucide:plus',
        group: 'retrieval/3-new',
        keyHint: t('ui.selRef.newKey'),
        pick: { kind: 'newPage', name: raw },
      }
      if (exact && exact.id !== selfId) rows.push(fresh)
      else rows.unshift(fresh)
    }
    return rows
  }
}
