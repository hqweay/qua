/**
 * 日记流的下滚加载：滚到接近底部 ⇒ 追加 `FEED_STEP` 天**存在的**更早日记。
 *
 * 只对**日记流**生效（roots 全是 journal 且 >1）；单日页不加载。
 * 视图状态（加载到第几屏）不入库；用「已加载的 root id 集合」判断，避免索引漂移。
 */
import { feedDays, isJournal, FEED_MAX, FEED_STEP, type Block } from '../../core/index.ts'
import { rootsForMany } from '../../app/commands/roots.ts'
import type { Workspace } from '../../core/infra/workspace.ts'
import type { BlockEditor } from '../../view/editor/editor.ts'

export interface FeedDeps {
  /** 滚动容器（中央编辑区的空白区）与启动收尾信号，都来自 chrome 分片 */
  blankAreaEl: HTMLElement
  markBooted: () => void
  getMainEd: () => BlockEditor
  getWs: () => Workspace
  activeBlock: () => Block
  /** 天 → 可编辑根（pages 分片「装载单位」的物化，那里持有编辑器装配的时序） */
  materialize: (days: Block[]) => void
}

export function setupFeed(deps: FeedDeps): void {
  const { blankAreaEl, markBooted, getMainEd, getWs, activeBlock, materialize } = deps

  /**
   * 滚到接近底部 ⇒ 追加一批**存在的**更早日记；不造空天，上限 `FEED_MAX`。
   *
   * ⚠️ **组合期不追加**（与 `appendRoots` 的守卫同一条理由）：这里必须在 `materializeEditableRoots`
   *    **之前**返回——那一步会物化根并改模型，而渲染会被 `appendRoots` 推迟，两者就分叉了。
   *    推迟到组合结束：用户下一次滚到底会再触发一次。
   */
  const appendMoreFeed = (): boolean => {
    const mainEd = getMainEd()
    const roots = mainEd.doc.roots
    if (mainEd.probe.isComposing) return false
    // 增量加载只在单列流成立：横排／网格的段数由打开它的入口定死，「往下滚」不是「要更旧的天」
    if (mainEd.layout !== 'column') return false
    if (roots.length <= 1 || !roots.every((r) => isJournal(r))) return false
    if (!isJournal(activeBlock())) return false
    if (roots.length >= FEED_MAX) return false
    const loaded = new Set(roots.map((r) => r.id))
    const limit = Math.min(roots.length + FEED_STEP, FEED_MAX)
    const more = feedDays(getWs().blocks, limit)
      .filter((d) => !loaded.has(d.id))
      .slice(0, limit - roots.length)
    if (more.length === 0) return false
    materialize(more)
    mainEd.appendRoots(rootsForMany(more))
    return true
  }

  {
    let appending = false
    blankAreaEl.addEventListener(
      'scroll',
      () => {
        if (appending) return
        if (blankAreaEl.scrollTop + blankAreaEl.clientHeight < blankAreaEl.scrollHeight - 120) return
        appending = true
        try {
          appendMoreFeed()
        } finally {
          appending = false
        }
      },
      { passive: true },
    )
  }

  markBooted()

  // 首屏填满：如果 3 天还撑不满视口（短日记），补到能滚为止 —— 否则「下滚加载」没有触发条件。
  // 教训：初始只装 1 条连第一屏都撑不满，用户不会去「加载更多」。
  requestAnimationFrame(() => {
    for (let i = 0; i < 6; i++) {
      if (blankAreaEl.scrollHeight > blankAreaEl.clientHeight + 8) break
      if (!appendMoreFeed()) break
    }
  })
}
