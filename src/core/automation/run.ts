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
  /** 批量运行靠「如果」圈目标：没有条件就是全库，宁可拒也不猜 */
  | 'needWhen'

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

/**
 * 批量运行的**准入守卫**（与手动链同一份值域，只是答案不同）：
 * 批量的目标集由「如果」圈出来——没有条件就不跑（没有选择器就是全库）。
 * 目标已经按条件查过 ⇒ `whenFailed`／`noTarget` 不在这条路上。
 */
export function batchRunGuards(def: AutomationDef | null): AutomationGuards {
  if (!def) return { ok: false, reason: 'noManual' }
  if (!def.enabled) return { ok: false, reason: 'disabled' }
  if (!def.triggers.some((tr) => tr === 'manual')) return { ok: false, reason: 'noManual' }
  if (def.steps.length === 0) return { ok: false, reason: 'noSteps' }
  if (def.when === undefined) return { ok: false, reason: 'needWhen' }
  return { ok: true }
}

/* ------------------------------------------------------------ 原语 */

/** 自动化 runner 需要的读面（窄口：`tx` 之外只给按 id／路径找块与字段定义清单） */
export interface AutomationKb
  extends Pick<KbClient, 'get' | 'matchesSpec' | 'propDefs' | 'findTag' | 'resolveAlias' | 'roots' | 'pathOf'> {
  /**
   * 事务入口：runner 把**全部步骤**包在这一笔里（真原子）。撤销捕获不经过这里——
   * 入口（装配层）拿到 undo 自己记账；runner 只关心「失败整批回滚」。
   */
  tx<R>(fn: (tx: Tx) => R): { result: R }
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

/** 一次步骤序列的执行上下文：目标是谁、`now` 定格在哪一刻（进 tx 前算好） */
export interface StepRunContext {
  targetId: string
  nowMs: number
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
): { stepsRun: number } | null {
  const nowMs = opts.now ?? Date.now()
  let stepsRun = 0
  kb.tx((tx) => {
    stepsRun = runStepsInTx(kb, tx, targetId, def, { targetId, nowMs }, opts.lookup)
  })
  return { stepsRun }
}

/**
 * 在**已开着的**事务里跑一条定义的全部步骤（事件引擎用：步骤并入触发事务，
 * 绝不自开——`kb.tx` 不可重入）。目标不存在等前置错误直接抛，由调用方决定
 * 这次失败牵连多大（手动链＝整笔回滚；事件链＝预检后不该发生）。
 */
export function runStepsInTx(
  kb: AutomationKb,
  tx: Tx,
  targetId: string,
  def: AutomationDef,
  ctx: StepRunContext,
  lookup?: TagLookup,
): number {
  let stepsRun = 0
  for (const step of def.steps) {
    runStepInTx(kb, tx, step, targetId, ctx, lookup)
    stepsRun++
  }
  return stepsRun
}

/**
 * 全部步骤的**干跑校验**（事件引擎的预检）：逐条过一遍每个步骤会抛的前置检查、
 * 一个字节不写。事件链与用户写入共用同一笔事务 ⇒ 不能靠回滚只退规则那一半，
 * 所以「能预先判定的失败」必须在写之前拦住（残余风险只剩写中的真 bug，落日志）。
 */
export function checkStepsInTx(
  kb: AutomationKb,
  targetId: string,
  def: AutomationDef,
  ctx: StepRunContext,
  lookup?: TagLookup,
): void {
  for (const step of def.steps) stepGuard(kb, step, targetId, ctx, lookup)
}

/** 一个步骤的**前置检查**（只判不写；与执行共用同一份判据——分两份迟早分叉） */
function stepGuard(
  kb: AutomationKb,
  step: AutomationStep,
  targetId: string,
  ctx: StepRunContext,
  lookup: TagLookup | undefined,
): void {
  const a = step.args
  const requirePropDef = (propId: string): void => {
    // 动作目标准入：只许属性定义块 id——`_` 系统键与引擎属性都不是规则该碰的格
    if (propId === '') throw new Error(`automation step: ${step.cmd} needs propId`)
    if (propId === AUTOMATION_PROP || propId.startsWith('_')) {
      throw new Error(`automation step: "${propId}" is a system slot; rules only write declared user fields`)
    }
    if (!kb.propDefs().some((d) => d.id === propId)) {
      throw new Error(`automation step: "${propId}" is not a property definition block`)
    }
  }
  switch (step.cmd) {
    case 'core.props/set-value': {
      const propId = String(resolveArg(a.propId, ctx) ?? '')
      requirePropDef(propId)
      const def = kb.propDefs().find((d) => d.id === propId)
      const rawValue = a.value ?? null
      const value = isRawNow(rawValue) ? nowValueFor(ctx.nowMs, def) : resolveArg(rawValue, ctx)
      if (!valuesOk(propKindOf(def!), value)) {
        throw new Error(
          `automation step: value ${JSON.stringify(value)} not valid for kind "${propKindOf(def!)}"` +
            (formatOf(def!) ? ` (format "${formatOf(def!)}")` : ''),
        )
      }
      stepTarget(kb, targetId, a.blockId)
      return
    }
    case 'core.props/clear-value': {
      requirePropDef(String(resolveArg(a.propId, ctx) ?? ''))
      stepTarget(kb, targetId, a.blockId)
      return
    }
    case 'core.tags/add': {
      stepTarget(kb, targetId, a.blockId)
      const rawTagId = a.tagId !== undefined ? String(resolveArg(a.tagId, ctx)) : ''
      if (rawTagId !== '') {
        if (!kb.get(rawTagId)) throw new Error(`automation step: tag "${rawTagId}" does not exist`)
        return
      }
      const name = String(resolveArg(a.name, ctx) ?? '').trim()
      if (name === '') throw new Error('automation step: tags/add needs tagId or name')
      if (!lookup) throw new Error('automation step: tags/add by name needs a tag lookup')
      // 未核定/未装载的名字在事务里拒建（与编辑器的闸同一份三态判据）：预检拦住，
      // 不让「名字归属没核定」在写中炸掉（事件链不能只回滚规则那一半）
      const state = lookup.aliasState?.(name)
      if (state && (state.kind === 'unchecked' || (state.kind === 'owned' && !state.loaded))) {
        throw new Error(`automation step: tag name "${name}" is not resolvable yet; refusing to create it in a rule`)
      }
      return
    }
    case 'core.tags/remove': {
      stepTarget(kb, targetId, a.blockId)
      if (String(resolveArg(a.tagId, ctx) ?? '') === '') {
        throw new Error('automation step: tags/remove needs tagId')
      }
      return
    }
    case 'core.tree/insert-child': {
      stepTarget(kb, targetId, a.parentId)
      return
    }
    case 'core.tree/move': {
      const blockId = String(resolveArg(a.blockId, ctx) ?? '')
      if (blockId === '') throw new Error('automation step: move needs blockId')
      if (!kb.get(blockId)) throw new Error(`automation step: no such block "${blockId}"`)
      const rawParent = resolveArg(a.parentId, ctx)
      const parent = rawParent === undefined || rawParent === null || rawParent === '' ? null : String(rawParent)
      if (parent !== null && !kb.get(parent)) throw new Error(`automation step: no such parent "${parent}"`)
      const why = moveIdentityConstraint(kb, blockId, parent)
      if (why) throw new Error(why)
      // 进自己子树：与 `tx.move` 同一份判据的预检（祖先链含目标即自环）
      if (parent !== null && kb.pathOf(parent).some((p) => p.id === blockId)) {
        throw new Error(`automation step: cannot move "${blockId}" into its own subtree`)
      }
      return
    }
    default:
      throw new Error(`automation step: command "${step.cmd}" is not a step-capable command`)
  }
}

/** 一个步骤在共享事务内的分派（闭集查表；不认识的 cmd 直接抛——声明层没有它） */
function runStepInTx(
  kb: AutomationKb,
  tx: Tx,
  step: AutomationStep,
  targetId: string,
  ctx: StepRunContext,
  lookup: TagLookup | undefined,
): void {
  // 前置检查与写入同一份判据：事件引擎的预检吃它，手动链在这里再过一遍（防御性，成本一条 if 级）
  stepGuard(kb, step, targetId, ctx, lookup)
  const a = step.args
  switch (step.cmd) {
    case 'core.props/set-value': {
      const propId = String(resolveArg(a.propId, ctx) ?? '')
      const def = kb.propDefs().find((d) => d.id === propId)!
      const rawValue = a.value ?? null
      const value = isRawNow(rawValue) ? nowValueFor(ctx.nowMs, def) : resolveArg(rawValue, ctx)
      tx.setProp(stepTarget(kb, targetId, a.blockId), propId, value)
      return
    }
    case 'core.props/clear-value': {
      tx.clearProp(stepTarget(kb, targetId, a.blockId), String(resolveArg(a.propId, ctx) ?? ''))
      return
    }
    case 'core.tags/add': {
      const blockId = stepTarget(kb, targetId, a.blockId)
      // id 优先（id 不漂）；只给名字（旧调用面）按名字找到或创建——与命令 handler 同一份判据
      const rawTagId = a.tagId !== undefined ? String(resolveArg(a.tagId, ctx)) : ''
      let tag: Block | null
      if (rawTagId !== '') {
        tag = kb.get(rawTagId) ?? null
      } else {
        const name = String(resolveArg(a.name, ctx) ?? '').trim()
        tag = ensureTagInTx(lookup!, name, tx)
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
      const rawParent = resolveArg(a.parentId, ctx)
      const parent = rawParent === undefined || rawParent === null || rawParent === '' ? null : String(rawParent)
      const rawPos = resolveArg(a.position, ctx)
      const idx = rawPos === undefined || rawPos === null ? Number.MAX_SAFE_INTEGER : Number(rawPos)
      tx.move(blockId, parent, Number.isFinite(idx) && idx >= 0 ? idx : Number.MAX_SAFE_INTEGER)
      return
    }
    default:
      throw new Error(`automation step: command "${step.cmd}" is not a step-capable command`)
  }
}
