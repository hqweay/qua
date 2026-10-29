/**
 * 侧槽里的**窗口**：一个块一张卡，卡里是那个块的真实编辑器。
 *
 * 「打开的块＝窗口」是这一层的全部含义；它不认单独的「打开清单」——
 * 清单已经变成槽的 `cards`（位置），这里只按 id 建/拆卡片。
 *
 * 三件事：
 *   1. 用 `EditableBlock` 把**共享 store 里的活块**渲染成一张卡（不是拷贝）；
 *   2. 卡头显示这个块的**路径**（父 > 父），不是重复正文；
 *   3. 卡片自己的折叠/单卡/拖拽由 `ui/dock.ts` 的统一卡壳提供，
 *      这里只提供 body 与关闭入口。
 *
 * ⚠️ **每个窗口一个编辑器实例**：一个编辑器只能排一列块，给不出「这一窗口的头/尾」。
 *    多实例共享同一个 `BlockStore`（undo 也是全局的），所以「槽里改、正文同步」。
 * ⚠️ **重画不得移动常驻卡片**：卡片是槽层的 entry，按顺序原地不动；
 *    移动一个正在编辑的 contenteditable 会丢焦点与光标（每敲一个字跳一次）。
 * ⚠️ **重载节奏在 `EditableBlock` 里**（每个窗口一份，各管各的卡：防抖、聚焦冻结、
 *    离焦补做）。正文每敲一个键都会 `touch`，每键重画整槽会让侧槽跟着抖；
 *    聚焦在某个窗口里时冻结（用户正在这里打字）。
 */
import { flatten, type Block, type BlockStore } from '../core/index.ts'
import type { KbClient } from '../core/kb/types.ts'
import { t } from '../core/msg.ts'
import type { BlockEditor, Run } from '../view/editor.ts'
import { bindDropTarget } from '../view/dnd.ts'
import { applyDockCardState, buildDockCard, type DockCardState } from './dock.ts'
import { EditableBlock } from './editable-block.ts'

export interface DockWindowsDeps {
  store: BlockStore
  /** 读门面：窗口按 id 解析（在不在、祖先链） */
  kb: KbClient
  /** 写入事务入口：执行者在装配层，这里只原样转给每个窗口编辑器（见 `Run`） */
  write: Run
  /** 卡头标题：这个块的路径（显示名由装配层算，UI 不认识地址规则） */
  label: (blockId: string) => string
  /** 关闭窗口（**不删块**） */
  onClose: (blockId: string) => void
  /**
   * **给窗口编辑器接上与正文同一套事件表**（装配层的 `viewEvents` 是唯一一份）。
   *
   * ⚠️ 必须整份接上：只手接几支的话，缺的那几样（右键块菜单、`#`·`@` 补全、
   *    撞名提示…）在窗口里点了就是没反应——漏接不报错。
   */
  wire: (editor: BlockEditor, change: (kind: string) => void) => void
  /** 窗口编辑器获得焦点：装配层把「活动编辑器」切过来 */
  onFocus: (editor: BlockEditor) => void
  /** 窗口被拆掉：装配层若正把 `ed` 指着它，要退回正文 */
  onDispose: (editor: BlockEditor) => void
  /** 窗口编辑器改了模型 */
  onChange: () => void
  /** 这张卡的收起/单卡/拖拽状态（装配层按 prefs 现算） */
  cardState: (blockId: string) => DockCardState
}

export class DockWindows {
  private readonly deps: DockWindowsDeps
  private readonly windows = new Map<string, { block: EditableBlock; card: HTMLElement }>()

  constructor(deps: DockWindowsDeps) {
    this.deps = deps
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

  private ensure(id: string, block: Block): { block: EditableBlock; card: HTMLElement } {
    const had = this.windows.get(id)
    if (had) return had

    const host = document.createElement('div')
    host.className = 'dock-window-editor'

    const win = new EditableBlock({
      host,
      store: this.deps.store,
      write: this.deps.write,
      // 窗口不是「真实兄弟序」：点空白不建块、删段根不删块（只是同一批块的一个视图）。
      // roots 是「一个块一张卡」，构造时就知道；此后 `load` 只按 id 重取。
      initialRoots: [block],
      load: (ed, ids) => {
        if (!ed) return
        // 与己无关的变化不重画（拿得到 ids 时）；拿不到（结构操作）按全量重取
        if (ids && !ids.some((i) => flatten(ed.doc).some((b) => b.id === i))) return
        ed.reloadFromStore()
      },
      wire: (editor, change) => this.deps.wire(editor, change),
      onChange: () => this.deps.onChange(),
      onFocus: (editor) => this.deps.onFocus(editor),
    })
    // 窗口建了就有编辑器（roots 构造时就知道，没有「先空着」的阶段）
    win.ensureEditor()

    const card = buildDockCard(
      {
        id,
        title: this.deps.label(id),
        body: win.root,
        draggable: true,
        close: { title: t('ui.dock.closeWindow'), onClick: () => this.deps.onClose(id) },
      },
      this.deps.cardState(id),
    )
    card.dataset.window = '1'

    const w = { block: win, card }
    this.windows.set(id, w)
    return w
  }

  private dispose(id: string): void {
    const w = this.windows.get(id)
    if (!w) return
    const ed = w.block.ed
    if (ed) this.deps.onDispose(ed)
    w.block.dispose()
    w.card.remove()
    this.windows.delete(id)
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
