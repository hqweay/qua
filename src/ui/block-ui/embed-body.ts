/**
 * **露面块的身体**：源块在「这一张看法」下的身体。
 *
 * 判据不在这里 —— 它是 `core/view.ts` 的 `embedBodyOf`（纯函数，纯模型）：
 *   · 源是 children 且这一次没选视图 ⇒ **镜像**：一台可编辑的岛编辑器（那棵子树）；
 *   · 其余（query／items 源，或选了一张视图）⇒ **投影**：一台 `ViewHost`，
 *     与正文行内体、段尾宿主、侧槽窗口**同一台渲染器**。
 *
 * 为什么身体必须是一个**编辑岛**：同一个块可能在同一屏出现两次（源在正文原位、
 * 这里又露面一次）。岛根把焦点与重排切成两个世界——外层编辑器不抢里层光标，
 * 里层打字也不触发外层重排（见 `ui/editable-block.ts` 与 `view/editor.ts` 的 `blockEl`）。
 *
 * ## 一条判据：看法住在**源块**上，露面只存一次选择
 *
 * `_embed = { block, view }`：`view` 是 `''`（跟随源块的默认看法）／`'outline'`（强制大纲）／
 * 源块 `_views` 里一张命名视图的 id。**露面块自己没有 `_views`。**
 *
 * 曾经露面块自己带一份配置，于是同一批块在正文、面板、中心各露一次 ⇒ 三份各自演化的
 * 列与排序。要共享就都指向源块；要「这一次特别一点」就在源块上建一张命名视图并指向它 ——
 * 两种需求都有出口，且只存在一份配置。
 *
 * ## 为什么这里**不该**有自己的渲染器表
 *
 * 曾经这里按「镜像／大纲表格／其它 ⇒ 还没有渲染器」分三路。三路里没有一格是「源是查询」：
 * 查询的命中不是 children，于是查询块的露面要么画出一行空壳、要么说「还没有渲染器」——
 * 而渲染器明明有。判据一旦落在这层，加一种源或一种 kind 就要在两处各改一次。
 *
 * 深度 1 由构造固定：镜像里那台编辑器带 `embedBodies: false`，投影那台 `ViewHost`
 * 的内层编辑器不带 `viewBody` —— 里面的露面/查询块只画占位，不递归。
 */
import {
  embedBodyOf,
  isDeleted,
  resolveEmbed,
  type Block,
  type BlockStore,
} from '../../core/index.ts'
import type { Tx } from '../../core/kb/types.ts'
import { t } from '../../core/infra/msg.ts'
import type { BlockEditor } from '../../view/editor/editor.ts'
import { EDIT_ISLAND_ATTR } from '../../view/editor/block-dom.ts'
import { EditableBlock } from './editable-block.ts'

export interface EmbedBodyDeps {
  store: BlockStore
  /** 命令层的事务入口（撤销条目与重画归装配层） */
  run: <R>(fn: (tx: Tx) => R) => R
  wire: (ed: BlockEditor, change: (kind: string) => void) => void
  onFocus: (ed: BlockEditor) => void
  onChange: (kind: string) => void
  /**
   * 画**投影**：由装配层给一台 `ViewHost`（`surface: 'embed'`，绑定点是这一次露面）。
   * 这一层不认识视图配置，也不该认识 —— 认识一次就会长出第二份判据。
   *
   * `titleInto` 是**名字那一行**的落点（这一层造的，见 `mountEmbedBody`）：
   * 投影跟正文里的查询块同一形状 —— 块标＋名字占一行，结果面板折在下一行。
   * 名字由 `ViewHost` 自己画（它就是那一块正文，改它＝改源块）。
   */
  mountView: (host: Block, target: Block, into: HTMLElement, titleInto: HTMLElement) => () => void
  /** 重画某一**行**：判据翻转（镜像 ⇄ 投影）时用 */
  repaint: (blockId: string) => void
  /** 命令面（只说「移除这次露面」） */
  invoke: (name: string, args: Record<string, unknown>, via?: string) => void
}

/**
 * 给一个露面块装身体。返回卸载函数——**换 DOM 之前必须调用**（里层是另一台编辑器／
 * 一张订阅 store 的视图；不卸载就会每次重排留一份订阅）。
 */
export function mountEmbedBody(host: Block, into: HTMLElement, deps: EmbedBodyDeps): () => void {
  const find = (id: string): Block | undefined => deps.store.find(id)
  const res = resolveEmbed(host, find)
  if (res.status !== 'ok') {
    into.dataset.embedState = res.status
    into.appendChild(noteEl(res.status))
    into.appendChild(removeBtn(host.id, deps))
    return () => {}
  }
  const target = res.target
  if (isDeleted(target)) {
    into.dataset.embedState = 'deleted'
    const note = document.createElement('div')
    note.className = 'embed-note'
    note.textContent = t('ui.embed.deleted')
    into.append(note, removeBtn(host.id, deps))
    return () => {}
  }

  const kind = embedBodyOf(host, find)
  const body =
    kind === 'view' ? mountProjection(host, target, into, deps) : mountMirror(target, into, deps)

  /**
   * **判据会翻**：`_embed.view === ''` 是「跟随源」，源自己换到某张视图之后，
   * 这一处的身体要从树变成视图（源撤掉激活视图则反过来）。
   *
   * 指针自己的变化不需要这里管：写 `_embed` 会按块重画这一行。
   * 但**源的变化不会重画露面那一行** —— 于是「跟随源」这句承诺只在重开之后才成立。
   */
  const off = deps.store.subscribe((_source, ids) => {
    if (ids && ids.length > 0 && !ids.includes(target.id)) return
    const now = deps.store.find(host.id)
    if (!now) return
    if (embedBodyOf(now, find) !== kind) deps.repaint(host.id)
  })
  return () => {
    off()
    body()
  }
}

function noteEl(status: 'self' | 'dangling' | 'broken'): HTMLElement {
  const el = document.createElement('div')
  el.className = 'embed-note'
  el.textContent =
    status === 'self' ? t('ui.embed.self') : status === 'dangling' ? t('ui.embed.dangling') : t('ui.embed.broken')
  return el
}

function removeBtn(hostId: string, deps: EmbedBodyDeps): HTMLElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'embed-remove ui-btn'
  btn.textContent = t('ui.embed.remove')
  btn.title = t('ui.embed.removeHint')
  btn.addEventListener('click', () => {
    deps.invoke('core.embed/remove', { blockId: hostId }, 'embed')
  })
  return btn
}

/**
 * **投影**：与正文里那个查询块**同一形状** —— 名字占一行（块标旁），结果面板折在下一行。
 *
 * 为什么不把名字留在面板里（`ViewHost` 自己的抬头）：那是面板的 chrome，长得像
 * 「一张表的标题」，而这一行本来就是一个**查询块**。同一个块在正文里长什么样、
 * 在这里就长什么样 —— 只换身份标记（空心块标），不换形状。
 *
 * 两格的分工是**折叠**的边界：`title-row` 永远在（折起来也看得见），`panel` 是
 * 「下一层」，折的就是它（`data-folded` 只藏不卸，ViewHost 的冻结与滚动还在）。
 */
function mountProjection(host: Block, target: Block, into: HTMLElement, deps: EmbedBodyDeps): () => void {
  const titleRow = document.createElement('div')
  titleRow.className = 'embed-title-row'
  titleRow.contentEditable = 'false'
  const panel = document.createElement('div')
  panel.className = 'embed-panel'
  panel.contentEditable = 'false'
  panel.setAttribute(EDIT_ISLAND_ATTR, '1')
  into.append(titleRow, panel)
  return deps.mountView(host, target, panel, titleRow)
}

/** 镜像：源自己那一行 ＋ 它的子树，装进一台岛编辑器（能就地改） */
function mountMirror(target: Block, into: HTMLElement, deps: EmbedBodyDeps): () => void {
  const hostEl = document.createElement('div')
  hostEl.className = 'embed-mirror'
  const load = (ed: BlockEditor | null): void => {
    if (!ed) return
    ed.loadPage({ roots: [target], folded: ed.doc.folded })
  }
  const island = new EditableBlock({
    host: hostEl,
    store: deps.store,
    write: (fn) => deps.run(fn),
    initialRoots: [target],
    // 深度 1：这一份装载里不再展开露面块（构造性截断）
    embedBodies: false,
    // 镜像的根是源块：根不能搬/并出这棵子树（外层兄弟不在这一屏里）
    structuralScope: 'roots',
    load,
    wire: deps.wire,
    onChange: deps.onChange,
    onFocus: deps.onFocus,
    area: into,
  })
  into.appendChild(island.root)
  load(island.ensureEditor())
  return () => {
    island.dispose()
    island.root.remove()
  }
}
