/**
 * **字段声明段**（标签属性）：我的成员会有哪些格子。
 *
 * 判据：声明是「我的成员/子块会有这一格」，不是「给这一块设一个值」——
 * 所以这一段只有清单和解除，没有值控件。值仍旧只在成员块上。
 *
 * ⚠️ 这一段**自带**自己的添加入口：它写 `_fieldDefs`，而「＋ 添加属性」写的是
 *    `_ownProps`。两个槽两个入口，共用一个入口就必须按块类型猜意图，而标签块恰好两个都需要。
 *
 * ⚠️ 这一段**不是一条属性行**（`props-section`，不是 `prop-row`）：视觉上它必须和
 *    「这一块自己的值」分开，否则用户会把声明当成另一条属性——去重也就跟着混了。
 *
 * ⚠️ 解除声明**不动值**：成员块上已有的值落回「本块自有」，重新声明后自动回来。
 *
 * ⚠️ **页不再有这一段**。页声明过 `_fieldDefs`，但**没有任何消费方**——子块不会因此
 *    获得那些字段，于是它只是「一个能写、没人读的值」。一个写进去却永远不会生效的入口
 *    比没有入口更糟：用户会以为「声明了，成员就有这一格了」。继承是另一个设计
 *    （需要先定「页的子块」与「标签的成员」谁说了算），在定下来之前，这一格就不该可写。
 *
 * 段不认识宿主，可被多个壳挂载（抽屉／将来的就地投影）：
 * 写能力由 deps 注入（命令面），「写完谁重画」由 `repaint` 带；草稿行的开合状态
 * 由宿主注入（`PropsDraftState`）——own 表单与声明表单共用一个槽位，
 * 同时开着会让「点了哪个」不可知，这个互斥是宿主的布局决定，不是段的。
 */
import type { Block, ClickMods, PropKind } from '../../core/index.ts'
import { hasList, clickModsOf, propKindOf } from '../../core/index.ts'
import type { PropCreateMode } from '../../core/infra/ports.ts'
import { t } from '../../core/infra/msg.ts'
import { plainText } from '../../core/model/runs.ts'
import { sectionInfo } from '../../view/info.ts'
import { chipDel } from './config-sections.ts'
import { sectionHead } from './props-chrome.ts'
import { ChoicesEditor, type ChoiceActions } from './choices-editor.ts'
import { buildAddForm, toggleDraftForm, type PropsAddFormDeps, type PropsDraftState } from './props-add-form.ts'

export interface DeclaredFieldsSectionDeps {
  /** 主体块活引用（每次现取：撤销/换库后旧引用可能已经不在森林里） */
  owner: () => Block | undefined
  /** 写完谁重画（ctx 带）：宿主接自己的重画（抽屉＝整面板重画） */
  repaint: () => void
  /** 页/标签声明给成员的那些属性定义（`_fieldDefs` 的活块） */
  declaredFields: (b: Block) => Block[]
  /** 解除一条声明（只摘清单；成员块上的值一个字节不动） */
  undeclareField: (b: Block, propId: string) => void
  /** chip 名字可点＝打开定义块（与属性行的名字、标签 chip 的名字同一契约） */
  openRef: (to: string, mods: ClickMods) => void
  /* ---- 草稿行（声明槽） ---- */
  /** 开合状态由宿主注入：own 表单与声明表单共用一个槽位（互斥是宿主的布局决定） */
  draft: PropsDraftState
  /** 把已有属性**声明给成员**（写 `_fieldDefs`） */
  declareProp: (b: Block, propId: string) => void
  /** 新建一条定义并**声明给成员**（`format` ＝ text 格式轴） */
  createDeclaredDef: (b: Block, label: string, kind: PropKind, mode?: PropCreateMode, format?: string) => void
  /** 草稿行需要的最小能力（复用下拉的候选与本块的现状） */
  form: PropsAddFormDeps
  /* ---- 选项编辑器（标签视角） ---- */
  /** 选项的写入口（命令面；组件不直接改块） */
  choices: ChoiceActions
  /** 按 id 读块（选项编辑器判「来源标签还在不在」） */
  blockById: (id: string) => Block | undefined
  /** 全库标签（选项作用域的勾选候选） */
  tags: () => readonly Block[]
  /** 标签块的显示名（作用域徽标里的 `#名`） */
  tagName: (id: string) => string
  /** 给选项选一个图标（装配层开浮层；未接 ⇒ 图标只读） */
  pickIcon?: (
    anchor: DOMRect,
    current: string,
    onPick: (icon: string) => void,
    trigger?: HTMLElement,
    face?: { color: string; onColor: (color: string) => void; recentColors: () => readonly string[] },
  ) => void
  /** 最近自定义色（设备态），与块脸选择器共用 */
  recentColors?: () => readonly string[]
}

export class DeclaredFieldsSection {
  private readonly deps: DeclaredFieldsSectionDeps
  /**
   * 选项编辑器的标签视角实例（记住「哪个作用域面板展开着」）。
   *
   * 状态必须在实例里而不是组件 DOM 里：勾一个标签会写一次模型，
   * 宿主随后整体重画——状态存在 DOM 上就会被这次重画连根拔掉。
   */
  private readonly choicesTag: ChoicesEditor
  /** 标签视角打开的是哪条属性的选项（chip 上的「选项」按钮切换它） */
  private tagChoices: { def: Block; owner: Block } | null = null

  constructor(deps: DeclaredFieldsSectionDeps) {
    this.deps = deps
    this.choicesTag = new ChoicesEditor({
      def: () => this.tagChoices?.def,
      tagById: deps.blockById,
      tags: deps.tags,
      write: deps.choices,
      tagName: deps.tagName,
      pickIcon: (anchor, current, onPick, trigger, face) =>
        deps.pickIcon?.(anchor, current, onPick, trigger, face),
      recentColors: deps.recentColors,
      // 标签视角只该看「对本标签可见」的那几条；页的声明段没有「标签作用域」可言
      // （`_fieldDefs` 在页上还没有消费方）：走全量视角
      focusTag: () => {
        const open = this.tagChoices
        return open && hasList(open.owner, 'tag') ? open.owner.id : ''
      },
    })
  }

  /** 主体不带 tag 露面 ⇒ 不画（返回 null，宿主不挂） */
  render(labels: ReadonlyMap<string, string>): HTMLElement | null {
    const target = this.deps.owner()
    if (!target || !hasList(target, 'tag')) return null

    // 走到这里只可能是标签（页那一段已移除，见文件头判据）
    const section = document.createElement('section')
    // `prop-declared` 是既有断言的选择器锚点（`.prop-declared [data-declared-prop-id]`），
    // `props-declared` 是这一段自己的名字（新的断言与样式用它）
    section.className = 'prop-declared props-declared props-section'
    section.dataset.declaredSection = 'tag'

    const defs = this.deps.declaredFields(target)
    const head = sectionHead('lucide:tag', t('ui.props.tagPropsTitle'), defs.length)

    /**
     * 这一段的添加入口与草稿行同 own 段一条口径：长在段尾（清单的追加位），
     * 不在段头——「往这列清单加一条」的动作跟着落点走。
     * `data-declare-add` 是给断言认「这是声明那一个，不是自己的值那一个」的。
     */
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'props-add props-declare-add'
    add.dataset.declareAdd = '1'
    add.textContent = t('ui.props.addTagProp')
    add.dataset.tip = t('ui.props.addTagPropTitle')
    add.addEventListener('click', () => {
      toggleDraftForm(this.deps.draft, 'declared')
      this.deps.repaint()
    })
    // 说明退成段头上的 ⓘ：解释不占正文宽度，悬停/聚焦可读（文案同 `ui.props.tagPropsHint`）
    head.appendChild(sectionInfo(t('ui.props.tagPropsHint')))

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
          this.deps.repaint()
        })
        chip.append(opt)
      }
      const del = chipDel(t('ui.props.undeclare'), () => this.deps.undeclareField(target, def.id))
      chip.append(text, del)
      list.appendChild(chip)
    }
    section.appendChild(list)

    const openChoices = this.tagChoices && this.tagChoices.owner.id === target.id ? this.tagChoices : null
    if (openChoices) {
      this.choicesTag.render()
      section.appendChild(this.choicesTag.root)
    }

    // 草稿行贴着清单（新声明的落点），追加入口收段尾
    if (this.deps.draft.formOpen === 'declared') section.appendChild(this.buildDeclareForm(target, labels))
    section.appendChild(add)
    return section
  }

  /**
   * **添加标签属性 / 字段声明**（只有页/标签有这个入口）。
   *
   * 与 own 表单的差别是「挂到哪个槽」、`slot` 的去重口径和文案；形状完全共用一份——
   * 两处各写一份表单迟早会长出两种键盘行为（Enter 提交 / Esc 取消 / 新建哨兵）。
   */
  private buildDeclareForm(target: Block, labels: ReadonlyMap<string, string>): HTMLElement {
    const isTag = hasList(target, 'tag')
    return buildAddForm(
      target,
      labels,
      {
        slot: 'declared',
        className: 'props-form props-form--declared',
        pick: t(isTag ? 'ui.props.pickTagProp' : 'ui.props.pickPageField'),
        use: t('ui.props.useDeclared'),
        onUse: (propId) => this.deps.declareProp(target, propId),
        onCreate: (label, kind, mode, format) => this.deps.createDeclaredDef(target, label, kind, mode, format),
      },
      this.deps.form,
      this.deps.draft,
      this.deps.repaint,
    )
  }
}
