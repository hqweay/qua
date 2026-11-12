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
  ancestorsByBlockId,
  depthOf,
  ensurePageInTx,
  flatten,
  hasChildrenViewBody,
  hasIdentity,
  hasQueryBody,
  hasList,
  isJournal,
  journalDate,
  todayISO,
  isPropDefBlock,
  isQueryBlock,
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
  foldStateOf,
  focusRootOf,
  isEmbedBlock,
  toggleChildrenCollapsed,
  toggleCollapsed,
  unfoldBlock,
  filterVisibleRows,
  pathTo,
  visibleRows,
  dropRefused,
  type RowVerdict,
  writeBlockContent,
  walkForest,
  gutterFieldsOf,
  gutterFieldsFor,
  belowFieldsFor,
  fieldTableOf,
  setValue,
  clearValue,
  declareOwnProp,
  todoOf,
  TASK_STATUS_PROP_ID,
  TASK_STATUS_TODO_ID,
  canWriteText,
  canDirectEditText,
  isOwnEdit,
  type Block,
  type CtxKeys,
  type Doc,
  type FieldTable,
  type GutterField,
  type BelowFields,
  type Sel,
  type UndoKind,
  type VisibleRow,
} from '../../core/index.ts'
import { resolveRef } from '../../core/relations/ref.ts'
import { inputSession } from './input-session.ts'
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
import { journalDateLabel, type OpenAction, type SecLayout, type ShellCol } from '../../core/index.ts'
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
// 任务状态定义块的事务内按需物化：落值之前保证定义在，面板才有行可画
import { ensureTaskStatusInTx } from '../../core/kb/ensure-task.ts'
// 用户可见文案一律走 t
import { t } from '../../core/infra/msg.ts'
import {
  ALLOWED_ROW_CHILDREN,
  EDIT_ISLAND_ATTR,
  LINE_H,
  fillBlockText,
  isReadonlyBlock,
  makeBlockEl,
  rowHasEmbedViewBody,
  rowHasInlineViewBody,
  visibleRowHeight,
} from './block-dom.ts'
import { assetViewOf, markAssetMissing } from '../asset-views.ts'
import { ReloadPolicy } from './reload-policy.ts'
import { spanAt, offsetAtPoint, paintHits, clearHits, type PlainSpan } from './hit-paint.ts'
import { AnnoHover, type AnnoHitSpan } from './anno-hover.ts'
import { blockIdOf, isTagChip, offsetIn, readRuns, textEndOff } from './dom-text.ts'
import { Drag } from "./drag.ts"
import { EmbedBodies } from "./embed-bodies.ts"
import { BlockSelection } from "./block-selection.ts"
import { ClipboardOps } from './clipboard-ops.ts'
import { TriggerOps } from './trigger-ops.ts'
import { InsertOps } from './insert-ops.ts'
import { StructOps } from './structure-ops.ts'
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

export interface ViewOpts {
  container: HTMLElement
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
  /**
   * **这一份装载里要不要展开露面块的身体**（镜像／投影）。
   *
   * 默认 `true`。露面块自己的身体由装配层画；那一层再遇到露面块时**只画占位**——
   * 这是「深度 1」的**构造性截断**：不是运行时用 visited 集合拦（那会让渲染结果
   * 依赖从哪开始遍历），而是「下一层根本没有展开这个动作」。
   */
  embedBodies?: boolean
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
  change?: (kind: 'text' | 'struct' | 'view' | 'load' | 'note') => void
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
   * **⌥-click 命中被备注的文本**：装配层据此打开侧栏备注栏、聚焦那一条备注。
   * ⌥ 语义与引用的「⌥ 看详情」同族——「把这一处自己的东西展开一层」。
   * ⚠️ 未接 ⇒ 什么都不做（缺入口看得见地缺）。
   */
  annoClick?: (hit: { blockId: string; annoId: string }) => void
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
   * **正文里查询块的身体**：由装配层用同一台 `ViewHost` 画（surface＝`inline`）。
   *
   * 与 `embedBody` 同一条分工（`view` 不 import `ui`）与同一条生命周期纪律
   * （返回卸载函数，换 DOM 前必须释放）。段根不走这里 —— 它仍由段尾宿主画，
   * 否则同一块会挂两台视图宿主。
   */
  viewBody?: (block: Block, into: HTMLElement) => (() => void) | void
  /**
   * **块下属性行**：值文本与「点值开属性面板」都在装配层。
   *
   * `view` 只负责「这一行有这一格」与高度；这里不返回卸载函数（行里没有订阅）。
   */
  propsLine?: (block: Block, data: BelowFields, into: HTMLElement) => void
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
  | { kind: 'ref'; to: string; label: string; flavor?: '#' }
  | { kind: 'newObj'; name: string; tagId: string }
  | { kind: 'newPage'; name: string }
  /** 新标签是**目标**；三种键各给一个落点（`inline` 行内 / `assign` 块标签 / `instance` 新实例） */
  | { kind: 'newTag'; name: string; action: 'inline' | 'assign' | 'instance' }
  | { kind: 'tag'; name: string }

/**
 * 一次「切换待办」要写哪一格（纯判据：单块与批量共用，避免两份翻值逻辑漂移）。
 *
 * `createCore`：这一行没有任何任务型字段 ⇒ 落核心任务状态并登记自有槽，
 * 与「第一次按 ⌘↵ ＝ 变成待办」的旧手感一致。
 * `clear`：完成型字段没有缺省值可回 ⇒ 清掉值但保留这一栏（行仍在「未填」）。
 */
interface TodoPlan {
  propId: string
  next?: unknown
  clear: boolean
  createCore: boolean
}

function applyTodoPlan(b: Block, plan: TodoPlan): void {
  if (plan.createCore) declareOwnProp(b, TASK_STATUS_PROP_ID)
  if (plan.clear) clearValue(b, plan.propId, { keepField: true })
  else setValue(b, plan.propId, plan.next)
}

/** 目标字段不存在 ⇒ 落核心任务状态（「第一次按 ⌘↵ ＝ 变成待办」） */
function todoPlanOfField(field: GutterField | undefined): TodoPlan {
  if (!field) return { propId: TASK_STATUS_PROP_ID, next: TASK_STATUS_TODO_ID, clear: false, createCore: true }
  // 任务状态：勾选 ⇄ 取消在**两个显式选项**之间翻，不再靠 default/清空
  if (field.use === 'status' && field.check) {
    const next = field.value === field.check.on ? field.check.off : field.check.on
    return { propId: field.propId, next, clear: false, createCore: false }
  }
  // 同一行上别的 checkbox 字段仍是布尔翻转
  return { propId: field.propId, next: field.value !== true, clear: false, createCore: false }
}

export class BlockEditor {
  container: HTMLElement
  doc: Doc
  /** 共享数据 store；`marks`/`atoms`/`undo` 都是它的投影（getter 转发） */
  store: BlockStore
  /** 本视图装载的 root id（reload 时按 id 从 store 重新取；不持有拷贝） */
  viewRootIds: string[] = []
  log = new CommandLog()
  probe: Probe = {
    isComposing: false,
    compositionSeq: [],
    lastKey: null,
    lastCommand: null,
    keyTrace: [],
    traced: true,
  }
  sel: Sel | null = null
  virtualize = false
  radius = 12
  mounted = new Set<string>()
  events: ViewEvents = {}

  /** 共享 undo 栈；depth/clear 与所有视图一致 */
  get undo(): UndoStack {
    return this.store.undoStack
  }

  /**
   * **可点导轨的祖先表**：`blockId → [祖先 id…]`（index = 层级 k）。
   *
   * ⚠️ 它对**全量可见行**算，不对 `applyWindow` 的 slice 算——否则窗口从中间开始时，
   *    第一行的祖先全丢（调研 点名的唯一易错处）。所以只在
   *    `renderAll` / `applyWindow` / `renderBlock` 入口重建，渲染单行时查表。
   */
  private ancestors = new Map<string, string[]>()

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
  /** 复盘的空天格子（纯视图兜底，不进库）；换页／换形态即清空 */
  private shells: readonly ShellCol[] = []
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
  private readonly onContextBack: ViewOpts['onContextBack']
  /** 行身体（露面／查询）的挂载与回收，都在协作对象里 */
  readonly embeds: EmbedBodies
  /** 这一面是不是「一屏就是这一块」的聚焦面（见 `ViewOpts.focusSurface`） */
  private readonly focusSurface: boolean
  /** 空块占位（见 `ViewOpts.emptyPlaceholder`；省略＝默认） */
  private readonly emptyPlaceholder: string | undefined
  /**
   * **字段读取表**（懒建）：判「这块是不是任务」要看标签声明（`todoOf`），
   * 逐块现建要扫两趟森林。任何一次模型写之后作废，下一次问到时重建一次。
   */
  private fieldTableCache: FieldTable | null = null
  /** 当前动作的撤销捕获袋：`write` 的每个事务都会把出口捕获并进来（一次动作可能拆成多笔） */
  private entryCap: UndoCapture | null = null
  /** 当前动作开始时的选区（撤销后回到这里） */
  private entrySel: Sel | null = null
  /**
   * 撤销条目的**嵌套深度**：复合命令可以用 `App.runGroup` 包住一组编辑器方法，
   * 而后者自己也会 `begin/finish`。只有最外层真正开袋／落条目；内层并入外层。
   */
  private entryDepth = 0
  /** store 订阅与事件绑定的卸载函数（`dispose` 用；视图被移除后不该继续收通知） */
  private readonly offStore: () => void
  private readonly unbind: () => void
  /**
   * 刚创建的那条备注（一次性信号，消费方读走即清）：派生栏据此在刷新后
   * 打开「备注」栏并聚焦新行。命令层不碰 DOM，落焦点是这个瞬态的用途。
   */
  lastCreatedNote: { noteId: string; hostIds: readonly string[] } | null = null
  /** 本实例的备注标记画笔 key（每台编辑器一份，互不覆盖；dispose 时摘掉） */
  private readonly annoKey = `anno-mark-${Math.random().toString(36).slice(2)}`
  private annoPaintQueued = false
  /**
   * 活跃备注区间（与画层**同源**：paintAnnoMarks 每次重画时顺手缓存）。
   * hover 命中判定读它——判定与画亮的是同一处，两份口径必然漂。
   */
  private annoSpans: ReadonlyMap<string, readonly AnnoHitSpan[]> = new Map()
  private readonly annoHover: AnnoHover

  constructor(o: ViewOpts) {
    this.container = o.container
    this.blankArea = o.blankArea ?? o.container
    this.allowBlankCreate = o.allowBlankCreate !== false
    this.allowRootRemove = o.allowRootRemove !== false
    this.rootRemoveFill = o.rootRemoveFill !== false
    this.structuralScope = o.structuralScope ?? 'document'
    // 写入口顺手作废那张派生表：标签声明／定义 kind 变了，下一次 `todoOf` 要重算
    this.write = (fn, source, opts) => {
      this.fieldTableCache = null
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
    this.embeds = new EmbedBodies(this, o.embedBodies !== false)
    this.focusSurface = o.focusSurface === true
    this.emptyPlaceholder = o.emptyPlaceholder
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
    this.unbind = this.bind()
    this.annoHover = new AnnoHover({
      container: this.container,
      spans: () => this.annoSpans,
      quiet: () => this.deferWhileComposing() || this.reloader.pointerDownNow(),
      textOf: (blockId, annoId) => this.annoNoteText(blockId, annoId),
    })
    this.renderAll()
  }

  /** 从文档里摘掉这个视图：退订 store、卸掉事件（否则游离容器还会继续被重画） */
  dispose(): void {
    this.embeds.disposeAll()
    this.offStore()
    this.unbind()
    this.reloader.dispose()
    this.annoHover.dispose()
    this.annoSpans = new Map()
    clearHits(this.annoKey)
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
   */
  beginUndoEntry(): void {
    this.entryDepth++
    // 内层并入外层：只有最外层能重置捕获袋（否则复合命令会把外层的 before 冲掉）
    if (this.entryDepth > 1) return
    this.entryCap = null
    this.entrySel = this.sel
  }

  /**
   * **收尾一个撤销条目**：把这一动作里所有事务的捕获交给撤销栈。
   *
   * `capture === null`（这一段没有开过事务）⇒ 不新建条目；合并窗口由栈判。
   *
   * 配对规则：有 `begin` 就按深度退；**没有配对的 `finish`**（历史上有些行内编辑
   * 在调用方已经开袋的情况下只调 finish）按老行为直接落条目，不静默吞掉。
   */
  finishUndoEntry(kind: UndoKind, at = Date.now()): void {
    if (this.entryDepth > 0) {
      this.entryDepth--
      if (this.entryDepth > 0) return
    }
    this.undo.record(this.entryCap, this.entrySel, kind, at)
    this.entryCap = null
  }

  /**
   * 字段读取表（懒建，写后作废）。
   *
   * 判「这块是不是任务」要看**标签声明**（`#任务` 用 `declareField` 把这一栏给到成员），
   * 而逐块现建要扫两趟森林 ⇒ 一张表摊到整屏／整条命令上。
   */
  // 协作对象 `InsertOps` 插待办时也要判「是不是已经是任务」；可见性为它放宽
  fieldTable(): FieldTable {
    this.fieldTableCache ??= fieldTableOf(this.store.blocks)
    return this.fieldTableCache
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
    this.renderAllPreservingAnchor(anchor)
    if (this.ownFocus() && this.sel) this.restoreSel()
    this.scheduleAnnoPaint()
    /**
     * 可见性兜底：外部结构变化把光标块移出了本视图 ⇒ 回源。只对**正在这台编辑器里
     * 输入**的人兜底——别人留档的旧光标不该拖着屏幕跳。
     */
    this.ensureCaretVisible(undefined, true)
  }

  /**
   * **输入锚点所在的行**（本编辑器名下的那颗 `.blk`），连同它旧的父块。
   *
   * 锚点来自输入会话（浮层/里层编辑器的锚点都可能嵌在本容器里）；从锚点向上找
   * 最近的行时，**只认「岛根与本编辑器相同」的那一颗**：露面行的身体是另一台编辑器
   * （另一个岛），里层的源行不属于本编辑器——保留它不会保住外层的宿主行。
   * 锚点解析不出行（锚点就是容器自己等）⇒ 退回光标所在的行。
   */
  private resolveAnchorRow(): { id: string; parentId: string | null } | null {
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
    const loc = locate(this.doc, id)
    if (!loc) return null
    return { id, parentId: loc.parent?.id ?? null }
  }

  /**
   * **整页重画，但把输入锚点的那一行原样换回去。**
   *
   * 为什么不增量挂新行：结构变化是低频的，整页重画 + 换回一行足够便宜；增量挂载
   * 要重新回答「插在哪、兄弟位怎么挪」这整组问题——性能真不够时再换，入口不变。
   *
   * 三种「不保留」（旧行的样子已经过期，硬保留只会把界面和模型继续分叉）：
   *   · 锚点块不在新装载里（被删/移出结果集）⇒ 不保留；输入 owner 是本编辑器的话回源；
   *   · 锚点块的 **parent 变了**（这次变化把它自己搬走了）⇒ 旧行的 `data-depth`/导轨是错的；
   *   · 旧行不在 DOM 里（窗口化把它收走了等）⇒ 没有可保留的东西。
   */
  private renderAllPreservingAnchor(anchor: { id: string; parentId: string | null } | null): void {
    if (!anchor) {
      this.renderAll()
      return
    }
    const loc = locate(this.doc, anchor.id)
    if (!loc) {
      if (inputSession.editor === this) this.events.focusSource?.(anchor.id)
      this.renderAll()
      return
    }
    if ((loc.parent?.id ?? null) !== anchor.parentId) {
      this.renderAll()
      return
    }
    const oldEl = this.blockEl(anchor.id)
    if (!oldEl) {
      this.renderAll()
      return
    }
    // 重画会把旧行从树上摘下来一瞬（`textContent = ''`）：焦点若在旧行里（里层编辑岛
    // 正在输入），那一刻就被Chrome交给 body，插回去也不会自己回来 —— 正在输入的表面
    // 不能因为别人的一次结构编辑丢焦点 ⇒ 记下来，插回后原样请回去。
    const active = document.activeElement
    const focusInside = active !== null && oldEl.contains(active)
    // 身体（里层编辑器/表格）挂在行上：重画期间既不能摘、也不能先挂一份新的
    this.embeds.pin(anchor.id)
    try {
      this.renderAll()
      const fresh = this.blockEl(anchor.id)
      if (fresh && fresh !== oldEl) {
        fresh.replaceWith(oldEl)
        this.mounted.add(anchor.id)
        if (focusInside) (active as HTMLElement).focus({ preventScroll: true })
      }
    } finally {
      this.embeds.unpin()
    }
    // 旧行是原样换回的：光标标记与块选区漆层按换回后的 DOM 重打一遍
    this.repaintOverlays()
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
   */
  private deferWhileComposing(): boolean {
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
   */
  blockEl(id: string): HTMLElement | null {
    const all = this.container.querySelectorAll<HTMLElement>(`.blk[data-block-id="${id}"]`)
    if (all.length <= 1) return all[0] ?? null
    const own = this.container.closest<HTMLElement>(`[${EDIT_ISLAND_ATTR}]`)
    for (const el of all) {
      if (el.closest(`[${EDIT_ISLAND_ATTR}]`) === own) return el
    }
    return all[0] ?? null
  }

  /**
   * 把某一行滚进视口并闪一下。
   *
   * 用途：上下文展开后命中行可能在屏幕外（展开了一整页祖先）——不滚过去，
   * 用户只看到一堆无关兄弟块，会以为「点了跳到别处」。
   * ⚠️ 虚拟化时目标可能不在窗口里：先把窗口中心移到它，再取元素。
   */
  reveal(id: string): void {
    if (this.virtualize && !this.blockEl(id)) this.applyWindow(id)
    const el = this.blockEl(id)
    if (!el) return
    el.scrollIntoView({ block: 'center' })
    el.dataset.flash = '1'
    window.setTimeout(() => {
      if (el.isConnected) delete el.dataset.flash
    }, 900)
  }

  /**
   * 剪切确认：被抓进剪贴板的行**抖一下**。⌘X 不改文档（移动发生在粘贴那一刻），
   * 屏幕上什么都没变——没有这一下，用户不知道按没按上。
   * 与 `reveal` 的 flash 同一挂法：data 属性 ＋ CSS keyframes，reduced-motion 由 CSS 关
   * （那里的可达性反馈由门面退回提示，不在这层造静态替身）。
   * 只对画得上的一行抖：虚拟化时看不见的块没有「看见的确认」可给。
   */
  pulseBlocks(ids: readonly string[]): void {
    for (const id of ids) {
      const el = this.blockEl(id)
      if (!el) continue
      el.dataset.pulse = '1'
      window.setTimeout(() => {
        if (el.isConnected) delete el.dataset.pulse
      }, 400)
    }
  }

  txEl(id: string): HTMLElement | null {
    return this.blockEl(id)?.querySelector<HTMLElement>('.tx') ?? null
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

  /** 全部可见行（**不筛**）：筛选的候选与计数读它（筛过的那份会让候选自己消失） */
  rowsAll(): VisibleRow[] {
    return this.rawRows()
  }

  private rawRows(): VisibleRow[] {
    return visibleRows(this.doc, {
      // 只有这一屏真会画身体的编辑器才让子块行让位（没有 viewBody 回调的
      // 里层编辑器——挂载区／镜像／查询结果——子块仍照常画）
      ...(this.events.viewBody ? { bodyHosts: hasChildrenViewBody } : {}),
    }).filter((r) => !r.hidden)
  }

  /** 可见行（**折叠的子树在这里被排除**；有筛选时只留命中行与它们的上下文） */
  rows(): VisibleRow[] {
    const all = this.rawRows()
    const filter = this.rowFilter?.()
    if (!filter) return all
    /**
     * **正在编辑的那一块永远算命中**（连同它的祖先链）。
     * 否则刚敲出来的空块（不带任何被筛的页/标签）会在下一帧凭空消失，
     * 而光标还在里面——编辑面不能被它自己的镜头藏掉。
     */
    const force = new Set<string>()
    const caret = this.caretBlock()
    if (caret !== null) {
      const chain = pathTo(this.doc, caret)
      if (chain) for (const b of chain) force.add(b.id)
      else force.add(caret)
    }
    return filterVisibleRows(all, (r, path) => filter(r.block, path), force)
  }

  /**
   * 重建祖先表（**全量可见行**）。
   * 每个改结构的入口都要调它——导轨画的是「此刻的树」，不是「上次渲染的树」。
   */
  private rebuildAncestors(): void {
    this.ancestors = ancestorsByBlockId(this.rows())
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

  /** 造一列空壳：只读日期头 ＋ 一行「点一下开始写」的落笔位（与真实日期行同一个视觉形状） */
  private makeShellSec(col: ShellCol): HTMLElement {
    const sec = document.createElement('div')
    sec.className = 'sec'
    sec.dataset.shell = col.date
    const head = document.createElement('div')
    head.className = 'blk'
    head.dataset.depth = '0'
    head.dataset.role = 'journal'
    const headTx = document.createElement('span')
    headTx.className = 'tx'
    headTx.contentEditable = 'false'
    headTx.dataset.readonly = '1'
    headTx.dataset.ph = journalDateLabel(col.date)
    headTx.dataset.phReadonly = '1'
    head.appendChild(headTx)
    const write = document.createElement('div')
    write.className = 'blk shell-row'
    write.dataset.depth = '1'
    write.contentEditable = 'false'
    const writeTx = document.createElement('span')
    writeTx.className = 'tx'
    writeTx.dataset.ph = t('ui.feed.shellHint')
    write.appendChild(writeTx)
    sec.append(head, write)
    return sec
  }

  renderAll(): void {
    /**
     * ⚠️ **组合期不换 DOM**（见 `deferWhileComposing`）。这条是全量重排的唯一入口，
     *    守卫放在这里才覆盖得住 `loadPage`／`reloadFromStore`／各命令路径。
     */
    if (this.deferWhileComposing()) return
    // 别的视图写进来（本实例的写入口已作废过）；重排之后重算一张表
    this.fieldTableCache = null
    this.embeds.disposeAll()
    this.container.textContent = ''
    this.mounted.clear()
    this.rebuildAncestors()
    // DOM 重建 ⇒ `data-caret` 全丢，缓存也失效（否则 `markCaret` 会因为「id 没变」而跳过）
    this.caretMarks = ''
    // 虚拟化只属单列流：row/grid 的段要完整的盒子才能当列用，窗口切片会把列切残
    if (this.virtualize && this._layout === 'column') {
      this.applyWindow()
      return
    }
    this.renderRows(this.rows())
    this.markCaret()
    this.bsel.paintBlockSel()
    this.events.mounted?.()
    this.paintAnnoMarks()
  }

  /* ----------------------------------------------- 备注区间的常显标记 */

  /**
   * 被备注的区间在宿主正文里常显一层淡底（「这里有备注」的背景事实）。
   * 画的是**有活备注指向**的 anno：孤儿锚（备注删了）不画——读侧判活，
   * 删除路径零钩子，撤销也干净（删备注只删块，锚原样留着等备注回来）。
   *
   * 画笔与命中高亮同一机制（Custom Highlight，纯渲染层——往 `.tx` 里插标记
   * 会被 `readRuns` 当成内容，还会挪光标），底色淡一档（`--ui-anno-bg`）。
   */
  private paintAnnoMarks(): void {
    const blocks = new Map<string, AnnoHitSpan[]>()
    const idx = this.store.index
    walkForest(this.doc.roots, (b) => {
      if (!b.annos || b.annos.length === 0) return
      const live = new Set<string>()
      for (const e of idx.relations.get(b.id) ?? []) {
        if (e.kind === 'annotates' && e.propId) live.add(e.propId)
      }
      if (live.size === 0) return
      const spans = b.annos
        .filter((a) => live.has(a.id))
        .map((a) => ({ annoId: a.id, ...a.range }))
      if (spans.length > 0) blocks.set(b.id, spans)
    })
    // 画层与命中判定同一份区间（hover tip 读它）——同帧同源，不会漂
    this.annoSpans = blocks
    paintHits(this.container, blocks, this.annoKey, '--ui-anno-bg')
  }

  /** 被备注区间的 tip 文本：备注块的正文投影（多条换行平铺） */
  private annoNoteText(blockId: string, annoId: string): string {
    const notes: string[] = []
    for (const e of this.store.index.relations.get(blockId) ?? []) {
      if (e.kind !== 'annotates' || e.propId !== annoId) continue
      const note = this.store.find(e.from)
      if (note) notes.push(plainText(note.content))
    }
    return notes.join('\n')
  }

  /** ⌥-click 命中判定：坐标 → 被备注的（块，锚）。与 hover 同一份缓存，与画层同源 */
  private annoHitAt(x: number, y: number): { blockId: string; annoId: string } | null {
    if (this.annoSpans.size === 0) return null
    const el = document.elementFromPoint(x, y)
    const blk = el?.closest<HTMLElement>('.blk')
    const blockId = blk?.dataset?.['blockId']
    if (!blk || !blockId || !this.container.contains(blk)) return null
    const tx = blk.querySelector<HTMLElement>(':scope > .tx')
    if (!tx) return null
    const offset = offsetAtPoint(tx, x, y)
    if (offset === null) return null
    const span = spanAt(this.annoSpans.get(blockId) ?? [], offset)
    return span ? { blockId, annoId: span.annoId } : null
  }

  /** 重画排进下一帧（合并同一帧里的多笔写）；组合期不画（DOM 还没落定） */
  private scheduleAnnoPaint(): void {
    if (this.annoPaintQueued || typeof requestAnimationFrame === 'undefined') return
    this.annoPaintQueued = true
    requestAnimationFrame(() => {
      this.annoPaintQueued = false
      if (this.deferWhileComposing()) return
      this.paintAnnoMarks()
    })
  }

  /**
   * 挂一列可见行。
   *
   * gutter 字段在**循环外**按整批算一次：每行各自扫库会让整屏渲染退化成 O(n²)，
   * 而这种退化不报错、只是越用越慢。
   *
   * **段物质化**：连续的行按段包进 `.sec[data-sec]`——depth 0 的行开新段。
   * `.sec` 只表达段边界，不表达层级（行在段内仍是扁平的 ＋ `data-depth`）；
   * 缺省布局下它是 `display: contents`（零几何影响），`row`/`grid` 才由 CSS 给它盒子。
   * 例外：单列流的日记段要一个盒子承载段间留白（样式层决定，装配层不区分）。
   * ⚠️ 虚拟化的窗口切片可能从段中间开始：那一段的 `.sec` 没有段根行，
   *    `data-sec` 落空串——分割线与「点空白归段」的判据都依赖段根在场。
   *
   * **段尾空槽**（`.sec-mount`）：每段末尾留一个**空的** div，装配层把「块底的挂载区」
   * 挂进去。为什么空着而不是由这里建实例：渲染是纯的，实例的生命周期要有人管
   * （哪一段展开、哪个 tab 激活），那是装配层的知识。`view/` 只交代「这儿有个位置」。
   * ⚠️ 只给 **`data-sec` 非空的段**发槽：窗口切片从段中间开始时那段没有段根行，
   *    给它发槽就等于把挂载区挂到一个装配层认不出的段上（`data-sec` 是空串）。
   * ⚠️ 最后一段只有在**它完整**时才发槽（`tailComplete`）：虚拟化窗口的下边界可能切在
   *    段中间，那时这一段还在往下长，槽会被后一行挤到中间去。
   */
  /**
   * 行的**模型父块**（`_childProps` 显示声明的来源；父不在装载窗口 ⇒ null）。
   * 渲染是按树扁平成可见行的（`VisibleRow` 没有 parent 指针），但 doc 里有——
   * 「显示跟数据走」就靠这一步把模型父链接回来（嵌入岛装的是同一棵子树 ⇒ 自动跟随）。
   */
  private parentOfRow(id: string): Block | null {
    return locate(this.doc, id)?.parent ?? null
  }

  private renderRows(rows: readonly VisibleRow[], tailComplete = true): void {
    const blocks = rows.map((r) => r.block)
    const gutters = gutterFieldsFor(blocks, this.store.blocks)
    const below = belowFieldsFor(blocks, this.store.blocks, (id) => this.parentOfRow(id), this.store.index.blocks)
    let sec: HTMLElement | null = null
    /** 给上一段收尾：追加那个空槽（只给有段根的行段） */
    const closeSec = (): void => {
      if (!sec || sec.dataset.sec === '' || sec.dataset.sec === undefined) return
      const slot = document.createElement('div')
      slot.className = 'sec-mount'
      // 它不是「可点空白建块」的地方：挂载区自己有点击语义，落到建块上就是静默多一个空块
      slot.dataset.noEmptyCreate = '1'
      /**
       * **编辑岛标记**（`.sec-mount` 与露面行的身体共用这一格）。
       *
       * 为什么需要一个标记而不是按类名判：本视图里有几处要回答「焦点现在是不是
       * **在别人的地盘**上」（`ownFocus`／`focusInMount`／`nestedEditorActive`）。
       * 按 `.sec-mount` 这个**类名**判，就等于「只有挂载区算别人的地盘」——
       * 露面行的身体（镜像／投影）同样嵌在本视图里、同样有自己的焦点，
       * 类名一换，那三处全部判错，而且是静默的：
       *   · `ownFocus` 判成「我在编辑」⇒ `restoreSel()` 把光标从里层抢回来；
       *   · `focusInMount` 判成「没有里层」⇒ 每次 store 变化都全量重排 ⇒
       *     里层正在打字的节点被换掉（`click` 不派发、光标跳走）。
       * ⇒ 判据是**标记**（「这一棵子树是另一个编辑宿主」），不是它属于哪一种容器。
       */
      slot.dataset.editIsland = '1'
      /**
       * ⚠️ **必须断开可编辑链**：`.sec-mount` 落在 `#editor`（一个 contenteditable 容器）里面，
       * 而挂载区里是**另一个编辑器实例**。可编辑元素嵌在可编辑元素里时，Chrome 把焦点交给
       * **外层的编辑宿主**（实测：对里层 `focus()` 之后 `activeElement` 仍是 `#editor`，
       * 打出来的字一个都不进模型）⇒ 里层编辑器根本收不到键盘。
       * ⇒ 槽本身不可编辑，里层那个 `contenteditable=true` 才成为独立的编辑岛。
       */
      slot.contentEditable = 'false'
      sec.appendChild(slot)
    }
    for (const r of rows) {
      if (r.depth === 0 || sec === null) {
        // 新的一段之前，先摆按列序应出现在这里的空天格子（复盘兜底；column 下 shells 恒空）
        if (r.depth === 0) {
          closeSec()
          for (const col of this.shells) if (col.beforeRootId === r.block.id) this.container.appendChild(this.makeShellSec(col))
        }
        sec = document.createElement('div')
        sec.className = 'sec'
        sec.dataset.sec = r.depth === 0 ? r.block.id : ''
        this.container.appendChild(sec)
      }
      sec.appendChild(this.makeBlockEl(r, gutters.get(r.block.id), below.get(r.block.id)))
    }
    if (tailComplete) closeSec()
    // 比所有已装段都更早的空天格子：追加在最后
    if (this.layout !== 'column') {
      for (const col of this.shells) if (col.beforeRootId === null) this.container.appendChild(this.makeShellSec(col))
    }
  }

  /** 所有模型变化统一出口：通知其他视图（共享 store），再通知装配层持久化/刷新 */
  /**
   * @param ids 这次**动过哪些块**（可选）。查询视图靠它判断「结果里的块变没变」，
   *            而不是靠「store 被碰过几次」——后者会把刷新顺带的重渲染也算成过期。
   *            ⚠️ 只给拿得到精确 id 的路径传（文本编辑、todo、删除）；结构操作先不传，
   *            订阅方必须容忍 `ids === undefined`（那就是「不知道，按整体处理」）。
   */
  /** 协作对象（块选区删块）也要广播同一件事；对外仍是编辑器的口径 */
  emitChange(kind: 'text' | 'struct' | 'view' | 'load' | 'note', ids?: readonly string[]): void {
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

  renderBlock(id: string): void {
    const loc = locate(this.doc, id)
    const el = this.blockEl(id)
    if (!loc || !el) return
    /**
     * ⚠️ **组合期不重画这一行**（见 `deferWhileComposing`）。这一条比 `renderAll` 更容易踩到：
     *    属性写入（`writeProps` → `repaintBlock`）、改名传播（`renderRefSources`）、
     *    以及 `syncFromDom` 的收尾都会调到它，而它们**都不看组合期**。
     *    它换的是 `.tx` 所在的那一行 ⇒ 输入法正持有的文本节点被换掉，预编辑串当场落成正文。
     */
    if (this.deferWhileComposing()) return
    const row = this.rows().find((r) => r.block.id === id) ?? {
      block: loc.block,
      depth: depthOf(this.doc, id),
      hidden: false,
      hasChildren: hasLiveChildren(loc.block),
    }
    this.embeds.disposeRow(id)
    el.replaceWith(
      this.makeBlockEl(
        row,
        gutterFieldsOf(row.block, this.store.blocks),
        belowFieldsFor([row.block], this.store.blocks, (id) => this.parentOfRow(id), this.store.index.blocks).get(
          row.block.id,
        ),
      ),
    )
    this.repaintOverlays()
  }

  /**
   * @param gutter 这一行的 gutter 字段，**由调用方算好**：`block-dom` 是渲染层，没有森林；
   *               让它自己去扫一遍全库就等于「每画一行扫一次」。批量路径只扫一次库。
   */
  private makeBlockEl(
    r: VisibleRow,
    gutter: readonly GutterField[] | undefined,
    below: BelowFields | undefined,
  ): HTMLElement {
    // 引用解析走**共享 store** 的森林：引用目标可能在当前视图之外（另一页／另一天），
    // 只有整片森林能回答「它还在不在、现在叫什么」。
    const find = (id: string) => this.store.find(id)
    const el = makeBlockEl(
      r,
      /**
       * **资产此刻的样子**：默认直接问 `view/asset-views.ts`（它是进程级的一份缓存，
       * 不是某个视图的状态）。事件表只留一个**覆盖**入口 —— 测试/独立实例可以把
       * 它换成受控答案。
       *
       * ⚠️ 为什么不能只靠 `events.assetView`：编辑器**在构造时**就渲染首帧，
       *    而 `events` 是构造之后才赋上去的。只认事件表 ⇒ 首帧一律画成
       *    `unavailable`，之后没有任何人再重画（那一行已经"画完了"）——
       *    表现为「重开之后图全是库不可用」，而库里明明有字节。
       */
      (tx) => fillBlockText(tx, r.block, find, this.events.assetView ?? assetViewOf, this.events.onAssetError ?? markAssetMissing),
      {
        single: flatten(this.doc).length === 1,
        ancestors: this.ancestors.get(r.block.id) ?? [],
        folded: foldStateOf(this.doc),
        gutter,
        find,
        // 只有装载根会带上下文：子行的位置已经由缩进表达
        context: r.depth === 0 ? this.doc.contexts?.get(r.block.id) : undefined,
        // 来源说明与面包屑同一格：都在说明「这一行为什么在这一屏里」
        note: r.depth === 0 ? this.doc.rootNotes?.get(r.block.id) : undefined,
        // 展开出来的根才有「收起上下文」；没接回调就不画一个点了没反应的按钮
        contextBack: Boolean(this.onContextBack) && r.depth === 0 && (this.doc.expandedRoots?.has(r.block.id) ?? false),
        // 露面块的身体：这一层只认「有没有展开」；画什么由装配层给（见 `ViewEvents.embedBody`）
        embedBody: (b, into) => this.embeds.attach(b, into),
        ...(this.emptyPlaceholder !== undefined ? { placeholder: this.emptyPlaceholder } : {}),
        /**
         * **正文里的查询体**：只有装配层接了画法、且这一份装载允许展开时才给。
         * 「哪一行画」由 `block-dom` 的 `rowHasInlineViewBody` 判（按源分派，
         * 段根同此——聚焦后身体仍贴着自己那一行，不再让位段尾宿主）。
         */
        ...(this.events.viewBody
          ? {
              viewBody: (b: Block, into: HTMLElement) => this.embeds.attachViewBody(b, into),
            }
          : {}),
        // 块下属性行：值文本与点击都在装配层；`view` 只给位置与定高
        ...(below && this.events.propsLine
          ? {
              below,
              propsLine: (b: Block, data: BelowFields, into: HTMLElement) => this.events.propsLine!(b, data, into),
            }
          : {}),
      },
    )
    this.mounted.add(r.block.id)
    return el
  }

  /* ------------------------------------------------------- DOM → 文本 */

  offsetIn(root: HTMLElement, node: Node, off: number): number {
    return offsetIn(root, node, off)
  }

  /** 读回块内容（DOM → run 序列；原子按 `data-atom-id` 原样带回）。委托 `view/dom-text` */
  readRunsOf(id: string): InlineRun[] {
    const tx = this.txEl(id)
    const b = locate(this.doc, id)?.block
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
         * 渲染层放进去的节点会带状态类：`block-dom` 里 `if (todo === 'done') tx.classList.add('done')`
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

  /**
   * 给**光标所在行**打 `data-caret="1"`。
   *
   * 为什么需要它：空块的占位符是 `::before` 生成内容（`data-ph`），浏览器把光标放在
   * 它**之后** ⇒ 用户看到「空块|」——像是「空块」两字是正文（2026-10-20 用户实机指出）。
   * 有了这个标记，CSS 就能在**这一行有光标时**把占位符藏掉（`.blk[data-caret] .tx[data-ph]::before`），
   * 而不是去猜「编辑器有没有焦点」（整片容器共用一个焦点，猜不出来）。
   *
   * ⚠️ 只在**块 id 变了**时才动 DOM：`selectionchange` 在打字时很密，逐个块删属性会掉帧。
   */
  private caretMarks = ''

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

  /** 行元素被换过 ⇒ `data-caret` 跟着旧元素丢了：缓存作废，光标标记与块选区漆层重打 */
  private repaintOverlays(): void {
    this.caretMarks = ''
    this.markCaret()
    this.bsel.paintBlockSel()
  }

  /** 供协作对象（块选区）在收掉模型选区时同步重打光标标记 */
  markCaret(): void {
    const id = this.sel?.aBlock ?? ''
    if (id === this.caretMarks) return
    this.caretMarks = id
    for (const el of Array.from(this.container.querySelectorAll<HTMLElement>('.blk'))) {
      if (el.dataset.blockId === id) el.dataset.caret = '1'
      else delete el.dataset.caret
    }
  }

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
        const len = (n.textContent ?? '').length
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
      // 同上：`placeRange` 也会改写 `this.sel` ⇒ 先摆 DOM，再写回模型
      this.placeRange({ ...s, aBlock: s.hBlock, aOff: s.hOff })
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
    fn()
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
    // 快照取在**建标签**之前：撤销这次挂标签时，顺手建出的标签块也该一起回滚
    this.beginUndoEntry()
    // 建标签块（可能）＋写归属是同一笔：拆开就会留下「只有标签、没有归属」的半批。
    // 名字为空／已挂 ⇒ 事务里什么都不写（零 op）
    const ok = this.write((tx) => {
      const tag = ensureTagInTx(tagLookupOf(this.store.blocks), name, tx)
      if (!tag || hasTag(b, tag.id)) return false
      tx.setTags(blockId, [...tagIdsOf(b), tag.id])
      return true
    })
    if (!ok) return false
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
    const loc = locate(this.doc, id)
    if (!loc) return
    // 这一块的第一笔输入 ＝ 一次编辑期的开始（此刻模型里还是改名前那个值）
    if (this.editBase?.id !== id) this.beginEdit(loc.block)
    const next = this.readRunsOf(id)
    if (sameRuns(next, loc.block.content)) return
    // 这一块真的落过字 ⇒ 到边界时记一次「块被改过」（时刻只在边界写，见 `stampEdited`）
    this.edited.add(id)
    const prevLen = plainLen(loc.block.content)
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
      if (caret !== null) this.placeCaret(id, Math.min(caret, plainLen(loc.block.content)))
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
   * 两条来源，因为两种归属的存法不同：
   *   · 引用 —— 在原子表里（`edgeSourceIds`）；
   *   · 标签 —— 在**块自己的 `_tags`** 里：改名后 chip 上显示的 `#旧名` 同样是过期的字，
   *     所以带这个标签的块也要重画（这是一次本视图内的扫描，不是全库索引）。
   *
   * ⚠️ 只重画**本视图内**的块：别的页里也有指向它的引用，但那些 DOM 不在 `doc` 里，
   *    由它们自己所在的视图在装载/刷新时解析（共享 store 只保证数据一致，不替别人画 DOM）。
   */
  renderRefSources(id: string): void {
    for (const b of flatten(this.doc)) {
      if (b.id === id) continue
      // 引用它的 run（含行内标签露面）⇒ 显示名现算；带着这个标签 ⇒ chip 上的字过期
      if (refRunsOf(b.content).some((r) => r.to === id) || tagIdsOf(b).includes(id)) {
        if (this.blockEl(b.id)) this.renderBlock(b.id)
      }
    }
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
     */
    if (bodyOnly) {
      this.paintFold(id)
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
    const body = el.querySelector<HTMLElement>(':scope > .blk-view-body, :scope > .blk-embed-body')
    if (body) {
      if (folded) body.dataset.folded = '1'
      else delete body.dataset.folded
    }
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
   */
  private bodyFoldable(b: Block): boolean {
    return (
      (Boolean(this.events.viewBody) && (hasQueryBody(b) || hasChildrenViewBody(b))) ||
      (Boolean(this.events.embedBody) && rowHasEmbedViewBody(b, (id) => this.store.find(id)))
    )
  }

  /**
   * **gutter 上 select 类图标的取值菜单**：把锚点交给装配层开选项菜单。
   * 入口有三条：左键点普通 select、⌥+点状态标记、右键点任何 select 类图标
   * （状态标记的普通左键不走这里——那一下翻完成，见 `toggleTodo`）。
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
   * **普通勾选框**（`_check` 无 `_use`）：只翻 on/off，不碰 `todoOf`/划线。
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

  toggleTodo(id: string, onlyPropId?: string): void {
    const loc = locate(this.doc, id)
    if (!loc) return
    const fields = gutterFieldsOf(loc.block, this.store.blocks)
    /**
     * 目标字段：点 gutter 上哪一枚就传哪个 propId（多个 checkbox 不串台）；
     * 命令／快捷键不带目标 ⇒ 库里唯一的 status 字段，其次 checkbox。
     */
    let field: GutterField | undefined
    if (onlyPropId !== undefined) {
      field = fields.find((f) => f.propId === onlyPropId)
      if (!field) return
    } else {
      field = fields.find((f) => f.use === 'status') ?? fields.find((f) => f.kind === 'checkbox')
    }
    const plan = todoPlanOfField(field)
    this.beginUndoEntry()
    // 切的是一个属性值：一笔 patch 落「值 ＋（新挂时）自有槽」，与「插入待办」同一形状。
    // 落的是核心任务状态 ⇒ 定义块得先在（恢复空库／定义被清掉的库里没有它，
    // 缺了它这一行只剩「未知属性」）；同一笔事务里补上，值与定义同批落盘。
    this.write((tx) => {
      if (plan.propId === TASK_STATUS_PROP_ID) ensureTaskStatusInTx(this.store.blocks, tx)
      tx.patch(id, (b) => applyTodoPlan(b, plan))
    })
    this.structTail(null, [id])
  }

  /**
   * 批量切换待办（块选区）：每块按**自己**的字段判据翻值（同 `toggleTodo`），
   * 全部装进**一笔事务**：定义块只补一次、一次撤销整体复原。section 根跳过。
   */
  toggleTodoMany(ids: readonly string[]): boolean {
    const plans: { id: string; plan: TodoPlan }[] = []
    for (const id of ids) {
      const loc = locate(this.doc, id)
      if (!loc || loc.parent === null) continue
      const fields = gutterFieldsOf(loc.block, this.store.blocks)
      const field = fields.find((f) => f.use === 'status') ?? fields.find((f) => f.kind === 'checkbox')
      plans.push({ id, plan: todoPlanOfField(field) })
    }
    if (plans.length === 0) return false
    this.beginUndoEntry()
    this.write((tx) => {
      if (plans.some((p) => p.plan.propId === TASK_STATUS_PROP_ID)) {
        ensureTaskStatusInTx(this.store.blocks, tx)
      }
      for (const p of plans) tx.patch(p.id, (b) => applyTodoPlan(b, p.plan))
    })
    this.structTail(null, plans.map((p) => p.id))
    return true
  }

  /**
   * **摘掉这一块的任务状态**（`core.editor/clear-todo`）：`toggleTodo` 的逆。
   *
   * 为什么不能只靠 `toggleTodo` 连着点：它翻的是**值**（`true` ⇄ `false`），
   * 而「这块不是任务」说的是**这一栏根本不存在**（`undefined`，见 `todoOf` 的三态）。
   * 值翻到 `false` 仍然是「是任务、没做完」—— 屏幕上还画着空心方框。
   * 所以退出的动作必须是摘栏：值连同自有槽一起删（`clearValue`）。
   *
   * ⚠️ **两种来源只有一种能摘**：这一栏可能来自这块自己的槽，也可能来自
   *    某个标签的**字段声明**（种子里的 `#任务` 就是）。`clearValue` 只动前者，
   *    所以摘完要**再读一次**判据 —— 还剩下就返回 `'declared'`，
   *    由调用方解释「它来自标签」，而不是让用户对着一个没变化的方框猜。
   */
  clearTodo(id: string): 'cleared' | 'declared' | 'none' {
    const loc = locate(this.doc, id)
    if (!loc) return 'none'
    // 目标与 `toggleTodo` 同一判据：库里唯一的任务状态字段
    const field = gutterFieldsOf(loc.block, this.store.blocks).find((f) => f.use === 'status')
    if (!field) return 'none'
    this.beginUndoEntry()
    this.write((tx) => tx.patch(id, (b) => clearValue(b, field.propId)))
    this.structTail(null, [id])
    // 摘完要**再读一次**判据：这一栏可能来自标签的字段声明（`clearValue` 只动自有槽），
    // 还剩下就返回 `'declared'`，由调用方解释「它来自标签」，而不是让用户对着
    // 一个没变化的方框猜。
    const after = locate(this.doc, id)
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
      const b = locate(this.doc, r.blockId)?.block
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
    const b = locate(this.doc, s.aBlock)?.block
    if (!b || !canWriteText(b)) return null
    const from = Math.min(s.aOff, s.hOff)
    const to = Math.max(s.aOff, s.hOff)
    if (from >= to) return null
    const slice = sliceRuns(b.content, from, to)
    if (slice.length === 0 || slice.some((r) => r.t !== 'text')) return null
    const raw = plainText(slice)
    const start = from + (raw.length - raw.trimStart().length)
    const end = to - (raw.length - raw.trimEnd().length)
    const text = raw.slice(start - from, end - from)
    return text === '' ? null : { blockId: s.aBlock, start, end, text }
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
      const lookup = tagLookupOf(this.store.blocks)
      const target = run.flavor === '#' ? ensureTagInTx(lookup, label, tx) : ensurePageInTx(lookup, label, tx)
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
    if (!ok) return 'none'
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
   * 引用某段的引文快照：用当前选区物化一条 anno，`quote.exact` 恒为
   * `plainText` 投影的子串（选区 plain 坐标 → 投影坐标的换算在 core 层）。
   * 没有文本 ⇒ `undefined`（引用纯原子没有可定位的东西，走整块引用）。
   */
  quoteAtSel(): { exact: string; prefix: string; suffix: string } | undefined {
    const s = this.sel
    if (!s) return undefined
    const r = normSel(this.doc, s)
    if (r.startBlock !== r.endBlock) return undefined
    const b = locate(this.doc, r.startBlock)
    if (!b) return undefined
    return mkAnno(b.block.content, r.startOff, r.endOff)?.quote
  }

  /**
   * 「引用这段」：把当前选区物化成一条**持久** anno，返回它的 id（引用 run 的 `to` 指它）。
   *
   * 与 `quoteAtSel` 的分工：那个只取引文快照给外部看，这个要把实体落进 `b.annos` ——
   * 否则引用指向一个不存在的 id。整件事在唯一事务里（`setAnnos` ⇒ `anno.set` op ⇒
   * 索引反查表、落盘 annos 列、撤销快照都跟着这一笔），撤销天然复原。
   */
  quoteSelection(): string | null {
    const spot = this.selectionSpot()
    if (!spot) return null
    const b = locate(this.doc, spot.blockId)?.block
    if (!b) return null
    const anno = mkAnno(b.content, spot.start, spot.end)
    if (!anno) return null
    const annos = [...(b.annos ?? []), anno]
    this.beginUndoEntry()
    this.write((tx) => tx.setAnnos(spot.blockId, annos), undefined, { directEdit: true })
    this.finishUndoEntry('other', Date.now())
    return anno.id
  }

  /**
   * 写备注：把当前选区物化成区间锚 ＋ 建一条备注块，**同一笔事务**
   * （拆开就是「宿主加了锚、备注块不在」的半批）。返回备注块 id；没有可用选区 ⇒ null。
   */
  createNoteFromSelection(): string | null {
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
  createNoteFromBlockSelection(): string | null {
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

  /** 两个入口共用的落笔：锚写宿主＋备注块进顶层，一笔事务一条撤销 */
  private createNote(pairs: NotePair[], writeHosts: (tx: Tx) => void): string | null {
    this.beginUndoEntry()
    let noteId: string | null = null
    this.write((tx) => {
      writeHosts(tx)
      noteId = ensureNoteInTx(this.store.blocks, pairs, tx).id
    }, undefined, { directEdit: true })
    this.finishUndoEntry('other', Date.now())
    // 焦点反馈走 change 通道（'note'）：派生栏的行没变，它自己不会重画——
    // 装配层在漏斗里读瞬态信号，切到「备注」栏并聚焦新行（本层不碰 DOM）
    this.lastCreatedNote = noteId ? { noteId, hostIds: pairs.map((p) => p.block) } : null
    this.emitChange('note')
    return noteId
  }

  /* ------------------------------------------------------- 虚拟化 */

  setVirtualize(on: boolean, radius = this.radius): void {
    this.virtualize = on
    this.radius = radius
    this.renderAll()
    this.events.change?.('load')
  }

  /** 窗口化挂载：只挂「光标所在行 ± radius」（**以可见行计**，折叠的子树本来就不在窗口里） */
  applyWindow(centerId?: string): void {
    /**
     * ⚠️ **组合期不重算窗口**（见 `deferWhileComposing`）。
     *    这条不是可有可无的：`applyWindow` 会 `container.textContent = ''` 再按窗口重新挂，
     *    承载块因此换成**另一个元素**（即使 `virtualize=false`，判据 `before === after` 为假）——
     *    那一下就把输入法的组合锚点摘掉了。
     */
    if (this.deferWhileComposing()) return
    const rows = this.rows()
    const cid = centerId ?? this.sel?.aBlock ?? rows[0]?.block.id
    let ci = rows.findIndex((r) => r.block.id === cid)
    if (ci < 0) ci = 0
    const from = Math.max(0, ci - this.radius)
    const to = Math.min(rows.length, ci + this.radius + 1)
    this.embeds.disposeAll()
    this.container.textContent = ''
    this.mounted.clear()
    // ⚠️ 祖先表对**全量** rows 算（上面已经拿到的就是全量可见行），
    //    不对下面 slice 重建 —— 否则窗口第一行的祖先全丢。
    this.rebuildAncestors()
    // 占位高度按**实际行高**累加：带别名头的行是两行，按 LINE_H 算会让长文档的
    // 滚动条与落点系统性偏小（越靠后偏得越多）。
    /**
     * 这一行在窗口外的占位高度。
     *
     * 「有没有视图体」有两种：正文里查询块的行内体（折叠时不算身体），
     * 与**露面块里的投影**（源的结果视图）。两者高度都来自 `VIEW_BODY_H` ——
     * 少算一处，带这种行的文档滚动条就系统性偏小。
     */
    const below = belowFieldsFor(
      rows.map((r) => r.block),
      this.store.blocks,
      (id) => this.parentOfRow(id),
      this.store.index.blocks,
    )
    const rowH = (r: VisibleRow): number =>
      visibleRowHeight(
        r.block,
        this.extraHeads(r),
        (Boolean(this.events.viewBody) && rowHasInlineViewBody(r) && !isFolded(this.doc, r.block.id)) ||
          (Boolean(this.events.embedBody) &&
            rowHasEmbedViewBody(r.block, (id) => this.store.find(id)) &&
            !isFolded(this.doc, r.block.id)),
        Boolean(this.events.propsLine) && below.has(r.block.id),
      )
    if (from > 0) {
      const headH = rows.slice(0, from).reduce((n, r) => n + rowH(r), 0)
      this.container.appendChild(this.placeholder(from, 'head', headH))
    }
    this.renderRows(rows.slice(from, to), to >= rows.length)
    if (to < rows.length) {
      const tailH = rows.slice(to).reduce((n, r) => n + rowH(r), 0)
      this.container.appendChild(this.placeholder(rows.length - to, 'tail', tailH))
    }
    this.repaintOverlays()
    this.events.mounted?.()
  }

  /** 这一行除正文外还占几条「整行头」（面包屑／别名头／来源说明的高度由 block-dom 统一算） */
  private extraHeads(r: VisibleRow): number {
    if (r.depth !== 0) return 0
    const hasTrail = (this.doc.contexts?.get(r.block.id)?.length ?? 0) > 0
    const hasBack = Boolean(this.onContextBack) && (this.doc.expandedRoots?.has(r.block.id) ?? false)
    // 来源说明与面包屑同住 `.blk-context` 那一行：两者都在时仍是**一条**头，不是两条
    const hasNote = (this.doc.rootNotes?.get(r.block.id) ?? '') !== ''
    return hasTrail || hasBack || hasNote ? 1 : 0
  }

  private placeholder(count: number, which: string, height = count * LINE_H): HTMLElement {
    const d = document.createElement('div')
    d.className = 'ph'
    d.dataset.ph = which
    d.dataset.count = String(count)
    d.contentEditable = 'false'
    d.style.height = `${height}px`
    d.textContent = t('ui.virt.placeholder', { count })
    return d
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
      beginMouseSelect: (id, x, y, shift) => this.bsel.beginMouseSelect(id, x, y, shift),
      updateMouseSelect: (x, y) => this.bsel.updateMouseSelect(x, y),
      endMouseSelect: () => this.bsel.endMouseSelect(),
      hasBlockSelection: () => this.bsel.hasBlockSelection(),
      onShellActivate: (date, place) => this.events.shellWrite?.(date, place),
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
      annoHitAt: (x, y) => this.annoHitAt(x, y),
      onAnnoClick: (hit) => {
        this.commitLeavingLine()
        this.events.annoClick?.(hit)
      },
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
      toggleTodo: (id, propId) => this.toggleTodo(id, propId),
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
    this.doc.roots.push(...blocks)
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

  ctxKeys(): CtxKeys {
    const s = this.sel
    const id = s?.aBlock ?? null
    const at = id ? locate(this.doc, id) : null
    const b = at?.block
    /**
     * **森林根**不是「装载根」：一个嵌在天下面的页被单独打开时，`blockIsRoot` 也是 true，
     * 但它并不是森林顶层。`store.blocks` 是森林根数组，O(根数) 就能判。
     */
    const forestRoot = Boolean(id) && this.store.blocks.some((x) => x.id === id)
    return {
      focus: 'editor',
      editorTextFocus: document.activeElement === this.container || this.container.contains(document.activeElement),
      selectionEmpty: s ? s.aBlock === s.hBlock && s.aOff === s.hOff : true,
      selectionCount: s && !(s.aBlock === s.hBlock && s.aOff === s.hOff) ? (s.aBlock === s.hBlock ? 1 : 2) : 0,
      /** 选区能不能转引用（单块纯文本）：与命令执行时同一份判据 */
      selectionRef: this.selectionSpot() !== null,
      blockFocused: Boolean(id),
      blockId: id ?? '',
      /**
       * 当前块是不是**视图的根**（`locate` 找不到父块）。
       *
       * 为什么需要它：根块不是一个「内容块」—— 删页／删天要走命令面
       * （`core.page/delete`），从编辑器里 splice 掉它只会让视图看不见，
       * 库里那块还在（刷新就回来，看起来像「删了又复活」）。
       * ⇒ 菜单靠这个键把自己藏起来，而不是点了再静默失败。
       */
      blockIsRoot: at !== null && at.parent === null,
      blockIsForestRoot: forestRoot,
      // 光标落在命中高亮里（块菜单「转为引用」的准入，与 ⌥ 单击同一份判据）
      mentionHit: this.mentionHitAtCaret() !== null,
      /**
       * 删除入口的准入：**按「有没有身份、有没有替代命令」判，不按「是不是根」**。
       *
       * 页／标签／日记天是身份根——它们是视图的装载单位，且各自有命令面的删除
       * （`core.page/delete` 带「至少留一页」，`core.journal/delete` 不给今天），
       * 从编辑器删只会让视图看不见、库里还在（「删了又复活」）⇒ 这里不给。
       * 非身份的根块（森林顶层的普通块、zoom 进来的普通块）删掉就是删掉内容，
       * 与普通块同构；**查询块根**同理——晋升出来的查询是内容，又没有替代命令，
       * 藏掉它就是「完全删不掉」。编辑器侧的删除走事务（整棵软删、⌘Z 可回），
       * 装载根的收尾（doc.roots splice／留空位）在删除命令里已处理。
       */
      blockCanDelete:
        id !== null && !(at !== null && at.parent === null && b !== undefined && hasIdentity(b) && !isQueryBlock(b)),
      /**
       * 「提取为页」只对**内容块**有定义：身份块（journal／tag／schema／query）
       * 不靠位置表达信息，搬它们没有意义；森林根也没有可移动的落点。
       */
      blockCanExtractPage:
        b !== undefined &&
        !forestRoot &&
        !isJournal(b) &&
        !(hasList(b, 'tag') && !hasList(b, 'page')) &&
        !isPropDefBlock(b) &&
        !isQueryBlock(b),
      /**
       * 这一块是**可以删的日记天**：今天不行 —— 今天在冷启动会被物化回来
       * （它是落点，不是「恰好存在的一天」），给它一个「删了又回来」的入口只会像坏了。
       */
      blockCanDeleteJournal: b !== undefined && isJournal(b) && journalDate(b) !== todayISO(),
      blockSelection: this.bsel.blockSel !== null,
      blockSelectionCount: this.bsel.blockSel?.ids.length ?? 0,
      blockType: b && todoOf(b, this.fieldTable()) ? 'todo' : 'paragraph',
      blockHasChildren: Boolean(b && hasLiveChildren(b)),
      /**
       * 这一行有没有可折的东西：子块，或**身体**（查询块的结果视图／露面投影）。
       *
       * 只在「这个表面真的画身体」时把身体算进来 —— 查询结果列表里的命中行
       * 不是它自己的位置，折它没有可见效果。
       */
      blockFoldable: Boolean(b && (hasLiveChildren(b) || this.bodyFoldable(b))),
      /**
       * 这一块值不值得给「视图…」入口：查询块（源＝命中），或**有子块**的容器，
       * 或已经有激活视图（要能切回大纲）。叶子普通块没有可摊开的东西 ——
       * 给一个点了什么都没有的菜单项，用户只会以为是坏的。
       */
      blockCanHaveView: Boolean(
        b && (isQueryBlock(b) || isEmbedBlock(b) || hasLiveChildren(b) || activeView(b) !== null),
      ),
      blockCollapsed: Boolean(b && isFolded(this.doc, b.id)),
      blockDone: b ? todoOf(b, this.fieldTable()) === 'done' : false,
      marking: b ? this.marksAtSel().join('+') : '',
      inTrash: false,
      composing: this.probe.isComposing,
      isMac: /Mac|iPhone|iPad/.test(navigator.platform),
      undoDepth: this.undo.depth(),
      redoDepth: this.undo.redoDepth(),
      blockCount: flatten(this.doc).length,
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
