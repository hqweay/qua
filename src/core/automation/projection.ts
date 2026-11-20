/**
 * **自动化的命令面板投影**：带手动触发的自动化 ⇒ 一条可从面板调用的动态命令。
 *
 * 投影是**派生的，不是第二张命令表**：命令面 ＝ 静态声明 ＋ 这里的规则投影。
 * 投影条目的 id 是 `automation/<块id>`——它**不进** `CommandDecl`（声明表是构建期
 * 的封闭集合），也不带 `automation` 准入标记 ⇒ 步骤引用它天然被拒（防递归）。
 *
 * 面板里的形态判据（与 runner 的 guards 共用一份）：
 *   · 禁用的**不列**（运行一个「关着」的东西只会造成困惑）；
 *   · 事件-only（没有手动触发）的**不列**（它们在「自动化」库视图里）；
 *   · 条件不满足／没有步骤／目标不适用 ⇒ **灰掉并说明**（不是隐藏——发现性靠它）；
 *   · 定义读不出来 ⇒ 灰掉（修复面：跳到那一块）。
 */
import type { Block } from '../model/model.ts'
import type { QuerySpec } from '../query/query.ts'
import { automationIcon, automationName, readAutomation } from './automation.ts'
import { manualRunGuards, type AutomationBlockReason } from './run.ts'

export interface AutomationEntry {
  /** 投影命令 id：`automation/<块id>` */
  id: string
  /** 自动化块的块 id（运行目标定位与「跳转修复」都用它） */
  automationId: string
  /** 规则名（＝自动化块正文投影） */
  title: string
  /** 身份图标（缺省 ⚡） */
  icon: string
  runnable: boolean
  /** 不能跑的原因（灰态说明；runnable ⇒ 缺省） */
  reason?: AutomationBlockReason
}

/** 自动化投影需要的读面（`automations` 是派生列表，不是扫森林） */
export interface ProjectionKb {
  automations(): readonly Block[]
  get(id: string): Block | undefined
  matchesSpec(spec: QuerySpec, block: Block, opts?: { today?: string }): boolean
}

/**
 * 当前块上**可用的手动自动化**投影。
 *
 * `targetId` 是手动链的目标（面板运行＝当前块）；没有当前块（记录面）⇒ 全部灰成
 * `noTarget`——规则还在、可见性还在，只是这一面没有可作用的对象。
 */
export function projectManualAutomations(kb: ProjectionKb, targetId: string | undefined): AutomationEntry[] {
  const out: AutomationEntry[] = []
  for (const b of kb.automations()) {
    const def = readAutomation(b)
    // 坏形状：灰掉并说明（可跳转）——不列会让用户以为规则丢了
    if (!def) {
      out.push({
        id: `automation/${b.id}`,
        automationId: b.id,
        title: automationName(b) || b.id,
        icon: automationIcon(b),
        runnable: false,
        reason: 'broken',
      })
      continue
    }
    if (!def.enabled) continue
    if (!def.triggers.some((tr) => tr === 'manual')) continue
    // 条件对目标现算（规则少时便宜；变贵再 memo——代价已登记）
    const whenOk = def.when === undefined ? true : evaluateWhen(kb, def.when, targetId)
    const g = manualRunGuards(def, b.id, targetId, whenOk)
    out.push({
      id: `automation/${b.id}`,
      automationId: b.id,
      title: automationName(b) || b.id,
      icon: automationIcon(b),
      runnable: g.ok,
      ...(g.reason !== undefined ? { reason: g.reason } : {}),
    })
  }
  return out
}

/** 条件求值：`when` 是 QueryNode，走与查询**同一份**求值器（matchesSpec） */
function evaluateWhen(kb: ProjectionKb, when: QuerySpec['where'], targetId: string | undefined): boolean {
  if (targetId === undefined) return false
  const target = kb.get(targetId)
  if (!target) return false
  try {
    return kb.matchesSpec({ where: when }, target)
  } catch {
    // 条件引用了删掉的标签／坏形状：按「不满足」处理（灰态说得出，运行拦得住）
    return false
  }
}
