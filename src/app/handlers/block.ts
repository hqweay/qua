/**
 * 结构类 handler：块自身的拆/并/缩进/增删，块选区，行内原子，区间格式，历史。
 *
 * 判据：它们动的是**编辑器里的那几块**，落点都是「当前块」。
 * 只经 `App` 门面改状态（`app.ed.*`），不碰 DOM。
 */
import { t } from '../../core/msg.ts'
import { COLLECTION_TYPE } from '../../core/index.ts'
import type { Handler } from '../../core/ports.ts'
import { curBlock, S } from './shared.ts'

export const STRUCT_HANDLERS: Record<string, Handler> = {
  /* ---- 结构 ---- */
  'core.editor/split-block': (_a, app) => {
    const id = curBlock(app)
    if (!id) return false
    app.ed.split(id, app.ed.caretOffset())
    return true
  },
  // ⌘A：接管原生全选（系统键归命令表）——见 `view/editor.ts` 的 `selectAll` 注释
  'core.editor/select-all': (_a, app) => app.ed.selectAll(),
  'core.editor/backspace': (_a, app) => {    // 合并成 ⇒ 已处理；没合并 ⇒ **放行给浏览器**（原生删除：命名的威力在于**允许不处理**）
    return app.ed.backspaceAtCaret()
  },
  'core.editor/indent-block': (_a, app) => {
    const id = curBlock(app)
    if (!id) return false
    app.ed.indent(id)
    return true
  },
  'core.editor/outdent-block': (_a, app) => {
    const id = curBlock(app)
    if (!id) return false
    app.ed.outdent(id)
    return true
  },
  'core.editor/move-block-up': (_a, app) => {
    const id = curBlock(app)
    if (!id) return false
    app.ed.move(id, -1)
    return true
  },
  'core.editor/move-block-down': (_a, app) => {
    const id = curBlock(app)
    if (!id) return false
    app.ed.move(id, 1)
    return true
  },
  'core.editor/toggle-collapse': (_a, app) => {
    const id = curBlock(app)
    if (!id) return false
    app.ed.toggleCollapse(id)
    return true
  },
  'core.editor/toggle-children-collapse': (_a, app) => {
    const id = curBlock(app)
    if (!id) return false
    app.ed.toggleChildrenCollapse(id)
    return true
  },
  'core.editor/duplicate-block': (_a, app) => {
    const id = curBlock(app)
    if (!id) return false
    app.ed.duplicate(id)
    app.toast(t('ui.toast.blockDuplicated'))
    return true
  },
  'core.editor/delete-block': (_a, app) => {
    const id = curBlock(app)
    if (!id) return false
    app.ed.remove(id)
    app.toast(t('ui.toast.blockDeleted'))
    return true
  },
  'core.editor/toggle-todo': (_a, app) => {
    const id = curBlock(app)
    if (!id) return false
    app.ed.toggleTodo(id)
    return true
  },
  'core.editor/insert-block': (a, app) => {
    const id = curBlock(app)
    if (!id) return false
    const text = S(a.text, '')
    const type = S(a.type, 'paragraph')
    // 分割线／组件块没有正文可落光标：插入动作自己负责在它下面留一个落点
    if (type === 'divider') return app.ed.insertDividerAfter(id)
    if (type === 'collection') return app.ed.insertWidgetAfter(id, COLLECTION_TYPE)
    const todo = type === 'todo' ? ('todo' as const) : undefined
    app.ed.insertBlockAfter(id, text, todo)
    return true
  },  'core.editor/clear-block': (_a, app) => {
    const id = curBlock(app)
    if (!id) return false
    app.ed.setText(id, '')
    return true
  },
  'core.editor/insert-tag': (a, app) => {
    if (!curBlock(app)) return false
    const tag = S(a.tag, t('ui.arg.defaultTag'))
    // 整件事在门面里一次做完：ensureTag（可能写森林）＋ 写当前块的归属。
    // 标签标的是**整个块**，所以落点是当前块，与光标在块内哪儿无关。
    app.insertTag(tag)
    return true
  },
  'core.editor/copy-ref': (_a, app) => {
    const id = curBlock(app)
    if (!id) return false
    const q = app.ed.quoteAtSel()
    app.copy(
      JSON.stringify({ target: { kind: 'block', id }, quote: q ?? null }, null, 2),
      t('ui.toast.refCopied'),
    )
    return true
  },
  'core.editor/delete-selected-blocks': (_a, app) => app.ed.deleteSelectedBlocks(),
  'core.editor/copy-selected-blocks': (_a, app) => {
    const text = app.ed.selectedBlocksText()
    if (!text) return false
    app.copy(text, t('ui.toast.blocksCopied'))
    return true
  },
  'core.editor/copy-selected-block-refs': (_a, app) => {
    const text = app.ed.selectedBlockRefs()
    if (!text) return false
    app.copy(text, t('ui.toast.blockRefsCopied'))
    return true
  },
  'core.selection/clear': (_a, app) => {
    const had = app.ed.hasBlockSelection()
    app.ed.clearBlockSelection()
    return had
  },
  'core.selection/select-all-blocks': (_a, app) => app.ed.selectAllBlocks(),
  'core.selection/focus-first': (_a, app) => app.ed.focusFirstSelected(),
  'core.selection/extend-up': (a, app) => app.ed.extendBlockSelection(Number(a.dir) === 1 ? 1 : -1),
  'core.selection/extend-down': (a, app) => app.ed.extendBlockSelection(Number(a.dir) === -1 ? -1 : 1),

  /* ---- 行内原子 ---- */
  'core.editor/insert-page-ref': (a, app) => {
    const pageId = S(a.pageId)
    if (!pageId) {
      app.showRefPicker()
      return true
    }
    const page = app.listPages().find((p) => p.id === pageId)
    if (!page) return false
    app.ed.insertRef({ to: page.id, label: page.title || t('ui.page.untitled') })
    return true
  },
  'core.editor/insert-image': (a, app) => {
    const preset = S(a.preset, 'ready')
    const missing = preset === 'missing'
    app.ed.insertImage(
      {
        hash: 'b7d4' + '1f0a'.repeat(4),
        name: missing ? t('ui.sample.assetMissingName') : t('ui.sample.assetReadyName'),
        state: missing ? 'missing' : 'ready',
      },
      { w: 1280, h: 800 },
    )
    return true
  },

  /* ---- 区间格式 ---- */
  'core.editor/remove-atom': (a, app) => {
    const id = S(a.atomId)
    if (!id) return false
    // 摘标签可能要提示「清理它带来的值」⇒ 走门面，而不是直接调编辑器
    app.removeAtom(id)
    return true
  },
  'core.anno/toggle-bold': (_a, app) => {
    app.ed.toggleMark('bold')
    return true
  },
  'core.anno/toggle-italic': (_a, app) => {
    app.ed.toggleMark('italic')
    return true
  },
  'core.anno/toggle-highlight': (_a, app) => {
    app.ed.toggleMark('highlight')
    return true
  },
  'core.anno/toggle-code': (_a, app) => {
    app.ed.toggleMark('code')
    return true
  },
  'core.anno/clear-marks': (_a, app) => {
    app.ed.clearMarksAtSel()
    return true
  },

  /* ---- 历史 ---- */
  'core.history/undo': (_a, app) => {
    app.ed.undoStep()
    return true
  },
  'core.history/redo': (_a, app) => {
    app.ed.redoStep()
    return true
  },
  'core.history/back': (_a, app) => app.historyBack(),
  'core.history/forward': (_a, app) => app.historyForward(),
}
