/**
 * **渲染管线**（画层 ＋ 备注画层）：全量重排、单行重画、虚拟化窗口、空天格子、
 * 备注标记的两层画笔。字段与方法都在这里，宿主（`BlockEditor`）保同名转发，
 * 装配层与协作对象的调用点不用动。
 *
 * 与重载路径（`reload-policy.ts`）的分工：policy 管**何时**可以换 DOM（冻结、欠账、
 * 补做），这里管**怎么画**——每个换 DOM 的入口先过 `ed.deferWhileComposing()`，
 * 这条接缝必须保持单向。
 *
 * 自有字段只有渲染自己的（祖先表／光标标记缓存／挂载集合／备注画笔）；
 * 森林、选区、事件表、折叠态全部经宿主。
 */
import {
  ancestorsByBlockId,
  belowFieldsFor,
  depthOf,
  flatten,
  foldStateOf,
  gutterFieldsFor,
  gutterFieldsOf,
  hasLiveChildren,
  isFolded,
  journalDateLabel,
  locate,
  noteSourceCellsOf,
  refSourcesOf,
  relationsTo,
  walkForest,
  type Block,
  type BelowFields,
  type GutterField,
  type NoteSourceCell,
  type ShellCol,
  type VisibleRow,
} from '../../core/index.ts'
import { plainText } from '../../core/model/runs.ts'
import { t } from '../../core/infra/msg.ts'
import { assetViewOf, markAssetMissing } from '../asset-views.ts'
import { LINE_H, fillBlockText, makeBlockEl, makeRefBadgeEl, rowHasEmbedViewBody, rowHasInlineViewBody, visibleRowHeight } from './block-dom.ts'
import { spanAt, offsetAtPoint, rangeAtSpan, paintHits, clearHits } from './hit-paint.ts'
import type { AnnoHitSpan } from './anno-hover.ts'
import { inputSession } from './input-session.ts'
import type { BlockEditor } from './editor.ts'

export class RenderOps {
  constructor(private readonly ed: BlockEditor) {}

  /**
   * **可点导轨的祖先表**：`blockId → [祖先 id…]`（index = 层级 k）。
   *
   * ⚠️ 它对**全量可见行**算，不对 `applyWindow` 的 slice 算——否则窗口从中间开始时，
   *    第一行的祖先全丢（调研 点名的唯一易错处）。所以只在
   *    `renderAll` / `applyWindow` / `renderBlock` 入口重建，渲染单行时查表。
   */
  private ancestors = new Map<string, string[]>()

  /** 这一屏已挂载的块 id（宿主 getter 转发给装配层的诊断与徽标） */
  mounted = new Set<string>()

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

  /** 本实例的备注标记画笔 key（每台编辑器一份，互不覆盖；dispose 时摘掉） */
  private readonly annoKey = `anno-mark-${Math.random().toString(36).slice(2)}`
  /** hover 命中那一段的加深画笔（AnnoHover 回报驱动；与常显层分 key 才能两档样式） */
  private readonly annoHotKey = `anno-mark-hot-${Math.random().toString(36).slice(2)}`
  private annoPaintQueued = false
  /**
   * 活跃备注区间（与画层**同源**：paintAnnoMarks 每次重画时顺手缓存）。
   * hover 命中判定读它——判定与画亮的是同一处，两份口径必然漂。
   */
  /** 宿主经 getter 读（AnnoHover 闭包与装配层） */
  annoSpans: ReadonlyMap<string, readonly AnnoHitSpan[]> = new Map()

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
  renderAllPreservingAnchor(anchor: { id: string; parentId: string | null } | null): void {
    if (!anchor) {
      this.renderAll()
      return
    }
    const loc = locate(this.ed.doc, anchor.id)
    if (!loc) {
      if (inputSession.editor === this.ed) this.ed.events.focusSource?.(anchor.id)
      this.renderAll()
      return
    }
    if ((loc.parent?.id ?? null) !== anchor.parentId) {
      this.renderAll()
      return
    }
    const oldEl = this.ed.blockEl(anchor.id)
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
    this.ed.embeds.pin(anchor.id)
    try {
      this.renderAll()
      const fresh = this.ed.blockEl(anchor.id)
      if (fresh && fresh !== oldEl) {
        fresh.replaceWith(oldEl)
        this.mounted.add(anchor.id)
        if (focusInside) (active as HTMLElement).focus({ preventScroll: true })
      }
    } finally {
      this.ed.embeds.unpin()
    }
    // 旧行是原样换回的：光标标记与块选区漆层按换回后的 DOM 重打一遍
    this.repaintOverlays()
  }

  renderAll(): void {
    /**
     * ⚠️ **组合期不换 DOM**（见 `deferWhileComposing`）。这条是全量重排的唯一入口，
     *    守卫放在这里才覆盖得住 `loadPage`／`reloadFromStore`／各命令路径。
     */
    if (this.ed.deferWhileComposing()) return
    // 别的视图写进来（本实例的写入口已作废过）；重排之后重算一张表
    this.ed.fieldTableCache = null
    this.ed.embeds.disposeAll()
    this.ed.container.textContent = ''
    this.mounted.clear()
    this.rebuildAncestors()
    // DOM 重建 ⇒ `data-caret` 全丢，缓存也失效（否则 `markCaret` 会因为「id 没变」而跳过）
    this.caretMarks = ''
    // 虚拟化只属单列流：row/grid 的段要完整的盒子才能当列用，窗口切片会把列切残
    if (this.ed.virtualize && this.ed.layout === 'column') {
      this.applyWindow()
      return
    }
    this.renderRows(this.ed.rows())
    this.markCaret()
    this.ed.bsel.paintBlockSel()
    this.ed.events.mounted?.()
    this.paintAnnoMarks()
  }

  /**
   * 把某一行滚进视口并闪一下。
   *
   * 用途：上下文展开后命中行可能在屏幕外（展开了一整页祖先）——不滚过去，
   * 用户只看到一堆无关兄弟块，会以为「点了跳到别处」。
   * ⚠️ 虚拟化时目标可能不在窗口里：先把窗口中心移到它，再取元素。
   */
  reveal(id: string): void {
    if (this.ed.virtualize && !this.ed.blockEl(id)) this.applyWindow(id)
    const el = this.ed.blockEl(id)
    if (!el) return
    // 跳块走平滑滚动：viewport 级瞬跳读作「换了一屏」，眼睛跟不上路；
    // 减动效偏好直接瞬移（flash 仍承担「到了哪里」的可达性反馈）。
    // ⚠️ 只在这一个跳转点选 smooth：打字时的滚动到光标必须瞬时，不走 CSS 全局 scroll-behavior。
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' })
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
      const el = this.ed.blockEl(id)
      if (!el) continue
      el.dataset.pulse = '1'
      window.setTimeout(() => {
        if (el.isConnected) delete el.dataset.pulse
      }, 400)
    }
  }

  txEl(id: string): HTMLElement | null {
    return this.ed.blockEl(id)?.querySelector<HTMLElement>('.tx') ?? null
  }

  /**
   * 重建祖先表（**全量可见行**）。
   * 每个改结构的入口都要调它——导轨画的是「此刻的树」，不是「上次渲染的树」。
   */
  private rebuildAncestors(): void {
    this.ancestors = ancestorsByBlockId(this.ed.rows())
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

  /**
   * 行的**模型父块**（`_childProps` 显示声明的来源；父不在装载窗口 ⇒ null）。
   * 渲染是按树扁平成可见行的（`VisibleRow` 没有 parent 指针），但 doc 里有——
   * 「显示跟数据走」就靠这一步把模型父链接回来（嵌入岛装的是同一棵子树 ⇒ 自动跟随）。
   */
  private parentOfRow(id: string): Block | null {
    return locate(this.ed.doc, id)?.parent ?? null
  }

  private renderRows(rows: readonly VisibleRow[], tailComplete = true): void {
    const blocks = rows.map((r) => r.block)
    const gutters = gutterFieldsFor(blocks, this.ed.store.blocks)
    const below = belowFieldsFor(blocks, this.ed.store.blocks, (id) => this.parentOfRow(id), this.ed.store.index.blocks)
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
          for (const col of this.ed.shells) if (col.beforeRootId === r.block.id) this.ed.container.appendChild(this.makeShellSec(col))
        }
        sec = document.createElement('div')
        sec.className = 'sec'
        sec.dataset.sec = r.depth === 0 ? r.block.id : ''
        this.ed.container.appendChild(sec)
      }
      sec.appendChild(this.makeBlockEl(r, gutters.get(r.block.id), below.get(r.block.id)))
    }
    if (tailComplete) closeSec()
    // 比所有已装段都更早的空天格子：追加在最后
    if (this.ed.layout !== 'column') {
      for (const col of this.ed.shells) if (col.beforeRootId === null) this.ed.container.appendChild(this.makeShellSec(col))
    }
  }

  renderBlock(id: string): void {
    const loc = locate(this.ed.doc, id)
    const el = this.ed.blockEl(id)
    if (!loc || !el) return
    /**
     * ⚠️ **组合期不重画这一行**（见 `deferWhileComposing`）。这一条比 `renderAll` 更容易踩到：
     *    属性写入（`writeProps` → `repaintBlock`）、改名传播（`renderRefSources`）、
     *    以及 `syncFromDom` 的收尾都会调到它，而它们**都不看组合期**。
     *    它换的是 `.tx` 所在的那一行 ⇒ 输入法正持有的文本节点被换掉，预编辑串当场落成正文。
     */
    if (this.ed.deferWhileComposing()) return
    const row = this.ed.rows().find((r) => r.block.id === id) ?? {
      block: loc.block,
      depth: depthOf(this.ed.doc, id),
      hidden: false,
      hasChildren: hasLiveChildren(loc.block),
    }
    this.ed.embeds.disposeRow(id)
    el.replaceWith(
      this.makeBlockEl(
        row,
        gutterFieldsOf(row.block, this.ed.store.blocks),
        belowFieldsFor([row.block], this.ed.store.blocks, (id) => this.parentOfRow(id), this.ed.store.index.blocks).get(
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
    const find = (id: string) => this.ed.store.find(id)
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
      (tx) => fillBlockText(tx, r.block, find, this.ed.events.assetView ?? assetViewOf, this.ed.events.onAssetError ?? markAssetMissing),
      {
        single: flatten(this.ed.doc).length === 1,
        ancestors: this.ancestors.get(r.block.id) ?? [],
        folded: foldStateOf(this.ed.doc),
        gutter,
        find,
        /**
         * **行尾引用数徽标**：读共享 store 的入向边表（索引查表，不是全库扫描），
         * 与浮层列表、引用栏抬头共用 `core/views/ref-sources.ts` 那一份聚合。
         * 放在构造渲染参数里而不是 `ViewEvents`：编辑器**构造时就画首帧**，
         * 事件表那时还没赋上（同 `assetView` 那条实测过的坑）。
         */
        refBadge: makeRefBadgeEl(r.block.id, refSourcesOf(relationsTo(this.ed.store.index, r.block.id))),
        // 行尾标签 chips 拖拽重排：写回走同一份 reorderTags（只许换序，一笔撤销）
        onReorderTags: (blockId, orderedIds) => {
          void this.ed.reorderTags(blockId, orderedIds)
        },
        // 只有装载根会带上下文：子行的位置已经由缩进表达。装载声明 paths=false 时只关这一格的显示
        context: r.depth === 0 && this.ed.doc.paths !== false ? this.ed.doc.contexts?.get(r.block.id) : undefined,
        // 来源说明与面包屑同一格：都在说明「这一行为什么在这一屏里」
        note: r.depth === 0 ? this.ed.doc.rootNotes?.get(r.block.id) : undefined,
        // 备注根说明「在评论谁」；这一屏已经说明了宿主时（备注栏／浮窗）Doc 关掉它
        noteSource: this.noteSourceOf(r.block, r.depth),
        // 展开出来的根才有「收起上下文」；没接回调就不画一个点了没反应的按钮
        contextBack: Boolean(this.ed.onContextBack) && r.depth === 0 && (this.ed.doc.expandedRoots?.has(r.block.id) ?? false),
        // 露面块的身体：这一层只认「有没有展开」；画什么由装配层给（见 `ViewEvents.embedBody`）
        embedBody: (b, into) => this.ed.embeds.attach(b, into),
        ...(this.ed.emptyPlaceholder !== undefined ? { placeholder: this.ed.emptyPlaceholder } : {}),
        /**
         * **正文里的查询体**：只有装配层接了画法、且这一份装载允许展开时才给。
         * 「哪一行画」由 `block-dom` 的 `rowHasInlineViewBody` 判（按源分派，
         * 段根同此——聚焦后身体仍贴着自己那一行，不再让位段尾宿主）。
         */
        ...(this.ed.events.viewBody
          ? {
              viewBody: (b: Block, into: HTMLElement) => this.ed.embeds.attachViewBody(b, into),
            }
          : {}),
        // 块下属性行：值文本与点击都在装配层；`view` 只给位置与定高
        ...(below && this.ed.events.propsLine
          ? {
              below,
              propsLine: (b: Block, data: BelowFields, into: HTMLElement) => this.ed.events.propsLine!(b, data, into),
            }
          : {}),
      },
    )
    this.mounted.add(r.block.id)
    return el
  }

  /** 行元素被换过 ⇒ `data-caret` 跟着旧元素丢了：缓存作废，光标标记与块选区漆层重打 */
  private repaintOverlays(): void {
    this.caretMarks = ''
    this.markCaret()
    this.ed.bsel.paintBlockSel()
  }

  /** 供协作对象（块选区）在收掉模型选区时同步重打光标标记 */
  markCaret(): void {
    const id = this.ed.sel?.aBlock ?? ''
    if (id === this.caretMarks) return
    this.caretMarks = id
    for (const el of Array.from(this.ed.container.querySelectorAll<HTMLElement>('.blk'))) {
      if (el.dataset.blockId === id) el.dataset.caret = '1'
      else delete el.dataset.caret
    }
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
    const idx = this.ed.store.index
    walkForest(this.ed.doc.roots, (b) => {
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
    paintHits(this.ed.container, blocks, this.annoKey, '--ui-anno-bg')
  }

  /**
   * hover 命中那一段的加深画笔（「这段可以点」的确认反馈）。
   * 常显层与 hot 层分 key 分 token：两档样式靠两把 highlight 叠出来。
   */
  paintAnnoHot(hit: { blockId: string; annoId: string } | null): void {
    if (!hit) {
      clearHits(this.annoHotKey)
      return
    }
    const anno = this.ed.store.find(hit.blockId)?.annos?.find((a) => a.id === hit.annoId)
    const blk = this.ed.container.querySelector<HTMLElement>(`.blk[data-block-id="${hit.blockId}"]`)
    const tx = blk?.querySelector<HTMLElement>(':scope > .tx')
    if (!anno || !tx) {
      clearHits(this.annoHotKey)
      return
    }
    const r = rangeAtSpan(tx, anno.range)
    if (!r) {
      clearHits(this.annoHotKey)
      return
    }
    paintHits(this.ed.container, new Map([[hit.blockId, [anno.range]]]), this.annoHotKey, '--ui-anno-bg-hot')
  }

  /** 被备注区间的 tip 文本：备注块的正文投影（多条换行平铺） */
  annoNoteText(blockId: string, annoId: string): string {
    const notes: string[] = []
    for (const e of this.ed.store.index.relations.get(blockId) ?? []) {
      if (e.kind !== 'annotates' || e.propId !== annoId) continue
      const note = this.ed.store.find(e.from)
      if (note) notes.push(plainText(note.content))
    }
    return notes.join('\n')
  }

  /** 被备注区间的屏幕矩形（浮窗定锚用；区间不在这一屏 ⇒ null——浮层锚函数返回 null 即自动关） */
  annoRect(blockId: string, annoId: string): DOMRect | null {
    // 直接从块数据取区间：刚创建时画层缓存（rAF）还没建，不能依赖 annoSpans
    const anno = this.ed.store.find(blockId)?.annos?.find((a) => a.id === annoId)
    if (!anno) return null
    const blk = this.ed.container.querySelector<HTMLElement>(`.blk[data-block-id="${blockId}"]`)
    const tx = blk?.querySelector<HTMLElement>(':scope > .tx')
    if (!tx) return null
    return rangeAtSpan(tx, anno.range)?.getBoundingClientRect() ?? null
  }

  /** ⌥-click 命中判定：坐标 → 被备注的（块，锚）。与 hover 同一份缓存，与画层同源 */
  annoHitAt(x: number, y: number): { blockId: string; annoId: string } | null {
    if (this.annoSpans.size === 0) return null
    const el = document.elementFromPoint(x, y)
    const blk = el?.closest<HTMLElement>('.blk')
    const blockId = blk?.dataset?.['blockId']
    if (!blk || !blockId || !this.ed.container.contains(blk)) return null
    const tx = blk.querySelector<HTMLElement>(':scope > .tx')
    if (!tx) return null
    const offset = offsetAtPoint(tx, x, y)
    if (offset === null) return null
    const span = spanAt(this.annoSpans.get(blockId) ?? [], offset)
    return span ? { blockId, annoId: span.annoId } : null
  }

  /** 重画排进下一帧（合并同一帧里的多笔写）；组合期不画（DOM 还没落定） */
  scheduleAnnoPaint(): void {
    if (this.annoPaintQueued || typeof requestAnimationFrame === 'undefined') return
    this.annoPaintQueued = true
    requestAnimationFrame(() => {
      this.annoPaintQueued = false
      if (this.ed.deferWhileComposing()) return
      this.paintAnnoMarks()
    })
  }

  /** 窗口化挂载：只挂「光标所在行 ± radius」（**以可见行计**，折叠的子树本来就不在窗口里） */
  applyWindow(centerId?: string): void {
    /**
     * ⚠️ **组合期不重算窗口**（见 `deferWhileComposing`）。
     *    这条不是可有可无的：`applyWindow` 会 `container.textContent = ''` 再按窗口重新挂，
     *    承载块因此换成**另一个元素**（即使 `virtualize=false`，判据 `before === after` 为假）——
     *    那一下就把输入法的组合锚点摘掉了。
     */
    if (this.ed.deferWhileComposing()) return
    const rows = this.ed.rows()
    const cid = centerId ?? this.ed.sel?.aBlock ?? rows[0]?.block.id
    let ci = rows.findIndex((r) => r.block.id === cid)
    if (ci < 0) ci = 0
    const from = Math.max(0, ci - this.ed.radius)
    const to = Math.min(rows.length, ci + this.ed.radius + 1)
    this.ed.embeds.disposeAll()
    this.ed.container.textContent = ''
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
      this.ed.store.blocks,
      (id) => this.parentOfRow(id),
      this.ed.store.index.blocks,
    )
    /** 这一块的属性区占几行（与装配层的渲染吃同一份判据；没有回调 ⇒ 不画） */
    const propsRowCount = (id: string, data: BelowFields | undefined): number => {
      if (!this.ed.events.propsLine || !this.ed.events.propsRows || !data) return 0
      return this.ed.events.propsRows(id, data)
    }
    const rowH = (r: VisibleRow): number =>
      visibleRowHeight(
        r.block,
        this.extraHeads(r),
        (Boolean(this.ed.events.viewBody) && rowHasInlineViewBody(r) && !isFolded(this.ed.doc, r.block.id)) ||
          (Boolean(this.ed.events.embedBody) &&
            rowHasEmbedViewBody(r.block, (id) => this.ed.store.find(id)) &&
            !isFolded(this.ed.doc, r.block.id)),
        // 行数由装配层给（密度档 ＋ 单块展开）；没有这一格 ⇒ 不画属性区
        propsRowCount(r.block.id, below.get(r.block.id)),
      )
    if (from > 0) {
      const headH = rows.slice(0, from).reduce((n, r) => n + rowH(r), 0)
      this.ed.container.appendChild(this.placeholder(from, 'head', headH))
    }
    this.renderRows(rows.slice(from, to), to >= rows.length)
    if (to < rows.length) {
      const tailH = rows.slice(to).reduce((n, r) => n + rowH(r), 0)
      this.ed.container.appendChild(this.placeholder(rows.length - to, 'tail', tailH))
    }
    this.repaintOverlays()
    this.ed.events.mounted?.()
  }

  /** 这一行除正文外还占几条「整行头」（面包屑／别名头／来源说明的高度由 block-dom 统一算） */
  private extraHeads(r: VisibleRow): number {
    if (r.depth !== 0) return 0
    // 与渲染同一份门：关掉路径的装载不再为它留一行（虚拟化占位高度跟着缩）
    const hasTrail = this.ed.doc.paths !== false && (this.ed.doc.contexts?.get(r.block.id)?.length ?? 0) > 0
    const hasBack = Boolean(this.ed.onContextBack) && (this.ed.doc.expandedRoots?.has(r.block.id) ?? false)
    // 来源说明与面包屑同住 `.blk-context` 那一行：都在时仍是**一条**头，不是两条
    const hasNote = (this.ed.doc.rootNotes?.get(r.block.id) ?? '') !== ''
    // 备注来源与它们同一个槽：有它也一样只多一条头
    const hasSource = this.noteSourceOf(r.block, r.depth) !== undefined
    return hasTrail || hasBack || hasNote || hasSource ? 1 : 0
  }

  /**
   * 备注根的来源格：`Doc.noteSource === false` 的屏（备注栏／浮窗）已经说明了宿主，
   * 不再重复；其余装载（中心／页签／侧栏／查询列）都带着来路。
   *
   * 每次渲染现算（与行尾引用徽标同一条口径）：它是块上的事实派生出来的，
   * 宿主或锚一删、下一次重画就该变样，没有第二份缓存要失效。
   */
  private noteSourceOf(b: Block, depth: number): NoteSourceCell[] | undefined {
    if (depth !== 0 || this.ed.doc.noteSource === false) return undefined
    const cells = noteSourceCellsOf(b, this.ed.store.index)
    return cells.length > 0 ? cells : undefined
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


  /** 宿主 dispose 时调：摘掉本实例的两把画笔、清命中缓存（游离容器不再被重画） */
  disposeAnnoPaint(): void {
    this.annoSpans = new Map()
    clearHits(this.annoKey)
    clearHits(this.annoHotKey)
  }
}
