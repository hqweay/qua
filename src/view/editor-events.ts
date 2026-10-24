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
import type { Atom } from '../core/index.ts'

/**
 * 行内原子被点时按下了哪些修饰键。
 *
 * ⚠️ 只传**判据**（修饰键），不传 `MouseEvent`：事件层不是 DOM 类型的分发处，
 *    再往上的消费者（装配层、UI 组件）不该为了读一个 `altKey` 拿到整个原生事件。
 */
export interface AtomClickMods {
  altKey: boolean
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
  /** 光标在 `/查询词` 尾部时上报（由装配层决定弹不弹斜杠菜单）*/
  emitSlashQuery: (id: string) => void
  /** `/查询词` 被消费后从文本里抹掉 */
  dropSlashQuery: (id: string) => void
  /** 插入一行纯文本（多行粘贴用）*/
  insertPlainText: (id: string, offset: number, text: string) => void
  /**
   * 拖拽落点：**视觉反馈（`.dragging`／`data-drop`）由编辑器自己画**，事件层只报坐标与判定。
   * 这样事件层不需要知道 CSS 类名，编辑器也不需要知道 DnD 事件的形状。
   */
  showDropTarget: (el: HTMLElement | null, zone: 'before' | 'after' | 'inside' | null) => void
  /** 开始拖某块（编辑器负责加 `.drag-src`）*/
  beginDrag: (id: string) => void
  /** 松手：编辑器按落点改结构（含撤销记录与重渲染）*/
  dropDrag: (targetId: string | null, zone: 'before' | 'after' | 'inside') => void
  /** 结束拖拽（清掉预览）*/
  endDrag: () => void
  /** 当前是否处于组合期 */
  composing: () => boolean
  /** 记录组合序列（诊断用）*/
  noteComposition: (step: 'start' | 'update' | 'end') => void
  /** 该块有没有子块（拖到 inside 要判）*/
  hasChildren: (id: string) => boolean
  /** 行内原子被点（`mods` 带修饰键：左键默认打开，⌥ 才看详情） */
  onAtomClick: (atomId: string, el: HTMLElement, mods: AtomClickMods) => Atom | undefined
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
  clickEmptyArea: (clientY: number) => boolean
  /** 勾选 / 取消待办（点方框）*/
  toggleTodo: (blockId: string) => void
  /** 任何模型变化 */
  onChange: () => void
  /** 重挂载窗口后 */
  onMounted: () => void
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

  /* ── 选区 ───────────────────────────────────────────── */
  on(document, 'selectionchange', () => {
    if (!c.contains(document.getSelection()?.anchorNode ?? null)) return
    br.syncSel()
  })

  // 焦点离开编辑区时也要把选区同步一次：否则"最后一次点的地方"会丢
  on(c, 'beforeinput', () => br.syncSel())
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
      if (!br.composing()) br.emitSlashQuery(collapsed)
      return
    }
    /**
     * **先信模型光标，DOM 选区只作旁证**：Chrome 在 `input` 派发的那一刻，
     * `getSelection().anchorNode` 可能报成**另一个块**的 `#text`（offset 0，实测）。
     * 直写时代价是「另一块被 mapMarks 洗一遍」；接 tx 后还会为那块多开一个事务。
     * 模型光标由 `selectionchange`/`beforeinput` 先行同步，比这一刻的 DOM 更可信。
     */
    const id = br.caretBlock() ?? br.blockOf(document.getSelection()?.anchorNode ?? null)
    if (!id) return
    br.syncSel()
    // 组合期不重渲染（否则打断输入法）；合成结束时会补渲染
    br.syncFromDom(id, !br.composing())
    if (!br.composing()) br.emitSlashQuery(id)
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
      br.emitSlashQuery(id)
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
     * 反链 footer / 查询结果都有自己的编辑器实例，而它们的 DOM 落在正文的
     * `blankArea`（`#scroll`）里面 ⇒ 点它们时事件也会冒到**正文**的这套监听上。
     * 判据是「路径里有没有**本实例**的 container」：别的视图的点击交还给它自己那份绑定，
     * **本实例**的点击（含它自己的块标/原子）必须继续往下走，否则 footer 点块标永远没反应。
     */
    const inOwnEditor = path.includes(br.container)
    const inNestedView = path.some(
      (n) =>
        n instanceof HTMLElement &&
        (n.classList.contains('backlinks') ||
          n.classList.contains('backlinks-editor') ||
          n.classList.contains('queryview') ||
          n.classList.contains('queryview-editor')),
    )
    if (!inOwnEditor && inNestedView) return

    // 行内原子：交给原子那一条（同样用快照路径，防原子被重渲染摘掉）
    const atomEl = path.find((n): n is HTMLElement => n instanceof HTMLElement && n.classList.contains('atom'))
    if (atomEl?.dataset.atomId) {
      const a = br.onAtomClick(atomEl.dataset.atomId, atomEl, { altKey: e.altKey })
      if (a) e.preventDefault()
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
      if (br.clickEmptyArea(e.clientY)) e.preventDefault()
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
     * ⓞ **只读行（journal 的日期）不落光标**。
     *    `contenteditable=false` 只挡住「往里打字」，挡不住浏览器把插入点放到它旁边
     *    （Chrome 会落到容器的相邻位置 ⇒ 一个不属于任何块的死光标）。
     *    所以这里直接吞掉 mousedown：点日期＝什么也不发生，要写就点下面的空白。
     */
    if (target.closest('[data-readonly]')) {
      e.preventDefault()
      return
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
      // Shift+点击方框 = 「在右槽打开」，**不勾选**（修饰键改变的是动作）
      if (e.shiftKey) br.openInDock(todo.dataset.todoFor)
      else br.toggleTodo(todo.dataset.todoFor)
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
  on(c, 'dragstart', (e: DragEvent) => {
    const handle = (e.target as HTMLElement).closest<HTMLElement>('[data-drag-for]')
    if (!handle?.dataset.dragFor) return
    br.beginDrag(handle.dataset.dragFor)
    e.dataTransfer?.setData('text/plain', handle.dataset.dragFor)
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  })
  on(c, 'dragover', (e: DragEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.blk')
    if (!el) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    br.showDropTarget(el, dropZone(el, e.clientY))
  })
  on(c, 'drop', (e: DragEvent) => {
    e.preventDefault()
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-block-id]')
    const id = el?.dataset.blockId ?? null
    const zone = el ? dropZone(el, e.clientY) : 'after'
    br.dropDrag(id, id && zone === 'inside' && !br.hasChildren(id) ? 'after' : zone)
    br.onMounted()
  })
  on(c, 'dragend', () => br.endDrag())

  return () => {
    for (const f of off) f()
    off.length = 0
  }
}

export { dropZone }
