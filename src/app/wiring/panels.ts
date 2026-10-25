/**
 * 面板装配：反链 footer、属性区、标签页、查询视图——四段「跟着当前对象走」的视图。
 * 组件实例由这一节持有；装配入口只拿重画入口。
 */
import {
  buildAdjacency,
  danglingOf,
  displayNameOf,
  findInForest,
  findByAlias,
  flatten,
  hasList,
  isJournal,
  isQueryBlock,
  journalDate,
  journalDateLabel,
  memberBlocks,
  parentsOf,
  type Block,
} from '../../core/index.ts'
import { t } from '../../core/msg.ts'
import type { RunWithId } from '../../core/runs.ts'
import type { App, Registry } from '../../core/commands/index.ts'
import type { MemoryKb } from '../../core/kb/memory.ts'
import type { Tx } from '../../core/kb/types.ts'
import type { BlockStore } from '../../core/store.ts'
import type { Workspace } from '../../core/workspace.ts'
import { BacklinksView } from '../../ui/backlinks.ts'
import type { Layers, Row } from '../../ui/layers.ts'
import { PropertiesPanel } from '../../ui/properties.ts'
import { QueryView } from '../../ui/query-view.ts'
import { TagPanel } from '../../ui/tag-panel.ts'
import type { Chrome } from '../../ui/chrome.ts'
import type { BlockEditor } from '../../view/editor.ts'

export type PanelsDeps = {
  blocks: BlockStore
  kb: MemoryKb
  layers: Layers
  app: App
  shortId: (id: string) => string
  activeBlock: () => Block
  run: <R>(fn: (tx: Tx) => R, source?: unknown) => R
  syncSections: () => void
  scheduleSave: () => void
  scheduleBadge: () => void
  handleAtomClick: (run: RunWithId, el: HTMLElement, mods: { altKey: boolean; shiftKey: boolean }) => void
  /** 换库会整体替换 `ws`，不能传值 */
  getWs: () => Workspace
  /** 焦点切到反链 footer／标签页／查询视图的编辑器时，`ed` 要跟着切 */
  getEd: () => BlockEditor
  setEd: (ed: BlockEditor) => void
  getMainEd: () => BlockEditor
  getRegistry: () => Registry
  getChrome: () => Chrome
  /** Shift+点任意可打开的行/块标/原子：在右槽打开（窗口） */
  openInDock: (blockId: string) => void
}

export function setupPanels(deps: PanelsDeps) {
  const { blocks, kb, layers, app, shortId, run, syncSections, scheduleSave, scheduleBadge, handleAtomClick } = deps
  const chrome = deps.getChrome()
  const mainEd = deps.getMainEd()
  /**
   * 边图邻接表**当次现建**：根集合随「父的露面」变，缓存一处就会让加了露面之后
   * 树里的位置不变。一屏之内要问好几遍的（属性区那一行）共用一次。
   */
  const adj = () => buildAdjacency(deps.getWs().blocks)
  const activeBlock = deps.activeBlock

  /**
   * **反链 view block**（footer 版， 下一层）：挂的是共享 store 的活块，
   * 所以这里可以原地编辑；右槽以后挂同一个 view。
   */
  let backlinksView: BacklinksView | null = null
  backlinksView = new BacklinksView(
    {
      root: chrome.backlinksEl,
      editor: chrome.backlinksEditorEl,
      title: chrome.backlinksTitleEl,
      count: chrome.backlinksCountEl,
      refresh: chrome.backlinksRefreshEl,
    },
    {
      store: blocks,
      write: (fn) => run(fn, backlinksView?.editor),
      kb,
      targetId: () => deps.getWs().activeId,
      onChange: () => {
        syncSections()
        scheduleSave()
        scheduleBadge()
      },
      onFocus: () => {
        if (backlinksView) deps.setEd(backlinksView.editor)
        // 不重画属性区：反链 footer 里的光标不属于「台面上那个块」，面板主体不随它变
      },
      onFocusBlock: (blockId) => void deps.getRegistry().invoke('core.block/focus-block', { blockId }, 'backlinks'),
      onOpenInDock: (blockId) => deps.openInDock(blockId),
      onAtomClick: (run, _blockId, el, mods) => handleAtomClick(run, el, mods),
    },
  )

  /** 页面/日记/zoom 装载后重查 footer 反链（target = activeId） */
  function renderBacklinks(): void {
    backlinksView?.render()
  }

  renderBacklinks()

  /* ------------------------------------------------------------ 属性区 */

  /**
   * 属性区的**主体**：这一屏**唯一的那个块**。
   *
   * 判据一条、不分角色：`doc.roots.length === 1` ⇒ 面板画那一块；否则收起。
   * 于是「打开一个页 / 聚焦一个块 / 只看今天这一天日记」都显示（它们都是单根），
   * 而日记流（今日＋更早的几天）、查询列表、多页并排都收起 —— 那些屏上没有
   * 「一个东西」可言，拿其中一段冒充整屏的主体正是本区最该避免的错位。
   *
   * ## 为什么不跟光标
   *
   * 「主体」必须是**被显式放到台面上的东西**。这个应用里台面只有两处：中心槽的当前对象
   * （`activeId`）与侧槽里**钉住**的块 —— 两者都是用户主动选定的，会一直待在原处直到再选一次。
   * 光标不在这两处里：它是阅读/输入过程中的瞬时位置。
   *
   * 三个具体后果（不是口味）：
   *   · **布局跳**：本区在正文**上方**。跟着光标 ⇒ 按一次 ↑/↓ 就可能在阅读内容上方
   *     插进/抽走几行 chrome，用户读到的那段文字整体位移。方向键是最高频的按键。
   *   · **位置与主体不符**：面板在顶、主体却在第 47 行。
   *   · **两套主体**：`activeId` 已经是「这一屏是谁」（面包屑、装载根、左右槽不跟随都按它算），
   *     再让属性区另认一个 ⇒ 同一屏有两处指着不同的块，用户没法从界面推出「改的是哪一个」。
   *
   * ## 那「不想 zoom 就想改某块的属性」怎么办
   *
   * 那个动作的成本被算错了：**块标点一下就是聚焦**（块标＝聚焦入口），它已经把
   * 「把这一块放上台面」做成了一次点击。所以不需要第二套主体，需要的是捷径，
   * 而捷径已经有一条（点块标 / 块菜单「聚焦到此块」）。
   *
   * ⚠️ 与「zoom 是视图配置、不引入焦点栈」一致：本区读的就是那个视图配置（当前对象），
   *    不额外持有任何「上次是谁」的记忆，因此也没有「点空白就收起」这回事。
   */
  function subject(): Block | null {
    const roots = deps.getMainEd().doc.roots
    return roots.length === 1 ? roots[0]! : null
  }

  /**
   * 检视卡：**常驻卡片**（列在右槽，`renderDockStack` 的 `persistent`）。
   *
   * 先挂进堆叠再交给重画：`renderDockStack` 只保留**已在文档里**的常驻节点
   * （游离节点会被当成垃圾清掉，然后写进一棵看着空的树）。
   *
   * 为什么是常驻而不是每次现造：里面是表单，重建会丢焦点与光标 ——
   * 与钉住区同一条理由（那边踩过一次「每敲一个字跳一次」）。
   */
  const inspectCard = chrome.inspectCardEl
  chrome.dockRightStackEl.appendChild(inspectCard)

  /**
   * **`ref` 值的选择器**：从整片森林里挑一块。
   *
   * 复用 `layers.openMenu`（与命令面板 / 标签选择器同一个浮层），
   * 所以键盘、搜索、空态的行为不用再写一份。
   * 列表给「页 → 它的块」两级，页名与块正文都能搜到。
   *
   * ⚠️ 标题用**显示名**（主名叶子 > 正文）：引用要叫「它的名字」，
   *    不是「它的描述」。描述仍留在 `hint`／后续的块行里。
   * ⚠️ `anchor` 由调用方给（属性区给按钮 rect、行内浮层给按钮 rect）：
   *    不再一律贴光标——否则从浮层里选值时，菜单会跑到编辑器的光标处。
   */
  const pickRefValue = (
    owner: Block,
    _propId: string,
    current: string,
    onPick: (targetId: string) => void,
    anchor?: DOMRect,
  ): void => {
    const rows: Row[] = []
    for (const b of flatten({ roots: [...kb.roots()] })) {
      // 自己不能指向自己：那会造出一个立刻成环的引用
      if (b.id === owner.id) continue
      const title = displayNameOf(b).trim()
      rows.push({
        id: `ref/${b.id}`,
        label: title === '' ? t('ui.page.untitled') : title,
        hint: hasList(b, 'page') ? t('ui.props.refIsPage') : t('ui.props.refIsBlock'),
        icon: hasList(b, 'page') ? 'lucide:file' : 'lucide:square',
        group: hasList(b, 'page') ? 'ref/1-page' : 'ref/2-block',
        // 当前值做个标记：不然选过一次之后看不出来「现在是哪个」
        keyHint: b.id === current ? t('ui.props.refCurrent') : undefined,
      })
    }
    layers.openMenu({
      rows,
      anchor: anchor ?? deps.getEd().caretRect(),
      title: t('ui.props.pickRef'),
      searchable: true,
      focusSearch: true,
      emptyText: t('ui.props.refEmpty'),
      onPick: (row) => {
        const id = String(row.id).slice('ref/'.length)
        onPick(id)
        // 选择器关掉之后属性区要立刻显示新值（不等下一次 store 通知）
        scheduleProperties()
      },
    })
  }

  const propertiesPanel = new PropertiesPanel(
    {
      root: inspectCard,
      title: chrome.inspectCardTitleEl,
      body: chrome.propertiesBodyEl,
      add: chrome.propertiesAddEl,
    },
    {
      target: () => subject(),
      rows: (b) => [...kb.fieldsOf(b.id)],
      // 标签（分类归属）与标签属性（字段声明）是两件事：这一行走 `props._tags`
      tags: (b) => [...kb.tagsOf(b.id)],
      // 归属（filed-under）：任何块都有这一行；跨类的那条边只在这里看得见
      belongsTo: (b) => parentsOf(b, adj()),
      belongsDangling: (b) => danglingOf(b, adj()),
      addBelong: (b, name) => {
        // 入口收窄：候选只给页与标签（模型不查露面，这是 UI 的取舍）
        const parent = findByAlias(deps.getWs().blocks, name, (x) => hasList(x, 'page') || hasList(x, 'tag'))
        if (!parent) {
          app.toast(t('ui.belongs.notFound', { name }), 'warn')
          return
        }
        void deps.getRegistry().invoke('core.belongs-to/add', { childId: b.id, parentId: parent.id }, 'ui')
        propertiesPanel.render()
      },
      removeBelong: (b, parentId) => {
        void deps.getRegistry().invoke('core.belongs-to/remove', { childId: b.id, parentId }, 'ui')
        propertiesPanel.render()
      },
      pruneBelongs: (b) => {
        void deps.getRegistry().invoke('core.belongs-to/prune', { childId: b.id }, 'ui')
        propertiesPanel.render()
      },
      // 挂/摘之后**面板自己重画**：这一行显示的就是刚改的那份 `_tags`，
      // 等下一次选区变化才刷会让「加完没反应」
      addTag: (b, name) => {
        void deps.getRegistry().invoke('core.tags/add', { blockId: b.id, name }, 'ui')
        propertiesPanel.render()
      },
      removeTag: (b, tagId) => {
        void deps.getRegistry().invoke('core.tags/remove', { blockId: b.id, tagId }, 'ui')
        propertiesPanel.render()
      },
      defs: () => [...kb.propDefs()],
      shortId: (id) => shortId(id),
      setValue: (b, propId, value) => void deps.getRegistry().invoke('core.props/set-value', { blockId: b.id, propId, value }, 'ui'),
      clearValue: (b, propId) => void deps.getRegistry().invoke('core.props/clear-value', { blockId: b.id, propId }, 'ui'),
      addField: (b, propId) => void deps.getRegistry().invoke('core.props/add-field', { blockId: b.id, propId }, 'ui'),
      createDef: (b, propId, kind) => void deps.getRegistry().invoke('core.props/create-def', { blockId: b.id, propId, kind }, 'ui'),
      /**
       * **`ref` 值的选择器**（实现见上面的 `pickRefValue`）：从整片森林里挑一块。
       * 属性区与行内实例浮层共用同一份，候选集合不会分叉。
       */
      pickRef: pickRefValue,
      refLabel: (targetId) => {
        const b = kb.get(targetId)
        if (!b) return t('ui.props.refMissing', { id: shortId(targetId) })
        const name = displayNameOf(b).trim()
        return name === '' ? shortId(b.id) : name
      },
      toast: (text, kind) => app.toast(text, kind),
    },
  )

  function renderProperties(): void {
    renderInspectTitle(subject())
    propertiesPanel.render()
  }

  /**
   * 重算时机：**当前对象变了**、或库里那块的内容变了，才需要重画。
   *
   * 触发点少而明确 —— 装载（换页 / 聚焦 / 翻日 / 换库，见 `loadPage`）、store 写入、
   * 面板自己的写入完成。光标移动、窗口失焦、点空白**都不在其中**：那些都不改变「这一屏是谁」。
   * 这正是本区不跟光标换来的好处：没有一组「焦点去哪了」的监听要维护，
   * 也就没有「改到一半面板自己消失」这一类要防。
   *
   * ⚠️ `blocks.subscribe` 仍要在：改标签/属性值之后行内容要跟着变，这与主体是谁无关。
   */
  let propertyTimer: number | null = null
  function scheduleProperties(): void {
    if (propertyTimer !== null) window.clearTimeout(propertyTimer)
    propertyTimer = window.setTimeout(() => {
      propertyTimer = null
      renderProperties()
    }, 60)
  }

  /**
   * 卡片标题＝**当前对象的名字**（journal 用日期投影，与面包屑同一口径）。
   *
   * 为什么标题交给卡而不是「块属性」四个字：这张卡要回答的是「现在在改**谁**」。
   * 名字写在卡的抬头，换主体时**标题变、卡不动** —— 位置稳定，用户不用重新认路。
   */
  function renderInspectTitle(b: Block | null): void {
    chrome.inspectCardTitleEl.textContent = b
      ? isJournal(b)
        ? journalDateLabel(journalDate(b))
        : displayNameOf(b).trim() || t('ui.page.untitled')
      : ''
  }

  blocks.subscribe(() => scheduleProperties())
  renderProperties()

  /* ------------------------------------------------------------ 标签页 footer（属于 / 包含 / 成员） */

  const tagPanel: TagPanel = new TagPanel(
    {
      root: chrome.tagPanelEl,
      title: chrome.tagPanelTitleEl,
      pageToggle: chrome.tagPanelPageEl,
      membersTitle: chrome.tagPanelMembersTitleEl,
      membersCount: chrome.tagPanelMembersCountEl,
      membersEmpty: chrome.tagPanelMembersEmptyEl,
      membersEditor: chrome.tagPanelMembersEditorEl,
    },
    {
      store: blocks,
      // `tagPanel` 在这一行之前就已声明（`const`），闭包调用时它已经就绪
      write: (fn) => run(fn, tagPanel.editor),
      kb,
      tag: () => {
        const b = activeBlock()
        return hasList(b, 'tag') ? b : undefined
      },
      members: (t) => memberBlocks(t.id, deps.getWs().blocks),
      isPage: (t) => hasList(t, 'page'),
      togglePage: (tagId) => {
        const b = findInForest(deps.getWs().blocks, tagId)
        if (!b) return
        void deps.getRegistry().invoke(hasList(b, 'page') ? 'core.block/unpage' : 'core.block/as-page', { blockId: tagId }, 'tagpanel')
      },
      shortId: (id) => shortId(id),
      onChange: () => {
        scheduleSave()
        scheduleBadge()
        scheduleProperties()
      },
      onFocus: () => {
        deps.setEd(tagPanel.editor)
        // 面板主体是中心槽的当前对象，与这个编辑器里的光标无关
      },
      onFocusBlock: (blockId) => void deps.getRegistry().invoke('core.block/focus-block', { blockId }, 'tagpanel'),
      onOpenInDock: (blockId) => deps.openInDock(blockId),
      onAtomClick: (run, _blockId, el, mods) => handleAtomClick(run, el, mods),
    },
  )

  function renderTagPanel(): void {
    tagPanel.render()
  }
  renderTagPanel()

  /**
   * **查询视图**：挂在「当前正文里那个查询块」下面。
   *
   * 口径：**查询块＝数据侧**，不吃结果——
   *   · 查询块自己只是大纲里的一行（正文＝它的名字，`_query` 里是条件）；
   *   · 结果是**外源渲染**，跟在它后面、**不 re-parent** ⇒ 刷新只改结果；
   *   · 正文里没有查询块 ⇒ 整段隐藏（不留死抬头）。
   */
  let queryView: QueryView | null = null
  /** 当前正文里那个查询块（没有 ⇒ `null`，视图整段隐藏） */
  let queryBlock: Block | null = null
  queryView = new QueryView(
    {
      root: chrome.queryViewEl,
      editor: chrome.queryViewEditorEl,
      title: chrome.queryViewTitleEl,
      count: chrome.queryViewCountEl,
      refresh: chrome.queryViewRefreshEl,
      stale: chrome.queryViewStaleEl,
    },
    {
      store: blocks,
      write: (fn) => run(fn, queryView?.editor),
      kb,
      block: () => queryBlock ?? activeBlock(),
      onChange: () => {
        syncSections()
        scheduleSave()
        scheduleBadge()
      },
      onFocus: () => {
        if (queryView) deps.setEd(queryView.editor)
        // 面板主体是中心槽的当前对象，与这个编辑器里的光标无关
      },
      onFocusBlock: (blockId) => void deps.getRegistry().invoke('core.block/focus-block', { blockId }, 'query'),
      onOpenInDock: (blockId) => deps.openInDock(blockId),
      onAtomClick: (run, _blockId, el, mods) => handleAtomClick(run, el, mods),
      toast: (text, kind) => app.toast(text, kind),
    },
  )

  /**
   * 找出**当前这一段**里的查询块并装载。
   *
   * ⚠️ 只认 `doc.roots` 那一层（及它的直接子块）：查询块是「这张页面里的一个块」，
   *    不是全库搜索结果——否则打开任意页都会突然冒出一个别处的查询视图。
   * ⚠️ 视图实例复用：换查询块时 `mount()` 重新冻结，不重建编辑器（否则 undo/选区全丢）。
   */
  function renderQueryView(): void {
    if (!queryView) return
    const inRoots = mainEd.doc.roots.flatMap((r) => [r, ...r.children])
    const q = inRoots.find((b) => isQueryBlock(b))
    if (!q) {
      queryBlock = null
      chrome.queryViewEl.hidden = true
      return
    }
    const changed = queryBlock?.id !== q.id
    queryBlock = q
    chrome.queryViewEl.hidden = false
    if (changed) queryView.mount()
    else queryView.render()
  }

  return { renderBacklinks, renderProperties, renderTagPanel, renderQueryView, scheduleProperties, pickRefValue }
}
