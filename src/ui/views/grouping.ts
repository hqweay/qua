/**
 * **记录视图的分组分桶**：把一批记录按某一列摆进「一个值一组」的桶里。
 *
 * 从卡片列的分桶逻辑抽出，表格的分组与它共用同一份次序与多值口径——
 * 两个渲染器各写一遍，就会在「未设置」「声明序」「多值 fan-out」这些分支上各漂各的。
 *
 * 次序约定（与看板一致）：
 *   · 用户配置的组序在前（`groupOrder` 存原始值）；
 *   · 其余声明选项按声明序；
 *   · 没声明过的值按**第一次出现**；
 *   · 「未设置」永远最后。
 *
 * 多值键（`isMultiValueKey`）的口径：一块**出现在每个所属组**（fan-out）；
 * 没有值（含空串）⇒ 只进「未设置」。
 */
import { isMultiValueKey, isDerivedGroupKey, sortRecords, type ViewConfig, type ViewRecord } from '../../core/index.ts'
import { nearestPageInChain } from '../../core/identity/pages.ts'
import { t } from '../../core/infra/msg.ts'

/** 「未设置」桶的内部键。分组键带类型前缀（`s:`／`n:`…），`\u0000` 不会与真值相撞 */
export const GROUP_UNSET = '\u0000unset'

export interface GroupBucket {
  /** 内部键（带类型前缀）；「未设置」桶是 `GROUP_UNSET` */
  id: string
  /** 这一组的原始值（写回同类型用；「未设置」桶是 `undefined`） */
  raw: unknown
  records: ViewRecord[]
  unset: boolean
}

export interface BucketizeOptions {
  choices: (propId: string) => readonly { id: string; label: string }[]
  groupOrder?: readonly string[]
  /** 字段基数解析（多值字段一块进每个所属组；缺省只认 `_tags`） */
  cardinalityOf?: (propId: string) => 'one' | 'many'
  /**
   * **值的名字解析**（`ref` 等值是块 id 的字段）：`select` 的值已被 `choices`
   * 覆盖，`ref` 的值是任意块 id——没有这一档，列头/段头就把 32 位 id 露给用户。
   * 按 propId 判 kind 是调用方的事（text 组的值是普通字，不能拿去 kb 里碰）；
   * 返回 undefined ＝ 解析不了，回落原始值。
   */
  valueLabel?: (propId: string, raw: unknown) => string | undefined
}

const keyOfValue = (v: unknown): string => {
  if (v === undefined || v === null || v === '') return GROUP_UNSET
  if (typeof v === 'string') return `s:${v}`
  if (typeof v === 'number') return `n:${v}`
  if (typeof v === 'boolean') return `b:${v}`
  return `j:${JSON.stringify(v)}`
}

/** 分桶（按传入顺序稳定分桶）。`order` 是完整次序（含**还没出现**的声明值），看板的空列从它来 */
export function bucketize(
  records: readonly ViewRecord[],
  key: string,
  o: BucketizeOptions,
): { multi: boolean; buckets: GroupBucket[]; order: string[] } {
  const multi = isMultiValueKey(key, o.cardinalityOf)
  const order: string[] = []
  for (const g of o.groupOrder ?? []) {
    const k = `s:${g}`
    if (!order.includes(k)) order.push(k)
  }
  for (const c of o.choices(key)) {
    const k = `s:${c.id}`
    if (!order.includes(k)) order.push(k)
  }
  const buckets = new Map<string, GroupBucket>()
  const push = (id: string, raw: unknown, r: ViewRecord): void => {
    let b = buckets.get(id)
    if (!b) {
      b = { id, raw, records: [], unset: id === GROUP_UNSET }
      buckets.set(id, b)
      if (id !== GROUP_UNSET && !order.includes(id)) order.push(id)
    }
    b.records.push(r)
  }
  for (const r of records) {
    // 派生键的值不在属性袋里：现算（位置的推论），不进 `props`、不落盘
    const raw = isDerivedGroupKey(key) ? nearestPageInChain(r.block, r.path)?.id : r.values[key]
    // 多值字段的旧值可能是单值（定义刚从 one 切成 many）⇒ 读成一个元素，不落进「未设置」
    const values = multi
      ? Array.isArray(raw)
        ? raw
        : raw === undefined || raw === null || raw === ''
          ? []
          : [raw]
      : [raw]
    if (values.length === 0) {
      push(GROUP_UNSET, undefined, r)
      continue
    }
    for (const v of values) push(keyOfValue(v), v, r)
  }
  if (!order.includes(GROUP_UNSET)) order.push(GROUP_UNSET)
  return { multi, buckets: [...buckets.values()], order }
}

/** 按完整次序摆桶（列布局用：空列也在次序里；分组表格只摆非空桶） */
export function orderBuckets(buckets: readonly GroupBucket[], order: readonly string[]): GroupBucket[] {
  const byId = new Map(buckets.map((b) => [b.id, b]))
  const out: GroupBucket[] = []
  for (const id of order) {
    const b = byId.get(id)
    if (b) out.push(b)
  }
  return out
}

/** 桶名：`select`／`_tags` 的值走 choices，`ref` 的值走 valueLabel（块 id → 名字）；其余属性的值本身就是名字 */
export function bucketLabel(b: GroupBucket, key: string, o: BucketizeOptions): string {
  if (b.unset) return t('ui.board.unset')
  const viaChoice = o.choices(key).find((c) => c.id === b.raw)?.label
  if (viaChoice !== undefined) return viaChoice
  return o.valueLabel?.(key, b.raw) ?? String(b.raw)
}

/** 分组前的显示排序（与看板同一条：按视图配置的显示序排，不改成员集合） */
export function recordsForGrouping(records: readonly ViewRecord[], view: ViewConfig | null): ViewRecord[] {
  return sortRecords(records, view?.sort)
}
