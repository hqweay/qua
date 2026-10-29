/**
 * 面板装配：属性区 ＋ **块底的挂载区**（每段一个）。
 *
 * 两者判据不同，别合并：
 *   · 属性区回答「这一屏是谁」（单根才画）；
 *   · 挂载区回答「这一块下面能展开哪些查询」（单根 ＋ 日记流的每一段）。
 * 组件实例由这一节持有；装配入口只拿重画入口。
 */
import {
  blockLabel,
  buildAdjacency,
  danglingOf,
  displayNameOf,
  findByAlias,
  flatten,
  hasList,
  isJournal,
  isQueryBlock,
  journalDate,
  parentsOf,
  readSpec,
  todayISO,
  type Block,
} from '../../core/index.ts'
import { t } from '../../core/msg.ts'
import type { RefClickHit, RefClickMods } from '../../view/editor-events.ts'
import type { App, Registry } from '../../core/commands/index.ts'
import type { MemoryKb } from '../../core/kb/memory.ts'
import type { Tx } from '../../core/kb/types.ts'
import type { BlockStore } from '../../core/store.ts'
import type { Workspace } from '../../core/workspace.ts'
import type { Layers, Row } from '../../ui/layers.ts'
import { MountArea } from '../../ui/mount-area.ts'
import { PropertiesPanel } from '../../ui/properties.ts'
import { createViewHostEls, ViewHost } from '../../ui/query-view.ts'
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
  /**
   * **给一台视图编辑器接上与正文同一套事件**（`main.ts` 的 `viewEvents` 是唯一一份）。
   * 挂载区、查询结果都走它 —— 各接一半的代价是「面板里点引用不跳」这类静默漏接。
   */
  wireEditor: (editor: BlockEditor, change: (kind: string) => void, via: string) => void
  /**
   * **「指向某块的露面」被点**（行内引用 / 行尾标签 chip 共用同一条口径）。
   * 由装配层注入，本层不认识「去哪」的语义；`el` 只是浮层锚点，可省。
   */
  refClick: (ref: RefClickHit, mods: RefClickMods, el?: HTMLElement) => void
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
  /**
   * **把一块的正文投影进一个容器**（run/marks/引用/图片都在）。
   *
   * 由装配层注入：表格标题列要画的是**块的样子**，而「引用现在叫什么、图在哪」
   * 只有持有读门面的那一层答得出来。`ui` 自己拼一份投影就会长出第二套 run 渲染。
   */
  project: (block: Block, into: HTMLElement) => void
  /** 点标题里的一枚非引用原子（图片/外链）：默认动作 / ⌥ 详情（与正文同一份） */
  atomClick?: (atom: { runId: string; kind: string; hash?: string }, el: HTMLElement, mods: { altKey: boolean; shiftKey: boolean }) => void
}

export function setupPanels(deps: PanelsDeps) {
  const { blocks, kb, layers, app, shortId, run, syncSections, scheduleSave, scheduleBadge, refClick } = deps
  const chrome = deps.getChrome()
  const mainEd = deps.getMainEd()
  /**
   * 边图邻接表**当次现建**：根集合随「父的露面」变，缓存一处就会让加了露面之后
   * 树里的位置不变。一屏之内要问好几遍的（属性区那一行）共用一次。
   */
  const adj = () => buildAdjacency(deps.getWs().blocks)

  /* 挂载区（每段一个）：装配在文件末尾的 renderMounts 里 —— 它要按段根建实例，
     而属性区只认「这一屏是谁」，两者判据不同，所以不挤在同一段。 */

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
      // 属性区里的标签名也是「指向标签块的一处露面」，与正文 chip 同一条口径
      // 属性区里的标签名也是「指向标签块的一处露面」，与正文 chip 同一条口径
      openRef: (to, mods) => refClick({ to }, { altKey: false, ...mods }),
      defs: () => [...kb.propDefs()],
      shortId: (id) => shortId(id),
      setValue: (b, propId, value) => void deps.getRegistry().invoke('core.props/set-value', { blockId: b.id, propId, value }, 'ui'),
      clearValue: (b, propId) => void deps.getRegistry().invoke('core.props/clear-value', { blockId: b.id, propId }, 'ui'),
      // ⚠️ 两个去处显式声明（`target`），不按块类型猜：标签块既要有自己的值、又要声明给成员
      addOwnProp: (b, propId) =>
        void deps.getRegistry().invoke('core.props/add-field', { blockId: b.id, propId, target: 'own' }, 'ui'),
      createOwnDef: (b, label, kind) =>
        void deps.getRegistry().invoke('core.props/create-def', { blockId: b.id, label, kind, target: 'own' }, 'ui'),
      declareProp: (b, propId) =>
        void deps.getRegistry().invoke('core.props/add-field', { blockId: b.id, propId, target: 'declared' }, 'ui'),
      createDeclaredDef: (b, label, kind) =>
        void deps.getRegistry().invoke('core.props/create-def', { blockId: b.id, label, kind, target: 'declared' }, 'ui'),
      declaredFields: (b) => [...kb.declaredFieldsOf(b.id)],
      undeclareField: (b, propId) => void deps.getRegistry().invoke('core.props/undeclare', { blockId: b.id, propId }, 'ui'),
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
    chrome.inspectCardTitleEl.textContent = b ? blockLabel(b) : ''
  }

  blocks.subscribe(() => scheduleProperties())
  renderProperties()

  /* ------------------------------------------------------------ 挂载区（每段一个） */

  /**
   * **一条 tab 条 ＋ 一个 body**，挂在**每一段**末尾那个空槽里（`.sec-mount`）。
   *
   * 三件放在这里而不是组件里的知识：
   *   · **哪一段有挂载区**：单根（页 / zoom / 单日）＋ 日记流的每一段；
   *     N>1 的非日记（查询结果列表、多页并排）**没有**——那些屏上没有「一个对象」可言。
   *   · **实例按段根缓存**：段根不变就复用（切换/滚动不重建编辑器，撤销栈与选区都还在）。
   *   · **查询块的结果视图**：被打开的那个查询块自己就是段根 ⇒ 那一段的槽里先放它的结果，
   *     再放挂载区。页面里「底部单列一条查询结果」没有了（那是旧形状）。
   *
   * 日记流里**只有今天展开**：更早的天是一行摘要（`MountArea` 初始 `expanded`）。
   */
  type MountInstance = { area: MountArea; query: ViewHost | null; queryHostId: string }
  const mountInstances = new Map<string, MountInstance>()

  /** 这一段该不该默认展开：日记只展开今天（「今天 = 你要写的那一天」） */
  const expandedFor = (host: Block): boolean => (isJournal(host) ? journalDate(host) === todayISO() : true)

  /**
   * **这一段要不要建视图宿主**。
   *
   * 两条判据缺一不可：
   *   · 查询块：它自己就是一张视图（不论激活哪种 kind）；
   *   · 普通块：只有当它是**这一屏的视图根**（`Doc.viewRootId`）时才有 ——
   *     否则「页里有子块」的每一条日记天都会在流里长出一张表（它在别的页里只是普通子块）。
   */
  const wantsView = (host: Block): boolean => isQueryBlock(host) || mainEd.doc.viewRootId === host.id

  function createView(host: Block): ViewHost {
    const hostId = host.id
    const vh = new ViewHost(createViewHostEls(), {
      store: blocks,
      write: (fn) => run(fn, edOfMount(hostId)),
      kb,
      block: () => blocks.find(hostId) ?? host,
      onChange: () => {
        syncSections()
        scheduleSave()
        scheduleBadge()
      },
      onFocus: (editor) => deps.setEd(editor),
      wire: (editor, change) => deps.wireEditor(editor, change, 'query'),
      toast: (text, kind) => app.toast(text, kind),
      invoke: (name, args) => void deps.getRegistry().invoke(name, args, 'queryview'),
      project: (b, into) => deps.project(b, into),
      refClick: (hit, el, mods) => deps.refClick(hit, mods, el),
      ...(deps.atomClick ? { onAtomClick: (atom, el, mods) => deps.atomClick!(atom, el, mods) } : {}),
      openBlock: (id) => void deps.getRegistry().invoke('core.block/focus-block', { blockId: id }, 'queryview'),
      pickRef: (b, propId, current, onPick, anchor) => pickRefValue(b, propId, current, onPick, anchor),
      refLabel: (id) => {
        const b = kb.get(id)
        if (!b) return t('ui.props.refMissing', { id: shortId(id) })
        const name = displayNameOf(b).trim()
        return name === '' ? shortId(b.id) : name
      },
    })
    void vh
    return vh
  }

  function createMount(host: Block): MountInstance {
    const hostId = host.id
    const area = new MountArea(
      {
        store: blocks,
        write: (fn) => run(fn, edOfMount(hostId)),
        kb,
        host: () => blocks.find(hostId),
        onChange: () => {
          syncSections()
          scheduleSave()
          scheduleBadge()
        },
        // 焦点进挂载区 ⇒ 活动编辑器就是那一个（键位走命令层，认的是它）
        onFocus: (editor) => deps.setEd(editor),
        // 与正文同一套事件（点引用/块标/右键菜单/`#`·`@` 补全），装配层只给这一份
        wire: (editor, change) => deps.wireEditor(editor, change, 'mount'),
        onAddTab: (id) => openMountPicker(id),
        onRemoveTab: (id, index) => {
          void deps.getRegistry().invoke('core.mount/remove', { hostId: id, index }, 'mount')
          // 摘完当场重排：栏是模型里的一格，DOM 不会自己知道
          renderMounts()
        },
        expanded: expandedFor(host),
      },
    )
    const query = wantsView(host) ? createView(host) : null
    return { area, query, queryHostId: query ? hostId : '' }
  }

  /** 挂载区里那个编辑器（写事务的 source）。焦点切过去之后 `ed` 就是它 */
  const edOfMount = (hostId: string) => mountInstances.get(hostId)?.area.blockEditor ?? undefined

  /**
   * 「＋」：从**库里已保存的查询块**挑一个，把它的条件复制成一栏。
   *
   * 为什么是复制条件而不是把查询块挂上来：挂载项不是库对象（没有身份、不能被引用），
   * 而查询块是。让一格数据指着一个块，就带回孤儿与悬空 id 的老问题。
   * 代价（登记在文档里）：条件在挂上那一刻定格，之后改查询块不会同步。
   */
  function openMountPicker(hostId: string): void {
    const rows: Row[] = []
    for (const b of flatten({ roots: [...kb.roots()] })) {
      const spec = readSpec(b)
      if (!spec) continue
      rows.push({
        id: `query/${b.id}`,
        label: displayNameOf(b).trim() || t('ui.query.untitled'),
        hint: t('ui.mount.addHint'),
        icon: 'lucide:list-filter',
      })
    }
    const host = blocks.find(hostId)
    if (!host) return
    if (rows.length === 0) {
      app.toast(t('ui.mount.addEmpty'), 'info')
      return
    }
    layers.openMenu({
      rows,
      anchor: deps.getEd().caretRect(),
      title: t('ui.mount.add'),
      searchable: true,
      focusSearch: true,
      emptyText: t('ui.mount.addEmpty'),
      onPick: (row) => {
        const id = String(row.id).slice('query/'.length)
        const b = blocks.find(id)
        const spec = b ? readSpec(b) : null
        if (!b || !spec) return
        void deps.getRegistry().invoke(
          'core.mount/add',
          { hostId, label: displayNameOf(b).trim() || t('ui.query.untitled'), spec },
          'mount',
        )
        // 当场看见新栏：store 订阅在「焦点还在本视图里」时会跳过（同 × 那条理由）
        mountInstances.get(hostId)?.area.render()
      },
    })
  }

  /**
   * 按编辑器里**有段根的那些段**建/收实例，并把实例的 DOM 放进那一段的空槽。
   *
   * 只在「装载 / 换库 / 段集合变了」时调：DOM 节点自己带着编辑器与会话状态，
   * 这里做的是**搬**（appendChild 到新段），不是重建。
   */
  function renderMounts(): void {
    const roots = mainEd.doc.roots
    // N>1 且不是日记流 ⇒ 没有「一个对象」可挂（查询结果列表、多页并排）
    const allow = roots.length <= 1 || roots.every((r) => isJournal(r))
    const seen = new Set<string>()
    if (allow) {
      for (const sec of mainEd.container.querySelectorAll<HTMLElement>('.sec')) {
        const hostId = sec.dataset.sec ?? ''
        if (hostId === '') continue
        const slot = sec.querySelector<HTMLElement>(':scope > .sec-mount')
        if (!slot) continue
        const host = blocks.find(hostId)
        if (!host) continue
        seen.add(hostId)
        let inst = mountInstances.get(hostId)
        if (!inst) {
          inst = createMount(host)
          mountInstances.set(hostId, inst)
          // 新实例才装载一次（之后由它自己的 store 订阅跟进）
          if (inst.query) {
            inst.queryHostId = hostId
            inst.query.mount()
          }
        } else if (inst.query && !wantsView(host)) {
          /**
           * 切回大纲：**摘掉视图宿主**（连同它订阅的编辑器），别藏一台还在跟着 store 重画的。
           * 段尾的挂载区留着 —— 它与视图是两件事。
           */
          if (inst.query.editor && deps.getEd() === inst.query.editor) deps.setEd(deps.getMainEd())
          inst.query.dispose()
          inst.query.root.remove()
          inst.query = null
          inst.queryHostId = ''
        } else if (!inst.query && wantsView(host)) {
          inst.query = createView(host)
          inst.queryHostId = hostId
          inst.query.mount()
        } else {
          // 已经在位：画法变了（切了视图/增删了行）就换分支，没变只对齐数据
          inst.query?.sync()
        }
        if (inst.query && inst.query.root.parentElement !== slot) slot.appendChild(inst.query.root)
        if (inst.area.root.parentElement !== slot) slot.appendChild(inst.area.root)
      }
    }
    /**
     * 收掉「这一屏已经不该有它」的实例。判据是**它还是不是这次的段根**，不是「这一轮有没有见到」：
     * 虚拟化的窗口之外那些段这一轮确实没见到，但它们是同一屏的其余部分——滚回去还要用同一个
     * 实例（否则每滚一下 tab 的激活项与撤销栈都重置一次）。
     *
     * 摘掉＝退订＋卸事件（游离容器不该继续被重画）；活动编辑器若正指着它，退回正文
     * ——键位走命令层，认的是 `ed`，指着一个已卸事件的编辑器会把按键静默丢掉。
     */
    for (const [id, inst] of mountInstances) {
      if (roots.some((r) => r.id === id)) continue
      for (const ed of [inst.area.blockEditor, inst.query ? inst.query.editor : null]) {
        if (ed && deps.getEd() === ed) deps.setEd(deps.getMainEd())
      }
      inst.query?.dispose()
      inst.query?.root.remove()
      inst.area.dispose()
      inst.area.root.remove()
      mountInstances.delete(id)
    }
  }

  renderMounts()

  return { renderMounts, renderProperties, scheduleProperties, pickRefValue }
}
