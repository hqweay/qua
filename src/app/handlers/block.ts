/**
 * 结构类 handler：块自身的拆/并/缩进/增删，块选区，行内原子，区间格式，历史。
 *
 * 判据：它们动的是**编辑器里的那几块**，落点都是「当前块」。
 * 只经 `App` 门面改状态（`app.ed.*`），不碰 DOM。
 */
import { t } from '../../core/infra/msg.ts'
import { checkExternalUrl, isJournalDate, journalDateLabel, rejectText } from '../../core/index.ts'
import { MISSING_ASSET_HASH, SEED_ASSET_HASH } from '../../core/fixtures/assets.ts'
import type { App, Handler } from '../../core/infra/ports.ts'
import { buildCopyHtml } from '../../view/editor/clipboard-flavor.ts'
import { curBlock, S } from './shared.ts'

/**
 * 块复制的多味载体（引用意图）：正文味给外部应用，HTML 载荷给本应用
 * （软内 ⌘V 贴成引用）。`text` 缺省时按 id 现取块正文。
 * 确认不弹话：被抄的行抖一下（`confirmGrab`，reduced-motion 退回提示）；
 * 「抓的是这一块」一族共用这条通道，写入失败的警告照弹。
 */
const copyRefs = (app: App, ids: readonly string[], text?: string): void => {
  const body = text ?? ids.map((id) => app.ed.clip.plainTextOf(id)).filter(Boolean).join('\n')
  app.copyFlavors({ text: body, html: buildCopyHtml(body, { ids: [...ids] }), clip: { ids: [...ids] } }, null)
  app.confirmGrab(ids, t('ui.toast.blockRefCopied'))
}

export const STRUCT_HANDLERS: Record<string, Handler> = {
  /* ---- 结构 ---- */
  'core.editor/split-block': (_a, app) => {
    const id = curBlock(app)
    if (!id) return false
    app.ed.struct.split(id, app.ed.caretOffset())
    return true
  },
  // ⌘A：接管原生全选（系统键归命令表）——见 `view/editor.ts` 的 `selectAll` 注释
  'core.editor/select-all': (_a, app) => app.ed.selectAll(),
  'core.editor/backspace': (_a, app) => {    // 合并成 ⇒ 已处理；没合并 ⇒ **放行给浏览器**（原生删除：命名的威力在于**允许不处理**）
    return app.ed.struct.backspaceAtCaret()
  },
  'core.editor/indent-block': (_a, app) => {
    const id = curBlock(app)
    if (!id) return false
    app.ed.struct.indent(id)
    return true
  },
  'core.editor/outdent-block': (_a, app) => {
    const id = curBlock(app)
    if (!id) return false
    app.ed.struct.outdent(id)
    return true
  },
  'core.editor/move-block-up': (_a, app) => {
    const id = curBlock(app)
    if (!id) return false
    app.ed.struct.move(id, -1)
    return true
  },
  'core.editor/move-block-down': (_a, app) => {
    const id = curBlock(app)
    if (!id) return false
    app.ed.struct.move(id, 1)
    return true
  },
  'core.editor/toggle-collapse': (_a, app) => {
    const id = curBlock(app)
    if (!id) return false
    app.ed.toggleCollapse(id)
    return true
  },
  'core.editor/toggle-children-collapse': (a, app) => {
    // 导轨点击带着显式 blockId（它不改光标，目标块不一定是聚焦块）；键位／面板走聚焦块
    const id = typeof a.blockId === 'string' && a.blockId !== '' ? a.blockId : curBlock(app)
    if (!id) return false
    app.ed.toggleChildrenCollapse(id)
    return true
  },
  'core.editor/duplicate-block': (_a, app) => {
    const id = curBlock(app)
    if (!id) return false
    app.ed.struct.duplicate(id)
    app.toast(t('ui.toast.blockDuplicated'))
    return true
  },
  'core.editor/delete-block': (_a, app) => {
    const id = curBlock(app)
    if (!id) return false
    // remove 对「有身份的装载根」等会静默拒绝——没删就不说「已删除」
    if (!app.ed.struct.remove(id)) return false
    app.toast(t('ui.toast.blockDeleted'))
    return true
  },
  /**
   * 修一枚 dangling 引用：回收站里有目标 ⇒ 恢复；真没了 ⇒ 建同名块并把这一枚指过去。
   * 两条都在 `BlockEditor.repairRef` 里，判据只有那一份（菜单只负责显示哪一句文案）。
   */
  'core.editor/repair-ref': (a, app) => {
    const id = S(a.atomId)
    if (!id) return false
    const r = app.ed.repairRef(id)
    if (r === 'restored') app.toast(t('ui.toast.refRestored'))
    else if (r === 'repointed') app.toast(t('ui.toast.refRebuilt'))
    return r !== 'none'
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
    if (!app.ed.struct.restoreFromTrash(id)) return false
    app.toast(t('ui.toast.blockRestored'))
    return true
  },
  /**
   * 永久清除回收站条目（回收站卡的「清空」是唯一入口，确认框长在卡里——
   * 这条命令本身不带确认：从别处调它不会问）。
   *
   * 判据：purge **不进撤销栈**（不可逆是口径）——所以它不走编辑器写入口，
   * 走 `App.purgeTrash`（撤销/重做同一条 op 路：建 op → 应用 → 宣布 → 落盘）。
   */
  'core.trash/purge': (args, app) => {
    const raw = (args as { ids?: string }).ids ?? ''
    const ids = raw.split(',').filter((s) => s !== '')
    if (ids.length === 0) return false
    const n = app.purgeTrash(ids)
    if (n === 0) return false
    app.toast(t('ui.toast.trashPurged', { count: String(n) }))
    return true
  },
  // 提及栏片段行的按钮与块菜单那一条都走这道门面；区间复核与「没转成」的实话在门面那一步
  'core.block/convert-mention': (a, app) => {
    // 菜单行不带参数：它问的是「光标正停在哪一处命中上」，与 ⌥ 单击同一份判据
    if (!a.blockId) {
      const hit = app.ed.mentionHitAtCaret()
      const id = app.ed.caretBlock()
      if (!hit || !id) return false
      return app.convertMention(id, hit.to, hit.start, hit.end)
    }
    return app.convertMention(S(a.blockId), S(a.to), Number(a.start), Number(a.end))
  },
  'core.editor/toggle-todo': (_a, app) => {
    const id = curBlock(app)
    if (!id) return false
    app.ed.toggleTodo(id)
    return true
  },
  /**
   * 「取消待办」：摘掉这一块的任务状态（`toggleTodo` 的反向，见 `editor.clearTodo`）。
   *
   * ⚠️ 返回值分三种，但**命令只回答「做没做」**：`none`（本来就不是任务）＝ false，
   *    另外两种都改过模型 ＝ true。牌子只在「摘了但它还在」时打一句 ——
   *    那种情况是标签声明给的，静默就会变成「点了没反应」。
   */
  'core.editor/clear-todo': (_a, app) => {
    const id = curBlock(app)
    if (!id) return false
    const r = app.ed.clearTodo(id)
    if (r === 'declared') app.toast(t('ui.todo.declaredByTag'), 'info')
    return r !== 'none'
  },
  'core.editor/insert-block': (a, app) => {
    const id = curBlock(app)
    if (!id) return false
    const text = S(a.text, '')
    const type = S(a.type, 'paragraph')
    // 分割线没有正文可落光标：插入动作自己负责在它下面留一个落点
    if (type === 'divider') return app.ed.insert.insertDividerAfter(id)
    /**
     * 只认这两种写正文的类型。**未知类型不降级成段落**：命令面的 `enum` 只是元数据，
     * `invoke` 不会按它校验——放过去就会「插了一行普通文字」，
     * 而用户以为那个类型还在（删掉的入口不该变成另一种东西）。
     */
    if (type !== 'paragraph' && type !== 'todo') return false
    const todo = type === 'todo' ? ('todo' as const) : undefined
    app.ed.insert.insertBlockAfter(id, text, todo)
    return true
  },
  // 缺省目标取光标所在块（curBlock），不是「当前打开的那一屏」——
  // 日记流里 activeId 是第一个根，新块会飞到流顶部而不是光标处
  'core.editor/insert-block-before': (_a, app) => {
    const id = curBlock(app)
    if (!id) return false
    return app.ed.insert.insertBlockBefore(id) !== null
  },
  'core.editor/clear-block': (_a, app) => {
    const id = curBlock(app)
    if (!id) return false
    app.ed.insert.setText(id, '')
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
  // 划选气泡那一颗：选区 → 同名引用（没有同名地址就新建页）。复核、事务、toast 都在门面那一步
  'core.editor/selection-to-ref': (_a, app) => app.convertSelectionToRef(),
  /**
   * 复制成**文本记号** `((block-id))`：粘贴时会被解析成行内引用，也能被「粘贴为…」读成露面源。
   * 与 `copy-ref`（引文快照 JSON）分开：那个是给人看的引文，这个是给库内粘贴用的指针。
   */
  'core.editor/copy-block-ref': (a, app) => {
    const id = S(a.blockId) || curBlock(app)
    if (!id) return false
    copyRefs(app, [id])
    return true
  },
  /**
   * 复制块（块上 ⌘C，光标无划选／块选区都归它）：多味载体——
   * 软内 ⌘V 贴成引用（HTML 载荷），软外 ⌘V 贴出正文（text/plain）。
   * 划选文本的 ⌘C 不归这里：选区非空时键位不命中，原生复制原样保留。
   */
  'core.editor/copy-block': (_a, app) => {
    const snap = app.ed.clip.copySnapshot()
    if (!snap) return false
    copyRefs(app, snap.ids, snap.text)
    return true
  },
  /**
   * 复制份（块上 ⌘⇧C／划选外的情况）：只写正文味、不带引用意图——
   * 软内软外 ⌘V 行为一致，贴出来都是新块。与 ⌘C 是同一动作的两个身份档。
   */
  'core.editor/copy-block-text': (_a, app) => {
    const snap = app.ed.clip.copySnapshot()
    if (!snap) return false
    // 与 ⌘C 同一条确认通道（行抖，reduced-motion 退回提示）——抓的是同一块，不按味分通道
    app.copyFlavors({ text: snap.text }, null)
    app.confirmGrab(snap.ids, t('ui.toast.blocksCopied'))
    return true
  },
  /** 划选 ⌘⇧C：块引＋静态锚文本（划选文本是这一处的显示名；源块改文锚不跟） */
  'core.editor/copy-ref-anchor': (_a, app) => {
    const snap = app.ed.clip.anchorSnapshot()
    if (!snap) return false
    const html = buildCopyHtml(snap.text, { ids: [snap.id], anchor: snap.text })
    app.copyFlavors(
      { text: snap.text, html, clip: { ids: [snap.id], anchor: snap.text } },
      t('ui.toast.refCopied'),
    )
    return true
  },
  /**
   * 剪切块（块选区 ⌘X；光标态 ⌘X 与 ⌘C 同判据——塌缩光标下原生文本剪切无事可做，
   * 剪整块才是有用的那一个）：引用味＋移动意图。⌘X 本身不动文档——移动发生在
   * 粘贴那一刻（一笔事务，id 不变、可反复贴）；划选态键位不命中 ⇒ 原生文本剪切照旧。
   * 成功不弹提示：被抓的行抖一下（`confirmGrab`）就是反馈；失败照常有警告。
   */
  'core.editor/cut-blocks': (_a, app) => {
    const snap = app.ed.clip.copySnapshot()
    if (!snap) return false
    const html = buildCopyHtml(snap.text, { ids: snap.ids, move: true })
    app.copyFlavors({ text: snap.text, html, clip: { ids: snap.ids, move: true } }, null)
    app.confirmGrab(snap.ids, t('ui.toast.cutBlocks'))
    return true
  },
  /** 块选区态的 ⌘V：没有光标，粘贴的东西作为新块落在选区后面（与 paste 事件同一份编辑器实现） */
  'core.editor/paste-into-selection': (_a, app) => {
    void app.readFlavors().then(({ refs, text }) => {
      const r = app.ed.clip.pasteIntoSelection(refs, text)
      if (r === 'gone') app.toast(t('ui.toast.moveSourceGone'), 'warn')
    })
    return true
  },
  'core.editor/delete-selected-blocks': (_a, app) => app.ed.bsel.deleteSelectedBlocks(),
  'core.editor/indent-selected-blocks': (_a, app) => app.ed.bsel.indentSelectedBlocks(),
  'core.editor/outdent-selected-blocks': (_a, app) => app.ed.bsel.outdentSelectedBlocks(),
  'core.editor/toggle-todo-selected-blocks': (_a, app) => app.ed.bsel.toggleTodoSelectedBlocks(),
  'core.editor/copy-selected-blocks': (_a, app) => {
    const text = app.ed.bsel.selectedBlocksText()
    if (!text) return false
    // 与剪切同一条确认通道（行抖，reduced-motion 退回提示）：块选区复制/剪切是同一手势的两档
    app.copyFlavors({ text }, null)
    app.confirmGrab(app.ed.bsel.selectedRootIds(), t('ui.toast.blocksCopied'))
    return true
  },
  'core.editor/copy-selected-block-refs': (_a, app) => {
    const snap = app.ed.clip.copySnapshot()
    if (!snap) return false
    copyRefs(app, snap.ids, snap.text)
    return true
  },
  'core.selection/clear': (_a, app) => {
    const had = app.ed.bsel.hasBlockSelection()
    app.ed.bsel.clearBlockSelection()
    return had
  },
  'core.selection/select-all-blocks': (_a, app) => app.ed.bsel.selectAllBlocks(),
  'core.selection/focus-first': (_a, app) => app.ed.bsel.focusFirstSelected(),
  'core.selection/extend-up': (a, app) => app.ed.bsel.extendBlockSelection(Number(a.dir) === 1 ? 1 : -1),
  'core.selection/extend-down': (a, app) => app.ed.bsel.extendBlockSelection(Number(a.dir) === -1 ? -1 : 1),

  /* ---- 行内原子 ---- */
  'core.editor/insert-page-ref': (a, app) => {
    const pageId = S(a.pageId)
    if (!pageId) {
      app.showRefPicker()
      return true
    }
    const page = app.listPages().find((p) => p.id === pageId)
    if (!page) return false
    app.ed.insert.insertRef({ to: page.id, label: page.title || t('ui.page.untitled') })
    return true
  },
  /**
   * 日期引用：目标＝那天的 journal 块。
   *
   * · 不带 `date` ⇒ 开日历选择器（`App.showDatePicker`）；带 ⇒ 直接插。
   * · **物化与插引用同一撤销条目**（`runGroup`）：不分组的话 ⌘Z 一次只撤掉引用、
   *   留下一个谁也没引用的空 journal 块——半批比慢更贵。
   * · `label` 只是 dangling 兜底快照；显示名走 `displayTextOf` 的日期投影，
   *   目标由 `ensureJournal` 保证存在 ⇒ 实际永远走投影那条。
   */
  'core.editor/insert-date-ref': (a, app) => {
    const date = S(a.date)
    if (!date) {
      app.showDatePicker()
      return true
    }
    if (!isJournalDate(date)) return false
    app.runGroup(() => {
      const id = app.ensureJournal(date)
      app.ed.insert.insertRef({ to: id, label: journalDateLabel(date) })
    })
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
    // 尺寸不在这里：一份字节多大由资产索引回答（见 `AssetRun`）
    app.ed.insert.insertAsset(preset === 'missing' ? MISSING_ASSET_HASH : SEED_ASSET_HASH, {
      label: preset === 'missing' ? t('ui.sample.assetMissingName') : t('ui.sample.assetReadyName'),
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
    return app.ed.insert.insertLink({ url: chk.url, ...(text === undefined ? {} : { text }) }) !== null
  },

  /**
   * **锚文本**（这一处引用显示什么）：`text` 为空串 ⇒ 删掉这个键 ⇒ 回到「跟随目标现算」。
   *
   * ⚠️ 入口只有 ⌥ 浮层那一个输入框（正文流里的原子不可编辑），
   *    命令化是为了让撤销与落盘走同一条路，不是为了给人第二个入口。
   */
  'core.editor/set-anchor': (a, app) => app.ed.setRunAnchor(S(a.atomId), S(a.text)),

  /**
   * **改一枚外链**：显示文字与地址一起写。
   *
   * 地址先过白名单（与插入、打开共用 `core/link.ts`）：非法地址不写模型，
   * 但**给一句话**——静默拒绝会让用户以为自己没按到。
   */
  'core.editor/set-link': (a, app) => {
    const id = S(a.atomId)
    if (!id) return false
    const hit = app.ed.findRun(id)
    if (!hit || hit.run.t !== 'link') return false
    const chk = checkExternalUrl(a.url === undefined ? hit.run.url : S(a.url))
    if (!chk.ok) {
      app.toast(rejectText(chk), 'warn')
      return true
    }
    const text = a.text === undefined ? hit.run.v : S(a.text)
    return app.ed.setRunLink(id, { url: chk.url, text })
  },

  /** 行内原子 → 纯文本：字留在原处，取消的是它作为一个对象的身份 */
  'core.editor/atom-to-text': (a, app) => app.ed.runToText(S(a.atomId)),

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
