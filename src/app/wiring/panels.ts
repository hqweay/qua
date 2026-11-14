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
  choiceDisplayLabel,
  choicesFor,
  COLOR_PROP,
  danglingOf,
  declaredFieldIds,
  applyQuickFilter,
  derivedColumns,
  derivedRecordsOf,
  derivedTemplateOf,
  displayNameOf,
  EMPTY_QUICK_FILTER,
  SELF,
  hasQueryBody,
  hasChildrenViewBody,
  findInForest,
  ICON_PROP,
  isJournal,
  isViewRoot,
  journalDate,
  mountHostOf,
  mountViewKey,
  derivedTabId,
  normalizeAlias,
  parentsOf,
  prop,
  propDisplayLabels,
  propKindOf,
  propLabel,
  queryFieldsOf,
  readMountView,
  todayISO,
  type Block,
  type ClickMods,
  type DerivedSource,
  type DerivedViewKind,
  type MountEntry,
  type PropKind,
  type QueryContext,
  type QuickFilterState,
  type ViewBindingRef,
  type ViewOwnerRef,
  type ViewSurface,
} from '../../core/index.ts'
import type { PropCreateMode, PropTarget } from '../../core/infra/ports.ts'
import { t } from '../../core/infra/msg.ts'
import type { RefClickHit, RefClickMods } from '../../view/editor/editor-events.ts'
import type { App, Registry } from '../../core/commands/index.ts'
import type { MemoryKb } from '../../core/kb/memory.ts'
import type { Tx } from '../../core/kb/types.ts'
import type { BlockStore } from '../../core/model/store.ts'
import type { Prefs, Workspace } from '../../core/infra/workspace.ts'
import type { Layers, Row } from '../../ui/overlay/layers.ts'
import { openIconPicker } from '../../ui/overlay/icon-picker.ts'
import { openChoicePicker } from '../choice-picker.ts'
import { createNameChoice, openNameChoice, openTagChoice } from '../retrieval/name-choice.ts'
import { BUILTIN_LABEL, MountArea, type ViewBodyHost } from '../../ui/chrome/mount-area.ts'
import { PropertiesPanel, type PropertiesDeps } from '../../ui/block-ui/properties.ts'
import type { DerivedMode } from '../../ui/query/query-view.ts'
import { createViewHostEls, openQueryTreeFor, ViewHost } from '../../ui/query/query-view.ts'

import type { Chrome } from '../../ui/chrome/chrome.ts'
import type { BlockEditor } from '../../view/editor/editor.ts'
import { editorRun } from '../../view/editor/editor-run.ts'
import { renderNamePrompt } from '../../ui/overlay/panels.ts'
import type { OwnerStore } from './owners.ts'

export type PanelsDeps = {
  blocks: BlockStore
  kb: MemoryKb
  layers: Layers
  /** 视图配置的唯一接缝（`ViewOwnerStore`） */
  owners: OwnerStore
  /** 日记面板的那一组（设备状态，由装配层从 prefs 取） */
  journalMounts: () => readonly MountEntry[]
  /** 设备状态（派生栏的看法住这里；**不是**库内容） */
  prefs: () => Prefs
  /** 设备状态变了要落盘（`qua.device`，与库那条队列分开） */
  scheduleDeviceSave: () => void
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
  wireEditor: (editor: BlockEditor, change: (kind: string) => void, via: string, inlineViewBodies?: boolean) => void
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
  /** 打开一个块：落点由装配层的唯一路由分流（中心／右槽／新 tab） */
  openBlock: (blockId: string, place?: import('../../core/index.ts').OpenAction) => void
  /**
   * **把一块的正文投影进一个容器**（run/marks/引用/图片都在）。
   *
   * 由装配层注入：表格标题列要画的是**块的样子**，而「引用现在叫什么、图在哪」
   * 只有持有读门面的那一层答得出来。`ui` 自己拼一份投影就会长出第二套 run 渲染。
   */
  project: (block: Block, into: HTMLElement) => void
  /** 点标题里的一枚非引用原子（图片/外链）：默认动作 / ⌥ 详情（与正文同一份） */
  atomClick?: (atom: { runId: string; kind: string; hash?: string }, el: HTMLElement, mods: ClickMods) => void
}

export function setupPanels(deps: PanelsDeps) {
  const { blocks, kb, layers, app, owners, journalMounts, shortId, run, syncSections, scheduleSave, scheduleBadge, refClick } = deps
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
  /**
   * **多值属性选值**：属性卡/表格共用的入口。
   *
   * 浮层、图标、勾选状态都在 `openChoicePicker`（一处实现）；这里只负责
   * 「按当前块解析能选的选项」＋「把写回接到调用方的 commit」。
   */
  const pickChoiceValue = (
    b: Block,
    propId: string,
    current: readonly string[],
    onPick: (next: string[]) => void,
    anchor?: DOMRect,
    trigger?: HTMLElement,
  ): void => {
    const def = kb.get(propId)
    if (!def) return
    const tagName = (id: string): string => {
      const tag = kb.get(id)
      return tag ? blockLabel(tag, (x) => kb.get(x)) : shortId(id)
    }
    openChoicePicker({
      layers,
      def,
      choices: choicesFor(b, propId, kb.roots()),
      current,
      ...(trigger ? { trigger } : {}),
      anchor: anchor ?? deps.getEd().caretRect(),
      labelOf: (c) => choiceDisplayLabel(c, def, tagName),
      onPick: (next) => onPick(Array.isArray(next) ? next : [next]),
    })
  }

  const pickRefValue = (
    owner: Block | undefined,
    _propId: string,
    current: string,
    onPick: (targetId: string) => void,
    anchor?: DOMRect,
    trigger?: HTMLElement,
    opts?: { rootBlock?: boolean },
  ): void => {
    /**
     * 「根块」是条件值位上的一枚虚拟块：它不在森林里，求值时由 `selfId` 解析成宿主。
     * 只在条件树要它（`rootBlock`）—— 属性区给某个块挑引用目标时，没有「随位置变化」这回事。
     * 与真实块同列、同搜索、同勾选，用户不必知道内部那个记号。
     * 它不是候选目录的行（目录只管森林里的块），所以每次查询都由这里前置。
     */
    const rootRow = (): Row[] =>
      opts?.rootBlock
        ? [
            {
              id: `ref/${SELF}`,
              label: t('ui.query.rootBlock'),
              hint: t('ui.query.rootBlockHint'),
              icon: 'lucide:square',
              // 不给 group：置顶的一行不需要分组标题，看起来就是候选里的第一块
              keyHint: current === SELF ? t('ui.props.refCurrent') : undefined,
            },
          ]
        : []
    const choice = createNameChoice(kb.roots(), {
      kind: 'ref',
      // 自己不能指向自己：那会造出一个立刻成环的引用
      ...(owner ? { excludeIds: [owner.id] } : {}),
      currentId: current,
    })
    layers.openMenu({
      rows: [...rootRow(), ...choice.rows('')],
      anchor: anchor ?? deps.getEd().caretRect(),
      // 同一颗值按钮再点一次＝收起（toggle）
      ...(trigger ? { trigger } : {}),
      title: t('ui.props.pickRef'),
      searchable: true,
      focusSearch: true,
      emptyText: t('ui.props.refEmpty'),
      onQuery: (q) => layers.setRows([...rootRow(), ...choice.rows(q)]),
      onPick: (row) => {
        const id = String(row.id).slice('ref/'.length)
        onPick(id)
        // 选择器关掉之后属性区要立刻显示新值（不等下一次 store 通知）
        scheduleProperties()
      },
    })
  }

  /**
   * 查询条件里的标签值：候选是库里已有的标签，按地址／别名可搜。
   * `allowCreate:false` —— 配条件是一次读操作，不该顺手往库里建标签，
   * 更不该让一条刚选完的条件查出空集。
   */
  const pickTagValue = (
    _current: string,
    onPick: (tagId: string) => void,
    anchor?: DOMRect,
    trigger?: HTMLElement,
  ): void => {
    openTagChoice({
      layers,
      forest: kb.roots(),
      anchor: anchor ?? null,
      ...(trigger ? { trigger } : {}),
      title: t('ui.query.pickTagTitle'),
      emptyText: t('ui.query.pickTagEmpty'),
      allowCreate: false,
      idPrefix: 'qtag',
      onPick: (pick) => {
        // 关掉「新建」后只可能选到已有标签；写回**标签块 id**（条件按 id 存，改名不影响语义）
        if (pick.kind === 'tag') onPick(pick.id)
      },
    })
  }

  /** 条件按**标签块 id**存：显示名现解析；'' ＝ 解析不到（标签删了），树那行说「已不存在，重新选」 */
  const tagLabel = (id: string): string => {
    const b = kb.get(id)
    return b ? displayNameOf(b).trim() : ''
  }

  /**
   * **图标选择器**（网格浮层，`ui/overlay/icon-picker.ts`）：矢量全量目录 ＋ ⊘ ＋
   * 最近使用 ＋ 手动源。选中即记账（`recentIcons`，设备态不入 KB）——
   * 「再用一次」的名单跟着这台机器走。
   */
  const pickIconValue = (anchor: DOMRect, current: string, onPick: (icon: string) => void, trigger?: HTMLElement): void => {
    openIconPicker({
      layers,
      anchor,
      ...(trigger ? { trigger } : {}),
      current,
      recent: deps.prefs().recentIcons,
      onPick: (value) => {
        onPick(value)
        // 摘键不进「最近使用」（它不是用了一个图标，是没有）
        if (value !== '') {
          const prev = deps.prefs().recentIcons ?? []
          deps.prefs().recentIcons = [value, ...prev.filter((n) => n !== value)].slice(0, 24)
          deps.scheduleDeviceSave()
        }
      },
    })
  }

  /**
   * **「图标＋颜色」选择器**（标签配置头／页属性面板的入口）：色与脸两条轴一次只动一条。
   * 写走命令面（`set-icon`／`set-color`），撤销与落盘都在那条路上；
   * 写完由调用方的 `onDone` 刷自己的面板（命令路径不自动重画宿主）。
   */
  const pickFace = (b: Block, anchor: DOMRect, trigger?: HTMLElement, onDone?: () => void): void => {
    const registry = deps.getRegistry()
    const done = (): void => onDone?.()
    openIconPicker({
      layers,
      anchor,
      ...(trigger ? { trigger } : {}),
      current: prop<string>(b, ICON_PROP) ?? '',
      color: prop<string>(b, COLOR_PROP) ?? '',
      recent: deps.prefs().recentIcons,
      onPick: (value) => {
        void registry.invoke('core.block/set-icon', { blockId: b.id, icon: value }, 'ui')
        if (value !== '') {
          const prev = deps.prefs().recentIcons ?? []
          deps.prefs().recentIcons = [value, ...prev.filter((n) => n !== value)].slice(0, 24)
          deps.scheduleDeviceSave()
        }
        done()
      },
      onColor: (color) => {
        void registry.invoke('core.block/set-color', { blockId: b.id, color }, 'ui')
        done()
      },
    })
  }

  /**
   * 新建属性定义，并按 `target` 挂到这一块上。
   *
   * `select` 是唯一「建完还必须再填东西」的类型（没有选项就是空下拉）：
   * **新建**后把用户带到它的定义页，那里就是选项编辑器。复用已有定义不跳 ——
   * 用户还在原来那一块上，而且那条定义已经有选项。
   */
  const createDef = (b: Block, label: string, kind: PropKind, target: PropTarget, mode?: PropCreateMode): void => {
    const name = normalizeAlias(label)
    const existed = kb.propDefs().some((d) => normalizeAlias(propLabel(d)) === name && propKindOf(d) === kind)
    const before = new Set(kb.propDefs().map((d) => d.id))
    void deps
      .getRegistry()
      .invoke('core.props/create-def', { blockId: b.id, label, kind, target, ...(mode ? { mode } : {}) }, 'ui')
    if (kind !== 'select') return
    if (mode !== 'new' && existed) return
    const defs = kb.propDefs()
    // 同名两义时「找到的」必须是**这一次新建的那一个**：按 id 集合比，不按名字猜
    const def = defs.find((d) => !before.has(d.id) && normalizeAlias(propLabel(d)) === name)
    if (!def) return
    void deps.getRegistry().invoke('core.block/focus-block', { blockId: def.id }, 'ui')
  }

  /**
   * 属性面板的**读写回调只做一份**：检视卡与属性抽屉是同一份内容的两个宿主
   * （一个跟焦点、常驻右槽；一个显式点出、钉在打开时那块上）。
   * 宿主之间只差两件事：`target`（画哪一块）与 `repaint`（写入后刷哪一个实例）。
   */
  const makePropertiesDeps = (target: () => Block | null | undefined, repaint: () => void): PropertiesDeps => ({
    target,
    rows: (b) => [...kb.fieldsOf(b.id)],
    // 标签（分类归属）与标签属性（字段声明）是两件事：这一行走 `props._tags`
    tags: (b) => [...kb.tagsOf(b.id)],
    // 归属（filed-under）：任何块都有这一行；跨类的那条边只在这里看得见
    belongsTo: (b) => parentsOf(b, adj()),
    belongsDangling: (b) => danglingOf(b, adj()),
    /**
     * **「选一个归属」浮层**：候选＝页＋标签（`kind:'pageOrTag'`），只选已有——
     * 配归属不该顺手造身份。已挂的上级不再出现在候选里。
     * 手打名字的入口随它退场：候选里没有的名字本来也加不上，省掉一句「找不到」。
     */
    pickBelong: (b, anchor, trigger) => {
      openNameChoice({
        layers,
        forest: kb.roots(),
        kind: 'pageOrTag',
        allowCreate: false,
        excludeIds: parentsOf(b, adj()).map((p) => p.id),
        anchor,
        trigger,
        title: t('ui.belongs.pickTitle'),
        emptyText: t('ui.belongs.pickEmpty'),
        idPrefix: 'propbelong',
        onPick: (pick) => {
          if (pick.kind !== 'block') return
          void deps.getRegistry().invoke('core.belongs-to/add', { childId: b.id, parentId: pick.id }, 'ui')
          repaint()
        },
      })
    },
    removeBelong: (b, parentId) => {
      void deps.getRegistry().invoke('core.belongs-to/remove', { childId: b.id, parentId }, 'ui')
      repaint()
    },
    pruneBelongs: (b) => {
      void deps.getRegistry().invoke('core.belongs-to/prune', { childId: b.id }, 'ui')
      repaint()
    },
    // 挂/摘之后**面板自己重画**：这一行显示的就是刚改的那份 `_tags`，
    // 等下一次选区变化才刷会让「加完没反应」
    /**
     * **「选一个标签」浮层**（与查询条件值位同一个手势）：可搜可新建，
     * 新建与选中走同一条写路径（`core.tags/add` 自己处理复用同名页／新建标签块）。
     * 已挂的不重复出现在候选里。
     */
    pickTag: (b, anchor, trigger) => {
      openTagChoice({
        layers,
        forest: kb.roots(),
        anchor,
        trigger,
        title: t('ui.props.pickTagTitle'),
        emptyText: t('ui.props.pickTagEmpty'),
        selectedIds: kb.tagsOf(b.id).map((x) => x.id),
        idPrefix: 'proptag',
        onPick: (pick) => {
          void deps.getRegistry().invoke('core.tags/add', { blockId: b.id, name: pick.name }, 'ui')
          repaint()
        },
      })
    },
    removeTag: (b, tagId) => {
      void deps.getRegistry().invoke('core.tags/remove', { blockId: b.id, tagId }, 'ui')
      repaint()
    },
      // 属性区里的标签名也是「指向标签块的一处露面」，与正文 chip 同一条口径
      openRef: (to, mods) => refClick({ to }, { ...mods, altKey: false }),
      defs: () => [...kb.propDefs()],
      shortId: (id) => shortId(id),
      setValue: (b, propId, value) => void deps.getRegistry().invoke('core.props/set-value', { blockId: b.id, propId, value }, 'ui'),
      clearValue: (b, propId) => void deps.getRegistry().invoke('core.props/clear-value', { blockId: b.id, propId }, 'ui'),
      // ⚠️ 两个去处显式声明（`target`），不按块类型猜：标签块既要有自己的值、又要声明给成员
      addOwnProp: (b, propId) =>
        void deps.getRegistry().invoke('core.props/add-field', { blockId: b.id, propId, target: 'own' }, 'ui'),
      createOwnDef: (b, label, kind, mode) => createDef(b, label, kind, 'own', mode),
      declareProp: (b, propId) =>
        void deps.getRegistry().invoke('core.props/add-field', { blockId: b.id, propId, target: 'declared' }, 'ui'),
      createDeclaredDef: (b, label, kind, mode) => createDef(b, label, kind, 'declared', mode),
      declaredFields: (b) => [...kb.declaredFieldsOf(b.id)],
      undeclareField: (b, propId) => void deps.getRegistry().invoke('core.props/undeclare', { blockId: b.id, propId }, 'ui'),
      /**
       * **`ref` 值的选择器**（实现见上面的 `pickRefValue`）：从整片森林里挑一块。
       * 属性区与行内实例浮层共用同一份，候选集合不会分叉。
       */
      pickRef: pickRefValue,
      /** 多值 select：整份数组写回（每次勾选一次撤销） */
      pickChoice: (b, propId, current, onPick, anchor, trigger) => pickChoiceValue(b, propId, current, onPick, anchor, trigger),
      /** 选项图标：同一份 catalog 现画成网格（可搜索、⊘、最近使用） */
      pickIcon: pickIconValue,
      /** 页的脸（图标＋颜色）：写走命令面，写完回来刷这张卡 */
      pickFace: (b, anchor, trigger) => pickFace(b, anchor, trigger, repaint),
      refLabel: (targetId) => {
        const b = kb.get(targetId)
        if (!b) return t('ui.props.refMissing', { id: shortId(targetId) })
        const name = displayNameOf(b).trim()
        return name === '' ? shortId(b.id) : name
      },
      toast: (text, kind) => app.toast(text, kind),
      /**
       * 选项作用域徽标里的 `#名`：一次 O(1) 的索引读，UI 不扫森林。
       */
      tagName: (id) => {
        const b = kb.get(id)
        return b ? displayNameOf(b) : id.slice(-6)
      },
      blockById: (id) => kb.get(id),
      allTags: () => [...kb.tags()],
      // 显示名一次算好（同名属性带来源、仍重名带短 id）：UI 不逐行扫森林
      propLabels: () => propDisplayLabels(kb.roots()),
      fieldDeclarations: () => {
        const map = new Map<string, Block[]>()
        for (const tag of kb.tags()) {
          for (const propId of declaredFieldIds(tag)) {
            const list = map.get(propId)
            if (list) list.push(tag)
            else map.set(propId, [tag])
          }
        }
        return map
      },
      choices: {
        add: (defId, label, scope) => void deps.getRegistry().invoke('core.props/add-choice', { defId, label, scope }, 'ui'),
        setLabel: (choiceId, label) =>
          void deps.getRegistry().invoke('core.props/set-choice-label', { choiceId, label }, 'ui'),
        move: (defId, choiceId, beforeId) =>
          void deps.getRegistry().invoke('core.props/move-choice', { defId, choiceId, beforeId }, 'ui'),
        setScope: (choiceId, scope) =>
          void deps.getRegistry().invoke('core.props/set-choice-scope', { choiceId, scope }, 'ui'),
        setIcon: (choiceId, icon) =>
          void deps.getRegistry().invoke('core.props/set-choice-icon', { choiceId, icon }, 'ui'),
        setCheck: (defId, spec) =>
          void deps
            .getRegistry()
            .invoke(
              'core.props/set-choice-check',
              { defId, on: spec?.on ?? '', off: spec?.off ?? '', status: spec?.status ?? false },
              'ui',
            ),
        setCardinality: (defId, cardinality) =>
          void deps.getRegistry().invoke('core.props/set-choice-cardinality', { defId, cardinality }, 'ui'),
        setUiPosition: (defId, position) =>
          void deps.getRegistry().invoke('core.props/set-ui-position', { defId, position }, 'ui'),
        remove: (choiceId) => void deps.getRegistry().invoke('core.props/delete-choice', { choiceId }, 'ui'),
      },
  })

  const propertiesPanel = new PropertiesPanel(
    {
      root: inspectCard,
      title: chrome.inspectCardTitleEl,
      body: chrome.propertiesBodyEl,
      add: chrome.propertiesAddEl,
    },
    makePropertiesDeps(() => subject(), () => propertiesPanel.render()),
  )

  /* ------------------------------------------------------------ 属性抽屉 */

  /**
   * **属性抽屉**：显式点出的任务面，宿主是 `layers.openDrawer`（整高右滑，看完即走）。
   *
   * 与检视卡共用同一份 `PropertiesPanel` 与写入回调（上面 `makePropertiesDeps`），
   * 差别只在主体与生命周期：检视卡画「这一屏是谁」（跟焦点换内容）；
   * 抽屉**钉在打开时那一块上**——不跟焦点、不换中心、不动槽（这正是它与
   * 「看属性＝开右槽」旧口径的分界）。
   *
   * ⚠️ 抽屉抬头已经写着「是谁」：面板的 title 槽给一个空元素占位（面板不写它）。
   * ⚠️ 钉住的块被删 ⇒ 整张抽屉关掉（`renderDrawer` 的判据），不留一个空壳。
   */
  let drawerBlockId: string | null = null
  let drawerPanel: PropertiesPanel | null = null
  /** 抽屉的根元素，跟着 `drawerPanel` 一起生灭；已开着时供 `focusPropRow` 定位 */
  let drawerRootEl: HTMLElement | null = null
  /** 抽屉当前聚焦的属性栏（带 `focusPropId` 的入口喂进来）；「同一栏再点一次＝收起」靠它判 */
  let drawerFocusPropId: string | null = null

  /** 库一变就跟着刷（与检视卡同一条通知、同鲜度）；抽屉已被关掉就顺手清状态 */
  function renderDrawer(): void {
    if (!layers.drawerOpen()) {
      drawerPanel = null
      drawerBlockId = null
      drawerRootEl = null
      drawerFocusPropId = null
      return
    }
    if (!drawerPanel) return
    const b = drawerBlockId ? findInForest(deps.getWs().blocks, drawerBlockId) : undefined
    if (!b) {
      layers.closeDrawer()
      drawerPanel = null
      drawerBlockId = null
      drawerRootEl = null
      drawerFocusPropId = null
      return
    }
    drawerPanel.render()
  }

  /**
   * **把焦点送到抽屉里的某一栏**：点块下属性行的值 ⇒ 打开的就是那一栏。
   *
   * ⚠️ 必须在抽屉**已经挂进文档**之后调用：`openDrawer` 先 render 再挂载，
   *    render 里对游离节点 `focus()` 是空操作（与浮层同一条坑）。
   */
  function focusPropRow(root: HTMLElement, propId: string): void {
    const row = root.querySelector<HTMLElement>(`.prop-row[data-prop-id="${propId}"]`)
    if (!row) return
    row.scrollIntoView({ block: 'nearest' })
    row.querySelector<HTMLElement>('input, select, textarea, button')?.focus()
  }

  const openPropertiesDrawer = (blockId: string, focusPropId?: string): void => {
    const b = findInForest(deps.getWs().blocks, blockId)
    if (!b) return
    /**
     * **同一块上再点一次＝收起**（toggle）：入口按钮就是这张抽屉的开关，
     * 「点了没反应」（先关再开同内容）在用户眼里等于坏了。另一块＝换内容。
     * 带 `focusPropId` 的入口同样 toggle，判的是**栏**：同一栏再点一次＝收起，
     * 另一栏＝把焦点挪过去——入口按钮就是开关，这条判据与不带栏的入口同一条。
     */
    if (drawerBlockId === blockId && layers.drawerOpen() && (!focusPropId || drawerFocusPropId === focusPropId)) {
      layers.closeDrawer()
      drawerBlockId = null
      drawerPanel = null
      drawerRootEl = null
      drawerFocusPropId = null
      return
    }
    /**
     * **抽屉已经开着同一块 ⇒ 不重建，只把焦点送到那一栏**。
     * `openDrawer` 是先关再开：对已开着的抽屉重建一遍，等于每次点值都让面板
     * 拆掉重滑进来一次——内容没变，用户看到的却是一闪。
     */
    if (focusPropId && drawerBlockId === blockId && layers.drawerOpen() && drawerRootEl) {
      focusPropRow(drawerRootEl, focusPropId)
      drawerFocusPropId = focusPropId
      return
    }
    drawerBlockId = blockId
    drawerFocusPropId = focusPropId ?? null
    layers.openDrawer(blockLabel(b, (id) => kb.get(id)), (host) => {
      const root = document.createElement('div')
      root.className = 'props-drawer'
      const titleEl = document.createElement('span')
      titleEl.className = 'props-drawer-title'
      const body = document.createElement('div')
      body.className = 'properties-body'
      const add = document.createElement('button')
      add.type = 'button'
      add.className = 'props-add'
      root.append(titleEl, body, add)
      const panel = new PropertiesPanel(
        { root, title: titleEl, body, add },
        makePropertiesDeps(
          () => (drawerBlockId ? findInForest(deps.getWs().blocks, drawerBlockId) : null),
          () => panel.render(),
        ),
      )
      drawerPanel = panel
      drawerRootEl = root
      host.appendChild(root)
      panel.render()
    })
    // 抽屉此时已挂进文档（`openDrawer` 同步 append），焦点才落得住
    if (focusPropId && drawerRootEl) focusPropRow(drawerRootEl, focusPropId)
  }

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
      renderDrawer()
    }, 60)
  }

  /**
   * 卡片标题＝**当前对象的名字**（journal 用日期投影，与面包屑同一口径）。
   *
   * 为什么标题交给卡而不是「块属性」四个字：这张卡要回答的是「现在在改**谁**」。
   * 名字写在卡的抬头，换主体时**标题变、卡不动** —— 位置稳定，用户不用重新认路。
   */
  function renderInspectTitle(b: Block | null): void {
    chrome.inspectCardTitleEl.textContent = b ? blockLabel(b, (id) => kb.get(id)) : ''
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
   *   · **查询块／收藏块的结果视图**：被打开的那一个自己就是段根 ⇒ 那一段的槽里先放它的结果，
   *     再放挂载区。
   *
   * 日记流里**只有今天展开**：更早的天是一行摘要（`MountArea` 初始 `expanded`）。
   */
  type MountInstance = { area: MountArea; view: ViewHost | null; viewHostId: string }
  const mountInstances = new Map<string, MountInstance>()
  /**
   * **右槽挂载区卡的那一台**（单例：宿主是当前对象，卡跟着它换）。
   * 中心段尾的设备状态类改动（看法/分组/增删栏）也要让它跟上——两个表面读的是同一格。
   */
  let dockMountArea: MountArea | null = null

  /** 这一段该不该默认展开：日记只展开今天（「今天 = 你要写的那一天」） */
  const expandedFor = (host: Block): boolean => (isJournal(host) ? journalDate(host) === todayISO() : true)

  /**
   * **求值的上下文**（`$self` 指谁、结果剔除谁）。
   *
   * 三条规则写在一处，因为它们曾经被塞进同一个 `selfId`：
   *   · 查询块自己**不进**自己的结果（一张「所有任务」的表不该把自己算进去）；
   *   · 挂载宿主**不进**结果（那是位置的性质，不是条件的性质）；
   *   · `$self` 指查询块**所在的容器**，不是它自己（查询块通常是个叶子）。
   */
  const contextFor = (ownerBlockId: string): QueryContext => {
    const container = kb.parentOf(ownerBlockId)
    return {
      selfId: container?.id,
      excludeIds: [ownerBlockId],
    }
  }

  /** 挂载区里一栏的上下文：宿主就是 `$self` */
  const tabContextFor = (host: Block, targetId?: string): QueryContext => ({
    selfId: host.id,
    excludeIds: targetId ? [host.id, targetId] : [host.id],
  })

  /**
   * **露面（投影）的上下文**：锚在**露面块所在的容器**，结果里剔除露面块自己与源块。
   *
   * 与「这一块自己」和「挂载栏的宿主」都不同，理由只有一条：露面的位置是**这一次露面**
   * 给的 —— 同一个查询块投影到另一页，「本页的待办」就该是那一页的待办（这也是
   * 「把查询块当模板用」的全部实现）。剔除露面块自己是为了不让投影出现在自己的结果里。
   *
   * ⚠️ 镜像（children 源）不走这里：那棵子树没有 `$self` 可言。
   */
  const embedContextFor = (hostId: string, targetId: string): QueryContext => {
    const container = kb.parentOf(hostId)
    return { selfId: container?.id, excludeIds: [hostId, targetId] }
  }

  /**
   * **这一段要不要建视图宿主**。
   *
   * 判据按**源**分：只有 children/items 源的视图根（收藏块、激活了某张视图的块）
   * 才走段尾宿主。**身体画在自己行下的块不建**（`rowHasInlineViewBody`：查询源、
   * children 源激活视图——与侧槽窗口宿主的排除口径同一条）——段尾再来一台
   * 就是同一块挂两台。
   * 收藏块即使没有 `_activeView` 也要建 —— 它的默认看法是列表，不画出来
   * 用户就只看到一行摘要，而 `_items` 里的东西一个都看不见。
   */
  const wantsView = (host: Block): boolean =>
    isViewRoot(host) && !hasQueryBody(host) && !hasChildrenViewBody(host)

  /** 一个拥有者「显示的是哪一块」（center 表面：拥有者就是这一块） */
  const blockOf = (owner: ViewOwnerRef): Block | undefined => (owner.kind === 'block' ? blocks.find(owner.blockId) : undefined)

  function createView(
    owner: ViewOwnerRef,
    host: Block,
    binding?: ViewBindingRef,
    derived?: DerivedMode,
    opts?: {
      /** 表面只影响几何/抬头去重，不拥有配置（`inline`＝正文里查询块自己那一格） */
      surface?: ViewSurface
      /** 写事务的 source：内联体的编辑要用**拥有这一行的那台编辑器**（撤销/重画才对得上） */
      source?: () => BlockEditor | undefined
      /** 名字画到哪（只有投影给：块标那一行；见 `ViewHostDeps.titleInto`） */
      titleInto?: HTMLElement
    },
  ): ViewHost {
    const hostId = host.id
    const ownerBlock = blockOf(owner)
    const vh = new ViewHost(createViewHostEls(), {
      store: blocks,
      write: editorRun(run, () => opts?.source?.() ?? edOfMount(hostId)),
      kb,
      owners,
      owner,
      ...(binding ? { binding } : {}),
      ...(derived ? { derived } : {}),
      host: () => blocks.find(hostId) ?? host,
      /**
       * 求值上下文按**拥有者**分：
       *   · tab 拥有者（local）是挂载表面 ⇒ `$self`＝**宿主块自己**；
       *     顶层宿主（日记的天、顶层页）也能当 `$self`，方向条件自己决定往下看多少。
       *   · 块拥有者（center 查询块）`$self` 指它所在的容器：查询块住在哪一页，
       *     `{up:{is:$self}}` 就是那一页之下；顶层没有容器 ⇒ `$self` 不可用（无条件即整库）。
       */
      context:
        binding?.kind === 'embed'
          ? embedContextFor(binding.blockId, hostId)
          : owner.kind === 'tab'
            ? tabContextFor(host, ownerBlock?.id)
            : contextFor(ownerBlock?.id ?? hostId),
      surface: opts?.surface ?? (owner.kind === 'tab' ? 'mount' : 'center'),
      ...(opts?.titleInto ? { titleInto: opts.titleInto } : {}),
      onChange: () => {
        syncSections()
        scheduleSave()
        scheduleBadge()
      },
      onFocus: (editor) => deps.setEd(editor),
      wire: (editor, change) => deps.wireEditor(editor, change, 'query'),
      toast: (text, kind) => app.toast(text, kind),
      invoke: (name, args) => void deps.getRegistry().invoke(name, args, 'queryview'),
      // 视图切换是下拉：贴着按钮弹「视图…」菜单（行仍由装配层现画）
      openViewMenu: (owner, anchor, trigger) => app.openViewMenu(owner, anchor, trigger),
      openSlice: (owner, viewId, anchor) => app.openViewSlice(owner, viewId, anchor),
      project: (b, into) => deps.project(b, into),
      refClick: (hit, el, mods) => deps.refClick(hit, mods, el),
      ...(deps.atomClick ? { onAtomClick: (atom, el, mods) => deps.atomClick!(atom, el, mods) } : {}),
      openBlock: (id, place) => deps.openBlock(id, place),
      pickRef: (b, propId, current, onPick, anchor, trigger, opts) => pickRefValue(b, propId, current, onPick, anchor, trigger, opts),
      pickChoice: (b, propId, current, onPick, anchor, trigger) => pickChoiceValue(b, propId, current, onPick, anchor, trigger),
      pickTag: pickTagValue,
      tagLabel,
      refLabel: (id) => {
        const b = kb.get(id)
        if (!b) return t('ui.props.refMissing', { id: shortId(id) })
        const name = displayNameOf(b).trim()
        return name === '' ? shortId(b.id) : name
      },
      // 选项显示名里 `· #名` 的解析（`select` 单元格与属性区同一份口径）
      tagName: (id) => {
        const b = kb.get(id)
        return b ? displayNameOf(b) : id.slice(-6)
      },
      /**
       * 条件树的字段下拉：属性定义 ＋ **有值控件的系统槽**（`core/query-fields.ts` 一处给）。
       * 引擎属性与没有值控件的系统槽不进下拉（它们仍可由 JSON 写成）。
       */
      fields: () => queryFieldsOf(kb.roots()),
      /**
       * 看板分组列的**选项**：`select` 的选项是定义块的直接子块（顺序＝children 顺序）。
       * 其余属性没有固定值域 ⇒ 空表，列按「第一次出现」排。
       */
      choices: (propId) => {
        const def = kb.get(propId)
        if (!def) return []
        return kb.children(propId).map((c) => ({ id: c.id, label: blockLabel(c, (x) => kb.get(x)) }))
      },
      /* 日历的「今天」：由装配层钉住，别让渲染器自己 `new Date()`（截图与断言会漂） */
      today: () => todayISO(),
    })
    return vh
  }

  /**
   * **把一个块的源视图挂进一个容器**（正文行的内联体／侧槽窗口的根视图）。
   *
   * 与段尾宿主共用全部 deps：上下文仍按拥有者算（`$self` 指它的容器），
   * 配置仍住那一块；`surface` 只决定几何与抬头去重，`source` 决定写事务落在哪台编辑器。
   * 调用方负责生命周期（`ViewHost` 有订阅与自己的编辑器）：
   * 内联体在换 DOM 前 `dispose()`；窗口在拆卡时 `dispose()`。
   */
  function mountBlockView(
    block: Block,
    into: HTMLElement,
    source: () => BlockEditor | undefined,
    surface: 'inline' | 'dock',
  ): ViewHost {
    const vh = createView({ kind: 'block', blockId: block.id }, block, undefined, undefined, { surface, source })
    into.appendChild(vh.root)
    vh.mount()
    return vh
  }

  /**
   * **把一个块的结果视图挂成「一次露面的身体」**（`surface: 'embed'`）。
   *
   * 与行内体同一台 `ViewHost`、同一份 deps；差在**绑定点**：这一次露面只存
   * 「指向谁 ＋ 选了哪张看法」（`_embed`），所以拥有者仍是源块、配置仍住源块，
   * 这一层只是把「这一次的选择」作为 binding 传进去（`resolveBoundView` 解它）。
   *
   * ⚠️ 上下文按**露面块**算（`embedContextFor`），不按源块：投影的 `$self`
   *    是「放它的地方」。这是「露面」与「镜像」在语义上唯一的分界。
   */
  function mountEmbedView(
    host: Block,
    target: Block,
    into: HTMLElement,
    source: () => BlockEditor | undefined,
    titleInto?: HTMLElement,
  ): ViewHost {
    const vh = createView(
      { kind: 'block', blockId: target.id },
      target,
      { kind: 'embed', blockId: host.id },
      undefined,
      { surface: 'embed', source, ...(titleInto ? { titleInto } : {}) },
    )
    into.appendChild(vh.root)
    vh.mount()
    return vh
  }

  /**
   * 派生栏切看法：写**设备状态**（不是 `_mounts`），并重画这一栏。
   *
   * 键按宿主分开（`block:<id>:<source>` / `journal:<source>`）：换块、跨天就是另一格。
   * `outline` 是**删掉这一格**而不是写 `'outline'` —— 「没选过」与「选了默认」不是一回事。
   */
  function setDerivedKind(host: Block, source: DerivedSource, kind: DerivedViewKind): void {
    const mountHost = mountHostOf(host)
    const key = mountViewKey(mountHost, source)
    if (kind === 'outline') delete deps.prefs().mountViews[key]
    else deps.prefs().mountViews[key] = kind
    deps.scheduleDeviceSave()
    // 设备状态是一格、两个表面都读它：发起面整幅重画，另一面如果正看着同一格也要跟上
    mountInstances.get(host.id)?.area.render()
    dockMountArea?.render()
  }

  /**
   * 一台挂载区落在哪个「表面」上，差异只收在这几条里。
   *
   * 挂载区落两个表面：**中心段尾**每段一份（宿主固定、日记只有今天展开），
   * **右槽一张卡**（宿主＝当前对象，随导航换一次装载）。写路径、判据、命令全部
   * 是同一份 —— 差异若散在别处各写一遍，就是同一件事两个答案。
   */
  interface MountSurface {
    /** 这一面的宿主（段根，或右槽的当前对象） */
    host: () => Block | undefined
    /** 写事务的 source：发起写的那台编辑器（见 `editorRun` 的注释） */
    edSource: () => BlockEditor | undefined
    /** 事件表与命令的来源标记（op 归因） */
    via: string
    /** 栏内视图体的表面（几何/条件树开合状态按表面各记） */
    viewSurface: ViewSurface
    /** 块的行内结果要不要在这一面渲染（右槽窗口渲染，中心段尾不渲染） */
    inlineViewBodies: boolean
    /** 初始展开（中心：日记只有今天；右槽：恒展开） */
    expanded: boolean
    /** 建栏/物化收尾：焦点交回编辑器（⌘Z 键位认它，挂在 editorTextFocus） */
    refocus: () => void
    /** 建栏/物化收尾：这一面切到新栏（激活页签每个表面各记自己的） */
    activate: (tabId: string) => void
    /** 派生栏非大纲视图读的 chips（谁的实例谁的筛选） */
    filterOf: (source: DerivedSource) => QuickFilterState
  }

  function createMountArea(spec: MountSurface): MountArea {
    return new MountArea({
      store: blocks,
      write: editorRun(run, spec.edSource),
      kb,
      owners,
      journalMounts: () => journalMounts(),
      host: spec.host,
      onChange: () => {
        syncSections()
        scheduleSave()
        scheduleBadge()
      },
      // 焦点进挂载区 ⇒ 活动编辑器就是那一个（键位走命令层，认的是它）
      onFocus: (editor) => deps.setEd(editor),
      invoke: (name, args) => {
        void deps.getRegistry().invoke(name, args, spec.via)
      },
      // 与正文同一套事件（点引用/块标/右键菜单/`#`·`@` 补全），装配层只给这一份
      wire: (editor, change) => deps.wireEditor(editor, change, spec.via, spec.inlineViewBodies),
      onAddTab: (id) => addLocalQueryTab(id, spec),
      onMaterializeTab: (id, source, _anchor, opts) => materializeDerivedTab(id, source, opts, spec),
      // 快速筛选的弹层外壳（chips 的内容与状态都在挂载区自己手里）
      openPopover: (render, anchor, trigger) => layers.openPopover(render, anchor, undefined, trigger),
      // 大纲分支的切换下拉：与视图宿主那条同一个菜单（装配层现画行，这里只给锚点）
      derivedKind: (hostBlock, source) => {
        const mountHost = mountHostOf(hostBlock)
        return readMountView(deps.prefs().mountViews, mountHost, source)
      },
      setDerivedKind: (hostBlock, source, kind) => setDerivedKind(hostBlock, source, kind),
      derivedGroup: (hostBlock, source) => {
        const mk = mountViewKey(mountHostOf(hostBlock), source)
        return deps.prefs().mountGroups[mk] ?? ''
      },
      setDerivedGroup: (hostBlock, source, key) => {
        const mk = mountViewKey(mountHostOf(hostBlock), source)
        if (key === '') delete deps.prefs().mountGroups[mk]
        else deps.prefs().mountGroups[mk] = key
        deps.scheduleDeviceSave()
        // 设备状态是一格、两个表面都读它（与看法切换同一条）
        mountInstances.get(hostBlock.id)?.area.render()
        dockMountArea?.render()
      },
      // 看法下拉与自定义查询的「视图…」同壳（同一台浮层，行由宿主层现画）
      openDerivedViewMenu: (anchor, current, onPick) => app.openDerivedViewMenu(anchor, current, (k) => onPick(k as DerivedViewKind)),
      onRemoveTab: (mountHost, tabId) => {
        void deps.getRegistry().invoke('core.mount/remove', { host: mountHost, tabId }, spec.via)
        // 摘完当场重排：栏是模型/设备状态里的一格，DOM 不会自己知道
        renderMounts()
      },
      /**
       * **改名**：浮层贴着那一栏弹，输入框里先填当前名字（改一半能看见原样）。
       *
       * 与 `core.view/rename` 同一条形状：输入 → 命令（可撤销、落盘只有一处）→ 当场重排。
       * 空名字在 `renderNamePrompt` 里就挡住（提交按钮不响应），命令层再挡一次。
       */
      onRenameTab: (mountHost, tabId, anchor) => {
        const cur = owners.entriesOf(mountHost).find((e) => e.id === tabId)
        if (!cur || cur.kind !== 'local') return
        layers.openPopover(
          (box) =>
            renderNamePrompt(box, {
              title: t('ui.mount.rename'),
              value: cur.label,
              placeholder: t('ui.mount.newTabName'),
              submitText: t('ui.mount.renameApply'),
              cancelText: t('ui.mount.renameCancel'),
              onSubmit: (label) => {
                layers.closePopover()
                void deps.getRegistry().invoke('core.mount/rename', { host: mountHost, tabId, label }, spec.via)
                // 栏名是模型/设备状态里的一格，DOM 不会自己知道（与摘掉同一笔重排）
                renderMounts()
              },
              onCancel: () => layers.closePopover(),
            }),
          anchor,
        )
      },
      onMoveTab: (mountHost, tabId, targetId, place) => {
        void deps.getRegistry().invoke('core.mount/move', { host: mountHost, tabId, targetId, place }, spec.via)
        // 顺序是那一格数组的顺序 ⇒ 写完整排一次（与摘掉同一条重排路径）
        renderMounts()
      },
      /** 非大纲那一栏的视图体：local ⇒ 拥有者就是这一栏（配置住在它自己身上） */
      createView: (mountHostBlock, entry) => {
        const mountHost = mountHostOf(mountHostBlock)
        if (entry.kind === 'local') {
          const owner: ViewOwnerRef = { kind: 'tab', host: mountHost, tabId: entry.id }
          // 表面与写事务 source 都按这台挂载区自己的口径：右槽卡的栏体写的是卡里的编辑器
          return asBody(
            createView(owner, mountHostBlock, undefined, undefined, {
              surface: spec.viewSurface,
              source: spec.edSource,
            }),
          )
        }
        if (entry.kind === 'derived') {
          /**
           * **派生栏**：借用视图宿主的渲染器，但不给它拥有者。
           * 看法来自设备状态、数据现算、抬头与「⋯」由挂载区画（那一台不画自己的抬头）。
           */
          const kind = readMountView(deps.prefs().mountViews, mountHost, entry.source)
          if (kind === 'outline') return null
          const explainKey =
            entry.source === 'refs'
              ? 'ui.mount.why.refs'
              : entry.source === 'members'
                ? 'ui.mount.why.members'
                : entry.source === 'same'
                  ? 'ui.mount.why.same'
                  : 'ui.mount.why.mentions'
          return asBody(
            createView({ kind: 'block', blockId: mountHostBlock.id }, mountHostBlock, undefined, {
              /**
               * 列表/表格与大纲读**同一份 chips**（挂在挂载区实例上）：两处各算各的
               * 就会出现两批行。⚠️ 经**注册表**晚读、不引上面那个 `area`：
               * 挂载区的构造函数会当场画第一屏，设备状态里存着表格看法时，这条路
               * 在 `area` 还没初始化完就走进来（构造期状态必是空筛选，缺省值即真值）。
               */
              records: () =>
                applyQuickFilter(
                  derivedRecordsOf(blocks.find(mountHostBlock.id) ?? mountHostBlock, kb, entry.source),
                  spec.filterOf(entry.source),
                ),
              columns: derivedColumns(entry.source),
              // 分组键与看法同层（设备状态）；下拉由挂载区抬头画，这里只带渲染用的键
              groupBy: deps.prefs().mountGroups[mountViewKey(mountHost, entry.source)] ?? '',
              setKind: (k) => setDerivedKind(mountHostBlock, entry.source, k),
              explain: t(explainKey),
            }, { surface: spec.viewSurface, source: spec.edSource }),
          )
        }
        return null
      },
      expanded: spec.expanded,
    })
  }

  /**
   * 中心段尾的那一台：宿主固定为段根，其余差异按中心表面的口径给。
   * 右槽卡的那一台见 `createDockMountArea` —— 同一台 `createMountArea`，另一份 spec。
   */
  function createMount(host: Block): MountInstance {
    const hostId = host.id
    const area = createMountArea({
      host: () => blocks.find(hostId),
      edSource: () => mountInstances.get(hostId)?.area.blockEditor ?? undefined,
      via: 'mount',
      viewSurface: 'mount',
      inlineViewBodies: false,
      expanded: expandedFor(host),
      refocus: refocusAfterMountOp,
      activate: (tabId) => mountInstances.get(hostId)?.area.activateTab(tabId),
      filterOf: (source) => mountInstances.get(hostId)?.area.filterOf(source) ?? EMPTY_QUICK_FILTER,
    })
    const view = wantsView(host) ? createView({ kind: 'block', blockId: host.id }, host) : null
    return { area, view, viewHostId: view ? hostId : '' }
  }

  /**
   * **右槽挂载区卡的那一台**：宿主＝当前对象，随导航换一次装载（`MountArea.render`
   * 里的换段判据管状态清空）。装配早于实例创建的引用全部走惰性 getter ——
   * 构造期回调拿到的是空值（与中心实例的「构造期空筛选」同一条事实）。
   */
  function createDockMountArea(target: () => string): MountArea {
    let area: MountArea | null = null
    area = createMountArea({
      host: () => blocks.find(target()),
      edSource: () => area?.blockEditor ?? undefined,
      via: 'dock',
      viewSurface: 'dock',
      inlineViewBodies: true,
      expanded: true,
      refocus: refocusAfterMountOp,
      activate: (tabId) => area?.activateTab(tabId),
      filterOf: (source) => area?.filterOf(source) ?? EMPTY_QUICK_FILTER,
    })
    dockMountArea = area
    return area
  }

  /** 挂载区里那个编辑器（写事务的 source）。焦点切过去之后 `ed` 就是它 */
  const edOfMount = (hostId: string) => mountInstances.get(hostId)?.area.blockEditor ?? undefined

  /** 视图体（`ViewHost`）也实现 `ViewBodyHost`：`mount/sync/dispose` 都在它身上 */
  const asBody = (vh: ViewHost): ViewBodyHost => ({
    root: vh.root,
    mount: () => vh.mount(),
    sync: () => vh.sync(),
    dispose: () => vh.dispose(),
  })

  /**
   * **「＋」＝新建一栏 local 查询**：不再弹菜单。
   *
   * 面板里的查询只属于这一块：不建块、不指向块、不提升。要一份可引用／可共享的查询，
   * 写「查询块」（内容对象），那是正文里的事。只剩一个动作还留一层菜单，只是让用户多点一次。
   *
   * 条件条在栏里，点一下就地展开。名字可以后改，条件不能后猜。
   * ⚠️ **不建块**：块数不变，⌘Z 可撤（建栏与应用条件是两笔，各自可撤）。
   */
  /**
   * **「＋」的新栏在哪个表面建，激活与焦点收尾就归哪个表面**。
   * `surface` 缺省＝中心段尾的手势（挂载区自己的「＋」回调都会带上来）。
   * 激活页签每个表面各记自己的：右槽建的栏不该把中心正看着的那栏切走。
   */
  function addLocalQueryTab(hostId: string, surface?: Pick<MountSurface, 'via' | 'activate' | 'refocus'>): void {
    const host = blocks.find(hostId)
    if (!host) return
    const mountHost = mountHostOf(host)
    const before = new Set(owners.entriesOf(mountHost).map((e) => e.id))
    void deps
      .getRegistry()
      .invoke(
        'core.mount/add-local',
        { host: mountHost, label: t('ui.mount.localName'), spec: { where: { up: { is: '$self' } } } },
        surface?.via ?? 'mount',
      )
    const added = owners.entriesOf(mountHost).find((e) => !before.has(e.id))
    renderMounts()
    if (!added) return
    // 新栏当场切过去：建了不看，「点了没生效」的另一种长相
    ;(surface?.activate ?? ((tabId) => mountInstances.get(host.id)?.area.activateTab(tabId)))(added.id)
    ;(surface?.refocus ?? refocusAfterMountOp)()
  }

  /**
   * **建栏类手势收尾把焦点交回编辑器**。
   *
   * 为什么必须做：撤销的键位挂在 `editorTextFocus` 上——点过「＋」或「复制为查询栏」
   * 之后焦点留在按钮上，⌘Z 按了不进编辑器，「建栏可撤销」对用户不成立
   * （与条件树应用后的 `refocusBody` 同一条理由）。目标是**主编辑器**：键位与撤销
   * 都认它，焦点留在按钮或新栏的查询体上都不算交回去。
   */
  function refocusAfterMountOp(): void {
    deps.getMainEd().container.focus()
  }

  /**
   * **「复制为查询栏」**：把一栏内置项物化成 local 栏。
   *
   * 模板在 core 的 `derivedTemplateOf`（内置 spec ＋ 本源默认列），这里只管写与激活：
   * 建出来就是普通用户栏——条件、视图、名字都能改；内置栏本体不动，它继续现算。
   * 走 `core.mount/add-local` 命令面（带 views），不另开写路径。
   * 维度不存在时模板是 `null` ⇒ 挂载区根本没给按钮，这里兜底返回。
   * `openTree`：物化完直接把新栏的条件树摊开——手势的承诺是「改条件」，
   * 让用户再点一次摘要 chip 才够到树，等于把承诺拆成两半。
   */
  function materializeDerivedTab(
    hostId: string,
    source: DerivedSource,
    opts?: { openTree?: boolean },
    surface?: Pick<MountSurface, 'via' | 'activate' | 'refocus' | 'viewSurface'>,
  ): void {
    const host = blocks.find(hostId)
    if (!host) return
    const template = derivedTemplateOf(host, kb.roots(), source)
    if (!template) return
    const mountHost = mountHostOf(host)
    const before = new Set(owners.entriesOf(mountHost).map((e) => e.id))
    void deps
      .getRegistry()
      .invoke(
        'core.mount/add-local',
        {
          // **占用内置栏的稳定 id**：合并规则让 local 替换对应的内置栏——
          // 「改条件」是原地升级（现算 → 可编辑），不是一栏变两栏
          id: derivedTabId(source),
          host: mountHost,
          label: t(BUILTIN_LABEL[source]),
          spec: template.spec,
          views: template.views,
          // 看法跟着这一栏物化前的样子走：原是大纲（缺省）就不给激活视图，
          // 缺省落回大纲——点条件句是来改条件的，不该顺手被换成表格；
          // 本源的派生列仍在视图列表里，要表格随时切得回来
          view:
            readMountView(deps.prefs().mountViews, mountHost, source) === 'table'
              ? (template.views[0]?.id ?? '')
              : '',
        },
        surface?.via ?? 'mount',
      )
    const added = owners.entriesOf(mountHost).find((e) => !before.has(e.id))
    renderMounts()
    if (!added) return
    // 新栏当场切过去：建了不看，「点了没生效」的另一种长相。激活项归发起面（与「＋」同一条）
    ;(surface?.activate ?? ((tabId) => mountInstances.get(hostId)?.area.activateTab(tabId)))(added.id)
    if (opts?.openTree === true) {
      // 条件树的开合状态按表面各记：发起面的树摊开，另一面不该跟着动
      openQueryTreeFor({ kind: 'tab', host: mountHost, tabId: added.id }, surface?.viewSurface ?? 'mount')
    }
    ;(surface?.refocus ?? refocusAfterMountOp)()
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
    if (allow) {
      /**
       * ⚠️ **只认正文自己的段**（`:scope > .sec`）。
       *
       * 裸 `.sec` 会扫进**嵌套编辑岛**里的段：投影抬头那台编辑器、挂载区、查询结果
       * 都嵌在 `#editor` 里，它们也各自有 `.sec`，而 `data-sec` 是同一套块 id。
       * 于是「聚焦一个露面块／它的源块」时，这一段会被当成正文的段，把**段尾挂载区
       * 搬进它自己的身体里** ⇒ `appendChild` 抛「新子节点包含父节点」，整屏只画一半。
       *
       * 正文的段永远是 `container` 的直接子节点（`renderRows` 只 append 到 container）；
       * 岛里的段隔着 `.mount-editor`／`.queryview-editor` 等宿主，不会命中这一条。
       */
      for (const sec of mainEd.container.querySelectorAll<HTMLElement>(':scope > .sec')) {
        const hostId = sec.dataset.sec ?? ''
        if (hostId === '') continue
        const slot = sec.querySelector<HTMLElement>(':scope > .sec-mount')
        if (!slot) continue
        const host = blocks.find(hostId)
        if (!host) continue
        let inst = mountInstances.get(hostId)
        if (!inst) {
          inst = createMount(host)
          mountInstances.set(hostId, inst)
          // 新实例才装载一次（之后由它自己的 store 订阅跟进）
          if (inst.view) {
            inst.viewHostId = hostId
            inst.view.mount()
          }
        } else if (inst.view && !wantsView(host)) {
          /**
           * 切回默认看法：**摘掉视图宿主**（连同它订阅的编辑器），别藏一台还在跟着 store 重画的。
           * 段尾的挂载区留着 —— 它与视图是两件事。
           */
          if (inst.view.editor && deps.getEd() === inst.view.editor) deps.setEd(deps.getMainEd())
          inst.view.dispose()
          inst.view.root.remove()
          inst.view = null
          inst.viewHostId = ''
        } else if (!inst.view && wantsView(host)) {
          inst.view = createView({ kind: 'block', blockId: host.id }, host)
          inst.viewHostId = hostId
          inst.view.mount()
        } else {
          // 已经在位：画法变了（切了视图/增删了行）就换分支，没变只对齐数据
          inst.view?.sync()
          /**
           * **重排栏条**：加/摘一栏、换它的视图、改设备状态里的日记栏，都不会经过
           * `EditableBlock` 的 store 订阅（那订阅盯的是块，而这几件事写在
           * `_mounts`／`prefs` 上）。不补这一次，用户会看到「点了加、栏没出来」。
           */
          inst.area.refreshEntries()
        }
        if (inst.view && inst.view.root.parentElement !== slot) slot.appendChild(inst.view.root)
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
      for (const ed2 of [inst.area.blockEditor, inst.view ? inst.view.editor : null]) {
        if (ed2 && deps.getEd() === ed2) deps.setEd(deps.getMainEd())
      }
      inst.view?.dispose()
      inst.view?.root.remove()
      inst.area.dispose()
      inst.area.root.remove()
      mountInstances.delete(id)
    }
    // 右槽那台也跟着对齐：增删栏/改名/换序写在 `_mounts`/设备状态上，不经过它的 store 订阅
    dockMountArea?.refreshEntries()
  }

  /**
   * **这一块的视图身体此刻有没有被某个表面画着**。
   *
   * 切视图只写拥有者的配置；屏幕跟上靠**每一台 ViewHost 自己订阅**。
   * 于是「要不要顺手把这一块打开」的判据就是这一句：没有表面在画它
   * （收藏块、children 源的激活视图只在打开时才画）⇒ 不打开就永远看不到结果。
   *
   * 判据落在 DOM 上（那台宿主的根带 `data-view-owner`），不维护「哪些块正被画着」的登记表：
   * 登记表漏一次 dispose 就会永远说「画着」，而它不报错，只表现为「切了视图没反应」。
   */
  function viewShown(blockId: string): boolean {
    if (blockId === '') return false
    return Boolean(document.querySelector(`.queryview[data-view-owner="${blockId}"]`))
  }

  // 首次装载：装配完就把每一段的挂载区放上去（之后由 loadPage / store 订阅跟进）
  renderMounts()

  return {
    renderMounts,
    createDockMountArea,
    renderProperties,
    scheduleProperties,
    pickRefValue,
    pickChoiceValue,
    pickTagValue,
    tagLabel,
    openPropertiesDrawer,
    mountBlockView,
    mountEmbedView,
    viewShown,
  }
}
