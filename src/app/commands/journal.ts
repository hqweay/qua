/**
 * 日记命令：翻日与「回今日」。
 */
import {
  FEED_INITIAL,
  FEED_SPEC,
  isJournal,
  journalDate,
  journalId,
  mkJournalBlock,
  shiftISO,
  todayISO,
} from '../../core/index.ts'
import type { App } from '../../core/ports.ts'
import type { Block } from '../../core/model.ts'
import { rootsFor, rootsForMany } from './roots.ts'
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
  /** 幂等物化：库里没有这一天的块才创建（排在最前）；经事务产 op——「块在库里」要有行可落 */
  const ensure = (date: string): string => {
    const id = journalId(date)
    if (!d.kb.get(id)) d.insertBlock(mkJournalBlock(date), null, 0)
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
    const b = d.kb.get(id)
    /**
     * ⚠️ 「哪一天是当前对象」由**日期**决定，不由装载顺序决定：
     *    日期块自己的 `id` 就是它的身份，`setActiveId` 必须拿它的 id
     *    （按「流的第一段」去设在库里留着更早的未打开天时会把人送到那一天）。
     * ⚠️ 空天补首子块是**装载边界**的事（经事务进库），打开这里只选择、不写库。
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
   * ⚠️ 「哪些天」由一份 QuerySpec 字面量回答（role 成员条件＋`_date` 降序＋limit），
   *    经索引路径求值（`kb.query`）——与查询块共用同一份评估，这里没有第二条来源语言。
   * ⚠️ 每个加载的天都要能直接打字：日期行只读 ⇒ 空天的首子块由装载边界补（经事务进库）。
   */
  const openFeed = (date: string): void => {
    d.flush()
    const anchorId = ensure(date)
    const anchor = d.kb.get(anchorId)
    /**
     * ⚠️ 「回今日」把**今天**设成当前对象，而不是流的**第一段**：库里若留着更早的
     *    未打开的一天（它不是今天），按下「回今日」人却停在昨天，是很怪的落点。
     *    装载顺序不变（按日期降序），只是当前对象归今天。
     */
    d.setActiveId(anchorId, { feed: true })
    // 流的形态＝「date 在顶、更早存在的天往下」：选天是查询的事，「怎么排」是装载的事
    const days = d
      .kb.query({ ...FEED_SPEC, limit: FEED_INITIAL })
      .map((h) => d.kb.get(h.blockId))
      .filter((b): b is Block => b !== undefined)
    d.loadPage(anchor ? rootsForMany(days) : [], d.marks(), d.atoms())
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
      const b = d.kb.get(d.activeId())
      // 从「当前对象」的日期出发；当前不是 journal 就从今天出发（翻日永远有起点）
      const from = b && isJournal(b) ? journalDate(b) : todayISO()
      // 单日模式：翻到相邻的一天（流里的「翻一天」是另一种动作）
      openBlock(ensure(shiftISO(from, days)))
    },
  }
}
