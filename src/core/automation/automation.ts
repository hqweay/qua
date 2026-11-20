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

/* ------------------------------------------------------------ 形状 */

/**
 * 触发器。**手动与事件是同一条自动化的两种触发**，不是两种东西；
 * 事件引擎接上之前，事件类触发器只是**数据**（可存、可显示、不执行）。
 *
 * `manual` 是字符串档：它没有参数，存对象反而让「有没有手动触发」多一问。
 */
export type AutomationTrigger =
  | 'manual'
  /** 某属性变成 `to`（缺省＝任何变化）时触发；`to` 按值格 kind 收（checkbox 是布尔） */
  | { kind: 'prop'; prop: string; to?: string | boolean }
  /** 某标签被打上／摘掉时触发 */
  | { kind: 'tag'; tag: string; on: 'added' | 'removed' }
  /** 直接父块下新建子块时触发；`parent` 是**作用在父块上**的条件（§8.9 原始形状）——
   *  「父块是某块的传递型引用」这类语义只有这里表达得了（`{up}` 走的是真祖先链） */
  | { kind: 'child.added'; parent?: QueryNode; followRefs?: true }

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
  const kind = (v as { kind?: unknown }).kind
  if (kind === 'prop') {
    const t = v as { prop?: unknown; to?: unknown }
    if (typeof t.prop !== 'string' || t.prop === '') return false
    return t.to === undefined || typeof t.to === 'string' || typeof t.to === 'boolean'
  }
  if (kind === 'tag') {
    const t = v as { tag?: unknown; on?: unknown }
    return typeof t.tag === 'string' && t.tag !== '' && (t.on === 'added' || t.on === 'removed')
  }
  if (kind === 'child.added') {
    const t = v as { parent?: unknown; followRefs?: unknown }
    if (t.parent !== undefined) {
      if (t.parent !== undefined && !(typeof t.parent === 'object' && t.parent !== null && isQueryNode(t.parent))) {
        return false
      }
    }
    return t.followRefs === undefined || t.followRefs === true
  }
  return false
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

/** 有没有手动触发（决定它进不进命令面板投影；事件-only 的规则不进面板） */
export function hasManualTrigger(def: AutomationDef): boolean {
  return def.triggers.some((tr) => tr === 'manual')
}

/**
 * 条件里有没有「内容依赖」的原子（正文／格式／外链／行内引用）——
 * 「新建子块」触发器的配置提示用：打字新建的块出生时没有正文，
 * 这类条件在触发那一刻多半不成立（粘贴/模板建的块有正文，所以是提示不是拦截）。
 *
 * ⚠️ 只看**目标块自己**的内容原子：套在 `{up}` 里的原子说的是祖先——祖先有正文，
 *    出生那一刻就能命中，不算错配。`{not}` 下的语义会翻转（「不含XX」对空块恒真），
 *    提示措辞因此写成「多半」而不是断言。
 */
export function mentionsContentAtoms(node: QueryNode): boolean {
  if ('text' in node || 'mark' in node || 'link' in node || 'ref' in node) return true
  // {up} 子树说的是祖先——祖先有正文，出生那一刻就能命中，不算错配
  if ('up' in node) return false
  if ('down' in node) return mentionsContentAtoms(node.down)
  if ('near' in node) return mentionsContentAtoms(node.near)
  if ('not' in node) return mentionsContentAtoms(node.not)
  if ('all' in node) return node.all.some(mentionsContentAtoms)
  if ('any' in node) return node.any.some(mentionsContentAtoms)
  return false
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
      : tr.kind === 'prop'
        ? (tr.to === undefined ? { kind: 'prop', prop: tr.prop } : { kind: 'prop', prop: tr.prop, to: tr.to })
        : tr.kind === 'tag'
          ? { kind: 'tag', tag: tr.tag, on: tr.on }
          : (tr.parent === undefined
              ? { kind: 'child.added', ...(tr.followRefs === true ? { followRefs: true } : {}) }
              : {
                  kind: 'child.added',
                  parent: canonicalNode(tr.parent),
                  ...(tr.followRefs === true ? { followRefs: true } : {}),
                }),
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
