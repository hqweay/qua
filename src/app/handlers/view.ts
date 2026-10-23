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
}
