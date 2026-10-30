/**
 * **露面块的身体**：镜像（一台嵌套编辑器）或投影（大纲表格）。
 *
 * 为什么身体必须是一个**编辑岛**：同一个块可能在同一屏出现两次（源在正文原位、
 * 这里又露面一次）。岛根把焦点与重排切成两个世界——外层编辑器不抢里层光标，
 * 里层打字也不触发外层重排（见 `ui/editable-block.ts` 与 `view/editor.ts` 的 `blockEl`）。
 *
 * 两种看法各走各的路，但**共用同一个源**：
 *   · 镜像 ＝ 把源的整棵子树装进一台 `EditableBlock`（含源自己那一行，所以能就地改）；
 *   · 大纲表格 ＝ `ViewListTable`（行＝源的直接子块），与整屏那张表是同一个渲染器。
 *
 * 深度 1 由构造固定：镜像里那台编辑器带 `embedBodies: false`，里面的露面块只画占位。
 * 这不是「用 visited 集合拦」——递归渲染的结果不能依赖遍历顺序。
 */
import {
  activeView,
  isDeleted,
  resolveEmbed,
  type Block,
  type BlockStore,
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

  const view = activeView(host)
  if (view && view.kind === 'list-table') return mountTable(host, target, into, deps)
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

/** 大纲表格：行＝源的直接子块（与整屏那张表同一个渲染器） */
function mountTable(host: Block, target: Block, into: HTMLElement, deps: EmbedBodyDeps): () => void {
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
  const view = activeView(host)
  if (!view) {
    cell.dispose()
    return () => {}
  }
  const table = new ViewListTable({
    store: deps.store,
    // 表的「容器」是**源**：行是它的直接子块（露面块自己只是宿主）
    host: () => target,
    view: () => view,
    kb: deps.kb,
    cell,
    openBlock: deps.openBlock,
    deleteRow: (rowId) => deps.invoke('core.view/delete-row', { rowId }, 'embed'),
  })
  into.appendChild(table.root)
  table.render()
  // 表的成员是活的：源里增删一行，这里跟着变（按 id 局部修补，不整表重搭）
  const off = deps.store.subscribe((_source, ids) => {
    table.render(ids)
  })
  return () => {
    off()
    table.dispose()
    cell.dispose()
  }
}
