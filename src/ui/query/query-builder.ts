/**
 * **条件的人话投影**（抬头 chip、收起态摘要、窄窗里的条件列表共用）。
 *
 * 单一来源是**条件树模型**（`core/query-tree.ts`）：方向、「非」、组、某一天都由它拆，
 * 这里只把一行说成人话。
 *
 * 为什么不另写一份平铺投影：曾经有过一份（一层 `all`／`any` ＋ 叶子行），
 * 它表达不了方向、`ref`／`is`／`role`／某一天 —— 这些形状的 chip 一律退化成
 * 「复合条件」。而两份投影的判据迟早分叉：同一个查询在条件树里读得懂、收起后读不懂。
 *
 * ⚠️ 这里零 DOM：`queryChips` 返回字符串，画不画、怎么排是调用方的事。
 * ⚠️ 括号与「非」的位置不是装饰：`{not:{up:{all:[A,B]}}}` ＝「没有这样的祖先（A 且 B）」，
 *    所以「非」在最外、方向次之、组在内 —— 与条件的拼装顺序同构。
 */
import {
  SELF,
  systemQueryFieldLabel,
  treeOfSpec,
  type QuerySpec,
  type TreeRow,
  type TreeNode,
} from '../../core/index.ts'
import { t, type MsgId } from '../../core/infra/msg.ts'
import type { DraftOp } from '../../core/query/query-draft.ts'

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

const DIR_TEXT: Record<'up' | 'down' | 'near', MsgId> = {
  up: 'ui.query.dir.up',
  down: 'ui.query.dir.down',
  near: 'ui.query.dir.near',
}

/** 「这一块」行挂了方向时的合并读法：值位直接嵌进介词短语（「在 项目页 之下」） */
const DIR_CHIP: Record<'up' | 'down' | 'near', MsgId> = {
  up: 'ui.query.chip.up',
  down: 'ui.query.chip.down',
  near: 'ui.query.chip.near',
}

export interface ConditionTextDeps {
  /** 属性定义（id → 显示名）；不在表里的 id 再问系统槽名字 */
  fields: readonly { id: string; label: string }[]
  /** `select` 的值是选项块 id，要换成选项名 */
  choices?: (propId: string) => readonly { id: string; label: string }[]
  /** 引用／这一块 `/` 某一块的目标 id → 名字 */
  refLabel?: (targetId: string) => string
}

/**
 * 一份条件 → 若干条 chip。
 *
 * 分组：根组**没有修饰**时每个子项一条（与「且／或 列表」的读法一致）；
 * 根组自己挂着「非」或方向时整棵树一条（那两格管的是整组，拆开就会把
 * 「非（A 且 B）」说成两条「非 A」「非 B」——语义变了）。
 *
 * 拆不动（方向里套方向、`{up:{not:…}}`、带 kind 的 `ref`…）⇒ 一条「复合条件」。
 */
export function queryChips(
  spec: QuerySpec,
  fields: readonly { id: string; label: string }[],
  choices?: (propId: string) => readonly { id: string; label: string }[],
  refLabel?: (id: string) => string,
): string[] {
  const draft = treeOfSpec(spec)
  if (!draft) return [t('ui.query.builder.complex')]
  const deps: ConditionTextDeps = { fields, choices, ...(refLabel ? { refLabel } : {}) }
  const root = draft.root
  if (root.dir !== undefined || root.not) return [sentence(root, deps, true)]
  return root.items.map((item) => sentence(item, deps, true))
}

function sentence(node: TreeNode, deps: ConditionTextDeps, topLevel: boolean): string {
  if (node.kind === 'leaf') {
    let text = rowSentence(node.row, deps)
    if (node.dir && node.row.kind === 'is') {
      // 「这一块」行：介词短语直接吃掉值位（「在 项目页 之下」），不再「短语 · 行」两截
      text = t(DIR_CHIP[node.dir], { target: targetText(node.row.target, deps) })
    } else if (node.dir) {
      text = `${t(DIR_TEXT[node.dir])} · ${text}`
    }
    if (node.not) text = t('ui.query.chipNot', { text })
    return text
  }
  const join = t(node.mode === 'any' ? 'ui.query.group.or' : 'ui.query.group.and')
  let text = node.items.map((child) => sentence(child, deps, false)).join(` ${join} `)
  /**
   * 括号只在**会读错**时出现：组里多条且它不是这一条 chip 的最外层。
   * 挂修饰的组即使在最外层也要括起来——「在…之下 ·（A 且 B）」会被读成两条并列。
   */
  if (node.items.length > 1 && (!topLevel || node.dir !== undefined || node.not)) text = `（${text}）`
  if (node.dir) text = `${t(DIR_TEXT[node.dir])} · ${text}`
  if (node.not) text = t('ui.query.chipNot', { text })
  return text
}

function rowSentence(row: TreeRow, deps: ConditionTextDeps): string {
  switch (row.kind) {
    case 'tag':
      return row.value === SELF ? t('ui.query.selfTag') : `#${row.value}`
    case 'text':
      return row.value === SELF ? t('ui.query.selfText') : t('ui.query.label.text', { text: row.value })
    case 'ref':
      return `${t('ui.query.prefix.ref')} ${targetText(row.target, deps)}`
    case 'is':
      return `${t('ui.query.prefix.is')} ${targetText(row.target, deps)}`
    case 'role':
      // 身份用名词直出（「日记」），不垫系动词——「是」是给模型看的区分
      return t(row.role === 'page' ? 'ui.query.role.page' : 'ui.query.role.journal')
    case 'day':
      return dayText(row)
    case 'stamp':
      return t('ui.query.label.stamp', {
        field: t(row.field === 'core/modified' ? 'ui.query.stamp.modified' : 'ui.query.stamp.created'),
        op: t(
          row.op === 'on' ? 'ui.query.stamp.on' : row.op === 'after' ? 'ui.query.stamp.after' : 'ui.query.stamp.before',
        ),
        date: row.date,
      })
    case 'prop':
      return propText(row, deps)
  }
}

function targetText(target: string, deps: ConditionTextDeps): string {
  if (target === SELF) return t('ui.query.rootBlock')
  return deps.refLabel?.(target) ?? target
}

function dayText(row: Extract<TreeRow, { kind: 'day' }>): string {
  if (row.date === SELF) return t('ui.query.selfDate')
  if (row.rel !== undefined) {
    if (row.rel === 0) return t('ui.query.row.today')
    return t('ui.query.row.todayOffset', { delta: `${row.rel > 0 ? '+' : ''}${row.rel}` })
  }
  return t('ui.query.row.day', { date: row.date })
}

function propText(row: Extract<TreeRow, { kind: 'prop' }>, deps: ConditionTextDeps): string {
  const name =
    deps.fields.find((f) => f.id === row.field)?.label ??
    systemQueryFieldLabel(row.field) ??
    t('ui.query.fieldMissing')
  if (row.op === 'exists') return t(row.value === 'false' ? 'ui.query.label.notExists' : 'ui.query.label.exists', { name })
  if (row.op === 'empty') return t(row.value === 'false' ? 'ui.query.label.notEmpty' : 'ui.query.label.empty', { name })
  const choice = deps.choices?.(row.field)?.find((c) => c.id === row.value)
  const shown =
    row.value === SELF ? t('ui.query.selfProp') : row.value === '' ? t('ui.query.builder.noValue') : (choice?.label ?? row.value)
  return t('ui.query.label.cmp', { name, op: t(OP_TEXT[row.op]), value: shown })
}
