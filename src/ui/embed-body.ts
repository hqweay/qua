/**
 * **露面块的身体**：镜像（一台嵌套编辑器）或投影（源块上那张命名视图的渲染器）。
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
 * 深度 1 由构造固定：镜像里那台编辑器带 `embedBodies: false`，里面的露面块只画占位。
 * 这不是「用 visited 集合拦」——递归渲染的结果不能依赖遍历顺序。
 */
import {
  isDeleted,
  resolveEmbed,
  resolveBoundView,
  readViewSet,
  type Block,
  type BlockStore,
  type ViewConfig,
  type ViewOwnerStore,
} from '../core/index.ts'
import type { KbClient } from '../core/kb/types.ts'
import type { Tx } from '../core/kb/types.ts'
import { t } from '../core/msg.ts'
import type { BlockEditor } from '../view/editor.ts'
import { BlockCell, type AtomHit, type CellClickMods, type RefHit } from './block-cell.ts'
import { EditableBlock } from './editable-block.ts'
import { ViewListTable } from './view-list-table.ts'

export interface EmbedBodyDeps {
  store: BlockStore
  kb: KbClient
  /** 命令层的事务入口（撤销快照与重画归装配层） */
  run: <R>(fn: (tx: Tx) => R) => R
  /** 视图配置的唯一接缝：这一层不摸 `props._views`，只问「这次露面选了哪张视图」 */
  owners: ViewOwnerStore
  wire: (ed: BlockEditor, change: (kind: string) => void) => void
  onFocus: (ed: BlockEditor) => void
  onChange: (kind: string) => void
  project: (block: Block, into: HTMLElement) => void
  refClick: (hit: RefHit, el: HTMLElement, mods: CellClickMods) => void
  onAtomClick?: (atom: AtomHit, el: HTMLElement, mods: CellClickMods) => void
  openBlock: (blockId: string) => void
  invoke: (name: string, args: Record<string, unknown>, via?: string) => void
  toast?: (text: string, kind?: 'ok' | 'warn' | 'info') => void
}

/**
 * 给一个露面块装身体。返回卸载函数——**换 DOM 之前必须调用**（里层是另一台编辑器／
 * 一张订阅 store 的表；不卸载就会每次重排留一份订阅）。
 */
export function mountEmbedBody(host: Block, into: HTMLElement, deps: EmbedBodyDeps): () => void {
  const res = resolveEmbed(host, (id) => deps.store.find(id))
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

  /**
   * 这一次露面选的那张视图：经绑定解析（`''` 跟随源、`'outline'` 强制大纲、其余是视图 id）。
   *
   * ⚠️ 目标那张视图没了 ⇒ **退回源块的默认看法并说一句实话**，不猜、也不偷偷改指针：
   *    指针没坏（源还在），坏的只是那一张视图。
   */
  const binding = deps.owners.readBinding({ kind: 'embed', blockId: host.id })
  const data = binding ? deps.owners.read(binding.owner) : null
  const picked = binding && data ? resolveBoundView(binding, data) : { view: null, degraded: false }
  const view: ViewConfig | null = picked.view ?? (data ? readViewSet(data).active : null)
  if (picked.degraded) deps.toast?.(t('ui.mount.viewGone'), 'warn')

  if (view && view.kind === 'list-table') return mountTable(target, view, into, deps)
  if (view) {
    // 别的看法（看板／画廊…）还没有渲染器：说清楚，不假装它是大纲
    into.dataset.embedState = 'norenderer'
    const note = document.createElement('div')
    note.className = 'embed-note'
    note.textContent = t('ui.embed.noRenderer')
    into.appendChild(note)
    return () => {}
  }
  return mountMirror(target, into, deps)
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

/** 大纲表格：表头＝源的直接子块、一列＝那个子块的孩子（与整屏那张表同一个渲染器） */
function mountTable(target: Block, view: ViewConfig, into: HTMLElement, deps: EmbedBodyDeps): () => void {
  const cell = new BlockCell({
    store: deps.store,
    write: (fn) => deps.run(fn),
    wire: deps.wire,
    onFocus: deps.onFocus,
    onChange: deps.onChange,
    project: deps.project,
    refClick: deps.refClick,
    ...(deps.onAtomClick ? { onAtomClick: deps.onAtomClick } : {}),
    openBlock: deps.openBlock,
  })
  const table = new ViewListTable({
    store: deps.store,
    // 表的「容器」是**源**：表头是它的直接子块（露面块自己只是宿主）
    host: () => target,
    view: () => view,
    kb: deps.kb,
    cell,
    // 嵌入是一行里的投影：源的名字在屏幕上没有第二处 ⇒ 用表标题说清楚它是哪棵树
    showCaption: true,
    openBlock: deps.openBlock,
    insertItem: (columnId) =>
      deps.invoke('core.view/new-row', { owner: { kind: 'block', blockId: target.id }, blockId: columnId }, 'embed'),
    deleteBlock: (id) => deps.invoke('core.view/delete-row', { rowId: id }, 'embed'),
  })
  into.appendChild(table.root)
  table.render()
  // 表的成员是活的：源里增删一块，这里跟着变（按 id 局部修补，不整表重搭）
  const off = deps.store.subscribe((_source, ids) => {
    table.render(ids)
  })
  return () => {
    off()
    table.dispose()
    cell.dispose()
  }
}
