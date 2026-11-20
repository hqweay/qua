/**
 * **「切换待办」要写哪一格**——纯判据，单块、批量与记录面共用一份。
 *
 * 住在 core 的理由：它只读模型、只产一个 plan；写入由调用方的事务入口执行。
 * 旧实现把这份判据放在编辑器里，于是「记录面右键切待办」只能再抄一遍——
 * 两份翻值逻辑必然漂移（`createCore` 与 `clear` 的边界最容易各写各的）。
 */
import type { Block, ClosureState } from '../model/model.ts'
import { ICON_PROP, prop } from '../model/model.ts'
import {
  TASK_STATUS_PROP_ID,
  TASK_STATUS_TODO_ID,
  allChoicesOf,
  clearValue,
  declareOwnProp,
  readField,
  setValue,
  singleValueOf,
  type FieldTable,
} from './props.ts'
import { closureTargetField, gutterFieldsOf, type GutterField } from './rows.ts'
import { CLOSURE_USE } from './uses.ts'

/**
 * 一次「切换待办」要写哪一格。
 *
 * `createCore`：这一行没有任何任务型字段 ⇒ 落核心任务状态并登记自有槽，
 * 与「第一次按 ⌘↵ ＝ 变成待办」的旧手感一致。
 * `clear`：完成型字段没有缺省值可回 ⇒ 清掉值但保留这一栏（行仍在「未填」）。
 */
export interface ClosurePlan {
  propId: string
  next?: unknown
  clear: boolean
  createCore: boolean
}

export function applyClosurePlan(b: Block, plan: ClosurePlan): void {
  if (plan.createCore) declareOwnProp(b, TASK_STATUS_PROP_ID)
  if (plan.clear) clearValue(b, plan.propId, { keepField: true })
  else setValue(b, plan.propId, plan.next)
}

/** 目标字段不存在 ⇒ 落核心任务状态（「第一次按 ⌘↵ ＝ 变成待办」） */
export function closurePlanOfField(field: GutterField | undefined): ClosurePlan {
  if (!field) return { propId: TASK_STATUS_PROP_ID, next: TASK_STATUS_TODO_ID, clear: false, createCore: true }
  // 任务状态：勾选 ⇄ 取消在**两个显式选项**之间翻，不再靠 default/清空
  if (field.use === CLOSURE_USE && field.check) {
    const next = field.value === field.check.on ? field.check.off : field.check.on
    return { propId: field.propId, next, clear: false, createCore: false }
  }
  // 同一行上别的 checkbox 字段仍是布尔翻转
  return { propId: field.propId, next: field.value !== true, clear: false, createCore: false }
}

/**
 * 这一块这一次要落哪个 plan。
 *
 * `onlyPropId` 是「点了 gutter 上哪一枚」：给了就必须命中，没命中＝不写
 * （不是退回核心状态——那会把用户点的那一栏换成另一条字段）。
 */
export function closurePlanFor(
  block: Block,
  forest: readonly Block[],
  onlyPropId?: string,
): ClosurePlan | null {
  const fields = gutterFieldsOf(block, forest)
  let field: GutterField | undefined
  if (onlyPropId !== undefined) {
    field = fields.find((f) => f.propId === onlyPropId)
    if (!field) return null
  } else {
    field = closureTargetField(fields)
  }
  return closurePlanOfField(field)
}

/** 「取消待办」要摘的那一栏（库级唯一的任务语义）；没有 ⇒ `undefined`。 */
export function closureFieldOf(block: Block, forest: readonly Block[]): GutterField | undefined {
  return gutterFieldsOf(block, forest).find((f) => f.use === CLOSURE_USE)
}

/**
 * **行内状态标记**要画的那一格：状态 ＋ propId ＋ 当前选项的图标。
 *
 * 与 `closureOf` 同一个判据（同一张 `FieldTable`、同一个 `readField`），只是多带
 * 两项呈现信息：`propId` 让点击回写知道写哪一栏，`icon` 让标记显示「当前状态」
 * 而不是一枚固定方框。仍是**派生**，不落盘。
 *
 * ⚠️ 不要求 closure 字段在 `block-left`：它可能只在面板里。行内标记读的是
 *    「这块有没有这一栏」，不是「这一栏画在哪」。
 * ⚠️ 目标块不在当前森林 ⇒ 返回 `undefined`，呈现层不假装有状态。
 */
export interface ClosureMark {
  state: ClosureState
  propId: string
  icon?: string
}

export function closureMarkOf(
  block: Block,
  table: FieldTable,
  find: (id: string) => Block | undefined,
): ClosureMark | undefined {
  const binding = table.byUse.get(CLOSURE_USE)?.find((b) => b.check !== undefined)
  const check = binding?.check
  if (!binding || !check) return undefined
  const def = find(binding.defId)
  if (!def) return undefined
  const { declared, value } = readField(block, binding.defId, table)
  if (!declared) return undefined
  const valueId = singleValueOf(value)
  const state: ClosureState = valueId === check.on ? 'closed' : 'open'
  const choice = valueId === '' ? undefined : allChoicesOf(def).find((c) => c.id === valueId)
  const icon = choice?.icon ?? prop<string>(def, ICON_PROP)
  return { state, propId: binding.defId, icon }
}
