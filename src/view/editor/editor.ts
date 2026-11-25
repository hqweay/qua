/**
 * 视图层 —— **单一 contenteditable 容器 ＋ 块级 DOM** 的形状：单一 contenteditable 容器 ＋ **块级 DOM**（扁平 ＋ `data-depth`），
 * 行内原子用 `contenteditable=false`；没有被编辑的块不额外套 contenteditable。
 *
 * 两条实测逼出来的结论在此继续成立（不许破坏）：
 *  1. **缩进不用 DOM 层级，用扁平 ＋ data-depth ＋ padding**（DOM 层级与窗口化虚拟化互相打架）；
 *  2. **组合期（IME composing）不重渲染该块**，只改模型，`compositionend` 后再补渲染。
 *
 * 行内内容＝**run 序列**（`core/runs.ts`）：文本段带自己的格式，原子是序列里不可分的一枚。
 * ⇒ 正文没有「长度 1 的区间锚点」这回事：原子的位置由邻居携带，删原子一定是显式动作。
 * 折叠（收起的子树不挂 DOM；折叠态是**文档级视图状态**）、待办复选框、悬停左侧 gutter
 * （折叠箭头／圆点／拖拽把手）、拖拽重排（HTML5 DnD，before/after/inside 三区）。
 * 键盘**一个都不在这里处理**——全部交给绑定表。
 */
import {
  BlockStore,
  CommandLog,
  UndoStack,
  activeView,
  blockMenuCtxOf,
  blockTypeOf,
  ensurePageInTx,
  flatten,
  locate,
  runAtCell,
  blockSpanPlan,
  hasTag,
  hasLiveChildren,
  liveChildren,
  mkBlock,
  trashOf,
  normSel,
  tagIdsOf,
  typeDeclOf,
  selToTextRanges,
  isFolded,
  isJournal,
  focusRootOf,
  isEmbedBlock,
  toggleChildrenCollapsed,
  toggleCollapsed,
  unfoldBlock,
  dropRefused,
  type RowVerdict,
  writeBlockContent,
  walkForest,
  gutterFieldsOf,
  relationsFrom,
  relationsTo,
  isRefKind,
  fieldTableOf,
  applyClosurePlan,
  closurePlanFor,
  closureFieldOf,
  setValue,
  clearValue,
  closureOf,
  CODE_TYPE,
  CAPTION_PROP,
  TASK_STATUS_PROP_ID,
  canWriteText,
  canDirectEditText,
  isOwnEdit,
  type Block,
  type ClosurePlan,
  type CtxKeys,
  type Doc,
  type FieldTable,
  type BelowFields,
  type Sel,
  type UndoKind,
  type VisibleRow,
} from '../../core/index.ts'
import { indexPathOf } from '../../core/infra/index-port.ts'
import { copyTextOf, resolveRef, type FindBlock } from '../../core/relations/ref.ts'
import type { RelationEdge } from '../../core/relations/relations.ts'
import { inputSession } from './input-session.ts'
import { RowProjection } from './row-projection.ts'
import {
  clearMarks as clearRunsMarks,
  isEmptyContent,
  marksInRange,
  mkAnno,
  plainLen,
  plainText,
  removeRunById,
  refRunsOf,
  runById,
  sameRuns,
  sliceRuns,
  spliceRuns,
  toggleMark as toggleRunMark,
  type LinkRun,
  type MarkPatch,
  type RefRun,
  type Run as InlineRun,
  type RunWithId,
  type Anno,
} from '../../core/model/runs.ts'
import { ensureNoteInTx } from '../../core/kb/ensure-note.ts'
import type { NotePair } from '../../core/relations/annotates.ts'
import { type OpenAction, type SecLayout, type ShellCol } from '../../core/index.ts'
export type { SecLayout }

/**
 * **视口锚**：顶部那一块 ＋ 它相对滚动容器顶的偏移。
 *
 * `delta` 可为负（块顶已被滚出视口）；`top` 只在锚点块被删／找不到时兜底。
 * 不存纯像素：上方插入／删除后，同一像素会落到别的块上。
 */
export interface ScrollAnchor {
  blockId: string
  delta: number
  top: number
}

/**
 * **一个视图的位置状态**（纯视图状态，不入库）：
 * 视口锚 ＋ 模型选区（为空＝用户只是浏览，没点块）。
 */
export interface ViewState {
  scroll: ScrollAnchor | null
  sel: Sel | null
}

// 只取**类型**：`view` 拿不到实现，写入的落地方式归装配层（见 `Run`）
import type { Op, Tx } from '../../core/kb/types.ts'
import { mergeCapture, type UndoCapture } from '../../core/kb/scoped.ts'
import type { AssetView } from '../../core/infra/assets.ts'
// 标签块的「找到或创建」有两种落地（直写 / 事务），判据只有一份
import { ensureTagInTx, tagLookupOf } from '../../core/kb/ensure-tag.ts'
import { deferAliasGate } from '../../core/kb/alias-gate.ts'
import { AliasClaimError } from '../../core/kb/unsupported.ts'
// 任务状态定义块的事务内按需物化：落值之前保证定义在，面板才有行可画
import { ensureTaskStatusInTx } from '../../core/kb/ensure-task.ts'
// 用户可见文案一律走 t
import { t } from '../../core/infra/msg.ts'
import { ALLOWED_ROW_CHILDREN, EDIT_ISLAND_ATTR, inlineBodyKind, isReadonlyBlock, rowHasEmbedViewBody } from './block-dom.ts'
import { ReloadPolicy } from './reload-policy.ts'
import { spanAt, type PlainSpan } from './hit-paint.ts'
import { AnnoHover, type AnnoHitSpan } from './anno-hover.ts'
import { blockIdOf, isCaretAnchorText, isTagChip, offsetIn, readRuns, textEndOff } from './dom-text.ts'
import { Drag } from "./drag.ts"
import { EmbedBodies } from "./embed-bodies.ts"
import { BlockSelection } from "./block-selection.ts"
import { ClipboardOps } from './clipboard-ops.ts'
import { TriggerOps } from './trigger-ops.ts'
import { InsertOps } from './insert-ops.ts'
import { StructOps } from './structure-ops.ts'
import { RenderOps } from './render-ops.ts'
import { bindEditorEvents, type AtomMenuHit, type RefClickHit, type RefClickMods, type TriggerQuery } from './editor-events.ts'

export interface Probe {
  isComposing: boolean
  compositionSeq: string[]
  lastKey: { key: string; isComposing: boolean; trusted: boolean } | null
  lastCommand: { name: string; at: number; via: string } | null
  /** 按键命中追踪（诊断）：这个键命中了哪条规则 / 为什么没命中 */
  keyTrace: { key: string; hit: string; when: string; ok: boolean }[]
  traced: boolean
}

/**
 * **开一个事务**：`view` 只知道「有这么个函数」，不知道它是 `kb.tx`。
 *
 * 为什么是函数形状而不是一个 `kb` 句柄：写入必须是**同步**的（模型改完就返回结果，
 * 方法内要拿新块的 id 去放光标），而「怎么开事务、失败怎么回滚、op 交给谁攒」
 * 都是装配层的决定。`view` 只 import **类型**，不 import 实现 —— 层向内，`core ← view` 成立。
 *
 * `source` ＝ 发起这次写的编辑器（**编辑器自己注入**，装配层的闭包只转发，缺省即没有）：
 * store 的订阅者据此判「发起的视图自己已经渲染过」，跳过自己的重画。
 *
 * ⚠️ 不能由装配层拿「活动编辑器」当 source：跨表面拖拽（从正文拖块进侧槽卡）落手时
 * 焦点从未进过那张卡，活动编辑器还是正文 —— 于是正文把这次通知当成自己写的，跳过
 * 重画，界面停在拖拽前（实测：模型已动、两个表面都不动，点一下别处才补画）。
 *
 * `opts.capture` ＝ 事务出口的撤销捕获（见下）；回报**结果**不变，调用点不必改形状。
 */
export type Run = <R>(
  fn: (tx: Tx) => R,
  source?: unknown,
  opts?: {
    directEdit?: boolean
    /**
     * **事务出口的撤销捕获**（装配层在 `kb.tx` 返回后调）。
     *
     * 为什么是回调而不是让 `Run` 返回 `{result, undo}`：31 个写入口里有 8 个在用返回值，
     * 改返回类型会把「只是想拿个布尔」的地方全部改一遍；回调只多一个可选参数，
     * 收集器（一次动作可能拆成多笔写）也不必知道 `Run` 的形状。
     */
    capture?: (undo: UndoCapture) => void
  },
) => R

/** 滚动联动换窗的提前量（行）：贴着窗口边这几行以内就换，免得看到占位区 */
const WINDOW_SLACK = 4

/**
 * 引用角标的**全库口径只有这一份来源与缓存**（2026-11-25 实测：正文 16／窗口 12）。
 *
 * 正文、窗口、挂载区、查询视图共用同一台 store，但只有装配层拿得到派生表。
 * 早先 fetch 是正文编辑器的私有选项，其余编辑器退回工作集子集 ⇒ 同一块在两个表面
 * 报不同数。把 source 与 cache 放在模块层：每台编辑器照自己可见的 ids 触发批查，
 * 命中的答案所有表面共用；换库时由装配层清一次。返回 `null` 表示派生表还没就绪，
 * 此时仍退回工作集口径（半表不可信）。
 */
type RefBadgeSource = (ids: readonly string[]) => Promise<Map<string, readonly RelationEdge[]> | null>
let refBadgeSource: RefBadgeSource | null = null
const refBadgeCache = new Map<string, readonly RelationEdge[]>()
let refBadgeFetch: Promise<void> | null = null
/** 派生表 ready 翻转/换库时加一：在飞的那次批查不能把旧答案写回新世界 */
let refBadgeEpoch = 0
/** 活编辑器登记表：全库口径变了要当场同刷，不能等用户下一次操作撞上重画 */
const liveEditors = new Set<BlockEditor>()

/** 装配层只设一次；闭包读活引用，换库不需要重设 */
export function setRefBadgeSource(fn: RefBadgeSource): void {
  refBadgeSource = fn
}

/** 换库/作废派生表时清缓存：旧数字不能跟着块 id 过河 */
export function clearRefBadgeCache(): void {
  refBadgeEpoch++
  refBadgeCache.clear()
}

/**
 * 派生表从 pending 翻到 ready 时由装配层调一次：清缓存并让每台活编辑器重查。
 * 不广播的话，窗口/挂载区那几台会停在「工作集子集」直到下一次渲染。
 */
export function refreshRefBadges(): void {
  clearRefBadgeCache()
  for (const ed of liveEditors) ed.refreshRefBadges()
}

/** 并发的几台编辑器共用一次在飞的批查；没查到（未 ready）不写空缓存 */
async function loadRefBadges(ids: readonly string[]): Promise<void> {
  const source = refBadgeSource
  if (!source) return
  const epoch = refBadgeEpoch
  const missing = [...new Set(ids)].filter((id) => !refBadgeCache.has(id))
  if (missing.length === 0) return
  if (refBadgeFetch) {
    const inFlight = refBadgeFetch
    await inFlight
    if (refBadgeFetch === inFlight) refBadgeFetch = null
    // 在飞的那次可能带回旧世界的答案（或返回 null）；epoch 变了就再查一次
    if (refBadgeEpoch !== epoch) await loadRefBadges(ids)
    return
  }
  const job = (async () => {
    const map = await source(missing)
    if (refBadgeEpoch !== epoch || !map) return
    for (const [id, edges] of map) refBadgeCache.set(id, edges)
  })()
  refBadgeFetch = job
  try {
    await job
  } finally {
    if (refBadgeFetch === job) refBadgeFetch = null
  }
}

export interface ViewOpts {
  container: HTMLElement
  // ⚠️ 加回调（装配层 → 事件层的通知）只有一条通道：本接口加字段 → 构造器赋值 →
  // `bind()` 桥接递给 editor-events。**塞进 ViewEvents 的构造 spread 不成立**——
  // events 初始为空、选项不展开进去，条件 spread 还能静默绕过类型检查（typecheck 绿 ≠ 接通）。
  // 2026-11-18 实测教训（组头折叠坏两轮），细节见 agent-backlink-breadcrumbs。
  /**
   * **写入事务入口**（`Run`）。装配层必须注入 —— 这不是可选参数。
   *
   * 为什么必需：模型变化的**宣布者只有一个**，就是事务的出口（`Kb.apply` 里补索引、
   * 通知订阅者）。编辑器若允许「没有事务时直改活块」，那条路径就没有宣布者：
   * 模型变了、别的视图与索引都不知道，而且**不报错**。
   * 曾经这里有一个「省略时直改」的兜底，理由写的是「迁移期」——迁移早结束了，
   * 剩下的是四条静默漏通知的路径（标签直写、页面直写、记录直写、撤销外直改）。
   */
  write: Run
  /**
   * **「点空白建块」的监听面**——通常比 `container` 大一圈
   * （编辑器 ＋ 它下方那段「还能往下写」的气口）。
   *
   * ⚠️ 省略时退化成 `container` 自己：那样点气口不建块（2026-10-20 探针实测，
   *    事件目标落在 `#scroll` 上，监听器根本不触发）。装配层**应当显式传**。
   */
  blankArea?: HTMLElement
  doc: Doc
  /**
   * **共享 block store**（下一层）：多个视图读同一份块/marks/atoms/undo。
   * 省略时编辑器自建一个（单视图兼容；测试/独立实例用）。
   */
  store?: BlockStore
  /** 是否允许「点空白建块」；反链/查询记录视图设为 false（视图序不是真实兄弟序） */
  allowBlankCreate?: boolean
  /** 是否允许删除 section 根；反链视图设为 false（删源块走命令面） */
  allowRootRemove?: boolean
  /**
   * 删掉的段根是**最后一段**时，要不要补一个空块当落点（默认要：编辑器没有
   * 落点就没法打字）。**页签身体要关**：它一段恒一页，fill 会把「删这一页」
   * 变成「原地换一个空块」——页签的落点由视图层给（回落到别的页／空态）。
   */
  rootRemoveFill?: boolean
  /**
   * **结构动作能在哪一层寻址**（默认 `'document'`）。
   *
   * `'roots'`：这一屏的 `doc.roots` 是**结果集**（查询命中、镜像源）。每一棵根子树
   * 内部照常可编辑（改字、建子块、删子块），但**根的列表本身是派生的**：
   *   · 根不能被行首退格并进上一行（那会跨结果行合并，改坏数据）；
   *   · 根不能被缩进／反缩进／上下换位（那会把结果行搬出可见集）；
   *   · 移动的落点必须仍在当前 scope 内（窗口里 `locate` 得到）。
   *
   * 这不是「只读投影」：根自己的正文、属性、整棵子树都照常编辑 —— 只是不能把
   * 「结果里有哪几行」当成可编辑的容器。
   */
  structuralScope?: 'document' | 'roots'
  /**
   * 是否跟随共享 store **自动重载**（默认 true）。
   *
   * 槽里的钉住块要自己控制节奏：外部每次 store 变化都重画会让侧槽跟着正文每个按键抖动，
   * 所以那一类实例关掉自动重载，改由承载它的组件防抖后显式 `reloadFromStore()`。
   */
  autoReload?: boolean
  /**
   * **点行首面包屑（普通点击）＝就地展开上下文**。
   * `rowId` 是这一格所在的行（原始命中或已展开的上下文根），用来算滚到哪。
   *
   * 省略 ⇒ 事件层退回 `focusBlock`（旧行为）：不是所有编辑器都有「一栏可装载的根」。
   * `⌘/Ctrl` 点与 Shift 点不走这里（仍是跳转／右槽）。
   */
  onExpandContext?: (ancestorId: string, rowId: string) => void
  /** 展开出来的上下文根行首的「收起上下文」＝收掉这一层，露出下一层 */
  onContextBack?: (rootId: string) => void
  /** 分段大纲的组头翻折叠（扣行重装是装载单位的知识，归装配层；编辑器只报组键） */
  onGroupToggle?: (key: string) => void
  /**
   * **这一份装载里要不要展开露面块的身体**（镜像／投影）。
   *
   * 默认 `true`。露面块自己的身体由装配层画；那一层再遇到露面块时**只画占位**——
   * 这是「深度 1」的**构造性截断**：不是运行时用 visited 集合拦（那会让渲染结果
   * 依赖从哪开始遍历），而是「下一层根本没有展开这个动作」。
   */
  embedBodies?: boolean
  /**
   * 这一台编辑器是不是「某一次露面的岛」：是则值为**露面宿主块 id**。
   *
   * 删除的落点判据读它：光标在露面岛里时，用户要删的是这一次露面，
   * 不是岛里那棵源子树——键位路径没有菜单的 `appearanceHost`，只能认编辑器自带的身份。
   * 只由装配层在露面编辑器的构造处注入；普通正文编辑器没有这一格。
   */
  embedHostId?: string
  /**
   * **这一面是不是「一屏就是这一块」的聚焦面**（缺省 `false`）。
   *
   * 只有中心槽是：那里「装载只剩一个根」意味着**整屏**就是这一块，
   * 把它收起来等于把整屏收成一行 ⇒ 它的折叠在这一屏不生效（见 `Doc.focusRootId`）。
   *
   * 侧槽窗口、挂载区、反链、查询结果不设：它们是「一个块装进一栏」，
   * 一栏里还有别的卡/别的行，块自己折起来是正常的显示
   * （槽卡的收起是**另一个轴**，走 `collapsedCards`，不是这张折叠表）。
   */
  focusSurface?: boolean
  /**
   * **空块占位文案**（省略＝不挂占位，空行就是空行）。
   *
   * 只在**没有字**的空块上出现。抬头这类落点用它：那一行不是「一块空内容」，
   * 而是「这个名字还是空的」——普通正文空块没有这句话要说的。
   * ⚠️ 与虚拟化占位（`placeholder()` 那个方法）不是一件事，所以名字带 `empty`。
   */
  emptyPlaceholder?: string
  /**
   * **段的排列**（视图配置轴，不是导航）：`column`（单列流，缺省）｜`row`（段横排）｜`grid`（折行网格）。
   * 只改「段怎么摆」，不改「段是什么」——DOM 形状对所有 layout 一致（见 `renderRows` 的 `.sec`）。
   */
  layout?: SecLayout
}

export interface ViewEvents {
  /** 任何模型变化（持久化 + 角标刷新）。格式/原子改动也是内容改动 ⇒ 归 `text` */
  change?: (kind: 'text' | 'struct' | 'view' | 'load') => void
  /** 光标前是不是在敲一个触发词（`/`／`#`／`@`）；`null` ＝ 这一段已经结束 */
  triggerQuery?: (hit: TriggerQuery | null, rect: DOMRect) => void
  /**
   * **点了一个「指向某块的露面」**：行内引用、行尾标签 chip 走同一条。
   *
   * 装配层据此决定去哪（左键开中心／Shift 开右槽／⌥ 看详情）。
   * `el` 只是详情浮层的锚点。
   * ⚠️ 未接的实例什么都不做——不静默退化成某一种（那会让「缺入口」看起来像成功）。
   */
  refClick?: (ref: RefClickHit, mods: RefClickMods, el?: HTMLElement) => void
  /**
   * **点了行尾引用数徽标**：就地展开引用列表浮层。
   *
   * 与 `refClick` 分开：那是「点了一个指向别处的露面」，要导航；这是「点了一个
   * 关于本块的计数」，要留在原地展开。`el` 是浮层锚点，`mods` 决定列表行的落点。
   * ⚠️ 未接 ⇒ 什么都不做（缺入口看得见地缺，不退化成导航到别的块）。
   */
  refCountClick?: (hostId: string, mods: RefClickMods, el?: HTMLElement) => void
  /**
   * **点实例的字段手柄**（图标槽 hover 换手后的 chevron）：打开这条记录的字段卡。
   *
   * 与 `refClick` 分开：那是「去哪」，这是「就地改字段」。
   * ⚠️ 未接 ⇒ 什么都不做，不退化成导航。
   */
  refFields?: (runId: string, el: HTMLElement) => void
  /**
   * **点块标签 chip 的三角**：打开宿主块在这枚标签下的字段卡。
   *
   * `hostId` 是值的家，`tagId` 是字段声明的家；两个一起给，浮层才能只列这一枚标签的字段。
   * ⚠️ 未接 ⇒ 什么都不做，不退化成打开标签类。
   */
  tagFields?: (hostId: string, tagId: string, el: HTMLElement) => void
  /**
   * **右键落在被备注的文本上**：「对这一处做什么」的菜单（打开／侧栏／删除），
   * 与 `atomMenu` 同族——右键原子是对一枚原子做什么，右键标记是对这一处做什么。
   * ⚠️ 未接 ⇒ 退回块菜单（不是没反应）。
   */
  annoMenu?: (hit: { blockId: string; annoId: string }, rect: DOMRect) => void
  /**
   * **点了非引用的行内原子**（图片／将来的文件、外链）。
   *
   * 为什么与 `refClick` 分开：引用是「去哪」，行内原子是「看它自己」。
   * 合成一支之后，装配层只能靠「`to === ''` 就当图片」来分派 —— 每加一种行内原子
   * 就要在那条分支里再猜一次，猜错的表现是「点了没反应」或「点图跳到一个空页」。
   *
   * ⚠️ 未接 ⇒ 事件层退回详情浮层（旧行为），不让点击看起来像没发生。
   */
  onAtomClick?: (atom: { runId: string; kind: string; hash?: string }, el: HTMLElement, mods: RefClickMods) => void
  /**
   * **右键一枚行内原子**（引用／行内标签／外链／图片／标签 chip）。
   *
   * 与 `blockMenu` 分开：右键块标是「对这块做什么」，右键一枚原子是「对这一处做什么」。
   * 未接 ⇒ 事件层退回块菜单（不是没反应）。身份判据见 `AtomMenuHit`。
   */
  atomMenu?: (hit: AtomMenuHit, el: HTMLElement, rect: DOMRect) => void
  /**
   * **粘贴进来一份图片字节**（v1 只取第一张）。
   *
   * 落点由事件层在入库前捕获（`point`）；装配层负责：校验 → 入库 → 按落点插 run。
   * 为什么经事件表注入：`view` 不该知道资产库在哪（IDB／库目录／云端）。
   *
   * ⚠️ 未接 ⇒ 粘贴图片**什么都不做**，不退化成「把图当文本贴」——后者是另一种静默失败。
   */
  onPasteImage?: (file: File, point: { blockId: string; offset: number } | null) => Promise<void>
  /**
   * **复制报告**：`ids` 是这次复制涉及的块，`text` 是剪贴板里那段纯文本。
   * 「粘贴为…」用它把「刚才复制的是哪一块」找回来（自定义剪贴板 MIME 在 Chromium 不可靠）。
   */
  onCopy?: (ids: readonly string[], text: string) => void
  /** 剪切味的源块已都不在（粘贴端已按正文降级）：装配层给一句实话 */
  clipboardNotice?: (kind: 'move-source-gone') => void
  /** 拖入文件被拒（v1 不做拖拽入图）：装配层给一句明确文案 */
  onDropFilesRejected?: () => void
  /**
   * 悬停把手/圆点或右键 → 块菜单。
   * `appearanceHost` ＝ 右键落在露面行上（见 `ViewEvents.onBlockMenu`）：菜单开在源上，
   * 装配层据此附「移除这次露面」。
   */
  blockMenu?: (blockId: string, rect: DOMRect, appearanceHost?: string, trigger?: HTMLElement) => void
  /**
   * **点 gutter 上一条普通 `select` 图标**：装配层开选项菜单。
   *
   * 视图只报「点了谁的哪条属性」，选值与写值走命令（`core.props/set-value`）——
   * 撤销/落盘只有一条路，视图不需要知道命令名。
   * ⚠️ 未接 ⇒ 什么都不做；不静默退化成「聚焦这一行」。
   */
  pickChoice?: (blockId: string, propId: string, anchor: DOMRect) => void
  /**
   * **左键点块标**：聚焦/zoom 到这个块。
   * 装配层把它接到 `core.block/focus-block`（面包屑那一格是同一个命令）。
   */
  focusBlock?: (blockId: string) => void
  /**
   * **打开一个块**：`place` 已把 Shift／⌘/Ctrl 翻译好（中心／右槽／新 tab）。
   *
   * 事件层只报落点，不认识「侧槽」「tab」这些具体语义；生产装配统一接到
   * `App.openBlock`，独立/测试实例未接时非中心落点什么都不做（不退化为中心 zoom）。
   */
  openBlock?: (blockId: string, place: OpenAction) => void
  /**
   * **结构动作之后，光标落在了本视图看不见的块上**：把它送到能被看见的地方（源位置）。
   *
   * 判据是**按块**的，不是按表面：新块在当前编辑器的 `doc` 里找得到 ⇒ 留下（本地连续）；
   * 找不到 ⇒ 回源。所有编辑器共用装配层的同一份实现（去主编辑器找，找不到再开真实位置）。
   * ⚠️ 未接 ⇒ 不做任何兜底（光标留在看不见的块上——下次按键看起来像「没反应」）。
   */
  focusSource?: (blockId: string) => void
  /**
   * 模型选区变了（**划选气泡的驱动**，2026-10-19）。
   * 只有这里知道「选区到底变了没有」——气泡不能靠猜，否则每次按键都会重建 DOM。
   */
  selChange?: () => void
  /** 重新挂载窗口后（虚拟化） */
  mounted?: () => void
  /**
   * **正文里露面块（镜像／投影）的身体**：由 UI 层画（`ui/embed-body.ts`）。
   *
   * `view` 只交代「这儿有身体、归你画」，不 import `ui`。
   * 返回一个卸载函数：身体里是另一台编辑器／一张表，**换 DOM 之前必须释放**
   * （否则每次重排都留一份订阅，页面越用越慢且不报错）。
   *
   * ⚠️ 未接 ⇒ 露面块只画抬头、身体留空（看得见地缺）；不退化成一行普通文字。
   */
  embedBody?: (block: Block, into: HTMLElement) => (() => void) | void
  /**
   * **代码块的编辑岛**（CM6）：与 `embedBody` 同一条生命周期纪律（换 DOM 前释放）。
   * 静态投影面不接这个回调，就不会为每个单元格起一台编辑器。
   */
  codeBody?: (block: Block, into: HTMLElement) => (() => void) | void
  /**
   * **正文里查询块的身体**：由装配层用同一台 `ViewHost` 画（surface＝`inline`）。
   *
   * 与 `embedBody` 同一条分工（`view` 不 import `ui`）与同一条生命周期纪律
   * （返回卸载函数，换 DOM 前必须释放）。段根不走这里 —— 它仍由段尾宿主画，
   * 否则同一块会挂两台视图宿主。
   */
  viewBody?: (block: Block, into: HTMLElement) => (() => void) | void
  /**
   * **正文里自动化块的身体**（三段式定义体）。与 `viewBody` 同一条分工与同一条
   * 生命周期纪律（返回卸载函数，换 DOM 前必须释放）。
   */
  automationBody?: (block: Block, into: HTMLElement) => (() => void) | void
  /**
   * **正文里属性定义块／标签的身体**（定义值配置／字段声明的就地投影）。
   *
   * 自描述判据：把「它是什么」的定义拿掉只剩名字 ⇒ 名字下面就该画定义——
   * 定义块画自己的值配置（格式／基数／候选域／选项），标签画自己的字段声明
   * （声明非空才画）。与 `viewBody` 同一条分工与同一条生命周期纪律。
   */
  defBody?: (block: Block, into: HTMLElement) => (() => void) | void
  /**
   * **块下属性区**：值文本、排布与「点值开属性面板」都在装配层。
   *
   * `view` 只负责「这一行有这一格」与高度；这里不返回卸载函数（行里没有订阅）。
   */
  propsLine?: (block: Block, data: BelowFields, into: HTMLElement) => void
  /**
   * **这一块的属性区占几行**（`0` ＝ 不画；`1` ＝ 一行摘要；`n` ＝ 一栏一行）。
   *
   * 为什么必须由装配层给、而不是 `view` 自己算：行数取决于**设备态的密度档**
   * 与「这块有没有就地展开」，那两样都不在 `view` 的视野里。
   * ⚠️ 它与 `propsLine` 必须吃同一份判据——两处各算一遍，滚动条就会系统性偏小，
   *    而那种偏差不会报错，只在滚到底部时露出来。
   */
  propsRows?: (id: string, data: BelowFields) => number
  /**
   * **资产此刻的样子**（`view/asset-views.ts` 的 `assetViewOf`）。
   *
   * 为什么经事件表注入而不是让 `view` 直接拿资产库：`view` 不该知道字节存在哪
   * （IDB／库目录／云端），它只问「这份 hash 现在能不能画、URL 是什么」。
   * 装配层把同一个函数递给**所有**编辑器实例（正文／挂载区／查询／侧槽），
   * 于是「同一张图在四个视图里长得一样」是同一份答案的自然结果。
   *
   * ⚠️ 未接 ⇒ 行内资产一律画成 `unavailable` 占位（这是真相：这台宿主没有资产库），
   *    不退化成「缺失」——那会让用户去找一个根本没被查过的文件。
   */
  assetView?: (hash: string) => AssetView
  /**
   * **字节取不到时**（`<img>` 报错）的回落。默认直接问 `view/asset-views.ts`：
   * 索引里有一行不代表文件还在 —— 浏览器去取的那一刻才是真相。
   */
  onAssetError?: (hash: string) => void
  /**
   * **在空天格子里落笔**（复盘兜底）：装配层物化那一天并重装载。
   * 编辑器只报日期——「造块进库」是命令层的事，视图不写库。
   */
  shellWrite?: (date: string, place?: OpenAction) => void
  /**
   * **一次改名被拒**（编辑边界上撞到已有地址，正文已回滚）。
   *
   * 为什么从编辑器里报、而不是让每个调用方看返回值：三个边界入口都可能撞名，
   * 各处自己弹提示就会漏一处或重复弹一次；提交是同一个函数，拒绝也就只有一个出口。
   * `name` 是**用户敲的那个名字**（回滚前取），`conflict` 是已经占用它的块。
   */
  editRejected?: (name: string, conflict: Block) => void
  /**
   * **撤销/重做产出的 op**（装配层据此并进待落盘队列）。
   *
   * 为什么走事件表而不是让编辑器自己落盘：撤销的 op 与一次普通编辑的 op 是**同一种东西**
   * （都只是「每一格现在是什么」），而落盘的排期与批次归装配层
   * （`app/wiring/persistence.ts` 的 `pendingOps`）。
   *
   * ⚠️ 不接 ⇒ 撤销改了模型却没进盘（用户关掉应用、重开发现撤销没生效）。
   */
  undoOps?: (ops: readonly Op[]) => void
}

/**
 * 一次编辑期开始前的快照（**只记正文**）。
 *
 * 地址不在这里：正文是描述，写它不改地址；地址只有「显式改名」一条写路径。
 * 旧实现连 `_alias` 一起记、在提交时改地址，于是每敲一次字都可能重命名一次。
 */
interface EditBase {
  id: string
}

/**
 * 浮层选中之后的**落点**（由触发字符那一栏决定，不由行决定）。
 *
 * · `ref`：正文里插一枚指向它的引用（`flavor:'#'` 就是行内标签的露面）；
 * · `newObj`：同一笔里建出标签块（缺则建）＋ 建一条住森林顶层的记录，再插指向记录的露面；
 * · `tag`：**只归类**——抹掉触发词、把标签写进本块的 `_tags`（行尾出 chip）。
 */
export type AcceptPick =
  /** `anchor` 只在别名点名时由浮层带上（见 `RowPick.page.anchor`）；主名路径不带，改名跟随 */
  | { kind: 'ref'; to: string; label: string; flavor?: '#'; anchor?: string }
  | { kind: 'newObj'; name: string; tagId: string }
  | { kind: 'newPage'; name: string }
  /** ⌥↵ 的另一条路：不建页，以查询词造一个普通块（宿主下一兄弟位）并插引用 */
  | { kind: 'newBlock'; name: string }
  /** 新标签是**目标**；三种键各给一个落点（`inline` 行内 / `assign` 块标签 / `instance` 新实例） */
  | { kind: 'newTag'; name: string; action: 'inline' | 'assign' | 'instance' }
  | { kind: 'tag'; name: string }

/**
 * 一次「切换待办」要写哪一格的判据住在 `core/props/closure.ts`：
 * 单块、批量与记录面共用同一份，编辑器只负责事务与重画。
 */

export class BlockEditor {
  container: HTMLElement
  doc: Doc
  /** 共享数据 store；`marks`/`atoms`/`undo` 都是它的投影（getter 转发） */
  store: BlockStore
  /** 本视图装载的 root id（reload 时按 id 从 store 重新取；不持有拷贝） */
  viewRootIds: string[] = []
  /** 露面岛的宿主块 id（普通编辑器为空）；删除落点判据读它 */
  embedHostId?: string
  log = new CommandLog()
  probe: Probe = {
    isComposing: false,
    compositionSeq: [],
    lastKey: null,
    lastCommand: null,
    keyTrace: [],
    traced: true,
  }
  /**
   * 行投影的调用计数（诊断探针）：`rowsCalls` 是调用次数，真正走没走
   * `visibleRows` 看 `treeProbe.visibleRowsCalls`——两者之间的差就是缓存命中的量。
   * 只有测试面读它（`window.__qua.perf`），产品逻辑不读。
   */
  readonly perfProbe = {
    rowsCalls: 0,
    rowsAllCalls: 0,
    /** 字段读取表重建次数（内容键入应为 0；标签声明/定义变更才 +1） */
    fieldTableBuilds: 0,
    /** `blockEl` 调用次数（每键应只随「问了几次」增长，不随库体量） */
    blockElCalls: 0,
    /** 行表全容器扫描次数（暖起来之后每键应为 0） */
    rowElScans: 0,
    /** 行表 miss 后的定向回退次数（只该在窗口外/里层岛行上出现） */
    blockElFallbacks: 0,
    /** `change` 回调总耗时/次数（装配层每次编辑通知都记一笔，诊断用） */
    changeCalls: 0,
    changeMs: 0,
    /** 其中 `renderDocks()` 占的毫秒数（回答「每键是不是还在重排侧槽」） */
    docksMs: 0,
    /** 滚动换窗回调（含换窗后的 scrollTop 还原/焦点还原）的总耗时 */
    scrollSyncCalls: 0,
    scrollSyncMs: 0,
  }

  /**
   * **可见行投影**（缓存/行索引/行位置/活块数）住 `./row-projection.ts`。
   *
   * 失效键与四个轴的判据见那里的模块注释；这里只持有并转发。
   * 抽成协作对象不是因为行数，而是因为「缝」：消费方只有渲染路径与上下文键，
   * 生命周期跟着装载的 Doc，且整块是 DOM-free 的——抽出来能直接单测。
   */
  readonly rowsProjection = new RowProjection({
    doc: () => this.doc,
    revisions: () => this.store,
    filter: () => this.rowFilter?.() ?? null,
    caret: () => this.caretBlock(),
    withBody: () =>
      this.events.viewBody !== undefined || this.events.automationBody !== undefined || this.events.defBody !== undefined,
    probe: this.perfProbe,
  })

  /** 当前装载的活块数（转发；诊断快照与上下文键读） */
  get docBlockCount(): number {
    return this.rowsProjection.blockCount
  }
  sel: Sel | null = null
  virtualize = false
  radius = 12
  /** 这一屏已挂载的块 id（真字段在渲染协作对象里；装配层诊断与徽标读 size） */
  get mounted(): Set<string> {
    return this.render.mounted
  }

  /** 备注命中缓存（真字段在渲染协作对象里；AnnoHover 闭包读） */
  get annoSpans(): ReadonlyMap<string, readonly AnnoHitSpan[]> {
    return this.render.annoSpans
  }
  events: ViewEvents = {}

  /** 共享 undo 栈；depth/clear 与所有视图一致 */
  get undo(): UndoStack {
    return this.store.undoStack
  }


  /** 块拖拽：字段与落手逻辑在协作对象里，这里只是持有它 */
  readonly drag = new Drag(this)
  /** 剪贴板三味（正文／引用／剪切移动）与粘贴落点：没有自有状态，全部经本编辑器 */
  readonly clip = new ClipboardOps(this)
  /** 触发词三事（报浮层／抹字／落账）：没有自有状态，全部经本编辑器 */
  readonly triggers = new TriggerOps(this)
  /** 插入族（结构插入与行内原子插入）：没有自有状态，全部经本编辑器 */
  readonly insert = new InsertOps(this)
  /** 结构操作（拆/并/缩进/换位/多块拖/删/恢复/补空格）：见 `structure-ops.ts` */
  readonly struct = new StructOps(this)
  /** 块级选区（跨块整块选择）：字段与方法都在协作对象里，这里只是持有它 */
  readonly bsel = new BlockSelection(this)
  /** 渲染管线（画层＋备注画层）：字段与方法都在协作对象里；宿主保同名转发 */
  readonly render = new RenderOps(this)
  /**
   * **进入这次编辑时**那一行是什么（正文 ＋ 地址）。
   *
   * 为什么要有它：校验放在编辑边界，而离开那一刻正文已经被敲进去了 —— 要回滚就得知道
   * 「改名前」是什么。记在**第一次把 DOM 同步进模型之前**（`syncFromDom` 的第一笔），
   * 而不是聚焦那一刻：聚焦之后、第一次敲键之前，别处命令也可能合法地改过这一块，
   * 那不属于「这次编辑」，不该被回滚带走。
   */
  private editBase: EditBase | null = null
  /**
   * 这个编辑期里**有没有内容落进过模型**（见 `stampEdited`）。
   *
   * 为什么不在边界上「比内容」：编辑期的起点在**第一次落字之前**，落字那一刻
   * `syncFromDom` 会 `beginEdit` 重开一个编辑期 —— 等边界到来时「起点」早就等于
   * 此刻了，比较永远相等。真正要记的是「这段时间里写没写过」这一位。
   */
  /**
   * 这个编辑期里**被写过**的块：到边界时给它们记一次修改时间。
   *
   * ⚠️ 为什么是「按块 id 的集合」而不是一个布尔：编辑期会在**每一笔输入**上重开
   *    （`syncFromDom` → `beginEdit` → `rebase`），一个布尔标记会被那次重开清掉，
   *    于是边界永远看不到「写过」。块的粒度不受编辑期怎么切的影响。
   */
  private edited = new Set<string>()
  /** 「点空白建块」的监听面：比 container 大一圈，见 `ViewOpts.blankArea` */
  blankArea: HTMLElement
  private allowBlankCreate: boolean
  /** 关掉的实例不许删装载根；协作对象 `StructOps.remove` 也要读它 */
  allowRootRemove: boolean
  /** 删空窗口时补一块空块；协作对象 `StructOps.remove` 也要读它 */
  rootRemoveFill: boolean
  /** 结构动作的可寻址层（见 `ViewOpts.structuralScope`）；协作对象也读它挡结构粘贴（ClipboardOps.moveClipboardRun） */
  structuralScope: 'document' | 'roots'
  /** 段的排列（视图配置；`data-layout` 供 CSS 选择，见 `setLayout`）；装配层按它挡住只属单列的行为 */
  private _layout: SecLayout = 'column'
  /** 复盘的空天格子（纯视图兜底，不进库）；换页／换形态即清空。渲染协作对象画格子时读它 */
  shells: readonly ShellCol[] = []
  get layout(): SecLayout {
    return this._layout
  }
  /**
   * **写入事务入口**（装配层注入，见 `Run`）。
   *
   * 唯一的模型写入口：模型变化只有一个宣布者，就在事务的出口。
   * 这里不再是 `undefined` 可省——省掉就意味着那条路径没有宣布者（静默漏通知）。
   */
  write: Run
  /** 面包屑的就地展开／逐层收起；见 `ViewOpts` */
  private readonly onExpandContext: ViewOpts['onExpandContext']
  /** 展开根的「收起上下文」回调；渲染协作对象画那颗按钮与算行头时读它 */
  readonly onContextBack: ViewOpts['onContextBack']
  /** 分段大纲的组头翻折叠；见 `ViewOpts` */
  private readonly onGroupToggle: ViewOpts['onGroupToggle']
  /** 行身体（露面／查询）的挂载与回收，都在协作对象里 */
  readonly embeds: EmbedBodies
  /** 这一面是不是「一屏就是这一块」的聚焦面（见 `ViewOpts.focusSurface`） */
  private readonly focusSurface: boolean
  /** 空块占位（见 `ViewOpts.emptyPlaceholder`；省略＝默认）；渲染协作对象画行时读它 */
  readonly emptyPlaceholder: string | undefined
  /**
   * **字段读取表**（懒建）：判「这块是不是任务」要看标签声明（`closureOf`），
   * 逐块现建要扫两趟森林。
   *
   * 失效键与行派生同一套口径：`structureRevision`（标签/定义块的成员与位置变了）、
   * `propsRevision`（声明/kind/缺省值变了）、**索引对象身份**（索引被丢弃重建）。
   * **正文写入不失效**——它不改标签声明与定义；从前每次 `write` 都置空，
   * 等于每键重扫两趟全库（探针只数 flatten/locate，看不见这两趟）。
   * ⚠️ 渲染协作对象（`renderAll`）仍作废它一次：不经事务的装载（工作集补块）
   *    不推修订号，整页重排是那类变化的兜底。
   */
  fieldTableCache: {
    structureRev: number
    propsRev: number
    index: unknown
    table: FieldTable
  } | null = null
  /**
   * **本编辑器自己的行元素**（blockId → 这一行在这一屏的 `.blk`）。
   *
   * 渲染路径在挂行/换行时增量维护（`renderRows`／`renderBlock`／`rebuildWith`／
   * `applyWindow`），`blockEl` 从「每次 querySelectorAll 全容器」变成 O(1) 查表。
   * `null` ＝ 还没有人挂过（或刚 dispose）：第一次 `blockEl` 做一次全容器扫描，
   * 之后一直走表。
   *
   * 只收**本编辑器**的行：嵌入身体的里层行是另一台编辑器的岛，由那台自己维护。
   * 表里没有的 id 就是「这一行不在这一屏」——虚拟化下窗口外的块也就该是这个答案。
   */
  private rowEls: Map<string, HTMLElement> | null = null
  /** 当前动作的撤销捕获袋：`write` 的每个事务都会把出口捕获并进来（一次动作可能拆成多笔） */
  private entryCap: UndoCapture | null = null
  /** 当前动作开始时的选区（撤销后回到这里） */
  private entrySel: Sel | null = null
  /**
   * 撤销条目的**嵌套深度**：复合命令可以用 `App.runGroup` 包住一组编辑器方法，
   * 而后者自己也会 `begin/finish`。只有最外层真正开袋／落条目；内层并入外层。
   */
  private entryDepth = 0
  /**
   * **命令分组深度**（`runGroup` 开的嵌套）。它是 `entryDepth` 的授权来源：
   * 只有分组内层的 begin 才是合法的嵌套；分组外的 depth > 0 一律是「上一笔出口漏了
   * finish」——那是实现 bug，必须在下一次动作开始前收口，否则深度永久留下，
   * 此后所有编辑都记不进撤销栈（⌘Z 看着还能用，只是停在旧条目上）。
   */
  private entryGroupDepth = 0
  private relationsPending = false
  private relationsTimer: number | null = null
  /** store 订阅与事件绑定的卸载函数（`dispose` 用；视图被移除后不该继续收通知） */
  private readonly offStore: () => void
  private readonly unbind: () => void
  private readonly annoHover: AnnoHover

  constructor(o: ViewOpts) {
    liveEditors.add(this)
    this.container = o.container
    this.blankArea = o.blankArea ?? o.container
    this.allowBlankCreate = o.allowBlankCreate !== false
    this.allowRootRemove = o.allowRootRemove !== false
    this.rootRemoveFill = o.rootRemoveFill !== false
    this.structuralScope = o.structuralScope ?? 'document'
    // 写入口不再无条件作废字段表：正文写入不碰标签声明/定义，缓存键是修订号＋索引身份
    this.write = (fn, source, opts) => {
      // 发起写的编辑器就是自己（见 `Run` 的 source 口径）：不注入的话，装配层的
      // 「活动编辑器」兜底会把跨表面的一笔写记到别的编辑器头上，那台就跳过重画，
      // 界面停在拖拽前。
      const r = o.write(
        (tx) => {
          const r = fn(tx)
          this.struct.keepWritableSlots(tx)
          return r
        },
        source ?? this,
        {
          ...opts,
          /**
           * 事务出口的捕获并进**当前动作**的袋子：一次结构动作可能拆成几笔写，
           * 而撤销要把它们当成一步（`mergeCapture`：before 留第一次、after 用最后一次）。
           */
          capture: (u) => {
            this.entryCap = this.entryCap ? mergeCapture(this.entryCap, u) : u
          },
        },
      )
      // 模型写了 ⇒ 备注标记可能要跟上（内容变了锚跟着动、锚本身被增删）
      this.scheduleAnnoPaint()
      return r
    }
    this.onExpandContext = o.onExpandContext
    this.onContextBack = o.onContextBack
    this.onGroupToggle = o.onGroupToggle
    this.embeds = new EmbedBodies(this, o.embedBodies !== false)
    this.focusSurface = o.focusSurface === true
    this.emptyPlaceholder = o.emptyPlaceholder
    this.embedHostId = o.embedHostId
    this.doc = o.doc
    this.setLayout(o.layout ?? 'column')
    /**
     * **冷启动也必须有 root id**。
     *
     * 冷启动走的是构造参数（`doc: { roots: bootRoots }`），不经过 `loadPage()`；
     * 空 id 列表会让第一次 `reloadFromStore()`（undo 或别的视图 `touch`）把
     * `doc.roots` 重载成空 ——正文看起来被清空了，而块其实还在 store 里。
     */
    this.viewRootIds = o.doc.roots.map((b) => b.id)
    // 冷启动也是一次装载（走构造参数，不经过 `loadPage`）⇒ 聚焦位同样按形状给上
    this.syncFocusRoot()
    this.store = o.store ?? new BlockStore(o.doc.roots)
    this.offStore =
      o.autoReload === false
        ? () => {}
        : this.store.subscribe((source?: unknown, ids?: readonly string[], structural?: boolean) => {
            // 发起编辑的视图自己已经渲染过；其他视图按 root id 从 store 重取（共享对象，不拷贝块数据）
            if (isOwnEdit(source, this)) return
            /**
             * **结构变化走保留锚点的整页重画**（见 `reloadStructural`）：树变了，行集合
             * 本身变了，「按 id 换几行」挂不上新行。它必须当场传播——别的露面停在旧形状
             * 的样子是「改了树，另一处不变，失焦才跳」。
             */
            if (structural) {
              this.reloadFromStore(true, ids, true)
              return
            }
            /**
             * **冻结时仍按 id 画那几行**：别的视图改的正是屏幕上这些行，整片重排会打断
             * 里层编辑岛里的事，但只换那一行不碰结构。组合期例外——连那一行也不换
             * （输入法的预编辑串挂在它的文本节点上）。
             */
            if (!this.probe.isComposing && !inputSession.isComposing && this.reloader.frozen() && ids && ids.length > 0) {
              for (const id of ids) this.renderBlock(id)
            }
            this.scheduleAnnoPaint()
            this.reloader.touch(ids)
          })
    this.container.setAttribute('contenteditable', 'true')
    this.container.setAttribute('spellcheck', 'false')
    const offEvents = this.bind()
    const offScroll = this.bindScrollSync()
    const offResize = this.bindWidthChange()
    this.unbind = () => {
      offEvents()
      offScroll()
      offResize()
    }
    this.annoHover = new AnnoHover({
      container: this.container,
      spans: () => this.annoSpans,
      quiet: () => this.deferWhileComposing() || this.reloader.pointerDownNow(),
      textOf: (blockId, annoId) => this.annoNoteText(blockId, annoId),
      onHot: (hit) => this.paintAnnoHot(hit),
    })
    this.renderAll()
  }

  /** 从文档里摘掉这个视图：退订 store、卸掉事件（否则游离容器还会继续被重画） */
  dispose(): void {
    liveEditors.delete(this)
    this.rowEls = null
    this.embeds.disposeAll()
    this.offStore()
    this.unbind()
    this.reloader.dispose()
    this.annoHover.dispose()
    this.render.disposeAnnoPaint()
  }

  /**
   * **聚焦根随装载形状重算**。
   *
   * 为什么是「装载形状」而不是「哪个入口调的」：点块标 zoom、打开页、翻日单日、
   * 单根查询块都只是「把一批根塞进中心」，形状相同 ⇒ 行为该相同；日记流（多段）
   * 里收起某一天只是收起那一天，不该被这条豁免。
   *
   * @param keepChoice `true` ＝ 这一屏只是**重取同一批根**（`reloadFromStore` 那种）：
   *   根没变就保留用户刚才的折叠选择（否则他刚折的那一下会在下一次重画时被悄悄展开）；
   *   根变了（形状变了）仍然按新的装载给上。`false` ＝ 新的一次装载，一律重新给上。
   */
  private syncFocusRoot(keepChoice = false): void {
    if (!this.focusSurface) {
      delete this.doc.focusRootId
      delete this.doc.focusRootOpen
      return
    }
    const root = focusRootOf(this.doc.roots)
    if (!root) {
      delete this.doc.focusRootId
      delete this.doc.focusRootOpen
      return
    }
    const same = this.doc.focusRootId === root
    this.doc.focusRootId = root
    if (!keepChoice || !same) this.doc.focusRootOpen = true
  }

  /* ------------------------------------------------------------ 快照 */

  /**
   * **开始一个撤销条目**：清空捕获袋，并记下这一笔之前的选区。
   *
   * 之后的每次 `write` 都会把事务出口的捕获并进来 —— 不再有「取整片森林快照」这一步。
   *
   * ⚠️ **分组外出现未收口的上一笔** ⇒ 先把它收掉再开新的。这是实现 bug 的自愈：
   *    某个出口漏了 `finish` 时，若继续把深度留在 1，之后所有 begin/finish 都只
   *    在 1↔2 之间往返，`undo.record` 永远不再被调用。自愈会把它当作一条独立
   *    `other` 条目落下（写过的内容仍可撤销），并留一条开发期警告；正常路径不该看到它。
   */
  beginUndoEntry(): void {
    if (this.entryDepth > 0 && this.entryGroupDepth === 0) {
      console.warn('[editor] previous undo entry was not finished; closing it before the next action')
      while (this.entryDepth > 0) this.finishUndoEntry('other')
    }
    this.entryDepth++
    // 内层并入外层：只有最外层能重置捕获袋（否则复合命令会把外层的 before 冲掉）
    if (this.entryDepth > 1) return
    this.entryCap = null
    this.entrySel = this.sel
  }

  /**
   * **开一个命令分组**：组内所有动作共用一个撤销条目（`runGroup` 用）。
   *
   * 与裸 `beginUndoEntry` 的区别只有一位：分组内的嵌套 begin 是合法的。
   * 非分组路径若开始嵌套，说明上一笔漏了 finish —— 见 `beginUndoEntry` 的自愈。
   */
  beginUndoGroup(): void {
    // 先按**顶层动作**开袋：若上一笔漏了 finish，这里必须先自愈；
    // 反过来先加分组深度会让自愈条件（groupDepth === 0）恒假，泄漏被带进新分组。
    this.beginUndoEntry()
    this.entryGroupDepth++
  }

  /** 收一个命令分组；最后一步落入组条目（与 `finishUndoEntry` 同语义） */
  endUndoGroup(kind: UndoKind): void {
    if (this.entryGroupDepth > 0) this.entryGroupDepth--
    this.finishUndoEntry(kind)
  }

  /**
   * **放弃当前动作的撤销条目**：只退一层深度，不落条目。
   *
   * 用于「校验失败 / 零写」的出口：这些路径不该留下一条空条目，更不该让深度挂着。
   * 与 `finishUndoEntry` 的分工：finish 是「动作成功，收下捕获」；abort 是「动作没发生」。
   * 嵌套内层的 abort 只退一层（与外层共用捕获袋），到 0 时丢弃捕获。
   */
  abortUndoEntry(): void {
    if (this.entryDepth === 0) return
    this.entryDepth--
    if (this.entryDepth > 0) return
    this.entryCap = null
    this.entrySel = null
  }

  /**
   * **收尾一个撤销条目**：把这一动作里所有事务的捕获交给撤销栈。
   *
   * `capture === null`（这一段没有开过事务）⇒ 不新建条目；合并窗口由栈判。
   *
   * 配对规则：有 `begin` 就按深度退；**没有配对的 `finish`**（历史上有些行内编辑
   * 在调用方已经开袋的情况下只调 finish）按老行为直接落条目，不静默吞掉。
   *
   * `standalone` 见 `UndoEntry.standalone`：粘贴这类原子动作要独占一步，
   * 否则「打了几个字紧接着粘贴」会退成同一步。
   */
  finishUndoEntry(kind: UndoKind, at = Date.now(), opts: { standalone?: boolean } = {}): void {
    if (this.entryDepth > 0) {
      this.entryDepth--
      if (this.entryDepth > 0) return
    }
    this.undo.record(this.entryCap, this.entrySel, kind, at, opts)
    this.entryCap = null
  }

  /**
   * 字段读取表（懒建；失效轴见 `fieldTableCache`）。
   *
   * 判「这块是不是任务」要看**标签声明**（`#任务` 用 `declareField` 把这一栏给到成员），
   * 而逐块现建要扫两趟森林 ⇒ 一张表摊到整屏／整条命令上。
   */
  // 协作对象 `InsertOps` 插待办时也要判「是不是已经是任务」；可见性为它放宽
  fieldTable(): FieldTable {
    const store = this.store
    const index = store.index
    const c = this.fieldTableCache
    if (c !== null && c.structureRev === store.structureRevision && c.propsRev === store.propsRevision && c.index === index) {
      return c.table
    }
    const table = fieldTableOf(store.blocks)
    this.perfProbe.fieldTableBuilds++
    this.fieldTableCache = {
      structureRev: store.structureRevision,
      propsRev: store.propsRevision,
      index,
      table,
    }
    return table
  }

  /**
   * 这一块在哪：先在本视图装载的树里找，再退到整片森林。
   *
   * 记录面（查询结果／派生栏）的块不在任何编辑器的 `doc` 里；「对一块做什么」
   * 的块级动作要能寻址它，否则只能从菜单里消失或静默失败。
   */
  private locateAny(id: string) {
    return locate(this.doc, id) ?? locate({ roots: this.store.blocks }, id)
  }

  /**
   * 从 store 重取本视图的 roots（按 id），并重渲染。
   * 不拷贝块数据：`doc.roots` 里就是 store 里的活块。
   *
   * @param structural `true` ＝ 这批变化改了树的形状（插入/移动/删块）：走
   *   **保留锚点的整页重画**（`reloadStructural`）——行集合本身变了，「按 id 换几行」
   *   挂不上新行；并且**绕过「里层编辑岛有人」的冻结**：其他露面必须当场跟上，
   *   「改了树、另一处失焦才变」就是那条旧路径的样子。
   *
   * ⚠️ 其他视图收到 `touch` 时调用；不触发 `events.change`（否则会回写成“编辑”）。
   */
  reloadFromStore(restoreSelection = true, ids?: readonly string[], structural = false): void {
    if (structural) {
      this.reloadStructural()
      return
    }
    /**
     * **冻结时不换 DOM**：组合期，或里层的编辑岛里正在发生别的事。
     * 组合期连「按 id 画一行」也不做——预编辑串就挂在那一行的文本节点上（见 `deferWhileComposing`）；
     * 其余冻结情形可以按 id 换那几行，结构重排记成欠账。
     */
    if (this.reloader.frozen()) {
      if (!this.probe.isComposing && !inputSession.isComposing && ids && ids.length > 0) for (const id of ids) this.renderBlock(id)
      this.scheduleAnnoPaint()
      this.reloader.touch()
      return
    }
    this.applyFreshRoots()
    // 焦点只算**本视图自己的**（里层编辑器是独立编辑岛，不是「我在编辑」）
    const focused = restoreSelection && this.ownFocus()
    this.renderAll()
    if (focused) this.restoreSel()
  }

  /** 重取 roots ＋ 换 `doc`（折叠表／`viewRootId` 的口径与非结构路径一致；见 `reloadFromStore`） */
  private applyFreshRoots(): void {
    const roots = this.viewRootIds
      .map((id) => this.store.find(id))
      .filter((b): b is Block => Boolean(b))
    /**
     * **根没变就复用同一份 doc**：后台装载／查询刷新这类重取，roots 与视图字段都
     * 没变——换一份新 doc 会让「保留行」的重画快路（`holdRows` 按 doc 同一性对账）
     * 把整屏当「装载形状变了」全量重建，读作一次无意义的闪。共享对象是同一份
     * （`store.find` 直达），序列相同就是同一棵树。
     */
    const same =
      roots.length === this.doc.roots.length && roots.every((b, i) => b.id === this.doc.roots[i]?.id)
    if (same) return
    /**
     * 折叠表／面包屑属于**这一份文档**（视图各带各的），换 roots 时原样保留。
     *
     * `viewRootId` 不同：它是**从模型派生的**（`activeView(根)`），所以每次重取 roots 都重算一遍。
     * 不重算的后果是「撤销一次切视图，模型回到表格、屏幕还停在大纲」——
     * 而那正是 ⌘Z 最该表现对的地方。
     * ⚠️ 其余字段用展开带过去：逐字段列举漏过一次（漏的正是 `viewRootId`）。
     */
    const only = roots.length === 1 ? roots[0] : undefined
    this.doc = { ...this.doc, roots }
    /**
     * 露面块**从不**当整屏的视图根：它自己的身体由那一行画（见 `ViewEvents.embedBody`）。
     * 让它当视图根会得到两个宿主（段尾一个、身体一个）——同一张表画两遍。
     */
    if (only && activeView(only) && !isEmbedBlock(only)) this.doc.viewRootId = only.id
    else delete this.doc.viewRootId
    // 同一批根的重取：保留用户在聚焦期间显式折的那一下（否则每次 store 变动都会弹开）
    this.syncFocusRoot(true)
  }

  /**
   * **结构变化的重装：保留锚点行的整页重画。**
   *
   * 与文本路径的两处不同：
   *   · **绕过「里层编辑岛有人」的冻结**（`nestedEditorActive`）——镜像里建了一个块，
   *     源那一处要**当场**长出来；这正是旧路径的样子（冻结记欠账，失焦才补）要修的病。
     *   · 组合期／指针按下仍然尊重：预编辑串冻成正文、正被按的按钮被搬走，都是比
     *     「晚一拍重画」更糟的事故 ⇒ 记欠账（`pendingStructural`），解冻后按结构口径补。
   */
  private reloadStructural(): void {
    if (this.probe.isComposing || inputSession.isComposing || this.reloader.pointerDownNow()) {
      this.reloader.touch(undefined, true)
      return
    }
    // 锚点要按**换 doc 之前**的那份树解析（要拿它旧的 parent 对比）
    const anchor = this.resolveAnchorRow()
    this.applyFreshRoots()
    this.render.renderAllPreservingAnchor(anchor)
    if (this.ownFocus() && this.sel) this.restoreSel()
    this.scheduleAnnoPaint()
    /**
     * 可见性兜底：外部结构变化把光标块移出了本视图 ⇒ 回源。只对**正在这台编辑器里
     * 输入**的人兜底——别人留档的旧光标不该拖着屏幕跳。
     */
    this.ensureCaretVisible(undefined, true)
  }

  /**
   * **输入锚点所在的行**（本编辑器名下的那颗 `.blk`）的 id。
   *
   * 锚点来自输入会话（浮层/里层编辑器的锚点都可能嵌在本容器里）；从锚点向上找
   * 最近的行时，**只认「岛根与本编辑器相同」的那一颗**：露面行的身体是另一台编辑器
   * （另一个岛），里层的源行不属于本编辑器——保留它不会保住外层的宿主行。
   * 锚点解析不出行（锚点就是容器自己等）⇒ 退回光标所在的行。
   *
   * ⚠️ 只交 id，不交 parent：解析发生在**写入之后**，从模型拿到的 parent 必然是
   *    新位置——拿它判「锚点行自己被搬走了」永远判不出来（「旧位置」的唯一持有者
   *    是渲染层的上次渲染表，见 `renderAllPreservingAnchor`）。
   */
  private resolveAnchorRow(): string | null {
    const anchor = inputSession.anchorEl
    let el: HTMLElement | null = null
    if (anchor && this.container.contains(anchor)) {
      const own = this.container.closest<HTMLElement>(`[${EDIT_ISLAND_ATTR}]`)
      let node: HTMLElement | null = anchor
      while (node && node !== this.container) {
        if (node.classList.contains('blk') && node.dataset.blockId && node.closest(`[${EDIT_ISLAND_ATTR}]`) === own) {
          el = node
          break
        }
        node = node.parentElement
      }
    }
    if (!el) el = this.sel?.aBlock ? this.blockEl(this.sel.aBlock) : null
    const id = el?.dataset.blockId
    if (!id) return null
    return locate(this.doc, id) ? id : null
  }


  /**
   * **光标落在了本视图看不见的块上 ⇒ 回源**（`events.focusSource`，装配层接了才生效）。
   *
   * @param id 要查的那一块（缺省 ＝ 当前光标块）。
   * @param gated `true` ＝ 只对「正在这台编辑器里输入」的人生效：重装路径带来的检查
   *   不该被别的视图留档的旧光标触发（那会拖着屏幕乱跳）；结构动作自己的收尾
   *   （`structTail`／`loadPage` 带了落点）是无条件的——动作刚发生，光标就是用户的注意力。
   */
  private ensureCaretVisible(id?: string | null, gated = false): void {
    const target = id ?? this.caretBlock()
    if (!target || locate(this.doc, target)) return
    if (gated && inputSession.editor !== this && !this.ownFocus()) return
    this.events.focusSource?.(target)
  }

  /**
   * 焦点是不是落在**本实例的编辑宿主**上。
   *
   * ⚠️ 不能用 `container.contains(activeElement)`：挂载区／查询视图的编辑器是
   *    **独立的编辑岛**，它们的 DOM 也在这个容器里面。按「含在里面」算，
   *    本视图会以为自己有焦点，于是 `restoreSel()` 把光标从里层抢回来（实测：
   *    点挂载区里的行，插入点立刻跳回正文）。
   */
  ownFocus(): boolean {
    const active = document.activeElement as HTMLElement | null
    if (!active) return false
    if (active === this.container) return true
    if (!this.container.contains(active)) return false
    // 焦点在**另一个编辑宿主**的子树里（挂载区、露面行的身体）⇒ 不算「本视图在编辑」
    return !active.closest(`[${EDIT_ISLAND_ATTR}]`) && !active.isContentEditable
  }

  /**
   * 焦点是不是在本视图里那些**别的编辑宿主**上（挂载区／查询视图／露面行的身体）。
   *
   * ⚠️ 判据不能只是「焦点在里层编辑器上」：点一下挂载区抬头那颗刷新按钮，
   *    焦点落到按钮上——那一刻**也不是**本视图在编辑。只判可编辑元素的话，
   *    按钮按下与抬起之间本视图会重排一次，把按钮从指针下搬走 ⇒ 一次真点击变成「点了没反应」
   *    （实测：`page.mouse.click` 不触发，`.click()` 能触发）。
   *    ⇒ 里层可编辑宿主，或**里层宿主里的任何东西**（输入框、按钮）都算「不在我这」。
   *
   * 这也是正文那份冻结判据的全部（见 `reloader`）：焦点在本容器**自己的行**上时
   * 它可以随时重排，否则别的视图每改一次，正文就停在旧形状。
   */
  private nestedEditorActive(): boolean {
    /**
     * 自己的输入不算「里层」：本实例正在打字时，别的视图的变化该按 id 更新别的行，
     * 整屏冻结会让正文停在旧形状。
     */
    if (inputSession.editor === this) return false
    /**
     * **浮层的锚点也算「有人在这」**：编辑浮层挂在 `document.body` 上，
     * `container.contains(activeElement)` 对它恒为 false；不看锚点，父编辑器就会在
     * 打一个字时重排整片，把浮层依附的那一行换掉。
     */
    if (inputSession.isAnchorInside(this.container)) return true
    const active = document.activeElement as HTMLElement | null
    if (!active || active === this.container) return false
    if (!this.container.contains(active)) return false
    return active.isContentEditable || Boolean(active.closest(`[${EDIT_ISLAND_ATTR}]`))
  }

  /**
   * 排一次「补做被推迟的重排」。
   *
   * 为什么不是「等 focusout 再补」：点挂载区抬头那颗按钮时，焦点从头到尾没离开过
   * 本容器（只是从里层编辑器换到了按钮上）——`focusout` 那条路永远等不到，
   * 正文就会一直停在旧形状。用计时器补：在里层**编辑器**里打字时它会一直往后推
   * （那时重排会打断输入），一旦焦点离开编辑岛就补上。
   */
  private armFlush(): void {
    this.reloader.arm()
  }

  setPointerDown(down: boolean): void {
    /**
     * 抬起后补做被推迟的装载/重排。
     * ⚠️ **不能**用 `setTimeout(…, 0)`：`click` 不是在 mouseup 的同一个任务里派发的，
     *    0 毫秒的定时器会抢在它前面把 DOM 换掉 ⇒ 那颗按钮的 `click` 又被弄丢了。
     *    走补做（200ms）：远在 `click` 之后，而在用户眼里仍是「立刻」。
     */
    this.reloader.setPointerDown(down)
  }

  /**
   * **组合期不换 DOM：记一笔「欠一次」，等组合结束再补。**
   *
   * 为什么这是一条**渲染前置条件**而不是某个事件里的分支：
   * 输入法的预编辑串（拼音字母）由浏览器持有，它不是正文；承载它的节点一旦被换掉或
   * 被卸载，浏览器就把这段预编辑**当成已提交文本**冻结在原位 —— 表现为「打拼音时冒出
   * 一个字母，且取消候选也收不回去」（实测：`checks/probe-ime-dom.mjs` 的 C／D 两档）。
   *
   * 而「换 DOM」的入口不止 `input` 一条：属性写入（`repaintBlock`）、别的视图 `store.touch`
   * （`reloadFromStore`）、`armFlush` 的延时重排、`applyWindow` 的窗口重算都会走到这里。
   * 判据必须放在**渲染入口**才覆盖得住；放在事件回调里只能覆盖其中一条路径。
   *
   * @returns `true` ＝ 已经记下「欠一次」，调用方**必须跳过这次换 DOM**。
   *
   * ⚠️ 可见性是 public：渲染协作对象（`RenderOps`）的每个换 DOM 入口都从它过——
   * 口径仍然只有这一份，放宽只是让协作对象走同一个门。
   */
  deferWhileComposing(): boolean {
    if (!this.probe.isComposing && !inputSession.isComposing) return false
    this.reloader.touch()
    return true
  }

  /* ------------------------------------------------------------ 渲染 */

  /**
   * 这一行**归本编辑器**的元素。
   *
   * ⚠️ 为什么不能直接 `querySelector`：同一个块可能在同一屏出现两次（露面块把源装进自己
   * 的身体里，而源也可能就在这一屏的原位）。身体是**编辑岛**（另一台编辑器 / 另一张表），
   * 岛里的 `.blk` 也在这个容器里；按 id 取第一个会取到岛里那份，于是「改这一行」改到了
   * 另一个实例上——不报错，只是看起来没反应。
   *
   * 判据是**岛根**：元素最近的编辑岛必须与本编辑器的岛相同（主编辑器不在任何岛里 ⇒ `null`）。
   * 行表由渲染路径维护；表里没有 ⇒ 这一行不在这一屏（不是「需要再扫一遍 DOM」）。
   */
  blockEl(id: string): HTMLElement | null {
    this.perfProbe.blockElCalls++
    if (this.rowEls === null) this.rowEls = this.scanRowEls()
    const hit = this.rowEls.get(id)
    if (hit && hit.isConnected) return hit
    if (hit) this.rowEls.delete(id)
    /**
     * 表里没有 ≠ 这一块一定没有行：它可能在**里层编辑岛**里（查询结果／露面身体），
     * 那台编辑器自己维护行表；但旧口径允许外层编辑器按 id 找到「这一屏唯一的一行」。
     * 保留这次定向回退（只扫容器，不建表、不缓存岛行），热路径仍是 O(1)；
     * 窗口外的块也会走到这里，返回 null 还是「不在这一屏」。
     */
    return this.queryBlockEl(id)
  }

  /** 旧口径的定向查询：先找自己岛里的行，找不到退回第一个（含里层岛）。 */
  private queryBlockEl(id: string): HTMLElement | null {
    this.perfProbe.blockElFallbacks++
    const all = this.container.querySelectorAll<HTMLElement>(`.blk[data-block-id="${id}"]`)
    if (all.length <= 1) return all[0] ?? null
    const own = this.container.closest<HTMLElement>(`[${EDIT_ISLAND_ATTR}]`)
    for (const el of all) {
      if (el.closest(`[${EDIT_ISLAND_ATTR}]`) === own) return el
    }
    return all[0] ?? null
  }

  /** 一次全容器扫描建行表（只在表为空时走；扫描口径与 `blockEl` 的岛判据同一份） */
  private scanRowEls(): Map<string, HTMLElement> {
    this.perfProbe.rowElScans++
    const own = this.container.closest<HTMLElement>(`[${EDIT_ISLAND_ATTR}]`)
    const out = new Map<string, HTMLElement>()
    for (const el of this.container.querySelectorAll<HTMLElement>('.blk[data-block-id]')) {
      if (el.closest(`[${EDIT_ISLAND_ATTR}]`) !== own) continue
      const id = el.dataset.blockId
      if (id && !out.has(id)) out.set(id, el)
    }
    return out
  }

  /** 渲染路径用：本屏行表换代（换窗/整页重排后由 `renderRows` 重新登记） */
  resetRowEls(): void {
    this.rowEls = new Map()
  }

  /** 渲染路径用：登记一行（占位节点没有 `data-block-id`，调用方只对真行调） */
  setRowEl(id: string, el: HTMLElement): void {
    this.rowEls?.set(id, el)
  }

  /** 渲染路径用：一行被摘掉/没有归位成功 */
  dropRowEl(id: string): void {
    this.rowEls?.delete(id)
  }


  /**
   * **这一屏的行筛选**：给「当前视图漏斗」用的接缝。
   *
   * 传的是**provider**而不是一份固定判据：它回答「此刻有没有筛选、判据是什么」，
   * 由装配层按「当前打开的是谁」现读（换页之后就自动是另一份/没有）。
   * 返回 `null` ⇒ 不筛（`rows()` 原样返回，不比「筛了一遍恰好全过」）。
   */
  setRowFilter(
    provider: (() => ((block: Block, path: readonly Block[]) => RowVerdict) | null) | null,
    repaint = true,
  ): void {
    this.rowFilter = provider
    if (repaint) this.renderAll()
  }

  /* —— 渲染管线在 `render-ops.ts`：下面是宿主转发，装配层与协作对象的调用点不变 —— */

  renderAll(): void {
    this.render.renderAll()
    this.prefetchRefBadges()
  }

  /**
   * **引用角标的全库口径**：共享缓存优先，未命中退回工作集。
   * 缓存只在派生表 ready 时填入（source 回 null 就不填）——半表当真会让角标「看起来是 0」。
   */
  badgeSourcesOf(id: string): readonly RelationEdge[] {
    return refBadgeCache.get(id) ?? relationsTo(this.store.index, id)
  }

  /** 全库口径变化后的强制重查：即便有一次批查在飞，也不能让 pending 挡住 */
  refreshRefBadges(): void {
    this.relationsPending = false
    this.prefetchRefBadges()
  }

  /** 编辑让某目标的角标过期：共享缓存摘掉（退回工作集口径），错峰补一次批查 */
  invalidateRefBadge(targets: readonly string[]): void {
    for (const id of targets) refBadgeCache.delete(id)
    this.scheduleRefBadgePrefetch()
  }

  private scheduleRefBadgePrefetch(): void {
    if (!refBadgeSource || this.relationsTimer !== null) return
    this.relationsTimer = window.setTimeout(() => {
      this.relationsTimer = null
      this.prefetchRefBadges()
    }, 500)
  }

  private prefetchRefBadges(): void {
    if (!refBadgeSource || this.relationsPending) return
    const ids = [...new Set(flatten(this.doc).map((b) => b.id))].filter((id) => !refBadgeCache.has(id))
    if (ids.length === 0) return
    this.relationsPending = true
    void loadRefBadges(ids)
      .then(() => {
        // 只重画「全库答案 ≠ 工作集答案」的行：整页重画会让折叠/选区白抖一次
        for (const id of ids) {
          if (!refBadgeCache.has(id)) continue
          const full = refBadgeCache.get(id)!.length
          const partial = relationsTo(this.store.index, id).length
          if (full !== partial && this.blockEl(id)) this.renderBlock(id)
        }
      })
      .catch((e) => console.warn(`[editor] ref badge prefetch failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        this.relationsPending = false
      })
  }

  renderBlock(id: string): void {
    this.render.renderBlock(id)
  }

  applyWindow(centerId?: string): void {
    this.render.applyWindow(centerId)
  }

  /** rAF 节流位：同一帧里的多次 scroll 只换一次窗 */
  private windowSyncQueued = false

  /**
   * **虚拟化的滚动联动**（rAF 节流）：视口顶部那一行贴到窗口边就换一次窗。
   *
   * 为什么必须有这一条：`applyWindow` 原先只在重画与跳块时算窗口，**滚动不换窗**，
   * 往下滚到的是占位块（高度对、但没有内容）——它因此只能当调试开关，当不了阅读模式。
   *
   * 换窗不跳：头尾占位用的是与窗口定位**同一份**行高（`RenderOps.rowHeight`），
   * 总高与估算一一对应；这里仍把滚动位置与选区按切换前的值写回，抵消子像素差。
   */
  private bindScrollSync(): () => void {
    const onScroll = (): void => {
      if (!this.virtualize || this.windowSyncQueued) return
      this.windowSyncQueued = true
      requestAnimationFrame(() => {
        this.windowSyncQueued = false
        this.syncWindowOnScroll()
      })
    }
    this.blankArea.addEventListener('scroll', onScroll, { passive: true })
    return () => this.blankArea.removeEventListener('scroll', onScroll)
  }

  /**
   * **可用宽度变了 ⇒ 实测行高作废**。
   *
   * 为什么只有宽度算数：正文是 `pre-wrap`，一条长块折成几行由**宽度**决定；
   * 而高度方向的变化（窗口拉高只是露出更多行）不改任何一行的折行位置。
   * 拿宽度做判据，竖直拉伸就不会白抖一次占位。
   *
   * ⚠️ 判据必须是**内容区宽度**（`clientWidth`），不是 `window.innerWidth`：
   *    槽开合、右槽拖宽都会改正文可用宽度，而窗口尺寸一点没变——那正是最容易漏的一种。
   *    `ResizeObserver` 比 `window.resize` 覆盖得全（槽宽变化不发 resize 事件）。
   */
  private bindWidthChange(): () => void {
    if (typeof ResizeObserver === 'undefined') return () => {}
    let last = this.blankArea.clientWidth
    const ro = new ResizeObserver(() => {
      const w = this.blankArea.clientWidth
      if (w === last) return
      last = w
      // 只在虚拟化档有意义：关档时每行都在 DOM 里，没有占位要用这些数
      if (!this.virtualize) return
      this.render.invalidateHeights(w)
      /**
       * 作废之后要重排一次：头尾占位是按旧宽度算的，现在要按新宽度重算。
       * 用 `applyWindow` 而不是 `renderAll`——后者会重装整屏（丢选区与滚动位）。
       */
      this.applyWindow(this.sel?.aBlock)
    })
    ro.observe(this.blankArea)
    return () => ro.disconnect()
  }

  private syncWindowOnScroll(): void {
    if (!this.virtualize || this.layout !== 'column') return
    const t0 = performance.now()
    this.perfProbe.scrollSyncCalls++
    try {
    /**
     * ⚠️ **组合期不换窗**：换窗会重挂承载行的元素，输入法的组合锚点跟着丢
     *    （`checks/probe-ime-attrib.mjs` 的场景 4 量过）。滚到的地方先留占位，
     *    组合结束后的下一次滚动再补。
     */
    if (this.deferWhileComposing()) return
    const anchor = this.render.topRowId()
    if (anchor === null) return
    if (!this.render.needsRecenter(anchor, WINDOW_SLACK)) return
    const scrollTop = this.blankArea.scrollTop
    const focused = this.container.contains(document.activeElement)
    const sel = this.sel
    this.applyWindow(anchor)
    this.blankArea.scrollTop = scrollTop
    /**
     * 焦点只在**光标那一行仍挂着**时还回去：滚走了就不该把焦点按回一个不在窗口里的行
     * （`restoreSel` 会去滚它，等于和用户抢滚动）。模型选区 `this.sel` 不动，⌘A／命令仍按模型走。
     */
    if (focused && sel && this.render.mounted.has(sel.aBlock)) {
      this.sel = sel
      this.restoreSel()
      // `restoreSel` 可能把光标滚进视口；用户正在滚，保持他原来的位置
      this.blankArea.scrollTop = scrollTop
    }
    } finally {
      this.perfProbe.scrollSyncMs += performance.now() - t0
    }
  }

  markCaret(): void {
    this.render.markCaret()
  }

  reveal(id: string): void {
    this.render.reveal(id)
  }

  /**
   * 把某一块**展开到可见、滚进视口，并在它真正进入视口后给一段落地闪光**。
   *
   * 「在父块中打开」的收尾：父块那一屏可能把目标藏在一个折起来的祖先里 ——
   * 只调 `reveal` 会静默找不到行（`blockEl` 为空），看起来像点了没反应。
   * 先沿索引的祖先链展开折叠，再滚到视口中央。
   *
   * ⚠️ **闪光不能跟滚动同时开始**：平滑滚动要几百毫秒，目标还没进视口时那 900ms
   *    已经烧掉大半，用户看到的是「到了但没闪」。这里等 IntersectionObserver
   *    报「已进入视口」再挂 `data-land`，CSS 侧把它拉长到 1.6s。
   *
   * 返回 `false` ＝ 这一块不在当前这一屏（父块或窗口边界之外）；调用方可以
   * 退回「打开目标本身」，不要假装定位成功。
   */
  landInContext(id: string): boolean {
    const path = indexPathOf(this.store.index, id)
    let unfolded = false
    for (const ancestor of path.slice(0, -1)) {
      if (!isFolded(this.doc, ancestor.id)) continue
      unfoldBlock(this.doc, ancestor.id)
      unfolded = true
    }
    if (unfolded) this.renderAll()
    const el = this.blockEl(id)
    if (!el) return false
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' })
    this.flashWhenVisible(el)
    return true
  }

  /**
   * 目标进入视口后再闪；环境没有 IntersectionObserver 时立即闪。
   * 兜底计时器防「元素已在视口里但观察器没回调」与隐藏元素（不闪也不算错）。
   */
  private flashWhenVisible(el: HTMLElement): void {
    let started = false
    const start = (): void => {
      if (started) return
      started = true
      if (!el.isConnected) return
      el.dataset.land = '1'
      window.setTimeout(() => {
        if (el.isConnected) delete el.dataset.land
      }, 1800)
    }
    if (typeof IntersectionObserver === 'undefined') {
      start()
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        io.disconnect()
        start()
      },
      { threshold: 0.6 },
    )
    io.observe(el)
    // 长滚动也应在观察器回调里先到；这里只兜底不回调的环境
    window.setTimeout(() => {
      io.disconnect()
      start()
    }, 1500)
  }

  pulseBlocks(ids: readonly string[]): void {
    this.render.pulseBlocks(ids)
  }

  txEl(id: string): HTMLElement | null {
    return this.render.txEl(id)
  }

  /** 被备注区间的屏幕矩形（备注浮窗定锚用；装配层经它取） */
  annoRect(blockId: string, annoId: string): DOMRect | null {
    return this.render.annoRect(blockId, annoId)
  }

  /** ⌥-click 命中判定（事件表经它问画层缓存） */
  annoHitAt(x: number, y: number): { blockId: string; annoId: string } | null {
    return this.render.annoHitAt(x, y)
  }

  /** 备注标记的重画排队（写出口与重载路径调；队列状态在渲染协作对象里） */
  scheduleAnnoPaint(): void {
    this.render.scheduleAnnoPaint()
  }

  /** 被备注区间的 tip 文本（AnnoHover 闭包读） */
  annoNoteText(blockId: string, annoId: string): string {
    return this.render.annoNoteText(blockId, annoId)
  }

  /** hover 命中段的加深画笔（AnnoHover 回报驱动） */
  paintAnnoHot(hit: { blockId: string; annoId: string } | null): void {
    this.render.paintAnnoHot(hit)
  }

  /** 全部可见行（**不筛**）：筛选的候选与计数读它（筛过的那份会让候选自己消失） */
  rowsAll(): VisibleRow[] {
    return this.rowsProjection.rowsAll()
  }

  /**
   * 这一块此刻的**可见行**（命中行索引 O(1)）。
   * 单行重画每键都要这一行；投影缓存与失效键见 `./row-projection.ts`。
   */
  rowOf(id: string): VisibleRow | undefined {
    return this.rowsProjection.rowOf(id)
  }

  /** 可见行（折叠的子树已排除；有筛选时只留命中行与它们的上下文） */
  rows(): VisibleRow[] {
    return this.rowsProjection.rows()
  }

  /** 这一块在**当前可见行**里的下标（不在这一屏/没有行 ⇒ undefined） */
  rowPosition(id: string): number | undefined {
    return this.rowsProjection.rowPosition(id)
  }


  /**
   * 切换段的排列。只动一个属性 ＋ 一个 DOM 属性：DOM 形状（`.sec` 包裹）对所有 layout
   * 一致，布局差异全部由 CSS（`#editor[data-layout]`）承担，不需要重渲染。
   */
  setLayout(mode: SecLayout): void {
    this._layout = mode
    this.container.dataset.layout = mode
    this.applySecCols()
  }

  /** grid 的列数由段数推导（`--sec-cols` 供 CSS 的 `repeat()`）；其余 layout 无意义，清掉 */
  private applySecCols(): void {
    if (this.layout === 'grid') this.container.style.setProperty('--sec-cols', String(Math.max(1, this.doc.roots.length)))
    else this.container.style.removeProperty('--sec-cols')
  }

  /**
   * 空天格子（复盘兜底）：窗口里没写过的天渲染成空壳列——**只在 row/grid 下有意义**，
   * column 不渲染（单列流维持「不造空天」）。格子是纯 DOM（没有块），点进去 ⇒ `shellWrite(date)`。
   */
  setShells(cols: readonly ShellCol[]): void {
    this.shells = cols
    this.renderAll()
  }

  /** 所有模型变化统一出口：通知其他视图（共享 store），再通知装配层持久化/刷新 */
  /**
   * @param ids 这次**动过哪些块**（可选）。查询视图靠它判断「结果里的块变没变」，
   *            而不是靠「store 被碰过几次」——后者会把刷新顺带的重渲染也算成过期。
   *            ⚠️ 只给拿得到精确 id 的路径传（文本编辑、关闭态、删除）；结构操作先不传，
   *            订阅方必须容忍 `ids === undefined`（那就是「不知道，按整体处理」）。
   */
  /** 协作对象（块选区删块）也要广播同一件事；对外仍是编辑器的口径 */
  emitChange(kind: 'text' | 'struct' | 'view' | 'load', ids?: readonly string[]): void {
    /**
     * ⚠️ **这里不发通知**：宣布者是事务的出口（`Kb.tx` → `store.apply`），
     * 它知道「变了哪几格」并能按 op 增量修补索引。
     *
     * 这里曾经也调 `store.touch(this, ids)`，于是同一次按键有**两个宣布者**：
     * 事务出口刚按 op 修补完索引，`touch` 又无条件把它作废 ⇒ 每次按键后第一次读索引
     * 都整库重建；而且订阅者被通知两次 ⇒ 所有别的视图每键重载两次。
     * 两者都不报错，界面只是慢一点、抖一点 —— 这正是「同一件事两个宣布者」的形状。
     *
     * @param ids 这次动过哪些块（留给 `events.change` 的消费方；通知已由事务发出）
     */
    void ids
    this.events.change?.(kind)
  }


  /* ------------------------------------------------------- DOM → 文本 */

  offsetIn(root: HTMLElement, node: Node, off: number): number {
    return offsetIn(root, node, off)
  }

  /** 读回块内容（DOM → run 序列；原子按 `data-atom-id` 原样带回）。委托 `view/dom-text` */
  readRunsOf(id: string): InlineRun[] {
    const tx = this.txEl(id)
    // 索引查表（O(1)）；这在每一笔输入里被调用一次
    const b = this.store.find(id)
    if (!tx || !b) return b ? b.content : []
    return readRuns(tx, b.content)
  }

  blockOf(node: Node | null): string | null {
    return blockIdOf(node, this.container)
  }

  /** 当前 DOM 选区 → 模型选区 */
  readSel(): Sel | null {
    const s = document.getSelection()
    if (!s || s.rangeCount === 0) return null
    const r = s.getRangeAt(0)
    const a = this.blockOf(r.startContainer)
    const b = this.blockOf(r.endContainer)
    if (!a || !b) return null
    const aTx = this.txEl(a)
    const bTx = this.txEl(b)
    if (!aTx || !bTx) return null
    return {
      aBlock: a,
      aOff: this.offsetIn(aTx, r.startContainer, r.startOffset),
      hBlock: b,
      hOff: this.offsetIn(bTx, r.endContainer, r.endOffset),
    }
  }

  /** 让模型选区跟上 DOM（**选区由模型持有**，DOM Range 只是它在视窗内的表现） */
  syncSel(): void {
    /**
     * **投影丢了就把模型选区重新投影回来。**
     *
     * 模型是选区的权威（`this.sel`），DOM Range 只是它在视窗内的表现。两者会脱钩：
     * 焦点被别的覆盖层拿走时浏览器会把 Range 清掉（`rangeCount === 0`），
     * 而模型里的选区还在。此时焦点回到本容器、`activeElement` 看起来完全正常，
     * 但**打字一个字符都进不去**——按键需要一个存在的插入点。
     *
     * 实测：`⌘P` 开命令面板 → `Esc` 关掉 → 打字 ⇒ 焦点已回到编辑器、正文一字不变。
     * 这类脱钩只有在这里能修（本类持有模型选区与它的 DOM 映射，别处只会去猜）。
     */
    const dom = document.getSelection()
    if ((!dom || dom.rangeCount === 0) && this.sel && this.ownFocus()) {
      this.restoreSel()
      return
    }
    // 插入点跑到正文槽之外时先收回来（否则下面的读数会把一处「不存在的位置」当成偏移）
    if (this.reclaimCaret()) return
    const s = this.readSel()
    if (!s) return
    /**
     * **光标换到另一块 ＝ 上一次编辑的结束。**
     *
     * 为什么不能只靠 `focusout`：整片编辑区是**一个** contenteditable 容器，
     * 在同一个容器里从父块点到子块（或反过来）**不会派发 `focusout`**，
     * 那个边界就永远不来了 —— 表现为「改完点进子块，修改时间不动」，
     * 而且不报错。光标换块这件事在这里能看见，它就是唯一可靠的落点。
     *
     * ⚠️ 判据是 `editBase` 那一块 vs 新光标块，不是 `this.sel`：`this.sel` 已经被
     *    各种路径改写过，拿它比会漏掉。`commitEdit` 幂等，重复调用无害。
     */
    if (this.editBase && this.editBase.id !== s.aBlock) this.commitEdit(this.editBase.id)
    // 不在这里清块选区：mouseup 前后浏览器会短暂恢复文本 Range，会误杀刚建好的块选区。
    // 块选区的退出来自显式动作（在 .tx 里 mousedown / Shift+拖 / Esc / Enter / 点空白 / 菜单）。
    // 只有**真的变了**才上报：否则气泡会在每次 selectionchange 上重建（打字时每帧一次）
    const same =
      this.sel !== null &&
      this.sel.aBlock === s.aBlock &&
      this.sel.aOff === s.aOff &&
      this.sel.hBlock === s.hBlock &&
      this.sel.hOff === s.hOff
    this.sel = s
    this.markCaret()
    if (!same) this.events.selChange?.()
  }

  /**
   * **插入点现在落在可写正文槽（`.tx`）里吗** —— 这是唯一允许输入的地方。
   *
   * 为什么需要一个独立判据：整片编辑区是**一个** contenteditable 容器，行容器 `.blk`
   * 于是也可编辑。插入点一旦跑到 `.tx` 之外（行容器自己、gutter 与正文之间的缝、
   * 只读的日期行），打出来的字会变成**裸节点挂在 `.blk` 里**：`readRuns` 只读 `.tx`
   * ⇒ 模型里什么都没有，重渲染一过就消失（用户当场看到「字在块前面」，事后找不着）。
   */
  caretInWritableTx(): boolean {
    const s = document.getSelection()
    if (!s || s.rangeCount === 0) return false
    const n = s.anchorNode
    const el = n?.nodeType === Node.ELEMENT_NODE ? (n as HTMLElement) : n?.parentElement
    const tx = el?.closest<HTMLElement>('.tx')
    return Boolean(tx && !tx.closest('[data-readonly]'))
  }

  /**
   * **把跑到正文槽之外的插入点收回来**。
   *
   * 收法刻意**不重建这一行**：重建会把角色元素（块标／把手）整个换掉，
   * 而这条路径可能正发生在「按在把手上、还没开始拖」的那一瞬（`mousedown` 之后、
   * `dragstart` 之前）——换了元素，这一次拖拽就断了。
   * 所以只做两件事：清掉浏览器塞进 `.blk` 的游离节点，再把光标按模型选区放回去
   * （模型没有选区就干脆不留光标：一个不属于任何块的光标本来就是错的状态）。
   *
   * @returns 是否真的收回了一次（正常编辑一次都不会走到这里）
   */
  reclaimCaret(): boolean {
    // 拖拽 / 块拖选进行中：此刻的 DOM 选区不是「插入点」，别去动它
    if (this.drag.active || this.bsel.mouseSel?.active) return false
    /**
     * **焦点在表单控件里 ⇒ 那次输入不是正文**。
     *
     * `<input>`／`<textarea>`／`<select>` 有自己的编辑面，`document.getSelection()` 对它们
     * 返回的是控件**外面**那个位置（Chrome 实测：锚点落在父元素上）。不做这个豁免，
     * 「插入点不在 `.tx` 里」这条守卫会把控件里的每一个字符都吞掉 ——
     * 表现是「表格/面板里的输入框点得进去、打得出来看不见」，而且不报错。
     */
    const active = document.activeElement
    if (active instanceof HTMLElement && active.closest('input, textarea, select')) return false
    const s = document.getSelection()
    if (!s || s.rangeCount === 0) return false
    const node = s.anchorNode
    if (!node || !this.container.contains(node)) return false
    if (this.caretInWritableTx()) return false
    // ① 清掉游离内容：`.blk` 的直接子节点只允许这几类（其余是浏览器顺手塞进来的）
    const host = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement
    const blk = host?.closest<HTMLElement>('.blk')
    if (blk) {
      for (const c of Array.from(blk.childNodes)) {
        if (c.nodeType === Node.TEXT_NODE) {
          if ((c.textContent ?? '').trim() !== '') blk.removeChild(c)
          continue
        }
        if (c.nodeType !== Node.ELEMENT_NODE) continue
        /**
         * 白名单按**类名集合**匹配，不按 `className` 全等。
         *
         * 渲染层放进去的节点会带状态类：`block-dom` 里 `if (closure === 'closed') tx.classList.add('closed')`
         * ⇒ 完成态任务块的正文槽 className 是 `"tx done"`。全等匹配认不出它，就会把**正文槽
         * 连同里面的整段字**当游离内容删掉。实测（2026-11-12）：点「完成态任务块」的块下属性行，
         * 正文整段消失，而模型一字未动（⌘Z 无效、聚焦别处再回来又画出来）。
         *
         * 判据放宽到「有任一白名单类」不损原意：这一格本来就是「渲染层自己放的那几种」，
         * 加状态类不改它的身份。
         */
        if ([...(c as HTMLElement).classList].some((k) => ALLOWED_ROW_CHILDREN.has(k))) continue
        blk.removeChild(c)
      }
    }
    // ② 光标按模型选区放回去
    if (this.sel) this.restoreSel()
    else s.removeAllRanges()
    return true
  }


  /** 这一屏的行筛选（provider；`null` ＝ 这个编辑器没有筛选接缝——里层编辑器就是这样） */
  private rowFilter: (() => ((block: Block, path: readonly Block[]) => RowVerdict) | null) | null = null

  /**
   * **外部变化之后要不要／什么时候重排**的那份状态机（欠账、合并、补做、指针）。
   *
   * 冻结判据在这里给：正文只在焦点落进**里层编辑岛**（挂载区／查询视图／露面体的
   * 编辑器是独立的编辑岛）、或输入法组合期时冻。本容器自己的行被换掉是安全的，
   * 所以那不是「有人在这」——判成冻结的话，别的视图每改一次，正文就停在旧形状。
   *
   * ⚠️ 结构变化的欠账补做时按 `frozenHard` 判（只有组合期挡得住）：结构必须当场传播，
   * 「里层编辑岛有人」挡不住它——「改了树、另一处失焦才变」正是要修的病。
   */
  private readonly reloader = new ReloadPolicy({
    frozen: () => this.nestedEditorActive() || this.probe.isComposing || inputSession.isComposing,
    frozenHard: () => this.probe.isComposing || inputSession.isComposing,
    debounceMs: 0,
    onReload: (ids, structural) => this.reloadFromStore(true, ids, structural === true),
  })


  /** 当前选区在屏幕上的矩形（划选气泡要锚在它上方；空选区给 null） */
  selectionRect(): DOMRect | null {
    const s = document.getSelection()
    if (!s || s.rangeCount === 0 || s.isCollapsed) return null
    const r = s.getRangeAt(0).getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return null
    return r
  }

  caretBlock(): string | null {
    return this.sel?.aBlock ?? null
  }

  caretOffset(): number {
    return this.sel?.aOff ?? 0
  }

  caretRect(): DOMRect | null {
    const s = document.getSelection()
    if (!s || s.rangeCount === 0) return null
    const r = s.getRangeAt(0).cloneRange()
    r.collapse(true)
    let rect = r.getBoundingClientRect()
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      const host = this.txEl(this.blockOf(r.startContainer) ?? '')
      rect = (host ?? this.container).getBoundingClientRect()
    }
    return rect
  }

  /**
   * (块 id, 块内偏移) → DOM 位置。`placeCaret` 与 `selectAll` 共用。
   * ⚠️ 空块没有文本节点（只有 `<br>`）⇒ 落到元素位置（`tx.childNodes.length`），
   *    这是空行唯一能放光标的地方（与 `fillBlockText` 的 trailing `<br>` 是同一招）。
   */
  private posAt(id: string, offset: number): { node: Node; off: number } | null {
    const tx = this.txEl(id)
    if (!tx) return null
    const target = { node: tx as Node, off: 0 }
    let acc = 0
    let done = false
    /** walk 有没有摸到过正文内容：空块与「offset 越过正文末尾」的落点不同 */
    let sawContent = false
    const walk = (n: Node): void => {
      if (done || isTagChip(n)) return
      if (n.nodeType === Node.TEXT_NODE) {
        sawContent = true
        // 光标锚的零宽空格不占模型格：锚只是行缘光标的站位件（0 长），
        // 落在它上面的模型偏移 = 行缘那个位置本身
        const len = isCaretAnchorText(n) ? 0 : (n.textContent ?? '').length
        if (acc + len >= offset) {
          target.node = n
          target.off = Math.max(0, offset - acc)
          done = true
          return
        }
        acc += len
        return
      }
      if (n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).dataset.atomId) {
        sawContent = true
        if (acc + 1 > offset) {
          target.node = n.parentNode ?? tx
          target.off = Array.from((n.parentNode ?? tx).childNodes).indexOf(n as ChildNode)
          done = true
          return
        }
        acc += 1
        return
      }
      for (const c of Array.from(n.childNodes)) walk(c)
    }
    walk(tx)
    if (!done) {
      target.node = tx
      /**
       * 有正文的落到「正文末尾、chip 之前」（textEndOff 的职责）。
       * **没有正文的一律落到元素 0 位**（`<br>` 之前）：
       * 「br 之后 / br 与 chip 之间」都不是 Chrome 认的稳定光标位。
       *
       * ⚠️ 除了上面那一条（下一次按键前 Chrome 会自己把光标挪走，随后的删除键
       *    按挪错的位置走原生删除，把整行的内联元素整段摘掉——⌥Enter 归类后的空行
       *    真踩过），它还有第二个后果：**输入法在 (tx, 1) 上组合不起来**。
       *    实测（`checks/probe-ime-live.mjs`）：空块里敲 `nihao`，第一个字母 `n`
       *    被冻结成正文，随后又起一次 `compositionstart`，结果成 `n你好`。
       *    Chrome 在 `<br>` 之后那个位置插入预编辑串时会把 `<br>` 摘掉，组合区间
       *    当场失焦 ⇒ 上一次组合被当作已提交。而 (tx, 0) 上同一串拼音干净
       *    （`probe-ime-matrix.mjs` 的假块对照）。新建的块**总是空的**，所以这条
       *    正好压在「↵ 建块后马上打中文」这条最常用的路上。
       */
      target.off = sawContent ? textEndOff(tx) : 0
    }
    return target
  }

  placeCaret(id: string, offset: number, extend = false): void {
    const pos = this.posAt(id, offset)
    if (!pos) return
    const r = document.createRange()
    r.setStart(pos.node, pos.off)
    r.collapse(true)
    const s = document.getSelection()
    if (!s) return
    if (!extend) s.removeAllRanges()
    s.addRange(r)
    this.sel = { aBlock: id, aOff: offset, hBlock: id, hOff: offset }
    this.markCaret()
  }

  /**
   * **原子边缘 6px 带的点击吸附**（editor-events 的 mousedown 先于原生放置调它）。
   *
   * 行内原子是 `contenteditable=false` 的整格：它的左右缝隙没有文本几何，
   * 原生点击放置会把光标吸到**另一侧**（点左缘落原子后——真机实测）。
   * 光标锚（行首/行尾的空文本节点）接得住**键盘**导航，接不住点击——锚零宽，
   * Chrome 的命中测不到它。⇒ 点击带内由编辑器自己放光标：`offsetIn` 把带内
   * 任意位置换算成原子前的模型偏移（原子占 1 格），`placeCaret` 走 `posAt`
   * 落进锚/文本节点——竖线画得出、按键落得进（行尾锚的同一条证据）。
   *
   * 带含原子盒**两端各 4px**：结构线款与正文齐平后，「点引用左侧」落的就是
   * 原子盒自己的左边缘（外面已经没有缝可点）。原子**内部**的点击照旧走
   * 原生放置＋click 导航——只有贴边 4px 例外，那已经是「点边缘放光标」的意图。
   * 返回认领原子的 run id（调用方用它豁免紧随的 click 导航）；不在带内 ⇒ null
   * （调用方照常走原生放置与拖选起手）。
   */
  caretAtAtomEdge(blockId: string, tx: HTMLElement, x: number, y: number): string | null {
    const BAND = 6
    const EDGE = 4
    for (const atom of tx.querySelectorAll<HTMLElement>('[data-atom-id]')) {
      const r = atom.getBoundingClientRect()
      if (y < r.top || y > r.bottom) continue
      const before = this.offsetIn(tx, atom, 0)
      let off: number | null = null
      if (x >= r.left - BAND && x < r.left + EDGE) off = before
      else if (x > r.right - EDGE && x <= r.right + BAND) off = before + 1
      if (off === null) continue
      this.container.focus()
      this.placeCaret(blockId, off)
      return atom.dataset.atomId ?? null
    }
    return null
  }

  /**
   * **点击落在原子内部 ⇒ 光标收到原子边**（显示名放开选中之后的补丁）。
   *
   * `.atom-label` 放开 `user-select:text`（划选要带上显示名）之后，原生放置会把
   * 选区落进 label 的文本节点——那是 `contenteditable=false` 盒子里的**不可编辑区**：
   * 焦点在编辑器上、选区却站不到可写槽里 ⇒ 之后打字既不走原生（Chrome 对不可编辑
   * 锚点丢弃输入）也不走接管（没有 beforeinput 可拦），静默丢字。
   * 吸附带（左右各 4px）只盖住边缘，点在原子**中间**（长显示名的日常落点）不受它保。
   * ⇒ mousedown 落进原子盒内部时收光标到**最近的原子边**：点哪半边收哪一侧，
   *   光标总在可写槽里；拖选起手不在这里判（mousemove 的选区更新自会接手）。
   *
   * @returns 收了 ⇒ 那枚原子的 id；没落在原子内部 ⇒ null（原生放置照旧）
   */
  caretInsideAtom(blockId: string, tx: HTMLElement, x: number, y: number): string | null {
    const atoms = [...tx.querySelectorAll<HTMLElement>('[data-atom-id]')]
    if (atoms.length === 0) return null
    /**
     * 落点在原子盒内 ⇒ 那一枚；落在行间 gap ⇒ y 距离最近的那枚——
     * 原生放置对 gap 的落点是「旁边行里最近的文本节点」，而显示名可选中后那
     * 正是 label 的不可编辑文本 ⇒ 打字从此丢。y 距离用「盒外的纵向距离」比。
     */
    let best: { atom: HTMLElement; r: DOMRect; d: number } | null = null
    for (const atom of atoms) {
      const r = atom.getBoundingClientRect()
      const insideY = y >= r.top && y <= r.bottom
      const dy = insideY ? 0 : y < r.top ? r.top - y : y - r.bottom
      if (!best || dy < best.d) best = { atom, r, d: dy }
    }
    if (!best) return null
    const r = best.r
    // x 在盒外横向太远 ⇒ 不是这行的原子（点击在空白天花板），交给原生路径
    if (x < r.left - 24 || x > r.right + 24) return null
    const before = this.offsetIn(tx, best.atom, 0)
    const off = x < r.left + r.width / 2 ? before : before + 1
    this.container.focus()
    this.placeCaret(blockId, off)
    return best.atom.dataset.atomId ?? null
  }

  /**
   * **⌘A：全选这一屏的块**（要求的「必须接管」之一，2026-10-20 落地）。
   *
   * 为什么必须自己接管、而不是留给浏览器：
   *   Chrome 在「编辑区里含 `contenteditable=false` 子树」时，**原生全选会退化成空选区**
   *   ——实测：journal 行标成只读后，⌘A 从「231 字／4 块」变成「0 字／1 块」；
   *   把那一行改回可编辑立刻恢复（115 字／4 块）。这不是我们的 bug，但**后果落在用户身上**。
   * ⇒ 自己拼一个跨块 Range（首块块首 → 末块块尾），并同步模型选区（`aBlock`≠`hBlock`）。
   *
   * ⚠️ 跨块选区在模型里是合法的（`Sel` 有 `aBlock`/`hBlock`），但**跨块编辑**（删除/替换）
   * 第 1 期仍不支持块集合选区（属后续内核工作）；这里只负责「选得上」。
   */
  selectAll(): boolean {
    this.bsel.clearBlockSelection()
    /**
     * ⚠️ **起选点必须避开只读行**：Chrome 会把「起点在 `contenteditable=false`
     *    子树里」的选区**钳成空选区**（实测：起点在容器／只读行 ⇒ 0 字 1 块；
     *    起点在第一行普通文本 ⇒ 88 字 3 块）。所以从**第一个可编辑行**起选。
     */
    /**
     * 嵌入宿主行不在文本跨度里：它自己没有正文宿主（`.tx` 落到岛内源行的头上），
     * 模型偏移与 DOM 对不上——第一次 ⌘A 之后 syncSel 读回的 hOff 会偏离 plainLen，
     * 第二次 ⌘A 的「已全选 ⇒ 升级块选区」判据就永远差着一截。岛是独立编辑域，
     * 文本选区本来就不跨进去（块选区仍含嵌入行：块粒度是行的归属，不是文本）。
     */
    const rows = this.rows().filter((r) => !isReadonlyBlock(r.block) && !isEmbedBlock(r.block))
    if (rows.length === 0) return false
    const first = rows[0]!.block
    const last = rows[rows.length - 1]!.block
    /**
     * **⌘A 两次升级**：第一次文本全选；当整屏可编辑文本已经全选时，
     * 再按一次 ⌘A ⇒ 升级成**块选区**。
     */
    const endOff = plainLen(last.content)
    if (
      this.sel &&
      this.sel.aBlock === first.id &&
      this.sel.aOff === 0 &&
      this.sel.hBlock === last.id &&
      this.sel.hOff === endOff &&
      this.bsel.blockSel === null
    ) {
      return this.bsel.selectAllBlocks()
    }
    const a = this.posAt(first.id, 0)
    const b = this.posAt(last.id, endOff)
    if (!a || !b) return false
    const r = document.createRange()
    r.setStart(a.node, a.off)
    r.setEnd(b.node, b.off)
    const s = document.getSelection()
    if (!s) return false
    s.removeAllRanges()
    s.addRange(r)
    this.sel = { aBlock: first.id, aOff: 0, hBlock: last.id, hOff: endOff }
    this.markCaret()
    this.events.selChange?.()
    return true
  }

  /* --------------------------------------------------------- 块选区 */

  private restoreSel(): void {
    if (!this.sel) return
    const r = this.sel
    const all = flatten(this.doc)
    if (!all.some((b) => b.id === r.aBlock)) return
    this.placeCaret(r.aBlock, r.aOff)
  }

  /**
   * 把**整段选区**（不只是光标）还原回 DOM。
   *
   * 为什么需要它：改格式要重渲染那一行，重渲染会丢掉原生 Range；
   * 原来只 `placeCaret` 还原**一个点** ⇒ 加粗后选区塌成光标，
   * 「再点一次取消加粗」就做不到了，划选气泡也会立刻消失（它靠选区存在才在）。
   * ⚠️ 只支持同一块内（跨块的 Range 要跨 `.tx` 节点，第 1 期不做）。
   */
  /**
   * **设置模型选区**（并尽量同步到 DOM）。
   *
   * 为什么要有公开入口：`⌘A` 是从 DOM 反推模型的，而**跨块删除**要从模型发起
   * （用户在块选区上按删除键时，DOM 选区已经被浏览器动过了）。
   * 给一个显式的设置点，测试与命令面都不用去手搓 Range。
   *
   * ⚠️ 跨块时 DOM 只画到**末块的光标**（原生跨块 Range 会跨 `.tx` 节点，
   *    与「块内 Range」的假设冲突）；模型里的 `sel` 才是权威。
   */
  setSel(s: Sel | null): void {
    this.bsel.clearBlockSelection()
    if (!s) {
      this.sel = null
      return
    }
    if (s.aBlock === s.hBlock) {
      /**
       * 同上：`placeRange` 也会改写 `this.sel` ⇒ 先摆 DOM，再写回模型。
       * ⚠️ 起点必须是 `s.aOff`，不能拿 `s.hOff` 盖掉：那会摆出一个**折叠** Range，
       *    随后 `selectionchange` 把模型选区同步塌成光标，整段选区就丢了
       *    （划选气泡靠 DOM Range 定位，取消浮层后就再也不回来）。
       */
      this.placeRange(s)
      this.sel = s
      return
    }
    // 跨块：先把 DOM 光标放到末块（`placeCaret` 会改写 `this.sel`），再写回模型选区
    this.placeCaret(s.hBlock, s.hOff)
    this.sel = s
  }

  private placeRange(s: Sel): void {
    if (s.aBlock !== s.hBlock) {
      this.placeCaret(s.hBlock, s.hOff)
      return
    }
    /**
     * ⚠️ **复用 `posAt`，不要在这里再抄一份「偏移 → DOM 位置」**：
     * 这一份漏了原子（`data-atom-id`），也不认「空块落到元素 0 位」那条
     * （见 `posAt` 的注释）——两处各判一次，空块上的输入法就会有一边仍然坏着。
     */
    const a = this.posAt(s.aBlock, s.aOff)
    const h = this.posAt(s.aBlock, s.hOff)
    if (!a || !h) return
    const r = document.createRange()
    r.setStart(a.node, a.off)
    r.setEnd(h.node, h.off)
    const sel = document.getSelection()
    if (!sel) return
    sel.removeAllRanges()
    sel.addRange(r)
    this.sel = s
  }

  /* --------------------------------------------------------- 事务入口 */

  /**
   * 事务：**一次快照 ＋ 一次渲染**（「事务＝所有观察者的共同原子单位」的最小形态）。
   * 所有命令都经此改模型，没有第二条写入路径。
   */
  tx(kind: UndoKind, fn: () => void, rerender: 'all' | 'block' | 'none' = 'all'): void {
    this.beginUndoEntry()
    const caret = this.sel
    try {
      fn()
    } catch (e) {
      // 写抛错 ⇒ 这一次动作没有发生：丢弃捕获并退深度，别把 ⌘Z 永久留在半开状态
      this.abortUndoEntry()
      throw e
    }
    this.finishUndoEntry(kind)
    if (rerender === 'all') this.renderAll()
    else if (rerender === 'block' && caret) this.renderBlock(caret.aBlock)
    if (caret) this.placeCaret(caret.aBlock, caret.aOff)
    this.emitChange(kind === 'structural' ? 'struct' : 'text')
  }

  /**
   * 结构操作的**同一笔收尾**：记撤销 → 整树重排 → 落光标 → 广播。
   *
   * 与 `tx` 的分工：`tx` 管「原位改、光标不动」；结构操作把光标落到**新位置**
   * （新块、保留块、并合点），还常带「改动涉及哪些块」的提示——那两个自由度
   * 就是这里仅有的参数。捕获与 `write` 留在调用方：写前的校验与准备各不相同，
   * 硬收进来只是把分叉改成参数汤（run 级的 `commitContent` 是同一判据收的）。
   */
  /** （协作对象同用：剪贴板的整组移动以它收尾，与编辑器内的结构动作同一条不变量尾段） */
  structTail(caret?: { id: string; off: number } | null, ids?: readonly string[]): void {
    this.finishUndoEntry('structural')
    this.renderAll()
    if (caret) this.placeCaret(caret.id, caret.off)
    this.emitChange('struct', ids)
    // 可见性兜底：这一步结构动作之后，光标落在了本视图看不见的块上 ⇒ 回源。
    // ⚠️ 看**该落的**那块，不是 `this.sel`：落点不可见时 `placeCaret` 落不下光标，
    //    `sel` 还停在旧块上（旧块当然可见，判它就永远验不出「落空」）。
    this.ensureCaretVisible(caret?.id)
  }

  undoStep(): void {
    this.undoRedoStep('undo')
  }

  redoStep(): void {
    this.undoRedoStep('redo')
  }

  /** 撤销/重做同一支：产出的 op 与一次普通编辑同路（交回装配层，并进待落盘队列） */
  private undoRedoStep(dir: 'undo' | 'redo'): void {
    this.editBase = null
    const r = dir === 'undo' ? this.store.undo(this, this.sel) : this.store.redo(this, this.sel)
    if (!r) return
    this.events.undoOps?.(r.ops)
    this.sel = r.sel
    this.reloadFromStore(false)
    this.restoreSel()
    this.emitChange('struct')
  }

  /**
   * **写容器标题**（`_caption`）：给「身体不是那行字」的块一个显示名。
   *
   * 单行：换行折成空格（标题不是一个多行文本框）；空串 ⇒ 摘掉属性，不留空壳。
   * 每笔一次 undo 条目，连续输入由撤销栈的合并窗口收成一步（与代码岛同一条纪律）。
   */
  setCaption(id: string, text: string): boolean {
    const b = this.store.find(id)
    if (!b) return false
    const raw = text.replace(/[\r\n]+/g, ' ')
    // 首尾空白不进模型：空白串就是「没有标题」，与缺席同义（不为退格写空 op）
    const next = raw.trim()
    if ((b.props?.[CAPTION_PROP] ?? '') === next) return false
    this.beginUndoEntry()
    const ok = this.write((tx) => {
      if (next === '') tx.clearProp(id, CAPTION_PROP)
      else tx.setProp(id, CAPTION_PROP, next)
      return true
    })
    if (ok) this.finishUndoEntry('insert', Date.now())
    else this.abortUndoEntry()
    return ok
  }

  /**
   * 块内替换（程序化编辑入口）：按 plain 偏移切内容，一次 content 写入。
   * 格式与原子随切片自然分家（相邻同段合并、区间盖住的原子整枚消失——都是序列语义）。
   *
   * `directEdit` 给「用户正对着这一行」的调用者（抹触发词）——与打字同档；
   * 缺省不标记，程序化整段替换仍被正文闸挡住。
   */
  editBlock(
    id: string,
    from: number,
    to: number,
    insert: string,
    kind: 'insert' | 'delete' = 'insert',
    opts?: { directEdit?: boolean },
  ): void {
    const loc = locate(this.doc, id)
    if (!loc) return
    this.beginUndoEntry()
    const next = spliceRuns(loc.block.content, from, to, insert)
    this.write((tx) => tx.patch(id, (b) => writeBlockContent(b, next)), undefined, opts)
    this.finishUndoEntry(kind, Date.now())
    this.renderBlock(id)
    this.emitChange('text')
  }

  /**
   * **收掉一个跨块选区**：把首块前半 ＋ 末块后半拼成一块。
   *
   * 为什么要单独一步：`syncFromDom` 只同步「光标所在的那一块」。
   * 跨块选区上按删除/打字时，浏览器会把整段内容一起删掉，
   * 但模型里那些块**一个都没少** ⇒ 重渲染后它们又全回来了（看着像删除没生效）。
   *
   * @returns 收拢之后光标应落到的块 id；`null` ＝ 这不是一个该在模型里收的选区
   */
  collapseSelection(): string | null {
    const s = this.sel
    if (!s) return null
    const r = normSel(this.doc, s)
    if (r.startBlock === r.endBlock) return null
    const plan = blockSpanPlan(this.doc, r.startBlock, r.startOff, r.endBlock, r.endOff)
    if (!plan) return null
    const caretId = plan.headId
    this.beginUndoEntry()
    /**
     * **经事务落**：旧实现直接 `writeBlockContent` ＋ `splice` 兄弟列表，
     * 靠整片森林快照兜底撤销。现在撤销只记 touched，直写会让这一次收拢整个丢掉。
     *
     * 被吃掉的块走**原位软删**（与合并同一口径），可恢复；正文先清空——
     * 末块的字已经搬进首块，留着就是库里有两份同一句话。身份块（查询/日记）不碰正文。
     */
    this.write((tx) => {
      tx.patch(plan.headId, (b) => writeBlockContent(b, plan.content))
      for (const id of plan.removeIds) {
        const b = this.store.find(id)
        if (b && canWriteText(b)) tx.patch(id, (x) => writeBlockContent(x, []))
        tx.remove(id)
      }
    })
    this.finishUndoEntry('delete')
    const loc = locate(this.doc, caretId)
    this.sel = loc ? { aBlock: caretId, aOff: r.startOff, hBlock: caretId, hOff: r.startOff } : null
    this.renderAll()
    this.placeCaret(caretId, Math.min(r.startOff, loc ? plainLen(loc.block.content) : 0))
    this.emitChange('struct')
    return caretId
  }

  /* --------------------------------------------------------- 编辑边界 */

  /**
   * **编辑边界**：这次编辑结束（失焦 / Enter 拆块 / 聚焦换块），把快照挪到当前正文。
   *
   * ⚠️ **只认正文，不碰地址**：正文是描述。名字住在 `_aliases`，改名只有
   *    `renameAlias`／`setPrimaryAlias` 一条路；在这里「按正文改地址」会让
   *    写回正文的每一次边界都顺手重命名一次（旧实现就是这样，撞名时还会
   *    把地址钉回旧值，表现为「显示名先走、引用名滞后」）。
   *
   * 幂等：同一块可以在一串边界上各调一次（失焦之后紧接着 Enter、再点块标），
   * 重复提交必须无害。
   *
   * **这里也是「修改时间」唯一该更新的位置之一**：敲字过程中不动它，否则每敲一字都要
   * 多一条 op，而那个时间也只说明「最后一次按键」。边界才是一次「改动」的粒度。
   * 整块内容比较（不是「这一笔改了没有」）保证这件事**幂等**：没有边界外改动时，
   * 内容与时间都不动，一笔事务都不产生。
   */
  /**
   * 「离开这一行」的编辑边界：先把当前行的正文改动当改名交出去。
   * 点击 `contenteditable=false` 的元素（块标、引用、原子、按钮）不派发 `focusout`，
   * 不显式提交则修改时间停在上一处——六个入口（粘贴图片/引用/原子/聚焦/上下文展开与回退）
   * 走的是同一条边界，所以收成一处；`except` 供「点的是自己那一行」的调用方排除自己。
   */
  private commitLeavingLine(except?: string): void {
    const from = this.caretBlock() ?? this.editBase?.id ?? null
    if (from && from !== except) this.commitEdit(from)
  }

  commitEdit(id: string): { ok: true } | { ok: false; conflict: Block } {
    const base = this.editBase
    if (!base || base.id !== id) return { ok: true }
    /**
     * ⚠️ **以 `doc` 里的那一块为准，`store.find` 只作旁证**。
     *
     * 装载进来的 roots 未必在 store 的索引里（索引按库建，而视图拿到的可能是
     * 只属于这个视图的那一份）——早先这里只认 `store.find`，于是那些块上的边界
     * **一次都没执行过**：`#tag` 的「编辑边界才算敲完」与「修改时间」都静默失效，
     * 而且不报错（看起来像「边界逻辑没写」）。
     */
    const b = locate(this.doc, id)?.block ?? this.store.find(id)
    if (!b) {
      this.editBase = null
      return { ok: true }
    }
    // 组合期不提交：IME 的预编辑还不是这次编辑的结束
    if (this.probe.isComposing) return { ok: true }
    this.rebase(b)
    this.stampEdited(b)
    return { ok: true }
  }

  /**
   * 记下「这一块刚被显式改过」：内容没变就什么都不做。
   *
   * 判据是**整块内容**：`syncFromDom` 已经逐笔把字写进模型，边界的职责只剩「宣布到这里
   * 算一次改动」；拿「这次有没有写」当判据会把「只移动了光标」也算成改动。
   */
  private stampEdited(b: Block): void {
    // 判据是「这次编辑期里**真的写进过模型**」：`syncFromDom` 把新内容落进模型、
    // 又确实变了时才在这里记下这一块。
    if (!this.edited.has(b.id)) return
    this.edited.delete(b.id)
    const at = Date.now()
    this.write((tx) => tx.patch(b.id, (x) => (x.modified = at)))
  }

  /** 换一个编辑期：先把上一块交出去（换块就是上一次编辑的结束），再记下这一块此刻的样子 */
  private beginEdit(b: Block): void {
    const prev = this.editBase
    if (prev && prev.id !== b.id) this.commitEdit(prev.id)
    this.rebase(b)
  }

  private rebase(b: Block): void {
    this.editBase = { id: b.id }
  }

  /**
   * **给一个块挂标签**（块级露面：正文之后出 chip）。
   *
   * 只写归属、不碰正文 —— 正文里那枚 `#名` 是**另一个动作**（`↵` 的提及），
   * 它不写 `_tags`；所以这里也不替用户删字、不替他造 run。
   * @returns 真的加上了才 `true`（已经有、名字为空 ⇒ `false`）
   */
  addTag(blockId: string, name: string): boolean {
    const b = this.store.find(blockId)
    if (!b) return false
    // 归属还没核定 ⇒ 先问一次库再重放（闸的语义见 `core/kb/alias-gate.ts`）
    if (deferAliasGate(this.store, name, () => this.addTag(blockId, name))) return true
    // 快照取在**建标签**之前：撤销这次挂标签时，顺手建出的标签块也该一起回滚
    this.beginUndoEntry()
    // 建标签块（可能）＋写归属是同一笔：拆开就会留下「只有标签、没有归属」的半批。
    // 名字为空／已挂 ⇒ 事务里什么都不写（零 op）
    let ok = false
    try {
      ok = this.write((tx) => {
        const tag = ensureTagInTx(tagLookupOf(this.store.blocks, this.store), name, tx)
        if (!tag || hasTag(b, tag.id)) return false
        tx.setTags(blockId, [...tagIdsOf(b), tag.id])
        return true
      })
    } catch (e) {
      // 名字被一个未装载的块占着 ⇒ 不新建（否则地址空间出现第二个同名身份）；留成纯文本
      this.abortUndoEntry()
      if (e instanceof AliasClaimError) {
        console.warn(`[editor] tag "${e.aliasName}" exists on an unloaded block; left as text`)
        return false
      }
      throw e
    }
    if (!ok) {
      this.abortUndoEntry()
      return false
    }
    this.finishUndoEntry('other', Date.now())
    if (locate(this.doc, blockId)) this.renderBlock(blockId)
    this.emitChange('text', [blockId])
    return true
  }

  /**
   * **摘掉一个标签的归属**（连带收掉它在正文里的露面）。
   *
   * ⚠️ 为什么连露面一起收：不知道「归属没了、正文里还留着一枚 `#名`」该怎么显示 ——
   *    画成标签是撒谎（查询已经找不到它），画成文字又要多一条渲染分支。
   *    收掉最干净；同一笔撤销能把它恢复回来。
   */
  removeTag(blockId: string, tagId: string): boolean {
    const loc = locate(this.doc, blockId)
    const b = loc?.block ?? this.store.find(blockId)
    if (!b) return false
    // 正文里的露面 ＝ 带 `#` 风味、指向这个标签的引用 run（整枚收，顺序无关）
    const hits = refRunsOf(b.content).filter((r) => r.flavor === '#' && r.to === tagId)
    if (hits.length === 0 && !hasTag(b, tagId)) return false
    this.beginUndoEntry()
    /**
     * ⚠️ 露面住在**块自己的内容**里 —— 与「这一块此刻画没画在屏上」无关。
     *    所以不按 `locate` 决定收不收：目标块不在本视图里时也要收，
     *    否则换个视图打开它，会看到一枚「属于标签、但归属里已经没有它」的僵尸露面。
     */
    const strip = (content: readonly InlineRun[]): InlineRun[] => hits.reduce((acc: InlineRun[], h) => removeRunById(acc, h.id), [...content])
    // 收露面与摘归属是同一件事 ⇒ 同一笔；内容没变的块 patch 不发 op
    this.write((tx) => {
      tx.patch(blockId, (bb) => writeBlockContent(bb, strip(bb.content)))
      tx.setTags(blockId, tagIdsOf(b).filter((t) => t !== tagId))
    })
    this.finishUndoEntry('delete')
    if (loc) this.renderAll()
    this.emitChange('text', [blockId])
    return true
  }

  /**
   * **重排一个块的归属序**（`_tags` 数组序）。
   *
   * 顺序喂着块标的借形/借色取「第一个」——它是用户可编辑的真实数据，
   * 不是打标先打的偶然；拖完 chips 的顺序写回这里。
   * 只许换序不许增删：传入集合与现状不一致就整笔拒绝（重排不是加/摘的第二入口，
   * 那两件事各有自己的门，混进来会出现「拖一下顺手挂上了别的标签」的暗写）。
   * @returns 真的换了序才 `true`（同序／集合不一致／块不存在 ⇒ `false`）
   */
  reorderTags(blockId: string, orderedIds: readonly string[]): boolean {
    const b = this.store.find(blockId)
    if (!b) return false
    const cur = tagIdsOf(b)
    if (cur.length !== orderedIds.length) return false
    const key = (ids: readonly string[]): string => [...ids].sort().join('\u0000')
    if (key(cur) !== key(orderedIds)) return false
    if (cur.every((id, i) => id === orderedIds[i])) return false
    this.beginUndoEntry()
    const ok = this.write((tx) => {
      tx.setTags(blockId, [...orderedIds])
      return true
    })
    this.finishUndoEntry('other')
    if (locate(this.doc, blockId)) this.renderBlock(blockId)
    this.emitChange('text', [blockId])
    return ok
  }

  /**
   * 从 DOM 输入事件同步模型（真实键入路径）。
   *
   * **DOM 重建 runs**：读回的是整段内容（文本段带格式、原子按 `data-atom-id`
   * 原样带回），模型侧整组替换。没有偏移映射——原子的存亡由「元素还在不在」决定，
   * 用户删掉那一格就是一次显式删除。
   *
   * ⚠️ **这里不认任何语法**：`#名字` 不再在敲到分隔符时静默变成标签。
   *    触发浮层与落点都在别的层（`emitTrigger` 报「在敲什么」，装配层按触发表弹浮层，
   *    选中之后才由 `acceptTrigger` 一次落账）。输入路径只做「把字同步进模型」这件事，
   *    否则同一串字会出现两套行为，而用户不知道刚才发生了哪一套。
   */
  syncFromDom(id: string, reRender: boolean): void {
    /**
     * 找块用 **store 的索引**（O(1)）：键入路径上每多一次 `locate(doc, id)`
     * 就是一次全树 DFS，而 store 里已经有增量维护的 byId 表。
     * 原来的 `!loc` 守卫仍由「找不到块」承担；DOM 行存在与否由调用方的事件源保证。
     */
    const block = this.store.find(id)
    if (!block) return
    // 这一块的第一笔输入 ＝ 一次编辑期的开始（此刻模型里还是改名前那个值）
    if (this.editBase?.id !== id) this.beginEdit(block)
    const next = this.readRunsOf(id)
    if (sameRuns(next, block.content)) return
    // 这一块真的落过字 ⇒ 到边界时记一次「块被改过」（时刻只在边界写，见 `stampEdited`）
    this.edited.add(id)
    const prevLen = plainLen(block.content)
    const kind = plainLen(next) < prevLen ? 'delete' : 'insert'
    const at = Date.now()
    /**
     * **连续打字仍然是一步，但不再为它取整库快照**：捕获只含这一块（事务出口深拷），
     * 合并窗口由撤销栈判断（同一 `kind` 且 1200ms 内 ⇒ 只更新上一条的 `after`）。
     *
     * ⚠️ 顺序仍不许反：`beginUndoEntry` 要在 `write` **之前**调 ——
     *    它记的是「改动之前」的选区与这一动作的捕获袋。
     */
    this.beginUndoEntry()
    this.write(
      (tx) => {
        tx.patch(id, (b) => writeBlockContent(b, next))
      },
      undefined,
      // 这是一行里的直接打字（含行内粘贴／删除）：查询块的标题只住在正文里，
      // 没有别的改名入口 ⇒ 只有这条路径能写它；合并／拆分等结构路径仍被挡。
      { directEdit: true },
    )
    const caret = this.sel ? this.sel.aOff : null
    this.finishUndoEntry(kind, at)
    if (reRender) {
      this.renderBlock(id)
      if (caret !== null) this.placeCaret(id, Math.min(caret, plainLen(block.content)))
      // **改名传播**：这一块可能是别处引用的目标 ⇒ 引用它的那些块也要重画（显示名现算）。
      // 改动只影响「指向它的 run 所在的块」，不是全视图重渲染。
      this.renderRefSources(id)
    }
    // 文本改了哪一块是已知的：带上 id，查询视图据此判断「结果里的内容变没变」
    this.emitChange('text', [id])
  }

  /**
   * **重画「引用了 `id` 这一块」的那些块**。
   *
   * 装配层在「改名 / 换显示模式 / 改露面」这类**属性写入**后也调它：
   * 那些写入不走 `syncFromDom`，没有别的「名字变了」信号能触发传播。
   *
   * 为什么需要显式做：引用显示的是**目标当前的名字**（`core/ref.ts`），是派生的；
   * 目标改名后，`atom`/`block` 本身一个字节都没变 ⇒ 没有任何「数据变了」的信号能触发重渲染。
   *
   * **反查走关系索引的入向表**（`relationsTo`），不扫整篇 doc。索引由事务出口按 op
   * 增量维护，「谁指向我」本来就有现成答案——逐块扫 run 的写法让每次输入都遍历
   * 全部块（块越多越像「每键全树」），而它要的只是这几条入边。
   *
   * 只认三种会**在正文里显示目标名字**的边：正文引用（`inline`）、行内标签露面
   * （`tagMention`）、`_tags` 归属（`tag`）。属性值与嵌入的显示名由各自的身体负责，
   * 不在这行正文里——多画一遍只是白换 DOM。
   *
   * ⚠️ 只重画**本视图内**的块：别的页里也有指向它的引用，但那些 DOM 不在 `doc` 里，
   *    由它们自己所在的视图在装载/刷新时解析（共享 store 只保证数据一致，不替别人画 DOM）。
   */
  renderRefSources(id: string): void {
    const sources = new Set<string>()
    for (const e of relationsTo(this.store.index, id)) {
      if (e.kind === 'inline' || e.kind === 'tagMention' || e.kind === 'tag') sources.add(e.from)
    }
    for (const sourceId of sources) {
      if (sourceId === id) continue
      if (this.blockEl(sourceId)) this.renderBlock(sourceId)
    }
    /**
     * **引用关系变了 ⇒ 目标块行尾的引用数徽标也要跟着变**。
     *
     * `changesOf(ops)` 只报「这次动了哪些块」（来源块 id），被引用目标不在通知的
     * `ids` 里 ⇒ 冻结分支按 id 局部重画会漏掉它，徽标会停在旧数字上。这里按出向边
     * 补一次（改后仍在的目标）。删掉引用时目标不在改后边表里，由下一次整页重画兜底。
     */
    for (const e of relationsFrom(this.store.index, id)) {
      if (!isRefKind(e.kind) || e.to === id) continue
      if (this.blockEl(e.to)) this.renderBlock(e.to)
    }
    // 改过的出向边让目标的全库角标过期（缓存摘掉 ＋ 错峰批查补全库口径）
    this.invalidateRefBadge(relationsFrom(this.store.index, id).filter((e) => isRefKind(e.kind) && e.to !== id).map((e) => e.to))
  }

  /* --------------------------------------------------------- 结构操作 */

  /**
   * Enter 的入口（2026-10-20 第五次修订； 推广到 N 个 section）。
   *
   * 分支判定集中在 `core/tree.ts` 的 `enterKind()`（纯函数、有单测），这里只执行：
   *   · `outdent` —— 空块且缩进 ≥ 2 层：**反缩进**（Enter 不建块）；
   *   · `split`   —— 块中：**同级拆**（左半插成**上方新块**，原块保 id/右半/子树）；
   *   · `child`   —— 块尾 ＋ 有子块且展开：插**首个子块**；
   *   · `sibling` —— 块尾 ＋ 无子块 / 折叠：建**同级**空块。
   *
   * ⚠️ **任意 section 根**（页／天／查询记录）没有兄弟位（写回按 root id 走）⇒ 不走上面四支：
   *    · **无角色的内容根**（focus/zoom 的普通块）＋ 文本**中间**
   *      ⇒ 左半留根、右半成**首个子块**，光标到子块；
   *    · **有角色的根**（页/日记）或块首 / 空块 / 块尾 ⇒ 插一个**空的首个子块**
   *      （根文本是名字/投影，不拆，避免静默改名）。
   */

  /**
   * 折 / 展一块（点三角、`mod+.`）。
   *
   * ⚠️ **不进撤销栈**：折叠是「这一行此刻怎么显示」，不是内容改动。
   *    记快照会让 `⌘Z` 把折叠撤回去 —— 用户想撤销的是刚才那几个字，不是「我折了一行」。
   *    代价明写：展开/收起之后按 `⌘Z` 撤的是**上一次内容改动**（与折叠无关）。
   */
  toggleCollapse(id: string): void {
    const loc = locate(this.doc, id)
    if (!loc) return
    /**
     * 查询块没有子块 ⇒ 折的是**身体**（结果视图）；露面投影行同理（折的是源的结果
     * 视图那一格）。只有「这个表面真的画身体」时才允许折——否则点了没有任何可见效果。
     */
    const bodyOnly = !hasLiveChildren(loc.block)
    if (bodyOnly && !this.bodyFoldable(loc.block)) return
    if (!toggleCollapsed(this.doc, id)) return
    /**
     * 身体折起来**不重排整屏**：只改这一行的折叠标记与身体的 `data-folded`。
     * 重排会重建 ViewHost（冻结结果与滚动位置都丢），而折一下并没有改变可见行集合。
     *
     * ⚠️ 有子块的身体块走下面 `renderAll` 那条：`folded` 在那里表示「收起整个容器」，
     *    身体随子块一起藏；只折子块的入口是导轨／`toggleChildrenCollapsed`。
     */
    if (bodyOnly) {
      const el = this.blockEl(id)
      /**
       * 代码块的身体是 CM6：收起要**真卸掉**（折叠态不挂第二编辑器），展开再重画
       * 这一行把它挂回来。查询体／投影体不同：它们只藏不卸，冻结结果与滚动还在。
       */
      if (el?.dataset.code === '1') {
        if (isFolded(this.doc, id)) {
          this.paintFold(id)
          this.embeds.disposeRow(id)
        } else {
          this.renderBlock(id)
        }
      } else {
        this.paintFold(id)
      }
      this.emitChange('view')
      return
    }
    this.renderAll()
    this.emitChange('view')
  }

  /** 把折叠态画到**已经挂着**的那一行上（不重建 DOM；查询身体折叠走这里） */
  private paintFold(id: string): void {
    const el = this.blockEl(id)
    if (!el) return
    const folded = isFolded(this.doc, id)
    if (folded) el.dataset.collapsed = '1'
    else delete el.dataset.collapsed
    const fold = el.querySelector<HTMLElement>(':scope > .left > .fold')
    if (fold) fold.dataset.tip = folded ? t('ui.block.foldExpand') : t('ui.block.foldCollapse')
    const body = el.querySelector<HTMLElement>(':scope > .blk-view-body, :scope > .blk-embed-body, :scope > .blk-code-host')
    if (body) {
      if (folded) body.dataset.folded = '1'
      else delete body.dataset.folded
    }
    this.render.noteFoldPainted()
  }

  /**
   * **点导轨段 ⇒ 折 / 展该祖先的直接子块**。
   *
   * 与 `toggleCollapse`（点三角）分开：这条命令**不折那个祖先自己**。
   * 理由见 `core/tree.ts` 的 `toggleChildrenCollapsed`。
   *
   * ⚠️ **必须落在行所属的这台编辑器上**（桥里的直调）：折叠表（`doc.folded`）
   *    是**每台编辑器一份**的视图实例态——镜像岛与源同屏时是两个世界，
   *    走「活动编辑器」就会点了镜像的线、折了源的子块。
   * ⚠️ 必须 `renderAll()`（不是 `renderBlock`）：折子块会改变**可见行集合**
   *    ⇒ 祖先表与整棵 DOM 都要重建（与 `toggleCollapse` 同形）。
   * ⚠️ **不进撤销栈**：与 `toggleCollapse` 同一条理由 —— 折叠不是内容。
   */
  toggleChildrenCollapse(id: string): void {
    const loc = locate(this.doc, id)
    if (!loc) return
    /**
     * 查询块／投影行没有子块，它们的「下一层」是**身体**（结果视图）：
     * 点线与点三角同效——折身体，行自己不折（折完行还看得见，线也还在）。
     */
    if (!hasLiveChildren(loc.block)) {
      if (this.bodyFoldable(loc.block)) this.toggleCollapse(id)
      return
    }
    if (toggleChildrenCollapsed(this.doc, id) === null) return
    this.renderAll()
    this.emitChange('view')
  }

  /**
   * **这个表面会不会把这一块的身体画出来**（查询内联体，或露面的投影）。
   *
   * 折/展身体的所有入口（三角、导轨、菜单）都认这一份判据——查询结果列表里的
   * 命中行也是查询块，但那一层画的是结果行，给它折一下没有任何可见效果。
   * 「有身体」与「身体归谁画」同一份答案（`inlineBodyKind`），别再抄一遍源清单。
   */
  private bodyFoldable(b: Block): boolean {
    return (
      (Boolean(this.events.viewBody || this.events.automationBody || this.events.defBody) && inlineBodyKind(b) !== null) ||
      (Boolean(this.events.embedBody) && rowHasEmbedViewBody(b, (id) => this.store.find(id))) ||
      (Boolean(this.events.codeBody) && blockTypeOf(b) === CODE_TYPE)
    )
  }

  /**
   * **gutter 上 select 类图标的取值菜单**：把锚点交给装配层开选项菜单。
   * 入口有三条：左键点普通 select、⌥+点状态标记、右键点任何 select 类图标
   * （状态标记的普通左键不走这里——那一下翻完成，见 `toggleClosure`）。
   */
  pickGutterValue(id: string, propId: string, anchor: DOMRect): void {
    if (!locate(this.doc, id)) return
    this.events.pickChoice?.(id, propId, anchor)
  }

  /**
   * **勾 / 取消勾选**这一行 gutter 上那个任务开关。
   *
   * 写的是**属性值**，不是块字段：任务状态是一个真实字段（有定义块、能进查询、能导出），
   * 所以这里走 `setValue`。`gutterFieldsOf` 是唯一的「这一行有哪些 gutter 字段」来源，
   * 点方框与菜单命令共用它 ⇒ 两条入口不会对同一行给出不同答案。
   *
   * 完成型字段是 select（值＝选项块 id）：切换是**完成 ⇄ 未完成**的二元互换，
   * 「进行中」不进快捷键 —— 它是显式意图，走属性编辑器或看板拖列去设。
   * 同一行上别的 checkbox 字段仍是布尔翻转（「未填」也算没勾，一次点击就是打上勾）。
   *
   * ⚠️ 这一行**一个 gutter 字段都没有**时（例如从菜单对普通块按「切换待办」）：
   *    落「待办」而不是「完成」。落下去之后它就成了这一块的**自有字段**，
   *    gutter 上随即出现方框 —— 于是「先成为一个没做完的任务，再点才勾上」，
   *    与原来「第一次切换 ＝ 变成待办」的手感一致。
   */
  /**
   * **普通勾选框**（`_check` 无 `_use`）：只翻 on/off，不碰 `closureOf`/划线。
   * 每个字段自己的 propId 从 gutter 带过来；一行上多个勾选框互不串台。
   */
  toggleCheck(id: string, propId: string): void {
    const loc = locate(this.doc, id)
    if (!loc) return
    const field = gutterFieldsOf(loc.block, this.store.blocks).find((f) => f.propId === propId)
    if (!field?.check) return
    const next = field.value === field.check.on ? field.check.off : field.check.on
    this.beginUndoEntry()
    this.write((tx) => tx.patch(id, (b) => setValue(b, propId, next)))
    this.structTail(null, [id])
  }

  toggleClosure(id: string, onlyPropId?: string): boolean {
    const loc = this.locateAny(id)
    if (!loc) return false
    /**
     * 目标字段：点 gutter 上哪一枚就传哪个 propId（多个勾选框不串台）；
     * 命令／快捷键不带目标 ⇒ 库里唯一的任务状态（见 `closureTargetField`），
     * 普通两态字段等它自己那一下点击。判据住在 `core/props/closure.ts`
     * （单块／批量／记录面共用）。
     */
    const plan = closurePlanFor(loc.block, this.store.blocks, onlyPropId)
    if (!plan) return false
    this.beginUndoEntry()
    // 切的是一个属性值：一笔 patch 落「值 ＋（新挂时）自有槽」，与「插入待办」同一形状。
    // 落的是核心任务状态 ⇒ 定义块得先在（恢复空库／定义被清掉的库里没有它，
    // 缺了它这一行只剩「未知属性」）；同一笔事务里补上，值与定义同批落盘。
    this.write((tx) => {
      if (plan.propId === TASK_STATUS_PROP_ID) ensureTaskStatusInTx(this.store.blocks, tx)
      tx.patch(id, (b) => applyClosurePlan(b, plan))
    })
    this.structTail(null, [id])
    return true
  }

  /**
   * 批量切换待办（块选区）：每块按**自己**的字段判据翻值（同 `toggleClosure`），
   * 全部装进**一笔事务**：定义块只补一次、一次撤销整体复原。section 根跳过。
   */
  toggleClosureMany(ids: readonly string[]): boolean {
    const plans: { id: string; plan: ClosurePlan }[] = []
    for (const id of ids) {
      const loc = locate(this.doc, id)
      if (!loc || loc.parent === null) continue
      const plan = closurePlanFor(loc.block, this.store.blocks)
      if (plan) plans.push({ id, plan })
    }
    if (plans.length === 0) return false
    this.beginUndoEntry()
    this.write((tx) => {
      if (plans.some((p) => p.plan.propId === TASK_STATUS_PROP_ID)) {
        ensureTaskStatusInTx(this.store.blocks, tx)
      }
      for (const p of plans) tx.patch(p.id, (b) => applyClosurePlan(b, p.plan))
    })
    this.structTail(null, plans.map((p) => p.id))
    return true
  }

  /**
   * **摘掉这一块的关闭态**（`core.editor/clear-closure`）：`toggleClosure` 的逆。
   *
   * 为什么不能只靠 `toggleClosure` 连着点：它翻的是**值**（`true` ⇄ `false`），
   * 而「这块不是任务」说的是**这一栏根本不存在**（`undefined`，见 `closureOf` 的三态）。
   * 值翻到 `false` 仍然是「是任务、没做完」—— 屏幕上还画着空心方框。
   * 所以退出的动作必须是摘栏：值连同自有槽一起删（`clearValue`）。
   *
   * ⚠️ **两种来源只有一种能摘**：这一栏可能来自这块自己的槽，也可能来自
   *    某个标签的**字段声明**（种子里的 `#任务` 就是）。`clearValue` 只动前者，
   *    所以摘完要**再读一次**判据 —— 还剩下就返回 `'declared'`，
   *    由调用方解释「它来自标签」，而不是让用户对着一个没变化的方框猜。
   */
  clearClosure(id: string): 'cleared' | 'declared' | 'none' {
    const loc = this.locateAny(id)
    if (!loc) return 'none'
    // 目标与 `toggleClosure` 同一判据：库里唯一的任务状态字段
    const field = closureFieldOf(loc.block, this.store.blocks)
    if (!field) return 'none'
    this.beginUndoEntry()
    this.write((tx) => tx.patch(id, (b) => clearValue(b, field.propId)))
    this.structTail(null, [id])
    // 摘完要**再读一次**判据：这一栏可能来自标签的字段声明（`clearValue` 只动自有槽），
    // 还剩下就返回 `'declared'`，由调用方解释「它来自标签」，而不是让用户对着
    // 一个没变化的方框猜。
    const after = this.locateAny(id)
    const still = after
      ? gutterFieldsOf(after.block, this.store.blocks).some((f) => f.propId === field.propId)
      : false
    return still ? 'declared' : 'cleared'
  }


  /* ------------------------------------------------------- 区间格式 */

  /**
   * ⌘B/⌘I…：格式是 run 属性 ⇒ 改格式＝改内容。每个被选中的块一条 content 写入
   * （格式/原子改动＝一条 upsert{content}，落库与同步看到的都是整组替换）。
   */
  toggleMark(patch: MarkPatch): void {
    const s = this.sel
    if (!s) return
    const ranges = selToTextRanges(this.doc, s)
    if (ranges.length === 0) return
    this.markTx(s, ranges, 'single', (next, r) => (r.start >= r.end ? next : toggleRunMark(next, patch, r.start, r.end)))
  }

  /**
   * 对选区命中的每段正文应用一次 run 级改动（加格式/清格式同一条骨架）：
   * 快照 → 逐块 patch content → 记撤销 → 重排 → 还原选区 → 广播。
   *
   * ⚠️ 还原的是**整段选区**（不是光标）：塌成光标的话「加完粗再点一次取消」
   *    做不到，划选气泡也会立刻消失。`rerender='single'` 给「只碰一段」的调用方
   *    省一次整树重排；多段与清格式一律整树。
   */
  private markTx(
    s: Sel,
    ranges: readonly { blockId: string; start: number; end: number }[],
    rerender: 'single' | 'all',
    op: (next: InlineRun[], r: { blockId: string; start: number; end: number }) => InlineRun[],
  ): void {
    this.beginUndoEntry()
    const apply = (blockId: string, content: readonly InlineRun[]): InlineRun[] => {
      let next: InlineRun[] = [...content]
      for (const r of ranges) {
        if (r.blockId !== blockId) continue
        next = op(next, r)
      }
      return next
    }
    const touched = [...new Set(ranges.map((r) => r.blockId))]
    // 选区格式（加粗/高亮/清格式…）是用户正对着这一行发起的直接编辑，与打字同档
    this.write((tx) => {
      for (const bid of touched) {
        const b = this.store.find(bid)
        if (b) tx.patch(bid, (bb) => writeBlockContent(bb, apply(bid, bb.content)))
      }
    }, undefined, { directEdit: true })
    this.finishUndoEntry('mark')
    if (rerender === 'single' && ranges.length === 1) this.renderBlock(ranges[0]!.blockId)
    else this.renderAll()
    this.placeRange(s)
    this.emitChange('text')
  }

  /** 当前选区上**出现过**的格式描述符（诊断/划选气泡的按压态）：`'bold'` 或 `'ink:red'` */
  marksAtSel(): string[] {
    const s = this.sel
    if (!s) return []
    const ranges = selToTextRanges(this.doc, s)
    const out = new Set<string>()
    for (const r of ranges) {
      // 索引查表：这一段在每次按键的 `ctxKeys` 里都会过一遍
      const b = this.store.find(r.blockId)
      if (!b) continue
      for (const m of marksInRange(b.content, r.start, r.end)) out.add(m)
    }
    return [...out]
  }

  /**
   * 当前选区**能不能转成引用**：单块、非空、整段都是文本（原子占格不可被文字替换）。
   *
   * 两端空白剪掉：选中「 名字 」时，引用只该包住名字本身，不能把空格也吞进 chip。
   * 这是划选气泡那颗按钮的准入判据，也是命令执行时的复核口径 —— 两处不同就会出现
   * 「按钮在、点了却说没选区」。
   */
  selectionSpot(): { blockId: string; start: number; end: number; text: string } | null {
    const s = this.sel
    if (!s || s.aBlock !== s.hBlock) return null
    // 塌缩选区直接收工，不必为「有没有选区」先找一遍块（这一步在每次按键的上下文键里）
    const from = Math.min(s.aOff, s.hOff)
    const to = Math.max(s.aOff, s.hOff)
    if (from >= to) return null
    const b = this.store.find(s.aBlock)
    if (!b || !canWriteText(b)) return null
    const slice = sliceRuns(b.content, from, to)
    if (slice.length === 0 || slice.some((r) => r.t !== 'text')) return null
    const raw = plainText(slice)
    const start = from + (raw.length - raw.trimStart().length)
    const end = to - (raw.length - raw.trimEnd().length)
    const text = raw.slice(start - from, end - from)
    return text === '' ? null : { blockId: s.aBlock, start, end, text }
  }

  /**
   * 划选复制投影：把模型选区读成「贴到外部该出现的字」——引用出现解析目标名。
   *
   * 为什么不读 `getSelection().toString()`：`.atom` 是 `user-select:none`，划选跨过
   * 引用时原生选区把那一格整段吞掉（真机实测 `…括号：。左键…`）。模型选区里原子
   * 占 1 格，`sliceRuns` 按 plain 偏移切片会把它整枚带出来，`copyTextOf` 读成显示名。
   *
   * 返回 null ⇒ 没有有效选区或选区里没有原子：调用方放行原生复制，纯文字零变化。
   */
  copySelectionText(): { ids: string[]; text: string } | null {
    const s = this.sel
    if (!s) return null
    const ranges = selToTextRanges(this.doc, s)
    if (ranges.length === 0) return null
    const find: FindBlock = (id) => this.store.find(id)
    const ids: string[] = []
    const lines: string[] = []
    let hasAtom = false
    for (const r of ranges) {
      const b = this.store.find(r.blockId)
      if (!b) continue
      ids.push(r.blockId)
      const slice = sliceRuns(b.content, r.start, r.end)
      if (slice.some((run) => run.t !== 'text')) hasAtom = true
      lines.push(copyTextOf(slice, find))
    }
    return hasAtom ? { ids, text: lines.join('\n') } : null
  }

  clearMarksAtSel(): void {
    const s = this.sel
    if (!s) return
    const ranges = selToTextRanges(this.doc, s)
    if (ranges.length === 0) return
    this.markTx(s, ranges, 'all', (next, r) => clearRunsMarks(next, r.start, r.end))
  }

  /* --------------------------------------------------------- 行内原子 */

  /**
   * **落一次内容改写**（报快照 → 写 → 记撤销 → 重画 → 必要时放回光标）。
   *
   * 抽它的直接理由是「第三处」：引用、外链、资产三个插入口原先各自背着同样的五步，
   * 写第三遍时已经开始漂移（记哪一种撤销、要不要 `emitChange` 各有一套写法）。
   * 收成一支 ⇒ 加第四种 run 只需要给一枚形状，不会再漏掉「写完要重画」。
   *
   * ⚠️ **顺序不许改**：先在事务里写模型，再拿 `before` 记撤销（快照必须在写之前取，
   *    由调用方传进来），最后才重画 —— 重画会重建这一块的 DOM。
   * ⚠️ `caret` 省略 ⇒ **不动光标**：从浮层里改东西时，用户的注意力在浮层上，
   *    把光标甩到别处等于抢一次焦点。
   */
  // 协作对象 `InsertOps` 也走这里落内容（插引用/外链/资产）；可见性为它放宽
  commitContent(id: string, next: readonly InlineRun[], undo: UndoKind, caret?: number): void {
    const b = this.store.find(id)
    /**
     * **只读行不落内容，但仍要收口撤销条目**：日记／字段定义／只读类型的正文是名字或投影。
     * 写进去事务会抛 protected，而调用方已经 `beginUndoEntry` —— 一走了之会把
     * `entryDepth` 永久留在 1，此后所有编辑都记不进撤销栈（⌘Z 看着像坏了）。
     */
    if (!b || !canDirectEditText(b)) {
      this.finishUndoEntry(undo)
      return
    }
    // 这里是**行内 run 编辑**的统一落点（插引用/图片/外链、改锚文本、摘原子……）——
    // 全部是用户正对着这一行发起的直接编辑，与打字同档；结构写路径不走这里。
    this.write((tx) => tx.patch(id, (b) => writeBlockContent(b, next)), undefined, { directEdit: true })
    this.finishUndoEntry(undo)
    this.renderBlock(id)
    if (caret !== undefined) this.placeCaret(id, caret)
    this.emitChange('text')
  }


  /** 按 run id 找到它（诊断/popover 用；全库找，popover 的目标块不一定在本视图） */
  findRun(runId: string): { block: Block; run: RunWithId } | null {
    let hit: { block: Block; run: RunWithId } | null = null
    walkForest(this.store.blocks, (b) => {
      if (hit) return false
      const run = runById(b.content, runId)
      if (run) hit = { block: b, run }
      return hit === null
    })
    return hit
  }

  /**
   * **改一枚引用的锚文本**（⌥ 浮层的输入框是**唯一**入口）。
   *
   * 写空串 ⇒ **删掉这个键**：遵守「缺席与空值不并存」的既有口径 ——
   * 读侧只需判「有没有 anchor」，不必再判「有但是空的」（那种形状在一处漏判就显示成空白 Link）。
   *
   * ⚠️ 为什么入口不能在正文流里（让用户在原子上直接打字）：原子占 1 格的契约
   *    （plain 偏移核算、IME 组合、读回配对）全部建立在「这一格不可分割」之上；
   *    在流里改＝给一枚原子做一个内部编辑器，那三条约束会同时失效。
   *
   * ⚠️ 一次调用一轮撤销 ⇒ **一条** `block.upsert{content}`（内容整段改写，
   *    不新增任何第二份真相：名字仍住在目标的 `_aliases` 里）。
   *
   * @returns 真的改了才 `true`（run 不在了 / 已经是这个值 ⇒ `false`，一个字节都不写）
   */
  setRunAnchor(runId: string, anchor: string): boolean {
    const hit = this.findRun(runId)
    // 只有普通块引用有锚文本。两处排除：①外链与资产的显示名是它们自己的内容（`v`／`asset`），
    // 再给一枚 anchor 等于同一句话两个来源；② `flavor:'#'` 的语义是「提及这个标签」，
    // 给它换一个显示名就会出现「写着 `#自定义` 却真指 `#咖啡`」——这一版不开放它的锚文本。
    if (!hit || hit.run.t !== 'ref' || hit.run.flavor === '#') return false
    const text = anchor.trim()
    if ((hit.run.anchor ?? '') === text) return false
    const patch = (r: RefRun): RefRun => {
      const rest: RefRun = { ...r }
      delete rest.anchor
      return text === '' ? rest : { ...rest, anchor: text }
    }
    const next: InlineRun[] = hit.block.content.map((r) => (r.t === 'ref' && r.id === runId ? patch(r) : r))
    this.beginUndoEntry()
    // 不强迫光标：这个动作来自浮层，此刻用户的焦点在浮层里，抢回来就是一次焦点跳变
    this.commitContent(hit.block.id, next, 'other')
    return true
  }

  /**
   * **改一枚外链**（显示文字与地址一起写）。
   *
   * 为什么两个键一起收：它们都是这枚 run 的内容，用户在一次编辑里改完；
   * 分两条命令会让撤销栈出现「地址改了、文字没改」的半批。
   *
   * 显示文字留空 ⇒ 落回地址本身（与插入路径同一条口径：看不见的链接等于不存在）。
   * 地址的合法性**不在这里判**：白名单住在 `core/link.ts`，命令入口先过它。
   */
  setRunLink(runId: string, next: { url: string; text: string }): boolean {
    const hit = this.findRun(runId)
    if (!hit || hit.run.t !== 'link') return false
    const url = next.url.trim()
    const text = next.text.trim() === '' ? url : next.text.trim()
    if (hit.run.url === url && hit.run.v === text) return false
    const patched: LinkRun = { ...hit.run, url, v: text }
    const nextContent = hit.block.content.map((r) => (r.t === 'link' && r.id === runId ? patched : r))
    this.beginUndoEntry()
    this.commitContent(hit.block.id, nextContent, 'other')
    return true
  }

  /**
   * **把一枚行内原子变成纯文本**（取消引用／标签／链接，字留在原处）。
   *
   * 取的是**用户此刻看到的字**：普通引用＝解析后的名字、行内 `#`＝`#名字`
   * （`#` 是它此刻的写法，不是装饰）、外链＝显示文字、资产＝文件名快照。
   * 格式（粗体等）跟着搬过去——用户删掉的是「它是个对象」，不是「它的样式」。
   *
   * ⚠️ 一次调用一轮撤销（整段内容一条 `block.upsert`）；不做「先删再插」两笔，
   *    那样中间态会丢掉光标位置，也会让一次动作看起来像两次。
   */
  runToText(runId: string): boolean {
    const hit = this.findRun(runId)
    if (!hit) return false
    const run = hit.run
    let text = ''
    if (run.t === 'ref') {
      const view = resolveRef((id) => this.store.find(id), run)
      text = run.flavor === '#' ? `#${view.label}` : view.label
    } else if (run.t === 'link') {
      text = run.v
    } else {
      text = run.label ?? run.asset.slice(0, 8)
    }
    if (text === '') return false
    const next: InlineRun = {
      t: 'text',
      v: text,
      ...('marks' in run && run.marks && Object.keys(run.marks).length > 0 ? { marks: run.marks } : {}),
    }
    const nextContent = hit.block.content.map((r) => (r.t !== 'text' && r.id === runId ? next : r))
    this.beginUndoEntry()
    this.commitContent(hit.block.id, nextContent, 'other')
    return true
  }

  /**
   * **修一枚 dangling 引用**（块菜单/原子菜单的「恢复／重建」都走这里）。
   *
   * 引用按 **id** 指人，所以「修」有两条路，顺序不能反：
   *   · 目标还在**回收站** ⇒ 恢复那一块（同一 id 回来 ⇒ **所有**指向它的引用一起复原，
   *     内容也回来）；这时另建一个同名块是没有用的：新块 id 不同，这一枚仍然指不到。
   *   · 目标真的没了（或被永久清除、或种子里的假地址）⇒ 按**可见名**找到或新建一块
   *     （`#` 建标签，其余建页），再把**这一枚**的 `to` 指过去。别的引用若也指着旧 id，
   *     下次修到它时会按同名收敛到同一块。
   *
   * @returns 修了什么；`none` ＝ 不是引用 / 已经能解析 / 连名字都没有（没有可用来重建的东西）
   */
  repairRef(runId: string): 'restored' | 'repointed' | 'none' {
    const hit = this.findRun(runId)
    if (!hit || hit.run.t !== 'ref') return 'none'
    const run = hit.run
    const to = run.to ?? ''
    if (to !== '' && this.store.find(to)) return 'none'
    const label = (run.anchor ?? run.label ?? '').trim()
    // 归属还没核定 ⇒ 先问一次库再重放（要按名字新建那条路用得上；目标在回收站那条不需要）
    if (deferAliasGate(this.store, label, () => this.repairRef(runId))) return 'none'
    this.beginUndoEntry()
    let mode: 'restored' | 'repointed' | 'none' = 'none'
    const ok = this.write((tx) => {
      if (to !== '' && trashOf(this.store.blocks).some((b) => b.id === to)) {
        tx.restore(to)
        mode = 'restored'
        return true
      }
      if (label === '') return false
      // 重建要改**宿主块**的 run（`to` 指过去）：只读行（journal 日期等）不写；
      // 可直接编辑的行（普通块／查询标题）都修——引用能进标题，修复就要跟得上
      if (!canDirectEditText(hit.block)) return false
      const lookup = tagLookupOf(this.store.blocks, this.store)
      let target: Block | null = null
      try {
        target = run.flavor === '#' ? ensureTagInTx(lookup, label, tx) : ensurePageInTx(lookup, label, tx)
      } catch (e) {
        // 名字被一个未装载的块占着 ⇒ 不按名字新建（新 id 指不到原来的目标）；留作 dangling
        if (e instanceof AliasClaimError) {
          console.warn(`[editor] repair target "${e.aliasName}" exists on an unloaded block; not repointed`)
          return false
        }
        throw e
      }
      if (!target) return false
      tx.patch(hit.block.id, (b) =>
        writeBlockContent(
          b,
          b.content.map((r) => (r.t === 'ref' && r.id === runId ? { ...r, to: target.id } : r)),
        ),
      )
      mode = 'repointed'
      return true
    }, undefined, { directEdit: true })
    if (!ok) {
      this.abortUndoEntry()
      return 'none'
    }
    this.finishUndoEntry('other', Date.now())
    this.renderAll()
    this.emitChange('struct')
    return mode
  }

  /**
   * **打字贴着原子的接管**（与 `deleteAdjacentAtom` 对称的那一半）：折叠光标的
   * 前一格或当前格是原子 ⇒ 这一笔插入走模型路径（`spliceRuns` 继承左邻格式），
   * 不放行给原生。
   *
   * 为什么接管：光标贴原子时 DOM 里常常没有文本节点可站（「块尾是原子」「整行
   * 只有原子」），原生插入按不稳定位乱放——实测「纯引用行打字进不去／位置乱」，
   * 字被塞进 DOM 的游离处再被读回，行为随 Chrome 心情。稳定位上原生打字本来也
   * 写得对，接管之后两条路同一结果、同一档打字撤销。
   *
   * ⚠️ 组合期（IME）不接——守卫在事件层（与删除接管同一条）。
   *
   * @returns 接管了才 `true`；非折叠／跨块／不贴原子 ⇒ `false`（照常走原生）
   */
  insertTextAtCaret(text: string): boolean {
    const s = this.sel
    if (!s || s.aBlock !== s.hBlock || s.aOff !== s.hOff) return false
    const loc = locate(this.doc, s.aBlock)
    if (!loc || !canDirectEditText(loc.block)) return false
    const content = loc.block.content
    const before = runAtCell(content, s.aOff - 1)
    const after = runAtCell(content, s.aOff)
    const nextToAtom = (before !== null && before.t !== 'text') || (after !== null && after.t !== 'text')
    if (!nextToAtom) return false
    this.beginUndoEntry()
    const next = spliceRuns(content, s.aOff, s.aOff, text)
    this.commitContent(loc.block.id, next, 'insert', s.aOff + text.length)
    return true
  }

  /**
   * **删除键贴着原子的接管**（⌫ 删前一格／Delete 删当前格）：那一格是原子 ⇒
   *
   * 为什么接管：光标贴着原子时 DOM 里常常**没有文本节点可站**（「块尾是原子」
   * 的插入点落在原子与 `<br>` 之间的元素位），那是 Chrome 的不稳定光标位——
   * 原生删除会按它自己挪错的位置走，把整行可编辑根从 DOM 摘掉而模型一字不动
   * （实测：插入引用后马上 ⌫，`.tx` 整个消失、行从此打不进字）。稳定位上原生
   * 删除本来也会摘原子，接管之后两条路同一个结果、同一档撤销（`'delete'`）。
   *
   * @returns 接管了才 `true`；非折叠选区／跨块／格上不是原子 ⇒ `false`（照常走原生）
   */
  deleteAdjacentAtom(dir: 'back' | 'forward'): boolean {
    const s = this.sel
    if (!s || s.aBlock !== s.hBlock || s.aOff !== s.hOff) return false
    const loc = locate(this.doc, s.aBlock)
    if (!loc || !canDirectEditText(loc.block)) return false
    const hit = runAtCell(loc.block.content, dir === 'back' ? s.aOff - 1 : s.aOff)
    if (!hit || hit.t === 'text') return false
    this.beginUndoEntry()
    const next = removeRunById(loc.block.content, hit.id)
    this.commitContent(loc.block.id, next, 'delete', dir === 'back' ? s.aOff - 1 : s.aOff)
    return true
  }

  /** 删掉一枚行内原子（显式动作；只动那一格，文本不受影响） */
  removeRun(runId: string): void {
    const hit = this.findRun(runId)
    if (!hit) return
    this.beginUndoEntry()
    const next = removeRunById(hit.block.content, runId)
    // 摘原子与插原子同档（都是这一行上的行内 run 编辑）
    this.write((tx) => tx.patch(hit.block.id, (b) => writeBlockContent(b, next)), undefined, { directEdit: true })
    this.finishUndoEntry('delete')
    this.renderAll()
    this.emitChange('text')
  }

  /**
   * 写备注：把当前选区物化成区间锚 ＋ 建一条备注块，**同一笔事务**
   * （拆开就是「宿主加了锚、备注块不在」的半批）。
   * 返回备注块 id 与指向对（浮窗定锚用）；没有可用选区 ⇒ null。
   */
  createNoteFromSelection(): { noteId: string; pairs: NotePair[] } | null {
    const spot = this.selectionSpot()
    if (!spot) return null
    const b = locate(this.doc, spot.blockId)?.block
    if (!b) return null
    const anno = mkAnno(b.content, spot.start, spot.end)
    if (!anno) return null
    return this.createNote([{ block: spot.blockId, anno: anno.id }], (tx) => {
      tx.setAnnos(spot.blockId, [...(b.annos ?? []), anno])
    })
  }

  /**
   * 写备注（块选区态）：每个选中的块整段一枚区间锚，**一条备注**带走全部——
   * 跨块备注＝一块（租客）对多枚（锚），锚侧不变（每枚只锚一个块内区间）。
   * 空块／纯原子块锚不出来 ⇒ 跳过；一个都锚不出来 ⇒ null（无事发生，不发空 op）。
   */
  createNoteFromBlockSelection(): { noteId: string; pairs: NotePair[] } | null {
    const pairs: NotePair[] = []
    const hostAnnos: { blockId: string; annos: Anno[] }[] = []
    for (const id of this.bsel.selectedRootIds()) {
      const b = locate(this.doc, id)?.block
      if (!b || plainLen(b.content) === 0) continue
      const anno = mkAnno(b.content, 0, plainLen(b.content))
      if (!anno) continue
      pairs.push({ block: id, anno: anno.id })
      hostAnnos.push({ blockId: id, annos: [...(b.annos ?? []), anno] })
    }
    if (pairs.length === 0) return null
    return this.createNote(pairs, (tx) => {
      for (const h of hostAnnos) tx.setAnnos(h.blockId, h.annos)
    })
  }

  /** 两个入口共用的落笔：锚写宿主＋备注块进顶层，一笔事务一条撤销。落焦点归浮窗（装配层） */
  private createNote(pairs: NotePair[], writeHosts: (tx: Tx) => void): { noteId: string; pairs: NotePair[] } | null {
    this.beginUndoEntry()
    let noteId: string | null = null
    this.write((tx) => {
      writeHosts(tx)
      noteId = ensureNoteInTx(this.store.blocks, pairs, tx).id
    }, undefined, { directEdit: true })
    this.finishUndoEntry('other', Date.now())
    return noteId ? { noteId, pairs } : null
  }

  /* ------------------------------------------------------- 虚拟化 */

  setVirtualize(on: boolean, radius = this.radius): void {
    this.virtualize = on
    this.radius = radius
    /**
     * 换档时作废实测高：关档期间不记账（全挂载不用占位），表里留着的是**上一次开档时**
     * 那个宽度下的数——不一定是现在的宽度。作废后第一窗重新量一遍，代价是一次布局读。
     */
    this.render.invalidateHeights()
    this.renderAll()
    this.events.change?.('load')
  }


  /* ------------------------------------------------------- 空白处建块 */

  /**
   * **点空白处 ⇒ 在当前 section 下面建一个子块**（推广到 N 段）。
   *
   * ⚠️ **修订历史**：v1 建「最后一行之后的同级块」⇒ 在**空 journal** 上就是建到了
   *    `roots[1]`（死区），一下次保存即丢。之后改成「当前对象的子块」。
   *    现在有 N 段（日记流）：点击点在**整个文档最后一行之下**，视觉上属于**最后一段**
   *    （日记流里是最早的一天）⇒ 建它的最后一个子块。N=1 时与旧行为完全一致。
   *    `row`/`grid` 排列下段是**列**：先按点击的横向位置找列（`.sec` 的盒子），
   *    再对**那一段**做「最后一行之下」判据——点哪列的空白就落到哪天。
   *
   * 落点判据（`clientY`）：只在**目标段最后一行可见块的底边之下**才算空白 —— 否则
   * `#scroll` 里与正文同高的左右留白也会误触。
   *
   * ⚠️ 虚拟化下最后一行可能没挂 DOM ⇒ 取不到 rect 时**放行**（宁可建块，也别「点了没反应」）。
   * ⚠️ 段与段之间的「缝」暂不单独建块（见 `待定-日记流.md`）；首版只认全局底部（column）
   *    与列内底部（row/grid）。
   */
  clickEmptyArea(clientY: number, clientX = 0, place: OpenAction = 'center'): boolean {
    if (!this.allowBlankCreate) return false
    this.bsel.clearBlockSelection()
    const rows = this.rows()
    /** `row`/`grid`：先找列。列不存在（点在列缝／边距上）⇒ 不建块 */
    let secId = ''
    if (this.layout !== 'column') {
      // 只认本编辑器自己的段：嵌套编辑岛（露面身体／挂载区／查询结果）里也有 `.sec`
      const sec = [...this.container.querySelectorAll<HTMLElement>(':scope > .sec')].find((el) => {
        const r = el.getBoundingClientRect()
        return r.width > 0 && clientX >= r.left && clientX <= r.right
      })
      // 点中的是空天格子：落笔物化那一天（与点格子本体同一条出口）
      if (sec?.dataset.shell) {
        this.events.shellWrite?.(sec.dataset.shell, place)
        return true
      }
      secId = sec?.dataset.sec ?? ''
      if (secId === '') return false
    }
    const root = secId ? this.doc.roots.find((r) => r.id === secId) : this.doc.roots[this.doc.roots.length - 1]
    if (!root) return false
    // 目标段的最后一行（column ＝ 全文档最后一行；row/grid ＝ 该列最后一行）
    let last: VisibleRow | undefined
    let cur = ''
    for (const r of rows) {
      if (r.depth === 0) cur = r.block.id
      if (secId === '' || cur === secId) last = r
    }
    const lastEl = last ? this.blockEl(last.block.id) : null
    if (lastEl && clientY < lastEl.getBoundingClientRect().bottom) return false

    this.beginUndoEntry()
    unfoldBlock(this.doc, root.id)
    /**
     * **复用末尾空块，不无中生有**：点底部若最后一段末尾已有一个空块（既无文字也无子块），
     * 直接聚焦它，避免「点一次多一个空块」越点越多。只有末尾没有空块时才新建。
     * 判据收紧到「空文本且空子树」——空标题但带子块的块不当作可复用空块。
     * ⚠️ 复用支**模型不动、撤销不记**（与 `insertBlockAfter` 的空块支同一条口径）：
     *    记了就会吃掉一次 ⌘Z——按一次「什么都不变」的动作，退一步却退到上一次改动之前。
     * ⚠️ 「末尾那块」只能从**活着的**子块里取：软删的块还在 `children` 里，按长度取会
     *    拿到一个屏幕上不存在的块 ⇒ `placeCaret` 找不到节点、静默返回 ⇒ 点了完全没反应。
     */
    const tail = liveChildren(root)
    const lastChild = tail[tail.length - 1]
    const emptyTail = lastChild && isEmptyContent(lastChild.content) && !hasLiveChildren(lastChild) ? lastChild : null
    const child = emptyTail ?? mkBlock('')
    if (!emptyTail) {
      this.write((tx) => tx.insert(child, root.id, root.children.length))
      this.finishUndoEntry('structural', Date.now())
    } else {
      // 复用末尾空块：模型不动、撤销不记（与 `insertBlockAfter` 的空块支同一条口径）
      this.abortUndoEntry()
    }
    this.renderAll()
    this.placeCaret(child.id, 0)
    this.emitChange('struct')
    return true
  }

  /* ------------------------------------------------------------ 绑定 */

  /**
   * 事件接线：**全部委托给 `view/editor-events`**。
   * 这里只把编辑器的能力面递过去——事件逻辑不需要认识 `doc`／`undo`／`marks`。
   */
  private bind(): () => void {
    return bindEditorEvents({
      container: this.container,
      blockOf: (n) => this.blockOf(n),
      syncSel: () => this.syncSel(),
      caretBlock: () => this.caretBlock(),
      reclaimCaret: () => this.reclaimCaret(),
      deleteAdjacentAtom: (dir) => this.deleteAdjacentAtom(dir),
      insertTextAtCaret: (text) => this.insertTextAtCaret(text),
      commitEdit: (id) => {
        this.commitEdit(id)
      },
      collapseSelection: () => this.collapseSelection(),
      syncFromDom: (id, re) => this.syncFromDom(id, re),
      caretAtAtomEdge: (blockId, tx, x, y) => this.caretAtAtomEdge(blockId, tx, x, y),
      caretInsideAtom: (blockId, tx, x, y) => this.caretInsideAtom(blockId, tx, x, y),
      beginMouseSelect: (id, x, y, shift) => this.bsel.beginMouseSelect(id, x, y, shift),
      updateMouseSelect: (x, y) => this.bsel.updateMouseSelect(x, y),
      endMouseSelect: () => this.bsel.endMouseSelect(),
      hasBlockSelection: () => this.bsel.hasBlockSelection(),
      onShellActivate: (date, place) => this.events.shellWrite?.(date, place),
      onGroupActivate: (key) => this.onGroupToggle?.(key),
      emitTrigger: (id) => this.triggers.emitTrigger(id),
      dropTrigger: (id) => this.triggers.dropTrigger(id),
      insertPlainText: (id, _off, text, cut) => this.clip.pasteAt(id, _off, text, cut),
      pasteRefsAt: (target, refs) => this.clip.pasteRefsAt(target, refs),
      pasteIntoSelection: (refs, text) => this.clip.pasteIntoSelection(refs, text),
      clipboardNotice: (kind) => this.events.clipboardNotice?.(kind),
      /**
       * 光标落点：**在浏览器改 DOM 之前**读（`paste` 处理器里第一件事就是捕获它）。
       * 入库是异步的，落点必须在那一刻定下来。
       */
      caretPoint: () => this.insert.caretPoint(),
      pasteTarget: () => this.clip.pasteTarget(),
      /**
       * 粘贴图片：事件层只报「有这么一份字节、落在哪」；入库与插 run 由装配层接
       * （`view` 不该知道资产库长什么样）。
       *
       * ⚠️ 没有接 `onPasteImage` 的实例（测试/独立编辑器）**什么都不做**，
       *    不退回「把图片当文本贴」——那是另一种静默失败。
       */
      onCopy: (ids, text) => this.events.onCopy?.(ids, text),
      copySelectionText: () => this.copySelectionText(),
      annoHitAt: (x, y) => this.annoHitAt(x, y),
      onAnnoMenu: (hit, rect) => this.events.annoMenu?.(hit, rect),
      onPasteImage: async (file, point) => {
        this.commitLeavingLine()
        await this.events.onPasteImage?.(file, point)
      },
      onDropFilesRejected: () => this.events.onDropFilesRejected?.(),
      acceptDrag: (id) => {
        const loc = locate(this.doc, id)
        // 本文档的内容块：段根（页／天／查询记录）不参与拖拽
        if (loc) return loc.parent !== null
        // 别的露面拖来的块（store 是共享的，任何露面的正文区都是结构落点）：
        // store 里存在即接——自环、类型不许有子块等守卫留在 `dropDrag`／`dropMoveExternal`
        return this.store.find(id) !== undefined
      },
      dropRefused: (draggedId, targetId, zone) => dropRefused(this.doc, draggedId, targetId, zone),
      acceptsChildren: (id) => {
        if (id === '') return false
        // store 是共享的：目标行属于另一个露面（镜像／挂载区／槽里的卡）时也答得出来
        const b = locate(this.doc, id)?.block ?? this.store.find(id)
        return b ? typeDeclOf(b).children !== 'none' : false
      },
      beginDrag: (id) => this.drag.begin(id),
      showDropTarget: (el, zone) => this.drag.showDropTarget(el, zone),
      clearDropTarget: () => this.drag.clearDropTarget(),
      /**
       * 落点报上来的块 id 是**载荷里那一个**（不是「我认得刚才那次拖拽」）——
       * 这样从侧槽／面板／任何组件拖过来的块都能落进正文。
       */
      dropDrag: (draggedId, targetId, zone, asRef) => this.drag.drop(draggedId, targetId, zone, asRef),
      endDrag: () => this.drag.end(),

      composing: () => this.probe.isComposing,
      noteComposition: (step) => {
        const was = this.probe.isComposing
        if (step === 'start') this.probe.isComposing = true
        if (step === 'end') this.probe.isComposing = false
        if (step === 'start' || step === 'end') inputSession.noteComposition(this, step === 'start')
        this.probe.compositionSeq.push(step)
        /**
         * **组合结束 ⇒ 把欠下的那次重排补上。**
         *
         * 没有这一步，组合期的守卫就成了死锁：`renderBlock`／`renderAll`／`applyWindow`
         * 在组合期一律只记「欠一次」，而消费它的是补做计时器（200ms）——
         * 用户如果组合完就不再动，正文会**一直停在旧形状**（改了属性看不到、别的视图的改动
         * 也不显示）。所以「结束」这件事必须自己把账清掉。
         */
        if (was && !this.probe.isComposing) this.armFlush()
      },
      blockContent: (id) => locate(this.doc, id)?.block.content ?? [],
      restoreBlockContent: (id, content) => {
        if (!locate(this.doc, id)) return
        this.beginUndoEntry()
        // 写回的是组合开始前模型里已有的那份正文（那次进入本身是直接编辑），同一档
        this.write((tx) => tx.patch(id, (b) => writeBlockContent(b, content)), undefined, { directEdit: true })
        this.finishUndoEntry('delete')
        this.emitChange('text', [id])
      },
      /**
       * 点了一个「指向某块的露面」。**先交出当前行的编辑期**，理由与 `focusBlock` 完全相同：
       * 点击 `contenteditable=false` 的元素不会派发 `focusout`（浏览器不认为焦点离开），
       * 所以不在这里显式 `commitEdit`，「敲完字直接点标签」这条路上修改时间与撞名校验
       * 就会停在上一处 —— 而那正是编辑边界该发生的地方。
       *
       * ⚠️ `runId` → 真的 run 在这一层换（它持有 store），事件层只认 DOM 上的字符串。
       */
      onRefClick: (ref, el, mods) => {
        this.commitLeavingLine()
        const run = ref.runId ? this.findRun(ref.runId)?.run : undefined
        this.events.refClick?.({ to: ref.to, ...(run ? { run } : {}) }, mods, el)
      },
      /** 行尾引用数徽标：与 `onRefClick` 同一套编辑边界（chip 是 contenteditable=false，不派 focusout） */
      onRefCountClick: (id, el, mods) => {
        this.commitLeavingLine()
        this.events.refCountClick?.(id, mods, el)
      },
      /** 实例字段手柄：与 `onRefClick` 同一条编辑边界（contenteditable=false 不派 focusout） */
      onRefFields: (runId, el) => {
        this.commitLeavingLine()
        this.events.refFields?.(runId, el)
      },
      /** 块标签 chip 的三角：同一套编辑边界 */
      onTagFields: (hostId, tagId, el) => {
        this.commitLeavingLine()
        this.events.tagFields?.(hostId, tagId, el)
      },
      /**
       * 非引用的行内原子（图片/外链）。与 `onRefClick` 同一套编辑边界：
       * 点击 `contenteditable=false` 的元素不派发 `focusout`，不显式提交则修改时间停在上一处。
       */
      onAtomClick: (atom, el, mods) => {
        this.commitLeavingLine()
        this.events.onAtomClick?.(atom, el, mods)
      },
      onBlockMenu: (id, rect, appearanceHost, trigger) => this.events.blockMenu?.(id, rect, appearanceHost, trigger),
      onAtomMenu: (hit, el, rect) => this.events.atomMenu?.(hit, el, rect),
      // 左键点块标 ＝ 聚焦/zoom。这也是**离开这一行**：先把当前行的编辑交出去
      // （判据是「上一个块 ≠ 这个块」；点自己那一行的块标不算离开）
      focusBlock: (id) => {
        this.commitLeavingLine(id)
        this.events.focusBlock?.(id)
      },
      // 打开落点（Shift／⌘）由装配层分流；事件层只把 place 交上去
      // ⚠️ 没接就不做事（不再退化成中心 zoom：那会让缺入口看起来像成功）
      openBlock: (id, place) => this.events.openBlock?.(id, place),
      /**
       * 面包屑普通点击 ＝ 这一栏就地展开上下文。也是一次编辑边界（与 focusBlock 同理）：
       * 点击 `contenteditable=false` 的按钮不会派发 `focusout`。
       */
      expandContext: this.onExpandContext
        ? (ancestorId, rowId) => {
            this.commitLeavingLine()
            this.onExpandContext?.(ancestorId, rowId)
          }
        : undefined,
      contextBack: this.onContextBack
        ? (rootId) => {
            this.commitLeavingLine()
            this.onContextBack?.(rootId)
          }
        : undefined,
      toggleCollapse: (id) => this.toggleCollapse(id),
      /**
       * **导轨点击直调行所属编辑器**：折叠表是每台编辑器一份的视图实例态。
       * 镜像岛与源同屏时是两个世界——若走「活动编辑器」（命令层的 `app.ed`），
       * 点镜像里的线就会折掉正文里源那一棵。命令
       * `core.editor/toggle-children-collapse` 仍留给面板／键位入口：那条路径
       * 本来就该作用于聚焦中的编辑器，语义不冲突。
       */
      toggleChildrenCollapse: (id) => this.toggleChildrenCollapse(id),
      toggleClosure: (id, propId) => this.toggleClosure(id, propId),
      toggleCheck: (id, propId) => this.toggleCheck(id, propId),
      pickGutterValue: (id, propId, anchor) => this.pickGutterValue(id, propId, anchor),
      blankArea: this.blankArea,
      clickEmptyArea: (y, x, place) => this.clickEmptyArea(y, x, place),
      onChange: () => this.emitChange('text'),
      onMounted: () => this.events.mounted?.(),
      flushPendingReload: () => this.reloader.flush(),
      armFlush: () => this.reloader.arm(),
      setPointerDown: (down) => this.setPointerDown(down),
    })
  }


  /* ------------------------------------------------------ 页面装载 */

  loadPage(doc: Doc, caret?: { blockId: string; off: number }): void {
    /**
     * **换视图不再是「索引可能过期」的时机**。
     *
     * 这里曾经无条件 `store.invalidateIndex()`，理由是「命令改完森林之后」会调它，
     * 而那条路径不发通知 —— 那是**编辑面还能直改活块**时的形状。
     * 现在所有写都经事务，事务出口已经按 op 修补过索引 ⇒ 换视图只换「装载单位」，
     * 不碰库的形状，索引没有任何理由作废。
     */
    /**
     * **换视图也是一个编辑边界**：上一行的编辑期在这里结束。
     *
     * 必须先 `commitEdit` 再清 `editBase`：反过来的话，「敲完字直接点面包屑/引用/块标」
     * 这条路会**丢掉这次边界**——正文已经进模型，修改时间却停在上一处。
     * `commitEdit` 幂等，编辑期本来就是空的时候它什么都不做。
     */
    const ending = this.editBase?.id
    if (ending) this.commitEdit(ending)
    /**
     * **同一批根的重装**（切视图、撤销把装载形状换回来）不是一次新的「聚焦」：
     * 用户在聚焦期间显式折过这一块的话，那一下要留着 —— 否则每次重画都把它弹开。
     * 判据用根集合，不用调用方传什么标志：`reloadPage` 与「打开同一页」在根上是同一件事，
     * 而后者本来就该按「重新装载」给上。
     */
    const sameRoots = this.doc.roots.length === doc.roots.length && this.doc.roots.every((b, i) => b.id === doc.roots[i]!.id)
    this.doc = doc
    /**
     * **换装载单位 ⇒ 实测高整表作废**：同一块 id 在另一份 `Doc` 里可能带着不同的
     * 头（面包屑／别名／来源说明）与不同的可用宽度，旧高度没有参考价值。
     * 只在根集合真的变了时清——`reloadPage` 换同一批根（比如刷新一次查询）时
     * 行还是那几行，清了会让占位白抖一次。
     */
    if (!sameRoots) this.render.invalidateHeights()
    // 换视图 ＝ 换了一份装载单位：上一行那个编辑期在这里结束，不能带到新页上
    this.editBase = null
    this.bsel.blockSel = null
    this.bsel.mouseSel = null
    this.container.classList.remove('blocksel-drag')
    this.viewRootIds = doc.roots.map((b) => b.id)
    this.syncFocusRoot(sameRoots)
    // 换了装载单位：上一形态的空天格子不再成立（复盘入口装载后会重新 setShells）
    this.shells = []
    this.applySecCols()
    // 行内内容住块上：换视图只换 roots，没有第二份锚点数组要替换。
    // **不清 undo**——undo 是 store 全局的，加载反链/查询视图不能清掉正文的撤销栈。
    this.sel = caret ? { aBlock: caret.blockId, aOff: caret.off, hBlock: caret.blockId, hOff: caret.off } : null
    this.renderAll()
    // 装载之后光标块不在这一屏里（刷新把结果重算了、落点不在新装载）⇒ 回源
    this.ensureCaretVisible()
    this.events.change?.('load')
  }

  /**
   * **追加一列 root**（日记流的下滚加载， P2）。
   *
   * 与 `loadPage` 的区别：不清 undo、不换「当前对象」、只把新的一段接在后面。
   * 为了省掉一次「重装整页」的代价，这里复用 `renderAll`，但把滚动位置与选区还原回去
   * （用户是滚到底触发加载的，不能被拽回顶部）。
   *
   * ⚠️ 入参应是**浅拷贝**（`rootsForMany`）——编辑器写 root 的正文，不能直接改森林里的块。
   * ⚠️ 超过 `FEED_MAX` 的加载由调用方挡住；这里不做上限判断（视图策略不塞进编辑器）。
   */
  appendRoots(blocks: readonly Block[]): void {
    if (blocks.length === 0) return
    /**
     * ⚠️ **组合期不追加**（见 `deferWhileComposing`）：这一句必须在改 `doc.roots` **之前**。
     *    放在 `renderAll` 里挡是不够的 —— 那时根已经 push 进去了，而渲染被推迟，
     *    于是「文档多了一天、屏幕还是旧的一天」，两个事实分叉。
     *    推迟到组合结束：调用方（下滚加载）会在下一次滚动时再试。
     */
    if (this.deferWhileComposing()) return
    /**
     * ⚠️ **换一份 `doc`**，不要原地 `roots.push`：可见行投影按 `doc`／`roots` 的身份
     * 缓存（结构修订号只覆盖经事务的结构变化，下滚加载没有事务）。原地追加会让
     * 「模型多了几天、屏幕还是旧的」——加载循环以为没装满，继续加到上限。
     */
    this.doc = { ...this.doc, roots: [...this.doc.roots, ...blocks] }
    this.viewRootIds.push(...blocks.map((b) => b.id))
    const scrollTop = this.blankArea.scrollTop
    const focused = this.container.contains(document.activeElement)
    const sel = this.sel
    this.renderAll()
    this.blankArea.scrollTop = scrollTop
    if (focused && sel) {
      this.sel = sel
      this.restoreSel()
      // `placeCaret` 可能把目标滚进视口；用户正在往下滚，保持他原来的位置
      this.blankArea.scrollTop = scrollTop
    }
    this.events.change?.('load')
  }

  /**
   * **捕获这一屏的位置**：视口锚（顶部那一块 ＋ 它相对滚动容器顶的偏移）＋ 模型选区。
   *
   * 为什么存块锚点而不是 `scrollTop`：上方插入／删除／图片加载都会让同一像素落到别处；
   * 块 id ＋ 相对偏移在内容变化后仍指回「我当时看到的那一块」。
   * 只读：不改模型、不重排、不写库。
   */
  captureViewState(): ViewState {
    return { scroll: this.captureScrollAnchor(), sel: this.sel ? { ...this.sel } : null }
  }

  private captureScrollAnchor(): ScrollAnchor | null {
    const area = this.blankArea
    const top = area.getBoundingClientRect().top
    for (const r of this.rows()) {
      const el = this.blockEl(r.block.id)
      if (!el) continue
      const rect = el.getBoundingClientRect()
      // 顶部那一块＝第一个「底边还在视口内」的行；它可能有一部分被滚出视口（delta 可为负）
      if (rect.bottom <= top) continue
      return { blockId: r.block.id, delta: rect.top - top, top: area.scrollTop }
    }
    return area.scrollTop > 0 ? { blockId: '', delta: 0, top: area.scrollTop } : null
  }

  /**
   * **恢复这一屏的位置**。调用方必须在目标 `loadPage`／`renderAll` 之后调用。
   *
   * @param focus 是否把焦点交回正文（左槽打开页＝false；历史/面包屑＝true）
   * @param fallbackCaret 没有保存选区时，把光标放到锚点块的块首（切 tab 用；
   *   只滚没点的视图不该在返回时凭空造光标，所以默认 false）
   */
  restoreViewState(state: ViewState, opts: { focus?: boolean; fallbackCaret?: boolean } = {}): void {
    const focus = opts.focus === true
    const sel = state.sel
    const known = sel ? flatten(this.doc).some((b) => b.id === sel.aBlock) : false
    if (sel && known) {
      this.sel = { ...sel }
      if (focus) {
        this.container.focus()
        this.restoreSel()
      }
    } else if (focus) {
      this.container.focus()
      if (opts.fallbackCaret) {
        const anchor = state.scroll?.blockId
        const target =
          anchor && flatten(this.doc).some((b) => b.id === anchor) ? anchor : (this.rows()[0]?.block.id ?? '')
        if (target) this.placeCaret(target, 0)
      }
    }
    this.restoreScrollAnchor(state.scroll)
    this.events.selChange?.()
  }

  private restoreScrollAnchor(s: ScrollAnchor | null): void {
    const area = this.blankArea
    if (!s) {
      // 保存的位置就是顶部（或新 tab 没有位置）⇒ 显式回到顶部；
      // 不写这一句会继承上一个视图的 scrollTop。
      area.scrollTop = 0
      return
    }
    if (s.blockId) {
      // 虚拟化：锚点可能在窗口外 ⇒ 先把窗口中心移过去，让它挂上
      if (this.virtualize && !this.blockEl(s.blockId)) this.applyWindow(s.blockId)
      const el = this.blockEl(s.blockId)
      if (el) {
        const top = area.getBoundingClientRect().top
        const cur = el.getBoundingClientRect().top - top
        area.scrollTop += cur - s.delta
        return
      }
    }
    // 锚点块被删／折叠／空屏：用捕获时的像素位置兜底，夹在合法范围内
    const max = Math.max(0, area.scrollHeight - area.clientHeight)
    area.scrollTop = Math.min(Math.max(0, s.top), max)
  }

  /** 复盘空天格子属于**这一份视图**，切 tab 时随 `Doc` 一起保存/恢复 */
  get shellCols(): readonly ShellCol[] {
    return this.shells
  }

  /**
   * 这一台编辑器上**命中高亮**的区间与目标，由画高亮的宿主设入（提及栏）。
   *
   * 内核不知道谁画了高亮，只回答「光标所在的这一格是不是命中」——⌥ 单击与块菜单
   * 的 `when` 都读这一份，判据不许有第二处。
   */
  private mentionHits: { to: string; spans: ReadonlyMap<string, readonly PlainSpan[]> } | null = null

  /** 换宿主/切栏时由宿主清掉（`null` ＝ 这台编辑器上没有命中） */
  setMentionHits(hits: { to: string; spans: ReadonlyMap<string, readonly PlainSpan[]> } | null): void {
    this.mentionHits = hits
  }

  /** 光标处落在命中区间里 ⇒ 目标与区间；否则 `null` */
  mentionHitAtCaret(): { to: string; start: number; end: number } | null {
    const hits = this.mentionHits
    const blockId = this.caretBlock()
    if (!hits || !blockId) return null
    const span = spanAt(hits.spans.get(blockId) ?? [], this.caretOffset())
    return span ? { to: hits.to, start: span.start, end: span.end } : null
  }

  /**
   * 这一块是不是**「一天」的最后一块**——删了，这一天就没有可写的行了。
   *
   * 判据必须与 `struct.keepWritableSlots` **同源**：那个不变量只在「这一天是**这一台**
   * 的装载根」时补块，所以这里也只认这一台的装载根。日期行是只读投影，一天没有子块就
   * 没有落点 ⇒ 写入漏斗会在**同一笔**事务里补一块空块，用户看到的是「删了又回来」。
   *
   * 谁用：删除入口拿它**先拒绝并说清原因**（而不是让写入漏斗静默换一块）；
   * 块菜单拿它把那行改成「写明原因、点不动」的一行（菜单里对准了就说，不等点完）。
   */
  daySoleBlock(id: string): boolean {
    const loc = locate(this.doc, id)
    if (!loc || !loc.parent || !isJournal(loc.parent)) return false
    if (!this.doc.roots.some((r) => r.id === loc.parent!.id)) return false
    const live = liveChildren(loc.parent)
    return live.length === 1 && live[0]!.id === id
  }

  ctxKeys(): CtxKeys {
    const s = this.sel
    const id = s?.aBlock ?? null
    /**
     * **光标块走行索引**（O(1)）：`ctxKeys` 在每一次按键派发里都会被读。
     * 行索引命中时就地拿 depth；未命中（折叠隐藏／缓存还没建）才退回 `locate`，
     * 保证「在不在这一屏」的口径不变。
     */
    const row = id ? this.rowOf(id) : undefined
    let b = row?.block
    let isDocRoot = row !== undefined && row.depth === 0
    if (!b && id) {
      const at = locate(this.doc, id)
      b = at?.block
      isDocRoot = at !== null && at.parent === null
    }
    /**
     * **森林根**不是「装载根」：一个嵌在天下面的页被单独打开时，`blockIsRoot` 也是 true，
     * 但它并不是森林顶层。`store.blocks` 是森林根数组，O(根数) 就能判。
     */
    const forestRoot = Boolean(id) && this.store.blocks.some((x) => x.id === id)
    /**
     * 块自己的判据只有一份（`core/identity/block-ctx.ts`）：身份/角色/能不能删/
     * 能不能提取/有没有视图/是不是任务。编辑器面与记录面读同一份。
     */
    const blockKeys = b
      ? blockMenuCtxOf(b, this.store.blocks, {
          isDocRoot,
          isForestRoot: forestRoot,
          fields: this.fieldTable(),
        })
      : {}
    return {
      ...blockKeys,
      focus: 'editor',
      editorTextFocus: document.activeElement === this.container || this.container.contains(document.activeElement),
      selectionEmpty: s ? s.aBlock === s.hBlock && s.aOff === s.hOff : true,
      selectionCount: s && !(s.aBlock === s.hBlock && s.aOff === s.hOff) ? (s.aBlock === s.hBlock ? 1 : 2) : 0,
      /** 选区能不能转引用（单块纯文本）：与命令执行时同一份判据 */
      selectionRef: this.selectionSpot() !== null,
      blockFocused: Boolean(id),
      blockMenuTarget: Boolean(id),
      blockId: id ?? '',
      blockIsRoot: isDocRoot,
      blockIsForestRoot: forestRoot,
      // 光标落在命中高亮里（块菜单「转为引用」的准入，与 ⌥ 单击同一份判据）
      mentionHit: this.mentionHitAtCaret() !== null,
      blockSelection: this.bsel.blockSel !== null,
      blockSelectionCount: this.bsel.blockSel?.ids.length ?? 0,
      blockHasChildren: Boolean(b && hasLiveChildren(b)),
      /**
       * 这一行有没有可折的东西：子块，或**身体**（查询块的结果视图／露面投影）。
       *
       * 只在「这个表面真的画身体」时把身体算进来 —— 查询结果列表里的命中行
       * 不是它自己的位置，折它没有可见效果。
       */
      blockFoldable: Boolean(b && (hasLiveChildren(b) || this.bodyFoldable(b))),
      blockCollapsed: Boolean(b && isFolded(this.doc, b.id)),
      blockClosed: b ? closureOf(b, this.fieldTable()) === 'closed' : false,
      marking: b ? this.marksAtSel().join('+') : '',
      inTrash: false,
      composing: this.probe.isComposing,
      isMac: /Mac|iPhone|iPad/.test(navigator.platform),
      undoDepth: this.undo.depth(),
      redoDepth: this.undo.redoDepth(),
      blockCount: this.docBlockCount,
      mountedCount: this.mounted.size,
      virtualize: this.virtualize,
    }
  }

  /** 诊断：composing 为真时命令零触发 */
  guard(name: string, ctx: Record<string, unknown>): boolean {
    if (ctx.composing) return false
    this.log.run(name)
    return true
  }
}
