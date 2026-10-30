/**
 * **视图命令**：一个块「怎么看」的增删改与行操作。
 *
 * 三条纪律（与模型层同源）：
 *   · 只写两个系统属性（`_views`／`_activeView`）——视图不是实体，没有自己的块；
 *   · **写配置一个字节都不碰记录**（删/换/改名视图，子块的正文与位置原样）；
 *   · 一次动作一条事务（＝一轮撤销），且**结构写（新建/删除行）也走事务**，
 *     否则换库之后那条块没有行可落。
 *
 * ⚠️ 这里不碰 DOM：切换视图之后要让屏幕跟上，走注入的 `reloadPage`（装配层的重装入口）。
 */
import {
  VIEWS_PROP,
  ACTIVE_VIEW_PROP,
  activeView,
  defaultColumns,
  isEmbedBlock,
  isQueryBlock,
  mkBlock,
  readSpec,
  readViews,
  removeView,
  renameView,
  STORED_VIEW_KINDS,
  upsertView,
  withListSort,
  withSort,
  type Block,
  type ListSort,
  type ViewConfig,
} from '../../core/index.ts'
import { uuidv7Hex } from '../../core/ids.ts'
import { refreshSpec } from '../../core/query-view.ts'
import { t } from '../../core/msg.ts'
import type { App } from '../../core/ports.ts'
import type { ViewConfigDeps } from './types.ts'

/** 视图 id：块 id 之外的**局部**标识（只在这个块的 `_views` 里有意义） */
function mkVievId(): string {
  return `v-${uuidv7Hex().slice(0, 12)}`
}

/** 把一串「视图属性」写进块（空集合 ⇒ 删掉那一格，不留空壳） */
function writeViews(b: Block, views: readonly ViewConfig[], activeId?: string | null): void {
  const props = { ...(b.props ?? {}) }
  if (views.length === 0) delete props[VIEWS_PROP]
  else props[VIEWS_PROP] = views
  if (activeId === undefined) {
    // 不动 `_activeView`
  } else if (activeId === null || activeId === '') delete props[ACTIVE_VIEW_PROP]
  else props[ACTIVE_VIEW_PROP] = activeId
  if (Object.keys(props).length === 0) delete b.props
  else b.props = props
}

export function viewConfigCommands(
  d: ViewConfigDeps,
):
  Pick<App, 'addView' | 'setActiveView' | 'removeView' | 'renameActiveView' | 'viewInsertRow' | 'viewDeleteRow' | 'viewSetSort'> {
  /**
   * 换完视图要让屏幕跟上：正文的根行与段尾的视图宿主都得跟着换。
   *
   * ⚠️ **只有「这一屏就是这一块」时重装才有效**。视图宿主挂在**段根**的段尾槽里，
   *    而一屏多根（日记流、并排页）时没有任何段根是「这一块的视图」——
   *    于是「给今天这一行建一张表」会把配置写进模型、屏幕却一动不动（点了没生效）。
   *    所以这里分两路：已经是单根就重装；否则**把这一块打开**（换屏到它），
   *    让「点了」总有可见结果。
   */
  const reveal = (blockId: string): void => {
    /**
     * **露面块不换屏**：它是正文里的一行，不是「一个对象」。
     * 按普通块那条 `openBlock` 会把用户从正文带走到一块空壳上（看起来像「点了视图就跳页」）。
     * 换看法之后，身体由装载时重画那一段跟着换——重装当前屏就够了。
     */
    if (isEmbedBlock(d.kb.get(blockId))) {
      d.reloadPage()
      return
    }
    const roots = d.rootIds()
    if (roots.length === 1 && roots[0] === blockId) d.reloadPage()
    else d.openBlock(blockId)
  }
  /** 只重装，不换屏（行操作：容器本来就是这一屏的根，才可能走到这些入口） */
  const after = (): void => d.reloadPage()

  return {
    /**
     * 新建一个视图并设为激活。
     *
     * 表格的列**在这里算一次**（`defaultColumns`）：算完写进配置，之后不随结果漂移。
     * 非表格的 kind 也允许建（类型与数据形状先就位），只是渲染层还没有它。
     */
    addView: (blockId, kindRaw) => {
      const b = d.kb.get(blockId)
      if (!b) return ''
      const kind = STORED_VIEW_KINDS.find((k) => k === kindRaw)
      if (!kind) {
        d.toast(t('ui.view.unknownKind'), 'warn')
        return ''
      }
      /**
       * 结构映射表把**层级**摊成列；查询结果是平的命中集合，没有「第 k 个孩子」可对齐。
       * 写进去也读不回来（`canonicalViews` 会丢掉它），所以当场拒绝而不是留一个「点了没生效」。
       */
      if (kind === 'list-table' && isQueryBlock(b)) {
        d.toast(t('ui.view.listNeedsTree'), 'warn')
        return ''
      }
      const id = mkVievId()
      const view: ViewConfig = { id, kind }
      if (kind === 'table') view.table = { columns: defaultColumns(blockId, d.kb) }
      d.run((tx) =>
        tx.patch(blockId, (x) => {
          writeViews(x, upsertView(readViews(x), view), id)
        }),
      )
      reveal(blockId)
      return id
    },

    /**
     * 切换激活视图。`viewId === ''` ＝ **大纲**（删掉 `_activeView`，不是存一个 `kind:'outline'`）。
     *
     * 指向一个不存在的 id 时**不写**：那会把块变成一个「配置坏了」的状态，
     * 而用户看到的是「点了没反应」——不如当场什么都不做（调用方只可能是菜单）。
     */
    setActiveView: (blockId, viewId) => {
      const b = d.kb.get(blockId)
      if (!b) return false
      const target = viewId.trim()
      if (target !== '' && !readViews(b).some((v) => v.id === target)) return false
      d.run((tx) =>
        tx.patch(blockId, (x) => {
          writeViews(x, readViews(x), target === '' ? null : target)
        }),
      )
      reveal(blockId)
      return true
    },

    /** 删一个视图：只动配置。删的正是激活那个 ⇒ 指向相邻一项，没有就回大纲 */
    removeView: (blockId, viewId) => {
      const b = d.kb.get(blockId)
      if (!b) return false
      const views = readViews(b)
      const at = views.findIndex((v) => v.id === viewId)
      if (at < 0) return false
      const next = removeView(views, viewId)
      const wasActive = activeView(b)?.id === viewId
      const fallback = wasActive ? (next[Math.min(at, next.length - 1)]?.id ?? null) : undefined
      d.run((tx) =>
        tx.patch(blockId, (x) => {
          writeViews(x, removeView(readViews(x), viewId), fallback)
        }),
      )
      reveal(blockId)
      return true
    },

    /** 给当前激活的视图改名（空名 ⇒ 回到按 kind 的默认名） */
    renameActiveView: (blockId, name) => {
      const b = d.kb.get(blockId)
      if (!b) return false
      const active = activeView(b)
      if (!active) return false
      d.run((tx) =>
        tx.patch(blockId, (x) => {
          writeViews(x, renameView(readViews(x), active.id, name))
        }),
      )
      reveal(blockId)
      return true
    },

    /**
     * 新建一个子块 ＝ 在容器**末尾**插入（结构 op，一次撤销）。
     *
     * 同一个入口在两种表里长成不同的东西：平表 ⇒ 多一行（行＝直接子块）；
     * 结构映射表 ⇒ 多一列（表头＝直接子块，它的孩子是这一列的各项）。
     * 也用它给某一列末尾加一项（`blockId` 传那一列的表头块）。
     *
     * 不继承容器的标签：标签是分类归属，不是父子关系（父子关系不是「像爸爸」）。
     */
    viewInsertRow: (blockId) => {
      const b = d.kb.get(blockId)
      if (!b) return false
      if (isQueryBlock(b)) return false // 查询源的行是命中，不是「这里能长出块」
      const row = mkBlock('')
      d.run((tx) => tx.insert(row, blockId, b.children.length))
      after()
      return true
    },

    /** 删除一行 ＝ 软删那个子块（可恢复；不是从状态里抹掉） */
    viewDeleteRow: (rowId) => {
      const b = d.kb.get(rowId)
      if (!b) return false
      d.run((tx) => tx.remove(rowId))
      after()
      return true
    },

    /**
     * 排序。
     *
     * 三种源/视图的落点**各不相同**（这不是分支癖，是语义）：
     *   · children ＋ 平表：写 `activeView.table.sort` —— **只改显示序**，`children` 顺序一个字节不动；
     *   · children ＋ 结构映射表：写 `activeView.list.sort`，键是**第几列**（位置），不是列定义；
     *   · 查询源：写 `_query.sort` 并重算 —— 排序可能影响 `limit` 的成员，所以必须重查。
     *
     * `dir === ''` ＝ 清掉这一格的排序（表头第三次点击的落点）。
     */
    viewSetSort: (blockId, by, dir) => {
      const b = d.kb.get(blockId)
      if (!b) return false
      const direction = dir === 'desc' ? 'desc' : dir === 'asc' ? 'asc' : ''
      const sort = direction === '' ? [] : [{ by, dir: direction as 'asc' | 'desc' }]
      if (isQueryBlock(b)) {
        const spec = readSpec(b)
        if (!spec) return false
        d.run((tx) =>
          tx.patch(blockId, (x) => {
            refreshSpec(x, { ...spec, sort }, d.kb)
          }),
        )
        after()
        return true
      }
      const active = activeView(b)
      if (!active) return false
      if (active.kind === 'list-table') {
        // `by` 在这一档是**列序号**（命令面只有字符串参数，语义由视图种类决定）
        const col = Number(by)
        if (!Number.isInteger(col) || col < 0) return false
        d.run((tx) =>
          tx.patch(blockId, (x) => {
            const cur = activeView(x)
            if (!cur) return
            const next: ListSort | undefined = direction === '' ? undefined : { col, dir: direction }
            writeViews(x, upsertView(readViews(x), withListSort(cur, next)))
          }),
        )
        after()
        return true
      }
      d.run((tx) =>
        tx.patch(blockId, (x) => {
          const cur = activeView(x)
          if (!cur) return
          writeViews(x, upsertView(readViews(x), withSort(cur, sort)))
        }),
      )
      after()
      return true
    },
  }
}
