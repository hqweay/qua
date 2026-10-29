/**
 * 页装配：「当前对象」一族、导航历史、装载边界与页/日记共用的依赖面。
 *
 * `ws`／`ed`／`mainEd` 都会被整体替换或切换，一律经 getter 现取；
 * 面板分片晚于本节装配，重画入口经 `getPanels` 延迟取用。
 */
import {
  displayNameOf,
  findInForest,
  findPath,
  isJournal,
  journalId,
  mkBlock,
  prop,
  type Block,
} from '../../core/index.ts'
import { t } from '../../core/msg.ts'
import type { Registry } from '../../core/commands/index.ts'
import type { MemoryKb } from '../../core/kb/memory.ts'
import type { Tx, Change, Op } from '../../core/kb/types.ts'
import type { BlockStore } from '../../core/store.ts'
import type { Prefs, Workspace } from '../../core/workspace.ts'
import type { Layers } from '../../ui/layers.ts'
import type { Chrome } from '../../ui/chrome.ts'
import { isReadonlyBlock } from '../../view/block-dom.ts'
import type { BlockEditor } from '../../view/editor.ts'
import type { PageDeps } from '../commands-impl.ts'

export type PagesDeps = {
  kb: MemoryKb
  blocks: BlockStore
  txRun: <R>(fn: (tx: Tx) => R, source?: unknown) => { ops: Op[]; changes: Change[]; result: R }
  run: <R>(fn: (tx: Tx) => R, source?: unknown) => R
  syncSections: () => void
  saveNow: () => void
  scheduleSave: () => void
  scheduleBadge: () => void
  repaintBlock: (blockId: string) => void
  /**
   * 改块自己的属性（**必然连带重画这一行**）。见实现处：那一步不是可选项。
   */
  writeProps: (blockId: string, mutate: () => void) => void
  renderDocks: () => void
  editorEl: HTMLElement
  layers: Layers
  uiCtx: () => import('../../core/index.ts').CtxKeys
  /** app 门面晚于本节装配；提示经 getter 现取 */
  getApp: () => { toast: (text: string, kind?: 'info' | 'warn' | 'ok') => void }
  /** 面板分片晚于本节装配：装载边界的重画经 getter 现取 */
  getPanels: () => {
    renderMounts: () => void
    renderProperties: () => void
  }
  getWs: () => Workspace
  getEd: () => BlockEditor
  setEd: (ed: BlockEditor) => void
  getMainEd: () => BlockEditor
  getRegistry: () => Registry
  getChrome: () => Chrome
  /** 槽开关是设备偏好：`openDock` 要先看它，已开就不再触发一次变更 */
  prefs: () => Prefs
  /** 把某张派生卡放回槽（关掉之后「看属性」还能把它放回来）；由装配层接到 `addDerived` */
  ensureDockCard: (side: 'left' | 'right', id: 'inspect' | 'belongs' | 'backrefs' | 'trash' | 'calendar') => void
}

export function setupPages(deps: PagesDeps) {
  const {
    kb,
    blocks,
    txRun,
    run,
    syncSections,
    saveNow,
    scheduleSave,
    scheduleBadge,
    repaintBlock,
    writeProps,
    renderDocks,
    editorEl,
    layers,
    uiCtx,
  } = deps

  /**
   * **导航历史**（中心槽的「当前对象」先后）。与 undo/redo 是两套：
   *   · undo 管**数据**（块树/锚点/原子的快照）；
   *   · 这里管**走到哪**（打开页、点链接、zoom、面包屑都算一次导航）。
   *
   * 左右槽显式钉住、不跟随导航，所以历史只记中心槽的 `activeId`。
   * `lock` 用来区分「用户导航」与「历史本身在回放」——后者不能再入栈。
   *
   * ⚠️ **同一个 id 可以有两种形态**：今天的 journal 既可能以「日记流入口」打开，
   *    也可能以「只看这一天」聚焦。历史只存 id 会把两者压成一种（回退后 feed 消失），
   *    所以每一项都带 `feed` 这个视图形态。
   */
  type NavPoint = { id: string; feed: boolean }
  const nav = { back: [] as NavPoint[], forward: [] as NavPoint[], lock: false }

  /** 当前中心视图是不是「日记流入口」（多段且全是 journal） */
  function isFeedView(): boolean {
    const mainEd = deps.getMainEd()
    if (!mainEd) return false
    const roots = mainEd.doc.roots
    return roots.length > 1 && roots.every((b) => isJournal(b))
  }

  /**
   * 「当前对象」＝ 中心槽持有的那个块（只有中心槽有这个概念）。
   *
   * ⚠️ 它**不只是页**：`journal` 也是中心槽的默认内容；zoom 之后还能是
   *   **任意深度的块**⇒ 必须在**整片森林**里找，不能只看顶层。
   */
  const activeBlock = (): Block => kb.get(deps.getWs().activeId) ?? kb.roots()[0]!

  /**
   * zoom 的面包屑：**派生**，不入库、不物化（不引入焦点栈）。
   * 路径含「当前对象」自己 ⇒ 去掉末尾就是祖先链。
   */
  const activeTrail = (): Block[] => {
    const path = findPath(deps.getWs().blocks, deps.getWs().activeId)
    return path ? path.slice(0, -1) : []
  }
  /** 页名 ＝ 主别名叶子（没有名字才回落到描述）；空则交给调用方做兜底文案 */
  const pageTitle = (p: Block): string => displayNameOf(p)
  /** 页图标 ＝ 系统属性 `_icon`；空值用 `file`，与 `view/icons.ts` 的角色默认一致 */
  const pageIcon = (p: Block): string => prop<string>(p, '_icon') ?? 'lucide:file'

  /**
   * **第一个可编辑的行**：journal 的首行是**只读日期**（`contenteditable=false`），
   * 不能接光标 ⇒ 取它的第一个子块。页 / 被 zoom 的块没这个问题：那一行就是页名／正文本身。
   *
   * ⚠️ 为什么抽成一处：冷启动落点、回今日、翻日、zoom 用的是**同一条**规则；
   *    写两份就会立刻分叉（实际发生过：末尾的「首屏落光标」那段还在指首行，
   *    把 `focusFirstBlock` 设好的光标又覆盖回只读日期行）。
   */
  function firstEditableRoot(first: Block | undefined): Block | null {
    if (!first) return null
    return isReadonlyBlock(first) ? (first.children[0] ?? null) : first
  }

  /**
   * **装载边界的可编辑保证**：被装进中心编辑器的 journal 天至少要有一个子块——
   * 日期行只读，没有子块就没有可落光标的地方（「打得开却打不了字」）。
   *
   * 这是**写库**，不是渲染兜底：渲染兜底会让「看到的块」与「库里的块」分叉，
   * 补的块经事务真的进库（一条 `insert`，op 里报它自己的落点）。
   * 所有装载入口共用这一个落点（`loadPage`／日记流增量／演示换库）；
   * 「新建」一类造数据的路径不走这里——它们在创建时就该把子块带上（同一笔插入）。
   * 冷启动在仓库构建之前、走不了事务，仍由模型层归一（`ensureFirstBlock`）。
   */
  function materializeEditableRoots(roots: readonly Block[]): void {
    for (const r of roots) {
      const mainEd = deps.getMainEd()
      if (isJournal(r) && r.children.length === 0) run((tx) => tx.insert(mkBlock(''), r.id, 0), mainEd)
    }
  }

  /**
   * 页与日记**共用同一份依赖**（`PageDeps`）：两者都是「一块 ＋ 一棵子树」，
   * 只是角色不同 ——各给一套依赖就会立刻出现两条分叉的实现路径（要消灭的正是这个）。
   *
   * ⚠️ 依赖一律是**读函数**而不是值：库会被 `loadState` 整体替换，传值会拿到过期快照。
   */
  const pageDeps: PageDeps = {
    kb,
    // 命令层开事务：装配层补撤销快照（零 op 的事务不记——没写东西就没有可撤销的），
    // 并重画这批改动碰到的行（标签 chip／别名头住在一行自己的 DOM 里，等整页重渲染就晚了）
    run: (fn) => {
      const before = blocks.snap(deps.getEd().sel)
      const r = txRun(fn, deps.getMainEd())
      if (r.ops.length > 0) blocks.record(before, 'other', Date.now())
      for (const id of new Set(r.changes.filter((c) => c.kind === 'blocks').map((c) => c.id))) repaintBlock(id)
      scheduleSave()
      scheduleBadge()
      return r
    },
    removeBlock: (id) => {
      // 删页：整棵子树原位标记（软删）。走 `run` 是为了产出 op —— 命令层只声明「删这块」，
      // 打标记由事务那一份实现负责（一条 op，只落操作根）。
      run((tx) => tx.remove(id), deps.getMainEd())
    },
    insertBlock: (block, parentId, index) => {
      // 与 `removeBlock` 对称的结构写入口：插一棵子树（含自带的首子块），
      // op 由事务产出——每个后代报它们自己的 parent/index，换库后行行有落点。
      run((tx) => tx.insert(block, parentId, index), deps.getMainEd())
    },
    moveBlock: (blockId, parentId, index) => {
      /**
       * 一次移动 = **一条** `block.upsert{parent,index}`（`tx.move` 就是这么发的）。
       * 拆成「先删后插」会让 ⌘Z 只回一半，也会让指向这块的引用在中间那一刻指向空。
       *
       * ⚠️ 走 `pageDeps.run`（**带撤销快照**），不是注入的 `deps.run`：
       *    后者只跑事务、不记快照 ⇒ 移动能成功但 ⌘Z 撤不回来。
       *    「搬了回不去」比「搬错了」更糟，而它不会报错，只在用户按 ⌘Z 时显形。
       */
      pageDeps.run((tx) => tx.move(blockId, parentId, index))
    },
    // 打标签的落点：**当前光标那一块**（正文 vs 反链 footer 会切换 ⇒ 每次现取活动编辑器）
    caretBlockId: () => deps.getEd().caretBlock() ?? deps.getEd().rows()[0]?.block.id ?? null,
    /**
     * 写块属性走装配层这一条路：撤销快照、索引失效、通知其他视图、重画这一行、落盘
     * 都在 `writeProps` 那一处。这里只做转发。
     *
     * ⚠️ **不要再包一层补重画**：重画是「改这一块的属性」的固有部分（那一行的
     *    别名头、身份图标、gutter 标记都由 props 派生），不是某个调用方记得要加的一步。
     *    上面那样包过一次，属性命令那条路径就漏了，表现为「加了属性、模型有了、屏幕没变」。
     */
    write: writeProps,
    activeId: () => deps.getWs().activeId,
    setActiveId: (id, view) => {
      /**
       * **记录导航历史**：只有「真的换了落点（或视图形态）」且旧落点还在森林里才记。
       * 历史回放期间 `nav.lock` 为真 ⇒ 不再入栈，否则前进/后退会自己套自己。
       */
      const feed = view?.feed === true
      const sameView = feed === isFeedView()
      const ws = deps.getWs()
      if (!nav.lock && (id !== ws.activeId || !sameView) && findInForest(ws.blocks, ws.activeId)) {
        nav.back.push({ id: ws.activeId, feed: isFeedView() })
        nav.forward = []
      }
      ws.activeId = id
    },
    rootIds: () => deps.getMainEd().doc.roots.map((b) => b.id),
    // 日记流装载的视图配置：偏好只读（写入走 core.journal/feed-layout），编辑器由装配层持有
    feedLayoutPref: () => deps.prefs().feedLayout,
    applyLayout: (mode) => {
      deps.getMainEd().setLayout(mode)
    },
    setShells: (cols) => {
      deps.getMainEd().setShells(cols)
    },
    focusDay: (date) => {
      const mainEd = deps.getMainEd()
      const target = firstEditableRoot(mainEd.doc.roots.find((b) => b.id === journalId(date)))
      editorEl.focus()
      if (target) mainEd.placeCaret(target.id, 0)
    },
    loadPage: (roots) => {
      const mainEd = deps.getMainEd()
      // 装载边界：空 journal 天在这里补首子块（经事务、一条 op）——
      // 所有「打开」命令共用的唯一归一落点，`rootsFor`／命令层只选择、不写库
      materializeEditableRoots(roots)
      const { renderMounts, renderProperties } = deps.getPanels()
      deps.setEd(mainEd)
      // 正文视图的折叠态是**设备**那份；取当前视图持有的那一份（`device.folded` 只在落盘时同步，可能落后一步）
      mainEd.loadPage({ roots, folded: mainEd.doc.folded })
      // 装载之后才建挂载区：它按**段根**建实例，而段是 `loadPage` 造出来的
      renderMounts()
      renderProperties()
    },
    flush: () => {
      syncSections()
      saveNow()
    },
    saveNow,
    scheduleSave,
    refreshList: () => renderDocks(),
    refreshTitle: () => deps.getChrome().renderTitle(activeBlock(), activeTrail()),
    focusFirstBlock: () => {
      const mainEd = deps.getMainEd()
      /**
       * 首行是**当前对象自己**（页／日记／被聚焦块都是正文第一行）。
       *
       * ⚠️ 但 **journal 的首行是只读日期**⇒ 光标落到它的**第一个子块**。
       *    否则「回今日」后光标停在一个不可编辑的行上，用户以为打不了字。
       *    page / 被 zoom 的块没这个问题：那一行就是可编辑的页名／正文本身。
       * ⚠️ **先 focus 再 placeCaret**：反过来的话 `focus()` 会把光标重置到容器开头
       *    （Contenteditable 的默认行为），实测表现为「光标停在只读的日期行上」。
       */
      const first = mainEd.doc.roots[0]
      if (!first) return
      const target = firstEditableRoot(first)
      editorEl.focus()
      if (target) mainEd.placeCaret(target.id, 0)
    },
    focusBlock: (blockId, offset = 0) => {
      const mainEd = deps.getMainEd()
      deps.setEd(mainEd)
      // 换块聚焦先结掉上一块的编辑期（与 `app.focusBlock` 同一条判据）
      const prev = mainEd.sel?.aBlock ?? mainEd.caretBlock()
      if (prev && prev !== blockId) mainEd.commitEdit(prev)
      editorEl.focus()
      mainEd.placeCaret(blockId, offset)
    },
    /**
     * 确保侧槽开着：已经开着就什么都不做（**不写 prefs**，也就不会把
     * 「没变化」记成一次设备变更）。
     *
     * 走命令而不是直接改 `prefs`：开槽要连带 `applyChrome`（列宽/边框/可见性）
     * 与设备落盘，那是 `core.dock/toggle-*` 那一份的职责，这里再写一遍就会分叉。
     */
    openDock: (side) => {
      if (deps.prefs().dock[side].open) return
      void deps.getRegistry().invoke(side === 'left' ? 'core.dock/toggle-left' : 'core.dock/toggle-right', {}, 'view')
      deps.scheduleBadge()
    },
    ensureDockCard: (side, id) => deps.ensureDockCard(side, id),
    toast: (text, kind) => deps.getApp().toast(text, kind),
    openRefPicker: (rows, onPick) =>
      layers.openMenu({
        rows,
        anchor: deps.getEd().caretRect(),
        title: t('menu.title.refPicker'),
        searchable: true,
        focusSearch: true,
        emptyText: t('ui.refPicker.empty'),
        onPick:
          onPick ??
          ((row) => {
            deps.getRegistry().invoke('core.editor/insert-page-ref', { pageId: (row.args as { pageId: string }).pageId }, 'menu', uiCtx())
          }),
      }),
    pageTitle,
    pageIcon,
  }

  /**
   * 前进 / 后退：从栈里取一个**仍然存在**的落点，再用「聚焦到此块」那条命令换当前对象。
   *
   * 为什么走命令而不是直接 `setActiveId`：zoom、面包屑、链接点击、历史回放必须是
   * **同一条**换落点路径（刷新列表/标题/面包屑/落盘都在里面）；再写一份就分叉了。
   * ⚠️ 回放期间 `nav.lock` 必须为真，否则 `setActiveId` 会把这次回放又记成一条新历史。
   */
  function historyGo(dir: 'back' | 'forward'): boolean {
    const from = dir === 'back' ? nav.back : nav.forward
    const to = dir === 'back' ? nav.forward : nav.back
    while (from.length > 0) {
      const point = from.pop()!
      const feed = isFeedView()
      // 同 id 但形态不同（feed ↔ 单日）也是一次真实导航，不能跳过
      if (point.id === deps.getWs().activeId && point.feed === feed) continue
      if (!findInForest(deps.getWs().blocks, point.id)) continue // 目标在历史里被删了：跳过，别把人送到空处
      to.push({ id: deps.getWs().activeId, feed })
      nav.lock = true
      try {
        void deps.getRegistry().invoke('core.block/focus-block', { blockId: point.id, feed: point.feed }, 'history')
      } finally {
        nav.lock = false
      }
      scheduleBadge()
      return true
    }
    return false
  }

  return { pageDeps, activeBlock, activeTrail, pageTitle, nav, historyGo, firstEditableRoot, materializeEditableRoots }
}
