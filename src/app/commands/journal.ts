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
  type Block,
  type SecLayout,
  type ShellCol,
} from '../../core/index.ts'
import type { App } from '../../core/ports.ts'
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
export function journalCommands(d: PageDeps): Pick<App, 'journalToday' | 'journalShift' | 'journalReview' | 'journalShellWrite'> {
  /** 幂等物化：库里没有这一天的块才创建（排在最前）；经事务产 op——「块在库里」要有行可落 */
  const ensure = (date: string): string => {
    const id = journalId(date)
    if (!d.kb.get(id)) d.insertBlock(mkJournalBlock(date), null, 0)
    return id
  }

  /**
   * 最近一次复盘的参数：空天格子里落笔要**按同一参数重开**（格子变成真实段、其余格子原样）。
   * 视图状态、不入库——重开一次就重建，存进库反而是「导航进复盘」的第二份答案。
   */
  let lastReview: { days: number } | null = null

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
    d.loadPage(b ? rootsFor(b) : [])
    d.refreshList()
    d.refreshTitle()
    d.saveNow()
    // ⚠️ 与 `openPage` 的差异：那里不落光标（用户是从左槽点进来的，焦点归点击），
    //    这里**要落光标**——用户刚按了「翻日／回今日」，落点就该是正文首块。
    d.focusFirstBlock()
  }

  /**
   * 打开**日记流**（复盘＝同一条装载路径带参）：`date` 在顶、更早的「存在的天」往下。
   *
   * ⚠️ 「哪些天」由一份 QuerySpec 字面量回答（role 成员条件＋`_date` 降序＋limit），
   *    经索引路径求值（`kb.query`）——与查询块共用同一份评估，这里没有第二条来源语言。
   * ⚠️ 每个加载的天都要能直接打字：日期行只读 ⇒ 空天的首子块由装载边界补（经事务进库）。
   * ⚠️ `days`／`layout` 省略＝普通日记流（设备偏好的排列）；带参＝复盘（首版横排）。
   */
  const openFeed = (date: string, opts?: { days?: number; layout?: SecLayout; focusDate?: string }): void => {
    d.flush()
    const anchorId = ensure(date)
    const anchor = d.kb.get(anchorId)
    const days = opts?.days ?? FEED_INITIAL
    /**
     * ⚠️ 「回今日」把**今天**设成当前对象，而不是流的**第一段**：库里若留着更早的
     *    未打开的一天（它不是今天），按下「回今日」人却停在昨天，是很怪的落点。
     *    装载顺序不变（按日期降序），只是当前对象归今天。
     */
    d.setActiveId(anchorId, { feed: true })
    // 流的形态＝「date 在顶、更早存在的天往下」：选天是查询的事，「怎么排」是装载的事
    let dayBlocks = d
      .kb.query({ ...FEED_SPEC, limit: days })
      .map((h) => d.kb.get(h.blockId))
      .filter((b): b is Block => b !== undefined)
    /**
     * 复盘的窗口是「今天往回 N 天」：比窗口更早的存在天不该混进格子（spec 没有
     * 日期范围原子——那是后置项；这里先由装载路径收窄，代价登记在案）。
     */
    if (opts?.days !== undefined) {
      const oldest = shiftISO(date, -(days - 1))
      dayBlocks = dayBlocks.filter((b) => journalDate(b) >= oldest)
    }
    d.loadPage(anchor ? rootsForMany(dayBlocks) : [])
    d.applyLayout(opts?.layout ?? d.feedLayoutPref())
    // 复盘：窗口里没写过的天渲染空壳格子（纯视图兜底，落笔才物化）；普通流恒清空
    d.setShells(opts?.days !== undefined ? reviewShells(date, days, dayBlocks) : [])
    d.refreshList()
    d.refreshTitle()
    d.saveNow()
    if (opts?.focusDate) d.focusDay(opts.focusDate)
    else d.focusFirstBlock()
  }

  /**
   * 复盘的空天格子：从最旧往今天走，「比它更早的第一个存在天」就是它该插在其前的列；
   * 全都更晚（窗口尾部缺天）⇒ `beforeRootId: null`（追加在最后）。
   */
  const reviewShells = (anchor: string, days: number, dayBlocks: readonly Block[]): ShellCol[] => {
    if (days <= 1) return []
    const shells: ShellCol[] = []
    const byDate = new Map(dayBlocks.map((b) => [journalDate(b), b.id]))
    let below: string | null = null
    for (let i = days - 1; i >= 0; i--) {
      const dt = shiftISO(anchor, -i)
      const existing = byDate.get(dt)
      if (existing) {
        below = existing
        continue
      }
      shells.unshift({ date: dt, beforeRootId: below })
    }
    return shells
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
    /** 复盘＝带参的日记流：同 spec 换 `days`，首版横排（三天／周各成一屏） */
    journalReview: (days) => {
      const n = Number.isFinite(days) && days >= 1 ? Math.floor(days) : FEED_INITIAL
      lastReview = { days: n }
      openFeed(todayISO(), { days: n, layout: 'row' })
    },
    /**
     * 在空天格子里落笔：物化那一天（幂等）→ 按同一参数重开（格子变真实段、
     * 其余格子原样）→ 光标落进那一天的首个子块。首子块由装载边界补（经事务）。
     */
    journalShellWrite: (date) => {
      ensure(date)
      openFeed(todayISO(), { days: lastReview?.days ?? FEED_INITIAL, layout: 'row', focusDate: date })
    },
  }
}
