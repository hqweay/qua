/**
 * **自动化块的数据形状**（触发器＋条件＋步骤）。
 *
 * 「命令块」＝带手动触发的自动化，**不新增实体**：`_automation` 是派生身份
 * （与 `_query` 同构）——判定与读形状只有一个入口（本文件的 `isAutomationDef`），
 * 「能读出定义」和「是不是自动化块」若是两套判据，就会冒出读不出定义的自动化块。
 *
 * 三条形状纪律（与查询条件同一族）：
 *   · **引用存 id 不存名字**：步骤里的 propId／tagId／blockId 都是 id——名字会漂，id 不会；
 *   · **条件是 QueryNode**（复用查询条件语言，同一份求值器）——「这块满不满足条件」
 *     不在自动化里再造第二个判定；
 *   · **enabled 是定义的一部分**：停用的自动化整条定义还在库里，只是不被执行——
 *     开关是数据（随库同步），不是设备状态。
 */
import { mkBlock, prop, type Block } from '../model/model.ts'
import { plainText, textRuns } from '../model/runs.ts'
import { canonicalNode, isQueryNode, type QueryNode } from '../query/query.ts'
import { visitTriggerQuery, type TriggerOn } from './trigger-query.ts'

/* ------------------------------------------------------------ 形状 */

/**
 * 触发器。**手动与事件是同一条自动化的两种触发**，不是两种东西。
 *
 * `manual` 是字符串档：它没有参数，存对象反而让「有没有手动触发」多一问。
 *
 * ⚠️ 旧的三种 kind（prop/tag/child.added）**不是合法形状**——读判给 `broken`
 * （灰态可跳转），不存在兼容分支；旧规则由用户在界面上按新形状重建。
 */
export type AutomationTrigger =
  | 'manual'
  /**
   * 对统一条件语言（TriggerQuery）声明一次迁移——`entered`（不满足→满足）／
   * `left`（满足→不满足）／`changed`（前后均满足且引用原子真变）。`birth: true` 把
   * 开火收窄到「块诞生（before 缺席）∧ after 匹配」——含 `up` 的条件（容纳链只在
   * 诞生时刻求值）由校验器强制带上它；query 的合法子集见 `trigger-query.ts`（写侧校验）。
   *
   * `followRefs` 是**容纳链怎么走**的一格（不是条件的一部分）：打开时传递型引用行
   * （正文只有一枚引用）在链上透明，父块条件按它指向的目标判定。默认**关**——
   * 「看」可以默认还原意图（显示继承默认穿），「写」必须保守：规则不该因为一行引用
   * 把写入落到别处。只落 `true`，关＝删键（与既有的「开回默认＝删格」同口径）。
   */
  | { on: TriggerOn; query: QueryNode; birth?: true; followRefs?: true; directOnly?: true }

/** 步骤参数的值位：字面量，或一个引用（run 开始时解析） */
export type ArgRef =
  | string
  | number
  | boolean
  | null
  /** 手动链的目标块 id（面板运行 ＝ 当前块） */
  | { ref: 'target' }
  /** run 开始那一刻的时间戳（整条链定格一次，逐步现取会两步跨天闹鬼） */
  | { ref: 'now' }

/** 一个步骤：**声明层**引用命令（命令是契约：准入／args schema／UI 标题），不内联实现 */
export interface AutomationStep {
  cmd: string
  args: Record<string, ArgRef>
}

export interface AutomationDef {
  /** 停用的自动化不执行（手动投影里也不列）；默认停用——分享来的规则不自觉生效 */
  enabled: boolean
  triggers: AutomationTrigger[]
  /** 条件（QueryNode）：目标不满足就整条不跑（面板里灰掉并说明，不是隐藏） */
  when?: QueryNode
  steps: AutomationStep[]
}

/* ------------------------------------------------------------ 判定 */

function isArgRef(v: unknown): v is ArgRef {
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return true
  if (!v || typeof v !== 'object') return false
  const r = (v as { ref?: unknown }).ref
  return r === 'target' || r === 'now'
}

export function isAutomationTrigger(v: unknown): v is AutomationTrigger {
  if (v === 'manual') return true
  if (!v || typeof v !== 'object') return false
  // 旧三种 kind（带 kind 槽）一律非法：读不出定义 ⇒ broken 灰态，不做兼容分支
  if ('kind' in v) return false
  const t = v as { on?: unknown; query?: unknown; birth?: unknown; followRefs?: unknown; directOnly?: unknown }
  if (t.on !== 'entered' && t.on !== 'left' && t.on !== 'changed') return false
  if (!(typeof t.query === 'object' && t.query !== null && isQueryNode(t.query))) return false
  // 只有「打开」需要落盘；`false` 不是合法值（关＝删键，读侧按缺省关）
  if (t.followRefs !== undefined && t.followRefs !== true) return false
  if (t.directOnly !== undefined && t.directOnly !== true) return false
  // 结构判据只答「形状」；TriggerQuery 的合法子集（白名单／位置／诞生约束）在写侧
  // `validateTriggerQuery` 校验，运行时求值器不承担——QueryNode 是公共语言，
  // 触发器只是更严的消费者子集
  return t.birth === undefined || t.birth === true
}

function isStep(v: unknown): v is AutomationStep {
  if (!v || typeof v !== 'object') return false
  const s = v as { cmd?: unknown; args?: unknown }
  if (typeof s.cmd !== 'string' || s.cmd === '') return false
  if (s.args === undefined) return true
  if (!s.args || typeof s.args !== 'object' || Array.isArray(s.args)) return false
  return Object.values(s.args).every(isArgRef)
}

/**
 * `_automation` 的合法性判据——**唯一一份**。存进去的（写侧拒形）与读出来的
 * （读侧判「是不是自动化块」）走它，两条路不许各有一个答案。
 */
export function isAutomationDef(v: unknown): v is AutomationDef {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const d = v as Partial<AutomationDef>
  if (typeof d.enabled !== 'boolean') return false
  if (!Array.isArray(d.triggers) || d.triggers.length === 0) return false
  if (!d.triggers.every(isAutomationTrigger)) return false
  if (d.when !== undefined && !isQueryNode(d.when)) return false
  if (!Array.isArray(d.steps)) return false
  return d.steps.every(isStep)
}

/**
 * 「是不是自动化块」的判定住在 `model.ts`（`isAutomationBlock`，零依赖叶子——
 * `canWriteText`／`hasIdentity` 要用它）；这里不重定义，只读定义：
 * 形状不合法给 `null`（降级显示「定义读不出来」，与 `readSpec` 同一条宽容）。
 */
export function readAutomation(b: Block): AutomationDef | null {
  return isAutomationDef(b.props?._automation) ? (b.props._automation as AutomationDef) : null
}

/**
 * 这条触发器的容纳链穿不穿传递型引用行。
 *
 * 只有一个读法：引擎判定与面板展示都问它（「这一格现在开没开」与「链怎么走」
 * 不许各算一遍）。缺省关——「写」的默认保守，见触发器的 `followRefs` 注释。
 */
export function followsRefs(tr: AutomationTrigger): boolean {
  return tr !== 'manual' && tr.followRefs === true
}

/**
 * 这条触发器只认直接父位，还是认整条容纳链。
 * 容纳链根在前，链尾＝新块真正落在谁下面；`followRefs` 展开引用行后链尾是它指向的目标，
 * 所以两格同开时按目标判定，不需要另立形状。
 */
export function isDirectOnly(tr: AutomationTrigger): boolean {
  return tr !== 'manual' && tr.directOnly === true
}

/** 有没有手动触发（决定它进不进命令面板投影；事件-only 的规则不进面板） */
export function hasManualTrigger(def: AutomationDef): boolean {
  return def.triggers.some((tr) => tr === 'manual')
}

/**
 * 条件里有没有「内容依赖」的原子（正文／格式／外链／行内引用）——
 * 「新建子块」触发器的配置提示用：打字新建的块出生时没有正文，
 * 这类条件在触发那一刻多半不成立（粘贴/模板建的块有正文，所以是提示不是拦截）。
 *
 * ⚠️ 只看**目标块自己**的内容原子：套在 `{up}` 里的原子说的是容纳链上的祖先——祖先有正文，
 *    出生那一刻就能命中，不算错配（遍历共享 `visitTriggerQuery`，up 子树切作用域后自然跳过）。
 *    `{not}` 下的语义会翻转（「不含XX」对空块恒真），提示措辞因此写成「多半」而不是断言。
 */
export function mentionsContentAtoms(node: QueryNode): boolean {
  let hit = false
  visitTriggerQuery(node, (n, ctx) => {
    if (ctx.scope !== 'self') return
    if ('text' in n || 'mark' in n || 'link' in n || 'ref' in n) {
      hit = true
      return false
    }
  })
  return hit
}

/* ------------------------------------------------------------ canonical */

/**
 * canonical 形状：键序固定，比较「定义变没变」不受写字面量顺序影响。
 *
 * `_automation` 要进 KB、进撤销；步骤参数的引用保留对象形状
 * （`{ref}` 与字面量在 JSON 里本来就有别），只修键序。
 */
export function canonicalAutomation(def: AutomationDef): AutomationDef {
  const triggers: AutomationTrigger[] = def.triggers.map((tr) =>
    tr === 'manual'
      ? 'manual'
      : {
          on: tr.on,
          query: canonicalNode(tr.query),
          ...(tr.birth === true ? { birth: true as const } : {}),
          ...(tr.followRefs === true ? { followRefs: true as const } : {}),
          ...(tr.directOnly === true ? { directOnly: true as const } : {}),
        },
  )
  const steps = def.steps.map((s) => ({ cmd: s.cmd, args: { ...s.args } }))
  const out: AutomationDef = { enabled: def.enabled, triggers, steps: def.steps.length === 0 ? [] : steps }
  if (def.when !== undefined) out.when = def.when
  return out
}

/* ------------------------------------------------------------ 造块 */

/**
 * 造一个**自动化块**（内容对象：有名字、能进回收站、定义住 props）。
 *
 * 正文＝名字——它没有别名入口，在这一行打字是唯一的改名路径
 * （判据见 `canDirectEditText`）；内容写路径不许改写它（`canWriteText` 拦）。
 */
export function mkAutomationBlock(opts: { name: string; def: AutomationDef; icon?: string }): Block {
  const props: Block['props'] = { _automation: canonicalAutomation(opts.def) }
  if (opts.icon !== undefined && opts.icon !== '') props._icon = opts.icon
  return mkBlock(textRuns(opts.name), { props })
}

/**
 * 自动化块的**显示名**（＝正文纯文本投影）。
 *
 * 名字住在正文里（与查询块同一条口径）；投影不落盘，改名即生效。
 */
export function automationName(b: Block): string {
  return plainText(b.content).trim()
}

/** 读出这一块挂的图标（缺省 ⚡——自动化的身份色，投影与块标共用一份） */
export function automationIcon(b: Block): string {
  return prop<string>(b, '_icon') ?? 'lucide:zap'
}
