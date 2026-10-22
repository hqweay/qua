/**
 * 命令处理器 —— **app 层**（59 ）：handler 只经 `App` 门面改状态，不碰 DOM。
 *
 * 原先与命令表、Registry 挤在同一个文件里 ⇒ core 文件不得不认识 app 实现。
 * 拆开后依赖方向恢复单向：core（表/注册表）← app（handler）← main（装配）。
 */
import { t } from '../core/msg.ts'
import type { App, Handler } from '../core/ports.ts'

/* ------------------------------------------------------------ 处理器 */

const S = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)

/** 当前块（没有就退回第一块；空库返回 null） */
function curBlock(app: App): string | null {
  return app.ed.caretBlock() ?? app.ed.rows()[0]?.block.id ?? null
}

export const HANDLERS: Record<string, Handler> = {
  /* ---- 结构 ---- */
  'core.editor/split-block': (_a, app) => {
    const id = curBlock(app)
    if (!id) return false
    app.ed.split(id, app.ed.caretOffset())
    return true
  },
  // ⌘A：接管原生全选（66 ）——见 `view/editor.ts` 的 `selectAll` 注释
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
    // 分割线没有正文可落光标：插入动作自己负责在它下面留一个落点
    if (type === 'divider') return app.ed.insertDividerAfter(id)
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
    app.ed.insertAtom('page', {
      label: page.title || t('ui.page.untitled'),
      target: { kind: 'page', id: page.id },
      quote: app.ed.quoteAtSel(),
    })
    return true
  },
  'core.editor/insert-image': (a, app) => {
    const preset = S(a.preset, 'ready')
    const missing = preset === 'missing'
    app.ed.insertAtom('image', {
      label: missing ? t('ui.demo.assetMissingName') : t('ui.demo.assetReadyName'),
      asset: {
        hash: 'b7d4' + '1f0a'.repeat(4),
        name: missing ? t('ui.demo.assetMissingName') : t('ui.demo.assetReadyName'),
        bytes: missing ? 0 : 348_160,
        mime: 'image/png',
        state: missing ? 'missing' : 'ready',
        w: 1280,
        h: 800,
      },
    })
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
  /* ---- 属性 ---- */
  'core.props/set-value': (a, app) => {
    const blockId = S(a.blockId)
    const propId = S(a.propId)
    if (!blockId || !propId) return false
    app.setPropValue(blockId, propId, a.value)
    return true
  },
  'core.props/clear-value': (a, app) => {
    const blockId = S(a.blockId)
    const propId = S(a.propId)
    if (!blockId || !propId) return false
    app.clearPropValue(blockId, propId)
    return true
  },
  'core.props/create-def': (a, app) => {
    const blockId = S(a.blockId)
    const label = S(a.label)
    const kind = S(a.kind, 'text')
    if (!label) return false
    return app.createPropDef(blockId, label, kind) !== ''
  },
  'core.props/add-field': (a, app) => {
    const blockId = S(a.blockId)
    const propId = S(a.propId)
    if (!blockId || !propId) return false
    app.addProp(blockId, propId)
    return true
  },
  'core.props/undeclare': (a, app) => {
    const blockId = S(a.blockId)
    const propId = S(a.propId)
    if (!blockId || !propId) return false
    app.undeclareProp(blockId, propId)
    return true
  },

  /* ---- 角色 ---- */
  'core.block/as-page': (a, app) => {
    const id = S(a.blockId) || curBlock(app)
    return id ? app.addBlockRole(id, 'page') : false
  },
  'core.block/unpage': (a, app) => {
    const id = S(a.blockId) || curBlock(app)
    return id ? app.removeBlockRole(id, 'page') : false
  },
  'core.block/as-tag': (a, app) => {
    const id = S(a.blockId) || curBlock(app)
    return id ? app.addBlockRole(id, 'tag') : false
  },
  'core.block/untag': (a, app) => {
    const id = S(a.blockId) || curBlock(app)
    return id ? app.removeBlockRole(id, 'tag') : false
  },
  'core.block/set-type': (a, app) => {
    const id = S(a.blockId) || curBlock(app)
    const type = S(a.type)
    if (!id || !type) return false
    return app.setBlockType(id, type)
  },

  /* ---- 标签层级 ---- */
  'core.tags/add-parent': (a, app) => {
    const childId = S(a.childId)
    const parentId = S(a.parentId)
    if (!childId || !parentId) return false
    return app.addTagParent(childId, parentId)
  },
  'core.tags/remove-parent': (a, app) => {
    const childId = S(a.childId)
    const parentId = S(a.parentId)
    if (!childId || !parentId) return false
    app.removeTagParent(childId, parentId)
    return true
  },
  'core.tags/prune-parents': (a, app) => {
    const childId = S(a.childId)
    if (!childId) return false
    app.pruneTagParents(childId)
    return true
  },
  'core.editor/pick-tag': (_a, app) => {
    app.showTagPicker()
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

  /* ---- 页面 ---- */
  'core.page/new': (_a, app) => {
    app.newPage()
    return true
  },
  'core.page/open': (a, app) => {
    const id = S(a.pageId)
    if (!id) return false
    app.openPage(id)
    return true
  },
  'core.page/next': (_a, app) => {
    const pages = app.listPages()
    const i = pages.findIndex((p) => p.id === app.activePageId())
    const next = pages[(i + 1) % pages.length]
    if (!next) return false
    app.openPage(next.id)
    return true
  },
  'core.page/prev': (_a, app) => {
    const pages = app.listPages()
    const i = pages.findIndex((p) => p.id === app.activePageId())
    const prev = pages[(i - 1 + pages.length) % pages.length]
    if (!prev) return false
    app.openPage(prev.id)
    return true
  },
  // ⚠️ 命令不知道 UI（59 ）：这里**只表达意图**，焦点/选区由装配层的 `app.focusTitle` 负责。
  //    底座轮记的「handler 越界碰 DOM」就是这里——`scripts/arch-check.mjs` 的 §17 现在会拦它。
  'core.page/rename': (_a, app) => {
    app.focusTitle()
    return true
  },

  /* ---- 日记（今日是落点，不是特例代码路径） ---- */
  'core.journal/today': (a, app) => {
    app.journalToday(typeof a.date === 'string' ? a.date : undefined)
    return true
  },
  'core.journal/prev': (_a, app) => {
    app.journalShift(-1)
    return true
  },
  'core.journal/next': (_a, app) => {
    app.journalShift(1)
    return true
  },
  'core.page/delete': (_a, app) => {
    app.deletePage(app.activePageId())
    return true
  },

  /* ---- zoom ---- */
  'core.block/focus-block': (a, app) => {
    // 缺省目标是**光标所在块**（块菜单就是这么调的：它不传 args）
    const id = typeof a.blockId === 'string' && a.blockId !== '' ? a.blockId : app.ed.caretBlock()
    if (!id) return false
    app.zoomTo(id)
    return true
  },
  'core.block/zoom-out': (_a, app) => {
    app.zoomOut()
    return true
  },

  /* ---- 视图 ---- */
  'core.view/toggle-theme': (_a, app) => {
    app.toggleTheme()
    return true
  },
  'core.view/set-theme': (a, app) => {
    app.setTheme(S(a.mode, 'system'))
    return true
  },
  // 旧的 toggle-rail 保留为**左槽的别名**（命令面板与老键位不失效）；新名字是 core.dock/*
  'core.view/toggle-rail': (_a, app) => {
    app.toggleDock('left')
    return true
  },
  'core.dock/toggle-left': (_a, app) => {
    app.toggleDock('left')
    return true
  },
  'core.dock/toggle-right': (_a, app) => {
    app.toggleDock('right')
    return true
  },
  'core.view/toggle-virtualize': (a, app) => {
    const on = typeof a.on === 'boolean' ? a.on : !app.ed.virtualize
    app.setVirtualize(on, typeof a.radius === 'number' ? a.radius : 12)
    return true
  },

  /* ---- 浮层 ---- */
  'core.command-palette/show': (_a, app) => {
    app.showMenu({ kind: 'palette', anchor: null, title: t('menu.title.palette') })
    return true
  },
  'core.menu/block': (a, app) => {
    const id = S(a.blockId) || curBlock(app)
    if (!id) return false
    const el = app.ed.blockEl(id)
    app.showMenu({ kind: 'menu', prefix: 'block/', anchor: el?.getBoundingClientRect() ?? null, title: t('menu.title.block') })
    return true
  },
  'core.menu/slash': (_a, app) => {
    app.showMenu({ kind: 'slash', anchor: app.ed.caretRect(), title: t('menu.title.slash'), query: '' })
    return true
  },
  'core.layer/close': (_a, app) => {
    app.closeLayers()
    return true
  },

  /* ---- 诊断 ---- */
  'core/context-keys/inspect': (_a, app) => {
    app.showPanel('context')
    return true
  },
  'core/bindings/list': (_a, app) => {
    app.showPanel('bindings')
    return true
  },
  'core/help/shortcuts': (_a, app) => {
    app.showPanel('shortcuts')
    return true
  },
  'core/debug/dump-model': (_a, app) => {
    app.showPanel('model')
    return true
  },

  /* ---- 演示 ---- */
  'core.demo/load-state': (a, app) => {
    const s = S(a.state, 'seed')
    if (s !== 'seed' && s !== 'empty' && s !== 'sparse' && s !== 'degraded' && s !== 'boot') return false
    app.loadState(s)
    return true
  },
  'core.demo/simulate-ime': (_a, app) => {
    const r = app.runImeProbe()
    app.toast(t('ui.toast.imeProbe', { fired: r.fired, seq: r.seq.join('→') }), r.fired === 0 ? 'ok' : 'warn')
    return true
  },
  'core.demo/reset-all': (_a, app) => {
    app.loadState('seed')
    app.toast(t('ui.toast.resetAll'))
    return true
  },
}
