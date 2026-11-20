/**
 * **事件引擎**：tx 出口的 reaction——「数据变了就跑」的那一半。
 *
 * 四条不变量（实现落点）：
 *   1. **只对初始变更集求值**：reactor 拿到的 `initial` 是 fn 写完那一刻的快照；
 *      规则自己写出的变化进同一张 touched 表、但不进求值 ⇒ 防循环；
 *   2. **值没真变不算变化**：prop 触发器吃 `sameValue`（与 setValue 写时刻同一份判据）；
 *   3. **规则写入并入触发事务**：同一个 tx 句柄 ⇒ 同一批 op、一次撤销全退；
 *   4. **重放／同步／撤销不触发**：reactor 只挂在 `MemoryKb.tx` 成功出口——
 *      `applyOps`（重放、undo/redo 的应用路径）不经过它 ⇒ 多端不重复记。
 *
 * 失败语义（与手动链的差异，代价已登记）：事件链与用户写共用同一笔事务，
 * 不能「只回滚规则那一半」——所以**能预先判定的失败在写之前拦住**（`checkStepsInTx`
 * 干跑，与执行同一份判据）；预检不过 ⇒ 跳过这条反应，用户的写照常提交；
 * 写中异常（理论上只剩真 bug）捕获落日志，不向上抛——reactor 抛出会回滚用户的输入。
 *
 * 成本纪律：每次 tx 出口先做 O(1) 的「有没有规则」检查；触发索引按自动化的派生列表
 * **数组身份**缓存（列表只在规则变化时重建），匹配只吃 touched 的前后值——
 * 不扫森林。两条规则写同一格 ⇒ 先序稳定序（确定性；优先级 UI 不在 v1）。
 */
import { type Block } from '../model/model.ts'
import { sameValue, passThroughRefTarget } from '../props/props.ts'
import type { QueryNode } from '../query/query.ts'
import type { TagLookup } from '../kb/ensure-tag.ts'
import type { Tx } from '../kb/types.ts'
import type { TouchedBlock } from '../kb/diff.ts'
import { readAutomation, type AutomationDef, type AutomationTrigger } from './automation.ts'
import { checkStepsInTx, runStepsInTx, type AutomationKb } from './run.ts'

/** 一条已登记的规则（索引与执行共用） */
interface IndexedRule {
  id: string
  def: AutomationDef
}

/** 触发索引：触发键 → 规则。建一遍、按派生列表的数组身份失效——每笔 tx 不扫森林 */
interface TriggerIndex {
  rules: IndexedRule[]
  propRules: Map<string, IndexedRule[]>
  tagRules: Map<string, IndexedRule[]>
  childAdded: IndexedRule[]
}

export interface AutomationEngineDeps {
  kb: AutomationKb & { automations(): readonly Block[] }
  /** 按名字建标签的解析口（缺省传 `kb` 自己；工作集模式带 aliasState 拒未核定名） */
  lookup?: TagLookup
  /** 规则失败的落点（v1：console；「最近运行」记录另立项） */
  onError?: (info: { ruleId: string; targetId: string; error: unknown }) => void
}

export interface ReactContext {
  tx: Tx
  /** fn 写完那一刻的 touched 快照（初始变更集；reactor 自己的写入不在里面） */
  initial: readonly TouchedBlock[]
}

export interface ReactResult {
  ran: number
  failed: number
}

export function createAutomationEngine(deps: AutomationEngineDeps) {
  const { kb } = deps
  let cachedList: readonly Block[] | null = null
  let index: TriggerIndex | null = null

  /** 触发索引只在规则清单换数组时重建（数组身份 ⇒ 列表真变了） */
  const rules = (): TriggerIndex | null => {
    const list = kb.automations()
    if (index !== null && cachedList === list) return index
    cachedList = list
    const next: TriggerIndex = { rules: [], propRules: new Map(), tagRules: new Map(), childAdded: [] }
    for (const b of list) {
      const def = readAutomation(b)
      if (!def || !def.enabled) continue
      const rule: IndexedRule = { id: b.id, def }
      next.rules.push(rule)
      for (const tr of def.triggers) {
        if (tr === 'manual') continue
        if (tr.kind === 'prop') {
          const bucket = next.propRules.get(tr.prop)
          if (bucket) bucket.push(rule)
          else next.propRules.set(tr.prop, [rule])
        } else if (tr.kind === 'tag') {
          const bucket = next.tagRules.get(tr.tag)
          if (bucket) bucket.push(rule)
          else next.tagRules.set(tr.tag, [rule])
        } else {
          next.childAdded.push(rule)
        }
      }
    }
    index = next.rules.length === 0 ? null : next
    return index
  }

  /**
   * 父块筛选：QueryNode 作用在**父块**上；`followRefs`（默认关）沿传递型引用展开，
   * 与 `_childProps` 的解析链同一条（passThroughRefTarget ＋ seen 防环）。
   */
  const parentMatches = (parent: Block | undefined, query: QueryNode | undefined, followRefs: boolean, seen: ReadonlySet<string>): boolean => {
    if (!parent) return false
    if (!query) return true
    if (seen.has(parent.id)) return false
    const nextSeen = new Set(seen).add(parent.id)
    if (kb.matchesSpec({ where: query }, parent)) return true
    if (!followRefs) return false
    const target = passThroughRefTarget(parent)
    if (!target) return false
    return parentMatches(kb.get(target), query, followRefs, nextSeen)
  }

  /** 这一条变更触发这条规则吗（只读 touched 的前后值，不写） */
  const fires = (entry: TouchedBlock, rule: IndexedRule): boolean => {
    const b = entry.block
    if (b.id === rule.id) return false // 防自改
    for (const tr of rule.def.triggers) {
      if (tr === 'manual') continue
      if (tr.kind === 'prop') {
        if (entry.before === null) continue
        const beforeValue = (entry.before.cells.props as Record<string, unknown> | undefined)?.[tr.prop]
        const afterValue = b.props?.[tr.prop]
        if (sameValue(beforeValue, afterValue)) continue // 值没真变不算变化
        if (tr.to !== undefined && !sameValue(afterValue, tr.to)) continue
        return true
      }
      if (tr.kind === 'tag') {
        if (entry.before === null) continue
        const beforeTags = entry.before.cells.props?._tags
        const afterTags = b.props?._tags
        const was = Array.isArray(beforeTags) && (beforeTags as unknown[]).includes(tr.tag)
        const is = Array.isArray(afterTags) && (afterTags as unknown[]).includes(tr.tag)
        if (tr.on === 'added' && !was && is) return true
        if (tr.on === 'removed' && was && !is) return true
        continue
      }
      // child.added：新块（before === null）按落点找直接父块；move 不算（child.entered 未立项）
      if (entry.before === null && entry.afterPlacement !== undefined) {
        const parentId = entry.afterPlacement.parent
        const parent = parentId === null ? undefined : kb.get(parentId)
        const query = tr.parent === undefined ? undefined : ({ is: tr.parent } as QueryNode)
        if (parentMatches(parent, query, tr.followRefs === true, new Set())) return true
      }
    }
    return false
  }

  return {
    /** 探针：当前索引里有几条可执行规则（诊断面用） */
    ruleCount(): number {
      return rules()?.rules.length ?? 0
    },

    /**
     * tx 出口的 reaction。**不许抛**——每条规则各自兜错，失败只计数、不牵连
     * 用户的写（语义见文件头）。
     */
    react(ctx: ReactContext): ReactResult {
      const idx = rules()
      if (!idx) return { ran: 0, failed: 0 }
      // 事件目标按 (规则, 目标) 去重：一条变更命中同一规则的多个触发只跑一次
      const seen = new Set<string>()
      // 先序稳定序（规则在森林先序、目标在 touched 序）：两条规则写同一格时谁赢是确定的
      const plan: { rule: IndexedRule; targets: string[] }[] = []
      for (const rule of idx.rules) {
        const targets: string[] = []
        for (const entry of ctx.initial) {
          if (!fires(entry, rule)) continue
          // 条件对目标现算（当前状态）：prop 触发器读到的就是刚写完的值
          if (rule.def.when !== undefined && !kb.matchesSpec({ where: rule.def.when }, entry.block)) continue
          const key = `${rule.id}\u0000${entry.block.id}`
          if (seen.has(key)) continue
          seen.add(key)
          targets.push(entry.block.id)
        }
        if (targets.length > 0) plan.push({ rule, targets })
      }
      if (plan.length === 0) return { ran: 0, failed: 0 }
      let ran = 0
      let failed = 0
      // `now` 整批定格一次（逐步现取会两步跨天闹鬼——与手动链同一纪律）
      const nowMs = Date.now()
      for (const { rule, targets } of plan) {
        for (const targetId of targets) {
          try {
            // 预检：能预先判定的失败在写之前拦住（事件链不能只回滚规则那一半）
            checkStepsInTx(kb, targetId, rule.def, { targetId, nowMs }, deps.lookup)
            runStepsInTx(kb, ctx.tx, targetId, rule.def, { targetId, nowMs }, deps.lookup)
            ran++
          } catch (error) {
            failed++
            deps.onError?.({ ruleId: rule.id, targetId, error })
          }
        }
      }
      return { ran, failed }
    },
  }
}

/** 触发器是不是事件类（UI 显示与测试用；manual 之外全是） */
export function isEventTrigger(tr: AutomationTrigger): tr is Exclude<AutomationTrigger, 'manual'> {
  return tr !== 'manual'
}

/** 引擎需要的触发器上下文取值（诊断用） */
export function triggerKey(tr: AutomationTrigger): string {
  if (tr === 'manual') return 'manual'
  if (tr.kind === 'prop') return `prop:${tr.prop}${tr.to !== undefined ? `=${tr.to}` : ''}`
  if (tr.kind === 'tag') return `tag:${tr.tag}:${tr.on}`
  return 'child.added'
}
