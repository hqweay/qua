/**
 * **条件树 → 候选计划**：把「哪些块**可能**命中」编译成 SQL 计划（`library-reads.ts`
 * 的 `CandidatePlan`），候选从数据库收窄，matcher 仍是判定的唯一来源。
 *
 * ## 与 `candidateIdsOf`（内存候选）的关系
 *
 * 同一个问题（条件 → 候选超集）的两条投影：内存版从 `Index` 抽取，这一版从条件树
 * 编译 SQL。两者都受同一条铁律约束：**返回的集合必须 ⊇ 真命中**，否则候选迭代会
 * 静默丢行。收窄不了的形状（方向原子／`prop exists:false`／`not` 的子计划不精确时）
 * 给 `visible`（全部可见块）——宁可多装，不少装。
 *
 * ## matcher 环境需要的「点名块」
 *
 * 候选只装块自己（＋祖先链）；但 matcher 的环境要看**条件里点名的块**：
 * `{tag}` 的标签块（chip 显示名）、`{prop}` 的定义块（`readField` 的判据）。
 * 这些 id 由这里收集（`loadIds`），装载方在装候选时一并装上。
 *
 * ## `$self`
 *
 * 解析只有一份判据（`resolveSelfSpec`）：有宿主先解析，解析成 `NEVER` 的分支
 * 编译成空计划（`{k:'none'}`）——**不退回全库**：看不懂的指代不该变成大范围命中。
 */
import {
  refKindsOf,
  resolveSelfSpec,
  usesSelf,
  type QueryNode,
  type QuerySpec,
  type QueryContext,
} from '../query/query.ts'
import { shiftISO } from '../identity/journal.ts'
import { normMarks, type Marks } from '../model/runs.ts'
import type { Block } from '../model/model.ts'
import type { CandidatePlan } from './library-reads.ts'

const NONE: CandidatePlan = { k: 'none' }

export interface CandidateBuild {
  plan: CandidatePlan
  /** 条件里点名的标签块／字段定义（matcher 环境要它们在场） */
  loadIds: string[]
  /** 条件里有 `{children:true}` ⇒ 候选要连一层子级一起装（判定要看子块在不在） */
  children: boolean
}

/** 收集条件树里点名的块（标签 id、属性定义 id）与形状标记 */
function collect(
  node: QueryNode,
  out: { tags: Set<string>; fields: Set<string>; children: boolean; tagDesc: boolean; tagAllDesc: boolean },
): void {
  if ('all' in node) {
    for (const n of node.all) collect(n, out)
    return
  }
  if ('any' in node) {
    for (const n of node.any) collect(n, out)
    return
  }
  if ('not' in node) return collect(node.not, out)
  if ('up' in node) return collect(node.up, out)
  if ('down' in node) return collect(node.down, out)
  if ('near' in node) return collect(node.near, out)
  if ('tag' in node) {
    const id = typeof node.tag === 'string' ? node.tag : node.tag.id
    if (id !== '') out.tags.add(id)
    // 只要**有**一个分支要子标签，候选就得展开（并集是超集）；全是直接成员时才能不展开。
    // `tagAllDesc` 单独记「每个分支都要子标签」——只有它才让展开支成为精确集。
    if (typeof node.tag !== 'string' && node.tag.desc === true) out.tagDesc = true
    else out.tagAllDesc = false
    return
  }
  if ('prop' in node) {
    const id = node.prop.id
    // 系统槽（`_` 开头）与 `core/*` 不住在定义块上；定义 id 才要点名装载
    if (!id.startsWith('_') && !id.startsWith('core/')) out.fields.add(id)
    return
  }
  if ('ref' in node) {
    const to = typeof node.ref === 'string' ? node.ref : node.ref.to
    if (to !== undefined && to !== '') out.tags.add(to) // 目标块也点名装载（视图里要显示名字）
    return
  }
  if ('children' in node) out.children = true
}

/** `Marks`（可选属性）→ 计划的线上形状（只留归一后仍在的轴，值都是布尔 `true`／字符串） */
function planMarks(m: Marks): Record<string, true | string> {
  const out: Record<string, true | string> = {}
  for (const [k, v] of Object.entries(normMarks(m) ?? {})) if (v !== undefined) out[k] = v
  return out
}

/** 系统槽的候选计划（`_date`／`_kind` 住在列上，不在属性行里） */
function propPlan(id: string): CandidatePlan {
  if (id === '_date') return { k: 'journal' }
  if (id === '_kind') return { k: 'kind' }
  if (id === '_aliases') return { k: 'aliased' }
  if (id === '_tags') return { k: 'tagged' }
  if (id.startsWith('core/')) return { k: 'visible' }
  return { k: 'prop', name: id }
}

function planOf(
  node: QueryNode,
  env: { selfId?: string; today?: string },
  seen: { tags: Set<string>; fields: Set<string>; children: boolean; tagDesc: boolean; tagAllDesc: boolean },
): CandidatePlan {
  if ('all' in node) {
    if (node.all.length === 0) return { k: 'visible' } // 恒真
    const plans = node.all.map((n) => planOf(n, env, seen))
    if (plans.some((p) => p.k === 'none')) return NONE
    return plans.every((p) => p.k === 'visible') ? { k: 'visible' } : { k: 'all', plans }
  }
  if ('any' in node) {
    if (node.any.length === 0) return NONE // 恒假
    const plans = node.any.map((n) => planOf(n, env, seen))
    return plans.every((p) => p.k === 'none') ? NONE : { k: 'any', plans }
  }
  if ('not' in node) {
    /**
     * 否定：候选＝可见块减去子计划的**精确**集合（`notIn`）。
     * 子计划不精确时 SQL 那边会自己退化成 `visible`——这里的计划形状不必知道。
     */
    return { k: 'notIn', plan: planOf(node.not, env, seen) }
  }
  if ('is' in node) return node.is === '' ? NONE : { k: 'ids', ids: [node.is] }
  if ('up' in node) return { k: 'descendantsOf', plan: planOf(node.up, env, seen) }
  if ('down' in node) return { k: 'ancestorsOf', plan: planOf(node.down, env, seen) }
  if ('near' in node) return { k: 'near', plan: planOf(node.near, env, seen) }
  if ('role' in node) {
    if (node.role === 'page' || node.role === 'tag') return { k: 'list', list: node.role }
    if (node.role === 'journal') return { k: 'journal' }
    if (node.role === 'note') return { k: 'note' }
    return { k: 'visible' }
  }
  if ('today' in node) {
    // 没有基准日 ⇒ matcher 也判不命中（见 matcher 的 `{today}` 支）：这里同样给空集
    if (env.today === undefined) return NONE
    return { k: 'journalDay', date: shiftISO(env.today, node.today.offset) }
  }
  if ('ref' in node) {
    const to = typeof node.ref === 'string' ? node.ref : node.ref.to
    // kinds 进计划：「哪些 kind 算引用」是块语义，只能在这里给（SQL 只绑定参数）；
    // `{ref:{kind:'embed'}}` 与 `{ref: X}` 的候选面本来就不同
    return { k: 'ref', kinds: [...refKindsOf(node.ref)], ...(to !== undefined && to !== '' ? { to } : {}) }
  }
  if ('tag' in node) {
    // matcher 的 `{tag}` 读**整份 where 的标签并集**（文档化的已知语义）；
    // 候选也按并集给，否则交集条件会悄悄丢行。ids 由调用方用 seen.tags 填。
    return { k: 'tags', ids: [...seen.tags], expand: seen.tagDesc, allDesc: seen.tagAllDesc }
  }
  if ('text' in node) {
    if (typeof node.text === 'string') {
      return node.text === '' ? { k: 'visible' } : { k: 'text', needle: node.text }
    }
    return { k: 'text', needle: '', nonempty: true }
  }
  if ('children' in node) return { k: 'parents' }
  if ('mark' in node) {
    // marks 先归一：未知轴／坏值在计划里就消失，SQL 只按已知轴问（与 matcher 同一份词汇）。
    // 空 marks（直接构造的 spec 才可能）⇒ 「有任何带格式的 run」。
    return { k: 'mark', marks: planMarks(node.mark) }
  }
  if ('link' in node) {
    // 带 url 时 SQL 不按 url 窄化（Unicode 折叠差异），但精确性随之降级 ⇒ url 进计划
    return node.link.url === undefined ? { k: 'link' } : { k: 'link', url: node.link.url }
  }
  if ('prop' in node) {
    const op = node.prop
    // 「没有这一栏」是补集，收窄不了（有值行/声明槽的反面没法用一张表答）
    if ('exists' in op && op.exists === false) return { k: 'visible' }
    return propPlan(op.id)
  }
  // 不认识的形状：收窄不了 ⇒ 全部可见块（matcher 判）
  return { k: 'visible' }
}

/**
 * 编译一份候选计划。`host` 是 `$self` 的宿主（查询块／挂载宿主）；
 * 条件用了 `$self` 却没有宿主 ⇒ 空计划（与 matcher 的「不退回全库」同一条口径）。
 */
export function candidateBuildOf(
  spec: QuerySpec,
  host: Block | undefined,
  forest: readonly Block[],
  ctx: QueryContext,
): CandidateBuild {
  const seen = { tags: new Set<string>(), fields: new Set<string>(), children: false, tagDesc: false, tagAllDesc: true }
  const empty: CandidateBuild = { plan: NONE, loadIds: [], children: false }
  let where = spec.where
  if (usesSelf(where)) {
    if (!host) return empty
    where = resolveSelfSpec(spec, host, forest).where
  }
  collect(where, seen)
  const env = { selfId: ctx.selfId, ...(ctx.today ? { today: ctx.today } : {}) }
  const plan = planOf(where, env, seen)
  return {
    plan,
    loadIds: [...seen.tags, ...seen.fields],
    children: seen.children,
  }
}
