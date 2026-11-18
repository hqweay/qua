/**
 * **首帧的工作集装载**：`catalog()` ＋ `doc(今日窗口 | active)` → 行缓存 → 唯一一份
 * `BlockStore`。读面只有具名的几条——「启动读了多少」由会话的 `reads` 逐面记账，
 * 没有「整库」一格可读。
 *
 * ## 落点怎么定（与冷启动旧行为同一条规则）
 *
 *   · `activeId` 是**页** ⇒ 装那一页（读回来的子树为空 ＝ 那块不存在/被清 ⇒ 回落今日窗口）；
 *   · `activeId` 是**日记天**（或没有 active）⇒ 装**今日在顶的日记流窗口**
 *     （日期降序、剔未来、截 `FEED_INITIAL`——窗口判据收在 catalog 日期上，不再扫全林）；
 *   · 「今天存不存在、是不是软删」由 catalog 回答，物化（新建/复活/补首子块）是
 *     装配层的事，这里只装载、不写。
 *
 * ## 祖先链
 *
 * `doc` 的祖先块行并进同一个 `RawLibraryRows` 交给行缓存：嵌套页的面包屑需要
 * 祖先的 `_aliases`，而祖先不是第二条子树（他们的兄弟子树不装）。
 */
import { FEED_INITIAL, journalId, todayISO, type Block } from '../../core/index.ts'
import type { LibraryCatalog, LibraryDocRows, RawLibraryRows } from '../../core/storage/library-reads.ts'
import type { LibraryClient } from '../../core/storage/library-client.ts'
import type { Workset } from '../../core/storage/workset.ts'

export interface WorksetBootDeps {
  client: LibraryClient
  workset: Workset
  /** 日记流窗口取几天（设备偏好管排列，装载只管窗口宽度） */
  feedLimit?: number
  today?: string
}

export type WorksetBootResult =
  | {
      status: 'ok'
      catalog: LibraryCatalog
      /** 编辑器要装的根（feed 天按日期降序；页是 active 自己） */
      roots: Block[]
      rootIds: readonly string[]
      mode: 'feed' | 'page'
      /** 「今天」在不在库里、是不是软删（物化判据；写不在这里做） */
      today: { exists: boolean; deleted: boolean }
      counts: {
        docReads: number
        docBlocks: number
        docRows: number
        catalogRows: number
        identityRows: number
        loadedBlocks: number
      }
    }
  | { status: 'no-library' }
  | { status: 'error'; error: string }

/** doc 的祖先块行并进行缓存要用的那一份行（导航装载也用它） */
export function withAncestors(doc: LibraryDocRows): RawLibraryRows {
  return {
    blocks: [...doc.rows.blocks, ...doc.ancestors],
    props: doc.rows.props,
    aliases: doc.rows.aliases,
    lists: doc.rows.lists,
    meta: {},
  }
}

export async function loadWorksetBoot(deps: WorksetBootDeps): Promise<WorksetBootResult> {
  const c = await deps.client.catalog()
  if (c.status !== 'ok') {
    return c.status === 'no-library' ? { status: 'no-library' } : { status: 'error', error: `catalog: ${describe(c)}` }
  }
  const catalog = c.value
  const today = deps.today ?? todayISO()
  const todayId = journalId(today)
  const todayJournal = catalog.journals.find((j) => j.id === todayId)
  /**
   * 日记流窗口：catalog 的日期已是降序；剔掉未来的天（引用日期会提前物化它们），
   * 再截首屏。软删天不进窗口——「这一天存在过」由物化判据回答，不进流。
   */
  const feedIds = catalog.journals
    .filter((j) => j.deleted === null && j.date <= today)
    .slice(0, deps.feedLimit ?? FEED_INITIAL)
    .map((j) => j.id)

  const activeId = catalog.meta.activeId
  const activeIsJournal = catalog.journals.some((j) => j.id === activeId)
  /** 页落点先按 active 装；装完没有可见根（那块不在了/被软删）⇒ 回落今日窗口 */
  let rootIds: readonly string[] = activeId !== '' && !activeIsJournal ? [activeId] : feedIds
  let mode: 'feed' | 'page' = rootIds === feedIds ? 'feed' : 'page'
  let docReads = 0

  /** 装一次 doc；失败按分型返回，不把失败当「空 Doc」 */
  const loadOnce = async (ids: readonly string[]): Promise<{ status: 'ok'; roots: Block[]; doc: LibraryDocRows } | { status: 'no-library' } | { status: 'error'; error: string }> => {
    const r = await deps.client.doc([...ids])
    docReads++
    if (r.status !== 'ok') {
      return r.status === 'no-library' ? { status: 'no-library' } : { status: 'error', error: `doc: ${describe(r)}` }
    }
    return { status: 'ok', roots: deps.workset.loadDoc(withAncestors(r.value), r.value.rootIds), doc: r.value }
  }

  const first = await loadOnce(rootIds)
  if (first.status !== 'ok') return first
  // 全局身份块（页/标签/定义/回收站根）：catalog 的块对象面——
  // kb.pages()/tags()/propDefs()/trash() 这些同步全局读靠它在工作集模式下保持正确
  const idn = await deps.client.identity()
  if (idn.status !== 'ok') {
    return idn.status === 'no-library' ? { status: 'no-library' } : { status: 'error', error: `identity: ${describe(idn)}` }
  }
  // 全局身份块都是顶层（身份不占位置）⇒ 祖先链天然完整，可参与派生行计算
  deps.workset.loadBlocks(idn.value, true)

  let doc = first.doc
  let roots = first.roots
  if (mode === 'page' && roots.length === 0) {
    const fallback = await loadOnce(feedIds)
    if (fallback.status !== 'ok') return fallback
    doc = fallback.doc
    roots = fallback.roots
    rootIds = feedIds
    mode = 'feed'
  }

  return {
    status: 'ok',
    catalog,
    roots,
    rootIds: doc.rootIds,
    mode,
    today: { exists: todayJournal !== undefined, deleted: todayJournal?.deleted != null },
    counts: {
      docReads,
      docBlocks: doc.rows.blocks.length,
      docRows: doc.rows.blocks.length + doc.rows.props.length + doc.rows.aliases.length + doc.rows.lists.length,
      catalogRows:
        catalog.journals.length +
        catalog.tags.length +
        catalog.propDefs.length +
        catalog.aliases.length +
        catalog.trash.length,
      identityRows:
        idn.value.blocks.length + idn.value.props.length + idn.value.aliases.length + idn.value.lists.length,
      loadedBlocks: deps.workset.size,
    },
  }
}

function describe(r: { status: string; error?: string }): string {
  return r.status === 'error' ? String(r.error ?? 'unknown') : r.status
}
