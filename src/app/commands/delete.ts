/**
 * **删除：一份实现，一个入口。**
 *
 * 入口只有一个（`App.deleteBlock`），它服务的块却有很多种：内容块、页、标签、日记天、
 * 字段定义。它们的差别只在**怎么删**和**删完落到哪**，不在「让不让删」——
 * 后者只剩一个变量（今天不删，见块级上下文的 `blockCanDelete`）。
 *
 * 为什么值得收成一处：按身份分成删页／删标签／删天／删块四条，兼位的块（页＋标签）
 * 会在菜单上出现两行做同一件事，而两行对同一次删除给出**不同的守卫答案**
 * （删页被「至少留一页」拦住、删标签照删）。一个动作两个答案比缺一个入口更糟。
 *
 * 三档机制，按「这一下站在哪」分派，不是按身份：
 *   ① 这一屏里的行 ⇒ 编辑器摘行（光标、空位、装载根收尾都由它管）；
 *   ② 不在这一屏 ⇒ 库级软删（回收站兜底）；
 *   ③ 删的正是正装载着的那个根 ⇒ 换落点：邻页 → 任一页 → 今日日记流。
 *
 * ③ 的第三档就是原来那条「至少留一页」前置的替代。禁令保护的东西其实是「删完没落点」，
 * 而落点可以补完 —— 补完之后删掉最后一页是合法且可预期的操作，不是被拦住的操作。
 *
 * 唯一例外：聚焦的内容块是**唯一装载根**时，为避免「删掉又补一块空根」的假删除，
 * 走 ② 的库级软删并退出聚焦到父块（没有父块才回落到 ③ 的页清单）。
 */
import {
  deletionCostOf,
  displayNameOf,
  hasList,
  isJournal,
  journalDate,
  needsConfirm,
  plainText,
  removableBySplice,
  todayISO,
  whereOf,
  type Block,
} from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import type { App } from '../../core/infra/ports.ts'
import { rootsFor } from './roots.ts'
import type { PageDeps } from './types.ts'

export interface DeleteDeps {
  /** 落点第三档：没有页可落了就回今日日记流（与冷启动「装不到就回落今日」同一条路） */
  openTodayFeed: () => void
  /**
   * 删聚焦根后退出聚焦到父块——**不是** `reland` 的页清单邻位。
   * 内容块的「家」是它的父块；页清单只在没有父块时兜底。
   */
  openParent: (id: string) => void
}

export function deleteCommands(d: PageDeps, x: DeleteDeps): Pick<App, 'deleteBlock'> {
  /**
   * 落点：**邻位页 → 任一页 → 今日**。
   *
   * `pageIndex` 是删除前这一块在页清单里的下标（删的不是页就是 -1 ⇒ 落到开头）。
   */
  const reland = (pageIndex: number): void => {
    const rest = d.kb.pages()
    if (rest.length === 0) {
      x.openTodayFeed()
      return
    }
    const p = rest[Math.min(pageIndex < 0 ? 0 : pageIndex, rest.length - 1)]!
    d.setActiveId(p.id, { restore: 'none' })
    d.loadPage(rootsFor(p))
  }

  /** 真的删（已经没有准入与确认的事了） */
  const deleteOne = (b: Block): boolean => {
    /**
     * 聚焦的内容块是**唯一装载根**时，摘行那条路会给它补一块空根——删了又补，
     * 视觉上等于没删。走库级软删（和删页同一条机制），再退出聚焦：
     * 有父块回父块，没有父块才落到页清单三档。有身份的根仍走原来的摘不到分支。
     */
    const roots = d.rootIds()
    if (roots.length === 1 && roots[0] === b.id && removableBySplice(b)) {
      const parent = d.kb.parentOf(b.id)
      const pageIndex = d.kb.pages().findIndex((p) => p.id === b.id)
      d.removeBlock(b.id)
      if (parent) x.openParent(parent.id)
      else reland(pageIndex)
      d.refreshList()
      d.refreshTitle()
      d.saveNow()
      return true
    }
    // ① 这一屏里的行：编辑器摘。装载根也走这里——它自己补空位/换根。
    if (d.spliceOut(b.id)) return true
    // ②③ 摘不到的（有身份的装载根、或根本不在这一屏）：库级软删 ＋ 落点
    const pageIndex = d.kb.pages().findIndex((p) => p.id === b.id)
    const loaded = d.activeId() === b.id || d.rootIds().includes(b.id)
    d.removeBlock(b.id)
    if (loaded) {
      // 落点跟着这一块的**家**走：天回到日记流（它的邻位就是流），其余的按页清单
      if (isJournal(b)) x.openTodayFeed()
      else reland(pageIndex)
    }
    d.refreshList()
    d.refreshTitle()
    d.saveNow()
    return true
  }

  /**
   * 删除一块。**先装载再算代价**：代价要看子树有多大，而未装载的块 `children` 是空的
   * （把「没装」当「没有子块」会给出一个骗人的确认框）。
   */
  const deleteBlock = (id: string): boolean => {
    if (!d.kb.isLoaded(id)) {
      d.loadDocThen([id], () => {
        // 补读没成功就不再递归（否则同一块在「再装一次」上死循环，点了没反应）
        if (!d.kb.isLoaded(id)) {
          console.warn('[doc] block still unloaded; skip delete:', id)
          return
        }
        deleteBlock(id)
      })
      return true
    }
    const b = d.kb.get(id)
    if (!b) return false
    // 准入只有这一条，且要说得出口：菜单里它压根不出现，键位/API 走到这里得给一句实话
    if (isJournal(b) && journalDate(b) === todayISO()) {
      d.toast(t('ui.toast.todayUndeletable'), 'warn')
      return false
    }

    const cost = deletionCostOf(b, d.kb.roots())
    const go = (): void => {
      if (deleteOne(b)) d.toast(t('ui.toast.deleted'))
    }
    // 没有看不见的连带就问都不问：删一块能撤销、也在回收站，多问一句只是拦人
    if (!needsConfirm(b, cost)) {
      go()
      return true
    }
    /**
     * 连带清单按**命中项**拼：一块叶子、一个连着五十个成员的标签、一份还被三个标签
     * 声明着的字段定义，说的不是同一句话。合成一条固定模板会把有用的那半遮掉。
     */
    const parts: string[] = []
    if (cost.blocks > 1) parts.push(t('ui.confirm.deleteBlocks', { count: String(cost.blocks - 1) }))
    if (cost.members > 0) parts.push(t('ui.confirm.deleteMembers', { count: String(cost.members) }))
    if (cost.declarations > 0) parts.push(t('ui.confirm.deleteDecls', { count: String(cost.declarations) }))
    if (cost.values > 0) parts.push(t('ui.confirm.deleteValues', { count: String(cost.values) }))
    const name = displayNameOf(b) || plainText(b.content).trim()
    const named = hasList(b, 'page') || hasList(b, 'tag')
    d.confirm({
      title: name
        ? named
          ? t('ui.confirm.deleteTitle', { name, where: whereOf(b) })
          : t('ui.confirm.deleteNamedTitle', { name })
        : t('ui.confirm.deleteSheetTitle'),
      body: parts.join('') + t('ui.confirm.deleteUndo'),
      confirmLabel: t('ui.confirm.delete'),
      danger: true,
      onConfirm: go,
    })
    return true
  }

  return { deleteBlock }
}
