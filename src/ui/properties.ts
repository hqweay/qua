/**
 * **属性区**（AA6：属性是块第一公民）。
 *
 * 形状是**一个平铺列表**，不是按标签分节：
 *   · 同一 `propId` 只出现一次（被多个标签声明时**来源并列**）；
 *   · 每行标来源：`来自 #A、#B`，没有标签声明就标「本块自有」；
 *   · 声明了但没填 ⇒ 仍在列表里，显示「待填」占位（这正是标签声明的意义）；
 *   · 顺序由数据层给（标签正文顺序 × `_fieldDefs` 顺序），本组件不重排。
 *
 * ⚠️ 为什么不分节：同一字段出现在两节里会重复；只放一节又会让来源随标签顺序变化。
 *    平铺 ＋ 多来源标注两个问题都没有（顺序只影响行序）。
 * ⚠️ 组件不写模型：所有写入经注入的回调（由装配层转成命令）。
 */
import type { Block } from '../core/index.ts'
import type { FieldRow, PropKind } from '../core/index.ts'
import { PROP_KINDS, propKindOf } from '../core/index.ts'
import { t } from '../core/msg.ts'

export interface PropertiesDeps {
  /** 当前属性区画在哪个块上（光标所在块；没有就退回当前对象） */
  target: () => Block | undefined
  /** 派生行（core 算好：声明 ∪ 自有，同一 propId 只一行） */
  rows: (b: Block) => FieldRow[]
  /** 森林里全部定义（「添加已有属性」用） */
  defs: () => Block[]
  /** 这个页/标签**声明**了哪些字段（不是值；值区在下面） */
  declared: (b: Block) => Block[]
  /** 短 id（未知属性的显示） */
  shortId: (id: string) => string
  setValue: (b: Block, propId: string, value: unknown) => void
  clearValue: (b: Block, propId: string) => void
  /** 把已有定义声明到 owner（页/标签）；普通块则给它加一个空值槽 */
  addField: (b: Block, propId: string) => void
  undeclare: (b: Block, propId: string) => void
  /** 新建定义（可同时声明/加槽） */
  createDef: (b: Block, label: string, kind: PropKind) => void
  toast: (text: string, kind?: 'ok' | 'warn' | 'info') => void
}

export interface PropertiesEls {
  root: HTMLElement
  title: HTMLElement
  body: HTMLElement
  add: HTMLButtonElement
}

/** 一行值的编辑器（按 kind）。返回控件元素 */
function valueEditor(row: FieldRow, commit: (v: unknown) => void): HTMLElement {
  const kind = row.kind
  if (kind === 'checkbox') {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'prop-check'
    box.checked = row.value === true
    box.addEventListener('change', () => commit(box.checked))
    return box
  }
  if (kind === 'select') {
    const sel = document.createElement('select')
    sel.className = 'prop-input'
    const choices = Array.isArray(row.def?.props?._choices) ? (row.def!.props!._choices as string[]) : []
    const opts = [...choices]
    const current = row.value === undefined || row.value === null ? '' : String(row.value)
    if (current !== '' && !opts.includes(current)) opts.unshift(current)
    const empty = document.createElement('option')
    empty.value = ''
    empty.textContent = t('ui.props.pending')
    sel.appendChild(empty)
    for (const c of opts) {
      const o = document.createElement('option')
      o.value = c
      o.textContent = c
      sel.appendChild(o)
    }
    sel.value = current
    sel.addEventListener('change', () => commit(sel.value === '' ? undefined : sel.value))
    return sel
  }
  const input = document.createElement('input')
  input.className = 'prop-input'
  input.type = kind === 'date' ? 'date' : 'text'
  if (kind === 'number') input.inputMode = 'decimal'
  input.placeholder = t('ui.props.pending')
  input.value = row.value === undefined || row.value === null ? '' : String(row.value)
  input.addEventListener('change', () => commit(input.value === '' ? undefined : input.value))
  return input
}

export class PropertiesPanel {
  private readonly els: PropertiesEls
  private readonly deps: PropertiesDeps
  private formOpen = false

  constructor(els: PropertiesEls, deps: PropertiesDeps) {
    this.els = els
    this.deps = deps
    this.els.title.textContent = t('ui.props.title')
    this.els.add.textContent = t('ui.props.add')
    this.els.add.addEventListener('click', () => {
      this.formOpen = !this.formOpen
      this.render()
    })
  }

  render(): void {
    const target = this.deps.target()
    if (!target) {
      this.els.root.hidden = true
      return
    }
    const rows = this.deps.rows(target)
    // 没有任何行、也没有「能声明字段」的角色 ⇒ 不占高度（普通内容块很常见）
    const canDeclare = target.roles?.includes('page') || target.roles?.includes('tag')
    if (rows.length === 0 && !canDeclare && !this.formOpen) {
      this.els.root.hidden = true
      return
    }
    this.els.root.hidden = false
    this.els.body.replaceChildren()

    if (rows.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'props-empty'
      empty.textContent = t('ui.props.empty')
      this.els.body.appendChild(empty)
    }

    // 同名不同 propId 必须能区分（C4）：两行 label 一样时把来源带进显示名
    const labelCount = new Map<string, number>()
    for (const r of rows) labelCount.set(r.label, (labelCount.get(r.label) ?? 0) + 1)

    for (const row of rows) {
      const el = document.createElement('div')
      el.className = 'prop-row'
      el.dataset.propId = row.propId
      if (!row.filled) el.dataset.pending = '1'

      const label = document.createElement('label')
      label.className = 'prop-label'
      const name = document.createElement('span')
      name.className = 'prop-name'
      const source = row.sources.length
        ? t('ui.props.source', { tags: row.sources.map((s) => `#${s.text}`).join('、') })
        : t('ui.props.own')
      const duplicated = (labelCount.get(row.label) ?? 0) > 1
      const disambiguated = duplicated ? `${row.label}（${row.sources[0]?.text ?? t('ui.props.own')}）` : row.label
      name.textContent = row.def ? disambiguated : t('ui.props.unknown', { id: this.deps.shortId(row.propId) })
      const src = document.createElement('span')
      src.className = 'prop-source'
      src.textContent = source
      label.append(name, src)

      const value = document.createElement('span')
      value.className = 'prop-value'
      value.appendChild(
        valueEditor(row, (v) => {
          if (v === undefined) this.deps.clearValue(target, row.propId)
          else this.deps.setValue(target, row.propId, v)
        }),
      )

      const clear = document.createElement('button')
      clear.type = 'button'
      clear.className = 'prop-clear ghost'
      clear.title = t('ui.props.clear')
      clear.textContent = '×'
      clear.addEventListener('click', () => this.deps.clearValue(target, row.propId))

      el.append(label, value, clear)
      this.els.body.appendChild(el)
    }

    if (canDeclare) this.els.body.appendChild(this.buildDeclared(target))
    if (this.formOpen) this.els.body.appendChild(this.buildForm(target))
  }

  /**
   * 页/标签**声明的字段**（成员可用）。
   *
   * ⚠️ 这一节是**声明**，没有值输入：值在成员块上（一块一槽）。
   *    给标签块本身设一个值不会成为「默认值」——默认值只属于定义（避免两处真相）。
   */
  private buildDeclared(target: Block): HTMLElement {
    const box = document.createElement('div')
    box.className = 'props-declared'
    const head = document.createElement('div')
    head.className = 'props-declared-head'
    head.textContent = t('ui.props.declaredTitle')
    box.appendChild(head)
    const defs = this.deps.declared(target)
    if (defs.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'props-empty'
      empty.textContent = t('ui.props.declaredEmpty')
      box.appendChild(empty)
      return box
    }
    for (const def of defs) {
      const row = document.createElement('div')
      row.className = 'prop-row'
      row.dataset.declared = def.id
      const label = document.createElement('label')
      label.className = 'prop-label'
      const name = document.createElement('span')
      name.className = 'prop-name'
      name.textContent = def.text.trim() || def.id
      const src = document.createElement('span')
      src.className = 'prop-source'
      src.textContent = t(`ui.props.kind.${propKindOf(def)}`)
      label.append(name, src)
      const del = document.createElement('button')
      del.type = 'button'
      del.className = 'prop-clear ghost'
      del.title = t('ui.props.undeclare')
      del.textContent = '×'
      del.addEventListener('click', () => this.deps.undeclare(target, def.id))
      row.append(label, del)
      box.appendChild(row)
    }
    return box
  }

  /** 添加字段：选已有定义（默认复用）或新建一个。 */
  private buildForm(target: Block): HTMLElement {
    const form = document.createElement('form')
    form.className = 'props-form'
    form.addEventListener('submit', (e) => e.preventDefault())

    const pick = document.createElement('select')
    pick.className = 'prop-input props-pick'
    const placeholder = document.createElement('option')
    placeholder.value = ''
    placeholder.textContent = t('ui.props.pick')
    pick.appendChild(placeholder)
    const used = new Set(this.deps.rows(target).map((r) => r.propId))
    for (const def of this.deps.defs()) {
      if (used.has(def.id)) continue
      const o = document.createElement('option')
      o.value = def.id
      o.textContent = `${def.text.trim() || def.id} · ${String(def.props?._kind ?? 'text')}`
      pick.appendChild(o)
    }
    const pickBtn = document.createElement('button')
    pickBtn.type = 'button'
    pickBtn.textContent = t('ui.props.use')
    pickBtn.addEventListener('click', () => {
      if (!pick.value) return
      this.deps.addField(target, pick.value)
      this.formOpen = false
      this.render()
    })

    const label = document.createElement('input')
    label.className = 'prop-input'
    label.placeholder = t('ui.props.newLabel')
    const kind = document.createElement('select')
    kind.className = 'prop-input'
    for (const k of PROP_KINDS) {
      const o = document.createElement('option')
      o.value = k
      o.textContent = t(`ui.props.kind.${k}`)
      kind.appendChild(o)
    }
    const create = document.createElement('button')
    create.type = 'submit'
    create.textContent = t('ui.props.create')
    create.addEventListener('click', () => {
      const name = label.value.trim()
      if (name === '') {
        this.deps.toast(t('ui.props.needLabel'), 'warn')
        return
      }
      this.deps.createDef(target, name, kind.value as PropKind)
      this.formOpen = false
      this.render()
    })

    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'ghost'
    cancel.textContent = t('ui.props.cancel')
    cancel.addEventListener('click', () => {
      this.formOpen = false
      this.render()
    })

    for (const el of [pick, pickBtn, label, kind, create, cancel]) form.appendChild(el)
    return form
  }
}
