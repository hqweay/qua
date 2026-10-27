/**
 * 编辑器的**事件接线**：把 contenteditable 上的原始事件翻译成编辑器动作。
 *
 * 为什么单独成文件：这块原本是 `view.ts` 里最长的私有方法（`bind()`，约 220 行），
 * 而它做的事情**全是"翻译"**——`input` → 同步模型、`compositionstart` → 拦下重渲染、
 * `paste` → 走粘贴事务、拖拽 → 三区放置。把它与「事务／结构操作」混在同一个类里，
 * 会让人以为改结构要动事件代码。
 *
 * **判据**：这里**不持有状态**，所有状态都在注入的 `EditorBridge` 后面。
 * 于是「某个事件该调什么」可以照着代码读出来，而不用在 1000 行的类里追。
 *
 * ⚠️ 两条实测得来的纪律（它们就写在这里，因为这是唯一能保证它们成立的地方）：
 *   1. **组合期（IME composing）不重渲染该块**——否则会打断输入法，`compositionend` 后才补渲染；
 *   2. **键位一个都不在这里处理**——全部交给绑定表，这里只碰「输入与拖拽」。
 */
import { bindDropTarget, setDragBlock, zoneHint } from './dnd.ts'
import type { TriggerChar } from '../core/trigger.ts'
import type { RunWithId } from '../core/runs.ts'

/**
 * 「指向某块的露面」被点时按下了哪些修饰键。
 *
 * ⚠️ 只传**判据**（修饰键），不传 `MouseEvent`：事件层不是 DOM 类型的分发处，
 *    再往上的消费者（装配层、UI 组件）不该为了读一个 `altKey` 拿到整个原生事件。
 */
export interface RefClickMods {
  altKey: boolean
  shiftKey: boolean
}

/**
 * 一次「指向某块的露面」被点：**去哪**（`to`）＋ **它自己的身份**（`run`，可无）。
 *
 * ⚠️ `to` 与 `run` 指的不是同一个东西：`to` 是**目标块**（点了去哪），`run` 是**这枚露面
 *    自己的行内对象**（有它才有「详情／删引用」可做）。chip 与属性区的标签名只有归属、
 *    没有 run —— 这也是为什么它们不弹详情浮层：那里没有可看可删的东西。
 * ⚠️ `to` 为空串 ＝ 这枚不是块引用（图片／外链），只能弹详情。
 */
export interface RefClickHit {
  to: string
  run?: RunWithId
}

/**
 * 浮层要的「此刻在敲什么」。
 *
 * ⚠️ 只报**触发字符与查询词**，不带偏移：抹掉这段字的偏移由编辑器自己算
 *    （投影坐标 ↔ plain 坐标的换算在 runs 层，事件层不需要认识）。
 */
export interface TriggerQuery {
  ch: TriggerChar
  query: string
}

/**
 * 编辑器暴露给事件层的动作面。
 * ⚠️ 全是方法而不是状态：事件层不该知道 `doc`／`marks`／`sel` 长什么样。
 */
export interface EditorBridge {
  /** 容器元素（真编辑区）*/
  container: HTMLElement
  /**
   * **「点空白建块」的监听面**。
   *
   * ⚠️ 与 `container` 分开是**实测逼出来的**：`#editor` 是 `width:100%` 的块级 div，
   *    高度只包住它的块；它下方那段「还能往下写」的气口属于 `#scroll` ⇒ 点那里时
   *    事件目标根本不是编辑器，`container` 上的 `click` 监听器**不会触发**
   *    （2026-10-20 探针复现：点 y=500..700 全部命中 `#scroll`，一个块都没建）。
   *    所以「空白处」必须是**编辑器连同它的气口**这一整块，由装配层给出。
   */
  blankArea: HTMLElement
  /** 某个 DOM 节点属于哪个块 */
  blockOf: (node: Node | null) => string | null
  /** 从 DOM 选区刷新模型选区 */
  syncSel: () => void
  /** 光标当前落在哪个块（没有就是 null）。`focusout` 靠它判断「离开的是哪一行」 */
  caretBlock: () => string | null
  /**
   * **把跑到正文槽之外的插入点收回来**（见 `BlockEditor.reclaimCaret`）。
   *
   * @returns 真的收回了一次 ＝ 这次的输入/选中发生在「不该有光标的地方」，调用方要拦掉它
   */
  reclaimCaret: () => boolean
  /**
   * **编辑边界**：把这一行的正文当作一次改名提交（撞名则回滚并报给装配层）。
   * 只在「离开这一行」时调 —— 逐字符校验会打死输入法。
   */
  commitEdit: (id: string) => void
  /**
   * 收掉跨块选区（首尾拼成一块）。
   *
   * 返回光标应落到的块 id；`null` ＝ 当前不是一个跨块选区。
   * 事件层在 `input` 里先调它，否则「选中多块再打字」只会删掉 DOM 里的字，
   * 模型里那些块一块都没少。
   */
  collapseSelection: () => string | null
  /** 把某个块的 DOM 文本同步回模型；`reRender` 为 false 时不重渲染（组合期专用）*/
  syncFromDom: (id: string, reRender: boolean) => void
  /** 光标前是不是在敲一个触发词（`/`／`#`／`@`）——由装配层决定弹不弹浮层 */
  emitTrigger: (id: string) => void
  /** 触发词被消费掉之后从正文里抹掉（`#查询词`／`@查询词`／`/查询词`） */
  dropTrigger: (id: string) => void
  /** 插入一行纯文本（多行粘贴用）*/
  insertPlainText: (id: string, offset: number, text: string) => void
  /**
   * 拖拽落点：**视觉反馈（`.dragging`／`data-drop`）由编辑器自己画**，事件层只报坐标与判定。
   * 这样事件层不需要知道 CSS 类名，编辑器也不需要知道 DnD 事件的形状。
   */
  showDropTarget: (el: HTMLElement | null, zone: 'before' | 'after' | 'inside' | null) => void
  /** 开始拖某块（编辑器负责加 `.drag-src`）*/
  beginDrag: (id: string) => void
  /**
   * 这个 id 能不能落到正文里。
   *
   * 判据只有一条：**它是这一份文档里的内容块**（段根不参与 —— 页／天／查询记录
   * 的先后是「真实日期序」或「视图序」，都不是可拖的兄弟序）。
   * 「不能拖进自己的子树」不在这里：那是**落点对目标**的判定，在 `dropMove` 里自带守卫。
   */
  acceptDrag: (id: string) => boolean
  /** 松手：编辑器按落点改结构（含撤销记录与重渲染）*/
  dropDrag: (draggedId: string, targetId: string | null, zone: 'before' | 'after' | 'inside') => void
  /** 结束拖拽（清掉预览）*/
  endDrag: () => void
  /** 当前是否处于组合期 */
  composing: () => boolean
  /** 记录组合序列（诊断用）*/
  noteComposition: (step: 'start' | 'update' | 'end') => void
  /** 该块有没有子块（拖到 inside 要判）*/
  hasChildren: (id: string) => boolean
  /**
   * **点了一个「指向某块的露面」**——行内原子、行尾标签 chip、属性区的标签名，
   * 全是同一件事，所以只有一个入口。
   *
   * `ref.to` 是**目标块**（去哪；空串 ＝ 这枚不是块引用，例如图片／外链），
   * `ref.runId` 是这枚露面自己的 run id（有它才有「详情／删引用」可做；
   * chip 与属性区只有归属，没有 run）。
   * `mods` 带修饰键：左键默认打开，⌥ 才看详情。
   *
   * ⚠️ 事件层只报「点到了谁」，不判「该不该导航」：目标可能刚被删掉，
   *    那要现查森林，而森林在装配层手里。
   */
  onRefClick: (ref: { to: string; runId?: string }, el: HTMLElement, mods: RefClickMods) => void
  /** 打开块菜单（悬停把手/圆点或右键）*/
  onBlockMenu: (blockId: string, rect: DOMRect) => void
  /**
   * **跨块拖选**：在 `.tx` 内按下 / 移动 / 松开。
   * 事件层只报坐标；「是否切成块选区」的判定在编辑器里（单块内仍是原生文本选择）。
   */
  beginMouseSelect: (blockId: string, clientX: number, clientY: number, shiftKey: boolean) => void
  updateMouseSelect: (clientX: number, clientY: number) => boolean
  endMouseSelect: () => void
  /** 是否可以跳过 mouseup 的文本选区同步（块选区激活时） */
  hasBlockSelection: () => boolean
  /**
   * **左键点块标**＝ 聚焦/zoom。
   * ⚠️ 与 `onBlockMenu` 分开：「左键聚焦、右键菜单」，
   *    把两者合成一个入口就永远只能实现其中一种。
   */
  focusBlock: (blockId: string) => void
  /** Shift+左键点块标（待办行的方框也是块标）＝ 在右槽钉住 / 取消钉住 */
  openInDock: (blockId: string) => void
  /**
   * **面包屑普通点击 ＝ 就地展开上下文**；`rowId` 是这一格所在的行。
   * 省略 ⇒ 事件层退回 `focusBlock`（不是所有编辑器都有「一栏可装载的根」）。
   */
  expandContext?: (ancestorId: string, rowId: string) => void
  /** 展开根行首的「收起上下文」：收掉这一层，露出下一层 */
  contextBack?: (rootId: string) => void
  /**
   * 折叠 / 展开某块（点三角）*/
  toggleCollapse: (blockId: string) => void
  toggleChildrenCollapse: (blockId: string) => void
  /**
   * **点空白处 ⇒ 建一个顶层空块**。
   *
   * 判据：我们的编辑器是**单 contenteditable 容器 ＋ 扁平块 DOM**，容器里不属于
   * 任何 `.blk` 的区域（行尾气口、窗口外的占位）**没有块可落光标** ⇒ 点那里毫无反应。
   * 常见解法是「最后一块下方悬停出一个 `+`，点击建**无缩进的顶层块**并落光标」。
   * 我们用更省的形状：**点空白即建**，不画常驻 `+`（悬停才现的图标是可发现性成本，
   * 我们用「点了就有反应」换它）。
   *
   * ⚠️ 返回 false 表示「这里不该由我处理」（例如点中的其实是个块）——调用方据此
   *    决定是否 preventDefault。**不返回布尔就无法区分「没建」与「建了」**。
   */
  clickEmptyArea: (clientY: number, clientX: number) => boolean
  /** 点进空天格子（复盘兜底）：物化那一天由装配层负责，事件层只报日期 */
  onShellActivate: (date: string) => void
  /** 勾选 / 取消待办（点方框）*/
  toggleTodo: (blockId: string) => void
  /**
   * **点了正文里的组件行**（`.widget-row`）。
   *
   * 与 `onRefClick` 分开：那一支是「点了一个指向某块的**行内对象**」，这里是「点了
   * 一整行**组件**」。对象有 run（可看可删），组件行只有摘要 —— 混成一支会让
   * 「⌥ 看详情」在组件行上变成「按了没反应」（它没有 run 可弹）。
   *
   * 修饰键分工沿用既有口径：**Shift ＝ 换目的地，不换动作**
   * （左键开中心／Shift 开右槽），与 `focusBlock`／`openInDock` 那一对同形。
   */
  onWidgetRowClick: (blockId: string, shiftKey: boolean) => void
  /** 任何模型变化 */
  onChange: () => void
  /** 重挂载窗口后 */
  onMounted: () => void
  /** 焦点离开编辑岛之后补一次被推迟的结构重排（见 `reloadFromStore`） */
  flushPendingReload: () => void
  /** 排一次「补做」（200ms 后；按下/抬起的间隙里不重排） */
  armFlush: () => void
  /** 指针按下/抬起（按下期间不重排：重排会把 `click` 从按钮上弄丢，见绑定处） */
  setPointerDown: (down: boolean) => void
}

/** 拖拽时的目标区域判定：竖直三分（上 1/4 before、下 1/4 after、中间 inside）*/
function dropZone(el: HTMLElement, y: number): 'before' | 'after' | 'inside' {
  const r = el.getBoundingClientRect()
  const q = r.height / 4
  if (y < r.top + q) return 'before'
  if (y > r.bottom - q) return 'after'
  return 'inside'
}

/**
 * 给同一个祖先的**所有**导轨段点亮/熄灭（④）。
 *
 * 为什么不能只靠 `:hover`：一条父块的线被切成 d 段、分散在 d 行上，
 * 鼠标从第 k 段移到第 k-1 段会经过**别的行**——单段 `:hover` 会在跨行时闪烁。
 * 同 id 全段一起亮，看起来才是「一整条线在响应」。
 */
function setHotRail(root: HTMLElement, ancestorId: string, on: boolean): void {
  for (const el of root.querySelectorAll<HTMLElement>(`[data-fold-line-for="${ancestorId}"]`)) {
    el.classList.toggle('hot', on)
  }
}

/**
 * 装上所有编辑区事件。
 * @returns 卸载函数（测试与热重载用；`BlockEditor` 在 demo 里不卸载）
 */
export function bindEditorEvents(br: EditorBridge): () => void {
  const c = br.container
  const off: (() => void)[] = []
  const on = <K extends keyof HTMLElementEventMap>(
    target: HTMLElement | Document,
    type: K | string,
    fn: (e: never) => void,
    opts?: AddEventListenerOptions,
  ): void => {
    target.addEventListener(type, fn as EventListener, opts)
    off.push(() => target.removeEventListener(type, fn as EventListener, opts))
  }

  /**
   * **指针按下的这一小段时间里不重排 DOM**。
   *
   * 为什么：`click` 的生灭要求按下与抬起落在同一个节点上。若两次之间本视图重排一次
   * （很常见：点按钮时里层编辑器失焦 ⇒ 提交一次编辑 ⇒ 别的视图 `touch`），
   * 按钮会被搬到别处，Chrome 就**不派发 `click`** —— 用户看到的是「这颗按钮点了没反应」。
   * 实测：同一颗刷新按钮，真鼠标点击不触发、脚本 `.click()` 触发。
   * ⇒ 按下期间只记「该重排了」，抬起后再补（`flushPendingReload`）。
   */
  on(document, 'pointerdown', () => br.setPointerDown(true), { capture: true })
  on(
    document,
    'pointerup',
    /**
     * ⚠️ **不在这里立刻放开**：`pointerup` 之后紧跟着 `mouseup` 与 `click`（同一个任务）。
     *    `mouseup` 那条路会提交一次编辑 ⇒ `store.touch` ⇒ 别的视图重排 DOM ⇒
     *    正在被按的元素被换掉 ⇒ 浏览器**不派发 `click`**（实测：挂载区里的块标/文本点上去没反应）。
     *    ⇒ 放开推到下一拍，让 `click` 先派发完。
     */
    () => window.setTimeout(() => br.setPointerDown(false), 0),
    { capture: true },
  )

  /* ── 选区 ───────────────────────────────────────────── */
  on(document, 'selectionchange', () => {
    if (!c.contains(document.getSelection()?.anchorNode ?? null)) return
    br.syncSel()
  })

  // 焦点离开编辑区时也要把选区同步一次：否则"最后一次点的地方"会丢
  on(c, 'beforeinput', (e: InputEvent) => {
    /**
     * ⚠️ **插入点不在可写正文槽里就不许输入**（`reclaimCaret` 的入口守卫）。
     *
     * 场景：行首按 `←` 会把插入点挤出 `.tx`（落到行容器 `.blk` 里），接着打字，字就
     * 变成挂在 `.blk` 上的裸节点 —— 渲染在块标左侧（看起来像「写在这一块前面」），
     * 而 `readRuns` 只读 `.tx` ⇒ 模型里没有，重渲染一过就消失。
     * 所以在这里先收回光标，再吞掉这一笔输入：宁可少打一个字，也不留看不见的脏数据。
     *
     * ⚠️ 组合期（IME）不碰：拦掉 `beforeinput` 会打断输入法，而组合期的中间态本来就
     *    不该按「一次插入」来判。组合结束后 `compositionend` 会走 `syncFromDom`，
     *    那时再收（`syncSel` → `reclaimCaret`）。
     */
    if (!br.composing() && br.reclaimCaret()) {
      e.preventDefault()
      return
    }
    br.syncSel()
  })
  on(c, 'mouseup', () => {
    // 块选区激活时不要再 syncSel：mouseup 后浏览器可能恢复一个非折叠 Range，
    // 会把刚建好的块选区立刻清掉（本机探针复现）。
    if (!br.hasBlockSelection()) br.syncSel()
    else document.getSelection()?.removeAllRanges()
    br.onChange()
  })

  /* ── 跨块拖选：单块内仍是文本；拖过块边界才切块选区 ── */
  on(c, 'mousedown', (e: MouseEvent) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    const tx = target.closest<HTMLElement>('.tx')
    if (!tx || tx.closest('[data-readonly]')) return
    const blk = tx.closest<HTMLElement>('[data-block-id]')
    if (!blk?.dataset.blockId) return
    br.beginMouseSelect(blk.dataset.blockId, e.clientX, e.clientY, e.shiftKey)
  })
  on(document, 'mousemove', (e: MouseEvent) => {
    if (br.updateMouseSelect(e.clientX, e.clientY)) e.preventDefault()
  })
  on(document, 'mouseup', () => br.endMouseSelect())
  on(c, 'keyup', (e: KeyboardEvent) => {
    br.syncSel()
    void e // 按键命中追踪在 dispatch 层，这里只需要"松手后同步"
    br.onChange()
  })
  on(c, 'focus', () => {
    br.syncSel()
    br.onChange()
  })
  /**
   * **失焦 ＝ 编辑边界**：离开一行时把它的正文当作一次改名提交。
   *
   * ⚠️ 判据不是「有没有 focusout」：整片编辑区共用**一个**焦点，块与块之间移动也会走这里
   *    （`focusout` 的 target 是容器本身，看不出离开的是哪一行）。
   *    所以判据是「离开的块 id 变了没有」——移动到同一块内（或 relatedTarget 仍在本块）
   *    不算离开，否则在块中间点一下就把编辑提前结了。
   */
  on(c, 'focusout', (e: FocusEvent) => {
    const from = br.caretBlock()
    if (!from) return
    const to = e.relatedTarget instanceof Node ? br.blockOf(e.relatedTarget) : null
    if (to === from) return
    br.commitEdit(from)
  })

  /**
   * **焦点离开编辑岛之后补上被推迟的结构重排**。
   *
   * 嵌在本视图里的挂载区／查询视图也是编辑器；它们拿着焦点时本视图不做全量重排
   * （搬 DOM 会把它们的光标扔掉，见 `BlockEditor.reloadFromStore`）。等焦点真的离开，
   * 那些推迟的重排在这里一次补上——否则「在挂载区里删掉一行」之后正文会停在旧形状。
   */
  on(c, 'focusout', () => {
    // ⚠️ 排到 `armFlush`（200ms）而不是 `setTimeout(…, 0)`：焦点变化常常发生在**按下**那一瞬，
    //    0 毫秒就补一次重排会把正在被按的按钮换掉 ⇒ `click` 不派发（实测）。
    br.armFlush()
  })

  /* ── 输入与组合（**不打断 IME**）────────────────────── */
  on(c, 'input', () => {
    /**
     * ⚠️ **先收跨块选区**：浏览器会把整段内容删掉，但模型里那些块一块都没少
     *    ⇒ 不收的话重渲染时它们又全回来了（看起来像「删除没生效」）。
     * 收拢之后光标落在拼接块里，下面照常同步这一块的文本。
     */
    const collapsed = br.collapseSelection()
    if (collapsed) {
      br.syncFromDom(collapsed, true)
      if (!br.composing()) br.emitTrigger(collapsed)
      return
    }
    /**
     * **先信模型光标，DOM 选区只作旁证**：Chrome 在 `input` 派发的那一刻，
     * `getSelection().anchorNode` 可能报成**另一个块**的 `#text`（offset 0，实测）。
     * 照 DOM 选区写会把那一块的正文顺手改一遍（它的 run 序列被重建成别的东西）；
     * 模型光标由 `selectionchange`/`beforeinput` 先行同步，比这一刻的 DOM 更可信。
     */
    const id = br.caretBlock() ?? br.blockOf(document.getSelection()?.anchorNode ?? null)
    if (!id) return
    br.syncSel()
    // 组合期不重渲染（否则打断输入法）；合成结束时会补渲染
    br.syncFromDom(id, !br.composing())
    if (!br.composing()) br.emitTrigger(id)
  })

  on(c, 'compositionstart', () => {
    br.noteComposition('start')
    br.onChange()
  })
  on(c, 'compositionupdate', () => br.noteComposition('update'))
  on(c, 'compositionend', () => {
    br.noteComposition('end')
    const id = br.blockOf(document.getSelection()?.anchorNode ?? null)
    if (id) {
      br.syncSel()
      br.syncFromDom(id, true)
      br.emitTrigger(id)
    }
    br.onChange()
  })

  /* ── 粘贴（多行 = 多块，**绝不把换行塞进一个块**）── */
  on(c, 'paste', (e: ClipboardEvent) => {
    e.preventDefault()
    const text = e.clipboardData?.getData('text/plain') ?? ''
    const sel = document.getSelection()
    const id = br.blockOf(sel?.anchorNode ?? null)
    if (!id || !sel) return
    br.syncSel()
    br.insertPlainText(id, 0, text)
  })

  /* ── 点击：原子 / 块标聚焦 ─────────────────────────── */
  on(br.blankArea, 'click', (e: MouseEvent) => {
    /**
     * ⚠️ **必须用 `composedPath()`，不能用 `target.closest()`**（2026-10-20 探针抓到的真 bug）：
     *    面包屑与块标左键都会触发 **zoom ⇒ 整棵树重渲染**，那一刻被点的元素已从 DOM 摘掉；
     *    事件继续冒泡到这里时，`detachedElement.closest('#crumbs-trail')` 恒为 null
     *    ⇒ 误判成「点了空白」⇒ **zoom 的同时顺手建一个空块**（探针实测：点面包屑后块数 +1）。
     *    `composedPath()` 在**派发时**就把整条路径快照下来，元素被摘掉也还在数组里。
     * ⚠️ 这条对块标同样致命（块标＝zoom）：所以 `.blk` 与 `#crumbs-trail` 都要进判据。
     */
    const path = e.composedPath()
    const inBlock = path.some((n) => n instanceof HTMLElement && n.classList.contains('blk'))
    const inCrumb = path.some((n) => n instanceof HTMLElement && n.id === 'crumbs-trail')
    /**
     * **别的视图**（挂载区 / 查询结果 / 反链）各有自己的编辑器实例，而它们的 DOM 可能落在
     * 正文的 `blankArea`（`#scroll`）里面 ⇒ 点它们时事件也会冒到**正文**的这套监听上。
     *
     * 判据：路径里有没有某个「视图根」，且它**不是本实例所属的那一棵**
     * （`nestedRoot.contains(br.container)`）。这样两种挂法都对：
     *   · 视图挂在正文之外（右槽/旧 footer）⇒ 本实例的 container 不在它里面 ⇒ 交还；
     *   · 视图嵌在正文的段里（块底的挂载区）⇒ 本实例的 container 也不在它里面 ⇒ 交还；
     *   · 视图**自己**的点击 ⇒ container 在视图根内 ⇒ 继续往下走（否则它自己的块标永远没反应）。
     */
    const nestedRoot = path.find(
      (n): n is HTMLElement =>
        n instanceof HTMLElement &&
        (n.classList.contains('mount') || n.classList.contains('queryview')),
    )
    if (nestedRoot && !nestedRoot.contains(br.container)) return

    /**
     * 空天格子（复盘兜底）：整列都是纯 DOM，点任何地方＝「开始写这一天」。
     * 必须最先判——格子里的行复用了 `.blk` 的视觉（没有 blockId），
     * 落进后面的块分支或「点空白建块」都会把它吞掉。
     */
    const shellSec = path.find(
      (n): n is HTMLElement => n instanceof HTMLElement && n.classList.contains('sec') && n.dataset.shell !== undefined,
    )
    if (shellSec?.dataset.shell) {
      br.onShellActivate(shellSec.dataset.shell)
      e.preventDefault()
      return
    }

    /**
     * **「收起上下文」**：收掉这一层展开，露出下一层（退完就是原始命中行）。
     */
    const backEl = path.find((n): n is HTMLElement => n instanceof HTMLElement && n.dataset.contextBackFor !== undefined)
    if (backEl?.dataset.contextBackFor) {
      br.contextBack?.(backEl.dataset.contextBackFor)
      e.preventDefault()
      return
    }

    /**
     * **面包屑一格**：普通点＝就地展开上下文；⌘/Ctrl 点＝跳转；Shift 点＝右槽。
     * `rowId` 是这一格所在的行（原始命中或已展开的上下文根），用来算展开后滚到哪。
     */
    const crumbEl = path.find((n): n is HTMLElement => n instanceof HTMLElement && n.dataset.crumbFor !== undefined)
    if (crumbEl?.dataset.crumbFor) {
      const ancestor = crumbEl.dataset.crumbFor
      if (e.shiftKey) {
        br.openInDock(ancestor)
      } else if (e.metaKey || e.ctrlKey) {
        br.focusBlock(ancestor)
      } else if (br.expandContext) {
        const rowEl = path.find(
          (n): n is HTMLElement => n instanceof HTMLElement && n.classList.contains('blk') && n.dataset.blockId !== undefined,
        )
        br.expandContext(ancestor, rowEl?.dataset.blockId ?? '')
      } else {
        // 没有「一栏可装载的根」的编辑器：退回旧行为，不让点击看起来像成功
        br.focusBlock(ancestor)
      }
      e.preventDefault()
      return
    }

    /**
     * **指向某块的露面**（行内引用／行尾标签 chip）：同一句话，不分形状。
     *
     * 判据是 `data-ref-to` 而不是 `classList.contains('atom')`：chip 不是原子
     * （不占正文、没有 run），但它和原子是同一件事的两种露面 —— 「点了一个指向 X 的东西」。
     * 只认 `.atom` 的话，每多一种露面就要在这里多一条分支，而漏掉的那一种会静默不响应。
     */
    /**
     * **正文里的组件行**（`.widget-row`）：点它 ＝ 打开这张卡。
     *
     * ⚠️ 这一支在「指向某块的露面」**之前**：组件行是 `contenteditable=false` 的整行，
     *    它内部没有 `data-ref-to`，而它所在的那一行**有** block id —— 两条判据不冲突，
     *    但顺序写反会让读者以为「组件行靠行内引用那条路工作」。
     * ⚠️ 用 `composedPath()` 而不是 `target.closest()`：与面包屑那一条同一条实测理由
     *    （点它 ⇒ 换中心 ⇒ 整棵树重渲染 ⇒ 被点元素已从 DOM 摘掉，`closest` 恒为 null）。
     */
    const widget = path.find((n): n is HTMLElement => n instanceof HTMLElement && n.dataset.widgetRow !== undefined)
    if (widget?.dataset.widgetRow) {
      e.preventDefault()
      br.onWidgetRowClick(widget.dataset.widgetRow, e.shiftKey)
      return
    }

    const refEl = path.find((n): n is HTMLElement => n instanceof HTMLElement && n.dataset.refTo !== undefined)
    if (refEl?.dataset.refTo) {
      br.onRefClick({ to: refEl.dataset.refTo, ...(refEl.dataset.atomId ? { runId: refEl.dataset.atomId } : {}) }, refEl, {
        altKey: e.altKey,
        shiftKey: e.shiftKey,
      })
      e.preventDefault()
      return
    }

    /**
     * 非引用的行内对象（图片／外链）：它们没有目标块，只有一枚 run 可看可删。
     * ⚠️ 这一支必须在上面那支**之后**：它是「没有 `data-ref-to` 的原子」，
     *    而上面那一支只认有目标的露面。
     */
    const atomEl = path.find((n): n is HTMLElement => n instanceof HTMLElement && n.classList.contains('atom'))
    if (atomEl?.dataset.atomId) {
      br.onRefClick({ to: '', runId: atomEl.dataset.atomId }, atomEl, { altKey: e.altKey, shiftKey: e.shiftKey })
      e.preventDefault()
      return
    }

    /**
     * **点空白处 ⇒ 建顶层空块**。
     *
     * 判据是「路径里没有 `.blk` 也没有面包屑」——扁平 DOM 下行与行之间的真实事件目标
     * 常常既不是容器也不是块（是 `#scroll`／`#doc` 这类祖先），那正是要救的场景。
     * ⚠️ 用 `click` 而不是 `mousedown`：gutter 三件（折叠/导轨/待办）走 mousedown 且
     *    已 `preventDefault`，所以它们**不会**走到这里；而点空白要在鼠标抬起后建块，
     *    否则一次拖拽选择文字也会顺带建块。
     */
    if (!inBlock && !inCrumb) {
      // 块选区刚拖出来时，mouseup 后的 click 可能落在空白区 ⇒ 不能当成「点空白建块」
      if (br.hasBlockSelection()) return
      if (br.clickEmptyArea(e.clientY, e.clientX)) e.preventDefault()
      return
    }

    /**
     * 块标左键 ＝ **聚焦/zoom**。
     * ⚠️ 菜单改到**右键**：`contextmenu` 那一支已经在做这件事（见下），
     *    所以这里不再有「左键也开菜单」的分支。
     */
    const marker = path.find((n): n is HTMLElement => n instanceof HTMLElement && 'focusFor' in n.dataset)
    if (marker?.dataset.focusFor) {
      // Shift+左键 ⇒ 钉到右槽（同一个入口可逆：已钉住则取消）
      if (e.shiftKey) {
        e.preventDefault()
        br.openInDock(marker.dataset.focusFor)
      } else {
        br.focusBlock(marker.dataset.focusFor)
      }
    }
  })

  on(c, 'contextmenu', (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-block-id]')
    if (!el?.dataset.blockId) return
    e.preventDefault()
    br.onBlockMenu(el.dataset.blockId, new DOMRect(e.clientX, e.clientY, 0, 0))
  })

  /* ── gutter 上的三个动作：折叠三角 / 导轨 / 待办方框 ── */
  // ⚠️ 用 mousedown 而不是 click：gutter 是 contenteditable=false 的兄弟节点，
  //    click 之前浏览器会先移动插入点，导致「点折叠时顺便把光标挪走」。
  on(c, 'mousedown', (e: MouseEvent) => {
    const target = e.target as HTMLElement

    /**
     * ⓞ **插入点只准落在可写正文槽（`.tx`）里**。gutter、行容器的空白、只读行
     *    （journal 的日期）都算「正文之外」，在这里一律不移动插入点。
     *
     * 为什么必须自己挡：整片编辑区是**一个** contenteditable 容器，行容器 `.blk`
     * 因此也是可编辑的。当点到的地方没有可写正文时，浏览器会把插入点放进**行容器自己**
     * （或它旁边）—— 那一处不属于任何 `.tx`，打出来的字就以**裸文本节点挂在 `.blk` 里**：
     * `readRuns` 只读 `.tx` ⇒ 模型拿不到，重渲染一过就消失，可用户当场看得见
     * （表现为「点这一行的竖线，光标跳到块标左边，还能打字」）。
     * `contenteditable=false` 只挡住「往里打字」，挡不住浏览器在外面找一个落点，
     * 所以拦在 `mousedown`：默认行为不发生 ＝ 插入点原地不动。
     *
     * ⚠️ 豁免**拖拽把手**（`data-drag-for`，也就是块标）：把手走原生 `dragstart`，
     *    `mousedown` 被吞掉连拖拽一起没（实测：preventDefault 之后 `dragstart` 一次都不派发）。
     *    它的落点由 `click` 那一条收尾（点块标＝聚焦，本来就要重新放光标）。
     */
    const tx = target.closest<HTMLElement>('.tx')
    const inWritable = Boolean(tx && !tx.closest('[data-readonly]'))
    if (!inWritable && !target.closest('[data-drag-for]') && target.closest('.blk')) {
      e.preventDefault()
    }

    // ① 折叠三角：只给有子块的行生成，所以这里不需要判 empty
    const fold = target.closest<HTMLElement>('[data-fold-for]')
    if (fold?.dataset.foldFor) {
      e.preventDefault()
      br.toggleCollapse(fold.dataset.foldFor)
      return
    }

    /**
     * ② **可点导轨**（④）：点哪一段就折叠哪一层祖先。
     *    `preventDefault` 与三角同理由——点线不该顺便把光标挪走。
     */
    const rail = target.closest<HTMLElement>('[data-fold-line-for]')
    if (rail?.dataset.foldLineFor) {
      e.preventDefault()
      br.toggleChildrenCollapse(rail.dataset.foldLineFor)
      return
    }

    /**
     * ③ 待办方框：**一块独立的命中区**，挂在块标的身份后缀上（不是块标本身）。
     *    它也走 preventDefault —— 勾选不该顺便把光标挪走。
     *    ⚠️ 它和上面「点块标＝聚焦」互不遮挡：块标上只有 `data-focus-for`，
     *       方框上只有 `data-todo-for`，一次点击只可能命中其中一个。
     */
    const todo = target.closest<HTMLElement>('[data-todo-for]')
    if (todo?.dataset.todoFor) {
      e.preventDefault()
      // 方框的动作是「切换完成」，不是「打开」——Shift 不改变它。
      // 「在右槽打开」的入口是块标/行/引用，统一由装配层的 openInDock 承担。
      br.toggleTodo(todo.dataset.todoFor)
    }
  })

  /**
   * 导轨的**跨段悬停**：同一条线的段分散在多行上，单段的 `:hover` 只能亮自己。
   * ⇒ 给同 id 的**所有**可见段加 `.hot`；离开时用 `relatedTarget` 判断
   * 「是不是移到了同 id 的相邻段」，是的话不清（否则闪）。
   */
  on(c, 'pointerover', (e: MouseEvent) => {
    const rail = (e.target as HTMLElement).closest<HTMLElement>('[data-fold-line-for]')
    if (!rail?.dataset.foldLineFor) return
    setHotRail(br.container, rail.dataset.foldLineFor, true)
  })
  on(c, 'pointerout', (e: MouseEvent) => {
    const rail = (e.target as HTMLElement).closest<HTMLElement>('[data-fold-line-for]')
    if (!rail?.dataset.foldLineFor) return
    const next = e.relatedTarget as HTMLElement | null
    if (next?.closest(`[data-fold-line-for="${rail.dataset.foldLineFor}"]`)) return
    setHotRail(br.container, rail.dataset.foldLineFor, false)
  })

  /* ── 拖拽重排（HTML5 DnD，三区判定）────────────────── */
  // 拖源只报「我是谁」；载荷形状与悬停记忆在 `view/dnd.ts`（跨组件共用的那一份）
  on(c, 'dragstart', (e: DragEvent) => {
    const handle = (e.target as HTMLElement).closest<HTMLElement>('[data-drag-for]')
    if (!handle?.dataset.dragFor) return
    setDragBlock(e.dataTransfer, handle.dataset.dragFor)
    br.beginDrag(handle.dataset.dragFor)
  })

  // 落点：正文三区。含义（移到这里／移入／移到后面）由**这个落点**说，模块只管贴出来
  off.push(
    bindDropTarget(c, {
      attr: 'drop',
      effect: 'move',
      // 段根（页／天／查询记录）不参与拖拽；未知 id 也不接（别人的载荷可能不是块）
      accept: (id) => br.acceptDrag(id),
      targetId: (e) => rowOf(e)?.dataset.blockId ?? null,
      hint: (_id, e) => zoneHint(zoneOf(e)),
      // 三区各有各的高亮线：由编辑器自己画（模块不认识 CSS 类名）
      mark: (_id, e) => {
        const el = rowOf(e)
        if (el) br.showDropTarget(el, zoneOf(e))
        else br.showDropTarget(null, null)
      },
      unmark: () => br.showDropTarget(null, null),
      onDrop: (draggedId, targetId, e) => {
        const el = rowOf(e)
        const zone = el ? zoneOf(e) : 'after'
        br.dropDrag(draggedId, targetId, targetId && zone === 'inside' && !br.hasChildren(targetId) ? 'after' : zone)
        br.onMounted()
      },
    }),
  )
  on(c, 'dragend', () => br.endDrag())

  return () => {
    for (const f of off) f()
    off.length = 0
  }
}

export { dropZone }

/** 事件落在哪一行（`.blk`；没有就是拖在空白处） */
function rowOf(e: DragEvent): HTMLElement | null {
  return (e.target as HTMLElement | null)?.closest<HTMLElement>('.blk') ?? null
}

/** 三区判定：按指针在行内的高度分上/中/下 */
function zoneOf(e: DragEvent): 'before' | 'after' | 'inside' {
  const el = rowOf(e)
  return el ? dropZone(el, e.clientY) : 'after'
}
