/**
 * **条件树的字段候选**：属性定义 ＋ 有明确人话入口的系统槽。
 *
 * 为什么单独一份：条件树的字段下拉、属性值的人话投影、看板分组的候选都要问
 * 「有哪些字段可以问」，而这三处各扫一遍 `propDefs` 就是三份判据。这里只答一次。
 *
 * ⚠️ **不是「所有能求值的 id」**：`{prop}` 的白名单（`core/props.ts` 的
 *    `QUERYABLE_SYSTEM_PROPS`）比这宽——`_kind`／`_tags`／`core/created`／
 *    `core/modified` 语言层认，但**没有字段级的控件能把它们问清楚**：
 *      · `_kind` 的值是内部 id，用户没有地方学到它；
 *      · `_tags` 的 `eq` 会与 `{tag}`（按名）造出同一件事的第二种写法；
 *      · `core/created`／`modified` 是毫秒，日期输入填进去对不上（它们走「时间」那一行）。
 *    它们仍可由 JSON 写成（条件树会如实显示），只是不进**字段**下拉。
 *    （`_type` **在**字段里：值域是 `TYPE_DECLS`，值控件是类型下拉——内部 id 由
 *    `typeValueLabel` 翻成人话，用户不需要自己拼。）
 *
 * 引擎属性（`core/created`／`core/modified`）**不进这里的下拉**：它们有自己的一行
 * （`kind:'stamp'` 的时间范围行，值控件是「字段 ＋ 问法 ＋ 日期」，条件里落成毫秒区间）。
 * 混进字段下拉会得到一个「日期填进毫秒」的框——对不上，还不报错。
 */
import { allPropDefs, propDisplayLabels, propKindOf, cardinalityOf, isEngineProp, systemQueryFieldLabel, QUERYABLE_SYSTEM_PROPS } from '../props/props.ts'
import type { PropKind } from '../props/props.ts'
import type { Cardinality } from '../props/props.ts'
import { CALLOUT_PROP, LANG_PROP } from '../model/model.ts'
import type { Block } from '../model/model.ts'

export interface QueryFieldOption {
  id: string
  label: string
  kind: PropKind
  cardinality?: Cardinality
  /**
   * **值域开放**：未知值照原文显示，不标「已删除」。
   *
   * `_lang` 的合法值可以来自插件/新版本（`zig`、`mermaid`），它不是「选项被删了」；
   * 条件树的值控件据此回落原文（与 `_type` 的未知 id 同一条读法）。
   */
  open?: true
  /** 这批结果里多少块带着这一栏（只在给了覆盖率时出现；渲染端拼「（n／m）」标在选项上） */
  count?: number
  /** 覆盖率分母（与 `count` 成对出现） */
  total?: number
}

/**
 * 一批结果上的字段覆盖率 —— **候选来自结果**（决策口径：字段下拉按覆盖率排序）在
 * 条件树这一面的分子与分母。「出现过」＝ 记录的属性袋里这一栏**有非空值**
 * （与分组候选 `groupChoicesOf` 同一份判据，两处各算一遍就会出现排位不同）。
 */
export interface FieldCoverage {
  /** 这批结果一共多少块（分母） */
  total: number
  counts: ReadonlyMap<string, number>
}

/**
 * 从一批记录现算覆盖率。空结果 ⇒ `undefined`：没有可数的答案就别假装知道——
 * 下拉回落全量平铺（现状），不发明一个「0 覆盖」的空推荐。
 */
export function fieldCoverageOf(records: readonly { values: Readonly<Record<string, unknown>> }[]): FieldCoverage | undefined {
  if (records.length === 0) return undefined
  const counts = new Map<string, number>()
  for (const r of records) {
    for (const [k, v] of Object.entries(r.values)) {
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) continue
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
  }
  return { total: records.length, counts }
}

/**
 * 下拉里真正列出来的系统槽（每一项都有对应的值控件与清楚的问法）。
 *
 * 加一项的前提：**用户能不查文档就填出值**。`_date` 有日期控件、`_aliases` 是名字文本、
 * `_type` 的值域是封闭注册表（`TYPE_DECLS`，值控件是类型下拉）、
 * `_callout`／`_lang` 的值域是各自的词汇表（值控件是下拉）；
 * `core/created`／`core/modified` 走「时间」行（`kind:'stamp'`），不进这一列。
 * `_tags` **不进**：「有任意标签」由标签行空值承载（拼回 `_tags exists`），
 * 而 `eq` 要标签块 id，用户填不出——下拉不给「必然填错」的入口。
 */
const QUERY_FIELD_SYSTEM_SLOTS = ['_date', '_aliases', '_type', CALLOUT_PROP, LANG_PROP] as const satisfies readonly (typeof QUERYABLE_SYSTEM_PROPS)[number][]

/**
 * 系统槽的**值形**（字段表统一前的最小一份，别在 `queryFieldsOf` 里再写三元）。
 *
 * `open` 是值域开放：`_lang` 的未知语言是合法数据（插件/新版本），值控件照原文显示；
 * `_callout` 不开放——未知 id 是「类型被删了」，显示「已删除」更诚实。
 */
const SYSTEM_SLOT_META: Record<string, { kind: PropKind; open?: true }> = {
  _date: { kind: 'date' },
  _aliases: { kind: 'text' },
  _type: { kind: 'select' },
  [CALLOUT_PROP]: { kind: 'select' },
  [LANG_PROP]: { kind: 'select', open: true },
}

/** 条件树字段下拉：属性定义（先序）＋ 系统槽；顺序＝前者按库、后者固定 */
export function queryFieldsOf(forest: readonly Block[], coverage?: FieldCoverage): QueryFieldOption[] {
  const labels = propDisplayLabels(forest)
  const defs: QueryFieldOption[] = []
  for (const def of allPropDefs(forest)) {
    if (isEngineProp(def.id)) continue
    const card = cardinalityOf(def)
    defs.push({
      id: def.id,
      label: labels.get(def.id) ?? def.id,
      kind: propKindOf(def),
      ...(card === 'many' ? { cardinality: card } : {}),
    })
  }
  for (const id of QUERY_FIELD_SYSTEM_SLOTS) {
    const label = systemQueryFieldLabel(id)
    const meta = SYSTEM_SLOT_META[id]
    if (label === undefined || meta === undefined) continue
    defs.push({ id, label, kind: meta.kind, ...(meta.open ? { open: meta.open } : {}) })
  }
  if (!coverage || coverage.total === 0) return defs
  /**
   * **候选来自结果**（与分组下拉同一条原则的条件树面）：这批结果里真有值的栏排前
   * （覆盖率降序，同数保持库序），没人有的栏殿后——**软排序，不禁选**：跨标签、
   * 临时属性仍是合法条件，只是要往下滚。系统槽不参与排序也不标注（它对任何一批
   * 结果都可问，覆盖率不携带信息）。空结果在入口就回落了，这里不会有 0 推荐假聪明。
   */
  const isSystem = new Set<string>(QUERY_FIELD_SYSTEM_SLOTS)
  const propDefs = defs.filter((f) => !isSystem.has(f.id))
  const slots = defs.filter((f) => isSystem.has(f.id))
  const withCoverage = propDefs
    .map((f, i) => ({ f, i, count: coverage.counts.get(f.id) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.i - b.i)
  return [
    ...withCoverage
      .filter((x) => x.count > 0)
      .map(({ f, count }) => ({ ...f, count, total: coverage.total })),
    ...withCoverage.filter((x) => x.count === 0).map(({ f }) => f),
    ...slots,
  ]
}
