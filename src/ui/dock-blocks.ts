/**
 * 侧槽里的**钉住的块**：一列真实块，可直接编辑。
 *
 * 它不是「侧栏列表组件」——槽里只有块（承「槽里是一列块」）。这里做三件事：
 *   1. 用 `BlockEditor` 把**共享 store 里的活块**渲染成一列（不是拷贝）；
 *   2. 从正文块标拖进来 ⇒ 钉住（HTML5 DnD，块 id 走 `text/plain`）；
 *   3. 钉住清单是**视图状态**（`Prefs.dock.*.pins`），每次重画按 id 去森林里取。
 *
 * ⚠️ **为什么每个钉住项一个编辑器实例**：槽里每一项都要有自己的移除入口，
 *    而单个编辑器只能排一列块、给不出「这一项的头/尾」。多实例共享同一个
 *    `BlockStore`（undo 也是全局的），所以「在槽里改、正文同步」与单实例等价。
 * ⚠️ **重画不得移动常驻卡片**：卡片是 `renderDockStack` 的 `persistent`，
 *    移动一个正在编辑的 contenteditable 会丢焦点与光标（每敲一个字跳一次）。
 *    所以这里只在自己这层「钉住清单变了」时增删行；其余卡片由槽层重画。
 * ⚠️ **外部 store 变化防抖重载**：正文每敲一个键都会 `touch`，若每键重画整槽的块，
 *    侧槽会跟着抖；聚焦在槽内时干脆冻结（用户正在这里打字，不该被外面的变化打断）。
 */
import { findInForest, findPath, flatten, type Block, type BlockStore } from '../core/index.ts'
import { t } from '../core/msg.ts'
import { BlockEditor } from '../view/editor.ts'
import type { DockSlotEls } from './dock.ts'

/** 外部变化到侧槽重画的防抖窗口（比正文落盘的 250ms 短，读起来才像「实时」） */
const RELOAD_DEBOUNCE_MS = 120

export interface DockBlocksDeps {
  side: 'left' | 'right'
  slot: DockSlotEls
  store: BlockStore
  /** 整片森林（活引用） */
  blocks: () => Block[]
  /** 这一槽钉住的块 id（有序） */
  pins: () => readonly string[]
  /** 拖进来一个新块 */
  pin: (blockId: string) => void
  /** 移除一个钉住的块（不删块本身） */
  unpin: (blockId: string) => void
  /** 槽内编辑器获得焦点：装配层把「活动编辑器」切过去 */
  onFocus: (editor: BlockEditor) => void
  /** 槽内编辑器改了模型 */
  onChange: () => void
  /** 点槽内块的块标：与正文同一个「聚焦/zoom」命令 */
  onFocusBlock: (blockId: string) => void
  /** Shift+点槽内块的块标：在右槽钉住 / 取消钉住 */
  onOpenInDock: (blockId: string) => void
  /** 槽内编辑吃掉了行内原子（不静默） */
  onAtomsLost?: (labels: string[]) => void
}

export class DockBlocks {
  /** 常驻卡片：交给 `renderDockStack` 的 `persistent`，永不重建 */
  readonly card: HTMLElement
  private readonly deps: DockBlocksDeps
  private readonly list: HTMLElement
  private readonly editors = new Map<string, BlockEditor>()
  private readonly rows = new Map<string, HTMLElement>()
  /** 上一次渲染出来的可见 id（顺序敏感） */
  private rendered: string[] = []
  private timer: number | null = null
  /** 聚焦期间跳过的外部重载：失焦后补一次（否则槽里的内容会停在旧值） */
  private frozen = false

  constructor(deps: DockBlocksDeps) {
    this.deps = deps
    this.card = buildCard()
    this.card.dataset.pinsFor = deps.side
    this.list = this.card.querySelector<HTMLElement>('.pin-list')!
    // 先挂进堆叠：`renderDockStack` 只保留已在文档里的常驻节点
    deps.slot.stack.appendChild(this.card)
    this.bindDrop()

    /**
     * 自己订阅 store（编辑器实例设了 `autoReload: false`）：
     * 防抖 + 聚焦冻结。`ids` 能拿到时只重载**真的被改到**的那些钉住项。
     * ⚠️ 来源是**其中一个**钉住编辑器时不能整个跳过：一次撤销会改到别的钉住块，
     *    只有发起编辑的那一行自己不需要重画（它已经渲染过了）。
     */
    deps.store.subscribe((source, ids) => {
      const own = this.ownEditor(source)
      if (own) {
        this.scheduleReload(ids, own)
        return
      }
      if (this.list.contains(document.activeElement)) {
        this.frozen = true
        return
      }
      this.scheduleReload(ids)
    })
    this.list.addEventListener('focusout', () => {
      window.setTimeout(() => {
        if (this.list.contains(document.activeElement)) return
        if (!this.frozen) return
        this.frozen = false
        this.reloadAll()
      }, 0)
    })
  }

  /** 槽层每次重画都调它：只处理「钉住清单变了没有」 */
  render(): void {
    const ids = this.visiblePins()
    const same = ids.length === this.rendered.length && ids.every((id, i) => id === this.rendered[i])
    this.card.hidden = ids.length === 0
    if (same) return

    for (const [id, editor] of this.editors) {
      if (ids.includes(id)) continue
      editor.dispose()
      this.editors.delete(id)
      this.rows.get(id)?.remove()
      this.rows.delete(id)
    }
    for (const id of ids) this.ensure(id)
    // 按 pins 的顺序重排（只在清单变化时发生，不会打断正在进行的输入）
    for (const id of ids) {
      const row = this.rows.get(id)
      if (row) this.list.appendChild(row)
    }
    this.rendered = ids
  }

  /**
   * 钉住清单 → 真正要渲染的 id。
   *
   * · 块已经不在了 ⇒ 跳过（清单保留：撤销把块恢复回来时它会自己回来）；
   * · **祖先也被钉住** ⇒ 只渲染祖先（否则同一个块会作为独立根和子树重复出现）。
   */
  private visiblePins(): string[] {
    const pins = this.deps.pins()
    const pinned = new Set(pins)
    const out: string[] = []
    for (const id of pins) {
      if (out.includes(id)) continue
      if (!findInForest(this.deps.blocks(), id)) continue
      const path = findPath(this.deps.blocks(), id) ?? []
      if (path.slice(0, -1).some((p) => pinned.has(p.id))) continue
      out.push(id)
    }
    return out
  }

  private ensure(id: string): void {
    if (this.editors.has(id)) return
    const block = findInForest(this.deps.blocks(), id)
    if (!block) return

    const row = document.createElement('div')
    row.className = 'pin-row'
    row.dataset.blockId = id

    const host = document.createElement('div')
    host.className = 'pin-editor'

    const off = document.createElement('button')
    off.type = 'button'
    off.className = 'pin-remove ghost'
    off.title = t('ui.dock.unpin')
    off.setAttribute('aria-label', t('ui.dock.unpin'))
    off.textContent = '×'
    off.addEventListener('click', (e) => {
      e.stopPropagation()
      this.deps.unpin(id)
    })

    row.append(host, off)
    this.list.appendChild(row)

    const editor = new BlockEditor({
      container: host,
      blankArea: host,
      // 槽里不该「点空白建块」或删段根：这里只是同一批块的一个视图
      allowBlankCreate: false,
      allowRootRemove: false,
      // 重载节奏归本组件（防抖 + 聚焦冻结）
      autoReload: false,
      store: this.deps.store,
      doc: { roots: [block], trash: this.deps.store.trash },
    })
    editor.events = {
      change: (kind) => {
        if (kind !== 'load') this.deps.onChange()
      },
      focusBlock: (blockId) => this.deps.onFocusBlock(blockId),
      openInDock: (blockId) => this.deps.onOpenInDock(blockId),
      atomsLost: (atoms) => this.deps.onAtomsLost?.(atoms.map((a) => a.label)),
    }
    host.addEventListener('focusin', () => this.deps.onFocus(editor))

    this.editors.set(id, editor)
    this.rows.set(id, row)
  }

  private ownEditor(source: unknown): BlockEditor | null {
    for (const editor of this.editors.values()) if (editor === source) return editor
    return null
  }

  private scheduleReload(ids?: readonly string[], except?: BlockEditor): void {
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      this.timer = null
      // 焦点在槽内时不重画正在编辑的这一列（会丢光标）；失焦后补
      if (!except && this.list.contains(document.activeElement)) {
        this.frozen = true
        return
      }
      for (const editor of this.editors.values()) {
        if (editor === except) continue
        if (ids && !flatten(editor.doc).some((b) => ids.includes(b.id))) continue
        editor.reloadFromStore()
      }
    }, RELOAD_DEBOUNCE_MS)
  }

  private reloadAll(): void {
    for (const editor of this.editors.values()) editor.reloadFromStore()
  }

  /** 整个槽都是落点：拖到任意位置都算「钉进这一槽」 */
  private bindDrop(): void {
    const root = this.deps.slot.root
    const clear = (): void => {
      delete root.dataset.dropPin
    }
    root.addEventListener('dragover', (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('text/plain')) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      root.dataset.dropPin = '1'
    })
    root.addEventListener('dragleave', (e: DragEvent) => {
      // 移到槽内的子元素不算离开
      const next = e.relatedTarget as Node | null
      if (next && root.contains(next)) return
      clear()
    })
    root.addEventListener('drop', (e: DragEvent) => {
      clear()
      const id = e.dataTransfer?.getData('text/plain') ?? ''
      if (!id) return
      e.preventDefault()
      if (findInForest(this.deps.blocks(), id)) this.deps.pin(id)
    })
    // 拖拽可能在槽外结束（Esc / 松在别处）：全局收尾，别把高亮留在槽上
    document.addEventListener('dragend', clear)
  }
}

/** 钉住卡片的骨架（常驻节点；抬头是卡片自己的 chrome，不是块） */
function buildCard(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'dock-card pin-card'
  el.dataset.cardId = 'pins'
  el.hidden = true

  const head = document.createElement('div')
  head.className = 'dock-card-head'
  const title = document.createElement('span')
  title.className = 'dock-card-title'
  title.textContent = t('ui.dock.pinned')
  head.appendChild(title)

  const body = document.createElement('div')
  body.className = 'dock-card-body'
  const list = document.createElement('div')
  list.className = 'pin-list'
  body.appendChild(list)

  el.append(head, body)
  return el
}
