/**
 * **日记流的来源**：一份 QuerySpec 字面量 ＋ 把它翻回块列表的纯路径内核。
 *
 * 日记流不是独立的库读：它是查询视图的**临时实例**——「选哪些天、什么序」
 * 全部由查询语言表达（role 成员条件 ＋ `_date` 降序），与查询块共用
 * 同一份评估（`evaluateQuery`）。这里只把这条 spec 与内核收在一处：
 * 冷启动（还没有索引）走纯路径内核，命令层走 `kb.query`（索引路径），等式由测试钉住。
 *
 * ⚠️ **「取几段」不住在 spec 里**：spec 只回答成员与顺序，窗口（先剔未来、再截前 N 段）
 *    由 `feedWindow` 一处回答。把 `limit` 写进 spec，截断就会发生在装载层过滤未来之前：
 *    引用日期提前物化的未来天把名额占满，滤完一屏什么都没有。
 * ⚠️ 分页＝窗口变宽：降序下「追加」天然等于「把窗口调大」——
 *    多出来的就是更旧的几天，不需要 offset。
 * ⚠️ 写规则不在这里：物化今天、空天补首子块、`_date` 只读是**装载与写边界**的事
 *    （`journal.ts` 与装载边界）；查询永不写库。
 */
import { journalDate, todayISO } from '../identity/journal.ts'
import type { Block } from '../model/model.ts'
import { findById, runQuery, type QuerySpec } from './query.ts'

/** 日记流的来源字面量：`_date` 降序（今日在顶）、只取**存在的**天；取几段由装载窗口定 */
export const FEED_SPEC: QuerySpec = {
  where: { role: 'journal' },
  sort: [{ by: '_date', dir: 'desc' }],
}

/**
 * **日记流的窗口**：一列按 `_date` 降序排好的活块，先剔掉基准日之后的天，再截前 `limit` 段。
 *
 * 为什么顺序不能反：引用日期会把还没到的天提前物化出来（日历上那些未来的圆点是真的块，
 * 引用目标必须存在），而「今天往回看」是日记流的语义，未来从日历进。先按降序取前 N 段再
 * 滤未来的话，未来天会**占满名额**——三个未来天 ＋ 首屏三段就把整屏滤成零段，
 * 点「回到今日」直接进空白页。spec 没有日期范围原子，这一步先留在装载路径；
 * 纯路径（`feedDays`）与索引路径（命令层）共用这一处判据，日期范围原子落地后一起退役。
 *
 * @param blocks 已按 `_date` 降序的候选（spec 求值的结果）
 * @param anchor 基准日（`YYYY-MM-DD`）；回流与复盘都用系统今天
 */
export function feedWindow(blocks: readonly Block[], anchor: string, limit: number): Block[] {
  return blocks.filter((b) => journalDate(b) <= anchor).slice(0, Math.max(0, limit))
}

/**
 * spec 求值内核（纯路径）：结果 id 翻回活块，解析不到的跳过。
 *
 * 「不造空天」是这条 spec 的自然结果——没有写过的日期没有块，也就不会命中。
 * 「不展示未来」与「取几段」都交给 `feedWindow`，两处装载不会各写一份顺序。
 *
 * @param now 纯函数不偷看墙钟：测试给固定值，运行时省略 ＝ 现在
 */
export function feedDays(blocks: readonly Block[], limit: number, now?: Date): Block[] {
  const hits = runQuery(FEED_SPEC, { blocks })
    .map((h) => findById(blocks, h.blockId))
    .filter((b): b is Block => b !== undefined)
  return feedWindow(hits, todayISO(now), limit)
}

/**
 * **段的排列**（视图配置轴，不是导航）：`column`（单列流，缺省）｜`row`（段横排）｜`grid`（折行网格）。
 * 它是设备级外挂状态（不进 KB），但类型住在这里——「段怎么摆」跟着「段是什么」的口径走，
 * prefs／编辑器／命令层都从这里取，不各写一份联合。
 */
export type SecLayout = 'column' | 'row' | 'grid'

/**
 * **空天格子**（复盘兜底）：窗口里没写过的天在 row/grid 排列下渲染成空壳列。
 * `beforeRootId`＝它应插在哪一段之前（按 `_date` 降序的列序）；`null`＝追加在最后。
 * 纯视图兜底不进库——落笔（点进格子）才物化那一天。
 */
export interface ShellCol {
  date: string
  beforeRootId: string | null
}
