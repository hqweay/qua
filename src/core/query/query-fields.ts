/**
 * **条件树的字段候选**：属性定义 ＋ 有明确人话入口的系统槽。
 *
 * 为什么单独一份：条件树的字段下拉、属性值的人话投影、看板分组的候选都要问
 * 「有哪些字段可以问」，而这三处各扫一遍 `propDefs` 就是三份判据。这里只答一次。
 *
 * ⚠️ **不是「所有能求值的 id」**：`{prop}` 的白名单（`core/props.ts` 的
 *    `QUERYABLE_SYSTEM_PROPS`）比这宽——`_kind`／`_type`／`_tags`／`core/created`／
 *    `core/modified` 语言层认，但**没有字段级的控件能把它们问清楚**：
 *      · `_kind`／`_type` 的值是内部 id，用户没有地方学到它；
 *      · `_tags` 的 `eq` 会与 `{tag}`（按名）造出同一件事的第二种写法；
 *      · `core/created`／`modified` 是毫秒，日期输入填进去对不上（它们走「时间」那一行）。
 *    它们仍可由 JSON 写成（条件树会如实显示），只是不进**字段**下拉。
 *
 * 引擎属性（`core/created`／`core/modified`）**不进这里的下拉**：它们有自己的一行
 * （`kind:'stamp'` 的时间范围行，值控件是「字段 ＋ 问法 ＋ 日期」，条件里落成毫秒区间）。
 * 混进字段下拉会得到一个「日期填进毫秒」的框——对不上，还不报错。
 */
import { allPropDefs, propDisplayLabels, propKindOf, cardinalityOf, isEngineProp, systemQueryFieldLabel } from '../props/props.ts'
import type { PropKind } from '../props/props.ts'
import type { Cardinality } from '../props/props.ts'
import type { Block } from '../model/model.ts'

export interface QueryFieldOption {
  id: string
  label: string
  kind: PropKind
  cardinality?: Cardinality
}

/**
 * 下拉里真正列出来的系统槽（每一项都有对应的值控件与清楚的问法）。
 *
 * 加一项的前提：**用户能不查文档就填出值**。`_date` 有日期控件、`_aliases` 是名字文本；
 * `_tags` 要等标签选择器（且只该有「有标签」这一档，避免与 `{tag}` 重复），
 * `core/created`／`core/modified` 走「时间」行（`kind:'stamp'`），都不进这一列。
 */
const QUERY_FIELD_SYSTEM_SLOTS: readonly string[] = ['_date', '_aliases']

/** 条件树字段下拉：属性定义（先序）＋ 系统槽；顺序＝前者按库、后者固定 */
export function queryFieldsOf(forest: readonly Block[]): QueryFieldOption[] {
  const labels = propDisplayLabels(forest)
  const out: QueryFieldOption[] = []
  for (const def of allPropDefs(forest)) {
    if (isEngineProp(def.id)) continue
    const card = cardinalityOf(def)
    out.push({
      id: def.id,
      label: labels.get(def.id) ?? def.id,
      kind: propKindOf(def),
      ...(card === 'many' ? { cardinality: card } : {}),
    })
  }
  for (const id of QUERY_FIELD_SYSTEM_SLOTS) {
    const label = systemQueryFieldLabel(id)
    if (label === undefined) continue
    out.push({ id, label, kind: id === '_date' ? 'date' : 'text' })
  }
  return out
}
