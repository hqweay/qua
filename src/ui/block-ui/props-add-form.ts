/**
 * **添加属性的草稿行**：own（这一块自己的值）与 declared（字段声明）两个入口共用一份形状。
 *
 * 差异只有四处（槽 / 外层类名 / 两条按钮文案 / 两个回调），所以收成一份：
 * 创建是主路径（名字＋类型，Enter 提交），浏览已有定义收在次级开关后面——
 * 分两份写就会出现「一个表单 Enter 能用、另一个不能」。
 *
 * 开合状态住在装配层（`PropsDraftState`）而不是 DOM 上：宿主会随焦点变化整卡重建，
 * 状态写在 DOM 上一次重建就被拔掉；两个入口共用一个槽位（`formOpen`），
 * 同时开着会让「点了哪个」变得不可知。谁重建谁照着摆。
 *
 * ⚠️ **同名不是错**：输入已有同名同 kind 时，两个动作同时可见——
 *    复用（默认，误复用可无损改回）与新建同名属性（另一个 `propId`，各自有值）。
 */
import type { Block, FieldRow, PropKind } from '../../core/index.ts'
import {
  PROP_KINDS,
  declaredFieldIds,
  displayNameOf,
  formatOf,
  hasList,
  normalizeAlias,
  propKindOf,
  propLabel,
} from '../../core/index.ts'
import type { PropCreateMode } from '../../core/infra/ports.ts'
import { t } from '../../core/infra/msg.ts'
import { plainText } from '../../core/model/runs.ts'
import { onCommitKeys } from './keys.ts'

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
 * 两个添加入口共用的草稿行状态（住装配层，跨宿主重建保留）。
 *
 * `formOpen` 不能是一个布尔：own 写 `_ownProps`、declared 写 `_fieldDefs`，
 * 两个入口写的是两个槽，同时开着会让「点了哪个」变得不可知——打开一个就关掉另一个。
 */
export class PropsDraftState {
  /** 哪个添加表单开着：`own`（这一块自己的值）／`declared`（标签属性／字段声明）／`null` */
  formOpen: 'own' | 'declared' | null = null
  /**
   * 「这一次打开草稿行才聚焦」的旗：添加入口点下时置位，草稿行构造时消费
   * （聚焦＋滚进视口），别的路径触发的重画不许抢焦点。
   */
  draftFocusPending = false
  /**
   * 草稿行次级「浏览已有定义」的开合。**跨重建保留**：开合若只写在 DOM 上，
   * 一次重建就把展开的下拉收回去（用户刚点到一半）；与 `formOpen` 同一待遇。
   */
  browseOpen = false
}

/**
 * 两个入口共用的开合：打开一个槽就关掉另一个（同一个槽位），
 * 只有「这一次打开」才置焦点旗（别的路径触发的重画不许抢焦点）。
 */
export function toggleDraftForm(draft: PropsDraftState, slot: 'own' | 'declared'): void {
  const opening = draft.formOpen !== slot
  draft.formOpen = opening ? slot : null
  draft.draftFocusPending = opening
}

/** 草稿行需要的**最小能力**：复用下拉的候选与本块的现状（值行／标签／声明） */
export interface PropsAddFormDeps {
  /** 森林里全部定义（「浏览已有定义」的候选） */
  defs: () => Block[]
  /** 本块现有的值行（own 槽去重） */
  rows: (b: Block) => FieldRow[]
  /** 这块带着哪些标签（own 槽 picker 的「本标签」分组用） */
  tags: (b: Block) => Block[]
  /** `propId → 声明它的标签`（picker 的「本标签／未声明／其他标签」分组用） */
  fieldDeclarations: () => ReadonlyMap<string, readonly Block[]>
  /** 拒绝/提示（空名字） */
  toast: (text: string, kind?: 'ok' | 'warn' | 'info') => void
}

/** 这个表单写哪个槽：own ＝ `_ownProps`，declared ＝ `_fieldDefs` */
export interface PropsAddFormSlot {
  slot: 'own' | 'declared'
  className: string
  pick: string
  use: string
  onUse: (propId: string) => void
  onCreate: (label: string, kind: PropKind, mode?: PropCreateMode, format?: string) => void
}

/**
 * 草稿行本体。`draft` 由宿主注入（own 与 declared 共用同一个槽位）；
 * `onClose` 是「关掉之后谁重画」——写完谁重画由 ctx 带，表单不自画。
 */
export function buildAddForm(
  target: Block,
  labels: ReadonlyMap<string, string>,
  opts: PropsAddFormSlot,
  deps: PropsAddFormDeps,
  draft: PropsDraftState,
  onClose: () => void,
): HTMLElement {
  const closeForm = (): void => {
    draft.formOpen = null
    draft.browseOpen = false
    onClose()
  }

  const form = document.createElement('form')
  form.className = opts.className
  form.addEventListener('submit', (e) => e.preventDefault())

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
  const defs = deps.defs()
  const declarations = deps.fieldDeclarations()
  const rows = new Set(deps.rows(target).map((r) => r.propId))
  const declared = hasList(target, 'page') || hasList(target, 'tag') ? new Set(declaredFieldIds(target)) : new Set<string>()

  /**
   * picker 分组：**本标签 / 未声明 / 其他标签**。
   * 它只是 `_fieldDefs` 的分组视图，不是第二份归属；其他标签的属性**不隐藏**
   * （藏起来会让下拉看起来是空的，用户以为库里没有那条属性）。
   */
  const ownTags =
    opts.slot === 'declared' ? (hasList(target, 'page') || hasList(target, 'tag') ? [target] : []) : [...deps.tags(target)]
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

  const pickBtn = document.createElement('button')
  pickBtn.type = 'button'
  pickBtn.className = 'props-use'
  pickBtn.textContent = opts.use
  pickBtn.addEventListener('click', () => {
    if (!pick.value) return
    opts.onUse(pick.value)
    closeForm()
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
      deps.toast(t('ui.props.needLabel'), 'warn')
      return
    }
    const picked = pickedOf()
    const match = matchNow()
    opts.onCreate(name, picked.kind, mode === 'new' ? 'new' : match ? 'reuse' : undefined, picked.format)
    closeForm()
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

  // 新建组整块占一行：名字、类型与提交是创建的主路径，草稿行常开这一形态
  const newGroup = document.createElement('div')
  newGroup.className = 'props-new-group'
  newGroup.append(label, kind, create, ao4)
  form.appendChild(newGroup)

  /**
   * **浏览已有定义收进次级**：AO4 只做精确的同名同 kind 匹配，覆盖不了
   * 「不记得确切名字、想翻一遍库里有什么」——分组下拉（含禁用标记）原样
   * 保留在这道开关后面。库里一条定义都没有时次级区整个不画（空下拉是死路；
   * 「定义都在本块上」不算——那些灰掉的项正是用户要的答案）。
   */
  const secondary = document.createElement('div')
  secondary.className = 'props-secondary'
  if (defs.length > 0) {
    const browseToggle = document.createElement('button')
    browseToggle.type = 'button'
    browseToggle.className = 'props-browse-toggle'
    browseToggle.textContent = t('ui.props.browseExisting')
    const browse = document.createElement('div')
    browse.className = 'props-browse'
    browse.hidden = !draft.browseOpen
    browseToggle.addEventListener('click', () => {
      draft.browseOpen = !draft.browseOpen
      browse.hidden = !draft.browseOpen
      if (!browse.hidden) pick.focus()
    })

    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'ghost'
    cancel.textContent = t('ui.props.cancel')
    cancel.addEventListener('click', () => closeForm())

    browse.append(pick, pickBtn, cancel)
    secondary.append(browseToggle, browse)
    form.appendChild(secondary)
  }

  // Esc 收起草稿行：焦点在行内任何控件上都生效（名字输入/类型/浏览下拉）
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeForm()
  })

  syncAo4()

  // 打开的那一次：名字输入聚焦＋滚进视口（构造时表单还没挂进文档，等一帧）
  if (draft.draftFocusPending) {
    draft.draftFocusPending = false
    requestAnimationFrame(() => {
      label.focus()
      form.scrollIntoView({ block: 'nearest' })
    })
  }
  return form
}
