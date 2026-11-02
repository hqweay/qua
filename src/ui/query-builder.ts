/**
 * **条件的人话投影**（chip 与旧平铺草稿共用）。
 *
 * 条件树的编辑面住在 `ui/query-tree.ts`；这里只把一份 `QuerySpec` 说成人话：
 *   · 抬头上的 chip（收起的树、投影窗口）；
 *   · 派生栏那一句只读说明（它不是用户配的条件，也没有可编辑的落点）。
 *
 * ⚠️ `draftOfSpec` 只表达**一层平铺行**：`is`／`up`／`down`／`near` 与嵌套组都拆不动，
 *    返回 `verbatim` ⇒ 这里显示「复合条件」。不要为了 chip 好看去硬拆——拆一半再拼回去
 *    就会悄悄丢掉剩下的条件。
 */
import {
  draftOfSpec,
  type DraftOp,
  type DraftRow,
  type QuerySpec,
} from '../core/index.ts'
import { t, type MsgId } from '../core/infra/msg.ts'

const OP_TEXT: Record<DraftOp, MsgId> = {
  eq: 'ui.query.op.eq',
  neq: 'ui.query.op.neq',
  contains: 'ui.query.op.contains',
  gt: 'ui.query.op.gt',
  gte: 'ui.query.op.gte',
  lt: 'ui.query.op.lt',
  lte: 'ui.query.op.lte',
  exists: 'ui.query.op.exists',
  empty: 'ui.query.op.empty',
}

/**
 * 一行条件的**人话**（chip 与行尾提示共用）。
 *
 * 拼的是「字段名 ＋ 算子 ＋ 值」：字段名是用户数据（属性定义的显示名），
 * 算子那半截是 UI 词汇——两样都不是模型的事。
 */
export function rowLabel(
  row: DraftRow,
  fieldName: (id: string) => string,
  opText: (op: DraftOp) => string,
  /** `select` 的值：选项块 id → 选项名。不接就只能把一串 id 显示给人看 */
  choiceLabel?: (propId: string, valueId: string) => string | undefined,
): string {
  if (row.kind === 'todo') {
    const v = row.value === 'done' ? 'done' : row.value === 'none' ? 'none' : 'todo'
    return t(v === 'done' ? 'ui.query.todo.done' : v === 'none' ? 'ui.query.todo.none' : 'ui.query.todo.todo')
  }
  if (row.kind === 'tag') return `#${row.value ?? ''}`
  if (row.kind === 'text') return t('ui.query.label.text', { text: row.value ?? '' })
  const name = row.field ? fieldName(row.field) : t('ui.query.label.noField')
  const op: DraftOp = row.op ?? 'eq'
  if (op === 'exists') return t(row.value === 'false' ? 'ui.query.label.notExists' : 'ui.query.label.exists', { name })
  if (op === 'empty') return t(row.value === 'false' ? 'ui.query.label.notEmpty' : 'ui.query.label.empty', { name })
  // 走到这里 `op` 已不是 `exists`／`empty`（上面两条已 return）：值那一格才有「选项名」可言
  const raw = row.value ?? ''
  const shown = choiceLabel
    ? (choiceLabel(row.field ?? '', raw) ?? (raw === '' ? t('ui.query.builder.noValue') : raw))
    : raw
  return t('ui.query.label.cmp', { name, op: opText(op), value: shown })
}

/** 一条条件的**筛选 chip**（抬头那一行；点击打开条件树） */
export function queryChips(
  spec: QuerySpec,
  fields: readonly { id: string; label: string }[],
  /** `select` 的值要显示**选项名**而不是一串块 id */
  choices?: (propId: string) => readonly { id: string; label: string }[],
): string[] {
  const draft = draftOfSpec(spec)
  if (draft.verbatim !== undefined) return [t('ui.query.builder.complex')]
  const choiceLabel = choices
    ? (propId: string, valueId: string) => choices(propId).find((c) => c.id === valueId)?.label
    : undefined
  return draft.rows.map((row) =>
    rowLabel(
      row,
      (id) => fields.find((f) => f.id === id)?.label ?? id.slice(-6),
      (op) => t(OP_TEXT[op]),
      choiceLabel,
    ),
  )
}
