/**
 * **搜索面的右列**：当前选中那一块的预览。
 *
 * 为什么单独一份：这一列是**一整套状态**（懒建一台编辑器、跨选中复用、折叠表、
 * 命中高亮、删除后回落、关面时的收尾），与左列（冻结的只读结果行）各有各的生命周期。
 * 搬出来之后 `SearchFace` 只回答「选谁」，这一列自己回答「怎么画」。
 *
 * 口径（与搬出来之前逐条一致）：
 *   · 一个 `EditableBlock` 实例**跨选中复用**：换选中只换 roots，不重建——重建一次就丢一次
 *     撤销栈与选区；
 *   · `structuralScope:'roots'`：预览根是派生的结果行，不能并进上一行/搬出结果集；
 *     根内部照常编辑（改字、建子块、删子块）；
 *   · **不传 `viewRootId`**：它不是「标题格」，Enter 要能建子块并**看见**它
 *     ⇒ 子块默认折叠，而拆块动作自己会展开（`splitTx` 的 `unfoldBlock`）；
 *   · 编辑走**同一份 `run`**：落盘、索引增量、撤销都在；**绝不重跑搜索**——
 *     重跑会重排列表并打断正在输入的那一行。
 */
import { hasFoldable, isDeleted, type Block, type BlockStore } from '../../core/index.ts'
import type { KbClient } from '../../core/kb/types.ts'
import { textSpansOf } from '../../core/query/text-spans.ts'
import type { BlockEditor, Run } from '../../view/editor/editor.ts'
import { clearHits, paintHits } from '../../view/editor/hit-paint.ts'
import { EditableBlock } from '../block-ui/editable-block.ts'
import { releaseHighlightKey } from './highlight-key.ts'

export interface PreviewPaneDeps {
  kb: KbClient
  /** 共享 store：预览按 id 现读**活块**（搜索结果只是一批 id，不是块的拷贝） */
  store: BlockStore
  /** 写入事务入口（与正文同一个 `run`，见 `Run`） */
  write: Run
  /** 与正文**同一份**编辑器事件表（右键块菜单 / `#`·`@` / 引用跳转 / 粘贴…） */
  wire: (editor: BlockEditor, change: (kind: string) => void) => void
  /** 当前选中那一块（空串 ＝ 没有选中）。选中归左列，这里只读 */
  targetId: () => string
  /** 选中的块已经软删/真没了：交回左列摘行并换选中 */
  onDrop: (id: string) => void
  /** 右列里真的编辑了（`kind !== 'load'`）：左列先局部改那一行，再落盘 */
  onEdit: (kind: string) => void
  /** 预览获得焦点：装配层把「活动编辑器」切过来（键位走命令层，认的是它） */
  onFocus: (editor: BlockEditor) => void
  /** 面被拆掉：装配层若正把活动编辑器指着预览，要退回正文 */
  onDispose: (editor: BlockEditor) => void
  /** 预览收起、焦点还在里面 ⇒ 交回搜索输入框（焦点不能停在一个看不见的容器里） */
  returnFocus: () => void
  /**
   * 这一块「为什么在结果里」（左行那个「经由」）。
   * 正文命中是默认来路，上层不给这一句（逐行写「经由正文」是噪音）。
   */
  noteOf: (blockId: string) => string | undefined
  /**
   * **只读预览**的初值。仍是同一台 `EditableBlock`，只把「能写」关掉：
   * 宿主不可编辑 ＋ 捕获阶段拦掉会写模型的交互（待办勾选／拖拽／drop／右键菜单）。
   * 为什么不在组件内核加 `readOnly`：那会把「一台编辑器」拆成两种形状；这只是宿主层的守卫。
   *
   * 之后可用 `setReadOnly()` 切换——形态不该逼着宿主重建实例（重建会丢撤销栈与选区）。
   */
  readOnly: boolean
  /**
   * 命中高亮的命名空间（基名）。实际使用前由 `SearchFace` 经 `claimHighlightKey`
   * 取一条本次唯一的 key，拆面时归还。
   */
  highlightKey: string
}

export class PreviewPane {
  /** 右列容器（滚动容器；编辑器宿主是它里面那一格） */
  readonly root: HTMLElement
  private readonly deps: PreviewPaneDeps
  private readonly body: HTMLElement
  /**
   * 编辑器宿主。**不在这里接进 DOM**：`EditableBlock` 会把宿主装进它自己的岛根，
   * 由它把**岛根**接进布局——同一颗元素既当宿主又当岛根的父节点就是自环。
   */
  private readonly host: HTMLElement
  /** 当前列表的查询词：只有它决定滚到哪儿、高亮什么（空词＝不高亮） */
  private term = ''
  private component: EditableBlock | null = null
  /** 已经种过「默认折叠」的块（用户展开过的不再种第二次） */
  private readonly seededFold = new Set<string>()
  /** root 接进文档之后才建编辑器（`BlockEditor` 构造时会量 DOM） */
  private mounted = false
  private disposed = false
  /** 当前是不是只读（构造参数只是初值；`setReadOnly` 可中途换） */
  private readOnly: boolean
  /** 只读守卫的卸载把手：**一套监听一个控制器**，切换时整组摘掉，不留第二份 */
  private guards: AbortController | null = null

  constructor(body: HTMLElement, deps: PreviewPaneDeps) {
    this.body = body
    this.deps = deps
    this.readOnly = false
    this.root = document.createElement('div')
    this.root.className = 'search-face-preview'
    this.host = document.createElement('div')
    this.host.className = 'search-face-preview-editor'
    this.setVisible(false)
    // 构造参数只是初值：装配走同一条切换路径，不另写一份「初始只读」分支
    this.setReadOnly(deps.readOnly)
  }

  /**
   * **只读 ↔ 可编辑**（不重建实例）。
   *
   * 为什么要有这个入口：只读是**宿主形态**，而形态会变（同一台预览在浮层里可编辑、
   * 在只给看的宿主里不可编辑）。若只读在构造期焊死，换形态只能重建 —— 重建一次
   * 就丢一次撤销栈和选区；而旧实例的守卫与 no-op 接线还会留在原地。
   */
  setReadOnly(readOnly: boolean): void {
    if (this.disposed || this.readOnly === readOnly) return
    this.readOnly = readOnly
    if (readOnly) this.installReadOnlyGuards()
    else this.uninstallReadOnlyGuards()
    // BlockEditor 构造时把宿主设成可编辑；切回只读要在这之后落定，切回可编辑要还回去
    if (this.component) this.host.contentEditable = readOnly ? 'false' : 'true'
  }

  /**
   * **root 接进文档之后**再装编辑器。
   *
   * `BlockEditor` 构造时就会渲染并量 DOM；在游离容器上量出来的尺寸/选区是错的
   * （`surface.ts` 是先造身体、随后才 `replaceChildren`）。
   */
  mount(): void {
    if (this.mounted || this.disposed) return
    this.mounted = true
    this.sync()
  }

  /**
   * 装载当前选中。左列在「选中变了 / 列表重画 / 空态变化」之后调它；
   * `term` 是这一份列表的查询词（刷新时按它高亮，而不是输入框里可能刚改过的半截词）。
   */
  sync(term: string = this.term): void {
    if (this.disposed) return
    this.term = term
    const want = this.wanted()
    this.setVisible(want)
    if (!want) {
      // 收起时把预览清空：隐藏的编辑器不该继续挂着上一块（也不该继续被外部变化重载）
      this.clearMatch()
      const ed = this.component?.ed
      if (ed) {
        if (ed.doc.roots.length > 0) ed.loadPage({ roots: [], folded: ed.doc.folded })
        if (ed.ownFocus()) this.deps.returnFocus()
      }
      return
    }
    // 还没接进文档 ⇒ 等 `mount()`；在游离容器上建编辑器会量错尺寸
    if (!this.mounted) return
    this.load(this.ensureEditor())
  }

  /** 已经建起来的那台编辑器的 `BlockEditor`（没有就是 null）：左列判「是不是自己写的」用 */
  get editor(): BlockEditor | null {
    return this.component?.ed ?? null
  }

  /** 左列摘行之后自己会重算选中：这里只同步「右列在不在」这一个属性 */
  setVisible(visible: boolean): void {
    this.body.dataset.preview = visible ? '1' : '0'
  }

  /** `↵` 把焦点放进右列预览（开始编辑）：光标落在这一块的开头 */
  focus(): void {
    // 只读预览没有「开始编辑」这一步：抢走焦点会让搜索框的 ↑↓/打字全失效
    if (this.readOnly) return
    const ed = this.component?.ed
    const id = this.deps.targetId()
    if (!ed || id === '') return
    ed.container.focus()
    ed.placeCaret(id, 0)
  }

  /**
   * **从宿主上摘下来**（不是销毁）：拆编辑器、摘高亮，但保留「选谁 / 词 / 折叠记忆」，
   * 允许之后再次 `mount()`。幂等。
   *
   * 与 `dispose()` 只差一条：这个实例还能再用。两者共用同一份 `teardown()`，
   * 免得「拆干净」这件事出现两个版本。
   */
  unmount(): void {
    if (this.disposed) return
    this.teardown()
    this.mounted = false
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.teardown()
    this.uninstallReadOnlyGuards()
    releaseHighlightKey(this.deps.highlightKey)
  }

  /**
   * 拆编辑器的**唯一**一份（卸载与销毁共用）。
   *
   * ⚠️ `component.root.remove()` 必须显式做：`EditableBlock.dispose()` 只拆订阅与事件，
   * 不把岛根从父节点摘掉——不摘的话重新 `mount()` 会留下**第二份**编辑器 DOM。
   */
  private teardown(): void {
    // 高亮住在**全局注册表**里：面拆掉不摘，它会留在别处（而且没人再清）
    this.clearMatch()
    /**
     * **先把最后一笔推进模型，再拆**。
     *
     * 覆盖层关闭是「先 remove DOM 再还焦点」：`focusout` 那条补 flush 是**延迟一拍**的
     * （`setTimeout(0)`），等不到就 dispose 了。`flush()` 同步收尾，不依赖 blur。
     */
    const component = this.component
    if (!component) return
    // 只读预览没有待提交的编辑：跳过 flush（它读的是可写宿主里的光标）
    if (!this.readOnly) component.flush()
    const ed = component.ed
    if (ed) this.deps.onDispose(ed)
    component.dispose()
    component.root.remove()
    this.component = null
  }

  /** 这一屏该不该有右列：有选中的那一条就有（空词的「最近更新」也走同一套主从布局） */
  private wanted(): boolean {
    return this.deps.targetId() !== ''
  }

  /** 懒建：第一次有选中项时才建这一台（空结果不该建实例） */
  private ensureEditor(): BlockEditor {
    if (!this.component) {
      this.component = new EditableBlock({
        host: this.host,
        store: this.deps.store,
        write: this.deps.write,
        load: (ed) => {
          if (ed) this.load(ed)
        },
        // 预览的根是派生的结果行：不能并进上一行/搬出结果集；根内部照常编辑
        structuralScope: 'roots',
        /**
         * 三个回调**始终接真的**，只在这里按「此刻是不是只读」放行/丢弃：
         * 接线若在构造期被换成 no-op，之后切回可编辑就没有第二条路径能接回来
         * （除非重建实例，而那会丢撤销栈与选区）。
         */
        wire: (editor, change) =>
          this.deps.wire(editor, (kind) => {
            if (!this.readOnly) change(kind)
          }),
        onChange: (kind) => {
          if (!this.readOnly) this.deps.onEdit(kind)
        },
        onFocus: (editor) => {
          if (!this.readOnly) this.deps.onFocus(editor)
        },
      })
      this.root.appendChild(this.component.root)
    }
    const ed = this.component.ed ?? this.component.ensureEditor()
    // BlockEditor 构造时会把宿主设成可编辑；只读要在这之后落定（卸载后重建也走这里）
    if (this.readOnly) this.host.contentEditable = 'false'
    return ed
  }

  /**
   * **只读预览**：同一个 `EditableBlock`，只把「能写」关掉。
   *
   * `contenteditable=false` 只挡打字：待办勾选、原生拖拽、外部 drop、右键块菜单
   * 都挂在**宿主容器**上，照样会触发（而且它们都写模型）。所以在预览根上按捕获阶段
   * 统一拦掉这几类——守卫住宿主层，不改组件内核，也不复制第二台预览。
   *
   * 监听用**一组一个 `AbortController`**：切回可编辑时一次 `abort()` 整组摘掉。
   * 逐个 `removeEventListener` 要求回调引用一一保管，少存一个就静默留一份监听。
   */
  private installReadOnlyGuards(): void {
    if (this.guards) return
    const ac = new AbortController()
    this.guards = ac
    const { signal } = ac
    this.root.dataset.readonly = '1'
    const inside = (target: EventTarget | null): boolean => this.host.contains(target as Node)
    /**
     * 左键按压不挪焦点、不划选：焦点留在搜索框（↑↓/打字继续有效）。
     * 只拦编辑器内——预览留白与滚动条在 `root` 上，拦了会滚不动预览。
     */
    this.root.addEventListener(
      'mousedown',
      (e) => {
        if (!this.readOnly || e.button !== 0 || !inside(e.target)) return
        e.preventDefault()
        this.deps.returnFocus()
      },
      { capture: true, signal },
    )
    // 待办勾选会写模型（`[data-todo-for]` 的 click 在编辑器容器上）
    this.root.addEventListener(
      'click',
      (e) => {
        if (!this.readOnly || !inside(e.target)) return
        if ((e.target as HTMLElement).closest?.('[data-todo-for]')) {
          e.preventDefault()
          e.stopPropagation()
        }
      },
      { capture: true, signal },
    )
    // 原生拖拽（块标拖出/拖入）与外部文件 drop 都会改结构
    this.root.addEventListener(
      'dragstart',
      (e) => {
        if (!this.readOnly || !inside(e.target)) return
        e.preventDefault()
        e.stopPropagation()
      },
      { capture: true, signal },
    )
    for (const type of ['dragover', 'drop'] as const) {
      this.root.addEventListener(
        type,
        (e) => {
          if (!this.readOnly || !inside(e.target)) return
          e.preventDefault()
          e.stopPropagation()
        },
        { capture: true, signal },
      )
    }
    // 右键块菜单：能删块、能改类型，只读预览不该有它
    this.root.addEventListener(
      'contextmenu',
      (e) => {
        if (!this.readOnly || !inside(e.target)) return
        e.preventDefault()
        e.stopPropagation()
      },
      { capture: true, signal },
    )
    /**
     * 焦点只要落进宿主就交回搜索框。
     *
     * `contenteditable=false` 只挡打字：Tab、程序化 `focus()`、辅助工具仍然能把焦点
     * 送进这台编辑器。而键位路由认的是「活动编辑器」——焦点停在这里，↑↓/Enter
     * 就会落到一台不接写入的编辑器上，用户看到的是「按键没反应」。
     */
    this.root.addEventListener(
      'focusin',
      (e) => {
        if (!this.readOnly || !inside(e.target)) return
        this.deps.returnFocus()
      },
      { capture: true, signal },
    )
  }

  /** 切回可编辑：整组摘掉守卫（**卸载是只读的一部分**，否则切换后仍被拦） */
  private uninstallReadOnlyGuards(): void {
    this.guards?.abort()
    this.guards = null
    delete this.root.dataset.readonly
  }

  /**
   * 装什么：**选中的那一块**（按 id 现读活块），面包屑给祖先链。
   *
   * ⚠️ 折叠表**每次从 `ed.doc.folded` 重读**：`writeFold` 每次都换一个新对象，
   *    长期持有一份旧引用会让「用户展开过」在下次装载时丢掉。
   */
  private load(ed: BlockEditor): void {
    if (!this.wanted()) {
      if (ed.doc.roots.length > 0) ed.loadPage({ roots: [], folded: ed.doc.folded })
      return
    }
    const id = this.deps.targetId()
    const block = this.deps.kb.get(id)
    /**
     * 选中的块已经**软删/真没了** ⇒ 回落。
     *
     * 判据含软删：删除是原位标记，`kb.get` 照样取得到它——只看「取不取得到」会让
     * 预览继续画一个已经被删的块（「删了还在这儿」）。回落只走一次（下一块不会是它）。
     */
    if (!block || isDeleted(block)) {
      this.deps.onDrop(id)
      if (!this.wanted()) {
        ed.loadPage({ roots: [], folded: ed.doc.folded })
        return
      }
      const next = this.deps.kb.get(this.deps.targetId())
      if (!next) return
      this.paint(ed, next)
      return
    }
    this.paint(ed, block)
  }

  /** 装载一块进预览：子块默认折叠、面包屑给祖先链 */
  private paint(ed: BlockEditor, block: Block): void {
    const folded = { ...(ed.doc.folded ?? {}) }
    // 子块默认折叠：防「一屏 50 条大树」。只在这一块**第一次被选中**时种一次——
    // 用户展开过的不再种回去（Enter 拆出来的子块因此看得见）
    if (!this.seededFold.has(block.id)) {
      this.seededFold.add(block.id)
      if (hasFoldable(block)) folded[block.id] = true
    }
    const path = this.deps.kb.pathOf(block.id)
    const contexts = path.length > 1 ? new Map([[block.id, path.slice(0, -1)]]) : undefined
    /**
     * **来源说明**：词可能不在正文里（别名/标签/属性/链接命中的情况）。
     * 这一句回答「它为什么在这儿」，与左行那个「经由」同一份来路。
     */
    const note = this.deps.noteOf(block.id)
    const rootNotes = note ? new Map([[block.id, note]]) : undefined
    ed.loadPage({ roots: [block], ...(contexts ? { contexts } : {}), ...(rootNotes ? { rootNotes } : {}), folded })
    /**
     * **滚到命中处并高亮**（换选中就重新定位）。
     *
     * 长块里命中词可能在屏幕外——那样右列就只剩「这一块的开头」，
     * 而用户来这儿就是为了看命中的那一句。
     * 高亮用 CSS Custom Highlight（**不往 contenteditable 里插 `<mark>`**：
     * 那会改模型读数、破坏光标与输入法）。
     */
    this.revealMatch(block)
  }

  /**
   * 把命中词高亮并把预览滚到它那里。
   *
   * 三条边界：
   *   · **没有词**（空态最近更新）⇒ 不高亮、不滚动（没有「命中」可言）；
   *   · **浏览器不支持 `CSS.highlights`** ⇒ 只滚动、不高亮（降级看得见地少一样，不报错）；
   *   · 落点**按模型算**（`textSpansOf` 给出 plain 偏移），不按 DOM 现搜——
   *     一套坐标只算一次：画的区间与滚到的区间是同一批 Range。
   */
  private revealMatch(block: Block): void {
    const term = this.term.trim()
    this.root.scrollTop = 0
    // 上一处的高亮先摘掉：高亮是**全局注册表**里的一条，不摘会留在别的视图上
    this.clearMatch()
    if (term === '') return
    const spans = textSpansOf(block.content, term)
    if (spans.length === 0) return
    const ranges = paintHits(this.root, new Map([[block.id, spans]]), this.deps.highlightKey)
    if (ranges.length === 0) return
    // 滚到**第一处**命中。用预览容器自己的 `scrollTop` 而不是 `scrollIntoView`：
    // 后者会一路往上找**能滚的祖先**，于是滚的是外层（甚至整页），预览自己没动
    // —— 实测：块高 2347、可视 816，`scrollIntoView` 之后命中仍在视口外。
    const at = ranges[0]!.getBoundingClientRect()
    const box = this.root.getBoundingClientRect()
    const delta = at.top - box.top
    this.root.scrollTop += delta - this.root.clientHeight / 3
  }

  /** 摘掉本次预览的高亮（换选中 / 关面 / 收起预览都要走这里） */
  private clearMatch(): void {
    clearHits(this.deps.highlightKey)
  }
}
