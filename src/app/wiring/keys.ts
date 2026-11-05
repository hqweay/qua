/**
 * 键位族：**提示表、上下文键空间、按键派发的接线**。
 *
 * 这里只有接线与「从绑定表现算」的读函数，没有任何手写的按键分支
 * （一次按键做什么永远由绑定表回答；逻辑在 `core/infra/dispatch.ts`）。
 * 上下文键的几个取值晚于本节装配（页历史、活动块都在 pages 分片），
 * 所以收 getter——它们只在运行时被读，装配时刻不需要值。
 */
import { BINDINGS, keyLabel } from '../../core/infra/bindings.ts'
import { installKeydown, type DispatchEnv, type KeyTrace } from '../../core/infra/dispatch.ts'
import { findInForest, flatten, hasList, isJournal, prop, type Block, type CtxKeys } from '../../core/index.ts'
import type { BlockEditor } from '../../view/editor/editor.ts'
import type { Registry } from '../../core/commands/index.ts'
import type { Workspace } from '../../core/infra/workspace.ts'
import type { Layers } from '../../ui/overlay/layers.ts'

export interface KeysDeps {
  getEd: () => BlockEditor
  getWs: () => Workspace
  layers: Layers
  isMac: () => boolean
  /** 以下四件晚于本节装配（pages 分片）⇒ getter，运行时现取 */
  pageTitle: (block: Block) => string
  activeBlock: () => Block
  canGoBack: () => boolean
  canGoForward: () => boolean
  /** 档位轴现在在哪一档（宽屏/全屏 ⇒ Esc 绑定的 `axisActive` 为真）；晚于本节装配 ⇒ getter */
  axisActive: () => boolean
}

export function setupKeys(deps: KeysDeps) {
  /** 命令 → 键位提示（palette／菜单行尾的那串）：从绑定表现算，没有第二份账 */
  const keyHints = (): Map<string, string> => {
    const m = new Map<string, string>()
    for (const b of BINDINGS) {
      if (b.kind !== 'keymap' || !b.key) continue
      if (!m.has(b.command)) m.set(b.command, keyLabel(b.key, deps.isMac()))
    }
    return m
  }

  /** 编辑器上下文键 ＋ 界面上下文键（同一张 when 用的键空间，：开放、可扩展） */
  const uiCtx = (): CtxKeys => {
    const ed = deps.getEd()
    const ws = deps.getWs()
    const focusId = ed.sel?.aBlock ?? ed.caretBlock()
    const focusBlock = focusId ? findInForest(ws.blocks, focusId) : undefined
    const ctx: CtxKeys = {
      ...ed.ctxKeys(),
      blockSelection: ed.bsel.hasBlockSelection(),
      blockSelectionCount: ed.bsel.blockSelectionCount(),
      paletteOpen: deps.layers.open,
      drawerOpen: deps.layers.drawerOpen(),
      popoverOpen: deps.layers.popoverOpen(),
      // ⚠️ 「页数」只数 `page` 列表（journal 也是一块，但它不是页 —— ）
      pageCount: flatten({ roots: ws.blocks }).filter((b) => hasList(b, 'page')).length,
      pageTitleEmpty: deps.pageTitle(deps.activeBlock()).trim() === '',
      // 块菜单里的露面开关（只看**当前聚焦块**；顺序无语义，只有「在不在」）
      blockHasPageRole: hasList(focusBlock, 'page'),
      blockHasTagRole: hasList(focusBlock, 'tag'),
      // 日记：`journalView` 是**真上下文键**（不是 if），`journalDate` 供前后翻日用
      journalView: isJournal(deps.activeBlock()),
      journalDate: isJournal(deps.activeBlock()) ? (prop<string>(deps.activeBlock(), '_date') ?? '') : '',
      // 导航历史是否可走：键位表的 `when` 与命令面板的可用态都读这两个键
      canGoBack: deps.canGoBack(),
      canGoForward: deps.canGoForward(),
      // 档位轴在宽屏/全屏上（Esc 退一档绑定的 when；常规档为假 ⇒ Esc 归关浮层那条）
      axisActive: deps.axisActive(),
      isMac: deps.isMac(),
    }
    return ctx
  }

  return { keyHints, uiCtx }
}

export interface DispatchDeps {
  uiCtx: () => CtxKeys
  isMac: () => boolean
  getEd: () => BlockEditor
  getRegistry: () => Registry
  layers: Layers
  scheduleBadge: () => void
  editorEl: HTMLElement
}

/** 按键派发的接线。**这里只有接线，没有逻辑**（逻辑在 `core/infra/dispatch.ts`） */
export function installDispatch(deps: DispatchDeps): DispatchEnv {
  const dispatchEnv: DispatchEnv = {
    ctx: deps.uiCtx,
    isMac: deps.isMac,
    invoke: (name, args, ctx) => deps.getRegistry().invoke(name, args, 'keymap', ctx).handled,
    // 覆盖层默认拦命令键；焦点在浮层里的真编辑器时放行（↵/Tab/撤销归编辑器）
    layerOpen: () => deps.layers.anyOpen() && !deps.layers.allowsEditorKeys(),
    trace: (tr: KeyTrace) => {
      const ed = deps.getEd()
      if (!ed.probe.traced) return
      ed.probe.keyTrace.push(tr)
      if (ed.probe.keyTrace.length > 40) ed.probe.keyTrace.shift()
      deps.scheduleBadge()
    },
  }

  installKeydown(dispatchEnv, { editorEl: deps.editorEl })
  return dispatchEnv
}
