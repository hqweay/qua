/**
 * **视图命令**：一个**拥有者**「怎么看」的增删改与行操作。
 *
 * 四条纪律（与模型层同源）：
 *   · 只写拥有者上的两个系统属性（`_views`／`_activeView`）——视图不是实体，没有自己的块；
 *     「这两个属性在哪」由 `ViewOwnerStore` 回答，命令层不自己摸 `props`；
 *   · **写配置一个字节都不碰记录**（删/换/改名视图，子块的正文与位置原样）；
 *   · 一次动作一条事务（＝一轮撤销），且**结构写（新建/删除行）也走事务**，
 *     否则换库之后那条块没有行可落；
 *   · **表头排序只写视图的显示序**：查询源的成员顺序住在 `QuerySpec.sort` 里，
 *     由构建器编辑。点表头不该换一批行。
 *
 * ⚠️ 这里不碰 DOM：切换视图之后要让屏幕跟上，走注入的 `reloadPage`（装配层的重装入口）。
 */
import {
  canonicalSpec,
  defaultColumnsForSource,
  isQueryBlock,
  isQueryNode,
  mkBlock,
  mkQueryBlock,
  mkViewId,
  readViewSet,
  removeView,
  renameView,
  resolveView,
  sourceOfOwner,
  storedKindsFor,
  upsertView,
  viewNameOf,
  withFilter,
  withGroup,
  withListSort,
  withSort,
  type Block,
  type ListSort,
  type Source,
  type ViewConfig,
  type ViewOwnerRef,
} from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import type { App } from '../../core/infra/ports.ts'
import type { ViewConfigDeps } from './types.ts'

/** 库里第一个某种 kind 的属性定义（看板的分组列／日历的日期列先给一个能用的） */
function firstDefOf(d: ViewConfigDeps, kind: string): string | undefined {
  return d.kb.propDefs().find((def) => def.props?._kind === kind)?.id
}

/** 一个拥有者这一刻的源（写配置前先问：能不能建这种 kind，看的是源） */
function sourceOfRef(d: ViewConfigDeps, owner: ViewOwnerRef): Source | null {
  const data = d.owners.read(owner)
  if (!data) return null
  const host = owner.kind === 'block' ? d.kb.get(owner.blockId) : undefined
  return sourceOfOwner(owner, data, host)
}

export function viewConfigCommands(
  d: ViewConfigDeps,
): Pick<
  App,
  | 'addView'
  | 'setActiveView'
  | 'removeView'
  | 'renameActiveView'
  | 'viewInsertRow'
  | 'viewDeleteRow'
  | 'viewSetSort'
  | 'viewSetGroup'
  | 'setViewFilter'
  | 'setQuerySpec'
  | 'createQuery'
> {
  /**
   * 换完视图要让屏幕跟上。
   *
   * 三条判据，按「谁在画这一块」分：
   *   · **整屏唯一的根** ⇒ 装载形状变了（正文只画根行 / 恢复子树）⇒ 重装这一屏；
   *   · **已经有表面在画它**（正文里的内联体、侧槽窗口的卡、挂载区的栏）⇒ 那台视图宿主
   *     自己订阅了拥有者的配置，就地重画。**不换屏、不动光标**：切个看法不该把用户
   *     正在读/写的位置换掉，更不该把这一块放大成整屏；
   *   · **没有表面在画它**（收藏块、children 源的激活视图只在打开时才画）⇒ 把这一块打开，
   *     否则配置写进了模型、屏幕一动不动（点了没生效）。
   */
  const reveal = (owner: ViewOwnerRef): void => {
    if (owner.kind !== 'block') {
      // local tab：它就在当前这一屏的挂载区里 ⇒ 重画当前屏就够（换屏会把用户带离宿主）
      d.reloadPage()
      return
    }
    const roots = d.rootIds()
    if (roots.length === 1 && roots[0] === owner.blockId) {
      d.reloadPage()
      return
    }
    /**
     * **它自己是这一屏的一个根**（日记流的一天、并排的一页）：装载形状与换屏都归中心编辑器，
     * 而「给这一天建一张表」本来就是要看见那一屏 —— 照旧打开它。
     */
    if (roots.includes(owner.blockId)) {
      d.openBlock(owner.blockId)
      return
    }
    /**
     * **它是这一屏里的一行，且已经有表面在画它的身体**（正文内联体／侧槽窗口的卡／挂载区的栏）
     * ⇒ 那台视图宿主自己订阅了拥有者的配置，就地重画就够。
     * **不换屏、不动光标**：切个看法不该把用户正在读/写的位置换掉，更不该把这一行放大成整屏。
     */
    if (d.viewShown(owner.blockId)) return
    d.openBlock(owner.blockId)
  }
  /** 只重装，不换屏（行操作：容器本来就是这一屏的根，才可能走到这些入口） */
  const after = (): void => d.reloadPage()

  return {
    /**
     * 新建一个视图并设为激活。
     *
     * 表格的列**在这里算一次**（`defaultColumnsForSource`）：算完写进配置，之后不随结果漂移。
     * ⚠️ **源不兼容的 kind 当场拒绝**（表只有 `STORED_KINDS_BY_SOURCE` 一张）：
     *    写进去也会被 `canonicalViews` 丢掉，那是「点了没生效」。
     */
    addView: (owner, kindRaw) => {
      const source = sourceOfRef(d, owner)
      if (!source) return ''
      const kind = storedKindsFor(source).find((k) => k === kindRaw)
      if (!kind) {
        d.toast(t('ui.view.unknownKind'), 'warn')
        return ''
      }
      const id = mkViewId()
      const view: ViewConfig = { id, kind }
      if (kind === 'table') {
        view.table = { columns: defaultColumnsForSource(source, d.kb) }
      } else if (kind === 'cards') {
        /**
         * 卡片**默认就是画廊**：不分组、封面取正文第一张图。
         *
         * 想要看板不是「建另一种东西」——在抬头选一个分组列，容器自己变成列
         * （`cardLayoutOf` 从 `groupBy` 派生布局）。所以这里不需要任何属性、
         * 也不会因为「没有 select」拒绝建：一张卡片随时能建，随时能分组。
         */
        view.cards = { cover: 'first-asset' }
      } else if (kind === 'calendar') {
        // 日期列：第一个 `date` 定义；任何块都可能有 `_date`（日记块）⇒ 退到它
        view.calendar = { dateBy: firstDefOf(d, 'date') ?? '_date' }
      } else if (kind === 'mindmap') {
        view.mindmap = { direction: 'both' }
      }
      /**
       * 建视图就给**默认名**（kind 显示名，撞名加序号）：`name` 字段一直在，此前无人填，
       * 于是同 kind 多张在菜单里全叫一个名字，只能靠顺序猜。「表格」「表格 2」
       * 从此分得开；改名入口另立，不在这里。
       */
      const taken = new Set(
        (d.owners.read(owner)?.views ?? []).map((v) => viewNameOf(v, (k) => t(`ui.view.kind.${k}`))),
      )
      {
        const base = t(`ui.view.kind.${kind}`)
        let name = base
        for (let n = 2; taken.has(name); n++) name = `${base} ${n}`
        view.name = name
      }
      d.owners.write(owner, { views: upsertView(d.owners.read(owner)?.views ?? [], view), activeView: id })
      reveal(owner)
      return id
    },

    /**
     * 切换激活视图。`viewId === ''` ＝ **默认看法**（删掉 `_activeView`，不是存一个 `kind:'outline'`）。
     *
     * 指向一个不存在的 id 时**不写**：那会把拥有者变成一个「配置坏了」的状态，
     * 而用户看到的是「点了没反应」——不如当场什么都不做（调用方只可能是菜单）。
     */
    setActiveView: (owner, viewId) => {
      const data = d.owners.read(owner)
      if (!data) return false
      const target = viewId.trim()
      if (target !== '' && !resolveView(data, target)) return false
      d.owners.write(owner, { activeView: target === '' ? '' : target })
      reveal(owner)
      return true
    },

    /** 删一个视图：只动配置。删的正是激活那个 ⇒ 指向相邻一项，没有就回默认看法 */
    removeView: (owner, viewId) => {
      const data = d.owners.read(owner)
      if (!data) return false
      const at = data.views.findIndex((v) => v.id === viewId)
      if (at < 0) return false
      const next = removeView(data.views, viewId)
      const wasActive = readViewSet(data).active?.id === viewId
      const patch: { views: ViewConfig[]; activeView?: string } = { views: next }
      if (wasActive) {
        const fallback = next[Math.min(at, next.length - 1)]?.id ?? ''
        patch.activeView = fallback
      }
      d.owners.write(owner, patch)
      reveal(owner)
      return true
    },

    /** 给当前激活的视图改名（空名 ⇒ 回到按 kind 的默认名） */
    renameActiveView: (owner, name) => {
      const data = d.owners.read(owner)
      if (!data) return false
      const active = readViewSet(data).active
      if (!active) return false
      d.owners.write(owner, { views: renameView(data.views, active.id, name) })
      reveal(owner)
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
    viewInsertRow: (owner, blockId) => {
      const source = sourceOfRef(d, owner)
      if (!source) return false
      // 查询源的行是命中，不是「这里能长出块」
      if (source.kind === 'query') return false
      const containerId = blockId !== undefined && blockId !== '' ? blockId : source.blockId
      const container: Block | undefined = d.kb.get(containerId)
      if (!container || isQueryBlock(container)) return false
      const row = mkBlock('')
      d.run((tx) => tx.insert(row, containerId, container.children.length))
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
     * 表头排序：**只写视图的显示序**。
     *
     * 三种落点（不是分支癖，是语义）：
     *   · 平表 ⇒ `view.table.sort`（键＝列）；
     *   · 结构映射表 ⇒ `view.listTable.sort`（键＝**第几列**，位置）；
     *   · 查询源**不再**写 `QuerySpec.sort` —— 那是成员顺序，由构建器编辑。
     *     点表头只排当前这批成员，不重查。
     *
     * `dir === ''` ＝ 清掉这一格的排序（表头第三次点击的落点）。
     */
    viewSetSort: (owner, viewId, by, dir) => {
      const data = d.owners.read(owner)
      if (!data) return false
      const view = resolveView(data, viewId)
      if (!view) return false
      const direction = dir === 'desc' ? 'desc' : dir === 'asc' ? 'asc' : ''
      if (view.kind === 'list-table') {
        // `by` 在这一档是**列序号**（命令面只有字符串参数，语义由视图种类决定）
        const col = Number(by)
        if (!Number.isInteger(col) || col < 0) return false
        const next: ListSort | undefined = direction === '' ? undefined : { col, dir: direction }
        d.owners.write(owner, { views: upsertView(data.views, withListSort(view, next)) })
        after()
        return true
      }
      if (view.kind !== 'table') return false
      const sort = direction === '' ? [] : [{ by, dir: direction as 'asc' | 'desc' }]
      d.owners.write(owner, { views: upsertView(data.views, withSort(view, sort)) })
      after()
      return true
    },

    /**
     * 写**分组键**（记录视图共用位）：`groupBy === ''` ＝ 清掉分组。
     *
     * 分组是**视图配置**，不是查询的一部分：改它不重查、不换成员，只是这批记录
     * 换一种摆法。`groupOrder` 由看板按声明序回填（用户拖序是另一批事）。
     */
    viewSetGroup: (owner, viewId, groupBy, groupOrder) => {
      const data = d.owners.read(owner)
      if (!data) return false
      const view = resolveView(data, viewId)
      if (!view) return false
      d.owners.write(owner, { views: upsertView(data.views, withGroup(view, groupBy, groupOrder)) })
      after()
      return true
    },

    /**
     * 写**这一张视图的切片**（基础条件 ∩ 切片里的后半句）。
     *
     * 与 `setQuerySpec` 的分工：那份基础条件全视图共享、住在源的 `_query`；
     * 切片只属于一张视图、住在它的 `filter`。这里**不碰 `_query`**：
     * 叠加是求值时的事（`slicedSpec`），不是把切片并进基础条件。
     *
     * `filter === null` ＝ 清掉切片（删键，不留空值）。
     * 源不是 query ⇒ 当场拒绝并提示：children/items 没有可叠加的条件，
     * 写进去会被 `canonicalViews` 丢掉（「点了没生效」）。
     */
    setViewFilter: (owner, viewId, filter) => {
      const data = d.owners.read(owner)
      if (!data) return false
      const source = sourceOfRef(d, owner)
      if (!source || source.kind !== 'query') {
        d.toast(t('ui.view.sliceOnlyQuery'), 'warn')
        return false
      }
      const view = resolveView(data, viewId)
      if (!view) return false
      if (filter !== null && !isQueryNode(filter)) return false
      d.owners.write(owner, { views: upsertView(data.views, withFilter(view, filter)) })
      reveal(owner)
      return true
    },

    /**
     * 写条件（构建器／JSON 的落点）。**只写 `_query`**，不写结果 ——
     * 结果由每个表面实例自己冻结：条件变了 ⇒ `specKey` 变 ⇒ 那一处自动重算。
     */
    setQuerySpec: (owner, spec) => {
      const data = d.owners.read(owner)
      if (!data) return false
      if (!spec || typeof spec !== 'object' || !spec.where) return false
      d.owners.write(owner, { query: canonicalSpec(spec) })
      reveal(owner)
      return true
    },

    /**
     * 建一个**查询块**（内容对象）。
     *
     * 与 local tab 的分工：查询块能被 `[[ ]]` 引用、能进回收站、能多处 embed；
     * local tab 只是「这一块下面的一栏」。需要命名/引用/共享时才建它。
     *
     * 默认落**森林顶层**（与页同一条口径）：它是内容对象，没有容器 ⇒ 上下文是全库。
     * 要就地放一个（不命名、挂在当前位置）走 `core.query/insert`：空块原地变查询块，
     * 有正文就建在它后面（见 `App.insertQueryBlock`）。
     *
     * ⚠️ **查询块是叶子**：不给它「加子块」的入口（children 不是 query 源），
     *    否则用户会看到「加了但看不见」。
     */
    createQuery: (name, spec, parentId) => {
      if (!spec || typeof spec !== 'object' || !spec.where) return ''
      const label = name.trim() === '' ? t('ui.query.untitled') : name.trim()
      const block = mkQueryBlock({ name: label, spec, icon: 'lucide:list-filter' })
      d.run((tx) => {
        if (parentId === undefined) tx.insert(block, null, d.kb.roots().length)
        else tx.insert(block, parentId, Number.MAX_SAFE_INTEGER)
      })
      d.refreshList()
      reveal({ kind: 'block', blockId: block.id })
      return block.id
    },
  }
}
