/**
 * **视图 / 查询 / 配置菜单族**：「视图…」下拉（九件全部住这里）、露面块的指针菜单、
 * 条件树弹层（唯一一份）、视图选项四轴、切片构建器、外链输入框、标签与子块属性选择器、
 * 删除标签的确认。装配层经 spread 拿到 app 那九件；`openEmbedViewMenu`/`openSpecPopover`
 * 同时被编辑器事件表直接消费。
 *
 * 兄弟方法互相**直呼**（本片内的 function 声明）；panels 的三件（pickRef/pickTag/tagLabel）
 * 与 registry、pageDeps 都晚于本片装配——闭包运行期才解引用。
 */
import { collatorLocale } from '../../core/infra/locale.ts'
import { QueryTree } from '../../ui/query/query-tree.ts'
import { ViewOptionsPanel } from '../../ui/views/view-options.ts'
import { renderLinkComposer, renderNamePrompt } from '../../ui/overlay/panels.ts'
import { openTagChoice } from '../../app/retrieval/name-choice.ts'
import { Layers, type Row } from '../../ui/overlay/layers.ts'
import {
  blockLabel,
  canonicalNode,
  cardLayoutOf,
  childDisplayProps,
  childPropsFollowOverride,
  childPropsForRefs,
  choicesOf,
  childrenRecords,
  displayNameOf,
  enginePropDefs,
  evaluateQuerySpec,
  fieldCoverageOf,
  filterOfSpec,
  hasList,
  isEmbedBlock,
  listTableOf,
  OUTLINE_VIEW,
  PAGE_COLUMN,
  passThroughRefTarget,
  propKindOf,
  propLabel,
  queryFieldsOf,
  readEmbed,
  readViewSet,
  resolveRows,
  sourceOfOwner,
  storedKindsFor,
  TAGS_COLUMN,
  defaultDisplayPropsFor,
  viewNameOf,
  VIEW_KIND_ICON,
  type CtxKeys,
  type Block,
  type DerivedSource,
  type FieldCoverage,
  type MountHost,
  type QueryNode,
  type QuerySpec,
  type ViewOwnerRef,
  systemFieldChoices,
} from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import { readAutomation, type AutomationDef, type AutomationTrigger } from '../../core/automation/automation.ts'
import { topUpOf, triggerQueryFromWhen, validateTriggerQuery, withUp } from '../../core/automation/trigger-query.ts'
import type { App } from '../../core/infra/ports.ts'
import type { BlockEditor } from '../../view/editor/editor.ts'
import type { MemoryKb } from '../../core/kb/memory.ts'
import type { OwnerStore } from '../../app/wiring/owners.ts'
import type { setupPanels } from '../../app/wiring/panels.ts'

export interface ViewMenusDeps {
  ws: import('../../core/infra/workspace.ts').Workspace
  blocks: import('../../core/model/store.ts').BlockStore
  kb: MemoryKb
  kbGet: (id: string) => Block | undefined
  owners: OwnerStore
  layers: Layers
  uiCtx: () => CtxKeys
  getEd: () => BlockEditor
  getRegistry: () => import('../../core/commands/index.ts').Registry
  /** 面板晚于本片装配：候选选择器与显示名三件走闭包 */
  getPanels: () => Pick<ReturnType<typeof setupPanels>, 'pickRefValue' | 'pickTagValue' | 'tagLabel'>
  getApp: () => App
  toast: App['toast']
  /** 短 id（uuidv7 尾段）：装配层唯一一份 */
  shortId: (id: string) => string
  blockName: (b: Block) => string
}

export function setupViewMenus(deps: ViewMenusDeps) {
  const { ws, blocks, kb, kbGet, owners, layers, uiCtx, getEd, getRegistry, getPanels, getApp, toast, shortId } = deps

/**
 * **露面的「视图…」菜单**：编辑的是**这一次露面的指针**（`_embed.view`），不是源块的配置。
 *
 * 三格直译 `core/embed.ts` 的三个取值：
 *   · **跟随源**（`''`）—— 源换默认看法，这里跟着换；菜单上写明「当前：表格」，
 *     否则它和「固定为大纲」在界面上分不出差别；
 *   · **固定为大纲**（`'outline'`）—— 源换看法时这一处不变；
 *   · **源上的某张命名视图**（视图 id）—— 要「这一次特别一点」就建一张命名视图并指过去。
 *
 * ⚠️ 露面块**没有自己的 `_views`**：写进它身上没有任何读路径会看到（`isViewRoot` 排除露面块），
 *    那就是「点了没生效」。所以同一个「视图…」入口在露面块上必须走这里。
 */
function openEmbedViewMenu(host: Block): void {
  const ref = readEmbed(host)
  const target = ref ? blocks.find(ref.block) : undefined
  if (!ref || !target) return
  const data = owners.read({ kind: 'block', blockId: target.id })
  const active = data ? readViewSet(data).active : null
  const curLabel = active ? viewNameOf(active, (k) => t(`ui.view.kind.${k}`)) : t('ui.view.outline')
  const rows: Row[] = [
    {
      id: 'embed/follow',
      label: t('ui.embed.followSource', { name: curLabel }),
      icon: 'lucide:link',
      ...(ref.view === '' ? { keyHint: t('ui.view.current') } : {}),
    },
    {
      id: 'embed/outline',
      label: t('ui.embed.pinOutline'),
      icon: 'lucide:list',
      ...(ref.view === OUTLINE_VIEW ? { keyHint: t('ui.view.current') } : {}),
    },
  ]
  for (const v of data?.views ?? []) {
    rows.push({
      id: `embed/view/${v.id}`,
      label: viewNameOf(v, (k) => t(`ui.view.kind.${k}`)),
      icon: v.kind === 'list-table' ? 'lucide:table-properties' : 'lucide:table',
      group: 'embed/views',
      ...(ref.view === v.id ? { keyHint: t('ui.view.current') } : {}),
    })
  }
  rows.push({ id: 'embed/new', label: t('ui.embed.newView'), icon: 'lucide:plus', group: 'embed/9-new' })
  rows.push({ id: 'embed/open', label: t('ui.embed.openSource'), icon: 'lucide:external-link', group: 'embed/9-new' })
  layers.openMenu({
    rows,
    anchor: getEd().blockEl(host.id)?.getBoundingClientRect() ?? null,
    title: t('menu.label.views'),
    searchable: false,
    onPick: (row) => {
      const id = String(row.id)
      if (id === 'embed/follow') void getRegistry().invoke('core.embed/set-view', { blockId: host.id, view: '' }, 'menu')
      else if (id === 'embed/outline') void getRegistry().invoke('core.embed/set-view', { blockId: host.id, view: OUTLINE_VIEW }, 'menu')
      else if (id.startsWith('embed/view/'))
        void getRegistry().invoke('core.embed/set-view', { blockId: host.id, view: id.slice('embed/view/'.length) }, 'menu')
      // 「在源上新建视图…」打开的是**源**的那一份菜单：建完它会成为源的默认看法，
      // 跟随态的露面当场跟着换；要钉住就再从本菜单选一次（一张视图只有一份配置）。
      else if (id === 'embed/new') openViewMenu({ kind: 'block', blockId: target.id })
      else if (id === 'embed/open') void getRegistry().invoke('core.block/focus-block', { blockId: target.id }, 'menu')
    },
  })
}

/**
 * **条件树弹层**（唯一一份）：基础条件（`core.query/set-spec`）与
 * 视图切片（`core.view/set-filter`）共用同一台组件，只是 `spec` 的来源与落点不同。
 */
function openSpecPopover(opts: {
  owner: ViewOwnerRef
  anchor: DOMRect | null
  spec: () => QuerySpec
  showOptions?: boolean
  onApply: (spec: QuerySpec) => void
  /**
   * 这批结果的覆盖率（字段下拉按它排序；不给／批次为空＝全量平铺，现状）。
   * `batch` 是条件树草稿里**已圈出的那批块**（未完成行已摘掉）——覆盖率跟草稿走，
   * 不跟已存储的 spec：弹层树点「应用」才落，跟存储值会让刚加的行参与不了收窄。
   */
  coverage?: (batch: QuerySpec) => FieldCoverage | undefined
  /**
   * 树上方的一句只读说明（派生栏用它写「基条件：…（只读，改不掉）」）。
   * 不是标题：标题属于「这一份条件是什么」，这句属于「树外那层是什么」。
   */
  note?: string
}): void {
  const hostId =
    opts.owner.kind === 'block'
      ? opts.owner.blockId
      : opts.owner.host.kind === 'block'
        ? opts.owner.host.blockId
        : ''
  const hostBlock = hostId === '' ? undefined : kb.get(hostId)
  layers.openPopover((box) => {
    const tree = new QueryTree(box, {
      spec: opts.spec,
      ...(opts.note ? { note: opts.note } : {}),
      // 条件树的字段候选只有一份（`core/query-fields.ts`）：属性定义 ＋ 有值控件的系统槽；
      // 有覆盖率时按「这批结果里真有值的栏」排前（与分组下拉同一条原则）
      fields: (batch) => queryFieldsOf(kb.roots(), batch ? opts.coverage?.(batch) : undefined),
      /**
       * `select` 的选项：**定义块的直接子块，全量、排除软删**。
       * 不按某一块的可选范围收窄（`choicesForDef`）—— 查询是跨块的，
       * 同一个属性在不同块上「此刻能选什么」可以不一样。
       * `_tags` 不是定义：它按标签归属分组时的「选项」＝ 全部标签块（组名用显示名）。
       */
      choices: (propId) => {
        if (propId === '_tags') return kb.tags().map((t) => ({ id: t.id, label: blockLabel(t, kbGet) }))
        // 系统槽的选项域来自字段声明（`_callout` 的动态词表、`_lang` 的静态表、`_type` 的类型注册表）
        const system = systemFieldChoices(propId, kbGet)
        if (system !== undefined) return system
        const def = kb.get(propId)
        if (!def || propKindOf(def) !== 'select') return []
        return choicesOf(def).map((c) => ({ id: c.id, label: c.label }))
      },
      ...(hostBlock ? { owner: hostBlock } : {}),
      pickRef: (b, propId, current, onPick, rect, trigger, opts) => getPanels().pickRefValue(b, propId, current, onPick, rect, trigger, opts),
      pickTag: getPanels().pickTagValue,
      tagLabel: getPanels().tagLabel,
      refLabel: (targetId) => {
        const target = kb.get(targetId)
        return target ? blockLabel(target, kbGet) : t('ui.props.refMissing', { id: shortId(targetId) })
      },
      apply: opts.onApply,
      close: () => layers.closePopover(),
      inline: false,
      ...(opts.showOptions === false ? { showOptions: false } : {}),
    })
    tree.render(true)
  }, opts.anchor)
}


function openViewMenu(owner: ViewOwnerRef, dropdownAnchor?: DOMRect | null, trigger?: HTMLElement): void {
  /**
   * **露面块不拥有视图配置**：`_embed = { block, view }` 只有一格选择。
   * 同一个「视图…」入口在露面块上编辑的是**那根指针**（跟随源／大纲／源的命名视图）——
   * 写它的 `_views` 不会被任何读路径看到（`isViewRoot` 排除露面块），那就是「点了没生效」。
   */
  if (owner.kind === 'block') {
    const embed = blocks.find(owner.blockId)
    if (embed && isEmbedBlock(embed)) {
      openEmbedViewMenu(embed)
      return
    }
  }
  const data = owners.read(owner)
  if (!data) return
  const host = owner.kind === 'block' ? blocks.find(owner.blockId) : undefined
  const source = sourceOfOwner(owner, data, host)
  const active = readViewSet(data).active
  const defaultLabel = t('ui.view.outline')
  const rows: Row[] = [
    {
      id: 'view//outline',
      label: defaultLabel,
      icon: 'lucide:list',
      ...(active ? {} : { keyHint: t('ui.view.current') }),
    },
  ]
  for (const v of data.views) {
    // 卡片的图标画「它现在长什么样」：网格／看板列；页签画它的方向
    const cardLayout = v.kind === 'cards' ? cardLayoutOf(v) : ''
    rows.push({
      id: `view//${v.id}`,
      label: viewNameOf(v, (k) => t(`ui.view.kind.${k}`)),
      icon:
        v.kind === 'list-table'
          ? 'lucide:table-properties'
          : v.kind === 'cards'
            ? cardLayout === 'columns'
              ? 'lucide:columns-3'
              : 'lucide:layout-grid'
            : v.kind === 'tabs'
              ? v.tabs?.direction === 'vertical'
                ? 'lucide:panel-left'
                : 'lucide:panel-top'
              : 'lucide:table',
      ...(v.filter ? { hint: t('ui.view.slice') } : {}),
      ...(active?.id === v.id ? { keyHint: t('ui.view.current') } : {}),
    })
  }
  /**
   * **当前视图的管理**：改名／切片／删除都住在这份菜单里。
   *
   * 不另造一个「视图设置」面板：这三件事都是那一张视图的配置，
   * 用户已经在「视图…」里看见了它，入口就该在同一处。
   */
  if (active) {
    /**
     * **卡片的封面**：两档——「有图才显示」与「无」。
     *
     * 不是新视图：画廊与块卡共用同一副身体，只差这一格配置。
     */
    if (active.kind === 'cards') {
      const cover = active.cards?.cover === 'none' ? 'none' : 'first-asset'
      for (const [value, label, icon] of [
        ['first-asset', t('ui.view.cover.first'), 'lucide:image'],
        ['none', t('ui.view.cover.none'), 'lucide:image-off'],
      ] as const) {
        rows.push({
          id: `view/cover/${value}`,
          label,
          icon,
          group: 'view/7-manage',
          ...(cover === value ? { keyHint: t('ui.view.current') } : {}),
        })
      }
    }
    /**
     * **页签的方向**：横向（缺省）／纵向。纯渲染差异 ⇒ 配置位，
     * 不是两种看法；这一组只对页签视图出现。
     */
    if (active.kind === 'tabs') {
      const current = active.tabs?.direction === 'vertical' ? 'vertical' : 'horizontal'
      for (const [value, label, icon] of [
        ['horizontal', t('ui.tabs.direction.h'), 'lucide:panel-top'],
        ['vertical', t('ui.tabs.direction.v'), 'lucide:panel-left'],
      ] as const) {
        rows.push({
          id: `view/tabs-dir/${value}`,
          label,
          icon,
          group: 'view/6-layout',
          ...(current === value ? { keyHint: t('ui.view.current') } : {}),
        })
      }
    }
    rows.push({
      id: 'view/options',
      label: t('ui.view.options'),
      icon: 'lucide:sliders-horizontal',
      group: 'view/7-manage',
    })
    rows.push({ id: 'view/rename', label: t('ui.view.rename'), icon: 'lucide:pencil', group: 'view/7-manage' })
    if (source.kind === 'query') {
      rows.push({
        id: 'view/slice',
        label: active.filter ? t('ui.view.sliceEdit') : t('ui.view.sliceAdd'),
        icon: 'lucide:filter',
        group: 'view/7-manage',
      })
      if (active.filter) {
        rows.push({ id: 'view/slice-clear', label: t('ui.view.sliceClear'), icon: 'lucide:filter-x', group: 'view/7-manage' })
      }
    }
    rows.push({ id: 'view/remove', label: t('ui.view.remove'), icon: 'lucide:trash-2', group: 'view/7-manage' })
  }
  /**
   * **结构映射表的排序**：第一行就是表头（容器的直接子块），所以排序入口按**列**列出来，
   * 名字取那一块的显示名。排序只改显示序（行＝每列各取第 j 项的位置元组），
   * `children` 顺序一个字节不动。
   */
  if (active?.kind === 'list-table' && source.kind === 'children') {
    const table = listTableOf(source.blockId, kb)
    const cur = active.listTable?.sort
    table.columns.forEach((col, i) => {
      const on = cur?.col === i ? cur.dir : ''
      const name = displayNameOf(col).trim()
      rows.push({
        id: `view/sort/${i}/${on}`,
        label:
          name === ''
            ? t('ui.view.sortByColumnN', { n: String(i + 1) })
            : t('ui.view.sortByColumn', { name }),
        icon: 'lucide:arrow-up-down',
        group: 'view/8-sort',
        ...(on ? { keyHint: on === 'desc' ? t('ui.view.sortDesc') : t('ui.view.sortAsc') } : {}),
      })
    })
  }
  /**
   * **能建哪几种**（表只有 `STORED_KINDS_BY_SOURCE` 一张）：
   * 查询源没有结构映射表与导图 —— 命中集合不是树，没有「第 k 个孩子」可对齐。
   */
  for (const kind of storedKindsFor(source)) {
    rows.push({
      id: `view/add/${kind}`,
      // 建的行一律「新建 X」：裸 kind 名读起来像「切过去」，点下去却是建——
      // 重复视图就是这么攒出来的。上方「已有视图」各叫各的名字（建时就给了默认名）。
      label:
        kind === 'table'
          ? t('ui.view.addTable')
          : kind === 'list-table'
            ? t('ui.view.addListTable')
            : t('ui.view.addKind', { kind: t(`ui.view.kind.${kind}` as 'ui.view.kind.table') }),
      icon: VIEW_KIND_ICON[kind],
      group: 'view/9-add',
    })
  }
  /**
   * 下拉（来自抬头那颗「当前看法」按钮）自带锚点；块菜单那条入口没有，
   * 退回「聚焦块的块标」——两条路打开的是同一份菜单。
   */
  const anchor =
    dropdownAnchor ??
    (owner.kind === 'block' ? (getEd().blockEl(owner.blockId)?.getBoundingClientRect() ?? null) : null)
  layers.openMenu({
    rows,
    anchor,
    // 同一颗「当前看法」按钮再点一次＝收起（toggle）；块菜单那条入口没有元素，退回先关再开
    ...(trigger ? { trigger } : {}),
    ...(dropdownAnchor ? { width: 260 } : {}),
    title: t('menu.label.views'),
    searchable: false,
    onPick: (row) => {
      const id = String(row.id)
      if (id === 'view//outline') void getRegistry().invoke('core.view/set-active', { owner, viewId: '' }, 'menu')
      else if (id.startsWith('view//')) void getRegistry().invoke('core.view/set-active', { owner, viewId: id.slice('view//'.length) }, 'menu')
      else if (id.startsWith('view/sort/')) {
        const [, , col, dir] = id.split('/')
        // 升 → 降 → 取消（与平表表头同一套三次点击）
        const next = dir === '' ? 'asc' : dir === 'asc' ? 'desc' : ''
        void getRegistry().invoke('core.view/set-sort', { owner, viewId: active?.id ?? '', by: col, dir: next }, 'menu')
      } else if (id.startsWith('view/cover/') && active) {
        void getRegistry().invoke(
          'core.view/set-cover',
          { owner, viewId: active.id, cover: id.slice('view/cover/'.length) },
          'menu',
        )
      } else if (id.startsWith('view/tabs-dir/') && active) {
        void getRegistry().invoke(
          'core.view/set-tabs-direction',
          { owner, viewId: active.id, direction: id.slice('view/tabs-dir/'.length) },
          'menu',
        )
      } else if (id === 'view/options') {
        showViewOptions(owner)
      } else if (id === 'view/rename' && active) {
        // 名字是这一张视图的配置：就在同一份菜单里改，走命令面落盘／可撤销
        layers.openPopover(
          (box) =>
            renderNamePrompt(box, {
              title: t('ui.view.renameTitle'),
              value: active.name ?? '',
              placeholder: t('ui.view.renamePlaceholder'),
              submitText: t('ui.view.renameApply'),
              cancelText: t('ui.view.renameCancel'),
              onSubmit: (name) => {
                layers.closePopover()
                void getRegistry().invoke('core.view/rename', { owner, name }, 'menu')
              },
              onCancel: () => layers.closePopover(),
            }),
          anchor,
        )
      } else if (id === 'view/slice' && active) {
        openViewSlice(owner, active.id, anchor)
      } else if (id === 'view/slice-clear' && active) {
        void getRegistry().invoke('core.view/set-filter', { owner, viewId: active.id, filter: null }, 'menu')
      } else if (id === 'view/remove' && active) {
        void getRegistry().invoke('core.view/remove', { owner, viewId: active.id }, 'menu')
      } else if (id.startsWith('view/add/')) void getRegistry().invoke('core.view/add', { owner, kind: id.slice('view/add/'.length) }, 'menu')
    },
  })
}

  /**
   * **派生栏（引用／成员／同类／提及）的看法下拉**。
   *
   * 与自定义查询的「视图…」同壳（同一台浮层、同一颗按钮的形状），但**没有**新建／
   * 改名／切片：派生栏是只读关系视图，没有 `_views` 可以写，看法只是设备状态的一格。
   * 候选吃 core 的 `DERIVED_VIEW_KINDS`（兼容集与 query 源同一张表）——菜单另写一份
   * 清单，迟早会在 core 加看法的那天漏掉一格。
   */
  /**
   * **切片构建器**：与「视图… → 编辑切片…」同一台浮层（抬头切片 chip 也走这里）。
   *
   * 切片没有「默认看法」那一份配置：`spec` 每次现读，视图被删了就退回空树；
   * 点「应用」才写一次，空树收成 `null` ⇒ `withFilter` 删键。
   */
  /**
   * **视图选项**（四轴一个面）：块菜单入口落在浮层里（默认大纲没有抬头可挂），
   * 抬头的「选项」按钮与这里共用同一台组件——一个轴在两个落点里说法必须一致。
   */
function showViewOptions(owner: ViewOwnerRef): void {
  const data = owners.read(owner)
  if (!data) return
  const host = owner.kind === 'block' ? blocks.find(owner.blockId) : undefined
  const anchor =
    owner.kind === 'block' ? (getEd().blockEl(owner.blockId)?.getBoundingClientRect() ?? null) : getEd().caretRect()
  layers.openPopover((box) => {
    const readSource = () => {
      const d = owners.read(owner)
      if (!d) return { view: null, source: { kind: 'children', blockId: '' } as const, filter: null, display: undefined }
      const view = readViewSet(d).active
      return {
        view,
        source: sourceOfOwner(owner, d, host ?? undefined),
        filter: view ? (view.filter ?? null) : (d.defaultFilter ?? null),
        display: view ? view.displayProps : d.defaultDisplayProps,
        // 行首路径只有默认大纲有面（命名视图没有大纲）；缺省显示，false 才落笔。
        // 分段同层：`_defaultGroup` 只认「所在页」，别的键对大纲不生效
        pathsHidden: view ? false : d.defaultShowPaths === false,
        pathsGrouped: view ? false : d.defaultGroup === PAGE_COLUMN,
      }
    }
    const records = () => {
      const src = readSource().source
      if (src.kind !== 'children') return []
      return childrenRecords(src.blockId, kb)
    }
    /** 筛选候选与字段覆盖率共用同一批：children 现读子块；query 现算 spec（各答各的问法） */
    const candidateRecords = () => {
      const src = readSource().source
      if (src.kind !== 'query') return records()
      return resolveRows(evaluateQuerySpec(src.spec, kb, {}), kb)
    }
    const fields = () => queryFieldsOf(kb.roots(), fieldCoverageOf(candidateRecords()))
    const panel = new ViewOptionsPanel({
      owner,
      viewId: () => readViewSet(owners.read(owner) ?? { views: [] }).active?.id ?? '',
      read: readSource,
      fields,
      records,
      filterCandidates: candidateRecords,
      atomLabel: (atom) => {
        if ('tag' in atom) return atom.tag
        const b = kb.get(atom.up.is)
        return b ? blockLabel(b, kbGet) : t('ui.page.untitled')
      },
      cardinalityOf: (id) => fields().find((f) => f.id === id)?.cardinality ?? 'one',
      invoke: (name, args) => void getRegistry().invoke(name, args, 'menu'),
      // 自定义编辑态的预选基线（与抬头选项面板同一口径）：表格＝计算列；rich＝有值的键
      displayDefaults: () => {
        const { view, source } = readSource()
        if (view?.kind === 'table') return defaultDisplayPropsFor(source, kb)
        const keys = new Set<string>()
        for (const r of records()) {
          for (const [k, val] of Object.entries(r.values)) {
            if (val !== undefined && val !== null && val !== '' && !(Array.isArray(val) && val.length === 0)) keys.add(k)
          }
          if (r.tags.length > 0) keys.add(TAGS_COLUMN)
        }
        return [...keys]
      },
      ...(owner.kind === 'block' ? { openChildProps: (blockId: string) => showChildPropsPicker(blockId) } : {}),
      openBuilder: () => {
        layers.closePopover()
        openQueryBuilder(owner)
      },
    })
    box.append(panel.root)
    panel.render()
  }, anchor)
}

/**
 * **派生栏的切片编辑器**：基条件只读展示，树只编辑叠加层。
 *
 * 它与视图切片共用同一台 `QueryTree`／同一个「应用」语义（空树＝没有切片），
 * 只是落点不同：这里写这一栏条目的 `filter`（`core.mount/set-derived-lens`），
 * 不写 `_query`／`_views`。
 */
function openDerivedSlice(
  hostBlockId: string,
  mountHost: MountHost,
  source: DerivedSource,
  current: QueryNode | null,
  baseText: string,
  anchor: DOMRect | null,
): void {
  openSpecPopover({
    owner: { kind: 'block', blockId: hostBlockId },
    anchor,
    spec: () => ({ where: current ?? { any: [] } }),
    showOptions: false,
    note: t('ui.mount.sliceBase', { text: baseText }),
    onApply: (spec) => {
      const filter = filterOfSpec(spec)
      void getRegistry().invoke(
        'core.mount/set-derived-lens',
        { host: mountHost, source, filter },
        'mount',
      )
      layers.closePopover()
    },
  })
}

function openViewSlice(owner: ViewOwnerRef, viewId: string, sliceAnchor: DOMRect | null | undefined): void {
  openSpecPopover({
    owner,
    anchor: sliceAnchor ?? null,
    /**
     * 切片住在哪：命名视图 ⇒ 它的 `filter`；默认看法（`''`）⇒ 拥有者的
     * `defaultFilter`。两处同一件事，判据是「此刻激活的是哪张视图」。
     */
    spec: () => ({
      where:
        viewId === ''
          ? (owners.read(owner)?.defaultFilter ?? { any: [] })
          : (owners.read(owner)?.views.find((v) => v.id === viewId)?.filter ?? { any: [] }),
    }),
    /**
     * 覆盖率分母＝这个拥有者显示的那批块（children 现读；query 现算）。
     * ⚠️ **不收草稿批次**：切片编辑的是筛选，批次按 187 D4 同款口径——筛选生效后不缩，
     * 否则摘掉一颗条件、字段下拉的覆盖率跟着变。
     */
    coverage: (_batch) => {
      const d = owners.read(owner)
      if (!d) return undefined
      const src = sourceOfOwner(owner, d, owner.kind === 'block' ? (blocks.find(owner.blockId) ?? undefined) : undefined)
      const records =
        src.kind === 'children'
          ? childrenRecords(src.blockId, kb)
          : src.kind === 'query'
            ? resolveRows(evaluateQuerySpec(src.spec, kb, {}), kb)
            : []
      return fieldCoverageOf(records)
    },
    showOptions: false,
    onApply: (spec) => {
      void getRegistry().invoke('core.view/set-filter', { owner, viewId, filter: filterOfSpec(spec) }, 'menu')
      layers.closePopover()
    },
  })
}

  /**
   * **条件树（弹层版）**：内联树之外的第二个入口（命令面／投影窗口）。
   *
   * 它和正文里那棵树是**同一个组件**，不是第二套表单——草稿改在本地、点「应用」才写一次，
   * 边打字边写会把 ⌘Z 变成「一个字一步」。
   */
function openQueryBuilder(owner: ViewOwnerRef): void {
  const data = owners.read(owner)
  if (!data?.query) {
    toast(t('ui.query.noSpec'), 'warn')
    return
  }
  const anchor =
    owner.kind === 'block' ? (getEd().blockEl(owner.blockId)?.getBoundingClientRect() ?? null) : getEd().caretRect()
  openSpecPopover({
    owner,
    anchor,
    spec: () => owners.read(owner)?.query ?? { where: { any: [] } },
    /** 覆盖率分母＝草稿已圈出的那批块（树递过来；一条完整的都没有 ⇒ undefined ⇒ 全量） */
    coverage: (batch) => fieldCoverageOf(resolveRows(evaluateQuerySpec(batch, kb, {}), kb)),
    onApply: (spec) => {
      void getRegistry().invoke('core.query/set-spec', { owner, spec }, 'builder')
      layers.closePopover()
    },
  })
}

  /**
   * **插入外链的输入框**（斜杠菜单／块菜单 ⇒ 命令不带 `url` ⇒ 走这里）。
   *
   * 与「选图片」同一条理由：要跟用户要**一句话**，而命令 handler 不许碰 DOM。
   */
function showLinkComposer(): void {
  layers.openPopover(
    (host) =>
      renderLinkComposer(host, {
        // 仍然走命令面：插入是写动作，撤销/落盘/审计都在那条路上
        insert: (url, text) => {
          layers.closePopover()
          void getRegistry().invoke('core.editor/insert-link', { url, text }, 'popover', uiCtx())
        },
        toast: (text, kind) => toast(text, kind),
      }),
    getEd().caretRect(),
  )
}

  /**
   * 标签选择器：**显示层级**（`#演员 · 属于 #人物、#艺术家`）。
   *
   * 这是「`#` 补全」当前的产品形态：从列表选一个已有标签插边（正文里敲 `#` 自动成边仍未做）。
   * 层级只帮人认位置，不参与消歧（地址唯一）。
   *
   * 候选与浮层都交给 `app/retrieval/name-choice.ts`：标签表与边图邻接表在**打开这一刻**
   * 建一次，输入只做本地过滤（不再每行重建一遍邻接表）。
   */
  /**
   * **子块行内属性的选择器**（块菜单「子块行内属性…」的落点）：多选清单＝
   * 引擎两项＋全部属性定义；勾选即写父块的 `_childProps`（keepOpen，逐项一次撤销）。
   */
function showChildPropsPicker(blockId: string): void {
  const parent = kb.get(blockId)
  if (!parent) return
  const current = new Set(childDisplayProps(parent))
  const FOR_REFS_ROW = 'childprop-for-refs'
  const FOLLOW_ROW = 'childprop-follow'
  // 浮层开着时块会被改写：每次都从库里重读，别拿打开那一刻的快照当现状
  const block = () => kb.get(blockId) ?? parent
  const sourceOn = () => childPropsForRefs(block())
  const refTarget = () => {
    const targetId = passThroughRefTarget(block())
    return targetId ? (kb.get(targetId) ?? null) : null
  }
  const followState = () => {
    const override = childPropsFollowOverride(block())
    if (override === undefined) {
      return t('menu.state.followSource', {
        on: childPropsForRefs(refTarget()) ? t('ui.automation.on') : t('ui.automation.off'),
      })
    }
    return override ? t('menu.state.forceOn') : t('menu.state.forceOff')
  }
  const rows = () => {
    const all = [
      ...kb.propDefs().map((d) => ({ id: d.id, label: propLabel(d) || blockLabel(d, kbGet) })),
      ...enginePropDefs().map((d) => ({ id: d.id, label: propLabel(d) })),
    ]
    all.sort((x, y) => x.label.localeCompare(y.label, collatorLocale()))
    const propRows = all.map((it) => ({
      id: `childprop/${it.id}`,
      label: it.label,
      keyHint: current.has(it.id) ? '✓' : undefined,
    }))
    /**
     * 头两行是**策略链**，不是 `_childProps` 的成员：
     *   · 源块级默认：任何块都可能被引用，配一次管所有引用（对未来引用也生效）；
     *   · 引用级覆盖：只在真有「这一跳」时出现（正文只有一枚引用、没有可见文字），
     *     缺省＝跟随源块，点一下先给出与源块相反的显式值。
     */
    const head = [
      {
        id: FOR_REFS_ROW,
        label: t('menu.label.childPropsForRefs'),
        keyHint: sourceOn() ? t('ui.automation.on') : t('ui.automation.off'),
        hint: t('menu.hint.childPropsForRefs'),
        icon: 'lucide:link-2',
      },
    ]
    if (passThroughRefTarget(block()) !== null) {
      head.push({
        id: FOLLOW_ROW,
        label: t('menu.label.childPropsFollow'),
        keyHint: followState(),
        hint: t('menu.hint.childPropsFollow'),
        icon: 'lucide:corner-down-right',
      })
    }
    return [...head, ...propRows]
  }
  layers.openMenu({
    rows: rows(),
    anchor: getEd().caretRect(),
    // 标签块上的声明对**所有成员**的子块生效（解析链含标签）；普通块只对自己的子块
    title: t(hasList(parent, 'tag') ? 'menu.label.childPropsTag' : 'menu.label.childProps'),
    searchable: true,
    focusSearch: true,
    keepOpen: true,
    onPick: (row) => {
      const id = String(row.id)
      if (id === FOR_REFS_ROW) {
        void getRegistry().invoke(
          'core.props/set-child-props-for-refs',
          { blockId, on: !sourceOn() },
          'menu',
          uiCtx(),
        )
        layers.setRows(rows())
        return
      }
      if (id === FOLLOW_ROW) {
        const targetOn = childPropsForRefs(refTarget())
        const cur = childPropsFollowOverride(block())
        // 三态循环：跟随源块 → 与源块相反 → 与源块相同 → 跟随源块
        const mode =
          cur === undefined ? (targetOn ? 'off' : 'on')
          : cur === targetOn ? 'follow'
          : targetOn ? 'on' : 'off'
        void getRegistry().invoke('core.props/set-child-props-follow', { blockId, mode }, 'menu', uiCtx())
        layers.setRows(rows())
        return
      }
      const propId = id.slice('childprop/'.length)
      const on = !current.has(propId)
      if (on) current.add(propId)
      else current.delete(propId)
      void getRegistry().invoke('core.props/set-child-props', { blockId, propId, on }, 'menu', uiCtx())
      layers.setRows(rows())
    },
  })
}

function showTagPicker(): void {
  openTagChoice({
    layers,
    forest: ws.blocks,
    anchor: getEd().caretRect(),
    title: t('ui.tagPicker.title'),
    emptyText: t('ui.tagPicker.typeToCreate'),
    onPick: (pick) => {
      if (pick.kind === 'create') {
        getApp().insertTag(pick.name)
        return
      }
      // 插入的是**地址**（全名）：`insertTag` 走 findByAlias，叶子在 `A/B` 上解析不到。
      void getRegistry().invoke('core.editor/insert-tag', { tag: pick.name }, 'menu', uiCtx())
    },
  })
}

  /**
   * **自动化条件（`when`）的编辑弹层**：与查询/切片**同一台**条件树组件，落点不同——
   * 应用写的是 `_automation.when`（整份定义一次写回，一步撤销）。
   * 草稿清空 ⇒ `when` 回到「无条件」（`{any:[]}` 是 specOfTree 对空草稿的固定答案）。
   */
  function openAutomationWhenBuilder(automationId: string): void {
    const readWhen = (): QueryNode | undefined => {
      const block = kb.get(automationId)
      return block ? readAutomation(block)?.when : undefined
    }
    const anchor = getEd().blockEl(automationId)?.getBoundingClientRect() ?? getEd().caretRect()
    openSpecPopover({
      owner: { kind: 'block', blockId: automationId },
      anchor,
      spec: () => ({ where: readWhen() ?? { any: [] } }),
      onApply: (spec) => {
        const block = kb.get(automationId)
        const def = block ? readAutomation(block) : null
        if (!def) return
        // 合成根被清空 ＝ 用户要「无条件」：摘掉 when，不存一个恒假/恒真的空组
        const empty = JSON.stringify(canonicalNode(spec.where)) === JSON.stringify({ any: [] })
        // 「任意父块」的诞生触发器（父块槽空态）条件跟着「如果」走——这里是唯一的同步点
        const emptySlotBirth = def.triggers.some(
          (tr) => tr !== 'manual' && tr.birth === true && topUpOf(tr.query) === undefined,
        )
        if (empty) {
          if (emptySlotBirth) {
            toast(t('ui.automation.whenGuardEmptySlots'), 'warn')
            return
          }
          const next: AutomationDef = { enabled: def.enabled, triggers: def.triggers, steps: def.steps }
          void getRegistry().invoke('core.automation/set-def', { automationId, def: next }, 'builder')
          layers.closePopover()
          return
        }
        const newWhen = canonicalNode(spec.where)
        if (emptySlotBirth) {
          const violation = validateTriggerQuery('entered', newWhen, true)
          if (violation) {
            toast(t('ui.automation.whenGuardNotTriggerable', { reason: violation }), 'warn')
            return
          }
        }
        const next: AutomationDef = {
          ...def,
          when: newWhen,
          triggers: def.triggers.map((tr) =>
            tr !== 'manual' && tr.birth === true && topUpOf(tr.query) === undefined ? { ...tr, query: newWhen } : tr,
          ),
        }
        void getRegistry().invoke('core.automation/set-def', { automationId, def: next }, 'builder')
        layers.closePopover()
      },
    })
  }

  /**
   * **诞生触发器的父块筛选编辑**：与「如果」同一台条件树，落点是 `trigger.query` 里的
   * `{up}`（**作用在容纳链上**——「父块是某块的传递型引用」这类语义只有这里表达得了）。
   * 清空草稿 ＝ 槽空态（任意父块）：条件即「如果」——「如果」没有能当触发条件的原子
   * 就拒（「任意父块＋无条件」＝每笔新建都触发，语言层保护性拒绝）。
   */
  function openAutomationParentBuilder(automationId: string, triggerIndex: number): void {
    const readTrigger = (): Exclude<AutomationTrigger, 'manual'> | null => {
      const block = kb.get(automationId)
      const def = block ? readAutomation(block) : null
      const tr = def?.triggers[triggerIndex]
      return !tr || tr === 'manual' ? null : tr
    }
    const readParent = (): QueryNode | undefined => {
      const tr = readTrigger()
      if (!tr || tr.birth !== true) return undefined
      return topUpOf(tr.query)
    }
    const anchor = getEd().blockEl(automationId)?.getBoundingClientRect() ?? getEd().caretRect()
    openSpecPopover({
      owner: { kind: 'block', blockId: automationId },
      anchor,
      spec: () => ({ where: readParent() ?? { any: [] } }),
      note: t('ui.automation.parentBuilderNote'),
      onApply: (spec) => {
        const block = kb.get(automationId)
        const def = block ? readAutomation(block) : null
        const current = readTrigger()
        if (!def || !current || current.birth !== true) return
        const empty = JSON.stringify(canonicalNode(spec.where)) === JSON.stringify({ any: [] })
        let query: QueryNode
        if (empty) {
          // 清空父块条件 ＝ 槽空态（任意父块）：条件即「如果」——「如果」没有能当触发
          // 条件的原子就拒（「任意父块＋无条件」＝每笔新建都触发，保护性拒绝）
          const whenQuery = def.when !== undefined ? triggerQueryFromWhen(def.when) : null
          if (!whenQuery) {
            toast(t('ui.automation.anyParentNeedsWhen'), 'warn')
            return
          }
          query = whenQuery
        } else {
          query = withUp(current.query, canonicalNode(spec.where))
          const violation = validateTriggerQuery('entered', query, true)
          if (violation) {
            toast(t('ui.automation.triggerQueryRejected', { reason: violation }), 'warn')
            return
          }
        }
        const next: AutomationDef = {
          ...def,
          triggers: def.triggers.map((tr, i) => (i === triggerIndex && tr !== 'manual' ? { ...tr, query } : tr)),
        }
        void getRegistry().invoke('core.automation/set-def', { automationId, def: next }, 'builder')
        layers.closePopover()
      },
    })
  }

  return {
    openEmbedViewMenu,
    openSpecPopover,
    openViewMenu,
    showViewOptions,
    openViewSlice,
    openDerivedSlice,
    openQueryBuilder,
    openAutomationWhenBuilder,
    openAutomationParentBuilder,
    showLinkComposer,
    showChildPropsPicker,
    showTagPicker,
  }
}
