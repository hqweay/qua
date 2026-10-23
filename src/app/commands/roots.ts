/**
 * 落点归一到「装哪些根」——**一条规则，四个入口**。
 *
 * 打开页、聚焦块、翻日、日记流入口，最终都只是「把一批根塞进中心编辑器」。
 * 把这几条拼装规则收在一处，是为了让「今天点左槽 = 日记流、点块标 = 只看这一天」
 * 这类形态差异只有**一个**判据来源；散在各域里，两处迟早对不上。
 */
import {
  ALIASES_PROP,
  DISPLAY_PROP,
  ensureFirstBlock,
  FEED_INITIAL,
  hasList,
  isJournal,
  journalDate,
  journalFeedDays,
  LISTS_PROP,
  mkBlock,
  todayISO,
  type Block,
} from '../../core/index.ts'
import { t } from '../../core/msg.ts'

/**
 * 编辑器装载的根集合：**只有「当前对象」自己一行**，它的子块**缩进挂在它下面**（2026-10-20）。
 *
 * zoom 的形状：
 * ```
 *   May 3rd, 2026 › 1      ← 面包屑（祖先链）
 *   • 2                    ← 被聚焦的块，正文第一行
 *   │  • 4                 ← 它的子块，缩进在它下面
 * ```
 *
 * ⚠️ **不是** `[b, ...b.children]`（那是把子块拉成兄弟，会显示成两棵树）。
 * ⚠️ 但也不能直接把 `b` 放进编辑器：那样 `syncActivePage` 写回时
 *   `p.children = roots` 会把「b 自己」塞进 b 的 children（自环）。
 *   所以给 b 一个**浅拷贝、children 用同一批子块**——子块照常缩进渲染，
 *   写回时再靠 `syncActivePage` 剥掉首行。
 */
/**
 * 落点归一到「**装哪个根**」：`rootsFor(p)` 是唯一规则（块自己就是根，不再拷子树）。
 *
 * ⚠️ 早先 journal 单独走「只装子块」：日期行只读、光标无处可落，于是直接把日期行丢掉。
 *    代价是**日记块自己不在 DOM 里**——它作为当前对象时 `data-depth=0`，没有日期就
 *    等于「一屏不知道是哪一天」，聚焦之后也一样（`rootsFor` 是打开页与聚焦共用的同一条规则）。
 *    现在与页同口径：**块自己是第一行**（journal 渲染成只读日期行），子块缩进挂在下面；
 *    「打得开却打不了字」由 `ensureFirstBlock` 管——空 journal 补一个可编辑子块，
 *    光标的落点由 `focusFirstBlock` 跳过只读行。
 */
export function rootsFor(block: Block): Block[] {
  if (isJournal(block)) ensureFirstBlock(block.children)
  return [block]
}

/**
 * **一列真实的根**：日记流／查询列表／多页并排。
 * 现在 block store 是唯一真相：这里返回**活引用**，不是浅拷贝；编辑直接写 store。
 */
export function rootsForMany(blocks: readonly Block[]): Block[] {
  return blocks.slice()
}

/**
 * **日记流入口装哪些根**：从 `target` 的日期起，今日在顶、更早存在的天往下。
 *
 * feed 与「单块聚焦」是两种形态：同一个 journal id 可以走这里（入口），
 * 也可以只走 `rootsFor`（只看这一天）。判据不能是「是不是今天」。
 */
export function rootsForFeed(target: Block, blocks: readonly Block[]): Block[] {
  const days = journalFeedDays(blocks, journalDate(target), FEED_INITIAL)
  // 日期行只读；没有子块就没有可落光标的地方（feed 里的每一天都要能直接打字）
  for (const day of days) ensureFirstBlock(day.children)
  return rootsForMany(days)
}

/**
 * **左槽「打开」一个落点时该装哪些根**。
 *
 * 判据：落点是**今天的 journal** ⇒ 这一下是「进入 Daily note 入口」，装**日记流**；
 *       否则就是「这块自己 ＋ 它的子树」。
 *
 * ⚠️ **聚焦不走这里**：点块标是「只看这一块」，即使目标是今天也只装单日。
 *    历史回放要还原当时的形态，所以那条信息随落点一起入栈。
 */
export function rootsForTarget(target: Block, blocks: readonly Block[]): Block[] {
  return isJournal(target) && journalDate(target) === todayISO() ? rootsForFeed(target, blocks) : rootsFor(target)
}

/**
 * 一个空页块：正文空（描述）、名字进 `_aliases`、身份是 `_lists:['page']`。
 *
 * ⚠️ 空标题也必须有一个地址：不变量是「在页列表里 ⇒ 至少有一个名字」。
 *    生成 `未命名-<短 id>` 而不是留空，是让「新建页」立刻可被引用、可被改名，
 *    且不会在落盘校验里变成非法形状。
 */
export function makePageBlock(): Block {
  const b = mkBlock('')
  const name = t('ui.page.untitledAlias', { id: b.id.slice(-6) })
  return {
    ...b,
    props: { [ALIASES_PROP]: [name], [LISTS_PROP]: ['page'], [DISPLAY_PROP]: 'alias', _icon: 'lucide:file' },
  }
}

/**
 * 冲突块在提示里怎么称呼。
 *
 * 只到「页／标签」这一层，不做面包屑：`[[ ]]` 打出去的名字撞的是**名字空间**里
 * 的那个块，用户要判断的是「我是不是想引用那个页」，知道它是页还是标签就够了。
 *
 * 导出给装配层：编辑器在编辑边界上拒绝一次改名时，提示要说清「撞的是哪种块」——
 * 同一句话两处拼，措辞就会分叉。
 */
export function takenWhere(b: Block): string {
  if (hasList(b, 'page')) return t('ui.where.page')
  if (hasList(b, 'tag')) return t('ui.where.tag')
  return t('ui.where.block')
}
