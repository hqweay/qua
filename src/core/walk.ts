/**
 * **块树遍历的唯一入口。**
 *
 * 为什么单独一个文件：全仓有十几条读路径要把块走一遍 —— 找一个块、列全部块、算路径、
 * 算层级、算可见行、找子树、建索引、按名字找标签、按列表筛块……它们各自写一遍递归，
 * 于是**「哪些块算活着、按什么顺序走」有十几份答案**。任何一处改变走法（回收站、软删、
 * 可见性、顺序），都要同时改十几处，漏一处就是静默的「有的地方找得到、有的地方找不到」。
 * ⇒ **递归只写在这里**，其余读路径全部由它派生。
 *
 * 放在 `model.ts` 之外、独立成叶子：`alias.ts`／`tags.ts`／`props.ts` 也要用它，
 * 而 `tree.ts` 依赖 `alias.ts` —— 写在 `tree.ts` 里会绕出一个循环 import。
 *
 * 签名里的四样东西都是「走一遍」本身带的信息，不是某个调用方的私货：
 *   · `parent`／`index` —— 它住哪（找块、算兄弟位要）；
 *   · `path`（**含自己**）—— 从根到它的链，`path.length - 1` 就是层级；
 *   · `hidden` —— 它在不在一个**折叠的**子树里。
 *
 * ⚠️ **被删的子树默认不进**（「删掉的块看不看得见」的全仓唯一答案）：
 *    删除是块上的 `_deletedAt` 标记（原位软删，见 `model.ts` 的 `isDeleted`），
 *    块留在树上的原位，遍历跳过它**和它整棵子树** —— 索引、查询、反链、名字表、
 *    可见行因此自动一致，不需要每条读路径各判一遍。要看回收站全貌的调用方
 *    （派生回收站清单、按 id 找回被删块）显式传 `includeDeleted: true`。
 * ⚠️ 折叠表（`FoldState`）是可选的：大多数读路径只关心「有哪些块」，不关心
 *    「此刻哪几行被收起来了」，给它们多传一个参数只是噪声；**不传 ＝ 当作没有任何折叠**。
 *    要可见性（渲染、可见行、Enter 落点）的调用方自己传。
 *
 * ⚠️ `path` 是**活数组**（遍历会继续改它）；调用方要留用必须自己拷一份（`ctx.path.slice()`）。
 * ⚠️ `visit` 返回 `false` ⇒ **整次遍历立刻停止**（「找到就收工」的查找靠它）。
 */
import { isDeleted, type Block, type FoldState } from './model.ts'

export interface WalkCtx {
  /** 父块；`null` ＝ 顶层（这片森林的一个根） */
  parent: Block | null
  /** 在兄弟里的下标 */
  index: number
  /** 从根到**自己**（含自己）；`length - 1` 即层级 */
  path: readonly Block[]
  /** 自己在不在一个折叠的子树里（祖先里有折叠的块） */
  hidden: boolean
}

export interface WalkOpts {
  /** 传入折叠表 ⇒ 按「此刻哪几行收起来了」走（渲染用） */
  folded?: FoldState
  /** 连**被删的**块（及其子树）也走 —— 派生回收站、按 id 找回被删块用 */
  includeDeleted?: boolean
}

/**
 * 先序（深度优先）走一遍；`roots` 既可以是整片森林，也可以是一个子树的孩子列表。
 */
export function walkForest(roots: readonly Block[], visit: (b: Block, ctx: WalkCtx) => boolean | void, opts: WalkOpts = {}): void {
  const { folded, includeDeleted } = opts
  const path: Block[] = []
  const step = (list: readonly Block[], parent: Block | null, hidden: boolean): boolean => {
    for (let i = 0; i < list.length; i++) {
      const b = list[i]!
      if (!includeDeleted && isDeleted(b)) continue
      path.push(b)
      const stop = visit(b, { parent, index: i, path, hidden }) === false
      if (stop || step(b.children, b, hidden || folded?.[b.id] === true)) {
        path.pop()
        return true
      }
      path.pop()
    }
    return false
  }
  step(roots, null, false)
}
