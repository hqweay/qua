/**
 * 面板装配：反链 footer、属性区、标签页、查询视图——四段「跟着当前对象/聚焦块走」的视图。
 * 组件实例由这一节持有；装配入口只拿重画入口与「聚焦块记忆」的清除口。
 */
import {
  childTags,
  danglingParentIds,
  displayNameOf,
  findInForest,
  findByAlias,
  flatten,
  hasList,
  isQueryBlock,
  memberBlocks,
  parentTags,
  type Atom,
  type Block,
} from '../../core/index.ts'
import { t } from '../../core/msg.ts'
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
  handleAtomClick: (a: Atom, el: HTMLElement, mods: { altKey: boolean }) => void
  /** 换库会整体替换 `ws`，不能传值 */
  getWs: () => Workspace
  /** 焦点切到反链 footer／标签页／查询视图的编辑器时，`ed` 要跟着切 */
  getEd: () => BlockEditor
  setEd: (ed: BlockEditor) => void
  getMainEd: () => BlockEditor
  getRegistry: () => Registry
  getChrome: () => Chrome
}

export function setupPanels(deps: PanelsDeps) {
  const { blocks, kb, layers, app, shortId, run, syncSections, scheduleSave, scheduleBadge, handleAtomClick } = deps
  const chrome = deps.getChrome()
  const mainEd = deps.getMainEd()
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
        scheduleProperties()
      },
      onFocusBlock: (blockId) => void deps.getRegistry().invoke('core.block/focus-block', { blockId }, 'backlinks'),
      onAtomClick: (a, el, mods) => handleAtomClick(a, el, mods),
      onAtomsLost: (labels) => app.toast(t('ui.toast.atomsLost', { labels: labels.join('、') }), 'warn'),
    },
  )

  /** 页面/日记/zoom 装载后重查 footer 反链（target = activeId） */
  function renderBacklinks(): void {
    backlinksView?.render()
  }

  renderBacklinks()

  /* ------------------------------------------------------------ 属性区 */

  /**
   * 属性区画在**当前聚焦块上**（活动编辑器里光标所在的那一块）。
   *
   * 为什么不跟「当前对象」：看一个内容块自己的属性不必先 zoom 进来；点哪一块就改哪一块，
   * 移开焦点（点到编辑区之外、窗口失焦）就收起。焦点落在本区自己的控件或 ref 选择浮层里时
   * 继续用记住的那一块 —— 否则改到一半面板会自己消失。
   *
   * ⚠️ 冷启动不抢焦点：没有任何块处于聚焦态时本区保持 `hidden`，不留一条空白。
   */

  /**
   * 属性区最近一次画过的聚焦块。
   *
   * 焦点落到面板自己的输入框、ref 选择浮层，或面板重绘让焦点暂时回到 body 时，
   * 活动编辑器已经不再「有光标」；没有记住的 id，面板就会在改到一半时消失。
   * 只有真的点到编辑区之外（pointerdown / 窗口失焦 / 换页）才清空。
   */
  let propsBlockId: string | null = null

  function lastFocusedBlock(): Block | null {
    // 窗口已经不在前台 ⇒ 没有「聚焦块」可言；否则失焦前的 activeElement 还会让我们假装有焦点
    if (!document.hasFocus()) return null
    const active = document.activeElement
    if (active && deps.getEd().container.contains(active)) {
      const caret = deps.getEd().caretBlock()
      if (!caret) return null
      const live = kb.get(caret)
      if (!live) return null
      propsBlockId = live.id
      return live
    }
    // 焦点在别的**可聚焦控件**上（Tab 到槽按钮、调试开关…）⇒ 已经没有聚焦块。
    // `body` 不算：面板重绘会把焦点暂时交回 body，那不是用户离开。
    if (active && active !== document.body && active !== document.documentElement) {
      const kept = chrome.propertiesEl.contains(active) || layers.contains(active)
      if (!kept) return null
    }
    // 焦点在面板/浮层/重绘后的 body：沿用上一次编辑器里真正落过的块
    return propsBlockId ? (kb.get(propsBlockId) ?? null) : null
  }

  const propertiesPanel = new PropertiesPanel(
    {
      root: chrome.propertiesEl,
      title: chrome.propertiesTitleEl,
      body: chrome.propertiesBodyEl,
      add: chrome.propertiesAddEl,
    },
    {
      target: () => lastFocusedBlock(),
      rows: (b) => [...kb.fieldsOf(b.id)],
      // 标签（分类归属）与标签属性（字段声明）是两件事：这一行走 `props._tags`
      tags: (b) => [...kb.tagsOf(b.id)],
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
      declared: (b) => [...kb.declaredFieldsOf(b.id)],
      shortId: (id) => shortId(id),
      setValue: (b, propId, value) => void deps.getRegistry().invoke('core.props/set-value', { blockId: b.id, propId, value }, 'ui'),
      clearValue: (b, propId) => void deps.getRegistry().invoke('core.props/clear-value', { blockId: b.id, propId }, 'ui'),
      addField: (b, propId) => void deps.getRegistry().invoke('core.props/add-field', { blockId: b.id, propId }, 'ui'),
      undeclare: (b, propId) => void deps.getRegistry().invoke('core.props/undeclare', { blockId: b.id, propId }, 'ui'),
      createDef: (b, propId, kind) => void deps.getRegistry().invoke('core.props/create-def', { blockId: b.id, propId, kind }, 'ui'),
      /**
       * **`ref` 值的选择器**：从整片森林里挑一块。
       *
       * 复用 `layers.openMenu`（与命令面板 / 标签选择器同一个浮层），
       * 所以键盘、搜索、空态的行为不用再写一份。
       * 列表给「页 → 它的块」两级，页名与块正文都能搜到。
       *
       * ⚠️ 标题用**显示名**（主名叶子 > 正文）：引用要叫「它的名字」，
       *    不是「它的描述」。描述仍留在 `hint`／后续的块行里。
       */
      pickRef: (owner, _propId, current, onPick) => {
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
          anchor: deps.getEd().caretRect(),
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
      },
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
    propertiesPanel.render()
  }

  /** 属性区跟着选块走；合并短时间内的多次改动（打字时不必每键重画面板） */
  let propertyTimer: number | null = null
  function scheduleProperties(): void {
    if (propertyTimer !== null) window.clearTimeout(propertyTimer)
    propertyTimer = window.setTimeout(() => {
      propertyTimer = null
      renderProperties()
    }, 60)
  }
  blocks.subscribe(() => scheduleProperties())
  renderProperties()

  /**
   * **面板跟着「聚焦块」重算**，三条触发各自对应一种「焦点去哪了」：
   *   · `selectionchange`：在编辑器里点/敲/方向键移动光标；
   *   · `focusin`：点进编辑器（还没形成选区的那一刻）；
   *   · `pointerdown`（捕获）：点到了编辑区之外 ⇒ 收起。
   *
   * ⚠️ `selectionchange` 只在活动编辑器里处理：属性区自己的输入框也会产生选区变化，
   *    跟着重绘会把正在输入的控件整块换掉。
   * ⚠️ 点面板自己或浮层里（含 ref 选择器）不算「出去了」——否则点开选择器的那一下就把面板关了。
   */
  document.addEventListener('selectionchange', () => {
    if (deps.getEd().container.contains(document.activeElement)) scheduleProperties()
  })
  document.addEventListener('focusin', (e) => {
    if (e.target instanceof Node && deps.getEd().container.contains(e.target)) scheduleProperties()
  })
  document.addEventListener('focusout', (e) => {
    const next = e.relatedTarget
    if (next instanceof Node) {
      if (deps.getEd().container.contains(next)) return
      if (chrome.propertiesEl.contains(next) || layers.contains(next)) return
    }
    // 焦点落到 body（面板重绘）时下面那条会沿用记住的块；落到别的控件则会收起
    scheduleProperties()
  })
  document.addEventListener(
    'pointerdown',
    (e) => {
      const node = e.target as Node | null
      if (!node) return
      if (deps.getEd().container.contains(node)) return
      if (chrome.propertiesEl.contains(node)) return
      if ((node as HTMLElement).closest?.('.blk')) return
      if (layers.contains(node)) return
      propsBlockId = null
      scheduleProperties()
    },
    true,
  )
  window.addEventListener('blur', () => {
    propsBlockId = null
    scheduleProperties()
  })

  /* ------------------------------------------------------------ 标签页 footer（属于 / 包含 / 成员） */

  const tagPanel: TagPanel = new TagPanel(
    {
      root: chrome.tagPanelEl,
      title: chrome.tagPanelTitleEl,
      pageToggle: chrome.tagPanelPageEl,
      relations: chrome.tagPanelRelationsEl,
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
      parents: (t) => parentTags(t, deps.getWs().blocks),
      dangling: (t) => danglingParentIds(t, deps.getWs().blocks),
      children: (t) => childTags(t, deps.getWs().blocks),
      members: (t) => memberBlocks(t.id, deps.getWs().blocks),
      isPage: (t) => hasList(t, 'page'),
      togglePage: (tagId) => {
        const b = findInForest(deps.getWs().blocks, tagId)
        if (!b) return
        void deps.getRegistry().invoke(hasList(b, 'page') ? 'core.block/unpage' : 'core.block/as-page', { blockId: tagId }, 'tagpanel')
      },
      shortId: (id) => shortId(id),
      addParent: (tagId, name) => {
        const parent = findByAlias(deps.getWs().blocks, name, (b) => hasList(b, 'tag'))
        if (!parent) {
          app.toast(t('ui.tagpanel.notFound', { name }), 'warn')
          return
        }
        void deps.getRegistry().invoke('core.tags/add-parent', { childId: tagId, parentId: parent.id }, 'ui')
      },
      removeParent: (tagId, parentId) =>
        void deps.getRegistry().invoke('core.tags/remove-parent', { childId: tagId, parentId }, 'ui'),
      pruneParents: (tagId) => void deps.getRegistry().invoke('core.tags/prune-parents', { childId: tagId }, 'ui'),
      onChange: () => {
        scheduleSave()
        scheduleBadge()
        scheduleProperties()
      },
      onFocus: () => {
        deps.setEd(tagPanel.editor)
        scheduleProperties()
      },
      onFocusBlock: (blockId) => void deps.getRegistry().invoke('core.block/focus-block', { blockId }, 'tagpanel'),
      onAtomClick: (a, el, mods) => handleAtomClick(a, el, mods),
      onAtomsLost: (labels) => app.toast(t('ui.toast.atomsLost', { labels: labels.join('、') }), 'warn'),
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
        scheduleProperties()
      },
      onFocusBlock: (blockId) => void deps.getRegistry().invoke('core.block/focus-block', { blockId }, 'query'),
      onAtomClick: (a, el, mods) => handleAtomClick(a, el, mods),
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

  /** 换页/换焦点对象：上一条「聚焦块」不再成立，等 focusFirstBlock 重新设上 */
  function forgetFocusedBlock(): void {
    propsBlockId = null
  }

  return { renderBacklinks, renderProperties, renderTagPanel, renderQueryView, scheduleProperties, forgetFocusedBlock }
}
