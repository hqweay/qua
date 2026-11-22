/**
 * **事件引擎**：tx 出口的 reaction——「数据变了就跑」的那一半。
 *
 * 触发器是统一形状 `{on, query, birth?}`：**同一门条件语言对前后两个状态各求值一次**，
 * 按事件轴取边沿——`entered`（不满足→满足）、`left`（满足→不满足）、`changed`
 * （前后均满足且引用原子真变）。before 侧经一个很小的主体适配器进同一台求值器
 * （不克隆整块、不造第二求值器）；`{up}` 只活在诞生时刻——birth 触发器对**容纳链**
 * （真父链；传递型引用行只在触发器开了 `followRefs` 时透明——默认透传会把规则的写入
 * 落到引用行的目标上，而用户那一行看起来只是「挂在引用下面」）
 * 求值一次，before 侧完全不求值祖先。
 *
 * 四条不变量（实现落点）：
 *   1. **只对初始变更集求值**：reactor 拿到的 `initial` 是 fn 写完那一刻的快照；
 *      规则自己写出的变化进同一张 touched 表、但不进求值 ⇒ 防循环；
 *   2. **值没真变不算变化**：prop 原子按 `{exists, value}` 对比较（缺失是独立状态），
 *      与 `setValue` 写时刻同一份判据；
 *   3. **规则写入并入触发事务**：同一个 tx 句柄 ⇒ 同一批 op、一次撤销全退；
 *   4. **重放／同步／撤销不触发**：reactor 只挂在 `MemoryKb.tx` 成功出口——
 *      `applyOps`（重放、undo/redo 的应用路径）不经过它 ⇒ 多端不重复记。
 *
 * 生命周期（exist 不是查询原子——判定只看数据原子与诞生）：
 *   · **after 已删 ⇒ 跳过**：删前最后一笔修改不许对死目标动作（改前引擎会成功写进
 *     死目标——reactor 跑在索引修补之前，这条守卫是修复不是装饰）；
 *   · 纯删除／纯恢复：原子没变 ⇒ 天然静默；恢复＋同笔修改按真实原子判定。
 *
 * 失败语义（与手动链的差异，代价已登记）：事件链与用户写共用同一笔事务，
 * 不能「只回滚规则那一半」——所以**能预先判定的失败在写之前拦住**（`checkStepsInTx`
 * 干跑，与执行同一份判据）；预检不过 ⇒ 跳过这条反应，用户的写照常提交；
 * 写中异常（理论上只剩真 bug）捕获落日志，不向上抛——reactor 抛出会回滚用户的输入。
 *
 * 成本纪律：每次 tx 出口先做 O(1) 的「有没有规则」检查；候选按**静态依赖倒排**收
 * （原子变化 ∩ 规则依赖；诞生边沿没有「变化的原子」⇒ 全量进 entered 候选——含 up 的
 * 规则也在其中），索引收候选、完整求值做判定；匹配只吃 touched 的前后值，不扫森林。
 * 两条规则写同一格 ⇒ 先序稳定序（确定性；优先级 UI 不在 v1）。
 */
import { isDeleted, type Block } from '../model/model.ts'
import { sameValue, passThroughRefTarget } from '../props/props.ts'
import type { QueryNode } from '../query/query.ts'
import type { TagLookup } from '../kb/ensure-tag.ts'
import type { Tx } from '../kb/types.ts'
import type { TouchedBlock } from '../kb/diff.ts'
import { readAutomation, followsRefs, type AutomationDef, type AutomationTrigger } from './automation.ts'
import { triggerDeps, type TriggerDeps } from './trigger-query.ts'
import { checkStepsInTx, runStepsInTx, type AutomationKb } from './run.ts'

/** 一条已登记的规则（索引与执行共用）；触发器在登记时编译一次 */
interface IndexedRule {
  id: string
  def: AutomationDef
  triggers: CompiledTrigger[]
  /** 有没有 entered 触发器——诞生边沿的候选网（entered 对「出生即满足」开火） */
  hasEntered: boolean
}

/** 编译好的触发器：up 拆成容纳链上的条件，self 部分留整树；依赖一次提取 */
interface CompiledTrigger {
  tr: Exclude<AutomationTrigger, 'manual'>
  /** 去掉 up 之后剩的 self 条件（整条都是 placement 时为 null） */
  self: QueryNode | null
  /** up 的内部条件（合法形状只在顶层或顶层 all 的直接成员位；诞生时刻对容纳链求值） */
  placement: QueryNode[]
  deps: TriggerDeps
}

/** up 拆解：{up:P} 与 {all:[{up:P1},…rest]} 两种合法形状精确处理；其余（腐坏数据）整条当 self 求值 */
function compileTriggerQuery(query: QueryNode): { self: QueryNode | null; placement: QueryNode[] } {
  if ('up' in query) return { self: null, placement: [query.up] }
  if ('all' in query) {
    const placement = query.all.filter((m): m is QueryNode & { up: QueryNode } => 'up' in m).map((m) => m.up)
    if (placement.length === 0) return { self: query, placement: [] }
    const rest = query.all.filter((m) => !('up' in m))
    return { self: rest.length === 0 ? null : { all: rest }, placement }
  }
  return { self: query, placement: [] }
}

/** 触发索引：依赖倒排收候选；建一遍、按派生列表的数组身份失效——每笔 tx 不扫森林 */
interface TriggerIndex {
  rules: IndexedRule[]
  propRules: Map<string, IndexedRule[]>
  tagRules: Map<string, IndexedRule[]>
  /** 诞生边沿的候选（没有「变化的原子」⇒ 全量进 entered 候选，§索引纪律） */
  enteredRules: IndexedRule[]
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
    const next: TriggerIndex = { rules: [], propRules: new Map(), tagRules: new Map(), enteredRules: [] }
    const bucket = (map: Map<string, IndexedRule[]>, key: string, rule: IndexedRule): void => {
      const list = map.get(key)
      if (list) {
        if (!list.includes(rule)) list.push(rule)
      } else map.set(key, [rule])
    }
    for (const b of list) {
      const def = readAutomation(b)
      if (!def || !def.enabled) continue
      const rule: IndexedRule = { id: b.id, def, triggers: [], hasEntered: false }
      for (const tr of def.triggers) {
        if (tr === 'manual') continue
        const { self, placement } = compileTriggerQuery(tr.query)
        const compiled: CompiledTrigger = { tr, self, placement, deps: triggerDeps(tr.query) }
        rule.triggers.push(compiled)
        if (tr.on === 'entered') rule.hasEntered = true
        // 一个触发器的依赖是「引用了谁」，规则的候选键是全部触发器依赖的并集
        for (const p of compiled.deps.props) bucket(next.propRules, p, rule)
        for (const t of compiled.deps.tags) bucket(next.tagRules, t, rule)
      }
      if (rule.triggers.length === 0) continue // 只有 manual：不是事件规则
      next.rules.push(rule)
      if (rule.hasEntered) next.enteredRules.push(rule)
    }
    index = next.rules.length === 0 ? null : next
    return index
  }

  /**
   * before 侧的主体适配器：touched 快照里的格 + 空结构。同一台求值器吃它——
   * 结构原子（children/down）在触发器白名单之外，残余形态对着空结构优雅退化。
   */
  const beforeSubjectOf = (entry: TouchedBlock): Block => {
    const cells = entry.before!.cells
    return {
      id: entry.block.id,
      content: cells.content,
      children: [],
      created: cells.created,
      modified: cells.modified,
      props: cells.props,
      annos: cells.annos,
    }
  }

  /**
   * **容纳链**：真父链（`followRefs` 打开时另加传递型引用行的目标，seen 防环）。
   * 只在诞生时刻枚举一次；`{up}` 的条件对链上任一块成立即命中。
   *
   * 引用行透不透由**这条触发器**说（缺省不透）：显示继承默认穿是「看」的事，
   * 规则开火是「写」的事——默认保守，要穿就在触发器上显式打开。
   */
  const containmentChainOf = (entry: TouchedBlock, followRefs: boolean): Block[] => {
    const parentId = entry.afterPlacement?.parent ?? null
    const chain: Block[] = []
    const seen = new Set<string>()
    const expand = (b: Block): void => {
      if (seen.has(b.id)) return
      seen.add(b.id)
      chain.push(b)
      if (!followRefs) return
      const ref = passThroughRefTarget(b)
      if (ref) {
        const target = kb.get(ref)
        if (target) expand(target)
      }
    }
    if (parentId !== null) {
      for (const ancestor of kb.pathOf(parentId)) expand(ancestor)
    }
    return chain
  }

  /** 一侧求值：self 部分对主体，placement 部分对容纳链（链只在诞生时刻有） */
  const evalQuery = (c: CompiledTrigger, block: Block, chain: Block[] | null): boolean => {
    if (c.self !== null && !kb.matchesSpec({ where: c.self }, block, { blockLocalTags: true })) return false
    for (const p of c.placement) {
      if (!chain || !chain.some((m) => kb.matchesSpec({ where: p }, m, { blockLocalTags: true }))) return false
    }
    return true
  }

  /** changed 的「引用原子真变」：prop 按 `{exists, value}` 对、tag 按归属，前后终值各比一次 */
  const depChanged = (entry: TouchedBlock, deps: TriggerDeps): boolean => {
    const beforeProps = entry.before!.cells.props as Record<string, unknown> | undefined
    const afterProps = entry.block.props as Record<string, unknown> | undefined
    for (const p of deps.props) {
      if (!sameValue(beforeProps?.[p], afterProps?.[p])) return true
    }
    const beforeTags = beforeProps?._tags
    const afterTags = afterProps?._tags
    for (const t of deps.tags) {
      const was = Array.isArray(beforeTags) && (beforeTags as unknown[]).includes(t)
      const is = Array.isArray(afterTags) && (afterTags as unknown[]).includes(t)
      if (was !== is) return true
    }
    return false
  }

  /** 这一条变更触发这条规则吗（只读 touched 的前后值，不写） */
  const fires = (entry: TouchedBlock, rule: IndexedRule): boolean => {
    const b = entry.block
    if (b.id === rule.id) return false // 防自改
    const beforeBlock = entry.before === null ? null : beforeSubjectOf(entry)
    for (const c of rule.triggers) {
      // 含 up 的触发器只在诞生时刻对容纳链求值（腐坏的无 birth 形态也按 birth 对待）
      if (c.tr.birth === true || c.placement.length > 0) {
        if (entry.before !== null) continue // 只对诞生开火：移动已有块、已有块改属性都不算
        if (!evalQuery(c, b, containmentChainOf(entry, followsRefs(c.tr)))) continue
        return true
      }
      if (entry.before === null) {
        // 诞生按「不匹配」参与数据边沿：创建即满足 ⇒ entered 开火（有意统一）；left/changed 不开火
        if (c.tr.on === 'entered' && c.self !== null && kb.matchesSpec({ where: c.self }, b, { blockLocalTags: true })) return true
        continue
      }
      const was = kb.matchesSpec({ where: c.self! }, beforeBlock!, { blockLocalTags: true })
      const is = kb.matchesSpec({ where: c.self! }, b, { blockLocalTags: true })
      if (c.tr.on === 'entered') {
        if (!was && is) return true
        continue
      }
      if (c.tr.on === 'left') {
        if (was && !is) return true
        continue
      }
      // changed：前后均成立＋引用原子真变（终值对终值；A→B→A 净零不算）
      if (was && is && depChanged(entry, c.deps)) return true
    }
    return false
  }

  /** 一条 touched 的**原子变化集**（候选倒排的键；诞生边沿不走这里——它没有「变化的原子」） */
  const changedAtomsOf = (entry: TouchedBlock): { props: Set<string>; tags: Set<string> } => {
    const props = new Set<string>()
    const tags = new Set<string>()
    if (entry.before === null) return { props, tags }
    const beforeProps = entry.before.cells.props as Record<string, unknown> | undefined
    const afterProps = entry.block.props as Record<string, unknown> | undefined
    for (const k of new Set([...Object.keys(beforeProps ?? {}), ...Object.keys(afterProps ?? {})])) {
      if (!sameValue(beforeProps?.[k], afterProps?.[k])) props.add(k)
    }
    const beforeTags = beforeProps?._tags
    const afterTags = afterProps?._tags
    const was = new Set(Array.isArray(beforeTags) ? (beforeTags as string[]) : [])
    const is = new Set(Array.isArray(afterTags) ? (afterTags as string[]) : [])
    for (const t of was) if (!is.has(t)) tags.add(t)
    for (const t of is) if (!was.has(t)) tags.add(t)
    return { props, tags }
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
      // 候选收集（touched 序）：after 已删的条目整条跳过（不对死目标动作）；
      // 诞生边沿全量进 entered 候选，原子边沿按依赖倒排收
      const hits = new Map<IndexedRule, string[]>()
      const seen = new Set<string>()
      for (const entry of ctx.initial) {
        if (isDeleted(entry.block)) continue
        const candidates = new Set<IndexedRule>()
        if (entry.before === null) {
          for (const rule of idx.enteredRules) candidates.add(rule)
        } else {
          const { props, tags } = changedAtomsOf(entry)
          for (const p of props) for (const rule of idx.propRules.get(p) ?? []) candidates.add(rule)
          for (const t of tags) for (const rule of idx.tagRules.get(t) ?? []) candidates.add(rule)
        }
        for (const rule of idx.rules) {
          if (!candidates.has(rule)) continue
          if (!fires(entry, rule)) continue
          // 条件对目标现算（当前状态）：prop 触发器读到的就是刚写完的值
          if (rule.def.when !== undefined && !kb.matchesSpec({ where: rule.def.when }, entry.block, { blockLocalTags: true })) continue
          // 事件目标按 (规则, 目标) 去重：一条变更命中同一规则的多个触发只跑一次
          const key = `${rule.id}\u0000${entry.block.id}`
          if (seen.has(key)) continue
          seen.add(key)
          const list = hits.get(rule)
          if (list) list.push(entry.block.id)
          else hits.set(rule, [entry.block.id])
        }
      }
      if (hits.size === 0) return { ran: 0, failed: 0 }
      let ran = 0
      let failed = 0
      // 先序稳定序（规则在森林先序、目标在 touched 序）：两条规则写同一格时谁赢是确定的
      const nowMs = Date.now()
      for (const rule of idx.rules) {
        const targets = hits.get(rule)
        if (!targets) continue
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
  const axis = tr.on === 'changed' ? 'changed' : tr.birth === true ? `${tr.on}@birth` : tr.on
  return `${axis}:${JSON.stringify(tr.query)}`
}
