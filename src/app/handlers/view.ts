/**
 * 视图 / 浮层 / 诊断 handler：皮肤三档、槽开关、虚拟化、菜单与面板。
 *
 * 这里只表达意图——真正换 token、开浮层、画面板都由门面交装配层落地。
 */
import { t } from '../../core/msg.ts'
import type { Handler } from '../../core/ports.ts'
import { curBlock, S } from './shared.ts'

export const VIEW_HANDLERS: Record<string, Handler> = {
  /* ---- zoom ---- */
  'core.block/focus-block': (a, app) => {
    // 缺省目标是**光标所在块**（块菜单就是这么调的：它不传 args）
    const id = typeof a.blockId === 'string' && a.blockId !== '' ? a.blockId : app.ed.caretBlock()
    if (!id) return false
    // `feed` 只来自历史回放：普通块标/面包屑/引用点击不带它，一律单块聚焦
    app.zoomTo(id, a.feed === true)
    return true
  },
  'core.block/zoom-out': (_a, app) => {
    app.zoomOut()
    return true
  },
  /**
   * 移动到…：先选块（光标 / 选区），再弹目标选择器。
   *
   * 块选区有多个块时**只搬第一个**（v1）：多块跨父搬运要处理「同一棵子树里的多块」
   * 与「搬完顺序」两件事，那是拖拽版一起做的事（`待办-拖拽一条缝.md`）。
   * 现在不静默搬一半——明确只搬光标那一块。
   */
  'core.block/move-to': (a, app) => {
    const id = typeof a.blockId === 'string' && a.blockId !== '' ? a.blockId : (app.ed.caretBlock() ?? '')
    if (!id) return false
    /**
     * 带 `targetId` ＝ **直接点名目标**（脚本、将来的拖拽版、以及验收都走这条）；
     * 不带 ＝ 弹选择器让用户挑。两条最终落到同一个 `moveBlockTo`，
     * 所以「怎么选目标」不影响「怎么搬」。
     */
    const target = typeof a.targetId === 'string' ? a.targetId : ''
    if (target !== '') {
      app.moveBlockTo(id, target)
      return true
    }
    app.showMovePicker(id)
    return true
  },
  /**
   * 看属性：与 zoom 同一条换落点路径，外加「确保右槽开着」。
   *
   * ⚠️ 它是**视图命令**，所以可以动槽开关。导航动作（zoom / 打开页 / 点链接）
   *    一律不碰它 —— 那条分界由 T1b 钉住（zoom 之后 `dock.right.open` 一字不变）。
   */
  'core.block/inspect': (a, app) => {
    const id = typeof a.blockId === 'string' && a.blockId !== '' ? a.blockId : app.ed.caretBlock()
    if (!id) return false
    app.inspectBlock(id)
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
  /**
   * 在侧槽打开一个块：**不换中心、不入历史**。
   * 缺省目标是光标所在块（块菜单不传 args）；`side` 缺省右槽（Shift+点的落点）。
   */
  'core.dock/open-block': (a, app) => {
    const id = typeof a.blockId === 'string' && a.blockId !== '' ? a.blockId : curBlock(app)
    if (!id) return false
    app.openInDock(id, a.side === 'left' ? 'left' : 'right')
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
}
