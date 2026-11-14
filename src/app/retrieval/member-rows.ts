/**
 * **`#` 第二段（成员搜索）的行**：某个标签的成员（按**成员文本**过滤）＋ 一行「新建实例」。
 *
 * 为什么单独一份：第一段（`triggers.ts` 的 `tagRows`）的候选构建要引用浮层的行装配
 * （斜杠命令的绑定渲染），而这一份是**纯判据**——只读森林、只产出行数据。
 * 分开才能被单测直接钉住（测试环境跑不了浮层那一份 DOM 装配）。
 *
 * 与第一段的两个分工差异：
 *   · 第一段的查询词匹配**标签名**，成员是「命中标签的全部成员」——成员自己的文本不参与；
 *     第二段反过来：标签已定，查询词匹配**成员文本**（`plainText` 投影，大小写不敏感）。
 *   · 「新建」行的目标也不同：第一段建**标签**，第二段建**实例**（名字＝输入文本）。
 *
 * ⚠️ 线性扫与 `@` 源同款：接口保持 `query => Row[]`，接全文索引时换这一个函数。
 * ⚠️ 空查询不列「新建实例」行：名字是空的记录没有可读的正文，那一行只会引出怪结果。
 */
import {
  blockLabel,
  findInForest,
  hasIdentity,
  iconOf,
  plainText,
  tagIdsOf,
  walkForest,
} from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import type { Block } from '../../core/index.ts'
import type { Row } from '../../ui/overlay/layers.ts'

/** 实例／成员一栏的上限：不设的话浮层永远滚不到底（与第一段同一个数） */
export const INSTANCE_CAP = 20

/** 第二段锚定的标签：已有标签带 id；名字留作标题与兜底（标签在落点那一笔才建时还没有 id） */
export interface MemberTagRef {
  tagId?: string
  name: string
}

export function memberRows(tag: MemberTagRef, query: string, deps: MemberDeps): Row[] {
  const rows: Row[] = []
  const want = query.trim().toLowerCase()
  const selfId = deps.selfBlockId()
  const exactExists = { hit: false }
  if (tag.tagId) {
    const hits: { row: Row; modified: number }[] = []
    walkForest(deps.forest(), (b) => {
      if (b.id === selfId || hasIdentity(b)) return
      if (!tagIdsOf(b).includes(tag.tagId!)) return
      const name = plainText(b.content).trim()
      if (name === '') return
      if (name.toLowerCase() === want) exactExists.hit = true
      if (want !== '' && !name.toLowerCase().includes(want)) return
      // 呈现摘要 ＋ 唯一兜底（匹配语义不动：上面按 plainText 过滤的口径照旧）
      const label = blockLabel(b, (id) => findInForest(deps.forest(), id))
      hits.push({
        modified: b.modified,
        row: {
          id: `retrieval/obj/${b.id}`,
          label: `#${label}`,
          hint: `#${tag.name}`,
          // 实例是普通块：空白但占位（iconOf 给显式图标让路——实例配了脸就跟着走）
          icon: iconOf(b) ?? '',
          group: 'retrieval/1-instance',
          pick: { kind: 'instance', id: b.id, name: label, tag: tag.name, tagId: tag.tagId! },
        },
      })
    })
    rows.push(...hits.sort((a, b) => b.modified - a.modified).slice(0, INSTANCE_CAP).map((h) => h.row))
  }
  const trimmed = query.trim()
  if (trimmed !== '' && !exactExists.hit) {
    rows.push({
      id: `retrieval/newObj/${trimmed}`,
      label: t('ui.retrieval.newInstance', { name: trimmed }),
      hint: t('ui.retrieval.newInstanceHint', { tag: tag.name }),
      icon: 'lucide:plus',
      group: 'retrieval/3-new',
      pick: { kind: 'newObj', name: trimmed, tagId: tag.tagId, tag: tag.name },
    })
  }
  return rows
}

/** 成员搜索问得到的东西：整片森林（现取）与「正在打字的这一块」（排除自我引用） */
export interface MemberDeps {
  forest: () => readonly Block[]
  selfBlockId: () => string | null
}
