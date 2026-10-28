/**
 * 结构类 handler：块自身的拆/并/缩进/增删，块选区，行内原子，区间格式，历史。
 *
 * 判据：它们动的是**编辑器里的那几块**，落点都是「当前块」。
 * 只经 `App` 门面改状态（`app.ed.*`），不碰 DOM。
 */
import { t } from '../../core/msg.ts'
import { COLLECTION_TYPE, checkExternalUrl, rejectText } from '../../core/index.ts'
import { MISSING_ASSET_HASH, SEED_ASSET_H, SEED_ASSET_HASH, SEED_ASSET_W } from '../../core/fixtures/assets.ts'
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
  /**
   * 从回收站恢复一块（回收站卡的「恢复」按钮与命令面板共用这一条）。
   *
   * 判据：恢复**不改变「它是哪一块」**——只摘掉删除标记，块回到原位。
   * 所以这里不新建块、不复制内容，也不改它的 id（引用它的地方会自己接回来）。
   */
  'core.block/restore': (args, app) => {
    const id = (args as { blockId?: string }).blockId
    if (!id) return false
    if (!app.ed.restoreFromTrash(id)) return false
    app.toast(t('ui.toast.blockRestored'))
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
    /**
     * **没有 `preset` ⇒ 真入口**：选一张图（隐藏的 file input）→ 校验 → 入库 → 按捕获点插 run。
     * 这段时序是异步的（算 hash、写字节、读尺寸），所以只能交给门面：
     * 命令 handler 同步返回 `handled`，它拿不到「入库回来之后」那一刻。
     *
     * **有 `preset` ⇒ 验收/演示入口**：直接插种子里的样本（`ready`）或刻意缺失的地址
     * （`missing`）。冒烟用它验「缺失态长什么样」，不需要真的去挑一张图。
     */
    const preset = a.preset === undefined ? undefined : S(a.preset, 'ready')
    if (preset === undefined) {
      app.pickImage()
      return true
    }
    app.ed.insertAsset(preset === 'missing' ? MISSING_ASSET_HASH : SEED_ASSET_HASH, {
      label: preset === 'missing' ? t('ui.sample.assetMissingName') : t('ui.sample.assetReadyName'),
      w: SEED_ASSET_W,
      h: SEED_ASSET_H,
    })
    return true
  },

  /**
   * 外链：给 `url` ⇒ 直接插（机器接口与验收走这一条）；不给 ⇒ 开输入框（人走的入口）。
   *
   * ⚠️ 协议白名单在这里**先判一次**：插入与打开是外链仅有的两个出口，
   *    两个都判、判据只有 `core/link.ts` 那一份，就不会出现「能插进去但打不开」的链接。
   */
  'core.editor/insert-link': (a, app) => {
    if (a.url === undefined) {
      app.showLinkComposer()
      return true
    }
    const chk = checkExternalUrl(S(a.url))
    if (!chk.ok) {
      app.toast(rejectText(chk), 'warn')
      return true
    }
    const text = a.text === undefined ? undefined : S(a.text)
    return app.ed.insertLink({ url: chk.url, ...(text === undefined ? {} : { text }) }) !== null
  },

  /**
   * **锚文本**（这一处引用显示什么）：`text` 为空串 ⇒ 删掉这个键 ⇒ 回到「跟随目标现算」。
   *
   * ⚠️ 入口只有 ⌥ 浮层那一个输入框（正文流里的原子不可编辑），
   *    命令化是为了让撤销与落盘走同一条路，不是为了给人第二个入口。
   */
  'core.editor/set-anchor': (a, app) => app.ed.setRunAnchor(S(a.atomId), S(a.text)),

  /**
   * 打开一枚外链：`atomId` ⇒ 去正文里读它**此刻**的 url（run 是唯一事实源，
   * 浮层上显示的那一份是它的投影）。点与浮层的「打开」按钮共用这一条命令。
   */
  'core.link/open': (a, app) => {
    const atomId = S(a.atomId)
    if (!atomId) return false
    const hit = app.ed.findRun(atomId)
    if (!hit || hit.run.t !== 'link') return false
    return app.openExternal(hit.run.url)
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
