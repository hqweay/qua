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
import { type Block, type BlockStore, isOwnEdit } from '../../core/index.ts'
import { EDIT_ISLAND_ATTR } from '../../view/editor/block-dom.ts'
import { bindPressFreeze } from '../../view/editor/editor-events.ts'
import { inputSession } from '../../view/editor/input-session.ts'
import { ReloadPolicy } from '../../view/editor/reload-policy.ts'
import { BlockEditor, type Run } from '../../view/editor/editor.ts'

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
   * 结构动作能在哪一层寻址（见 `ViewOpts.structuralScope`）。
   * 反链/查询结果/镜像的根是派生的，传 `'roots'`；正文不传。
   */
  structuralScope?: 'document' | 'roots'
  /**
   * **段根可不可以删**（默认不可）。查询结果／侧槽窗口的段根是**别的页的块**，
   * 在这里删源不合适（那类删除走命令面）；**页签身体**的段根就是页签本身——
   * 容器的真实子块，删除＝删这一页（软删可回），要显式打开。
   */
  allowRootRemove?: boolean
  /**
   * 删掉最后一段时补不补空块落点（默认补）。页签身体关掉：一段恒一页，
   * fill 会把「删这一页」变成「原地换空块」，落点由视图层回落激活页给。
   */
  rootRemoveFill?: boolean
  /**
   * 冻结判据的范围，默认＝岛根。挂载区要连 tab 条一起算「有人在这」——
   * 焦点落在 tab 按钮上时重排 tab 条，同样会把正被按的那颗换掉。
   */
  area?: HTMLElement
  /** 外部变化到重载的防抖窗口。挂载区重查更贵（要跑查询），给 200 */
  debounceMs?: number
  /**
   * **这份装载里要不要展开露面块的身体**。默认 `true`。
   *
   * 镜像的身体本身是一份装载：它里面的露面块只画占位（深度 1 的构造性截断），
   * 否则「A 的子树里嵌了 A」会递归渲染。
   */
  embedBodies?: boolean
  /** 面包屑的就地展开／逐层收起（省略则事件层退回 focusBlock） */
  onExpandContext?: (ancestorId: string, rowId: string) => void
  onContextBack?: (rootId: string) => void
  /**
   * **空块占位文案**（省略＝编辑器默认的「空块／写点什么…」）。
   *
   * 抬头那类落点里，这一行不是「一块空内容」而是「这个名字还是空的」——
   * 默认占位会在一个名字格子里说「按 / 呼出命令」。
   * ⚠️ 与虚拟化占位（`BlockEditor` 的 `placeholder()`）不是一件事。
   */
  emptyPlaceholder?: string
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
  /**
   * **外部变化之后要不要／什么时候重装这一栏**的那份状态机（欠账、合并、补做、指针）。
   *
   * 冻结判据在这里给：这一片只有自己一台编辑器，焦点落在区域里**任何东西**上都算
   * 「有人在这」——包括挂载区连带的 tab 条（重排 tab 条同样会把正被按的那颗换掉）。
   * 这与正文那份判据的域不同，所以各给各的，不并。
   */
  private readonly reloader: ReloadPolicy

  constructor(deps: EditableBlockDeps) {
    this.deps = deps
    this.host = deps.host
    this.root = document.createElement('div')
    this.root.className = 'editable-block'
    this.root.setAttribute(EDIT_ISLAND_ATTR, '1')
    this.root.contentEditable = 'false'
    this.root.appendChild(this.host)
    this.area = deps.area ?? this.root

    this.reloader = new ReloadPolicy({
      frozen: () =>
        this.area.contains(document.activeElement) ||
        this.editor?.probe.isComposing === true ||
        inputSession.isComposing ||
        inputSession.isAnchorInside(this.area),
      debounceMs: deps.debounceMs ?? DEBOUNCE_MS,
      onReload: (ids) => this.deps.load(this.editor, ids),
    })

    /**
     * **唯一的重载入口**：所有外部变化都从这一条路走。自己的编辑不算外部——
     * 那一行编辑器自己已经画过，但「这一栏装谁」可能因此过期（成员判定读内容），
     * 所以仍记一笔欠的，等离开这里再补，不在打字途中重排。
     */
    this.offStore = deps.store.subscribe((source, ids) => {
      this.reloader.touch(isOwnEdit(source, this.editor) ? undefined : ids)
    })

    /**
     * 指针按下期间不重载。绑在 document 上（捕获）：按下后拖出本区域再抬起也要放开，
     * 否则一次「按下-拖走-松手」就把这片永远冻住。放开路径（含原生拖拽收走指针的
     * `pointercancel`／`dragend`）与延迟一拍的道理见 `bindPressFreeze`。
     */
    this.offPointer = bindPressFreeze(
      () => this.reloader.setPointerDown(true),
      () => this.reloader.setPointerDown(false),
    )

    /**
     * 焦点离开这片区域：补一次欠下的重载。挂载区原来的行为是「离开必重画」，
     * 这里收成「欠了才补」——没欠的时候重画只是白做，而且重建 tab 条这类 DOM
     * 每一次都是一次风险。
     */
    this.area.addEventListener('focusout', () => {
      window.setTimeout(() => {
        if (this.area.contains(document.activeElement)) return
        const ed = this.editor
        if (ed) inputSession.end(ed)
        this.reloader.flush()
      }, 0)
    })
  }

  /** 编辑器实例（懒建时还没有）。装配层判「活动编辑器」、取写事务 source 都用它 */
  get ed(): BlockEditor | null {
    return this.editor
  }

  /**
   * **同步收尾**：把当前那一行的 DOM 内容推入模型，并收一次编辑边界。
   *
   * 为什么要有这个入口：`focusout` 那条补 flush 是**延迟一拍**的（`setTimeout(0)`），
   * 而覆盖层关闭是「先 remove DOM 再还焦点」——焦点事件不保证派发，等不到那一拍。
   * 关掉一个正在编辑的浮层时，最后一笔要在这里落地，不能指望 blur。
   *
   * 幂等：正文每条 `input` 都已经同步过一次（见 `editor-events`），这里再推一遍
   * 在内容相同时是 no-op；组合期也推——模型一直是 DOM 的投影，收尾只是对齐。
   */
  flush(): void {
    const ed = this.editor
    if (!ed) return
    const id = ed.caretBlock()
    if (!id) return
    ed.syncFromDom(id, false)
    ed.commitEdit(id)
  }

  /** 建那一个编辑器；建了就一直复用（重建一次，撤销栈与选区就丢一次） */
  ensureEditor(): BlockEditor {
    if (this.editor) return this.editor
    const ed = new BlockEditor({
      container: this.host,
      blankArea: this.host,
      // 记录视图：没有「视图级同级」——点空白不建块。删段根默认也不许
      //（根是别的页的块）；页签身体用 `allowRootRemove` 显式打开
      allowBlankCreate: false,
      allowRootRemove: this.deps.allowRootRemove === true,
      rootRemoveFill: this.deps.rootRemoveFill !== false,
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
      ...(this.deps.embedBodies === false ? { embedBodies: false } : {}),
      ...(this.deps.structuralScope ? { structuralScope: this.deps.structuralScope } : {}),
      ...(this.deps.emptyPlaceholder !== undefined ? { emptyPlaceholder: this.deps.emptyPlaceholder } : {}),
      onExpandContext: this.deps.onExpandContext,
      onContextBack: this.deps.onContextBack,
    })
    this.deps.wire(ed, (kind) => {
      // `load` 是装载自己的回声，不是编辑；落盘该跳过它
      if (kind !== 'load') this.deps.onChange(kind)
    })
    this.host.addEventListener('focusin', () => {
      inputSession.start(ed)
      this.deps.onFocus(ed)
    })
    // 惰性判据：没有这一格就没有「编辑器已建」可读
    this.host.dataset.editor = '1'
    this.editor = ed
    return ed
  }

  /** 从文档里摘掉这个组件：退订、卸事件（游离容器不该继续被重画） */
  dispose(): void {
    this.offStore()
    this.offPointer()
    this.reloader.dispose()
    const ed = this.editor
    if (ed) inputSession.end(ed)
    this.editor?.dispose()
    this.editor = null
  }
}
