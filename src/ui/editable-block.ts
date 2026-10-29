/**
 * **可编辑块列**：`BlockEditor` ＋ 它该有的全套装配，收成一个组件。
 *
 * 为什么要有它：同一份配方（建编辑器 ＋ 订阅 store ＋ 焦点切换 ＋ 事件表）在每个落点
 * 各手抄一份，而其中三件事**抄漏了不报错**——
 *   · **重载路径叠了两条**：编辑器自己跟随 store，承载它的组件又防抖重载一次；
 *     两条路各自换 DOM ⇒ 按下的按钮在 `mouseup` 之前被换掉 ⇒ `click` 不派发，
 *     用户看到的是「点了没反应」；
 *   · **嵌进另一个可编辑宿主时没断链**：可编辑嵌可编辑，Chrome 把焦点交给**外层**的
 *     编辑宿主 ⇒ 里层打的字一个都不进模型；
 *   · **事件表只接一半**：右键块菜单、`#`·`@` 补全这类漏接，面板里点了就是没反应。
 * 这三条都收在这里——接第五处「渲染一列可编辑块」的人不需要知道它们。
 *
 * 「什么时候装」归组件，且**只有这一条路径**（编辑器被设成 `autoReload: false`，
 * 不再自己跟随 store）：外部变化先防抖；聚焦在本区域、指针按下、输入法组合期一律冻结
 * （换 DOM 会打断正在发生的事）；冻结欠下的那次在离开之后补上。
 * 「装什么」归消费者（`load`）：挂载区＝重查一栏、查询视图＝解冻结果、窗口＝按 id 重取。
 */
import { type Block, type BlockStore } from '../core/index.ts'
import { EDIT_ISLAND_ATTR } from '../view/block-dom.ts'
import { BlockEditor, type Run } from '../view/editor.ts'

/** 补做被冻结的重载的间隔：够 `click` 派发完（mouseup 之后同一任务里还有它），又仍在用户眼里是「立刻」 */
const FLUSH_MS = 200
/** 外部变化到重载的默认防抖窗口 */
const DEBOUNCE_MS = 120

export interface EditableBlockDeps {
  /** 编辑器宿主：消费者自己的元素与类名（CSS 契约在消费者那一侧），组件把它装进岛根 */
  host: HTMLElement
  store: BlockStore
  /** 写入事务入口（装配层注入，见 `Run`）：组件原样递给编辑器 */
  write: Run
  /** 编辑器的初始 roots（窗口是「一个块一张卡」，构造时就知道；其余落点从空开始由 `load` 装） */
  initialRoots?: readonly Block[]
  /**
   * **这一份装载里，哪个根的子块不归编辑器画**（见 `Doc.viewRootId`）。
   *
   * 单块标题编辑器用它把「这一块的 children」摘掉：它们本来就画在别处（表格/正文），
   * 在浮层里再画一遍既超出格子的语义，也会让 Enter 拆出一块看不见的块。
   */
  viewRootId?: string
  /**
   * **装载动作**。「什么时候装」归组件，「装什么」归这里。
   * `ed` 是当前编辑器（懒建时可能是 null——空结果不该建实例）；`ids` 是这次动过的块
   * （拿得到时），窗口用它跳过与己无关的重载。
   */
  load: (ed: BlockEditor | null, ids?: readonly string[]) => void
  /**
   * **与正文同一份事件表**（装配层的 `viewEvents`）。必给，不是可选：
   * 各接一半的漏接不报错——点引用不跳、右键没菜单、`#` 不弹补全。
   */
  wire: (ed: BlockEditor, change: (kind: string) => void) => void
  /** 编辑器里的编辑（`kind !== 'load'`）：落盘、刷角标 */
  onChange: (kind: string) => void
  /** 获得焦点：装配层把「活动编辑器」切过来（键位走命令层，认的是它） */
  onFocus: (ed: BlockEditor) => void
  /**
   * 冻结判据的范围，默认＝岛根。挂载区要连 tab 条一起算「有人在这」——
   * 焦点落在 tab 按钮上时重排 tab 条，同样会把正被按的那颗换掉。
   */
  area?: HTMLElement
  /** 外部变化到重载的防抖窗口。挂载区重查更贵（要跑查询），给 200 */
  debounceMs?: number
  /** 面包屑的就地展开／逐层收起（省略则事件层退回 focusBlock） */
  onExpandContext?: (ancestorId: string, rowId: string) => void
  onContextBack?: (rootId: string) => void
}

export class EditableBlock {
  /**
   * **岛根**：`contenteditable=false` ＋ `data-edit-island`。
   *
   * 两个标记各管一件事：断链（嵌进任何可编辑宿主，焦点都归里层，不打给外层）；
   * 认岛（外层编辑器按这一格判「焦点在别人的地盘上」，于是不在打字期间重排这片 DOM）。
   * `display: contents` ⇒ 不产生盒子，放进谁的布局都不改变几何。
   */
  readonly root: HTMLElement
  /** 编辑器宿主（消费者的元素，`contenteditable=true` 由 `BlockEditor` 落上） */
  readonly host: HTMLElement
  private readonly deps: EditableBlockDeps
  private readonly area: HTMLElement
  private editor: BlockEditor | null = null
  private readonly offStore: () => void
  private readonly offPointer: () => void
  /** 防抖重载的计时器 */
  private timer: number | null = null
  /** 补做被冻结重载的计时器 */
  private flushTimer: number | null = null
  /** 欠一次重载：被冻结（聚焦/按下/组合期），或自己的编辑让「这一栏装谁」过期了 */
  private pending = false
  private pointerDown = false

  constructor(deps: EditableBlockDeps) {
    this.deps = deps
    this.host = deps.host
    this.root = document.createElement('div')
    this.root.className = 'editable-block'
    this.root.setAttribute(EDIT_ISLAND_ATTR, '1')
    this.root.contentEditable = 'false'
    this.root.appendChild(this.host)
    this.area = deps.area ?? this.root

    /**
     * **唯一的重载入口**：所有外部变化都从这一条路走。自己的编辑不算外部——
     * 那一行编辑器自己已经画过，但「这一栏装谁」可能因此过期（成员判定读内容），
     * 所以记一笔欠的，等离开这里再补，不在打字途中重排。
     */
    this.offStore = deps.store.subscribe((source, ids) => {
      if (source === this.editor) {
        this.pending = true
        return
      }
      if (this.frozen()) {
        this.pending = true
        this.armFlush()
        return
      }
      this.schedule(ids)
    })

    /**
     * 指针按下期间不重载。绑在 document 上（捕获）：按下后拖出本区域再抬起也要放开，
     * 否则一次「按下-拖走-松手」就把这片永远冻住。抬起推迟一拍——`click` 紧跟在
     * `mouseup` 的同一个任务里，立刻放开会在它之前把 DOM 换掉。
     */
    const down = (): void => {
      this.pointerDown = true
    }
    const up = (): void => {
      window.setTimeout(() => {
        this.pointerDown = false
        if (this.pending) this.armFlush()
      }, 0)
    }
    document.addEventListener('pointerdown', down, { capture: true })
    document.addEventListener('pointerup', up, { capture: true })
    this.offPointer = () => {
      document.removeEventListener('pointerdown', down, { capture: true })
      document.removeEventListener('pointerup', up, { capture: true })
    }

    /**
     * 焦点离开这片区域：补一次欠下的重载。挂载区原来的行为是「离开必重画」，
     * 这里收成「欠了才补」——没欠的时候重画只是白做，而且重建 tab 条这类 DOM
     * 每一次都是一次风险。
     */
    this.area.addEventListener('focusout', () => {
      window.setTimeout(() => {
        if (!this.area.contains(document.activeElement)) this.flush()
      }, 0)
    })
  }

  /** 编辑器实例（懒建时还没有）。装配层判「活动编辑器」、取写事务 source 都用它 */
  get ed(): BlockEditor | null {
    return this.editor
  }

  /** 建那一个编辑器；建了就一直复用（重建一次，撤销栈与选区就丢一次） */
  ensureEditor(): BlockEditor {
    if (this.editor) return this.editor
    const ed = new BlockEditor({
      container: this.host,
      blankArea: this.host,
      // 记录视图：没有「视图级同级」——点空白不建块、删段根不删块
      allowBlankCreate: false,
      allowRootRemove: false,
      // 重载节奏归本组件（唯一一条路径），编辑器不再自己跟随 store
      autoReload: false,
      store: this.deps.store,
      write: this.deps.write,
      // 折叠态是视图私有的（在块底收起一行，不该让正文里那一块也收起来）
      doc: {
        roots: [...(this.deps.initialRoots ?? [])],
        folded: {},
        ...(this.deps.viewRootId ? { viewRootId: this.deps.viewRootId } : {}),
      },
      onExpandContext: this.deps.onExpandContext,
      onContextBack: this.deps.onContextBack,
    })
    this.deps.wire(ed, (kind) => {
      // `load` 是装载自己的回声，不是编辑；落盘该跳过它
      if (kind !== 'load') this.deps.onChange(kind)
    })
    this.host.addEventListener('focusin', () => this.deps.onFocus(ed))
    // 惰性判据：没有这一格就没有「编辑器已建」可读
    this.host.dataset.editor = '1'
    this.editor = ed
    return ed
  }

  /** 从文档里摘掉这个组件：退订、卸事件（游离容器不该继续被重画） */
  dispose(): void {
    this.offStore()
    this.offPointer()
    if (this.timer !== null) window.clearTimeout(this.timer)
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer)
    this.editor?.dispose()
    this.editor = null
  }

  /** 此刻能不能安全换 DOM：区域里有焦点、指针按着、输入法组合中，都不能 */
  private frozen(): boolean {
    return this.area.contains(document.activeElement) || this.pointerDown || this.editor?.probe.isComposing === true
  }

  private schedule(ids?: readonly string[]): void {
    if (this.timer !== null) window.clearTimeout(this.timer)
    const wait = this.deps.debounceMs ?? DEBOUNCE_MS
    this.timer = window.setTimeout(() => {
      this.timer = null
      if (this.frozen()) {
        this.pending = true
        this.armFlush()
        return
      }
      this.pending = false
      this.deps.load(this.editor, ids)
    }, wait)
  }

  /** 排一次「补做被冻结的重载」。计时器而不是 focusout：焦点可能只是从行挪到本区域的按钮上，从未离开 */
  private armFlush(): void {
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer)
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, FLUSH_MS)
  }

  private flush(): void {
    if (this.frozen()) {
      if (this.pending) this.armFlush()
      return
    }
    if (!this.pending) return
    this.pending = false
    this.deps.load(this.editor, undefined)
  }
}
