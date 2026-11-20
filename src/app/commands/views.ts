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
  hasChildrenViewBody,
  hasQueryBody,
  storedKindsFor,
  upsertView,
  viewNameOf,
  withFilter,
  withCover,
  withGroup,
  withTabsDirection,
  withListSort,
  axesFor,
  PAGE_COLUMN,
  setValue,
  sortKeysOfRaw,
  withSort,
  withDisplay,
  withWidth,
  displayPropsOfRaw,
  withStructureGroup,
  type Block,
  type ListSort,
  type Source,
  type StoredViewKind,
  type ViewConfig,
  type ViewOwnerRef,
} from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import type { App } from '../../core/infra/ports.ts'
import type { KbClient } from '../../core/kb/types.ts'
import { propValueIssue } from './props.ts'
import type { ViewConfigDeps } from './types.ts'

/** 一个拥有者这一刻的源（写配置前先问：能不能建这种 kind，看的是源） */
function sourceOfRef(d: ViewConfigDeps, owner: ViewOwnerRef): Source | null {
  const data = d.owners.read(owner)
  if (!data) return null
  const host = owner.kind === 'block' ? d.kb.get(owner.blockId) : undefined
  return sourceOfOwner(owner, data, host)
}

/**
 * 建一张**默认配置**的视图：kind 兜底（表格列／卡片封面／日历日期列）＋ 默认名。
 *
 * 兜底写两份就会漂移，所以 `addView`（视图菜单）与斜杠「插入看法」共用这一份。
 * `existing` 只用来给同名 kind 加序号（「表格」「表格 2」）——新块没有兄弟视图，
 * 斜杠那条传缺省即可。源不兼容的 kind 返回 `null`（表只有 `STORED_KINDS_BY_SOURCE` 一张：
 * 写进去也会被 `canonicalViews` 丢掉，那是「点了没生效」）。
 */
export function buildFreshView(
  kb: KbClient,
  source: Source,
  kind: StoredViewKind,
  existing: readonly ViewConfig[] = [],
): ViewConfig | null {
  if (!storedKindsFor(source).includes(kind)) return null
  const view: ViewConfig = { id: mkViewId(), kind }
  if (kind === 'cards') {
    // 卡片默认就是画廊（不分组、封面取正文首图）；要看板是抬头选一个分组列，不是另一种东西
    view.cards = { cover: 'first-asset' }
  } else if (kind === 'calendar') {
    // 日期列：第一个 `date` 定义；任何块都可能有 `_date`（日记块）⇒ 退到它
    view.calendar = { dateBy: kb.propDefs().find((def) => def.props?._kind === 'date')?.id ?? '_date' }
  } else if (kind === 'mindmap') {
    view.mindmap = { direction: 'both' }
  }
  // 建视图就给默认名（kind 显示名，撞名加序号）：同 kind 多张在菜单里才分得开
  const taken = new Set(existing.map((v) => viewNameOf(v, (k) => t(`ui.view.kind.${k}`))))
  const base = t(`ui.view.kind.${kind}`)
  let name = base
  for (let n = 2; taken.has(name); n++) name = `${base} ${n}`
  view.name = name
  return view
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
  | 'viewNewCard'
  | 'viewDeleteRow'
  | 'viewSetSort'
  | 'viewSetDisplay'
  | 'viewSetListSort'
  | 'viewSetWidth'
  | 'viewSetGroup'
  | 'viewSetCover'
  | 'viewSetTabsDirection'
  | 'setViewFilter'
  | 'setViewPaths'
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
   *   · **没有表面在画它**（收藏块、激活视图但无行内体的表面）⇒ 把这一块打开，
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
     * **它的身体会就地画**（查询源／children 源激活视图）：重画之后身体自己出现在
     * 这一行下面——不换屏、不动光标。首次激活时身体还没挂上（`viewShown` 看不到），
     * 所以这条要走在 `viewShown` 前面，否则会把用户拽去整屏。
     *
     * 两个前提，缺一个就退回「打开它」：
     *  · **树在当前屏上**（是某个根的后代）——不在屏上的块重画多少遍都看不见，
     *    创建路径（查询块落森林顶层）就栽在「重画了但什么都没出现」；
     *  · **行真的由主编辑器画着**——中间任何一层带了行内体（页签／卡片／查询身体），
     *    它的行已经让位给那一层的身体岛，主编辑器重画够不到它（子块的页签就栽在
     *    「重画了，岛没动」）。
     */
    const b = d.kb.get(owner.blockId)
    const path = d.kb.pathOf(owner.blockId)
    const onScreen = d.rootIds().some((rid) => path.some((p) => p.id === rid))
    const inBodyIsland = path.some(
      (p) => p.id !== owner.blockId && (hasQueryBody(p) || hasChildrenViewBody(p)),
    )
    if (b && onScreen && !inBodyIsland && (hasQueryBody(b) || hasChildrenViewBody(b))) {
      // 轻重画（编辑器自己重读 roots＋重画＋恢复选区），不走整页装载——那会清掉光标
      d.rerenderEditor()
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
     * 新建一个视图并设为激活。兜底配置与默认名收在 `buildFreshView`（与斜杠「插入看法」共用）。
     */
    addView: (owner, kindRaw) => {
      const source = sourceOfRef(d, owner)
      if (!source) return ''
      const data = d.owners.read(owner)
      const view = buildFreshView(d.kb, source, kindRaw as StoredViewKind, data?.views ?? [])
      if (!view) {
        d.toast(t('ui.view.unknownKind'), 'warn')
        return ''
      }
      d.owners.write(owner, { views: upsertView(data?.views ?? [], view), activeView: view.id })
      reveal(owner)
      return view.id
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

    /**
     * 看板列尾「新建」：新卡**出生时就带着这一列的值**（拖卡写值是同一格的搬运，
     * 这是它的出生版）——插块与写值在同一笔事务里，一轮撤销整体回退。
     * 落点跟源语义走：children/items 源的记录本来就是容器的直接子块 ⇒ 插容器末尾；
     * 查询源的命中没有天然父块 ⇒ 住顶层（与记录、备注同一条「没有宿主的内容住顶层」
     * 的口径），视图自己负责把「没进结果」说明白。
     */
    viewNewCard: (owner, propId, value) => {
      const source = sourceOfRef(d, owner)
      if (!source) return false
      // 值校验与 set-value 同一道闸（坏值不写；值来自既有记录，这一般只是兜底）
      const issue = propValueIssue(d.kb.propDefs().find((x) => x.id === propId), value)
      if (issue) {
        d.toast(issue, 'warn')
        return false
      }
      let parentId: string | null = null
      let index = d.kb.roots().length
      if (source.kind !== 'query') {
        const container: Block | undefined = d.kb.get(source.blockId)
        if (!container || isQueryBlock(container)) return false
        parentId = source.blockId
        index = container.children.length
      }
      const row = mkBlock('')
      // 值在插进事务**之前**写上（同一笔 tx 里 patch 新插的块会被拒）：
      // 新卡出生时就带着这一列的值，插块与写值仍是一笔事务、一轮撤销
      if (value !== undefined && value !== null) setValue(row, propId, value)
      d.run((tx) => {
        tx.insert(row, parentId, index)
      })
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
     * 写**显示排序**（顶层轴，多键：数组序即优先级）。
     *
     * 只写视图的显示序——不重查、不改成员（`QuerySpec.sort` 是成员顺序，由构建器编辑）。
     * `sort` 是原始数组，形状校验在 `sortKeysOfRaw`；空数组 ＝ 不排序（删键）。
     * 矩阵不认 sort 的看法（默认看法、页签、日历…）当场拒绝：写了也会被
     * `canonicalViews` 丢掉，那是「点了没生效」。
     */
    viewSetSort: (owner, viewId, sort) => {
      const data = d.owners.read(owner)
      if (!data) return false
      const view = resolveView(data, viewId)
      const source = sourceOfRef(d, owner)
      if (!view || !source) return false
      if (!axesFor(source, view.kind).includes('sort') || view.kind === 'list-table') {
        d.toast(t('ui.view.axisNotSupported'), 'warn')
        return false
      }
      d.owners.write(owner, { views: upsertView(data.views, withSort(view, sortKeysOfRaw(sort))) })
      // 排序只换这批记录的显示序：屏幕跟着靠每台 ViewHost 自己的订阅就地重画。
      // 用 reveal（不是 after 的整页重装）——挂载区/内联体里已经画着这一块时它直接返回，
      // 否则整页 reload 会把查询体连同行一起拆建一次，点一下「应用」闪一下。
      reveal(owner)
      return true
    },

    /**
     * 写**结构映射表的排序**（矩阵的声明例外：键是**第几列**的位置，不与 `sort` 合成一个键空间）。
     * `dir === ''` ＝ 清掉（菜单的第三击）。
     */
    viewSetListSort: (owner, viewId, col, dir) => {
      const data = d.owners.read(owner)
      if (!data) return false
      const view = resolveView(data, viewId)
      if (!view || view.kind !== 'list-table') return false
      const position = Number(col)
      if (!Number.isInteger(position) || position < 0) return false
      const direction = dir === 'desc' ? 'desc' : dir === 'asc' ? 'asc' : ''
      const next: ListSort | undefined = direction === '' ? undefined : { col: position, dir: direction }
      d.owners.write(owner, { views: upsertView(data.views, withListSort(view, next)) })
      after()
      return true
    },

    /**
     * 写**列宽**（含标题列；布局元数据，与显示白名单分开两个位）。
     * `width === null` ＝ 回到缺省宽度（删键）。只认表格视图：宽度是平表的形状。
     */
    viewSetWidth: (owner, viewId, key, width) => {
      const data = d.owners.read(owner)
      if (!data) return false
      const view = resolveView(data, viewId)
      if (!view || view.kind !== 'table' || typeof key !== 'string' || key === '') return false
      if (width !== null && (typeof width !== 'number' || !Number.isFinite(width))) return false
      d.owners.write(owner, { views: upsertView(data.views, withWidth(view, key, width)) })
      after()
      return true
    },

    /**
     * 写**显示白名单**（显示轴的视图级写口）。形状校验在 `displayPropsOfRaw`：
     * 标题列不在清单里（它是行身份）、其余按 key 去重——坏项丢掉而不是让整表消失。
     * **空数组是合法值**（＝只标题）；`null` ＝ 清掉白名单，回到该看法的缺省。
     * 矩阵不认 display 的看法当场拒绝；`viewId === ''` ＝ 默认看法的显示覆写
     * （`_defaultDisplayProps`，与 `_defaultFilter` 同一层）。
     */
    viewSetDisplay: (owner, viewId, props) => {
      const data = d.owners.read(owner)
      if (!data) return false
      const next = props === null ? null : displayPropsOfRaw(props)
      if (viewId === '') {
        const source = sourceOfRef(d, owner)
        if (!source || !axesFor(source, 'outline').includes('display')) {
          d.toast(t('ui.view.axisNotSupported'), 'warn')
          return false
        }
        d.owners.write(owner, { defaultDisplayProps: next })
        reveal(owner)
        return true
      }
      const view = resolveView(data, viewId)
      const source = sourceOfRef(d, owner)
      if (!view || !source) return false
      if (!axesFor(source, view.kind).includes('display')) {
        d.toast(t('ui.view.axisNotSupported'), 'warn')
        return false
      }
      d.owners.write(owner, { views: upsertView(data.views, withDisplay(view, next)) })
      after()
      return true
    },

    /**
     * 写**卡片封面**：`first-asset`（有图才显示）／`none`（纯文字卡）。
     * 只认卡片视图：别的 kind 写进去会被 `canonicalViews` 丢掉（那就是「点了没生效」）。
     */
    viewSetCover: (owner, viewId, cover) => {
      const data = d.owners.read(owner)
      if (!data) return false
      const view = resolveView(data, viewId)
      if (!view || view.kind !== 'cards') return false
      d.owners.write(owner, { views: upsertView(data.views, withCover(view, cover)) })
      reveal(owner)
      return true
    },

    /**
     * 写**页签的切换条方向**：横向（缺省）／纵向。
     *
     * 只对页签视图有意义：别的 kind 没有切换条，写进去也只会被 `canonicalViews`
     * 丢掉——命令面先挡，免得「点了没生效」。
     */
    viewSetTabsDirection: (owner, viewId, direction) => {
      const data = d.owners.read(owner)
      if (!data) return false
      const view = resolveView(data, viewId)
      if (!view || view.kind !== 'tabs') return false
      if (direction !== 'horizontal' && direction !== 'vertical') return false
      d.owners.write(owner, { views: upsertView(data.views, withTabsDirection(view, direction)) })
      after()
      return true
    },

    /**
     * 写**分组键**（记录视图共用位）：`groupBy === ''` ＝ 清掉分组。
     *
     * 分组是**视图配置**，不是查询的一部分：改它不重查、不换成员，只是这批记录
     * 换一种摆法。`groupOrder` 由看板按声明序回填（用户拖序是另一批事）。
     */
    viewSetGroup: (owner, viewId, groupBy, groupOrder, structure) => {
      const data = d.owners.read(owner)
      if (!data) return false
      /**
       * `viewId === ''` 是**默认大纲的分段键**（拥有者的 `_defaultGroup`）——
       * 与 set-filter 的空串分支同一约定。大纲只有「所在页」一档有面
       * （分段＝投影重排，按字段分大纲没有需求信号）；`''` ＝ 清掉。
       */
      if (viewId === '') {
        const source = sourceOfRef(d, owner)
        if (!source || source.kind !== 'query') {
          d.toast(t('ui.view.groupOnlyQuery'), 'warn')
          return false
        }
        if (groupBy !== '' && groupBy !== PAGE_COLUMN) return false
        d.owners.write(owner, { defaultGroup: groupBy === '' ? null : groupBy })
        reveal(owner)
        return true
      }
      const view = resolveView(data, viewId)
      if (!view) return false
      /**
       * 两种分组来源互斥，写一边清另一边：
       *   · `structure` ⇒ 组＝容器的直接子块（组有身份，拖卡＝换父）；
       *   · 否则 ⇒ 按值分组（`''` 把它们一起清掉）。
       * 允许写进不支持的 kind／源由 `canonicalViews` 兜底——但命令面先挡一次，
       * 免得「点了没生效」。
       */
      if (structure === true && (view.kind !== 'cards' || sourceOfRef(d, owner)?.kind !== 'children')) {
        d.toast(t('ui.view.structureOnlyChildren'), 'warn')
        return false
      }
      const next = structure === true ? withStructureGroup(view, true) : withGroup(view, groupBy, groupOrder)
      d.owners.write(owner, { views: upsertView(data.views, next) })
      after()
      return true
    },

    /**
     * 写**这一张视图的 filter**（两种语义共用一份 `QueryNode`，落点由矩阵回答）：
     *   · query 源＝**切片**（基础条件 ∩ 切片；与 `setQuerySpec` 的分工：基础条件全视图共享）；
     *   · children 记录视图＝**显示掩码**（不匹配的行消失，children 顺序一个字节不动）。
     *
     * `filter === null` ＝ 清掉（删键，不留空值）。
     * 矩阵不认 filter 的看法（映射表、导图）当场拒绝；默认看法（`viewId === ''`）只有
     * query 源接（`_defaultFilter`）——children 源的默认大纲筛选另需按父块的行过滤，未做。
     */
    setViewFilter: (owner, viewId, filter) => {
      const data = d.owners.read(owner)
      if (!data) return false
      const source = sourceOfRef(d, owner)
      if (!source) return false
      if (filter !== null && !isQueryNode(filter)) return false
      if (viewId === '') {
        if (source.kind !== 'query') {
          d.toast(t('ui.view.sliceOnlyQuery'), 'warn')
          return false
        }
        d.owners.write(owner, { defaultFilter: filter })
        reveal(owner)
        return true
      }
      const view = resolveView(data, viewId)
      if (!view) return false
      if (!axesFor(source, view.kind).includes('filter')) {
        d.toast(t('ui.view.sliceOnlyQuery'), 'warn')
        return false
      }
      d.owners.write(owner, { views: upsertView(data.views, withFilter(view, filter)) })
      reveal(owner)
      return true
    },

    /**
     * 写**行首路径显隐**（默认看法的那一格）：只有 `false`（关）与 `null`（开回默认）。
     *
     * 行首面包屑只存在于**默认大纲**（命中行的位置投影）——命名视图没有大纲、
     * 记录视图的路径走「路径」列（显示轴管），所以这里没有 viewId 位；
     * 写到非 query 源当场拒绝（children 大纲的行住在真树上，位置由缩进表达）。
     */
    setViewPaths: (owner, showPaths) => {
      const data = d.owners.read(owner)
      if (!data) return false
      if (showPaths !== false && showPaths !== null) return false
      const source = sourceOfRef(d, owner)
      if (!source || source.kind !== 'query') {
        d.toast(t('ui.view.pathsOnlyQuery'), 'warn')
        return false
      }
      d.owners.write(owner, { defaultShowPaths: showPaths })
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
