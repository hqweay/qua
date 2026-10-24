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
  hasList,
  LISTS_PROP,
  mkBlock,
  type Block,
} from '../../core/index.ts'
import { t } from '../../core/msg.ts'

/**
 * 编辑器装载的根集合：**只有「当前对象」自己一行**，它的子块**缩进挂在它下面**。
 *
 * zoom 的形状：
 * ```
 *   May 3rd, 2026 › 1      ← 面包屑（祖先链）
 *   • 2                    ← 被聚焦的块，正文第一行
 *   │  • 4                 ← 它的子块，缩进在它下面
 * ```
 *
 * ⚠️ **不是** `[b, ...b.children]`（那是把子块拉成兄弟，会显示成两棵树）。
 * ⚠️ 装进编辑器的是 **store 里的活块**：块是唯一真相，编辑直接发生在它身上，
 *   不存在「写回时把自己塞进自己 children」的自环问题。
 */
/**
 * 落点归一到「**装哪个根**」：`rootsFor(p)` 是唯一规则（块自己就是根，不再拷子树）。
 *
 * ⚠️ 早先 journal 单独走「只装子块」：日期行只读、光标无处可落，于是直接把日期行丢掉。
 *    代价是**日记块自己不在 DOM 里**——它作为当前对象时 `data-depth=0`，没有日期就
 *    等于「一屏不知道是哪一天」，聚焦之后也一样（`rootsFor` 是打开页与聚焦共用的同一条规则）。
 *    现在与页同口径：**块自己是第一行**（journal 渲染成只读日期行），子块缩进挂在下面；
 *    「打得开却打不了字」由**装载边界**管——空 journal 天补一个可编辑子块（经事务真的进库），
 *    光标的落点由 `focusFirstBlock` 跳过只读行。
 *
 * ⚠️ **纯函数**：只选择，不改库。早先它顺手给空 journal 补子块——「打开」是读动作，
 *    读的时候改模型让 op 序列缺一段（块进了库却没有行可落）。补块的唯一落点在装配层的
 *    装载边界（`materializeEditableRoots`）。
 */
export function rootsFor(block: Block): Block[] {
  return [block]
}

/**
 * **一列真实的根**：日记流／查询列表／多页并排。
 * 现在 block store 是唯一真相：这里返回**活引用**，不是浅拷贝；编辑直接写 store。
 *
 * 「日记流装哪些天」由一份 QuerySpec 字面量回答（role 成员条件＋`_date` 降序＋limit，
 * 与查询块共用同一份评估）；「单日还是流」的形态判据在各入口
 * （左槽 Daily note 入口＝流、聚焦/翻日＝单日），这里只负责把选好的一列块排成装载根。
 */
export function rootsForMany(blocks: readonly Block[]): Block[] {
  return blocks.slice()
}

/**
 * 一个空页块：正文空（描述）、名字进 `_aliases`、身份是 `_lists:['page']`。
 *
 * ⚠️ 空标题也必须有一个地址：不变量是「在页列表里 ⇒ 至少有一个名字」。
 *    生成 `未命名-<短 id>` 而不是留空，是让「新建页」立刻可被引用、可被改名，
 *    且不会在落盘校验里变成非法形状。
 * ⚠️ **天生命中带一个空首子块**（与种子库的空页同形）：页名行展示的是名字，
 *    没有子块的新页「建出来却没处写正文」。这块随页一起插进库（同一笔事务），
 *    不是打开时的渲染兜底——半截状态（有页、没处写字）不该有存在的一刻。
 */
export function makePageBlock(): Block {
  const b = mkBlock('')
  const name = t('ui.page.untitledAlias', { id: b.id.slice(-6) })
  return {
    ...b,
    children: [mkBlock('')],
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
