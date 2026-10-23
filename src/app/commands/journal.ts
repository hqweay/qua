/**
 * 日记命令：翻日与「回今日」。
 */
import {
  ensureFirstBlock,
  isJournal,
  journalDate,
  journalId,
  mkJournalBlock,
  shiftISO,
  todayISO,
} from '../../core/index.ts'
import type { App } from '../../core/ports.ts'
import { rootsFor, rootsForFeed } from './roots.ts'
import type { PageDeps } from './types.ts'

/**
 * 日记（日记流）。
 *
 * 两种形态，共用「先幂等物化，再打开」：
 *   · **日记流**（`journalToday` 不带日期／冷启动／左槽 Daily note 入口）：
 *     `date` 在顶，更早的「存在的天」按 `_date` 降序往下；
 *   · **单日**（`journalShift`／`journalToday` 指定日期／聚焦这一块）：只装那一天。
 *
 * · **幂等**：id 由 `(本地日)` 确定性派生（`journalId`）⇒ 「一天一个」是结构保证，
 *   不靠扫描去重；并发/多设备打开同一天会拿到同一个 id。
 * · **只读**：日期只进 `_date`，不进 `text`；这里没有任何写 `_date` 的分支。
 * · **不引入焦点栈**：翻日/回流只是把中心槽的「当前对象」换一块或换一串（同口径）。
 */
export function journalCommands(d: PageDeps): Pick<App, 'journalToday' | 'journalShift'> {
  /** 幂等物化：库里没有这一天的块才创建（排在最前，`forest()` 的 `blocks[0]` 即冷启动默认内容） */
  const ensure = (date: string): string => {
    const id = journalId(date)
    if (!d.blocks().some((b) => b.id === id)) d.blocks().unshift(mkJournalBlock(date))
    return id
  }

  /**
   * 打开**单日**：只装这一天自己（不是日记流）。
   *
   * ⚠️ 与左槽「Daily note」入口不同：入口是**流**，聚焦/翻日是**这一天**。
   *    两者都落在同一个 journal id 上，但装的根数量不同 —— 形态由调用方决定。
   */
  const openBlock = (id: string): void => {
    d.flush()
    const b = d.blocks().find((x) => x.id === id)
    // 全新的一天还没有任何子块 ⇒ 先归一：journal 的首行是**只读日期**，
    // 没有子块就**没有任何地方可以落光标**（打不了字）
    if (b) ensureFirstBlock(b.children)
    /**
     * ⚠️ 「哪一天是当前对象」由**日期**决定，不由装载顺序决定：
     *    日期块自己的 `id` 就是它的身份，`setActiveId` 必须拿它的 id
     *    （按「流的第一段」去设在库里留着更早的未打开天时会把人送到那一天）。
     */
    d.setActiveId(id, { feed: false })
    d.loadPage(b ? rootsFor(b) : [], d.marks(), d.atoms())
    d.refreshList()
    d.refreshTitle()
    d.saveNow()
    // ⚠️ 与 `openPage` 的差异：那里不落光标（用户是从左槽点进来的，焦点归点击），
    //    这里**要落光标**——用户刚按了「翻日／回今日」，落点就该是正文首块。
    d.focusFirstBlock()
  }

  /**
   * 打开**日记流**：`date` 在顶、更早的「存在的天」往下。
   *
   * ⚠️ 只取森林里**存在的** journal 块（`journalFeedDays`），不按日历逐天生造空天。
   * ⚠️ 每个加载的天都要 `ensureFirstBlock`：日期行只读，没有子块就「打得开却打不了字」。
   */
  const openFeed = (date: string): void => {
    d.flush()
    const anchorId = ensure(date)
    const anchor = d.blocks().find((b) => b.id === anchorId)
    /**
     * ⚠️ 「回今日」把**今天**设成当前对象，而不是流的**第一段**：库里若留着更早的
     *    未打开的一天（它不是今天），按下「回今日」人却停在昨天，是很怪的落点。
     *    装载顺序不变（按日期降序），只是当前对象归今天。
     */
    d.setActiveId(anchorId, { feed: true })
    d.loadPage(anchor ? rootsForFeed(anchor, d.blocks()) : [], d.marks(), d.atoms())
    d.refreshList()
    d.refreshTitle()
    d.saveNow()
    d.focusFirstBlock()
  }

  return {
    journalToday: (date) => {
      const ok = typeof date === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)
      // 「去某一天」＝只打开那一天（选日期是落点，不是筛选）；「回今日」＝今天在顶的日记流
      if (ok) openBlock(ensure(date as string))
      else openFeed(todayISO())
    },
    journalShift: (days) => {
      const b = d.blocks().find((x) => x.id === d.activeId())
      // 从「当前对象」的日期出发；当前不是 journal 就从今天出发（翻日永远有起点）
      const from = b && isJournal(b) ? journalDate(b) : todayISO()
      // 单日模式：翻到相邻的一天（流里的「翻一天」是另一种动作）
      openBlock(ensure(shiftISO(from, days)))
    },
  }
}
