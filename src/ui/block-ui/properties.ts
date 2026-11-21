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
 * ⚠️ 四段已全部抽成宿主无关段（`fields-section.ts`／`declared-fields-section.ts`／
 *    `def-config-section.ts`／`system-section.ts`；身份与归属的内容在 `config-sections.ts`）——
 *    检视卡/抽屉/正文投影挂的是同一段。本文件只剩**装配职责**：段序、岛守卫
 *    （正被编辑的行整行保留）、宿主 chrome（行包装 ＋ 抬头 ＋ 添加入口）。
 *
 * ⚠️ 为什么块属性段内不分节：同一条属性出现在两节里会重复；只放一节又会让来源随标签顺序变化。
 *    平铺 ＋ 多来源标注两个问题都没有（顺序只影响行序）。
 * ⚠️ 但**声明**必须另成一段：它写 `_fieldDefs`、不是这一块的值；画成同一种行会让人
 *    把它当成另一条属性（也会诱导两个 picker 共用去重集合）。
 * ⚠️ 组件不写模型：所有写入经注入的回调（由装配层转成命令）。
 */
import type { Block, ClickMods } from '../../core/index.ts'
import { identityColorCss } from '../../core/index.ts'
import { inputSession } from '../../view/editor/input-session.ts'
import { EDIT_ISLAND_ATTR } from '../../view/editor/block-dom.ts'
import type { FieldRow, PropKind } from '../../core/index.ts'
import type { PropCreateMode } from '../../core/infra/ports.ts'
import {
  aliasesOf,
  prop,
  refViewOf,
  valueListOf,
  type RefDomain,
} from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import { renderIcon } from '../../view/icons.ts'
import type { ChoiceActions } from './choices-editor.ts'
import {
  belongsContent,
  displayContent,
  listsContent,
  namesContent,
  tagsContent,
  type ConfigSectionsCtx,
} from './config-sections.ts'
import { DefConfigSection } from './def-config-section.ts'
import { DeclaredFieldsSection } from './declared-fields-section.ts'
import { PropsDraftState, toggleDraftForm, type PropsAddFormDeps } from './props-add-form.ts'
import { labeledRow, sectionHead, stackedRow } from './props-chrome.ts'

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
   * **传没传是「看法落面」的门**：开了岛的面（`inlineRefIsland`）才用它，ref 值
   * 否则照旧画引用 chip——inline 是 opt-in 的看法，一个面一个面验观感。
   * 当前产品面都关着这一档（原地编辑先撤），机器留作口子；表格格子永不传（N 行 ×
   * N 座岛是真实性能面，要先量）。
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
   * **`ref` 定义的候选域**（`_refDomain` 软约束）的三个入口：标签、指定块、查询。
   *
   * 选择器必须经装配层开（浮层不归组件）；标签这一档收已有清单当排除项 ——
   * 第二次为同一个标签点「＋」不该再多给一条同样的 chip。
   */
  pickRefTag: (exclude: readonly string[], onPick: (tagId: string) => void, anchor: DOMRect) => void
  pickRefAnchor: (exclude: readonly string[], onPick: (blockId: string) => void, anchor: DOMRect) => void
  pickRefQuery: (onPick: (queryId: string) => void, anchor: DOMRect) => void
  /** 写候选域（`null` ＝ 不限，摘键） */
  setRefDomain: (defId: string, domain: RefDomain | null) => void
  toast: (text: string, kind?: 'ok' | 'warn' | 'info') => void
}

/**
 * 值控件族（按 kind 的值控件／多值 chips／ref 值 inline 岛）住 `./value-editor.ts`；
 * **属性值段**（行渲染器与其最小能力包）住 `./fields-section.ts`。
 * 本文件从那里再导出，**对外的符号名不变**（表格格子、行内浮层照旧 import 这里）。
 */
export { makeCellEditor } from './value-editor.ts'
export { makeFieldRow, type FieldRowDeps } from './fields-section.ts'
export type { CellEditorDeps, CellEditorSurface, RefIslandDeps } from './value-editor.ts'
import { disposeRefIslandsIn, ensureRefIslandsIn } from './value-editor.ts'
import type { RefIslandDeps } from './value-editor.ts'
import { FieldsSection } from './fields-section.ts'
import { systemSection } from './system-section.ts'

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

export class PropertiesPanel {
  private readonly els: PropertiesEls
  private readonly deps: PropertiesDeps
  /**
   * 这个实例的 ref 值行装不装 inline 岛（`_refView: 'inline'` 时）。
   *
   * **当前所有实例都是关的**：产品面一律画引用 chip（原地编辑的复杂度大于收益，
   * 侧槽编辑已够用）。开关与它下游的装配整包留着——要开时只改各宿主传的这个
   * 参数，值行不在两条路径上各写一套。
   */
  private readonly inlineRefIsland: boolean
  /**
   * 两个添加入口共用的草稿行状态（own 表单在这里构造，声明表单在段里构造；
   * 互斥靠同一个槽位——同时开着会让「点了哪个」不可知）。
   */
  private readonly draft = new PropsDraftState()
  /** 草稿行需要的最小能力（own 表单与声明段各取所需，读的都是同一份 deps） */
  private readonly formDeps: PropsAddFormDeps
    /**
     * **抽出的段**：属性值／定义值配置／字段声明（一套内容、多宿主可挂）。
     *
     * 段只长内容与交互、不认识宿主：写能力由 deps 注入，「写完谁重画」由段的
     * `repaint` 带回这里的整卡重画。检视卡与抽屉两个壳都是本面板，
     * 所以挂的都是同一段；正文投影宿主挂同一段组件，不再抄第二份。
     * 面板本身只剩装配职责：段序（值 → 类型专属 → 块配置 → 系统信息）、
     * 岛守卫（正被编辑的行整行保留）与宿主 chrome（行包装 ＋ 抬头）。
     */
    private readonly fields: FieldsSection
    private readonly defConfig: DefConfigSection
    private readonly declared: DeclaredFieldsSection

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
    this.formDeps = {
      defs: this.deps.defs,
      rows: this.deps.rows,
      tags: this.deps.tags,
      fieldDeclarations: this.deps.fieldDeclarations,
      toast: this.deps.toast,
    }
    this.fields = new FieldsSection({
      // ref 值 inline 岛的门在这里：没开岛的面把装配摘掉，ref 值行照旧画引用 chip
      // （`inlineRefIsland` 是每个面板实例的固定开关，门在装配点判一次即可）
      refIsland: this.inlineRefIsland ? this.deps.refIsland : undefined,
      pickChoice: this.deps.pickChoice,
      pickAsset: this.deps.pickAsset,
      tagName: this.deps.tagName,
      openRef: this.deps.openRef,
      activateAsset: this.deps.activateAsset,
      refIcon: this.deps.refIcon,
      add: this.els.add,
      draft: this.draft,
      form: this.formDeps,
      addOwnProp: this.deps.addOwnProp,
      createOwnDef: this.deps.createOwnDef,
      repaint: () => this.render(),
      shortId: this.deps.shortId,
      setValue: this.deps.setValue,
      clearValue: this.deps.clearValue,
      pickRef: this.deps.pickRef,
      refLabel: this.deps.refLabel,
    })
    this.defConfig = new DefConfigSection({
      def: () => this.deps.target() ?? undefined,
      repaint: () => this.render(),
      choices: this.deps.choices,
      setFormat: this.deps.setFormat,
      setRefDomain: this.deps.setRefDomain,
      pickRefTag: this.deps.pickRefTag,
      pickRefAnchor: this.deps.pickRefAnchor,
      pickRefQuery: this.deps.pickRefQuery,
      blockById: (id: string) => this.deps.blockById(id),
      shortId: this.deps.shortId,
      openRef: this.deps.openRef,
      tags: base.tags,
      tagName: base.tagName,
      pickIcon: base.pickIcon,
    })
    this.declared = new DeclaredFieldsSection({
      owner: () => this.deps.target() ?? undefined,
      repaint: () => this.render(),
      declaredFields: this.deps.declaredFields,
      undeclareField: this.deps.undeclareField,
      openRef: this.deps.openRef,
      draft: this.draft,
      declareProp: this.deps.declareProp,
      createDeclaredDef: this.deps.createDeclaredDef,
      form: this.formDeps,
      choices: this.deps.choices,
      blockById: base.tagById,
      tags: base.tags,
      tagName: base.tagName,
      pickIcon: base.pickIcon,
    })
    this.els.add.textContent = t('ui.props.addShort')
    this.els.add.dataset.tip = t('ui.props.add')
    this.els.add.addEventListener('click', () => {
      toggleDraftForm(this.draft, 'own')
      // 只有「这一次打开」才抢焦点：别的路径触发的重画不许把焦点拽回草稿行
      this.render()
    })
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
    if (!islandHold) this.els.body.appendChild(this.fields.render(target, rows, labels))

    /**
     * **标签属性**（字段声明）与**定义块的值配置**：两段已抽成宿主无关段
     * （`declared-fields-section.ts`／`def-config-section.ts`）。
     * 判据（「只有标签有声明段」「只有定义块有值配置」）与挂载条件在段里——
     * 返回 null 宿主就不挂；这里只排段序：类型专属段跟在值段之后。
     */
    const declared = this.declared.render(labels)
    if (declared) this.els.body.appendChild(declared)

    const defConfig = this.defConfig.render()
    if (defConfig) this.els.body.appendChild(defConfig)

    // 块配置是低频的「它是谁」，排在值与其类型专属配置之后
    this.els.body.appendChild(this.buildConfig(target))

    // 系统信息在**最后**：它是这一块的出生与改动记录，不是可编辑的数据
    this.els.body.appendChild(systemSection(target))
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
    ensureRefIslandsIn(this.els.body)
  }

  /** 面板收起/换主体：全部岛退役——岛的订阅不比面板活得久 */
  private retireAllIslands(): void {
    disposeRefIslandsIn(this.els.body)
  }

  /**
   * **块配置段**：身份（名字／脸／露面／显示）与分类（标签／属于）。
   *
   * 它是低频的「这块是谁」，所以排在属性值之后；段内顺序与块配置弹窗同一条
   * （两个壳是同一个配置体，段序同一份），只是这一个壳多了一圈段头。
   * 名字排在脸之前：别名是这块的地址（改名的频度高于换脸），脸是识别的装饰。
   */
  private buildConfig(target: Block): HTMLElement {
    const section = document.createElement('section')
    section.className = 'props-section prop-config'
    section.appendChild(sectionHead('lucide:sliders-horizontal', t('ui.blockConfig.title')))

    section.appendChild(this.buildNames(target))
    // 脸：一枚入口开块配置弹窗（弹窗里脸面板直接展开）——任意块都有脸，入口不按露面位限流
    if (this.deps.pickFace) section.appendChild(this.buildFace(target))
    section.appendChild(this.buildLists(target))
    const display = this.buildDisplay(target)
    if (display) section.appendChild(display)
    section.appendChild(this.buildTags(target))
    section.appendChild(this.buildBelongs(target))
    return section
  }

  /** 身份/归属段的能力包（每次现建：块与「写完谁重画」都是这一次的） */
  private cfg(target: Block): ConfigSectionsCtx {
    return this.deps.configOps(target.id, () => this.render())
  }

  /**
   * **名字段**（别名＋添加）：与块配置弹窗共用同一份段（`config-sections.ts`）。
   * 面板壳是整宽小节（添加表单需要宽度），不是右值行。
   */
  private buildNames(target: Block): HTMLElement {
    const value = document.createElement('span')
    value.className = 'prop-value prop-names-value'
    value.appendChild(namesContent(this.cfg(target), this.els.body))
    return stackedRow('prop-names', t('ui.alias.title'), value, 'lucide:at-sign')
  }

  /** **露面段**（page/tag 列表位）：与弹窗共用同一份段 */
  private buildLists(target: Block): HTMLElement {
    return labeledRow('prop-lists', t('ui.alias.lists'), listsContent(this.cfg(target)), 'lucide:layers')
  }

  /** **显示模式段**：有别名才画（「这一行的头显示什么」没有名字就没有答案） */
  private buildDisplay(target: Block): HTMLElement | null {
    if (aliasesOf(target).length === 0) return null
    return labeledRow('prop-display', t('ui.alias.display'), displayContent(this.cfg(target)), 'lucide:eye')
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
    const value = belongsContent(this.cfg(target))
    // 同标签行：「＋」住进行头；悬空清理仍跟着值走（那是值自己的动作）
    const add = value.querySelector<HTMLElement>('.props-belong-add')
    add?.remove()
    return stackedRow('prop-belongs', t('ui.belongs.title'), value, 'lucide:folder-tree', add ?? undefined)
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
    renderIcon(ico, prop<string>(target, '_icon'), 'circle-help', 'md')
    btn.appendChild(ico)
    const color = prop<string>(target, '_color')
    if (color !== undefined) {
      const dot = document.createElement('span')
      dot.className = 'prop-face-dot'
      dot.style.setProperty('--swatch', identityColorCss(color))
      btn.appendChild(dot)
    }
    btn.addEventListener('click', () => this.deps.pickFace?.(target, btn.getBoundingClientRect()))
    return labeledRow('prop-face', t('ui.iconPicker.faceEntry'), btn, 'lucide:palette')
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
    const value = tagsContent(this.cfg(target))
    // 「＋」住进行头（面板壳的 chrome 重排；共享段里它跟着值走，弹窗仍那样）：
    // 空态时它独占一行读作「标签下面又一行字」，有 chips 时动作也总在同一个位置
    const add = value.querySelector<HTMLElement>('.props-tag-add')
    add?.remove()
    return stackedRow('prop-tags', t('ui.props.tagsTitle'), value, 'lucide:tag', add ?? undefined)
  }

}
