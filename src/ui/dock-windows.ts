/**
 * 侧槽里的**窗口**：一个块一张卡，卡里是那个块的真实编辑器。
 *
 * 「打开的块＝窗口」是这一层的全部含义；它不认单独的「打开清单」——
 * 清单已经变成槽的 `cards`（位置），这里只按 id 建/拆卡片。
 *
 * 三件事：
 *   1. 用 `BlockEditor` 把**共享 store 里的活块**渲染成一张卡（不是拷贝）；
 *   2. 卡头显示这个块的**路径**（父 > 父），不是重复正文；
 *   3. 卡片自己的折叠/单卡/拖拽由 `ui/dock.ts` 的统一卡壳提供，
 *      这里只提供 body 与关闭入口。
 *
 * ⚠️ **每个窗口一个编辑器实例**：一个编辑器只能排一列块，给不出「这一窗口的头/尾」。
 *    多实例共享同一个 `BlockStore`（undo 也是全局的），所以「槽里改、正文同步」。
 * ⚠️ **重画不得移动常驻卡片**：卡片是槽层的 entry，按顺序原地不动；
 *    移动一个正在编辑的 contenteditable 会丢焦点与光标（每敲一个字跳一次）。
 * ⚠️ **外部 store 变化防抖重载**：正文每敲一个键都会 `touch`，若每键重画整槽，
 *    侧槽会跟着抖；聚焦在某个窗口里时干脆冻结（用户正在这里打字）。
 */
import { flatten, type Block, type BlockStore } from '../core/index.ts'
import type { KbClient } from '../core/kb/types.ts'
import { t } from '../core/msg.ts'
import { BlockEditor, type Run } from '../view/editor.ts'
import type { RefClickHit, RefClickMods } from '../view/editor-events.ts'
import { bindDropTarget } from '../view/dnd.ts'
import { applyDockCardState, buildDockCard, type DockCardState } from './dock.ts'

/** 外部变化到侧槽重画的防抖窗口（比正文落盘的 250ms 短，读起来才像「实时」） */
const RELOAD_DEBOUNCE_MS = 120

export interface DockWindowsDeps {
  store: BlockStore
  /** 读门面：窗口按 id 解析（在不在、祖先链） */
  kb: KbClient
  /** 写入事务入口：执行者在装配层，这里只原样转给每个窗口编辑器（见 `Run`） */
  write?: Run
  /** 卡头标题：这个块的路径（显示名由装配层算，UI 不认识地址规则） */
  label: (blockId: string) => string
  /** 关闭窗口（**不删块**） */
  onClose: (blockId: string) => void
  /** 窗口编辑器获得焦点：装配层把「活动编辑器」切过去 */
  onFocus: (editor: BlockEditor) => void
  /** 窗口被拆掉：装配层若正把 `ed` 指着它，要退回正文 */
  onDispose: (editor: BlockEditor) => void
  /** 窗口编辑器改了模型 */
  onChange: () => void
  /** 点窗口内块的块标：与正文同一个「聚焦/zoom」命令 */
  onFocusBlock: (blockId: string) => void
  /** Shift+点窗口内块的块标：在右槽打开（已在右槽则定位；不在则移过去） */
  onOpenInDock: (blockId: string) => void
  /** 这张卡的收起/单卡/拖拽状态（装配层按 prefs 现算） */
  cardState: (blockId: string) => DockCardState
  /**
   * **「指向某块的露面」被点**（行内引用 / 行尾标签 chip）。
   *
   * ⚠️ 侧槽的窗口是**生产装配里的编辑器实例**，与正文同一个口径。
   *    不接它，槽里那张卡上的引用与标签点了就没反应 —— 而缺入口最糟的形态
   *    不是报错，是「看起来点了、其实什么都没发生」。
   */
  onRefClick: (ref: RefClickHit, mods: RefClickMods, el?: HTMLElement) => void
}

export class DockWindows {
  private readonly deps: DockWindowsDeps
  private readonly windows = new Map<string, { editor: BlockEditor; card: HTMLElement }>()
  private timer: number | null = null
  /** 聚焦期间跳过的外部重载：失焦后补一次（否则窗口里的内容会停在旧值） */
  private frozen = false

  constructor(deps: DockWindowsDeps) {
    this.deps = deps
    /**
     * 自己订阅 store（编辑器实例设了 `autoReload: false`）：
     * 防抖 + 聚焦冻结。`ids` 能拿到时只重载**真的被改到**的那些窗口。
     * ⚠️ 来源是**其中一个**窗口时不能整个跳过：一次撤销会改到别的窗口，
     *    只有发起编辑的那一个自己不需要重画（它已经渲染过了）。
     */
    deps.store.subscribe((source, ids) => {
      const own = this.ownEditor(source)
      if (own) {
        this.scheduleReload(ids, own)
        return
      }
      if (this.hasFocus()) {
        this.frozen = true
        return
      }
      this.scheduleReload(ids)
    })
    document.addEventListener('focusout', () => {
      window.setTimeout(() => {
        if (this.hasFocus()) return
        if (!this.frozen) return
        this.frozen = false
        this.reloadAll()
      }, 0)
    })
  }

  /**
   * 按 id 建/拆窗口；返回本槽真正要渲染的卡片（顺序由槽层决定）。
   *
   * · id 不在清单里 ⇒ 拆掉（关闭窗口）；
   * · 块已经不在库里 ⇒ 保留编辑器、但不给卡片（撤销把块恢复回来时它自己回来）；
   * · 祖先/后代都打开 ⇒ **两张都画**：窗口是显式的，重复是预期。
   */
  sync(ids: readonly string[]): Map<string, HTMLElement> {
    const wanted = new Set(ids)
    for (const id of [...this.windows.keys()]) if (!wanted.has(id)) this.dispose(id)

    const out = new Map<string, HTMLElement>()
    for (const id of ids) {
      const block = this.deps.kb.get(id)
      if (!block) continue
      const w = this.ensure(id, block)
      const title = w.card.querySelector<HTMLElement>('.dock-card-title')
      if (title) {
        const text = this.deps.label(id)
        if (title.textContent !== text) title.textContent = text
        title.title = text
      }
      applyDockCardState(w.card, this.deps.cardState(id))
      out.set(id, w.card)
    }
    return out
  }

  private ensure(id: string, block: Block): { editor: BlockEditor; card: HTMLElement } {
    const had = this.windows.get(id)
    if (had) return had

    const host = document.createElement('div')
    host.className = 'dock-window-editor'

    const card = buildDockCard(
      {
        id,
        title: this.deps.label(id),
        body: host,
        draggable: true,
        close: { title: t('ui.dock.closeWindow'), onClick: () => this.deps.onClose(id) },
      },
      this.deps.cardState(id),
    )
    card.dataset.window = '1'

    const editor = new BlockEditor({
      container: host,
      blankArea: host,
      // 窗口不是「真实兄弟序」：点空白不建块、删段根不删块（只是同一批块的一个视图）
      allowBlankCreate: false,
      allowRootRemove: false,
      // 重载节奏归本组件（防抖 + 聚焦冻结）
      autoReload: false,
      store: this.deps.store,
      write: this.deps.write,
      doc: { roots: [block] },
    })
    editor.events = {
      change: (kind) => {
        if (kind !== 'load') this.deps.onChange()
      },
      focusBlock: (blockId) => this.deps.onFocusBlock(blockId),
      openInDock: (blockId) => this.deps.onOpenInDock(blockId),
      refClick: (ref, mods, el) => this.deps.onRefClick(ref, mods, el),
    }
    host.addEventListener('focusin', () => this.deps.onFocus(editor))

    const w = { editor, card }
    this.windows.set(id, w)
    return w
  }

  private dispose(id: string): void {
    const w = this.windows.get(id)
    if (!w) return
    this.deps.onDispose(w.editor)
    w.editor.dispose()
    w.card.remove()
    this.windows.delete(id)
  }

  private hasFocus(): boolean {
    for (const w of this.windows.values()) if (w.card.contains(document.activeElement)) return true
    return false
  }

  private ownEditor(source: unknown): BlockEditor | null {
    for (const w of this.windows.values()) if (w.editor === source) return w.editor
    return null
  }

  private scheduleReload(ids?: readonly string[], except?: BlockEditor): void {
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      this.timer = null
      // 焦点在某个窗口里时不重画那一张（会丢光标）；失焦后补
      if (!except && this.hasFocus()) {
        this.frozen = true
        return
      }
      for (const { editor } of this.windows.values()) {
        if (editor === except) continue
        if (ids && !flatten(editor.doc).some((b) => ids.includes(b.id))) continue
        editor.reloadFromStore()
      }
    }, RELOAD_DEBOUNCE_MS)
  }

  private reloadAll(): void {
    for (const { editor } of this.windows.values()) editor.reloadFromStore()
  }
}

/**
 * 整槽都是「把块打开到这里」的落点。
 *
 * 含义由这一处注入；同样的拖拽落到正文行是「移动」、落到归属树 item 是「归到它下面」。
 * `attr` 保持 `dropPin`：那是槽的 CSS 契约（`[data-drop-pin]`），不跟着实现换名字。
 */
export function bindWindowDrop(slotRoot: HTMLElement, accept: (id: string) => boolean, onDrop: (id: string) => void): void {
  bindDropTarget(slotRoot, {
    attr: 'dropPin',
    effect: 'copy',
    // 载荷里是块 id 才接：外部拖来的文字、别处的自定义类型一律不认
    accept,
    targetId: () => null,
    hint: () => t('ui.dnd.pin'),
    onDrop,
  })
}
