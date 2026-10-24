/**
 * **冷启动态**：与「第一次打开 app」看到的那屏一致 —— 今日 journal 在顶、只有最近几天，
 * 落点＝今日（`activeId` 由 `forest()` 取 `blocks[0]`）。
 *
 * ⚠️ 它不是夹具样张（那是 `fixtures/` 的事）：内容是「首屏长什么样」的规格，
 *    调试时用它看首次启动，而不是去清 localStorage 再刷新。
 * ⚠️ 区别于「假数据库」：那是**全量种子**（6 页 + 全部历史天）；冷启动只装
 *    日记流首屏（`FEED_SPEC` 的 limit ＝ `FEED_INITIAL`）那几段。
 *
 * 造块借 `fixtures/build.ts` 的构建器：装库的形状只有一份，冷启动不该另写一份
 * 「页块 / 日记块 / 折叠表 / 库级锚点」的拼装 —— 但它**不自带任何样张内容**。
 */
import { FEED_INITIAL, shiftISO, todayISO } from './index.ts'
import { forest, mkJournal, resolveRefs } from './fixtures/build.ts'
import type { Workspace } from './workspace.ts'

export function bootWorkspace(): Workspace {
  const days = [
    mkJournal(todayISO(), [{ text: '打开就在今天：这个日期是只读的，一天只有一个。' }]),
    mkJournal(shiftISO(todayISO(), -1), [{ text: '昨天留下的第一行。' }]),
    mkJournal(shiftISO(todayISO(), -2), [{ text: '前天的第一行。' }]),
  ]
  // 冷启动的装载是日记流首屏（`FEED_SPEC`）⇒ 这里按同一条规则剪到 `FEED_INITIAL` 段
  const feed = days.slice(0, FEED_INITIAL)
  const blocks = feed.map((d) => d.page)
  resolveRefs(blocks, feed)
  return forest(blocks, feed)
}
