/**
 * zoom 命令：把中心槽的「当前对象」换成任意块，以及退回祖先。
 */
import { FEED_INITIAL, isJournal, journalDate } from '../../core/index.ts'
import type { App } from '../../core/ports.ts'
import { rootsFor, rootsForMany } from './roots.ts'
import type { PageDeps } from './types.ts'

/**
 * zoom：**中心槽的「当前对象」从顶层块放宽为任意块**。
 *
 * ⚠️ 与「打开一个页」是**同一条规则的两个实例**：都是「容器 ＋ 它的 children」。
 *   所以这里不新增状态、不新增对象，也没有焦点栈：
 *   · 面包屑＝`kb.pathOf(当前对象)` 去掉末尾（**派生**：层级本来就来自 parent 链）；
 *   · 退回＝把当前对象换成祖先（与 zoom in **同一个动作**，只是目标不同）。
 * ⚠️ zoom **不跟随**左右槽（它们的内容显式钉住）。
 */
export function zoomCommands(d: PageDeps): Pick<App, 'zoomTo' | 'zoomOut'> {
  /**
   * 把中心槽指向任意块（**整库按 id 解析**，不只是顶层）。
   *
   * `feed` 只给**历史回放**用：它要还原「当时看的是日记流」这件事，而单看 id 分不出来。
   * 普通聚焦（块标 / 面包屑 / 引用）永远是 `feed = false`：**只装这一块**。
   */
  const open = (id: string, feed = false): void => {
    const b = d.kb.get(id)
    if (!b) return
    /**
     * **已经在「单块聚焦」这一块上 ⇒ 不再重装。**
     *
     * 重装会 `loadPage` + `focusFirstBlock`：DOM 整片换掉，屏幕上会闪一下，
     * 而落点、根集合、内容都没有任何变化 —— 用户再点一次块标时不该付这个代价。
     * 判据必须是「根只有一个且就是它」，不能用 activeId：日记流的 activeId
     * 也是今天那一块，但它是多段 feed，点块标正是要收成单日。
     */
    const roots = d.rootIds()
    if (!feed && roots.length === 1 && roots[0] === id) return

    d.flush()
    d.setActiveId(id, { feed })
    d.loadPage(
      feed && isJournal(b) ? rootsForMany(d.kb.journalFeed(journalDate(b), FEED_INITIAL)) : rootsFor(b),
      d.marks(),
      d.atoms(),
    )
    d.refreshList()
    d.refreshTitle()
    d.saveNow()
    d.focusFirstBlock()
  }

  return {
    zoomTo: (id, feed) => {
      /**
       * 叶子块也能 zoom：`scope: subtree` **含块自身**，叶子就是「只看这一块」——
       * 若叶子不给 zoom，点击行为会**时 zoom 时不 zoom**，用户没法预测一次点击的结果。
       */
      open(id, feed === true)
    },
    zoomOut: () => {
      const path = d.kb.pathOf(d.activeId())
      // 已经是最外层（页 / journal 本身就是顶层块）⇒ 没有可退的
      if (path.length <= 1) return
      open(path[0]!.id)
    },
  }
}
