/**
 * chrome 装配：主题档位（含系统外观监听）、chrome 组件、诊断角标。
 *
 * 主题只记账不变色：颜色由 CSS 的 `@media (prefers-color-scheme: dark)` ＋
 * `light-dark()` 决定，JS 这边一行切类都不做。
 */
import { darkQuery, resolveTheme } from '../../core/theme.ts'
import type { CtxKeys } from '../../core/index.ts'
import { flatten } from '../../core/index.ts'
import type { Registry } from '../../core/commands/index.ts'
import type { Prefs, Workspace } from '../../core/workspace.ts'
import { createBadge, type BadgeSnapshot } from '../../ui/badge.ts'
import { createChrome } from '../../ui/chrome.ts'
import { applyDockVisibility, applyDockWidth } from '../../ui/dock.ts'
import type { BlockEditor } from '../../view/editor.ts'

export type ChromeDeps = {
  prefs: () => Prefs
  /** 启动读盘的异常提示（没有异常为 null）；有则挂成常驻告警 */
  bootNotice: string | null
  shortId: (id: string) => string
  uiCtx: () => CtxKeys
  getActiveBlock: () => import('../../core/index.ts').Block
  getPageTitle: (p: import('../../core/index.ts').Block) => string
  $: <T extends HTMLElement>(id: string) => T
  /** 换库会整体替换 `ws`，不能传值 */
  getWs: () => Workspace
  /** 角标启动时编辑器尚未装配；诊断快照只在装配完成后被调 */
  getMainEd: () => BlockEditor
  getRegistry: () => Registry
  /** Shift+点面包屑：在右槽打开这个祖先 */
  openInDock: (blockId: string) => void
  /** DOM 统计（证据源在诊断分片；它晚于本节装配，现取） */
  getDomStats: () => { blocks: number; domBlocks: number; domNodes: number }
}

export function setupChrome(deps: ChromeDeps) {
  const { prefs, shortId, uiCtx } = deps

  /* ------------------------------------------------------------ 主题档位 */

  /** 系统外观：只用来**记账与诊断**，颜色本身由 CSS 决定 —— 不做 JS 切类 */
  const resolvedTheme = (): 'light' | 'dark' => resolveTheme(prefs().theme, darkQuery.matches)
  /** 启动完成前不碰 DOM 诊断（`ed` 还没建好） */
  let booted = false

  // **监听系统外观**的缺口）：只同步诊断与按钮文案 ——颜色由 CSS 的
  // `@media (prefers-color-scheme: dark)` ＋ `light-dark()` 决定，**这里一行切类都不做**。
  darkQuery.addEventListener('change', () => {
    chrome.renderDebugState()
    if (booted) scheduleBadge()
  })

  /* ------------------------------------------------------------ 渲染 */

  /**
   * 把偏好写进 `body[data-*]`：主题档位、三槽开关。
   *
   * ⚠️ 这里**只写属性，不改 DOM 形状**（门禁 5：换肤前后 `data-depth` 序列一致）。
   * ⚠️ `data-theme` 记的是**档位**（system/light/dark），不是解析后的亮暗 —— 颜色由 CSS 取。
   * ⚠️ **不再有 `data-skin`**：内建只有一种样式，观感调 token 即可。
   */
  function applyChrome(): void {
    document.body.dataset.theme = prefs().theme
    document.body.dataset.themeMode = prefs().theme
    applyDockVisibility({ left: prefs().dock.left.open, right: prefs().dock.right.open })
    const appEl = deps.$('app')
    applyDockWidth(appEl, 'left', prefs().dock.left.width, prefs().dock.left.open)
    applyDockWidth(appEl, 'right', prefs().dock.right.width, prefs().dock.right.open)
  }

  /**
   * 读一个 CSS 长度 token（`180px` → 180）。
   *
   * 回退值是**数字**而不是 `'180px'` 字面量（TS 里拼 px 会被门禁拦）；
   * 它只在样式没加载到（测试夹具/首帧）时兜底，正常路径永远读 token。
   */
  function cssLength(name: string, fallback: number): number {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    const n = Number.parseFloat(raw)
    return Number.isFinite(n) ? n : fallback
  }

  /** 槽宽下限：token `--ui-dock-min` */
  const dockMinWidth = (): number => cssLength('--ui-dock-min', 180)

  /** 没拖过时的默认宽（与 CSS 的 `--ui-dock-w-*` 同源） */
  const dockDefaultWidth = (side: 'left' | 'right'): number =>
    cssLength(`--ui-dock-w-${side}`, side === 'left' ? 236 : 320)

  /**
   * 另一侧**当前占的宽度**：关着的槽不占列（与 CSS 的列宽归零一致）。
   * 拖这一侧时要把它扣掉，否则两边都拖宽会把中心槽挤到 0。
   */
  function dockOtherWidth(side: 'left' | 'right'): number {
    const other = side === 'left' ? 'right' : 'left'
    const p = prefs().dock[other]
    if (!p.open) return 0
    return typeof p.width === 'number' ? p.width : dockDefaultWidth(other)
  }

  /** 槽宽上限：中心槽至少留 `--ui-center-min`。 */
  function dockMaxWidth(side: 'left' | 'right'): number {
    const min = dockMinWidth()
    const center = cssLength('--ui-center-min', 480)
    return Math.max(min, window.innerWidth - dockOtherWidth(side) - center)
  }

  // 视口跨过压缩区（839/840）时，inline 宽度要跟着交回 CSS / 重新写回
  window.addEventListener('resize', () => applyChrome())

  /* ------------------------------------------------------------ chrome 组件 */

  /**
   * 中心槽的 chrome（页名 + 空态提示 + 编辑器挂载点）。
   * ⚠️ **组件自持 DOM**：装配入口里不再出现那些元素的 `getElementById`。
   * ⚠️ 皮肤/主题那两个开关**不在这里**：撤出顶栏，挪进调试菜单。
   */
  const chrome = createChrome((blockId, shiftKey) => {
    // 面包屑一格 ＝「聚焦到这个祖先」；Shift+点 ＝ 同一个「打开」，换到右槽
    if (shiftKey) deps.openInDock(blockId)
    else deps.getRegistry().invoke('core.block/focus-block', { blockId }, 'chrome')
  })

  const editorEl = chrome.editorEl

  // 读盘异常 / 首屏保存失败：持久告警常驻，不随 toast 消失
  if (deps.bootNotice) chrome.showNotice(deps.bootNotice)

  /* ------------------------------------------------------------ 角标（诊断面） */

  const badge = createBadge({
    shortId,
    snapshot: (): BadgeSnapshot => {
      const page = deps.getActiveBlock()
      const mainEd = deps.getMainEd()
      const ws = deps.getWs()
      return {
        ...deps.getDomStats(),
        mounted: mainEd.mounted.size,
        virtualize: mainEd.virtualize,
        radius: mainEd.radius,
        theme: prefs().theme,
        composing: mainEd.probe.isComposing,
        compositionSeq: mainEd.probe.compositionSeq,
        selection: mainEd.sel,
        blockSelection: mainEd.hasBlockSelection(),
        blockSelectionCount: mainEd.blockSelectionCount(),
        // 行内内容住块上：角标给两个派生计数（带格式的 run 数／原子 run 数；整片森林口径）
        marks: flatten({ roots: mainEd.store.blocks }).reduce((n, b) => n + b.content.filter((r) => r.t !== 'image' && r.marks?.length).length, 0),
        atoms: flatten({ roots: mainEd.store.blocks }).reduce((n, b) => n + b.content.filter((r) => r.t !== 'text').length, 0),
        undoDepth: mainEd.undo.depth(),
        redoDepth: mainEd.undo.redoDepth(),
        lastCommand: deps.getRegistry().last,
        pageTitle: deps.getPageTitle(page),
        pageCount: ws.blocks.length,
        storageKB: JSON.stringify(ws).length / 1024,
        savedAt: ws.savedAt,
        ctx: uiCtx(),
        keyTrace: mainEd.probe.keyTrace,
      }
    },
  })

  const scheduleBadge = badge.schedule

  return {
    chrome,
    editorEl,
    applyChrome,
    resolvedTheme,
    dockMinWidth,
    dockMaxWidth,
    badge,
    scheduleBadge,
    /** 首屏装配完成：之后系统外观变化才联动角标 */
    markBooted: () => {
      booted = true
    },
  }
}

