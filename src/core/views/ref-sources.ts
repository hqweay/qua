/**
 * 引用数的**唯一读法**：从入向关系边聚合出「几次 / 几个来源 / 每来源几次」。
 *
 * 只认 `REFERENCE_KINDS`（inline／property／embed）这三类：标签归属与备注是另外两种
 * 关系，不进反链 —— 与 `mount.ts:refRecords` 同一份口径，别在别处再写一遍过滤器。
 *
 * 两个数字不是一回事，也不许互相代替：
 *   · `total`   ＝ Σ count，回答「改这一块会波及几处」—— 写前预警，行尾徽标显示它；
 *   · `sources` ＝ 去重后的来源块数，回答「哪几个块引用了我」—— 列表的行数。
 * 同一个来源块引两次时 total=2、sources=1：列表那一行标「2 次」，加总与徽标对得上。
 * 把徽标改成「来源数」会丢掉「一处来源引了两次」这件事，把列表改成按次数拆行
 * 又会让「哪些块引用了我」变成一堆重复行 —— 所以两个数字都留着，由行上的次数对账。
 *
 * ⚠️ 派生的：不进 `props`、不落盘、不进撤销、不随复制带走。它是这一刻关系的事实，
 *    写进内容层就等于承认「复制一份可以短暂地不是真值」。
 */
import { isRefKind, type RefKind, type RelationEdge } from '../relations/relations.ts'

/** 一个来源块：它引用了宿主几次，以及经由哪几类关系 */
export interface RefSource {
  from: string
  count: number
  kinds: readonly RefKind[]
}

export interface RefSummary {
  /** 引用次数（Σ count）；0 ⇒ 不画徽标 */
  total: number
  /** 来源块数（按 `from` 去重） */
  sources: number
  /** 按次数降序、同次数按 id 字典序；`rows.length === sources` */
  rows: readonly RefSource[]
}

/**
 * 聚合一次入向边表。
 *
 * `count` 缺省按 1 算（`property`／`embed` 一条边就是一处；`inline` 用 count 记同块
 * 重复提及）。稳定序不用 `localeCompare`：不同 locale 下同一份数据会排出不同次序，
 * 重画一次行就跳一下。
 */
export function refSourcesOf(edges: readonly RelationEdge[]): RefSummary {
  const bySource = new Map<string, { count: number; kinds: Set<RefKind> }>()
  for (const e of edges) {
    if (!isRefKind(e.kind)) continue
    const acc = bySource.get(e.from) ?? { count: 0, kinds: new Set<RefKind>() }
    acc.count += e.count ?? 1
    acc.kinds.add(e.kind)
    bySource.set(e.from, acc)
  }
  const rows: RefSource[] = [...bySource].map(([from, a]) => ({
    from,
    count: a.count,
    kinds: [...a.kinds],
  }))
  rows.sort((a, b) => b.count - a.count || (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
  let total = 0
  for (const r of rows) total += r.count
  return { total, sources: rows.length, rows }
}
