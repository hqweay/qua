/**
 * **日历卡**：一个月一屏，点一格就去那天写日记。
 *
 * 为什么它是一张卡而不是一个「日历页」：日历是**导航**，不是内容——
 * 它回答「哪天写过、怎么去那天」，而不承载任何一块数据。
 * 造一个「日历页」等于造第二种实体，而「一切皆块」里没有它的位置。
 *
 * 三条判据（都来自它要回答的问题）：
 *   ① **一屏一个月**，不滚动翻月：翻月是显式动作（← →），不是滚出来的。
 *      滚动翻月会让「现在看的是哪个月」取决于滚到哪，而那是**不可读**的状态。
 *   ② **有内容的日期要看得见**：日历的用处一半是「这天写过」，只画数字等于没用。
 *      判据是索引里的 `journals` 表（与 `journalDay` 同源），不是遍历森林。
 *   ③ **点一格 ＝ 去那天**（`core.journal/today` 带 `date`）。走命令面而不是
 *      在这里直接物化：物化要进事务、要产 op、要让索引跟上——三条只有一处入口。
 *
 * ⚠️ 这一层不认 `registry`／`ws`：能力由 `CalendarDeps` 收进来（与 `dock-content` 同一口径）。
 */
import { openActionOf, type OpenAction } from '../../core/index.ts'
import type { KbClient } from '../../core/kb/types.ts'
import { t } from '../../core/infra/msg.ts'
import { monthGrid } from '../chrome/month-grid.ts'
import type { DockCard } from '../dock/dock.ts'

export interface CalendarDeps {
  /** 读门面：只用来问「库里存在哪几天」 */
  kb: KbClient
  /**
   * 去某一天（`YYYY-MM-DD`）。`place` 由修饰键算：中心／右槽／新 tab。
   *
   * ⚠️ 空白天在库里还没有块；物化（含从回收站复活）由 `core.journal/open` 那一处做，
   *    日历不自己拼 `journalId` —— 否则会出现第二份「哪天是哪个块」的答案。
   */
  openDate: (date: string, place?: OpenAction) => void
}

export function calendarCard(deps: CalendarDeps): DockCard {
  /**
   * 一个月的身体是共享的月网格原语（`month-grid`）：游标／翻月／回本月／表头／
   * 今天标记都在那里。卡在这里只给三件自己的事：
   *   · 月外的格子**留空**（导航不画邻月：那会让「几号」要靠位置猜）；
   *   · 每次重画读一次「哪几天写过」并标记（写完一天要能立刻看见，卡没有 change 订阅）；
   *   · 点格 ＝ 去那天（`core.journal/open` 带日期；物化只由那一条命令做，卡不自己拼 `journalId`）。
   */
  const grid = monthGrid({
    outOfMonth: 'blank',
    onPick: (date, e) => deps.openDate(date, openActionOf(e)),
    dayLabel: (date) => t('ui.cal.dayLabel', { date }),
    mark: (cells) => {
      const written = new Set(deps.kb.journalDates())
      for (const [date, cell] of cells) {
        if (!written.has(date)) {
          cell.title = t('ui.cal.openBlank')
          continue
        }
        cell.dataset.written = '1'
        cell.title = t('ui.cal.openWritten')
        // 有内容：一颗小点。只画数字等于「这天写过」看不出来，而那是日历一半的用处
        const dot = document.createElement('span')
        dot.className = 'cal-dot'
        cell.appendChild(dot)
      }
    },
  })

  return { id: 'calendar', title: t('ui.cal.title'), body: grid.el }
}
