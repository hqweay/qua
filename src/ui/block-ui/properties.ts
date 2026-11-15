/**
 * **块属性区**：块属性是块的第一公民。
 *
 * 三词分工（定义在 `core/props.ts` 顶部）：**属性**是全局定义，**标签属性**是
 * 某个标签声明了哪些属性，**块属性**是这个块自己有哪些属性的值。
 * 本组件画的是「这个块有哪些属性的值」，顺带把「标签属性」的清单也画出来。
 *
 * 段序按**打开这块要干什么**排（不是按模型的字段序）：
 *   1. **属性值**：高频工作区，同一 `propId` 只出现一次（被多个标签声明时**来源并列**）；
 *      每行标来源：`来自 #A、#B`，没有标签声明就标「本块自有」；
 *      声明了但没填 ⇒ 仍出现，显示「待填」占位（这正是标签属性的意义）；行序由数据层给。
 *   2. **类型专属**：标签的字段声明（`_fieldDefs` 清单）／定义块的值配置（格式／基数／候选域／选项）。
 *   3. **块配置**：脸／别名／露面／显示／标签／属于——低频的「它是谁」，与块配置弹窗共用段。
 *   4. **系统信息**：只读的创建／修改时刻。
 *
 * ⚠️ 为什么块属性段内不分节：同一条属性出现在两节里会重复；只放一节又会让来源随标签顺序变化。
 *    平铺 ＋ 多来源标注两个问题都没有（顺序只影响行序）。
 * ⚠️ 但**声明**必须另成一段：它写 `_fieldDefs`、不是这一块的值；画成同一种行会让人
 *    把它当成另一条属性（也会诱导两个 picker 共用去重集合）。
 * ⚠️ 组件不写模型：所有写入经注入的回调（由装配层转成命令）。
 */
import type { Block, BlockStore, ClickMods } from '../../core/index.ts'
import { clickModsOf, COLOR_PROP, enginePropText, identityColorCss, isColorValue, isEngineProp } from '../../core/index.ts'
import { plainText } from '../../core/model/runs.ts'
import { EDIT_ISLAND_ATTR } from '../../view/editor/block-dom.ts'
import type { BlockEditor, Run } from '../../view/editor/editor.ts'
import { inputSession } from '../../view/editor/input-session.ts'
import { EditableBlock } from './editable-block.ts'
import { onCommitKeys } from './keys.ts'
import type { FieldRow, PropKind } from '../../core/index.ts'
import type { PropCreateMode } from '../../core/infra/ports.ts'
import {
  ICON_PROP,
  aliasesOf,
  allowsMany,
  assetRefKindOf,
  assetRefsOf,
  cardinalityOf,
  choiceDisplayLabel,
  clockLabel,
  displayNameOf,
  declaredFieldIds,
  hasList,
  formatOf,
  isPropDef,
  normalizeAlias,
  PROP_KINDS,
  PROP_KIND_SPECS,
  prop,
  propKindOf,
  propLabel,
  refDomainOf,
  refViewOf,
  SELF,
  valueItemsOf,
  valueListOf,
  type RefDomain,
  type RefDomainMode,
} from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import { renderIcon } from '../../view/icons.ts'
import { ChoicesEditor, type ChoiceActions } from './choices-editor.ts'
import { makeAssetThumb } from './asset-value.ts'
import {
  belongsContent,
  chipDel,
  displayContent,
  listsContent,
  namesContent,
  tagsContent,
  type ConfigSectionsCtx,
} from './config-sections.ts'

/** 格式的显示名（一张小表：格式是封闭集，翻不出去） */
function formatLabelOf(format: string): string {
  if (format === 'url') return t('ui.props.format.url')
  if (format === 'email') return t('ui.props.format.email')
  if (format === 'phone') return t('ui.props.format.phone')
  if (format === 'date') return t('ui.props.format.date')
  if (format === 'datetime') return t('ui.props.format.datetime')
  if (format === 'image') return t('ui.props.format.image')
  if (format === 'file') return t('ui.props.format.file')
  if (format === 'any') return t('ui.props.format.any')
  return t('ui.props.format.plain')
}

/**
 * 下拉里「这条属性装什么」的目录名：`text` 的格式轴给一等名（链接／邮箱／电话），
 * 其余按 kind。用户按内容类型认一条属性（「主页 · 链接」），不按 kind/format 的分界认。
 */
function defCatalogLabel(def: Block): string {
  const kind = propKindOf(def)
  if (kind === 'text') {
    const f = formatOf(def)
    if (f === 'url' || f === 'email' || f === 'phone') return t(`ui.props.format.${f}`)
  }
  return t(`ui.props.kind.${kind}`)
}

/**
 * **段头**：图标 ＋ 名字 ＋ 可选计数。
 *
 * 段头是「分组」的唯一视觉锚点：一列表单里没有段头，读者只看到一串行；
 * 有了图标与计数，主段与次段在同一视野里各有身份（图标是形状，计数是规模）。
 */
function sectionHead(icon: string, title: string, count?: number): HTMLElement {
  const head = document.createElement('div')
  head.className = 'props-section-head'
  const ico = document.createElement('span')
  ico.className = 'props-section-ico'
  ico.setAttribute('aria-hidden', 'true')
  renderIcon(ico, icon, 'list', 'sm')
  const label = document.createElement('span')
  label.className = 'props-section-title'
  label.textContent = title
  head.append(ico, label)
  if (count !== undefined && count > 0) {
    const badge = document.createElement('span')
    badge.className = 'props-section-count'
    badge.textContent = String(count)
    head.appendChild(badge)
  }
  return head
}

export interface PropertiesDeps {
  /**
   * 属性区画在哪个块上 —— **这一屏唯一的主体**（中心槽的当前对象）。
   *
   * 不是「光标所在的块」：见装配层 `subject()` 的注释（布局跳、位置与主体不符、
   * 与 `activeId` 形成两套主体）。`null` ⇒ 没有单一主体（多根视图），整区收起。
   */
  target: () => Block | null | undefined
  /** 派生行（core 算好：标签属性 ∪ 块属性，同一 propId 只一行） */
  rows: (b: Block) => FieldRow[]
  /**
   * **身份与归属段的能力包工厂**（标签／归属／名字／露面的读写与开取）。
   *
   * 与块配置弹窗共用同一份段组件（`config-sections.ts`）：判据与写路径只写一份，
   * 两个宿主只差 chrome 与「写完谁重画」（`repaint` 由宿主给）。
   */
  configOps: (blockId: string, repaint: () => void) => ConfigSectionsCtx
  /** 这块带着哪些标签（`props._tags` 的活块）——字段行的来源分组用（只读） */
  tags: (b: Block) => Block[]
  /**
   * **打开一个指向某块的露面**（属性行的名字用它）。
   *
   * 判据与正文里的标签 chip 是同一条：**一份归属的每一处露面，点名字都打开它**。
   * 不注入的话，同一个标签在正文里能点、在属性区点了没反应 —— 同一件事有两种行为，
   * 每一次都要重新猜一遍哪个能点。
   */
  openRef: (to: string, mods: ClickMods) => void
  /** 值里的资产点一下：默认动作按指向分派（图→lightbox／外链→浏览器／其余→详情） */
  activateAsset: (ref: string, label: string) => void
  /** 引用目标的图标（页/标签的脸）；没有就不画 */
  refIcon: (id: string) => string | undefined
  /** 森林里全部定义（「添加已有属性」用） */
  defs: () => Block[]
  /** 短 id（未知属性的显示） */
  shortId: (id: string) => string
  setValue: (b: Block, propId: string, value: unknown) => void
  /** `drop`：连自有槽一起删（「删掉这一栏」）；缺省＝只清值 */
  clearValue: (b: Block, propId: string, opts?: { drop?: boolean }) => void
  /**
   * **`asset` 值选一份本地资源**：入库后把 hash 交给回调，由值控件写进这一格。
   *
   * 为什么不复用正文的 `pickImage`：那条路先取光标落点、入库后往正文插 `AssetRun`；
   * 属性面板没有光标语义，写的是 `props[propId]`。入库是异步的、要碰文件对话框，
   * 所以能力落在装配层，组件只接一个「选好了」的 hash。
   */
  pickAsset?: (onPick: (hash: string) => void) => void
  /** 把已有属性加进**这一块自己的值槽**（`_ownProps`） */
  addOwnProp: (b: Block, propId: string) => void
  /** 新建一条定义并加进**这一块自己的值槽**（`mode: 'new'` ＝ 同名也新建；`format` ＝ text 格式轴） */
  createOwnDef: (b: Block, label: string, kind: PropKind, mode?: PropCreateMode, format?: string) => void
  /** 把已有属性**声明给成员**（标签属性／字段声明，写 `_fieldDefs`；只有页/标签能声明） */
  declareProp: (b: Block, propId: string) => void
  /** 新建一条定义并**声明给成员**（标签属性／字段声明；`format` ＝ text 格式轴） */
  createDeclaredDef: (b: Block, label: string, kind: PropKind, mode?: PropCreateMode, format?: string) => void
  /**
   * 页/标签**声明给成员**的那些属性定义（`_fieldDefs` 的活块）。
   *
   * ⚠️ 与「这一块自己有哪些值」是两件事：在页/标签上点自己的添加入口做的是**声明**，
   *    页自己没有值，所以不会在块属性里长出任何一行。没有这一段，那次点击就没有可见结果。
   */
  declaredFields: (b: Block) => Block[]
  /** 解除一条声明（只摘清单；成员块上的值一个字节不动） */
  undeclareField: (b: Block, propId: string) => void
  /**
   * **给 `ref` 类型的值选一个目标块**（装配层弹出选择器，选中后回调写值）。
   *
   * 为什么必须走注入：选择器要读**整片森林**（页、标签、任意块），
   * 而属性区只认识「当前这一块」——它也拿不到 DOM 之外的浮层。
   * 不注入的话，`ref` 只能让用户手打 32 位 id，那等于没有这个类型。
   */
  pickRef: (b: Block, propId: string, current: string, onPick: (targetId: string) => void, anchor?: DOMRect, trigger?: HTMLElement) => void
  /**
   * **多值属性选值**（选中不关、逐项勾）。单选走原生 `<select>`，多选必须开浮层：
   * 原生 `<select multiple>` 的交互（Ctrl/⌘ 点）不是这套 UI 的语言。
   */
  pickChoice: (
    b: Block,
    propId: string,
    current: readonly string[],
    onPick: (next: string[]) => void,
    anchor?: DOMRect,
    trigger?: HTMLElement,
  ) => void
  /**
   * **给选项选一个图标**（装配层弹出图标网格，选中后回调写 `_icon`）。
   *
   * 与 `pickRef` 同一条理由：图标集是 `view/icons.ts` 的数据，属性区不该自己
   * 维护第二份清单；浮层也只有装配层能开。
   */
  pickIcon: (anchor: DOMRect, current: string, onPick: (icon: string) => void) => void
  /**
   * **这一块的「图标＋颜色」**（装配层弹出选择器，写 `_icon`／`_color`）。
   *
   * 点击开的是块配置弹窗（脸面板直接展开），写与「最近」记账都在弹窗那条路上；
   * 与弹窗头部脸位同判据——任意块都有脸，入口不按露面位限流。
   */
  pickFace?: (b: Block, anchor: DOMRect) => void
  /** 把一个块 id 变成人能读的名字（`ref` 值的显示） */
  refLabel: (targetId: string) => string
  /**
   * ref 值 inline 岛的装配（`_refView: 'inline'` 的值行用）。
   *
   * **传没传是「看法落面」的门**：开了岛的面（属性抽屉）传它；检视卡与表格格子
   * 不传 ⇒ ref 值照旧画引用 chip——inline 是 opt-in 的看法，一个面一个面验观感，
   * 不一次铺满（右槽窄栏的观感没验过之前不进高频面）。
   */
  refIsland?: RefIslandDeps
  /**
   * 标签块的显示名（选项作用域徽标里的 `#名`）。
   *
   * 由装配层注入（`kb.get` 是 O(1) 的索引读）：UI 不该为了一个名字去扫整片森林。
   */
  tagName: (id: string) => string
  /** 按 id 取块（选项编辑器判「来源标签还在不在」） */
  blockById: (id: string) => Block | undefined
  /** 全部标签（选项作用域的勾选候选） */
  allTags: () => readonly Block[]
  /**
   * `propId → 显示名`（同名属性带声明来源，仍重名再带短 id）。
   *
   * 由装配层用 `propDisplayLabels` 一次算好：UI 逐行扫森林会把这个面板变成 O(n²)，
   * 而且显示名会出现两种口径。
   */
  propLabels: () => ReadonlyMap<string, string>
  /** `propId → 声明它的标签`（picker 的「本标签／未声明／其他标签」分组用） */
  fieldDeclarations: () => ReadonlyMap<string, readonly Block[]>
  /** 选项的写入口（命令；组件不直接改块） */
  choices: ChoiceActions
  /** 定义格式的写入口（同值形状内的约束与画法；`plain` ＝ 摘键） */
  setFormat: (defId: string, format: string) => void
  /**
   * **`ref` 定义的候选域**（`_refDomain` 软约束）的三个入口：标签、锚块、查询。
   *
   * 选择器必须经装配层开（浮层不归组件）；标签这一档收已有清单当排除项 ——
   * 第二次为同一个标签点「＋」不该再多给一条同样的 chip。
   */
  pickRefTag: (exclude: readonly string[], onPick: (tagId: string) => void, anchor: DOMRect) => void
  pickRefAnchor: (onPick: (blockId: string) => void, anchor: DOMRect) => void
  pickRefQuery: (onPick: (queryId: string) => void, anchor: DOMRect) => void
  /** 写候选域（`null` ＝ 不限，摘键） */
  setRefDomain: (defId: string, domain: RefDomain | null) => void
  toast: (text: string, kind?: 'ok' | 'warn' | 'info') => void
}

/**
 * 一行字段编辑需要的**最小能力**：读写值、解析 / 选择 `ref` 目标。
 *
 * 单独收窄是为了让「属性区」与「行内实例浮层」共用同一个行渲染器：
 * 后者不需要标签行、归属行、系统信息，只需要这一组回调。
 */
export type FieldRowDeps = Pick<PropertiesDeps, 'shortId' | 'setValue' | 'clearValue' | 'pickRef' | 'refLabel'> & {
  /** ref 值 inline 岛的装配（开了岛的面才传；见 `PropertiesDeps.refIsland`） */
  refIsland?: RefIslandDeps
  /** 多值选择器（省略 ⇒ 多值字段只读；行内实例浮层可以不给） */
  pickChoice?: PropertiesDeps['pickChoice']
  /** 本地资源入库（省略 ⇒ asset 值只显示缩略图与手填链接，不给选文件按钮） */
  pickAsset?: PropertiesDeps['pickAsset']
  /** 标签名解析（选项显示名的 `#名`）；缺省显示短 id */
  tagName?: (id: string) => string
  /** 打开属性定义块（普通块的属性名可点：改选项去定义页，不在块上再开一个编辑面） */
  openRef?: PropertiesDeps['openRef']
  /** 值里的资产点一下：lightbox／外链／一句详情（判据与块下属性行同一份，执行归装配层） */
  activateAsset?: (ref: string, label: string) => void
  /** 引用目标的图标（页/标签的脸）；没有就不画 */
  refIcon?: (id: string) => string | undefined
}

/**
 * 值控件要的那一小撮能力：`ref` 要选择器与显示名，`select` 要标签名。
 *
 * 全都可以缺省：表格格子里没有属性区那套依赖时，控件退化成只读/短 id 显示，
 * 而不是「点了报错」。
 */
export type CellEditorDeps = Partial<
  Pick<
    FieldRowDeps,
    'pickRef' | 'pickChoice' | 'pickAsset' | 'refLabel' | 'tagName' | 'openRef' | 'activateAsset' | 'refIcon'
  >
> & {
  /** ref 值 inline 岛的装配（缺省 ⇒ 该面永远画 chip）；见 `RefIslandDeps` */
  refIsland?: RefIslandDeps
}

/**
 * ref 值 inline 岛需要的装配（`EditableBlock` 的那一套，原样透传）。
 *
 * 岛是 `EditableBlock` 的又一个挂点（镜像/抬头/侧槽窗口/备注浮窗同一条装配线），
 * 三件套都在组件里：岛根断链、唯一重载路径、整份事件表。这里只递参数。
 */
export interface RefIslandDeps {
  store: BlockStore
  /** 写事务入口（见 `Run`）：编辑**直接写回目标块本体**——禁止拷贝语义 */
  write: Run
  /** 目标块解析（值存的是 id）；解析不到（悬空值）就不画岛 */
  blockOf: (id: string) => Block | undefined
  /** 与正文同一份事件表（装配层 `wireViewEditor` 的整份 viewEvents） */
  wire: (ed: BlockEditor, change: (kind: string) => void) => void
  /** 岛里的编辑：落盘、刷角标 */
  onChange: (kind: string) => void
  /** 获得焦点：装配层把「活动编辑器」切过来（键位走命令层，认的是它） */
  onFocus: (ed: BlockEditor) => void
}

export interface PropertiesEls {
  /** 卡片本身：`hidden` 与否表达「有没有主体」 */
  root: HTMLElement
  /**
   * 卡片标题。**由装配层写当前对象的名字**（`displayNameOf`），面板不写死「块属性」——
   * 标题要回答「现在在改谁」，而这个名字每个主体都不一样。
   */
  title: HTMLElement
  body: HTMLElement
  add: HTMLButtonElement
}

/**
 * 活动岛登记表：键＝岛根元素，值＝建编辑器／退役两件收尾。
 *
 * 岛的编辑器要**等宿主挂进文档才建**（构造时量 DOM），退役要**退订 store**——
 * 这两件事的时机都归面板的一次重建（见 `PropertiesPanel.render()`），
 * 登记在元素上而不是面板字段里，行怎么重建都找得到自己那座岛。
 */
const REF_ISLANDS = new WeakMap<HTMLElement, { ensure: () => void; dispose: () => void }>()

/**
 * ref 值行装目标块的正文（深度 1 的 inline 岛）。
 *
 * 三个口径都写在参数里：
 *   · **深度 1** ＝ `viewRootId`（目标的子树不归岛画——它们在大纲里本就有位置，
 *     岛里再展开是把一棵树画第二遍）＋ `embedBodies: false`（露面身体同样不展开，
 *     与镜像同一档构造性截断）；
 *   · **禁止拷贝语义** ＝ 编辑直接写回目标块本体（`write` 是装配层事务）；
 *   · `allowRootRemove: false`——岛绑定单一块，「值指向的块没了」走摘值/换目标，
 *     不是岛内删除键的职责。
 *
 * 自刷新与冻结都归 `EditableBlock`（唯一重载路径）；面板重建对它的
 * 保留/退役见 `PropertiesPanel` 的岛守卫（正被编辑的行整行保留）。
 */
function mountRefValueIsland(deps: RefIslandDeps, area: HTMLElement, targetId: string): void {
  const target = deps.blockOf(targetId)
  if (!target) return // 悬空值不画岛（读侧按悬空显示）
  // 岛根包着编辑器宿主（`EditableBlock` 构造时 root.appendChild(host)）：
  // 宿主必须是**新元素**，area 只当岛根的落点——同一个元素两头当，父子互包当场炸
  const host = document.createElement('div')
  // `inline-editor` 是既有的「裸正文」档（抬头/卡片格共用）：行 chrome 收掉、字号承容器——
  // 共用类名选择，不另写一份按容器的覆盖
  host.className = 'prop-ref-island inline-editor'
  const island = new EditableBlock({
    host,
    store: deps.store,
    write: deps.write,
    initialRoots: [target],
    viewRootId: target.id,
    embedBodies: false,
    structuralScope: 'roots',
    allowRootRemove: false,
    load: (ed, ids) => {
      if (!ed) return
      if (ids && !ids.includes(targetId)) return
      ed.reloadFromStore()
    },
    wire: deps.wire,
    onChange: deps.onChange,
    onFocus: deps.onFocus,
  })
  island.root.dataset.refTarget = targetId
  area.appendChild(island.root)
  REF_ISLANDS.set(island.root, {
    ensure: () => void island.ensureEditor(),
    dispose: () => island.dispose(),
  })
}

/**
 * 多值的**一枚 chip**：值文本 ＋ 摘除。
 *
 * 多值的读法一律从这里长出来（而不是各自拼字符串）：`asset` 用缩略图、
 * `select`／`ref`／`text`／`number` 用 chip —— 但「一格值是一个列表」这件事
 * 只有一种表达，写回时用 `valueListOf`／`valueItemsOf` 还原成数组，
 * **绝不 `String(value)`**（那会把 `a,b` 写回去，List 就退化成单值了）。
 */
function valueChips(
  items: readonly { text: string; refId?: string; icon?: string }[],
  onRemove: (index: number) => void,
  opts: { onOpen?: (index: number, e: MouseEvent) => void } = {},
): HTMLElement {
  const box = document.createElement('div')
  box.className = 'prop-chips'
  box.dataset.propChips = '1'
  for (const [i, item] of items.entries()) {
    const chip = document.createElement('span')
    chip.className = 'prop-chip'
    chip.dataset.chip = '1'
    const body = document.createElement('span')
    body.className = 'prop-chip-text ui-ellipsis'
    if (item.icon !== undefined && item.icon !== '') {
      const ico = document.createElement('span')
      ico.className = 'prop-chip-ico'
      ico.setAttribute('aria-hidden', 'true')
      renderIcon(ico, item.icon, 'circle', 'sm')
      body.appendChild(ico)
    }
    const text = document.createElement('span')
    text.className = 'prop-chip-label ui-ellipsis'
    text.textContent = item.text
    body.appendChild(text)
    /**
     * 引用类的值本身是一枚**露面**：点名字＝打开目标（与正文引用、块下属性行同一条语义）。
     * 面板不在编辑器事件宿主里，所以这里显式调 `onOpen`；`data-ref-to` 仍留着，
     * 它是「指向某块」的语义标记，不是第二套跳转实现。
     */
    if (item.refId !== undefined && item.refId !== '') {
      body.dataset.refTo = item.refId
      body.classList.add('prop-chip-ref')
    }
    if (opts.onOpen) {
      body.classList.add('prop-chip-open')
      body.dataset.tip = t('ui.props.openRef')
      body.addEventListener('click', (e) => {
        e.stopPropagation()
        opts.onOpen!(i, e)
      })
    }
    const x = document.createElement('button')
    x.type = 'button'
    x.className = 'prop-chip-x'
    x.dataset.chipRemove = '1'
    x.dataset.tip = t('ui.props.multiRemove')
    x.textContent = '×'
    x.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      onRemove(i)
    })
    chip.append(body, x)
    box.appendChild(chip)
  }
  return box
}

/** 多值的「追加一个」入口（`+`）：形状与定义页的「＋候选标签」同一枚，读者认得 */
function chipAddButton(title: string, onClick: (anchor: DOMRect) => void): HTMLButtonElement {
  const add = document.createElement('button')
  add.type = 'button'
  add.className = 'prop-chip-add'
  add.dataset.chipAdd = '1'
  add.dataset.tip = title
  add.textContent = '+'
  add.addEventListener('click', (e) => {
    e.preventDefault()
    onClick(add.getBoundingClientRect())
  })
  return add
}

/** 值控件画在哪：面板/抽屉给整宽富控件，表格格只给一行（格子定高，不被预览撑破） */
export type CellEditorSurface = 'panel' | 'cell'

/**
 * 一行值的编辑器（按 kind）。返回控件元素。
 *
 * `ref` 与其它类型不同：它不是「输入一个值」，而是**选一个块**。
 * 所以它需要 deps（弹选择器、解析显示名），不能只靠 `commit`。
 *
 * ⚠️ **属性区与表格单元格共用这一份**：两处各写一套控件，迟早出现
 *    「面板里 Enter 能提交、表格里不能」这种只在某处复现的分叉。
 *
 * 多值（`many`）也在这里：它是**值的形状**（一格是一个列表），不是某一种 kind 的脾气
 * —— 所以 `text`／`number`／`select`／`ref`／`asset` 各自有控件，但共用「chips ＋ 追加」
 * 这一副形状与「写回整份数组」这一条写路径。
 */
export function makeCellEditor(
  row: FieldRow,
  commit: (v: unknown) => void,
  deps?: CellEditorDeps,
  owner?: Block,
  surface: CellEditorSurface = 'panel',
): HTMLElement {
  const kind = row.kind
  /**
   * **同一个值不重复提交**。
   *
   * 控件会给两条提交路径：`change`（失焦/选择）与 Enter（表格里显式派一次 `change`）。
   * 用键盘在输入框里敲完直接 Enter 时两条都会走到 —— 第二次提交的值与第一次相同，
   * 于是产出一次「零 op 的事务」，把 `lastOps` 冲成空数组：
   * 账面上「改了却没写」，而实际写了。这里按**控件自己记住的最后一个值**去重。
   */
  let last: unknown = row.value
  const same = (a: unknown, b: unknown): boolean => {
    // 多值的「同一个值」是**同样的数组**（引用比较恒不等 ⇒ 每次重画都多一笔零 op 事务）
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i])
    const ea = a === undefined || a === null || a === ''
    const eb = b === undefined || b === null || b === ''
    if (ea && eb) return true
    return a === b
  }
  const send = (v: unknown): void => {
    if (same(last, v)) return
    last = v
    commit(v)
  }
  if (kind === 'checkbox') {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'prop-check'
    /**
     * **三态**：有槽没勾（`false`）与没有这一槽（`undefined`）是两件事 ——
     * 「是任务但没填」与「不是任务」在待办条件里分得开，靠的就是这两位。
     * 浏览器只能画两态 ⇒ 用 `indeterminate` 把「没有值」画出来。
     */
    box.checked = row.value === true
    box.indeterminate = row.value === undefined || row.value === null
    box.addEventListener('change', () => send(box.checked))
    /**
     * **格子里要有字**：勾选框是**值**的控件，而这一格读起来是「谁 · 什么值」。
     * 只画一个方框时，表格列里看见的是「□ □」、看板列头看见的是 `false`／`true` ——
     * 读者得先知道方框属于哪个字段才认得出它。
     *
     * 所以二元值给一段**只读**的说明文字（「已完成／未完成」），它不参与编辑：
     * 改值仍然只有方框这一处。没有值（`undefined`）时不给字——那正是「未填」。
     */
    if (row.value === true || row.value === false) {
      const l = document.createElement('label')
      l.className = 'prop-check-row'
      const text = document.createElement('span')
      text.className = 'prop-check-text'
      text.textContent = row.value === true ? t('ui.props.checkboxOn') : t('ui.props.checkboxOff')
      l.append(box, text)
      return l
    }
    return box
  }
  /**
   * **这一格是不是多值**（`_cardinality: 'many'` ＋ 注册表说这个 kind 允许多值）。
   *
   * 两个条件都要：注册表是写路径的闸，控制面不该比它更宽 —— 坏数据里
   * `checkbox + many` 不该画出 chips（那会让用户以为这种形态是合法的）。
   */
  const many = row.cardinality === 'many' && allowsMany(kind)
  /**
   * `ref`：显示目标的名字，点一下换目标。
   *
   * ⚠️ **不提供手打 id 的输入框**：32 位 hex 没人记得住，让它可编辑等于让人拼手速。
   *    值的形状仍然是「一个块 id」（模型层不变），只是入口换成了选择器。
   *
   * **带修饰键 ⇒ 去那个块**（不带＝换目标）。这一支与正文引用同一份语义：
   * `openRef` 把 mods 原样交给 `openActionOf`（⇧ 右槽／⌘ 新 tab／⌥ 详情），
   * 这里不发明第二套「哪个键去哪儿」。编辑面（面板／表格）的主动作仍是换值——
   * 阅读面（块下行）反过来：点值就跳，见 `props-line.ts`。
   *
   * ⚠️ **多值时不换成「换目标」语义**：一串引用里换成「点一下把整串换成一个」
   *    是破坏性动作。多值时值本身是阅读面（chip 可点），编辑走 `×` 摘除与 `+` 追加，
   *    每次追加写回**整份数组**。
   */
  if (kind === 'ref') {
    if (many) {
      const ids = valueListOf(row.value)
      const box = document.createElement('div')
      box.className = 'prop-multi-value'
      box.dataset.propMulti = '1'
      if (deps?.refIsland !== undefined && refViewOf(row.def) === 'inline') {
        // **inline 看法的多值**：每个值一台岛（目标正文就地编辑，写回各自源块）。
        // 值层不变——仍是整份 id 数组：摘除写回数组、追加走选择器，岛只是值的看法。
        // 抽屉的一个属性就那么几个值，逐台岛的账付得起；表格/检视卡不传岛 deps，照旧 chips。
        for (const id of ids) {
          const item = document.createElement('span')
          item.className = 'prop-ref-item'
          mountRefValueIsland(deps.refIsland, item, id)
          item.appendChild(chipDel(t('ui.props.multiRemove'), () => {
            const next = ids.filter((x) => x !== id)
            send(next.length === 0 ? undefined : next)
          }))
          box.appendChild(item)
        }
      } else {
        box.appendChild(
          valueChips(
            ids.map((id) => ({ text: deps?.refLabel?.(id) ?? id, refId: id, icon: deps?.refIcon?.(id) })),
            (i) => {
              const next = ids.filter((_, j) => j !== i)
              send(next.length === 0 ? undefined : next)
            },
            deps?.openRef ? { onOpen: (i, e) => deps.openRef!(ids[i]!, clickModsOf(e)) } : {},
          ),
        )
      }
      if (deps?.pickRef && owner) {
        const pick = deps.pickRef
        box.appendChild(
          chipAddButton(t('ui.props.refAdd'), (anchor) => {
            pick(owner, row.propId, '', (targetId) => {
              if (targetId === '' || ids.includes(targetId)) return
              send([...ids, targetId])
            }, anchor)
          }),
        )
      }
      return box
    }
    if (deps?.pickRef && owner) {
      const pick = deps.pickRef
      const current = row.value === undefined || row.value === null ? '' : String(row.value)
      const wrap = document.createElement('span')
      wrap.className = 'prop-ref-value'

      /** 换目标退成一枚尾键——「看它/编辑它」与「换它」是两件事，不能挤在同一个点击上 */
      const changeKey = (): HTMLElement => {
        const change = document.createElement('button')
        change.type = 'button'
        change.className = 'prop-ref-change'
        change.dataset.tip = t('ui.props.refChange')
        change.setAttribute('aria-label', t('ui.props.refChange'))
        renderIcon(change, 'lucide:pencil', 'pencil', 'sm')
        change.addEventListener('click', (e) => {
          e.stopPropagation()
          pick(
            owner,
            row.propId,
            current,
            (targetId) => send(targetId === '' ? undefined : targetId),
            change.getBoundingClientRect(),
            change,
          )
        })
        return change
      }

      const islandDeps = deps.refIsland
      if (islandDeps && current !== '' && refViewOf(row.def) === 'inline') {
        // **inline 看法**：值行直接装目标块的正文（深度 1，装配见 `mountRefValueIsland`）。
        // 看法是 opt-in（缺省 chip）；正被编辑的行整行冻结（见 `PropertiesPanel.render()`），
        // 不会走到这里重造。
        mountRefValueIsland(islandDeps, wrap, current)
      } else {
        /**
         * **值本身是阅读面**：点名字＝打开目标（带修饰键走同一份 `openRef` 路由）。
         */
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'prop-input prop-ref'
        btn.dataset.refId = current
        btn.dataset.tip = current === '' ? t('ui.props.pickRef') : t('ui.props.refOpenHint')
        const icon = current === '' ? undefined : deps.refIcon?.(current)
        if (icon !== undefined && icon !== '') {
          const ico = document.createElement('span')
          ico.className = 'prop-ref-ico'
          ico.setAttribute('aria-hidden', 'true')
          renderIcon(ico, icon, 'circle', 'sm')
          btn.appendChild(ico)
        }
        const name = document.createElement('span')
        name.className = 'prop-ref-name ui-ellipsis'
        name.textContent = current === '' ? t('ui.props.pending') : (deps.refLabel?.(current) ?? current)
        btn.appendChild(name)
        btn.addEventListener('click', (e) => {
          if (current !== '' && deps.openRef) {
            deps.openRef(current, clickModsOf(e))
            return
          }
          pick(owner, row.propId, current, (targetId) => send(targetId === '' ? undefined : targetId), btn.getBoundingClientRect(), btn)
        })
        wrap.appendChild(btn)
      }
      if (current !== '') wrap.appendChild(changeKey())
      return wrap
    }
  }
  if (kind === 'select' && many) {
    /**
     * 多值：**每一项一枚 chip**，`×` 摘这一项、`+` 开多选浮层。
     *
     * 此前是一颗「a、b」按钮：它把「一格有多个值」压成一句话，读者分不清
     * 哪些是可摘的项、也点不到其中某一个。chips 与 `asset` 的缩略图同一档 —— 都是
     * 「一格值是一个列表」的露面。
     *
     * 写回的是**整份数组**，与单选同一条 `set-value` 命令；每次勾选一次撤销。
     * 顺序按选项序（`currentChoiceIds`，与标签逐项对齐），摘除按 **id** 而不是按下标猜。
     */
    const ids = row.currentChoiceIds ?? valueListOf(row.value)
    const labels = row.currentChoiceLabels ?? []
    const iconOf = new Map((row.choices ?? []).map((c) => [c.id, c.icon]))
    const box = document.createElement('div')
    box.className = 'prop-multi-value'
    box.dataset.propMulti = '1'
    box.appendChild(
      valueChips(
        ids.map((id, i) => ({ text: labels[i] ?? t('ui.props.choice.deleted'), icon: iconOf.get(id) })),
        (i) => {
          const next = ids.filter((_, j) => j !== i)
          send(next.length === 0 ? undefined : next)
        },
      ),
    )
    if (deps?.pickChoice && owner) {
      const pick = deps.pickChoice
      box.appendChild(
        chipAddButton(t('ui.props.pickChoiceMulti'), (anchor) => {
          pick(owner, row.propId, ids, (next) => send(next.length === 0 ? undefined : next), anchor)
        }),
      )
    }
    return box
  }
  if (kind === 'select') {
    const sel = document.createElement('select')
    sel.className = 'prop-input'
    /**
     * 选项只从 `row.choices` 来（派生好的一份）：UI 不认识「选项目录存在哪」，
     * 也就不会出现「属性面板与表格各读一处、两处能不一致」。
     */
    const choices = row.choices ?? []
    const current = row.value === undefined || row.value === null ? '' : String(row.value)
    const tagName = deps?.tagName ?? ((id: string) => id.slice(-6))
    const empty = document.createElement('option')
    empty.value = ''
    empty.textContent = t('ui.props.pending')
    sel.appendChild(empty)
    for (const c of choices) {
      const o = document.createElement('option')
      o.value = c.id
      o.textContent = row.def ? choiceDisplayLabel(c, row.def, tagName) : c.label.trim() || c.id.slice(-6)
      sel.appendChild(o)
    }
    /**
     * **当前值不在可见选项里**（作用域隐藏 / 选项软删 / 值来自另一个库）时，
     * 仍然画出来并保持选中：值在模型里还在，控件不许替用户把它丢掉。
     * 用户可显式切走或清空 —— 那是他的动作，不是这一次渲染的副作用。
     */
    if (current !== '' && !choices.some((c) => c.id === current)) {
      const o = document.createElement('option')
      o.value = current
      const base = row.currentChoiceLabel ?? t('ui.props.choice.deleted')
      // 软删的选项**保留旧名**再标「已删除」：用户才知道要恢复哪一条
      o.textContent = row.currentChoiceDeleted ? t('ui.props.choice.deletedNamed', { label: base }) : base
      o.dataset.missing = '1'
      if (row.currentChoiceDeleted) o.dataset.deleted = '1'
      o.dataset.tip = row.currentChoiceDeleted
        ? t('ui.props.choice.deletedTitle', { label: base })
        : t('ui.props.choice.notInScope')
      sel.appendChild(o)
    }
    sel.value = current
    sel.addEventListener('change', () => send(sel.value === '' ? undefined : sel.value))
    /**
     * **当前值的图标预览**：有图标才加这一枚（没有的 select 保持原样，不给每一条
     * 都塞一个虚线占位）。它读的是行派生里的选项块，与 gutter 同一个 `_icon`。
     */
    const currentChoice = choices.find((c) => c.id === current)
    const icon = currentChoice?.icon ?? (row.def ? prop<string>(row.def, ICON_PROP) : undefined)
    if (icon === undefined) return sel
    const wrap = document.createElement('span')
    wrap.className = 'prop-select'
    const ico = document.createElement('span')
    ico.className = 'prop-select-ico'
    renderIcon(ico, icon, 'square-dashed', 'sm')
    wrap.append(ico, sel)
    return wrap
  }
  /**
   * `asset`：**预览在上、地址在下**（表格格仍收成一行）。
   *
   * 值只有一份，图与地址是它的两种投影：图是「它是什么」，地址是「它从哪来」。
   * 两件事放在同一条带上，读者分不出哪部分可点、哪部分可改；分开之后：
   *   · 预览带是值的舞台（点图＝默认动作：lightbox／外链／详情）；
   *   · 地址带是唯一的编辑入口（手填链接／选文件），也是唯一吸收收缩量的格。
   *
   * 多值预览横向滚动，但滚动本身要**看得出来**：计数徽标 ＋ 细滚动条 ＋
   * 右缘渐隐（只在真的溢出时出现，`data-overflow` 现算），容器可聚焦用方向键滚。
   *
   * 两态值（hash／http(s)）在 `asset-value.ts` 现算成地址，这里只管读写：
   *   · 已有值画成露面（内态缺失／外链腐烂时自己退化成一句实话，值不动）；
   *   · 手填仍可写外链或资产 id，写路径按 kind＋`isAssetRef` 校验；
   *   · 选文件走装配层入库，拿到 hash 再写这一格 —— 组件不碰文件对话框与资产库。
   *
   * ⚠️ **单值／多值都从 `assetRefsOf` 读**：定义切成 `many` 后值是数组，
   *    这里追加／摘除都保持数组形状，绝不 `String(value)`（那会把 `a,b` 写回成一个字符串）。
   *    基数开关在定义页的通用段（`buildDefCardinality`，asset 在注册表里 `many: true`）。
   */
  if (kind === 'asset') {
    const refs = assetRefsOf(row.value)
    const box = document.createElement('div')
    box.className = 'prop-asset'
    box.dataset.assetEditor = '1'
    box.dataset.assetMany = many ? '1' : '0'
    box.dataset.assetSurface = surface

    if (refs.length > 0) {
      const preview = document.createElement('div')
      preview.className = 'prop-asset-preview'
      if (refs.length > 1) {
        preview.dataset.tip = t('ui.props.assetScrollHint', { n: refs.length })
        const count = document.createElement('span')
        count.className = 'prop-asset-count'
        count.textContent = t('ui.props.assetCount', { n: refs.length })
        count.dataset.tip = t('ui.props.assetScrollHint', { n: refs.length })
        preview.appendChild(count)
      }
      const thumbs = document.createElement('div')
      thumbs.className = 'prop-asset-thumbs'
      if (refs.length > 1) {
        // 多值才需要滚：容器可聚焦，方向键能滚；计数徽标在右上角说明「还有」
        thumbs.tabIndex = 0
        thumbs.setAttribute('aria-label', t('ui.props.assetScrollHint', { n: refs.length }))
      }
      for (const ref of refs) {
        const thumb = makeAssetThumb(ref, {
          onRemove: () => {
            // 多值摘一项仍写数组；摘空了就是「没有这一格」（与 chips 一条口径）
            const next = refs.filter((x) => x !== ref)
            send(many ? (next.length === 0 ? undefined : next) : undefined)
          },
        })
        if (deps?.activateAsset) {
          thumb.dataset.assetOpen = '1'
          thumb.addEventListener('click', (e) => {
            e.stopPropagation()
            deps.activateAsset!(ref, row.label)
          })
        }
        thumbs.appendChild(thumb)
      }
      preview.appendChild(thumbs)
      box.appendChild(preview)

      // 溢出是「此刻的几何」，不是值的性质：首帧、图片解码后各量一次
      const syncOverflow = (): void => {
        preview.dataset.overflow = thumbs.scrollWidth > thumbs.clientWidth + 1 ? '1' : '0'
      }
      requestAnimationFrame(syncOverflow)
      thumbs.addEventListener('scroll', syncOverflow, { passive: true })
      for (const img of thumbs.querySelectorAll('img')) img.addEventListener('load', syncOverflow, { once: true })
    }

    const address = document.createElement('div')
    address.className = 'prop-asset-address'
    // 地址带的引导图标说明「这一格是引用」：库内 hash 是文件，外链是链接。
    const lead = document.createElement('span')
    lead.className = 'prop-asset-lead'
    lead.setAttribute('aria-hidden', 'true')
    renderIcon(lead, refs[0] && assetRefKindOf(refs[0]) === 'internal' ? 'lucide:file' : 'lucide:link', 'link', 'sm')
    address.appendChild(lead)

    const input = document.createElement('input')
    input.className = 'prop-input prop-asset-input'
    input.type = 'text'
    input.spellcheck = false
    input.placeholder = t(many ? 'ui.props.assetAddPlaceholder' : 'ui.props.assetPlaceholder')
    input.setAttribute('aria-label', t('ui.props.assetAddress'))
    input.value = many ? '' : (refs[0] ?? '')
    input.addEventListener('change', () => {
      const next = input.value.trim()
      if (next === '') {
        if (!many) send(undefined)
        return
      }
      send(many ? [...refs, next] : next)
    })
    address.appendChild(input)
    if (deps?.pickAsset) {
      const pick = deps.pickAsset
      const btn = document.createElement('button')
      btn.type = 'button'
      // 「选择文件」是动作不是数据：窄槽里按视觉纪律 5 先做减法，文字退 tooltip ＋ aria，
      // 让出宽度给地址（那格才是能省略、能拿回全文的）。
      btn.className = 'prop-asset-pick ghost'
      btn.dataset.assetPick = '1'
      btn.dataset.tip = t('ui.props.assetPickHint')
      btn.setAttribute('aria-label', t('ui.props.assetPick'))
      renderIcon(btn, 'lucide:image-plus', 'image-plus', 'sm')
      btn.addEventListener('click', () =>
        pick((hash) => {
          if (many) {
            if (!refs.includes(hash)) send([...refs, hash])
          } else send(hash)
        }),
      )
      address.appendChild(btn)
    }
    box.appendChild(address)
    return box
  }
  /**
   * **`text`／`number` 的多值**：chips ＋ 一个「加一个值」的输入框。
   *
   * 为什么不用「一行一个输入框」：多值的项数是用户随手长的，行数跟着变会
   * 让属性区的行高跳（面板与表格都在按「行数 × 行高」估高）；chips 是**一格**。
   *
   * 读值走 `valueItemsOf`（不滤类型：`number` 多值存的是数字数组，
   * 走只认字符串的 `valueListOf` 会读成空列表 ⇒ 有值却显示待填）。
   */
  if (many && (kind === 'text' || kind === 'number')) {
    const values = valueItemsOf(row.value)
    const box = document.createElement('div')
    box.className = 'prop-multi-value'
    box.dataset.propMulti = '1'
    const commitOne = (raw: string): void => {
      const text = raw.trim()
      if (text === '') return
      if (kind === 'number') {
        const n = Number(text)
        // 解析失败 ⇒ 不写（回退，一次 op 都不产），与单值数字同一条
        if (!Number.isFinite(n)) return
        send([...values, n])
        return
      }
      send([...values, text])
    }
    box.appendChild(
      valueChips(
        values.map((v) => ({ text: String(v) })),
        (i) => {
          const next = values.filter((_, j) => j !== i)
          send(next.length === 0 ? undefined : next)
        },
      ),
    )
    const add = document.createElement('input')
    add.className = 'prop-input prop-multi-add'
    add.placeholder = t('ui.props.multiAdd')
    add.inputMode = kind === 'number' ? 'decimal' : 'text'
    if (row.format === 'url' || row.format === 'email' || row.format === 'phone') add.spellcheck = false
    /**
     * 提交走 `onCommitKeys`（Enter 由它兜住并 `stopPropagation`）：这个输入框可能长在
     * 表格格里，Enter 冒到命令层会命中「拆块」，也会让属性卡的 Enter 去提交别的行。
     * 失焦也提交一次 —— 用户打完字直接点别处是最常见的那条路。
     */
    const submit = (): void => {
      commitOne(add.value)
      add.value = ''
    }
    onCommitKeys(add, { commit: submit, stop: true })
    add.addEventListener('change', submit)
    box.appendChild(add)
    return box
  }
  const input = document.createElement('input')
  input.className = 'prop-input'
  /**
   * 输入框类型跟着**格式**走（不是跟着 kind）：`url`／`email`／`tel` 的原生键盘与
   * 浏览器提示是白拿的；校验仍在写路径（命令层），这里只影响键盘与拼写检查。
   */
  input.type =
    kind === 'date'
      ? 'date'
      : row.format === 'url'
        ? 'url'
        : row.format === 'email'
          ? 'email'
          : row.format === 'phone'
            ? 'tel'
            : 'text'
  if (row.format === 'url' || row.format === 'email' || row.format === 'phone') input.spellcheck = false
  if (kind === 'number') input.inputMode = 'decimal'
  input.placeholder = t('ui.props.pending')
  input.value = row.value === undefined || row.value === null ? '' : String(row.value)
  input.addEventListener('change', () => {
    if (input.value === '') {
      send(undefined)
      return
    }
    /**
     * **数字提交的是 `number`**（不是字符串）：排序与统计按值比，字符串会退化成字典序
     * （`10` 排在 `9` 前面），而且从表面看只是「顺序有点怪」。
     * 解析失败 ⇒ 不写（回退原值，一次 op 都不产）。
     */
    if (kind === 'number') {
      const n = Number(input.value)
      if (!Number.isFinite(n)) {
        input.value = row.value === undefined || row.value === null ? '' : String(row.value)
        return
      }
      send(n)
      return
    }
    send(input.value)
  })
  return input
}

/**
 * **一行字段**：标签名（含来源）＋ 按 kind 的值控件 ＋ 清空。
 *
 * 属性区与行内实例浮层共用这一份：一处改了行布局，两处一起变。
 * `labelCount` 用来消歧「同名不同 propId」——两个字段都叫「状态」时，
 * 只靠 label 用户分不出改的是哪一个。
 */
export function makeFieldRow(
  row: FieldRow,
  target: Block,
  deps: FieldRowDeps,
  opts: { labelCount?: ReadonlyMap<string, number>; showSource?: boolean; labels?: ReadonlyMap<string, string> } = {},
): HTMLElement {
  const el = document.createElement('div')
  el.className = 'prop-row ui-row'
  el.dataset.propId = row.propId
  /**
   * **值的形状决定行形**：图与多值不是「标签右边的一格」。半宽值槽里，
   * 预览会贴到地址输入上、chips 会挤成一团；这时标签单占一行，值整宽落下。
   * 单行值仍保持「标签左、值右」的紧凑形（扫一列字段时更快）。
   */
  if (
    row.kind === 'asset' ||
    (row.cardinality === 'many' && allowsMany(row.kind)) ||
    // inline 看法的值行：岛是一台块编辑器（带块级的行 chrome），半宽槽装不下——
    // 与图／多值同一档：标签单占一行，值整宽落下
    (row.kind === 'ref' && row.filled && deps.refIsland !== undefined && refViewOf(row.def) === 'inline')
  )
    el.dataset.stack = '1'
  if (!row.filled) el.dataset.pending = '1'

  const label = document.createElement('label')
  label.className = 'prop-label'
  const name = document.createElement('span')
  name.className = 'prop-name'
  const source = t('ui.props.own')
  const duplicated = (opts.labelCount?.get(row.label) ?? 0) > 1
  const disambiguated = duplicated ? `${row.label}（${row.sources[0] ? displayNameOf(row.sources[0]) : t('ui.props.own')}）` : row.label
  // 有 `labels` 就用它（同名属性带声明来源；仍重名带短 id）——只在一个地方决定「这一行叫什么」
  const shown = opts.labels?.get(row.propId) ?? disambiguated
  name.textContent = row.def ? shown : t('ui.props.unknown', { id: deps.shortId(row.propId) })
  /**
   * **属性名指向定义块**。普通块上只画值控件：要改选项/类型，点名字去定义页，
   * 不在块上再开第三个编辑面（同一个东西三处可改＝三处都能不同步）。
   */
  if (row.def && deps.openRef) {
    name.dataset.refTo = row.def.id
    name.dataset.tip = t('ui.props.openDef')
    name.addEventListener('click', (e) => deps.openRef!(row.def!.id, clickModsOf(e)))
  }
  label.appendChild(name)
  if (opts.showSource !== false) {
    const src = document.createElement('span')
    src.className = 'prop-source'
    /**
     * **来源是一枚色点＋#名**，不是一句灰字：这条值「归谁管」（改选项去哪个标签、
     * 摘标签会不会带走它）在聚焦编辑时也要读得出来，2xs 灰字与「本块自有」
     * 几乎同形 ⇒ 读不出。点用标签自己的显式身份色（与块标同一套信号，
     * 「色是涂料」——只染点这一个形状）；没配色的标签回落中性点——
     * 「来自标签」是在场信号，色是标签之间的区分。
     */
    if (row.sources.length) {
      const from = document.createElement('span')
      from.textContent = t('ui.props.sourceFrom')
      src.appendChild(from)
      for (const tag of row.sources) {
        const item = document.createElement('span')
        item.className = 'prop-source-tag'
        const dot = document.createElement('span')
        dot.className = 'prop-source-dot'
        dot.setAttribute('aria-hidden', 'true')
        const c = prop<string>(tag, COLOR_PROP)
        if (c !== undefined && isColorValue(c)) dot.style.setProperty('--identity-c', identityColorCss(c))
        const nm = document.createElement('span')
        nm.textContent = `#${displayNameOf(tag)}`
        item.append(dot, nm)
        if (deps.openRef) {
          // 来源也是「指向标签的一处露面」：点它打开标签（与正文 chip 同一语义）
          item.classList.add('prop-source-tag--link')
          item.dataset.tip = t('ui.props.openTag')
          item.addEventListener('click', (e) => {
            e.stopPropagation()
            deps.openRef!(tag.id, clickModsOf(e))
          })
        }
        src.appendChild(item)
      }
    } else {
      src.textContent = source
    }
    label.appendChild(src)
  }

  const value = document.createElement('span')
  value.className = 'prop-value'
  /**
   * 引擎行（`core/created`/`core/modified`）只读：值由引擎记账，没有可编辑的值控件
   * （合成定义的 kind 只是兜底，给它控件会把毫秒数当 date 输入框画出来），也没有清空。
   */
  if (isEngineProp(row.propId)) {
    value.textContent = enginePropText(row.propId, Number(row.value))
    el.append(label, value)
    return el
  }
  value.appendChild(
    makeCellEditor(
      row,
      (v) => {
        if (v === undefined) deps.clearValue(target, row.propId)
        else deps.setValue(target, row.propId, v)
      },
      deps,
      target,
    ),
  )

  /**
   * **这一行的删除键**（`×`）。
   *
   * 语义按行的来源分：**本块自有** ⇒ 删掉这一栏（值连同自有槽）；**标签声明来的** ⇒
   * 只清值 —— 声明在标签上，这里删不掉它，行会留着（那才是「待填」）。
   * 两件事共用这颗按钮是因为它们对用户是同一个动作（「这条我不要了」）；
   * 分开做成两颗按钮只会让用户在「清空」与「删除」之间猜。
   */
  const own = row.sources.length === 0
  const clear = document.createElement('button')
  clear.type = 'button'
  clear.className = 'prop-clear ghost'
  clear.dataset.dropField = own ? '1' : '0'
  clear.dataset.tip = t(own ? 'ui.props.dropField' : 'ui.props.clear')
  clear.textContent = '×'
  clear.addEventListener('click', () => deps.clearValue(target, row.propId, own ? { drop: true } : undefined))

  el.append(label, value, clear)
  return el
}

export class PropertiesPanel {
  private readonly els: PropertiesEls
  private readonly deps: PropertiesDeps
  /**
   ** 这个实例的 ref 值行装不装 inline 岛（`_refView: 'inline'` 时）。
   *
   * 检视卡不装（引用 chip，右槽窄栏的观感没验过之前不进高频面）；属性抽屉装——
   * 同一份 deps，落面是**实例的门**不是装配的门。
   */
  private readonly inlineRefIsland: boolean
  /**
   * 哪个添加表单开着：`own`（这一块自己的值）／`declared`（标签属性／字段声明）／`null`。
   *
   * ⚠️ 不能是一个布尔：两个入口写的是两个槽，同时开着会让「点了哪个」变得不可知。
   */
  private formOpen: 'own' | 'declared' | null = null
  /**
   * 选项编辑器的两个实例（各自记住「哪个作用域面板展开着」）。
   *
   * 状态必须**在面板里**而不是组件 DOM 里：勾一个标签会写一次模型，
   * 卡片随后整体重画 —— 状态存在 DOM 上就会被这次重画连根拔掉。
   */
  private readonly choicesFull: ChoicesEditor
  private readonly choicesTag: ChoicesEditor
  /** 标签视角打开的是哪条属性的选项（`chip` 上的「选项」按钮切换它） */
  private tagChoices: { def: Block; owner: Block } | null = null

  constructor(els: PropertiesEls, deps: PropertiesDeps, opts: { inlineRefIsland?: boolean } = {}) {
    this.els = els
    this.deps = deps
    this.inlineRefIsland = opts.inlineRefIsland === true
    // **岛编辑会话结束后的整卡补画**：hold 期间值段冻结（其余段照常新），焦点
    // 离开面板才需要补——面板内移动焦点由行控件自己的写路径兜。定时器在点击
    // 完成之后才跑（click 是同步派发），不会吃掉正在进行的点击。
    this.els.body.addEventListener('focusout', () => {
      window.setTimeout(() => {
        if (this.els.body.contains(document.activeElement)) return
        this.render()
      }, 0)
    })
    const base = {
      tagById: (id: string) => this.deps.blockById(id),
      tags: () => this.deps.allTags(),
      write: this.deps.choices,
      tagName: (id: string) => this.deps.tagName(id),
      pickIcon: (anchor: DOMRect, current: string, onPick: (icon: string) => void) =>
        this.deps.pickIcon(anchor, current, onPick),
    }
    this.choicesFull = new ChoicesEditor({
      ...base,
      // 全量视角：属性卡的主体**就是**那条 select 定义时才画
      def: () => this.selectDef(),
      focusTag: () => '',
    })
    this.choicesTag = new ChoicesEditor({
      ...base,
      def: () => this.tagChoices?.def,
      // 页的字段段没有「标签作用域」可言（`_fieldDefs` 在页上还没有消费方）：走全量视角
      focusTag: () => {
        const open = this.tagChoices
        return open && hasList(open.owner, 'tag') ? open.owner.id : ''
      },
    })
    this.els.add.textContent = t('ui.props.addShort')
    this.els.add.dataset.tip = t('ui.props.add')
    this.els.add.addEventListener('click', () => {
      this.formOpen = this.formOpen === 'own' ? null : 'own'
      this.render()
    })
  }

  /** 主体是一条 `select` 定义时，属性卡里画它的选项编辑器 */
  private selectDef(): Block | undefined {
    const target = this.deps.target()
    return target && isPropDef(target) && propKindOf(target) === 'select' ? target : undefined
  }

  /** chip 尾上的删除粒：标签/归属的粒住在段里（`config-sections.ts`）；这里只剩声明段用 */
  private tagDel(title: string, onClick: () => void): HTMLButtonElement {
    return chipDel(title, onClick)
  }

  render(): void {
    const target = this.deps.target()
    if (!target) {
      this.els.root.hidden = true
      delete this.els.root.dataset.targetBlockId
      // 面板收起：岛随卡退役——订阅不比面板活得久
      this.retireAllIslands()
      return
    }
    /**
     * **全部属性行都在这一张卡里可编辑**，包括 `_uiPosition: 'block-left'` 的那些。
     *
     * 曾经的规则是「一个值不开两个编辑面」⇒ 归 gutter 的行从这里排除，只留一句
     * 「在块左侧编辑」。实际用起来那一句就是死路：任务状态是最高频的属性，而用户
     * 在这个卡片里看到它、却改不了它，得先想起来「左侧还有个小方框」。
     *
     * 改成两面共存的前提是**两面读写同一份东西**：行的派生是同一个 `fieldRows`
     * （`gutterFieldsOf` 是它的一个视图）、写是同一类 `core.props/set-value`、
     * 写完两边都重画（`writeProps` 会 `repaintBlock` ＋ `scheduleProperties`）。
     * ⇒ 「面板改了 gutter 没跟上」这个当初的理由不再成立，所以互斥可以撤。
     *
     * ⚠️ `_uiPosition` 仍然有意义：它决定**快捷入口画在哪**（高频二元开关要在行上够得着），
     *    不是「只有那一处能改」。
     */
    const rows = this.deps.rows(target)
    /**
     * **有当前对象就显示**，不因为「没有行」而收起。
     *
     * ⚠️ 判据是入口而不是内容：一个块总能加属性，而「＋ 添加属性」就在这一区里。
     *    按行数收起过一次，结果普通块在加第一条属性之前面板根本不出现 —— 那个加号也就
     *    没了，于是「给一个空块加第一个属性」这条路径根本走不通。
     */
    this.els.root.hidden = false
    // 诊断/冒烟面：面板现在画在哪一块上（收起时删掉，避免读到上一次的目标）
    /**
     * **有活岛在场时，这一次只重建岛不在的段**：inline 岛的每次防抖写回都会触发
     * 这里的重建（store 订阅 → 面板重画）——把正被打字的岛拔掉，等于打到一半丢字。
     *
     * 判据是「岛的区域里有焦点或输入法锚点」（与 `EditableBlock` 的冻结判据同源）。
     * 手法是**值段整段冻结**：移动节点会断焦点（reparent 与摘出文档实测都会），
     * 所以保留不靠搬移，靠「这一段这一次不动」；其余段照常重建。代价是值段的
     * 邻行在编辑期间不变新——由焦点离开面板后的整卡补画兜住（构造器里的
     * focusout 钩子）。没有活岛时这些是一次空查询，重建路径一个字节不变。
     */
    const prevBlockId = this.els.root.dataset.targetBlockId
    this.els.root.dataset.targetBlockId = target.id
    const islandHold = prevBlockId === target.id && this.islandHoldRows(rows)
    if (islandHold) {
      const fieldsEl = this.els.body.querySelector(':scope > .prop-fields')
      for (const child of [...this.els.body.children]) {
        if (child !== fieldsEl) child.remove()
      }
    } else {
      this.retireAllIslands()
      this.els.body.replaceChildren()
    }

    /**
     * **段序按「打开这块要干什么」排，不按模型的字段序排**：
     * 属性值（高频工作区）→ 类型专属（标签的声明／定义块的值配置）→ 块配置
     * （低频的「它是谁」）→ 系统信息。
     *
     * 为什么不拆成两张卡：卡片的粒度是**一个主体**，不是一类信息。检视卡的主体
     * 是「这一屏唯一的那一块」，拆开后两张卡共享同一个主体、同一份生命周期、
     * 同一个标题，却各自要一套收起／关闭状态 —— 用户得先找「值在哪张卡里」。
     * 职责在卡片内部分段即可，容器不该按字段类别复制。
     */
    const labels = this.deps.propLabels()
    // hold 期间值段（含正被编辑的岛）原样保留：不重建、不搬移，其余段照常换新
    if (!islandHold) this.els.body.appendChild(this.buildFields(target, rows, labels))

    /**
     * **标签属性**：只有标签有。
     *
     * 与上面那一段是两件事：那一段是「这一块自己的值」，这一段是「我的成员会有哪些格子」。
     *
     * ⚠️ **页不再有这一段**（v29）。页声明过 `_fieldDefs`，但**没有任何消费方**
     * —— 子块不会因此获得那些字段，于是它只是「一个能写、没人读的值」。
     * 一个写进去却永远不会生效的入口比没有入口更糟：用户会以为「声明了，
     * 成员就有这一格了」。继承是另一个设计（需要先定「页的子块」与「标签的成员」
     * 谁说了算），在定下来之前，这一格就不该可写。
     */
    if (hasList(target, 'tag')) {
      this.els.body.appendChild(this.buildDeclared(target, labels))
    }

    /**
     * **select 定义的选项编辑器**：这条属性「能选什么」就是它自己的子块。
     * 主体是定义块时画在这里（属性行之后、系统信息之前），改完立刻看得到。
     */
    /**
     * **定义块的值配置归组**：格式（同值形状内的约束与画法）、`ref` 的候选域、
     * select 的选项编辑器——三件事都是「这条属性的值」的配置，散着画就是三段断片
     * （空属性段 → 一行格式 → 裸标题「选项」），读者拼不出它们的归属。
     * 归组后「选项」降为组内的一个名字，组头说明这组配置管的是**成员块的值**。
     *
     * 只有有格式轴的 kind 才有格式段（select 的配置是选项编辑器；checkbox/ref 没有格式）；
     * 格式改动**不动任何值**：值仍是同一个字符串，只是校验与输入框类型变了。
     */
    if (isPropDef(target)) {
      const config = document.createElement('section')
      config.className = 'props-section prop-def-config'
      const head = sectionHead('lucide:sliders-horizontal', t('ui.props.defValuesTitle'))
      const hint = document.createElement('span')
      hint.className = 'props-section-hint'
      hint.textContent = t('ui.props.defValuesHint')
      head.appendChild(hint)
      config.appendChild(head)
      const card = this.buildDefCardinality(target)
      if (card) config.appendChild(card)
      const fmt = this.buildDefFormat(target)
      if (fmt) config.appendChild(fmt)
      // `ref` 的候选域：只对 ref 定义出现（别的 kind 没有「候选」这回事）
      const refDomain = this.buildRefDomain(target)
      if (refDomain) config.appendChild(refDomain)
      if (this.selectDef()) {
        this.choicesFull.render()
        config.appendChild(this.choicesFull.root)
      }
      this.els.body.appendChild(config)
    }

    // 块配置是低频的「它是谁」，排在值与其类型专属配置之后
    this.els.body.appendChild(this.buildConfig(target))

    // 系统信息在**最后**：它是这一块的出生与改动记录，不是可编辑的数据
    this.els.body.appendChild(this.buildSystem(target))
    this.ensureIslands()
  }

  /**
   * 值段这一次要不要冻结：**每个正被编辑的岛对应的行仍与它的看法/值一致**才冻。
   *
   * 「正被编辑」＝ 岛的区域里有焦点或输入法锚点——只有这一小撮不能随重建换血；
   * 冻结不靠搬移（reparent 与摘出文档都实测会断焦点），靠「这一段这一次不动」。
   * 一致性是出口：看法切回 chip／值换了目标，冻结就不再成立——被冻的岛看到的
   * 是旧看法，放行整卡重建才能让行跟上（岛随重建退役，编辑会话本来就结束了）。
   */
  private islandHoldRows(rows: readonly FieldRow[]): boolean {
    let any = false
    for (const node of this.els.body.querySelectorAll(`[${EDIT_ISLAND_ATTR}]`)) {
      if (!(node instanceof HTMLElement) || !node.dataset.refTarget) continue
      if (!(node.contains(document.activeElement) || inputSession.isAnchorInside(node))) continue
      const row = node.closest('.prop-row')
      const fr = row instanceof HTMLElement ? rows.find((r) => r.propId === row.dataset.propId) : undefined
      // 一致性认**值**：单值＝同一个 id；多值＝数组里仍含这个目标（摘掉的那枚岛随重建退役）
      const targetId = node.dataset.refTarget
      const valueOk =
        fr !== undefined &&
        targetId !== undefined &&
        (Array.isArray(fr.value) ? valueListOf(fr.value).includes(targetId) : String(fr.value ?? '') === targetId)
      if (!fr || fr.kind !== 'ref' || refViewOf(fr.def) !== 'inline' || !valueOk) {
        return false
      }
      any = true
    }
    return any
  }

  /** 进了文档的岛补建编辑器（构造时量 DOM，等挂好才建）；抽屉是「先 render 再挂载」，游离的等下一帧 */
  private ensureIslands(): void {
    for (const node of Array.from(this.els.body.querySelectorAll(`[${EDIT_ISLAND_ATTR}]`))) {
      if (!(node instanceof HTMLElement)) continue
      const entry = REF_ISLANDS.get(node)
      if (!entry) continue
      if (node.isConnected) entry.ensure()
      else requestAnimationFrame(() => {
        if (node.isConnected) entry.ensure()
      })
    }
  }

  /** 面板收起/换主体：全部岛退役——岛的订阅不比面板活得久 */
  private retireAllIslands(): void {
    for (const node of Array.from(this.els.body.querySelectorAll(`[${EDIT_ISLAND_ATTR}]`))) {
      if (node instanceof HTMLElement) REF_ISLANDS.get(node)?.dispose()
    }
  }

  /**
   * **属性段：这一块自己的值**。
   *
   * 段头给「属性」一个名字 ＋ 入口——没有段头时它与身份行混成一张平清单，
   * 「主次」就是从这里丢的：身份行是轻动作行，这里往下是表单区，节奏必须断开。
   *
   * 入口和表单都紧贴它们写的那一组：`els.add` 原来挂在卡体外面（最下面），
   * 点开表单会长在「声明给成员」段下面，看起来像在给声明段加东西。
   */
  private buildFields(target: Block, rows: readonly FieldRow[], labels: ReadonlyMap<string, string>): HTMLElement {
    const fields = document.createElement('section')
    fields.className = 'props-section prop-fields props-section--primary'
    const fieldsHead = sectionHead('lucide:list', t('ui.block.properties'), rows.length)
    fieldsHead.appendChild(this.els.add)
    fields.appendChild(fieldsHead)

    if (rows.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'props-empty'
      empty.textContent = t('ui.props.empty')
      fields.appendChild(empty)
    }

    // 同名不同 propId 必须能区分（C4）：两行 label 一样时把来源带进显示名
    const labelCount = new Map<string, number>()
    for (const r of rows) labelCount.set(r.label, (labelCount.get(r.label) ?? 0) + 1)

    // inline 岛是**实例的门**：没开岛的面把装配摘掉，ref 值行照旧画 chip
    const rowDeps: FieldRowDeps = this.inlineRefIsland ? this.deps : { ...this.deps, refIsland: undefined }

    for (const row of rows) {
      fields.appendChild(makeFieldRow(row, target, rowDeps, { labelCount, labels }))
    }
    if (this.formOpen === 'own') fields.appendChild(this.buildForm(target, labels))
    return fields
  }

  /**
   * **块配置段**：身份（脸／名字／露面／显示）与分类（标签／属于）。
   *
   * 它是低频的「这块是谁」，所以排在属性值之后；段内顺序与块配置弹窗同一条
   * （两个壳是同一个配置体，段序同一份），只是这一个壳多了一圈段头。
   */
  private buildConfig(target: Block): HTMLElement {
    const section = document.createElement('section')
    section.className = 'props-section prop-config'
    section.appendChild(sectionHead('lucide:sliders-horizontal', t('ui.blockConfig.title')))

    // 脸：一枚入口开块配置弹窗（弹窗里脸面板直接展开）——任意块都有脸，入口不按露面位限流
    if (this.deps.pickFace) section.appendChild(this.buildFace(target))
    section.appendChild(this.buildNames(target))
    section.appendChild(this.buildLists(target))
    const display = this.buildDisplay(target)
    if (display) section.appendChild(display)
    section.appendChild(this.buildTags(target))
    section.appendChild(this.buildBelongs(target))
    return section
  }

  /**
   * **基数**（`_cardinality`）：一条属性在**一个块上**能有几个值。
   *
   * 它原来只在 `ChoicesEditor` 里（"允许多个值"），于是只有 `select` 定义做得到 ——
   * 而基数轴早就推广到全 kind（`PROP_KIND_SPECS[kind].many`：text／number／select／ref／asset，
   * date 先 one、checkbox 永不 many）。同一件事只有一类属性做得到，用户会以为
   * 「引用不能是列表」；真相是**界面没给入口**。
   *
   * 判据与写路径同一份：显隐读 `allowsMany(propKindOf(def))`，闸门在
   * `core.props/set-choice-cardinality`（切回 `one` 时挡住「库里仍有 >1 个值」）。
   * 命令拒绝时把控件重画回模型里的那个值 —— 复选框不能停在用户点出来的状态上。
   */
  private buildDefCardinality(def: Block): HTMLElement | null {
    const kind = propKindOf(def)
    if (!allowsMany(kind)) return null
    const row = document.createElement('div')
    row.className = 'prop-row prop-def-multi prop-hug ui-row'
    const label = document.createElement('label')
    label.className = 'prop-label'
    const name = document.createElement('span')
    name.className = 'prop-name'
    name.textContent = t('ui.props.cardinality.label')
    label.append(name)
    const value = document.createElement('span')
    value.className = 'prop-value'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'prop-check'
    box.dataset.defMulti = '1'
    box.checked = cardinalityOf(def) === 'many'
    box.addEventListener('change', () => {
      this.deps.choices.setCardinality(def.id, box.checked ? 'many' : 'one')
      this.render()
    })
    const hint = document.createElement('span')
    hint.className = 'prop-source'
    hint.textContent = t('ui.props.cardinality.hint')
    value.append(box, hint)
    row.append(label, value)
    return row
  }

  /** 定义格式的一段（没有格式轴的 kind 返回 null：不给一个点了没用的下拉） */
  private buildDefFormat(def: Block): HTMLElement | null {
    const kind = propKindOf(def)
    const spec = PROP_KIND_SPECS[kind]
    if (spec.formats.length === 0) return null
    const row = document.createElement('div')
    row.className = 'prop-row prop-def-format ui-row'
    const label = document.createElement('label')
    label.className = 'prop-label'
    const name = document.createElement('span')
    name.className = 'prop-name'
    name.textContent = t('ui.props.format.label')
    label.append(name)
    const sel = document.createElement('select')
    sel.className = 'prop-input'
    sel.dataset.defFormat = '1'
    for (const f of spec.formats) {
      const o = document.createElement('option')
      o.value = f
      o.textContent = formatLabelOf(f)
      sel.appendChild(o)
    }
    // 没写过 `_format` 时显示该 kind 的第一个格式（text 的 plain／asset 的 image）
    sel.value = formatOf(def) ?? spec.formats[0] ?? ''
    sel.addEventListener('change', () => this.deps.setFormat(def.id, sel.value))
    row.append(label, sel)
    return row
  }

  /**
   * **系统信息**（只读）：创建时间／修改时间两行。
   *
   * 为什么单独成段而不是混进属性行：它们**不是属性**（不在属性袋里，也没有定义块），
   * 面板的每一行都带「编辑控件 ＋ 清除按钮」，把只读事实塞进那种行里，用户会去点、
   * 点了没反应。判据是「可见但只读」由**通道**提供 —— 这一段就没有输入控件。
   */
  private buildSystem(target: Block): HTMLElement {
    const box = document.createElement('section')
    box.className = 'props-section prop-system'
    box.dataset.systemSection = '1'
    box.appendChild(sectionHead('lucide:clock', t('ui.props.systemTitle')))

    const value = document.createElement('div')
    value.className = 'prop-system-value'
    for (const [key, at] of [
      ['created', target.created],
      ['modified', target.modified],
    ] as const) {
      const line = document.createElement('span')
      line.className = 'prop-system-line'
      line.dataset.systemField = key
      line.textContent = `${t(key === 'created' ? 'ui.props.createdAt' : 'ui.props.modifiedAt')} ${clockLabel(at) || t('ui.props.timeUnknown')}`
      value.appendChild(line)
    }
    box.appendChild(value)
    return box
  }

  /**
   * **标签属性**（标签）／**字段声明**（页）：只有页/标签有这一段。
   *
   * 判据：声明是「我的成员/子块会有这一格」，不是「给这一块设一个值」——
   * 所以这一段只有清单和解除，没有值控件。值仍旧只在成员块上。
   *
   * ⚠️ 这一段**自带**自己的添加入口：它写的是 `_fieldDefs`，而「＋ 添加属性」写的是
   *    `_ownProps`。两个槽两个入口，共用一个入口就必须按块类型猜意图，而标签块恰好两个都需要。
   *
   * ⚠️ 这一段**不是一条属性行**（`props-section`，不是 `prop-row`）：视觉上它必须和
   *    「这一块自己的值」分开，否则用户会把声明当成另一条属性 —— 去重也就跟着混了。
   *
   * ⚠️ 解除声明**不动值**：成员块上已有的值落回「本块自有」，重新声明后自动回来。
   */
  private buildDeclared(target: Block, labels: ReadonlyMap<string, string>): HTMLElement {
    // 走到这里只可能是标签（页那一段已移除，见 `render` 里的判据）
    const section = document.createElement('section')
    // `prop-declared` 是既有断言的选择器锚点（`.prop-declared [data-declared-prop-id]`），
    // `props-declared` 是这一段自己的名字（新的断言与样式用它）
    section.className = 'prop-declared props-declared props-section'
    section.dataset.declaredSection = 'tag'

    const defs = this.deps.declaredFields(target)
    const head = sectionHead('lucide:tag', t('ui.props.tagPropsTitle'), defs.length)

    /**
     * 这一段的添加入口住进段头：它是这一段的动作，不是清单下面的又一行字。
     * `data-declare-add` 是给断言认「这是声明那一个，不是自己的值那一个」的。
     */
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'props-add props-declare-add'
    add.dataset.declareAdd = '1'
    add.textContent = t('ui.props.addTagProp')
    add.dataset.tip = t('ui.props.addTagPropTitle')
    add.addEventListener('click', () => {
      this.formOpen = this.formOpen === 'declared' ? null : 'declared'
      this.render()
    })
    head.appendChild(add)

    // 说明折到标题下一整行：标题与动作同排，说明是这一段「为什么存在」的旁注
    const hint = document.createElement('span')
    hint.className = 'props-section-hint'
    hint.textContent = t('ui.props.tagPropsHint')
    head.appendChild(hint)
    section.appendChild(head)

    const list = document.createElement('div')
    list.className = 'props-declared-list'
    if (defs.length === 0) {
      const empty = document.createElement('span')
      empty.className = 'props-empty'
      empty.textContent = t('ui.props.tagPropsEmpty')
      list.appendChild(empty)
    }
    for (const def of defs) {
      const chip = document.createElement('span')
      chip.className = 'props-tag'
      chip.dataset.declaredPropId = def.id
      const text = document.createElement('span')
      text.textContent = `${labels.get(def.id) ?? (plainText(def.content).trim() || def.id)} · ${t(`ui.props.kind.${propKindOf(def)}`)}`
      /**
       * **名字可点＝打开定义块**：与属性行的名字、标签 chip 的名字同一契约
       * （`data-ref-to`）。一枚 chip 上「选项」「×」各有自己的命中区，
       * 可点的只有这段名字，三个命中区互不重叠。
       */
      text.dataset.refTo = def.id
      text.className = 'props-tag-name'
      text.dataset.tip = t('ui.props.openDef')
      text.addEventListener('click', (e) => this.deps.openRef(def.id, clickModsOf(e)))
      /**
       * `select` 的一条声明带「选项」入口：选项是定义块的子块，而标签视角只该看
       * 「对本标签可见」的那几条。**就地展开**在清单下面 —— 再开一层抽屉会让
       * 「现在在改谁」要看两处抬头才知道。
       */
      if (propKindOf(def) === 'select') {
        const opt = document.createElement('button')
        opt.type = 'button'
        opt.className = 'props-tag-choice'
        opt.dataset.declaredChoices = def.id
        opt.textContent = t('ui.props.choice.open')
        opt.dataset.tip = t('ui.props.choice.openTitle')
        opt.addEventListener('click', () => {
          const open = this.tagChoices
          this.tagChoices = open && open.def.id === def.id && open.owner.id === target.id ? null : { def, owner: target }
          this.render()
        })
        chip.append(opt)
      }
      const del = this.tagDel(t('ui.props.undeclare'), () => this.deps.undeclareField(target, def.id))
      chip.append(text, del)
      list.appendChild(chip)
    }
    section.appendChild(list)

    const openChoices = this.tagChoices && this.tagChoices.owner.id === target.id ? this.tagChoices : null
    if (openChoices) {
      this.choicesTag.render()
      section.appendChild(this.choicesTag.root)
    }

    if (this.formOpen === 'declared') section.appendChild(this.buildDeclareForm(target, labels))
    return section
  }

  /** 身份/归属段的能力包（每次现建：块与「写完谁重画」都是这一次的） */
  private cfg(target: Block): ConfigSectionsCtx {
    return this.deps.configOps(target.id, () => this.render())
  }

  /**
   * 身份/归属段的行 chrome：左标签 ＋ 轻值贴着标签（`prop-hug`）。
   * 这些行的值是轻动作（勾选/按钮/chips），铺满右半会把「一行一个字段」读成
   * 「标签在左、答案在很远的右边」；铺满只属于要填的值（字段行、系统信息）。
   */
  private labeledRow(cls: string, title: string, value: HTMLElement): HTMLElement {
    const row = document.createElement('div')
    row.className = `prop-row prop-hug ${cls} ui-row`
    const label = document.createElement('label')
    label.className = 'prop-label'
    const name = document.createElement('span')
    name.className = 'prop-name'
    name.textContent = title
    label.append(name)
    row.append(label, value)
    return row
  }

  /**
   * 富值行：标签占第一行（与摘除键同排），值整宽落第二行。
   *
   * 判据是**值自己的形状**：一串 chips、一列别名、一张图，都不是「标签右边的一格」，
   * 塞进半宽的值槽只会互相压。单行值（文本／日期／下拉）仍走上一条 `labeledRow`。
   */
  private stackedRow(cls: string, title: string, value: HTMLElement): HTMLElement {
    const row = this.labeledRow(cls, title, value)
    row.dataset.stack = '1'
    return row
  }

  /**
   * **名字段**（别名＋添加）：与块配置弹窗共用同一份段（`config-sections.ts`）。
   * 面板壳是整宽小节（添加表单需要宽度），不是右值行。
   */
  private buildNames(target: Block): HTMLElement {
    const value = document.createElement('span')
    value.className = 'prop-value prop-names-value'
    value.appendChild(namesContent(this.cfg(target), this.els.body))
    return this.stackedRow('prop-names', t('ui.alias.title'), value)
  }

  /** **露面段**（page/tag 列表位）：与弹窗共用同一份段 */
  private buildLists(target: Block): HTMLElement {
    return this.labeledRow('prop-lists', t('ui.alias.lists'), listsContent(this.cfg(target)))
  }

  /** **显示模式段**：有别名才画（「这一行的头显示什么」没有名字就没有答案） */
  private buildDisplay(target: Block): HTMLElement | null {
    if (aliasesOf(target).length === 0) return null
    return this.labeledRow('prop-display', t('ui.alias.display'), displayContent(this.cfg(target)))
  }

  /**
   * **这一块归在谁下面**（`props._belongsTo`）。
   *
   * 判据：**能配在任何块上的关系，住在属性区**；只有某类块才有的关系（成员）住在那个块的面板里。
   * 所以这一行对**每个**块都出现，而标签面板只剩「成员」。
   *
   * 两种悬空必须分开显示：上级在回收站（等它复活，边会自己接回）与上级真没了（可清理）。
   * 都画成「已删除」会让人一点清理就把能复活的边清掉。内容与交互在段里（与弹窗共用一份）。
   */
  private buildBelongs(target: Block): HTMLElement {
    return this.stackedRow('prop-belongs', t('ui.belongs.title'), belongsContent(this.cfg(target)))
  }

  /**
   * **页的脸**（图标＋颜色）：一枚入口开块配置弹窗（脸面板直接展开）。
   * 按钮自己是当前值的样子（脸＋色点）——入口读作「它现在长这样，点开改」。
   */
  private buildFace(target: Block): HTMLElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'prop-face-btn'
    btn.dataset.tip = t('ui.iconPicker.faceEntry')
    const ico = document.createElement('span')
    ico.className = 'prop-face-ico'
    renderIcon(ico, prop<string>(target, '_icon'), 'circle-help', 'sm')
    btn.appendChild(ico)
    const color = prop<string>(target, '_color')
    if (color !== undefined) {
      const dot = document.createElement('span')
      dot.className = 'prop-face-dot'
      dot.style.setProperty('--swatch', identityColorCss(color))
      btn.appendChild(dot)
    }
    btn.addEventListener('click', () => this.deps.pickFace?.(target, btn.getBoundingClientRect()))
    return this.labeledRow('prop-face', t('ui.iconPicker.faceEntry'), btn)
  }

  /**
   * **这块的标签**（块级归属）。
   *
   * 这一行只读 `props._tags`：它是「我有哪些分类」，不是「它在正文里出现在哪」。
   * 摘标签不只删这一行：正文里那枚 `#名` 也要收掉（段的宿主路负责），
   * 否则归属没了、正文里还挂着一个看起来像标签的东西。
   * 内容与交互在段里（与块配置弹窗共用一份）。
   */
  private buildTags(target: Block): HTMLElement {
    return this.stackedRow('prop-tags', t('ui.props.tagsTitle'), tagsContent(this.cfg(target)))
  }

  /**
   * **`ref` 定义的候选域**（`_refDomain`）：候选从哪儿来。
   *
   * 四档同一根轴：**不限**（键缺席）／标签成员（含下级标签闭包）／锚块子树／查询块结果。
   * 它在定义页，不在值行上：域是**这条属性**的性质（谁可以被引用），不是某一格值的性质；
   * 值行只画「现在指向谁」——一个字节都不动。
   *
   * 两个判据：
   *   · **控件不许比存储先说**：切到某一档时先还原 `<select>` 的显示值，等「选中目标」
   *     那一步真的写进库、面板重画，档位才变。取消选择 ⇒ 一切照旧（不丢原有配置）。
   *   · **悬空不静默**：锚块/查询被删了仍画出来并标「已删除」，摘掉它就是回到不限。
   */
  private buildRefDomain(def: Block): HTMLElement | null {
    if (propKindOf(def) !== 'ref') return null
    const domain = refDomainOf(def)
    const mode: RefDomainMode = domain?.kind ?? 'any'

    const value = document.createElement('div')
    value.className = 'prop-value prop-ref-domain'
    value.dataset.refDomain = '1'

    const sel = document.createElement('select')
    sel.className = 'prop-input prop-ref-mode'
    sel.dataset.refDomainMode = '1'
    const modes = [
      ['any', 'ui.props.refDomain.any'],
      ['tags', 'ui.props.refDomain.mode.tags'],
      ['block', 'ui.props.refDomain.mode.block'],
      ['query', 'ui.props.refDomain.mode.query'],
    ] as const
    for (const [m, key] of modes) {
      const o = document.createElement('option')
      o.value = m
      o.textContent = t(key)
      sel.appendChild(o)
    }
    sel.value = mode
    sel.dataset.tip = t(
      mode === 'tags'
        ? 'ui.props.refDomain.hint.tags'
        : mode === 'block'
          ? 'ui.props.refDomain.hint.block'
          : mode === 'query'
            ? 'ui.props.refDomain.hint.query'
            : 'ui.props.refDomain.any',
    )
    sel.addEventListener('change', () => {
      const next = sel.value as RefDomainMode
      // 存储没变之前控件不许先说（取消选择时这里就是全部的回滚）
      sel.value = mode
      const rect = sel.getBoundingClientRect()
      if (next === 'any') {
        this.deps.setRefDomain(def.id, null)
        return
      }
      if (next === 'tags') {
        const ids = domain?.kind === 'tags' ? [...domain.ids] : []
        this.deps.pickRefTag(
          [],
          (tagId) => {
            if (!ids.includes(tagId)) this.deps.setRefDomain(def.id, { kind: 'tags', ids: [...ids, tagId] })
          },
          rect,
        )
        return
      }
      if (next === 'block') {
        this.deps.pickRefAnchor((id) => this.deps.setRefDomain(def.id, { kind: 'block', id }), rect)
        return
      }
      this.deps.pickRefQuery((id) => this.deps.setRefDomain(def.id, { kind: 'query', id }), rect)
    })
    value.appendChild(sel)

    /** 一枚约束 chip：点名字打开它；× 摘掉整条约束（回到不限） */
    const targetChip = (id: string, text: string): HTMLElement => {
      const chip = document.createElement('span')
      chip.className = 'props-tag'
      chip.dataset.refDomainTarget = id
      const name = document.createElement('span')
      name.className = 'props-tag-name'
      name.textContent = text
      name.dataset.refTo = id
      name.dataset.tip = t('ui.props.openRef')
      name.addEventListener('click', (e) => this.deps.openRef(id, clickModsOf(e)))
      chip.append(name, chipDel(t('ui.props.refDomain.remove'), () => this.deps.setRefDomain(def.id, null)))
      return chip
    }
    /** 「＋」：切换/补一个目标（标签是追加，锚块与查询是换一个） */
    const addButton = (tip: string, onclick: (rect: DOMRect) => void): HTMLElement => {
      const add = document.createElement('button')
      add.type = 'button'
      add.className = 'prop-ref-add'
      add.dataset.refDomainAdd = '1'
      add.dataset.tip = tip
      add.textContent = '+'
      add.addEventListener('click', () => onclick(add.getBoundingClientRect()))
      return add
    }

    if (domain?.kind === 'tags') {
      for (const id of domain.ids) {
        const tag = this.deps.blockById(id)
        /**
         * 悬空标签（删了/换库了）仍画出来并标短 id：约束的失效是状态，
         * 静默少一枚 chip 会让用户以为约束本来就是这些。
         */
        const chip = document.createElement('span')
        chip.className = 'props-tag'
        chip.dataset.refTag = id
        const name = document.createElement('span')
        name.className = 'props-tag-name'
        name.textContent = tag ? `#${displayNameOf(tag)}` : `#${this.deps.shortId(id)}`
        if (tag) {
          name.dataset.refTo = id
          name.dataset.tip = t('ui.props.openTag')
          name.addEventListener('click', (e) => this.deps.openRef(id, clickModsOf(e)))
        }
        chip.append(
          name,
          chipDel(t('ui.props.refDomain.remove'), () =>
            this.deps.setRefDomain(def.id, { kind: 'tags', ids: domain.ids.filter((x) => x !== id) }),
          ),
        )
        value.appendChild(chip)
      }
      value.appendChild(
        addButton(t('ui.props.refDomain.hint.tags'), (rect) =>
          this.deps.pickRefTag(
            domain.ids,
            (tagId) => this.deps.setRefDomain(def.id, { kind: 'tags', ids: [...domain.ids, tagId] }),
            rect,
          ),
        ),
      )
    } else if (domain?.kind === 'block') {
      const anchor = domain.id === SELF ? undefined : this.deps.blockById(domain.id)
      const text =
        domain.id === SELF
          ? t('ui.props.refDomain.self')
          : anchor
            ? displayNameOf(anchor).trim() || this.deps.shortId(domain.id)
            : t('ui.props.refMissing', { id: this.deps.shortId(domain.id) })
      if (domain.id === SELF) {
        const chip = document.createElement('span')
        chip.className = 'props-tag'
        chip.dataset.refDomainTarget = SELF
        const name = document.createElement('span')
        name.className = 'props-tag-name'
        name.textContent = text
        name.dataset.tip = t('ui.props.refDomain.hint.block')
        chip.append(name, chipDel(t('ui.props.refDomain.remove'), () => this.deps.setRefDomain(def.id, null)))
        value.appendChild(chip)
      } else {
        value.appendChild(targetChip(domain.id, text))
      }
      value.appendChild(
        addButton(t('ui.props.refDomain.pickBlock'), (rect) =>
          this.deps.pickRefAnchor((id) => this.deps.setRefDomain(def.id, { kind: 'block', id }), rect),
        ),
      )
    } else if (domain?.kind === 'query') {
      const qb = this.deps.blockById(domain.id)
      const text = qb
        ? displayNameOf(qb).trim() || this.deps.shortId(domain.id)
        : t('ui.props.refMissing', { id: this.deps.shortId(domain.id) })
      value.appendChild(targetChip(domain.id, text))
      value.appendChild(
        addButton(t('ui.props.refDomain.pickQuery'), (rect) =>
          this.deps.pickRefQuery((id) => this.deps.setRefDomain(def.id, { kind: 'query', id }), rect),
        ),
      )
    }
    return this.stackedRow('prop-ref-domain-row', t('ui.props.refDomain.label'), value)
  }

  /**
   * **添加「这一块自己的」属性**：选已有定义（默认复用）或新建一个。
   *
   * ⚠️ 这个表单只管一件事：往 `_ownProps` 里加一条。**标签属性／字段声明**有它自己的入口
   *    （`buildDeclareForm`），因为那是写另一个槽（`_fieldDefs`）、长在另一段下面。
   *    曾经这两件事共用一个表单，靠「这个块有没有 page/tag 露面」猜用户要哪个 ——
   *    于是标签块永远加不了自己的属性（真踩过）。
   *
   * ⚠️ **类型只属于「新建定义」，不属于「给这一块加一条属性」**：`_kind` 住在定义块上、
   *    全库一份，而「用这个」只吃一个 `propId`——选已有属性能配类型是假的。
   *    所以两件事分两行画：第一行选/复用，第二行（只在「新建」时出现）才是名字＋类型。
   */
  private buildForm(target: Block, labels: ReadonlyMap<string, string>): HTMLElement {
    return this.buildAddForm(target, labels, {
      slot: 'own',
      className: 'props-form props-form--own',
      pick: t('ui.props.pick'),
      use: t('ui.props.use'),
      onUse: (propId) => this.deps.addOwnProp(target, propId),
      onCreate: (label, kind, mode, format) => this.deps.createOwnDef(target, label, kind, mode, format),
    })
  }

  /**
   * **添加标签属性 / 字段声明**（只有页/标签有这个入口）。
   *
   * 与 `buildForm` 的差别是「挂到哪个槽」、`slot` 的去重口径和文案；形状完全共用一份 ——
   * 两处各写一份表单迟早会长出两种键盘行为（Enter 提交 / Esc 取消 / 新建哨兵）。
   */
  private buildDeclareForm(target: Block, labels: ReadonlyMap<string, string>): HTMLElement {
    const isTag = hasList(target, 'tag')
    return this.buildAddForm(target, labels, {
      slot: 'declared',
      className: 'props-form props-form--declared',
      pick: t(isTag ? 'ui.props.pickTagProp' : 'ui.props.pickPageField'),
      use: t('ui.props.useDeclared'),
      onUse: (propId) => this.deps.declareProp(target, propId),
      onCreate: (label, kind, mode, format) => this.deps.createDeclaredDef(target, label, kind, mode, format),
    })
  }

  /**
   * 两个添加入口共用的表单形状。
   *
   * 差异只有四处（槽 / 外层类名 / 两条按钮文案 / 两个回调），所以收成一份：
   * 「选已有 → 用这个」「新建 → 名字＋类型」这两个形态是同一个交互，
   * 分两份写就会出现「一个表单 Enter 能用、另一个不能」。
   *
   * **同名不是错**：输入已有同名同 kind 时，两个动作同时可见 ——
   * 复用（默认，误复用可无损改回）与新建同名属性（另一个 `propId`，各自有值）。
   */
  private buildAddForm(
    target: Block,
    labels: ReadonlyMap<string, string>,
    opts: {
      /** 这个表单写哪个槽：own ＝ `_ownProps`，declared ＝ `_fieldDefs` */
      slot: 'own' | 'declared'
      className: string
      pick: string
      use: string
      onUse: (propId: string) => void
      onCreate: (label: string, kind: PropKind, mode?: PropCreateMode, format?: string) => void
    },
  ): HTMLElement {
    const form = document.createElement('form')
    form.className = opts.className
    form.addEventListener('submit', (e) => e.preventDefault())

    /** 「新建定义」的哨兵值：它不是任何真实定义的 id，只用来把下拉切到第二行 */
    const NEW_OPTION = '__new__'

    const pick = document.createElement('select')
    pick.className = 'prop-input props-pick'
    const placeholder = document.createElement('option')
    placeholder.value = ''
    placeholder.textContent = opts.pick
    pick.appendChild(placeholder)
    /**
     * **每个表单只按自己写的那个槽去重，两个槽互不占位。**
     *
     *   · `own` 写 `_ownProps`：已经在本块的行里（`fieldRows`，含标签声明来的行）就不可再加；
     *   · `declared` 写 `_fieldDefs`：只有已经声明过才不可再加。
     *
     * 所以：
     *   · 标签把 P 声明给成员后，标签自己**仍可以**有一条 P 的值（声明不占值槽）；
     *   · 本块已经有 P 的值/行，也**仍可以**把 P 声明给成员（值不让声明失效）。
     *
     * 曾经两个表单共用一套 `used = rows ∪ declared`：两个方向互相挡住，用户报的就是这个。
     * 这些项**留在列表里但不可选**，而不是从列表里删掉：小库的下拉会变空，
     * 用户分不清「库里没有这条属性」与「本块已经有了」。
     */
    const defs = this.deps.defs()
    const declarations = this.deps.fieldDeclarations()
    const rows = new Set(this.deps.rows(target).map((r) => r.propId))
    const declared = hasList(target, 'page') || hasList(target, 'tag') ? new Set(declaredFieldIds(target)) : new Set<string>()

    /**
     * picker 分组：**本标签 / 未声明 / 其他标签**。
     * 它只是 `_fieldDefs` 的分组视图，不是第二份归属；其他标签的属性**不隐藏**
     * （藏起来会让下拉看起来是空的，用户以为库里没有那条属性）。
     */
    const ownTags =
      opts.slot === 'declared' ? (hasList(target, 'page') || hasList(target, 'tag') ? [target] : []) : [...this.deps.tags(target)]
    const ownIds = new Set(ownTags.map((tag) => tag.id))
    const groupOf = (def: Block): 0 | 1 | 2 => {
      const declaring = declarations.get(def.id) ?? []
      if (declaring.some((tag) => ownIds.has(tag.id))) return 0
      return declaring.length === 0 ? 1 : 2
    }
    const groupLabels = [t('ui.props.groupOwn'), t('ui.props.groupUndeclared'), t('ui.props.groupOther')]
    const groups: HTMLOptGroupElement[] = groupLabels.map((label) => {
      const g = document.createElement('optgroup')
      g.label = label
      return g
    })
    const shownOf = (def: Block): string => labels.get(def.id) ?? (plainText(def.content).trim() || def.id)

    for (const def of defs) {
      let mark = ''
      let disabled = false
      if (opts.slot === 'own') {
        if (rows.has(def.id)) {
          mark = t('ui.props.alreadyOn')
          disabled = true
        } else if (declared.has(def.id)) {
          // 已经声明给成员，但自己的值槽还空着：这一条**可选中**（只是标出来由）
          mark = t(hasList(target, 'tag') ? 'ui.props.isTagProp' : 'ui.props.isFieldDecl')
        }
      } else if (declared.has(def.id)) {
        mark = t('ui.props.declaredOn')
        disabled = true
      }
      const o = document.createElement('option')
      o.value = def.id
      o.textContent = `${shownOf(def)} · ${defCatalogLabel(def)}${mark ? `（${mark}）` : ''}`
      o.disabled = disabled
      groups[groupOf(def)]!.appendChild(o)
    }
    for (const g of groups) if (g.childElementCount > 0) pick.appendChild(g)
    const newOption = document.createElement('option')
    newOption.value = NEW_OPTION
    newOption.textContent = t('ui.props.newOption')
    pick.appendChild(newOption)

    const pickBtn = document.createElement('button')
    pickBtn.type = 'button'
    pickBtn.className = 'props-use'
    pickBtn.textContent = opts.use
    pickBtn.addEventListener('click', () => {
      if (!pick.value || pick.value === NEW_OPTION) return
      opts.onUse(pick.value)
      this.closeForm()
    })

    const label = document.createElement('input')
    label.className = 'prop-input'
    label.placeholder = t('ui.props.newLabel')
    /**
     * **新建的「装什么」目录：kind 闭集 ＋ `text` 格式轴的一等入口。**
     *
     * `url`/`email`/`phone` 不是 kind（kind 按**值的存储形状**分，都是字符串），
     * 但用户按内容类型想——「我要一条链接」，不是「我要一个 text 再去配置里补格式」。
     * 所以目录层给它们一等名，落盘仍是 `text + _format`（模型不动）；
     * 「纯文本」就是 kind 的 text 本名，不带格式。
     */
    const kindOptions: { value: string; kind: PropKind; format?: 'url' | 'email' | 'phone' }[] = []
    for (const k of PROP_KINDS) {
      kindOptions.push({ value: k, kind: k })
      if (k === 'text')
        for (const f of ['url', 'email', 'phone'] as const) kindOptions.push({ value: `text:${f}`, kind: 'text', format: f })
    }
    const kind = document.createElement('select')
    kind.className = 'prop-input'
    for (const opt of kindOptions) {
      const o = document.createElement('option')
      o.value = opt.value
      o.textContent = opt.format ? t(`ui.props.format.${opt.format}`) : t(`ui.props.kind.${opt.kind}`)
      kind.appendChild(o)
    }

    /** 下拉此刻选中的那条目录项（kind ＋ 可选格式） */
    const pickedOf = (): { kind: PropKind; format?: string } => {
      const opt = kindOptions.find((x) => x.value === kind.value) ?? kindOptions[0]!
      return opt.format ? { kind: opt.kind, format: opt.format } : { kind: opt.kind }
    }

    /**
     * **AO4：同一个名字可以有两个 `propId`。**
     *
     * 默认复用（错了好改），但「新建同名属性」也必须当下可见 ——
     * 藏进对话框的那一下会被当成「复用失败」，而用户真正要的是另一个定义。
     * 匹配按 **kind ＋ 有效格式**：声明的格式不同就是两条属性（链接 ≠ 纯文本）——
     * 复用一条纯文本定义会让「要链接」静默丢格式。
     */
    const matchNow = (): Block | undefined => {
      const name = normalizeAlias(label.value.trim())
      if (name === '') return undefined
      const picked = pickedOf()
      return defs.find((d) => {
        if (propKindOf(d) !== picked.kind || normalizeAlias(propLabel(d)) !== name) return false
        const defFormat = picked.kind === 'text' ? (formatOf(d) ?? 'plain') : undefined
        return defFormat === (picked.format ?? (picked.kind === 'text' ? 'plain' : undefined))
      })
    }
    const ao4 = document.createElement('div')
    ao4.className = 'props-ao4'
    ao4.hidden = true
    ao4.dataset.ao4 = '1'
    const reuse = document.createElement('button')
    reuse.type = 'button'
    reuse.className = 'props-reuse'
    reuse.dataset.ao4Reuse = '1'
    const fresh = document.createElement('button')
    fresh.type = 'button'
    fresh.className = 'props-create-new'
    fresh.dataset.ao4New = '1'
    fresh.textContent = t('ui.props.createSameName')
    ao4.append(reuse, fresh)

    const commit = (mode: 'auto' | 'new'): void => {
      const name = label.value.trim()
      if (name === '') {
        this.deps.toast(t('ui.props.needLabel'), 'warn')
        return
      }
      const picked = pickedOf()
      const match = matchNow()
      opts.onCreate(name, picked.kind, mode === 'new' ? 'new' : match ? 'reuse' : undefined, picked.format)
      this.closeForm()
    }

    const create = document.createElement('button')
    create.type = 'submit'
    create.className = 'props-create'
    create.textContent = t('ui.props.create')
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      commit('auto')
    })

    /** 名字/类型一变就重算：有同名同 kind ⇒ 两个动作，默认 Enter 走复用 */
    const syncAo4 = (): void => {
      const match = matchNow()
      if (!match) {
        ao4.hidden = true
        create.hidden = false
        return
      }
      const declaring = declarations.get(match.id) ?? []
      const source = declaring.length > 0 ? declaring.map((tag) => `#${displayNameOf(tag)}`).join('、') : t('ui.props.own')
      reuse.textContent = t('ui.props.reuseNamed', { label: shownOf(match), source })
      ao4.hidden = false
      create.hidden = true
    }
    reuse.addEventListener('click', () => commit('auto'))
    fresh.addEventListener('click', () => commit('new'))
    label.addEventListener('input', syncAo4)
    kind.addEventListener('change', syncAo4)
    onCommitKeys(label, { commit: () => commit('auto') })

    // 新建组整块占一行：它的三个控件只一起出现，不能和第一行的「用这个」混排
    const newGroup = document.createElement('div')
    newGroup.className = 'props-new-group'
    newGroup.hidden = true
    newGroup.append(label, kind, create, ao4)

    /** 形态跟着下拉走：占位空值两者都藏，选哨兵露新建组，选真实定义露「用这个」 */
    const syncShape = (): void => {
      const isNew = pick.value === NEW_OPTION
      newGroup.hidden = !isNew
      pickBtn.hidden = !pick.value || isNew
    }
    pick.addEventListener('change', syncShape)

    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'ghost'
    cancel.textContent = t('ui.props.cancel')
    cancel.addEventListener('click', () => this.closeForm())

    // 库里一条定义都没有时，空下拉是死路：直接切到「新建」并展开第二行。
    // ⚠️ 只有「没有定义」才算死路；「定义都在本块上」不是 —— 下拉里那些灰掉的项
    //    正是用户要的答案（本块已经有它，只是入口不在这个面板）。
    if (defs.length === 0) pick.value = NEW_OPTION
    syncShape()
    syncAo4()

    for (const el of [pick, pickBtn, cancel, newGroup]) form.appendChild(el)
    return form
  }

  /** 关掉当前打开的那个添加表单并重画（两个入口共用一份状态） */
  private closeForm(): void {
    this.formOpen = null
    this.render()
  }
}
