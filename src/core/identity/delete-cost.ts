/**
 * **删这一块会连带什么** —— 确认框唯一的输入。
 *
 * 为什么确认的判据是代价而不是身份：菜单上「删除」只有一行，同一个动作落在页／标签／
 * 字段定义／内容块上。按身份分档（删页总问、删标签有人用才问）会让同一次删除给出两个
 * 答案，而兼位的块（页＋标签）连该听哪一个都不确定。
 *
 * 身份只剩一件事：**决定这件事怎么称呼**（`whereOf`）。要不要问、问的时候说什么，
 * 一律由这里报的数决定。
 */
import { hasIdentity, hasList, type Block } from '../model/model.ts'
import { walkForest } from '../model/walk.ts'
import { declaredFieldIds, hasValue, isPropDef } from '../props/props.ts'
import { tagMemberIds } from './tags.ts'

export interface DeletionCost {
  /** 整棵（含自己）有几块 —— 这一下会带走多少行 */
  blocks: number
  /** 还打着这个标签的块数（删了这些块上的标签会消失，恢复后自动接回） */
  members: number
  /** 会失效的声明数：自己是个标签 ⇒ 它声明的字段；自己是个字段定义 ⇒ 有多少标签声明了它 */
  declarations: number
  /** 会失去这一格的块数（自己是个字段定义时） */
  values: number
}

/** 子树块数（含自己）。只走 `children`——`_belongsTo` 是归属边，不是这棵子树的一部分。 */
function subtreeSize(b: Block): number {
  let n = 0
  walkForest([b], () => {
    n += 1
  })
  return n
}

export function deletionCostOf(b: Block, forest: readonly Block[]): DeletionCost {
  let members = 0
  let declarations = 0
  let values = 0

  if (hasList(b, 'tag')) {
    members = tagMemberIds(b.id, forest).size
    declarations = declaredFieldIds(b).length
  }
  if (isPropDef(b)) {
    const declaredBy = new Set<string>()
    walkForest(forest, (x) => {
      if (declaredFieldIds(x).includes(b.id)) declaredBy.add(x.id)
      if (hasValue(x, b.id)) values += 1
    })
    declarations = declaredBy.size
  }

  return { blocks: subtreeSize(b), members, declarations, values }
}

/**
 * **要不要先问一次**：判据是「这一下会让**此刻看不见的东西**消失吗」。
 *
 *   · 别人的块上少一格（成员／声明／值）—— 那几块不在这屏上，看不见 ⇒ 问；
 *   · 删的是一个**命名对象**（页／标签／天／字段定义）而它下面还有内容 ——
 *     用户是按着块标点的，那一整片不在眼前 ⇒ 问；
 *   · 正文里的一块连着它缩进着的子块 —— 就在眼前，删掉什么一清二楚，且 ⌘Z 能回 ⇒ 不问。
 *
 * 把「子块多」单独当问的理由是错的：大纲里删一个带十条子块的段落是日常动作，
 * 每一下都停一次，用户只会学会无脑点确定。
 */
export function needsConfirm(b: Block, c: DeletionCost): boolean {
  if (c.members > 0 || c.declarations > 0 || c.values > 0) return true
  return hasIdentity(b) && c.blocks > 1
}
