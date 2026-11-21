/**
 * **TriggerQuery：统一触发器的条件语言**——QueryNode 的触发器子集，加静态依赖提取。
 *
 * 三件东西住在这里：
 *   · `visitTriggerQuery`——**一份 AST 遍历**（组合器与方向原子都进，带作用域与容器链），
 *     消费方各自解释节点语义（依赖提取、白名单校验、内容原子提示是三个消费方，判据不共享、
 *     遍历只此一份）；
 *   · `validateTriggerQuery`——**写侧校验**（保存规则时拒形；运行时求值器不承担合法性检查，
 *     QueryNode 是公共语言，触发器只是更严的消费者子集）；
 *   · `triggerDeps`——**静态依赖提取**（self 层的 prop/tag 引用；索引收候选、完整求值做判定）。
 *
 * ## 白名单为什么是两份作用域（一条判据生成）
 *
 * **叶子合法 ⇔ 引擎在该触发器语义要求的那一刻，观测得到它读的事实。**
 *
 * - **self 层**（引擎对 touched 块持续观测 before/after）：只许 `prop`/`tag` ＋组合器。
 *   每条禁令各有独立理由——`is` 恒惰（块 id 在可见事件里不变，永远开不了火）；
 *   正文原子逐键挥发且**没有原子索引**（＝每键全量求值所有正文规则）；`children`/`down`/`near`
 *   的变化 touch 的是别的块（子块诞生不会 touch 父块），self 层观测不到；`today` 是
 *   时间依赖原子（等于要求每天重算，level-triggered 后门）；`role` 可由系统槽 prop 拼出，
 *   是第二种拼法。
 * - **up 子层**（birth 触发器，**诞生那一刻对容纳链的一次性判定**，不是被追踪的依赖）：
 *   求值一次、不重算、无逐键路径——观测约束不适用 ⇒ 除嵌套 up 的全条件语言。
 *   `is`（「父块是块A」＝picker 核心写法）、正文原子、`today`（「今天的日记页下新建」
 *   诞生时求值一次，无每日重算问题）在这里全部合法。
 * - 未来新增叶子两边**默认禁止、显式开放**——白名单防的是「QueryNode 扩张静默扩大
 *   事件能力」，这条动机对两个作用域同样成立。
 */
import type { QueryNode } from '../query/query.ts'

/** 事件轴：成员迁移的三个方向（manual 与它并列，是触发器不是事件） */
export type TriggerOn = 'entered' | 'left' | 'changed'

/** 遍历上下文：节点在谁的范围内、经过了哪些容器（位置约束的原料） */
export interface TriggerWalkCtx {
  /** `'self'` ＝ 触发器主体自己的事实；`'up'` ＝ 容纳链上父块的事实（一次性判定） */
  scope: 'self' | 'up'
  /** 从根到这里的容器键链（`all`/`any`/`not`/`up`/`down`/`near`）；顶层是空数组 */
  path: readonly string[]
}

/**
 * **一份遍历**：先访本节点（回调返回 `false` 则整支停走——拒形后不必再走），
 * 再按组合器／方向原子递归。`up` 把作用域切成 `'up'`（子树说的是容纳链上的块）；
 * `down`/`near` 保持当前作用域。
 */
export function visitTriggerQuery(
  node: QueryNode,
  visit: (node: QueryNode, ctx: TriggerWalkCtx) => void | false,
  ctx: TriggerWalkCtx = { scope: 'self', path: [] },
): void {
  if (visit(node, ctx) === false) return
  const down = (key: string, next: QueryNode, scope: 'self' | 'up' = ctx.scope): void =>
    visitTriggerQuery(next, visit, { scope, path: [...ctx.path, key] })
  if ('all' in node) node.all.forEach((n) => down('all', n))
  else if ('any' in node) node.any.forEach((n) => down('any', n))
  else if ('not' in node) down('not', node.not)
  else if ('up' in node) down('up', node.up, 'up')
  else if ('down' in node) down('down', node.down)
  else if ('near' in node) down('near', node.near)
}

/* ------------------------------------------------------------ 校验 */

/**
 * 一次保存的拒形理由（英文，开发者面——调用方负责把它变成用户能懂的话）。
 * `null` ＝ 合法。
 */
export function validateTriggerQuery(on: TriggerOn, query: QueryNode, birth: boolean): string | null {
  let atoms = 0
  let violation: string | null = null
  visitTriggerQuery(query, (node, ctx) => {
    if (violation) return false
    // 引用原子计数：数的是「指到具体事实」的叶子；not/all/any/up/down/near 只是容器与翻转
    if (
      'prop' in node || 'tag' in node || 'is' in node || 'text' in node ||
      'mark' in node || 'link' in node || 'ref' in node || 'role' in node || 'today' in node
    ) atoms++
    if ('up' in node) {
      if (ctx.scope === 'up') { violation = 'up cannot nest inside up'; return false }
      if (on !== 'entered') { violation = 'up is only allowed on entered triggers'; return false }
      if (!birth) { violation = 'a trigger whose query contains up must set birth'; return false }
      // 位置：顶层（空链）或顶层 all 的直接成员位（链恰为 ['all']）
      if (ctx.path.length > 1 || (ctx.path.length === 1 && ctx.path[0] !== 'all')) {
        violation = 'up is only allowed at the top level or as a direct member of a top-level all'
        return false
      }
      return
    }
    if (ctx.scope === 'self') {
      if ('tag' in node && typeof node.tag !== 'string') {
        // 含子标签（desc）要标签树闭包——before 侧主体不在索引里，闭包无从注入；
        // 触发器的标签原子用直读形态（真用例出现再把闭包接进主体适配）
        violation = 'tag conditions in triggers use direct membership (string form)'
        return false
      }
      if ('text' in node || 'mark' in node || 'link' in node || 'ref' in node) {
        violation = 'content atoms cannot trigger events (per-keystroke transactions, no atom index)'
        return false
      }
      if ('is' in node) {
        violation = '"is" is inert on the trigger block itself (identity never changes in a visible event)'
        return false
      }
      if ('children' in node || 'down' in node || 'near' in node) {
        violation = 'structural atoms cannot trigger events (their changes touch other blocks, not this one)'
        return false
      }
      if ('today' in node) {
        violation = '"today" is a time-dependent atom (would require daily re-evaluation)'
        return false
      }
      if ('role' in node) {
        violation = '"role" is expressible as a prop condition on system slots'
        return false
      }
    }
    // up 子层：除嵌套 up（上面已拒）全开放
  })
  if (violation) return violation
  // 结构检查之后才答 birth 的轴问题：{up} 在 left 上的具体理由优先于泛化的 birth 拒形
  if (birth && on !== 'entered') return 'birth only applies to entered triggers'
  if (atoms === 0) return 'a trigger query must reference at least one atom (an atom-less trigger fires on every change)'
  return null
}

/* ------------------------------------------------------------ 依赖提取 */

/** 静态依赖：self 层引用的属性定义块 id 与标签块 id（up 子层是一次性判定，不进依赖） */
export interface TriggerDeps {
  props: Set<string>
  tags: Set<string>
}

/**
 * **静态依赖提取**（索引收候选的原料）：只数 self 层的 `prop`/`tag` 引用；
 * `{not}` 仍引用其子树（翻转不改引用面），重复原子靠 Set 天然去重。
 */
export function triggerDeps(query: QueryNode): TriggerDeps {
  const props = new Set<string>()
  const tags = new Set<string>()
  visitTriggerQuery(query, (node, ctx) => {
    if (ctx.scope !== 'self') return
    if ('prop' in node) props.add(node.prop.id)
    else if ('tag' in node) tags.add(typeof node.tag === 'string' ? node.tag : node.tag.id)
  })
  return { props, tags }
}
