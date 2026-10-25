/**
 * 诊断装配：DOM 统计、调试菜单与给截图脚本/检查台的口子（`window.__qua`）。
 *
 * 测试面（`DEV_SURFACE`）才挂 `__qua`：诊断口能直接调 `invoke`（含换库、清存储），
 * 产品构建里这个入口根本不存在。
 */
import {
  allPropDefs,
  allTags,
  childTags,
  danglingParentIds,
  declaredFieldIds,
  fieldRows,
  findInForest,
  flatten,
  hasList,
  identityTags,
  isJournal,
  journalDate,
  listsOf,
  aliasesOf,
  membersOf,
  parentTags,
  prop,
  propKindOf,
  resolveRef,
  tagIdsOf,
  tagMemberIds,
  todoOf,
  type Block,
  type CtxKeys,
} from '../../core/index.ts'
import { t } from '../../core/msg.ts'
import { plainText, type MarkType, type RunWithId } from '../../core/runs.ts'
import { DISPLAY_PROP } from '../../core/index.ts'
import type { App, FixtureName, MenuRequest, PanelKind, Registry } from '../../core/commands/index.ts'
import type { LoadedWorkspace, Prefs, ThemeMode, Workspace, WorkspaceStore } from '../../core/workspace.ts'
import { createBadge } from '../../ui/badge.ts'
import type { Layers, Row } from '../../ui/layers.ts'
import type { Chrome } from '../../ui/chrome.ts'
import type { BlockEditor } from '../../view/editor.ts'

export type DiagnosticsDeps = {
  /** 测试面开关：构建时由 env 决定（dev server 恒开，产物要显式带 flag） */
  DEV_SURFACE: boolean
  store: WorkspaceStore
  boot: LoadedWorkspace
  readOnly: boolean
  bootNotice: string | null
  prefs: () => Prefs
  resolvedTheme: () => 'light' | 'dark'
  applyChrome: () => void
  chrome: Chrome
  badge: ReturnType<typeof createBadge>
  scheduleDeviceSave: () => void
  scheduleBadge: () => void
  getLastOps: () => import('../../core/kb/types.ts').Op[]
  registry: Registry
  app: App
  layers: Layers
  editorEl: HTMLElement
  shortId: (id: string) => string
  activeBlock: () => Block
  pageTitle: (p: Block) => string
  nav: { back: { id: string; feed: boolean }[]; forward: { id: string; feed: boolean }[]; lock: boolean }
  uiCtx: () => CtxKeys
  showMenu: (req: MenuRequest) => void
  openDrawerFor: (kind: PanelKind) => void
  firstEditableRoot: (first: Block | undefined) => Block | null
  stateMenuBtn: HTMLElement
  /** `ed` 随焦点切换；`ws` 换库整体替换——一律现取 */
  getWs: () => Workspace
  getMainEd: () => BlockEditor
  getEd: () => BlockEditor
  setEd: (ed: BlockEditor) => void
  setQuiet: (v: boolean) => void
}


/** 诊断面的两个派生枚举：格式段（投影坐标）与原子 run（plain 坐标；**整片森林**，与旧库级数组同口径） */
function markSegments(ed: BlockEditor): { type: MarkType; blockId: string; start: number; end: number }[] {
  const out: { type: MarkType; blockId: string; start: number; end: number }[] = []
  for (const b of flatten({ roots: ed.store.blocks })) {
    let proj = 0
    for (const r of b.content) {
      if (r.t !== 'text') continue
      for (const m of r.marks ?? []) out.push({ type: m, blockId: b.id, start: proj, end: proj + r.v.length })
      proj += r.v.length
    }
  }
  return out
}

function atomicRuns(ed: BlockEditor): { blockId: string; run: RunWithId; start: number; end: number }[] {
  const out: { blockId: string; run: RunWithId; start: number; end: number }[] = []
  for (const b of flatten({ roots: ed.store.blocks })) {
    let off = 0
    for (const r of b.content) {
      if (r.t !== 'text') out.push({ blockId: b.id, run: r, start: off, end: off + 1 })
      off += r.t === 'text' ? r.v.length : 1
    }
  }
  return out
}

export function setupDiagnostics(deps: DiagnosticsDeps) {
  const {
    DEV_SURFACE,
    store,
    boot,
    readOnly,
    bootNotice,
    prefs,
    resolvedTheme,
    applyChrome,
    chrome,
    badge,
    scheduleDeviceSave,
    scheduleBadge,
    getLastOps,
    registry,
    app,
    layers,
    editorEl,
    shortId,
    activeBlock,
    pageTitle,
    nav,
    uiCtx,
    showMenu,
    openDrawerFor,
    firstEditableRoot,
    stateMenuBtn,
  } = deps
  const mainEd = deps.getMainEd()

  /** DOM 统计（角标与诊断面板的证据源） */
  function domStats(): { blocks: number; domBlocks: number; domNodes: number } {
    return {
      blocks: flatten(mainEd.doc).length,
      domBlocks: editorEl.querySelectorAll('.blk').length,
      domNodes: editorEl.querySelectorAll('*').length,
    }
  }

  /* ------------------------------------------------------------ 菜单的菜单 */

  /**
   * 调试菜单：**正式软件不暴露的开关都在这里**（2026-10-20）。
   *
   * 原先甲乙丙／明暗是顶栏常驻按钮；正式软件不需要它们常驻，挪进调试菜单。
   * ⇒ 挪进这里。判据：**它是诊断面，不是产品面** —— 与右下角的角标同一性质
   * （`ui/badge.ts` 的注释已经写明「将来应当整体降级成一个可关的诊断插件」）。
   *
   * ⚠️ 入口按钮原先在 `index.html` 里带 `hidden` 且**没有任何代码取消它** ⇒ 是个死入口。
   *    现在让它默认可见，否则这些开关搬进来也点不到。
   * ⚠️ 命令仍然经 `registry.invoke`（不是直改 `prefs()`）：主题是真命令，
   * 走命令面才能撤销/审计/被机器接口调到（命令是唯一写入口，UI 只是它的一个调用者）。
   * ⚠️ **皮肤三行已删**：内建只有一种样式，`core.view/set-skin` 整条命令撤掉。
   */
  stateMenuBtn.addEventListener('click', () => {
    const th = prefs().theme
    // 当前档位用图标位的 `check`（不用 hint：hint 会被推到行最右，离标签太远，读不出"这是勾选"）
    const pick = (on: boolean, icon: string): string => (on ? 'lucide:check' : icon)
    // ⚠️ 这两类的 hint 一律给**空串**：渲染器的兜底是「没有 hint ⇒ 显示命令名」，
    //    调试菜单里列 `core.view/set-theme` 只会挡视线（那是诊断信息，不是给用户看的）。
    const rows: Row[] = [
      { id: 'theme-system', label: t('ui.theme.mode.system'), hint: '', icon: pick(th === 'system', 'lucide:monitor'), group: 'dbg/1-theme', command: 'core.view/set-theme', args: { mode: 'system' } },
      { id: 'theme-light', label: t('ui.theme.mode.light'), hint: '', icon: pick(th === 'light', 'lucide:sun'), group: 'dbg/1-theme', command: 'core.view/set-theme', args: { mode: 'light' } },
      { id: 'theme-dark', label: t('ui.theme.mode.dark'), hint: '', icon: pick(th === 'dark', 'lucide:moon'), group: 'dbg/1-theme', command: 'core.view/set-theme', args: { mode: 'dark' } },
    ]
    /**
     * 演示状态那几行**只在测试面存在**：它们换的是整份库（并立刻落盘）。
     * 产品构建里那一行根本没注册，摆出来点下去只会得到「命令未注册」—— 不如不摆。
     */
    if (DEV_SURFACE) {
      rows.push(
        // 演示状态
        { id: 'seed', label: t('ui.stateMenu.seed'), hint: t('ui.stateMenu.seedHint'), icon: 'lucide:book-open', group: 'dbg/2-state', command: 'dev.fixture/load', args: { state: 'seed' } },
        // 冷启动：看「第一次打开 app」那一屏到底长什么样（不用清 localStorage 再刷新）
        { id: 'boot', label: t('ui.stateMenu.boot'), hint: t('ui.stateMenu.bootHint'), icon: 'lucide:sunrise', group: 'dbg/2-state', command: 'dev.fixture/load', args: { state: 'boot' } },
        { id: 'degraded', label: t('ui.state.degraded'), hint: t('ui.stateMenu.degradedHint'), icon: 'lucide:triangle-alert', group: 'dbg/2-state', command: 'dev.fixture/load', args: { state: 'degraded' } },
        { id: 'sparse', label: t('ui.state.sparse'), hint: t('ui.stateMenu.sparseHint'), icon: 'lucide:square-dashed', group: 'dbg/2-state', command: 'dev.fixture/load', args: { state: 'sparse' } },
        { id: 'empty', label: t('ui.state.empty'), hint: t('ui.stateMenu.emptyHint'), icon: 'lucide:square', group: 'dbg/2-state', command: 'dev.fixture/load', args: { state: 'empty' } },
      )
    }
    layers.openMenu({
      rows,
      anchor: stateMenuBtn.getBoundingClientRect(),
      title: t('menu.title.debugMenu'),
      searchable: false,
      focusSearch: false,
      onPick: (row) => {
        if (row.command) registry.invoke(row.command, (row.args as Record<string, unknown>) ?? {}, 'menu', uiCtx())
      },
    })
  })

  /* ------------------------------------------------------------ 给截图脚本/检查台的口子 */

  const api = {
    snapshot() {
      const st = domStats()
      const ws = deps.getWs()
      return {
        ...st,
        mounted: mainEd.mounted.size,
        // 行内内容住块上：诊断面给「格式段数/原子枚数」两个派生计数（口径同 marks()/atoms()）
        marks: markSegments(mainEd).length,
        atoms: atomicRuns(mainEd).length,
        theme: prefs().theme,
        resolvedTheme: resolvedTheme(),
        themeMode: prefs().theme,
        composing: mainEd.probe.isComposing,
        virtualize: mainEd.virtualize,
        activePage: pageTitle(activeBlock()),
        // 导航历史断言要认「当前对象」本身（页名可能重复/为空）
        activeId: ws.activeId,
        // ⚠️ 「页数」＝ `page` 角色的块数（journal 不算页）；顶层块总数另给 `topBlocks`
        pageCount: flatten({ roots: ws.blocks }).filter((b) => hasList(b, 'page')).length,
        topBlocks: ws.blocks.length,
        totalBlocks: flatten({ roots: ws.blocks }).length,
        journalDate: isJournal(activeBlock()) ? journalDate(activeBlock()) : '',
        undoDepth: mainEd.undo.depth(),
        redoDepth: mainEd.undo.redoDepth(),
        lastCommand: registry.last,
        selection: mainEd.sel,
        blockSelection: mainEd.hasBlockSelection(),
        blockSelectionCount: mainEd.blockSelectionCount(),
        hasLocalStorage: boot.status !== 'storage-error',
        readOnly,
        bootNotice,
        storageKind: store.kind,
        /**
         * 三槽的设备状态（**诊断面**）：钉住清单与宽度都在 prefs 里，
         * 断言要能区分「落盘了没有」与「页面里渲染了没有」。
         */
        dock: {
          left: { open: prefs().dock.left.open, width: prefs().dock.left.width, pins: [...prefs().dock.left.pins] },
          right: { open: prefs().dock.right.open, width: prefs().dock.right.width, pins: [...prefs().dock.right.pins] },
        },
        // 导航历史（不是 undo 栈）：给断言看「能退到哪 / 能进到哪」
        nav: { back: nav.back.map((p) => p.id), forward: nav.forward.map((p) => p.id), canGoBack: nav.back.length > 0, canGoForward: nav.forward.length > 0 },
      }
    },
    text() {
      return flatten(mainEd.doc).map((b) => plainText(b.content))
    },
    /**
     * **整片森林**（区别于 `blocks()`：那个只给当前视图装载的子树）。
     * 标签块挂在森林根上、不在当前页里 ⇒ 查「标签存不存在」必须用这个。
     */
    allBlocks() {
      return deps.getWs().blocks.map((b) => ({
        id: b.id,
        text: plainText(b.content),
        roles: identityTags(b),
        // 地址与露面是两套语义，诊断面要能分别读（`roles` 只给外观认的身份种类）
        aliases: aliasesOf(b),
        lists: listsOf(b),
        display: prop<string>(b, DISPLAY_PROP) ?? null,
      }))
    },
    /** 字段定义（诊断面）：id ＝ propId、正文 ＝ label、谁声明了它 */
    propDefs() {
      const ws = deps.getWs()
      return allPropDefs(ws.blocks).map((d) => ({
        id: d.id,
        label: plainText(d.content),
        kind: propKindOf(d),
        declaredBy: allTags(ws.blocks).filter((t) => declaredFieldIds(t).includes(d.id)).map((t) => t.id),
      }))
    },
    /** 一个块的属性区（**派生**：声明 ∪ 自有；同一 propId 只一行） */
    fields(blockId: string) {
      const ws = deps.getWs()
      const b = findInForest(ws.blocks, blockId)
      if (!b) return []
      return fieldRows(b, ws.blocks).map((r) => ({
        propId: r.propId,
        label: r.label,
        kind: r.kind,
        value: r.value ?? null,
        filled: r.filled,
        sources: r.sources.map((s) => s.id),
      }))
    },
    /** 标签的直接父/子/失效父（诊断面；同一条边两个读法） */
    tagParents(tagId: string) {
      const b = findInForest(deps.getWs().blocks, tagId)
      return b ? parentTags(b, deps.getWs().blocks).map((x) => x.id) : []
    },
    tagChildren(tagId: string) {
      const b = findInForest(deps.getWs().blocks, tagId)
      return b ? childTags(b, deps.getWs().blocks).map((x) => x.id) : []
    },
    tagDanglingParents(tagId: string) {
      const b = findInForest(deps.getWs().blocks, tagId)
      return b ? danglingParentIds(b, deps.getWs().blocks) : []
    },
    /** 成员（**含算作**：自己的成员 ∪ 后代标签的成员） */
    tagMembersDeep(tagId: string) {
      return [...membersOf(tagId, deps.getWs().blocks)]
    },
    /** 打了某个标签的块 id（标签的成员列表＝标签块的入向边） */
    tagMembers(tagId: string) {
      return [...tagMemberIds(tagId, deps.getWs().blocks)]
    },
    /** 删掉一枚行内原子（显式动作；那条边跟着没了） */
    removeAtom(runId: string) {
      mainEd.removeRun(runId)
    },
    blocks() {
      return flatten(mainEd.doc).map((b) => ({
        id: b.id,
        text: plainText(b.content),
        todo: todoOf(b) ?? null,
        // 诊断面的字段名保持 `collapsed`（冒烟按它断言）；值现在来自折叠表
        collapsed: mainEd.doc.folded?.[b.id] === true,
        children: b.children.length,
        // 角色进诊断面（journal 行是只读日期，测试要能把它挑出来）
        roles: identityTags(b),
        // 标签归属也进诊断面：它是块级字段，DOM 里只剩渲染出来的 chip
        tags: tagIdsOf(b),
      }))
    },
    /**
     * 格式段（**派生视图**）：格式住在 run 上，这里把它投影回「块内 plain 区间」的形状，
     * 断言不需要认识 run。一段 ＝ 一个带该格式的 run 在块内的覆盖区间。
     */
    marks() {
      return markSegments(mainEd)
    },
    /**
     * 行内原子（**派生视图**）：从各块内容里枚举原子 run，标出它住的块与 plain 区间。
     * ⚠️ `label` 与 `state` 给的是**解析后的**结果（不是落盘的快照）：
     *   探针要能回答「现在显示的是什么」，否则断言就只是在复读过期的名字快照。
     */
    atoms() {
      return atomicRuns(mainEd).map((a) => {
        const v = a.run.t === 'ref' ? resolveRef((id) => mainEd.store.find(id), a.run) : { label: a.run.t === 'image' ? (a.run.asset.name ?? '') : a.run.v, state: 'resolved' as const }
        return {
          id: a.run.id,
          kind: a.run.t === 'ref' ? (a.run.flavor === '#' ? 'tag' : 'page') : a.run.t,
          label: v.label,
          rawLabel: a.run.t === 'ref' ? a.run.label ?? '' : '',
          blockId: a.blockId,
          start: a.start,
          end: a.end,
          state: v.state,
          target: a.run.t === 'ref' && a.run.to ? { kind: 'page', id: a.run.to } : null,
        }
      })
    },
    shortId: (id: string) => shortId(id),
    ctxKeys: () => uiCtx(),
    pages: () => app.listPages(),
    invoke: (name: string, args: Record<string, unknown> = {}, via = 'api') => registry.invoke(name, args, via, uiCtx()),
    commandLog: () => registry.log.map((l) => l.name),
    quiet: (v: boolean) => {
      deps.setQuiet(v)
    },
    setTheme: (mode: ThemeMode) => {
      prefs().theme = mode
      applyChrome()
      chrome.renderDebugState()
      scheduleDeviceSave()
      scheduleBadge()
    },
    loadState: (s: FixtureName) => registry.invoke('dev.fixture/load', { state: s }, 'api'),
    focusBlock: (blockId: string, off = 0) => {
      deps.setEd(mainEd)
      editorEl.focus()
      mainEd.placeCaret(blockId, off)
    },
    /**
     * 把焦点给编辑器：有模型选区就还原它，没有就落到第一个可编辑行。
     *
     * ⚠️ **先 focus 再 placeCaret**：`focus()` 在「此前没有焦点」时会把光标重置到容器开头
     *    （Contenteditable 默认行为）——不补一次 placeCaret，光标会停在只读的日期行上，
     *    连带把 ⌘A 的全选范围也缩到那一行。
     * ⚠️ 冷启动**不**走这里：打开 app 时没有任何块处于聚焦态；这是一个显式动作的入口。
     */
    focus: () => {
      deps.setEd(mainEd)
      const keep = mainEd.sel
      editorEl.focus()
      if (keep) {
        mainEd.placeCaret(keep.aBlock, keep.aOff)
        return
      }
      const target = firstEditableRoot(mainEd.doc.roots[0])
      if (target) mainEd.placeCaret(target.id, 0)
    },
    openPalette: () => registry.invoke('core.command-palette/show', {}, 'api'),
    openBlockMenu: (blockId: string) => {
      const el = deps.getEd().blockEl(blockId)
      showMenu({ kind: 'menu', prefix: 'block/', anchor: el?.getBoundingClientRect() ?? null, title: t('menu.title.block'), ctx: uiCtx() })
    },
    openSlash: () => showMenu({ kind: 'slash', anchor: deps.getEd().caretRect(), query: '' }),
    themeMode: () => prefs().theme,
    resolvedTheme: () => resolvedTheme(),
    openPanel: (kind: PanelKind) => openDrawerFor(kind),
    setVirtualize: (on: boolean, radius = 12) => app.setVirtualize(on, radius),
    badgePanel: (open: boolean) => {
      // 角标的开合是**设备状态**（下次冷启动按它恢复），不是库的内容
      prefs().badgeOpen = open
      badge.toggle(open)
      scheduleDeviceSave()
    },
    /**
     * 自检用：清掉落盘的那一份（**只清存储，不动当前内存库**）。
     * 演示状态切换不再调它：`loadState` 换库后会经由 `scheduleSave` 覆盖写，
     * 「先清后写」在异步批次下会多一次无谓的写序（曾是同步全量 save 时代的口径）。
     */
    clearStorage: () => void store.clear(),
    /**
     * 自检用：**最近一次事务**产出的 op（诊断面板不用它，只为「一次动作几条 op」留证据）。
     * 只读副本：调用方改数组不该影响这里记着的那一份。
     */
    lastOps: () => getLastOps(),
    __editor: mainEd,
    __registry: registry,
    __layers: layers,
  }

  // ⚠️ 只在测试面挂上去：诊断口能直接调 `invoke`（含换库、清存储），
  //    接上真库之后留在产品构建里＝把「一键清掉真实数据」放在用户的 F12 里。
  if (DEV_SURFACE) window.__qua = api

  return { domStats, api }
}

type QuaApi = ReturnType<typeof setupDiagnostics>['api']

declare global {
  interface Window {
    /** 只在测试面存在（`DEV_SURFACE`）；产品构建里这个键根本不会被赋值 */
    __qua: QuaApi
  }
}
