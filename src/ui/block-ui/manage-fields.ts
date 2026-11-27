/**
 * **主体行下的管理档**：单主体屏的根行下面那一段属性（值段 ＋ 标签声明段）。
 *
 * 它不是第二个编辑器：值段／声明段就是抽屉与检视卡挂的同一份组件
 * （`fields-section.ts`／`declared-fields-section.ts`），写路径、行的派生、
 * 显示名的口径一个字节没变。这一档只回答两件事——
 *   · **这一块此刻长什么样**：有值的字段全显（不按密度档截）；
 *   · **还差什么**：一行 `+N 项待填`，点开就地展开（再点收起）。
 *
 * 三条判据（改形状之前先读）：
 *  1. **不画 gutter 字段**：`_uiPosition: block-left` 的 `select`/`checkbox` 在块标旁
 *     已经有那一格，行下再画一次就是 30px 内两个可编辑控件（判据 `isGutterRow`）。
 *     整组声明都是 gutter 字段的标签因此在这里一条都不剩——它不出，不是被筛掉。
 *  2. **不放添加入口**：加属性／加声明是 schema 变更，归抽屉；行脸只回答「已有的这些，
 *     值是什么」。所以两段都以 `bare` 挂（`bare` = 不画 `＋` 与草稿行）。
 *  3. **只有「块的真实位置」挂它**：镜像／查询结果／挂载区／单元格在构造上就不接
 *     这个宿主（与「正文里的结果体」同一条纪律），否则每个单根岛都会长出一块面板。
 *
 * ⚠️ **`slots` 与渲染必须同一份判据**：虚拟化的行高估算是这里算的
 *    （`visibleRowHeight` 的 `manageRows`），渲染多画一行而这里没算，滚动条就系统性
 *    偏小——那种偏差不报错，只在滚到底部时露出来（与 `belowFieldsRows` 同一条纪律）。
 */
import type { Block, ManagePlan } from '../../core/index.ts'
import { hasList, planManageFields } from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import { FieldsSection } from './fields-section.ts'
import { DeclaredFieldsSection } from './declared-fields-section.ts'
import { PropsDraftState } from './props-add-form.ts'
import type { PropertiesDeps } from './properties.ts'

export type { ManagePlan }

export interface ManageFieldsOpts {
  /** 这一档画在哪块上（活引用：撤销／换库之后旧引用可能已不在森林里） */
  target: () => Block | undefined
  /** 「待填」此刻是不是展开着（会话态，归装配层） */
  pendingOpen: () => boolean
  /** 点 `+N` 行：展开 ⇄ 收起。宿主负责落状态并重画这一行（估高跟着变） */
  onTogglePending: () => void
  /** 写完谁重画（段内的写回调经它回到宿主） */
  repaint: () => void
}

export class ManageFieldsSection {
  private readonly deps: PropertiesDeps
  private readonly opts: ManageFieldsOpts
  private readonly fields: FieldsSection
  private readonly declared: DeclaredFieldsSection

  constructor(deps: PropertiesDeps, opts: ManageFieldsOpts) {
    this.deps = deps
    this.opts = opts
    const form = {
      defs: deps.defs,
      rows: deps.rows,
      tags: deps.tags,
      fieldDeclarations: deps.fieldDeclarations,
      toast: deps.toast,
    }
    this.fields = new FieldsSection({
      // `add` 故意不给：行脸不提供 schema 变更的入口（见文件头判据 ②）
      shortId: deps.shortId,
      setValue: deps.setValue,
      clearValue: deps.clearValue,
      pickRef: deps.pickRef,
      pickChoice: deps.pickChoice,
      pickAsset: deps.pickAsset,
      refLabel: deps.refLabel,
      tagName: deps.tagName,
      openRef: deps.openRef,
      activateAsset: deps.activateAsset,
      refIcon: deps.refIcon,
      // ref 值照旧画引用 chip：这一档是读值面，原地岛先不开（与抽屉同一个默认）
      draft: new PropsDraftState(),
      form,
      addOwnProp: deps.addOwnProp,
      createOwnDef: deps.createOwnDef,
      repaint: opts.repaint,
    })
    this.declared = new DeclaredFieldsSection(
      {
        owner: () => this.opts.target(),
        repaint: opts.repaint,
        declaredFields: deps.declaredFields,
        undeclareField: deps.undeclareField,
        openRef: deps.openRef,
        // `bare` 下草稿行永远关着，这份状态只是签名要求（与真草稿互斥无关）
        draft: new PropsDraftState(),
        declareProp: deps.declareProp,
        createDeclaredDef: deps.createDeclaredDef,
        form,
        choices: deps.choices,
        blockById: deps.blockById,
        tags: deps.allTags,
        tagName: deps.tagName,
        pickIcon: deps.pickIcon,
        recentColors: deps.recentColors,
      },
      { bare: true },
    )
  }

  /** 画这一块的这一档；`null` ＝ 这一块没有可画的东西（宿主不挂） */
  render(target: Block): HTMLElement | null {
    // 声明段的准入与 `DeclaredFieldsSection.render` 同一条：带 `tag` 露面的块才有
    const declared = hasList(target, 'tag')
    const plan = planManageFields(this.deps.rows(target), this.opts.pendingOpen(), declared)
    if (!plan) return null
    const root = document.createElement('div')
    root.className = 'blk-manage'
    root.dataset.manageBlock = target.id
    /**
     * **Enter 家族的键在表单控件上归控件自己，不往上传**。
     *
     * 这一档住在块编辑器里：整片编辑区是一个 contenteditable 容器，而 `↵`/`⇧↵`/`⌥↵`/
     * `⌘⇧↵` 都挂在「编辑器有文本焦点」上——不拦的话，在一个输入框里按回车会当场
     * 拆块／建子块（`editorTextFocus` 只看焦点在不在容器里，不看是不是表单控件）。
     * 行内小输入框早有一条同样的拦法（`onCommitKeys` 的 `stop`），这里是它的宿主级兜底：
     * 控件自己的行为（提交、选集、按钮激活）照常，外层收不到这一下。
     */
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      const t = e.target as HTMLElement | null
      if (!t?.closest('input, textarea, select, button')) return
      e.stopPropagation()
    })
    if (plan.rows.length > 0) {
      root.appendChild(this.fields.render(target, plan.rows, this.deps.propLabels()))
    }
    if (plan.pendingTotal > 0) root.appendChild(this.pendingLine(target.id, plan))
    if (plan.declared) {
      const declaredEl = this.declared.render(this.deps.propLabels())
      if (declaredEl) root.appendChild(declaredEl)
    }
    return root
  }

  /**
   * 那一行 `+N 项待填`。
   *
   * 两种状态共用一颗按钮：收起时是「还有几栏没填」，展开时是「收起」——
   * 展开本身不该再开第二个入口（面板里靠 `⋯` 菜单收起过一次，用户找不到它）。
   * 待填的栏展开后就是普通的字段行（`FieldsSection` 画，值控件现成）。
   */
  private pendingLine(blockId: string, plan: ManagePlan): HTMLElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'blk-manage-pending'
    btn.dataset.managePending = blockId
    btn.dataset.open = plan.open ? '1' : '0'
    btn.setAttribute('aria-expanded', plan.open ? 'true' : 'false')
    btn.textContent = plan.open
      ? t('ui.props.managePendingClose')
      : t('ui.props.managePending', { n: plan.pendingTotal })
    btn.dataset.tip = t('ui.props.managePendingHint')
    btn.addEventListener('click', () => {
      this.opts.onTogglePending()
      this.opts.repaint()
    })
    return btn
  }
}
