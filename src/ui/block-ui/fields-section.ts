/**
 * **属性值段**（高频工作区）：一行一条属性（同一 `propId` 只一行，被多个标签声明时
 * **来源并列**），每行标来源、待填显占位；段尾是添加入口与 own 草稿行（写 `_ownProps`）。
 *
 * 段不认识宿主（抽屉／行下管理档挂同一段）：行渲染器 `makeFieldRow` 与行内实例浮层共用
 * 一份（一处改了行布局，两处一起变）；写能力由 deps 注入，「写完谁重画」由 `repaint` 带。
 * 主体块、值行派生与显示名由宿主每次 render 传入——宿主要先算行（岛守卫用它），
 * 现成的派生直接喂给段，不重算第二遍。
 */
import type { Block, FieldRow, PropKind } from '../../core/index.ts'
import { clickModsOf, COLOR_PROP, enginePropText, identityColorCss, isColorValue, isEngineProp } from '../../core/index.ts'
import { allowsMany, displayNameOf, prop, refViewOf } from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import type { PropCreateMode } from '../../core/infra/ports.ts'
import { sectionHead } from './props-chrome.ts'
import type { PropsAddFormDeps, PropsDraftState } from './props-add-form.ts'
import { buildAddForm } from './props-add-form.ts'
import type { PropertiesDeps } from './properties.ts'
import { makeCellEditor } from './value-editor.ts'
import type { RefIslandDeps } from './value-editor.ts'

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

export interface FieldsSectionDeps extends FieldRowDeps {
  /**
   * 添加入口（宿主提供：宿主各一颗）。段负责把它放在段尾追加位——
   * 行清单的追加位就是新行落点，入口跟着落点走。
   *
   * **不给＝不画**：主体行下管理档只回答「已有的这些字段，值是什么」，
   * 加属性是 schema 变更，入口归抽屉（同样地，草稿行一并不画——没有入口能打开它）。
   */
  add?: HTMLButtonElement
  /** own 草稿行的开合状态（宿主持有：与声明段的草稿行共用一个槽位，互斥是宿主的布局决定） */
  draft: PropsDraftState
  /** own 草稿行的能力包（复用下拉的候选与本块的现状） */
  form: PropsAddFormDeps
  /** 把已有属性加进**这一块自己的值槽**（`_ownProps`） */
  addOwnProp: (b: Block, propId: string) => void
  /** 新建一条定义并加进**这一块自己的值槽**（`mode: 'new'` ＝ 同名也新建；`format` ＝ text 格式轴） */
  createOwnDef: (b: Block, label: string, kind: PropKind, mode?: PropCreateMode, format?: string) => void
  /** 写完谁重画（ctx 带）：宿主接自己的重画（抽屉＝整面板重画） */
  repaint: () => void
}

export class FieldsSection {
  private readonly deps: FieldsSectionDeps

  constructor(deps: FieldsSectionDeps) {
    this.deps = deps
  }

  /**
   * **属性段：这一块自己的值**。
   *
   * 段头给「属性」一个名字——没有段头时它与身份行混成一张平清单，
   * 「主次」就是从这里丢的：身份行是轻动作行，这里往下是表单区，节奏必须断开。
   *
   * 添加入口与草稿行都**长在段尾**：行清单的追加位就是新行落点（行序＝声明顺序，
   * 新行落末尾），点 ＋ 后草稿行在原位出现，反馈不跳变；入口本身也跟着落点走
   * （它不是卡级控件，卡体底部的旧位置看起来像在给别的段加东西）。
   */
  render(target: Block, rows: readonly FieldRow[], labels: ReadonlyMap<string, string>): HTMLElement {
    const fields = document.createElement('section')
    fields.className = 'props-section prop-fields props-section--primary'
    const fieldsHead = sectionHead('lucide:list', t('ui.block.properties'), rows.length)
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

    for (const row of rows) {
      fields.appendChild(makeFieldRow(row, target, this.deps, { labelCount, labels }))
    }
    // 草稿行在行清单末尾（新行落点）与追加入口之间；收起时入口独占段尾
    if (this.deps.add) {
      if (this.deps.draft.formOpen === 'own') fields.appendChild(this.buildForm(target, labels))
      fields.appendChild(this.deps.add)
    }
    return fields
  }

  /**
   * **添加「这一块自己的」属性**：选已有定义（默认复用）或新建一个。
   *
   * ⚠️ 这个表单只管一件事：往 `_ownProps` 里加一条。**标签属性／字段声明**有它自己的入口
   *    （`declared-fields-section.ts` 的草稿行），因为那是写另一个槽（`_fieldDefs`）、长在另一段下面。
   *    曾经这两件事共用一个表单，靠「这个块有没有 page/tag 露面」猜用户要哪个 ——
   *    于是标签块永远加不了自己的属性（真踩过）。
   *
   * ⚠️ **类型只属于「新建定义」，不属于「给这一块加一条属性」**：`_kind` 住在定义块上、
   *    全库一份，而「用这个」只吃一个 `propId`——选已有属性能配类型是假的。
   *    所以两件事分两行画：第一行选/复用，第二行（只在「新建」时出现）才是名字＋类型。
   */
  private buildForm(target: Block, labels: ReadonlyMap<string, string>): HTMLElement {
    return buildAddForm(
      target,
      labels,
      {
        slot: 'own',
        className: 'props-form props-form--own',
        pick: t('ui.props.pick'),
        use: t('ui.props.use'),
        onUse: (propId) => this.deps.addOwnProp(target, propId),
        onCreate: (label, kind, mode, format) => this.deps.createOwnDef(target, label, kind, mode, format),
      },
      this.deps.form,
      this.deps.draft,
      this.deps.repaint,
    )
  }
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
