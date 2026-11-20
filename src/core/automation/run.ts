/**
 * **自动化的执行层**：步骤 → 共享原语，手动链一笔事务包住（真原子）。
 *
 * 分工（与命令契约的关系）：
 *   · **命令**（`core/commands/decls.ts`）是**声明层契约**——名字、标题、args schema、
 *     `automation` 准入标记；这一层不调 handler（handler 各自开事务、还碰 UI）；
 *   · **原语**（本文件）是这批命令的**共享实现层**：一律收 `Tx` 句柄、绝不自己开事务——
 *     `kb.tx` 不可重入，事件引擎将来在触发事务**内**调 runner，步骤若经 handler
 *     写库就违反「并入触发事务」、撤销捕获会撕裂；
 *   · **runner**（本文件）把一条定义跑完：guards → 定格参数 → 一笔 tx 顺序跑原语；
 *     任一步抛错，tx 的回滚日志把内存整批退回，op 一条都不出（op 只在出口产生）。
 *
 * ⚠️ 失败的报错是**开发者面**的英文（console/throw 不走 msg）；调用方（app 层）
 *    负责把它变成 toast 与撤销记账。
 */
import { isAutomationBlock, isJournalBlock, isPropDefBlock, mkBlock, type Block } from '../model/model.ts'
import { writeBlockContent } from '../model/model.ts'
import { dateOfMs } from '../identity/journal.ts'
import { hasTag, tagIdsOf } from '../identity/tags.ts'
import { ensureTagInTx, type TagLookup } from '../kb/ensure-tag.ts'
import { formatOf, propKindOf, valuesOk } from '../props/props.ts'
import { removeRunById, refRunsOf, textRuns, type Run } from '../model/runs.ts'
import type { KbClient, Tx } from '../kb/types.ts'
import type { UndoCapture } from '../kb/scoped.ts'
import type { AutomationDef, AutomationStep } from './automation.ts'

/** 手动链可用的命令 → 原语（**闭集**：加一步先在这里立一条，递归天然进不来） */
export const STEP_COMMANDS: readonly string[] = [
  'core.props/set-value',
  'core.props/clear-value',
  'core.tags/add',
  'core.tags/remove',
  'core.tree/insert-child',
  'core.tree/move',
]

/* ------------------------------------------------------------ guards */

/** 「这条自动化现在为什么不能跑」的封闭值域（面板灰态说明与运行前拦截共用一份判据） */
export type AutomationBlockReason =
  | 'disabled'
  | 'noManual'
  | 'noTarget'
  | 'selfTarget'
  | 'whenFailed'
  | 'noSteps'
  /** `_automation` 读不出合法定义（坏形状）：灰掉并可跳转，不静默消失 */
  | 'broken'

export interface AutomationGuards {
  ok: boolean
  reason?: AutomationBlockReason
}

/**
 * 手动链的**准入守卫**。面板投影（灰掉并说明）与运行前拦截共用这一份——
 * 两个答案迟早分叉的地方只允许有一份判据。
 */
export function manualRunGuards(
  def: AutomationDef | null,
  automationId: string,
  targetId: string | undefined,
  whenOk: boolean,
): AutomationGuards {
  if (!def) return { ok: false, reason: 'noManual' }
  if (!def.enabled) return { ok: false, reason: 'disabled' }
  if (!def.triggers.some((tr) => tr === 'manual')) return { ok: false, reason: 'noManual' }
  if (def.steps.length === 0) return { ok: false, reason: 'noSteps' }
  if (targetId === undefined || targetId === '') return { ok: false, reason: 'noTarget' }
  // 防自改：规则改自己的定义（enabled／steps）没有任何合理读法，还会自我递归
  if (targetId === automationId) return { ok: false, reason: 'selfTarget' }
  if (!whenOk) return { ok: false, reason: 'whenFailed' }
  return { ok: true }
}

/* ------------------------------------------------------------ 原语 */

/** 自动化 runner 需要的读面（窄口：`tx` 之外只给按 id 找块与字段定义清单） */
export interface AutomationKb
  extends Pick<KbClient, 'get' | 'matchesSpec' | 'propDefs' | 'findTag' | 'resolveAlias' | 'roots'> {
  tx<R>(fn: (tx: Tx) => R, opts?: { directEdit?: boolean }): { result: R; undo: UndoCapture }
}

/** 步骤里显式指到别的块时，那一块必须活着（缺省目标在 guards 里已查过） */
function stepTarget(kb: AutomationKb, targetId: string, raw: unknown): string {
  if (raw === undefined || raw === null) return targetId
  const id = String(raw)
  if (id === '' || id === targetId) return targetId
  if (!kb.get(id)) throw new Error(`automation step: no such block "${id}"`)
  return id
}

/** {ref:'now'} 按值格的 kind 折算：date → 那一天的本地 ISO；其余 kind → 毫秒（形状校验兜底） */
function nowValueFor(nowMs: number, def: Block | undefined): number | string {
  if (def && propKindOf(def) === 'date') return dateOfMs(nowMs)
  return nowMs
}

function resolveArg(raw: unknown, ctx: { targetId: string; nowMs: number }): unknown {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'ref' in raw) {
    const r = (raw as { ref: unknown }).ref
    if (r === 'target') return ctx.targetId
    if (r === 'now') return ctx.nowMs
  }
  return raw
}

/** `{ref:'now'}` 还没被按 kind 折算过（resolveArg 给回毫秒）——set-value 在此二次折算 */
function isRawNow(v: unknown): v is { ref: 'now' } {
  return !!v && typeof v === 'object' && !Array.isArray(v) && (v as { ref?: unknown }).ref === 'now'
}

/** 自动化定义格：值写路径不许碰它（定义只能由显式编辑写）——闭集里没有「改自动化」 */
const AUTOMATION_PROP = '_automation'

/**
 * 移动的身份约束（标签／日记／定义这类身份块有「住顶层」的落点口径，共享执行层与机器面命令同一份）：
 * **标签／日记／定义／自动化住顶层**——位置对它们不承载信息，树操作会把住在
 * 子树里的它们当货物搬走；页是容器，搬进另一页是合法的。
 *
 * @returns 一句英文理由（开发者面）；`null` ＝ 可以搬
 */
export function moveIdentityConstraint(kb: Pick<KbClient, 'get'>, blockId: string, parentId: string | null): string | null {
  if (parentId === null) return null
  const b = kb.get(blockId)
  if (!b) return null
  const lists = b.props?._lists
  const isTag = Array.isArray(lists) && (lists as unknown[]).includes('tag')
  if (
    isTag ||
    isJournalBlock(b) ||
    isPropDefBlock(b) ||
    isAutomationBlock(b)
  ) {
    return `automation step: "${blockId}" is an identity block (tag/journal/def/automation) and lives at the forest top; moving it under "${parentId}" is refused`
  }
  return null
}

/**
 * 跑一条自动化定义的**步骤序列**（手动链）。
 *
 * 真原子：一笔 tx 包住全部步骤，`kb.tx` 的回滚日志保证「任一步失败 ⇒ 内存整批退回、
 * op 只在出口产生 ⇒ 零 op、撤销栈干净」。步骤参数的引用（`{ref:'target'}`／`{ref:'now'}`）
 * 在进 tx 前按 run 开始那一刻定格解析（`now` 逐步现取会两步跨天闹鬼）。
 *
 * @returns 撤销捕获（调用方记栈）＋实际跑了几步；guards 不过给 `null`
 *          （不跑、不报错——面板灰态已经说明过原因）
 */
export function runAutomationSteps(
  kb: AutomationKb,
  targetId: string,
  def: AutomationDef,
  opts: { now?: number; lookup?: TagLookup } = {},
): { undo: UndoCapture; stepsRun: number } | null {
  const nowMs = opts.now ?? Date.now()
  const ctx = { targetId, nowMs }
  let stepsRun = 0
  const run = kb.tx((tx) => {
    for (const step of def.steps) {
      runStepInTx(kb, tx, step, targetId, ctx, opts.lookup)
      stepsRun++
    }
  })
  return { undo: run.undo, stepsRun }
}

/** 一个步骤在共享事务内的分派（闭集查表；不认识的 cmd 直接抛——声明层没有它） */
function runStepInTx(
  kb: AutomationKb,
  tx: Tx,
  step: AutomationStep,
  targetId: string,
  ctx: { targetId: string; nowMs: number },
  lookup: TagLookup | undefined,
): void {
  const a = step.args
  switch (step.cmd) {
    case 'core.props/set-value': {
      const propId = String(resolveArg(a.propId, ctx) ?? '')
      if (propId === '') throw new Error('automation step: set-value needs propId')
      if (propId === AUTOMATION_PROP) throw new Error('automation step: cannot write the automation definition slot')
      const def = kb.propDefs().find((d) => d.id === propId)
      // {ref:'now'} 先按值格的 kind 折算（date 格要本地 ISO 日，不是毫秒），再走通用解析
      const rawValue = a.value ?? null
      const value = isRawNow(rawValue) ? nowValueFor(ctx.nowMs, def) : resolveArg(rawValue, ctx)
      if (def && !valuesOk(propKindOf(def), value)) {
        throw new Error(
          `automation step: value ${JSON.stringify(value)} not valid for kind "${propKindOf(def)}"` +
            (formatOf(def) ? ` (format "${formatOf(def)}")` : ''),
        )
      }
      tx.setProp(stepTarget(kb, targetId, a.blockId), propId, value)
      return
    }
    case 'core.props/clear-value': {
      const propId = String(resolveArg(a.propId, ctx) ?? '')
      if (propId === '') throw new Error('automation step: clear-value needs propId')
      if (propId === AUTOMATION_PROP) throw new Error('automation step: cannot clear the automation definition slot')
      tx.clearProp(stepTarget(kb, targetId, a.blockId), propId)
      return
    }
    case 'core.tags/add': {
      const blockId = stepTarget(kb, targetId, a.blockId)
      // id 优先（id 不漂）；只给名字（旧调用面）按名字找到或创建——与命令 handler 同一份判据
      const rawTagId = a.tagId !== undefined ? String(resolveArg(a.tagId, ctx)) : ''
      let tag: Block | null
      if (rawTagId !== '') {
        tag = kb.get(rawTagId) ?? null
        if (!tag) throw new Error(`automation step: tag "${rawTagId}" does not exist`)
      } else {
        const name = String(resolveArg(a.name, ctx) ?? '').trim()
        if (name === '') throw new Error('automation step: tags/add needs tagId or name')
        if (!lookup) throw new Error('automation step: tags/add by name needs a tag lookup')
        tag = ensureTagInTx(lookup, name, tx)
      }
      if (!tag) throw new Error('automation step: tags/add resolved to nothing')
      const b = kb.get(blockId)
      if (!b) throw new Error(`automation step: no such block "${blockId}"`)
      if (!hasTag(b, tag.id)) tx.setTags(blockId, [...tagIdsOf(b), tag.id])
      return
    }
    case 'core.tags/remove': {
      const blockId = stepTarget(kb, targetId, a.blockId)
      const tagId = String(resolveArg(a.tagId, ctx) ?? '')
      if (tagId === '') throw new Error('automation step: tags/remove needs tagId')
      const b = kb.get(blockId)
      if (!b) throw new Error(`automation step: no such block "${blockId}"`)
      // 与 `core.tags/remove` 同一条语义：归属连正文里的 `#名` 露面一起收（画成标签却查不到＝撒谎）
      const hits = refRunsOf(b.content).filter((r) => r.flavor === '#' && r.to === tagId)
      if (hits.length > 0) {
        const stripped: Run[] = hits.reduce(
          (acc: Run[], h) => removeRunById(acc, h.id),
          [...b.content] as Run[],
        )
        tx.patch(blockId, (bb) => writeBlockContent(bb, stripped))
      }
      if (hasTag(b, tagId)) tx.setTags(blockId, tagIdsOf(b).filter((t) => t !== tagId))
      return
    }
    case 'core.tree/insert-child': {
      const parentId = stepTarget(kb, targetId, a.parentId)
      const text = String(resolveArg(a.text, ctx) ?? '')
      // 一次 run 的所有写入共享同一格时间戳（与 `{ref:'now'}` 定格同一纪律）
      tx.insert(mkBlock(textRuns(text), { created: ctx.nowMs, modified: ctx.nowMs }), parentId, Number.MAX_SAFE_INTEGER)
      return
    }
    case 'core.tree/move': {
      const blockId = String(resolveArg(a.blockId, ctx) ?? '')
      if (blockId === '') throw new Error('automation step: move needs blockId')
      const rawParent = resolveArg(a.parentId, ctx)
      const parent = rawParent === undefined || rawParent === null || rawParent === '' ? null : String(rawParent)
      const why = moveIdentityConstraint(kb, blockId, parent)
      if (why) throw new Error(why)
      const rawPos = resolveArg(a.position, ctx)
      const idx = rawPos === undefined || rawPos === null ? Number.MAX_SAFE_INTEGER : Number(rawPos)
      tx.move(blockId, parent, Number.isFinite(idx) && idx >= 0 ? idx : Number.MAX_SAFE_INTEGER)
      return
    }
    default:
      throw new Error(`automation step: command "${step.cmd}" is not a step-capable command`)
  }
}
