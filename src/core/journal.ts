/**
 * 日记：只读日期 `_date` + 一天一个的确定性 id。
 * 日期**不进 text**；模型层没有写 `_date` 的路径。
 *
 * ⚠️ 它**不是列表值**：「是不是日记」由 `_date` 在不在决定（`isJournalBlock`）。
 *    再存一个标记就是同一件事的第二份答案，而两份可以不一致。
 */

import { isJournalBlock, prop, type Block } from './model.ts'
import { derivedId } from './ids.ts'
import { walkForest } from './walk.ts'
export function todayISO(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 日期加减天数（走本地日历：跨月/跨年/夏令时都交给 `Date`） */
export function shiftISO(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return todayISO(new Date(y!, (m ?? 1) - 1, (d ?? 1) + days))
}

/**
 * `(本地日) → id`：**确定性派生**（`derivedId('journal', date)`）。
 *
 * ⚠️ 取舍：以前这个 id 的**前 12 位是本地零点的毫秒时间戳**、尾部塞日期数字 ——
 *    看上去像「能在 id 里读出日期」。那条可读性不是任何代码依赖的东西（日期的事实源是
 *    `_date`），换来的是「id 的形状与其它 id 不一致」。改成名字哈希之后，
 *    「同一天同一个 id」这条不变量改由 `derivedId` 的纯函数性保证（同样不依赖时钟），
 *    而 id 与其它块 id 是同一类形状，落库/导出/调试看到的东西一致。
 *    旧的 id 形状不迁移：落盘版本一换，旧库重新 seed（原型不做兼容）。
 *
 * ⚠️ 这是「一天一个」的实现载体，不是新实体（仍然只是块）。
 */
export function journalId(date: string): string {
  return derivedId('journal', date)
}

export function journalDate(b: Block): string {
  return prop<string>(b, '_date') ?? ''
}

/**
 * ⚠️ 返回 **boolean** 而不是类型谓词：`b is Block` 会把 `if` 的 else 分支收窄成 `never`
 * （`Block` 减 `Block`），于是「非 journal」那条路一行都写不出来。
 */
export function isJournal(b: Block | undefined): boolean {
  return isJournalBlock(b)
}

/**
 * **库里有哪些天、各自是哪一块**（唯一口径）。
 *
 * 两件事必须只在**这一处**定义：
 *   · **走整片森林**，不是只看顶层。索引与引用解析都是整片森林口径；只看顶层，
 *     一个被嵌进子树的 journal 就会「索引认得它、日记流看不见」——同一天两个答案。
 *   · **同一天有多个块时取先序第一个**（与日期索引一致）。「一天一个」是口径，
 *     多出来的那些是坏数据，不该让两条读路径各答一半。
 *
 * ⚠️ 与「journal 必须在顶层」不冲突：那条是入口守卫，落地后这里只剩一个候选。
 */
export function journalDays(blocks: readonly Block[]): Block[] {
  const byDate = new Map<string, Block>()
  walkForest(blocks, (b) => {
    const d = isJournal(b) ? journalDate(b) : ''
    if (d !== '' && !byDate.has(d)) byDate.set(d, b)
  })
  return [...byDate.values()]
}

/** 某一天的 journal 块（**唯一口径**：与 `journalDays` 同一片森林、同一个「先序第一个」） */
export function findJournalDay(blocks: readonly Block[], date: string): Block | undefined {
  return journalDays(blocks).find((b) => journalDate(b) === date)
}

/**
 * 日记流（32 ）：从 `anchor`（含）向过去取**存在的** journal 块，
 * 按 `_date` **降序**（今日在顶、越往下越早），最多 `limit` 天。
 *
 * ⚠️ **不造空天**：没有写过的日期不会有块，也就不会出现在流里。
 *    「日记是按需物化的资源」——没写过的日期不该存在。
 * ⚠️ 只做选择，不做视图：调用方负责 `ensureFirstBlock` 与浅拷贝成 roots。
 */
export function journalFeedDays(blocks: readonly Block[], anchor: string, limit = 14): Block[] {
  const days = journalDays(blocks).filter((b) => journalDate(b) <= anchor)
  days.sort((a, b) => journalDate(b).localeCompare(journalDate(a)))
  return days.slice(0, Math.max(0, limit))
}

/** 日记流的首屏/增量/上限（调研 §4.9 的「3 + 5」口径，上限先兜住 DOM） */
export const FEED_INITIAL = 3
export const FEED_STEP = 5
export const FEED_MAX = 30

/** 一个还没进库的日记块（`blocks` 里没有时才造它） */
export function mkJournalBlock(date: string): Block {
  return { id: journalId(date), text: '', children: [], props: { _date: date, _icon: 'lucide:calendar' } }
}

/**
 * 冷启动的模型归一：**保证「今天」的 journal 块在场**，并返回它的 id。
 *
 * ⚠️ 判据：冷启动落在今日是**默认内容**，不是「看存储里恰好有什么」——
 *   旧形状的库（没有 journal）升级上来也必须能直接进今日，否则用户找不到入口。
 * ⚠️ 与 `ensureFirstBlock` 分工：这里保证**块在场**，那里保证**块可编辑**。
 */
export function ensureTodayJournal(blocks: Block[], now: Date = new Date()): string {
  const date = todayISO(now)
  const id = journalId(date)
  if (!blocks.some((b) => b.id === id)) blocks.unshift(mkJournalBlock(date))
  return id
}

/** 日记日期的人类显示（只读投影；不是 `text`，也不可编辑） */
export function journalDateLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  if (!y || !m || !d) return date
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }).format(
    new Date(y, m - 1, d),
  )
}

/** 块的「页名」＝它的正文（**中间没有页标题**，页名就是那个块的文本） */
