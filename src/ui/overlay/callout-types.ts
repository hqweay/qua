/**
 * 引述类型的**两处编辑面**：
 *   · 类型选择器里的「新建类型…」→ 一个名字输入框（提交即建好并应用到当前引述）；
 *   · 「管理类型…」→ 一张表：改名、换图标/颜色、排序、删除/恢复。
 *
 * 为什么管理面是**一张表**而不是逐类型开配置页：类型的全部内容就是名字＋图标＋颜色，
 * 一屏能看全、能对照；改名/换色是高频微调，藏进「打开这个类型」只会多两次点击。
 *
 * 三条分工（与属性定义/标签的配置面同一条纪律）：
 *   · 写一律走命令（撤销、落盘、词汇级重画都在那条路上），本文件只收集输入；
 *   · 表的内容由宿主的 `types()` 现读，不在本地缓存一份（改完重画即可）；
 *   · 图标选择器**内嵌**（`keepOpen`）：管理浮层自己就是一层 popover，再开一层会把它顶掉。
 */
import type { Layers } from './layers.ts'
import type { CalloutType } from '../../core/infra/callout.ts'
import { DEFAULT_CALLOUT } from '../../core/infra/callout.ts'
import { identityColorCss } from '../../core/identity/faces.ts'
import { isColorValue } from '../../core/model/model.ts'
import { t } from '../../core/infra/msg.ts'
import { renderIcon } from '../../view/icons.ts'
import { renderIconPicker } from './icon-picker.ts'
import { renderNamePrompt } from './panels.ts'

export interface NewCalloutTypeOpts {
  layers: Layers
  anchor: DOMRect | null
  title: string
  submitText: string
  onSubmit: (label: string) => void
}

/** 「新建类型…」的名字输入（浮层一次性面；提交后由调用方关闭/重开） */
export function openCalloutTypeCreator(o: NewCalloutTypeOpts): void {
  o.layers.openPopover((host) => {
    renderNamePrompt(host, {
      title: o.title,
      value: '',
      placeholder: t('ui.callout.typeNamePlaceholder'),
      submitText: o.submitText,
      cancelText: t('ui.confirm.cancel'),
      onSubmit: (name) => o.onSubmit(name),
      onCancel: () => o.layers.closePopover(),
    })
  }, o.anchor)
}

export interface CalloutTypesManagerOpts {
  layers: Layers
  anchor: DOMRect | null
  /** 注册表里的全部记录（含墓碑）；由宿主现读 */
  types: () => readonly CalloutType[]
  /** 走命令面（撤销/落盘/词汇级重画都在那条路上） */
  dispatch: (command: string, args?: Record<string, unknown>) => void
}

/** 打开管理浮层（一张表：名字／图标＋颜色／排序／删除恢复） */
export function openCalloutTypesManager(o: CalloutTypesManagerOpts): void {
  o.layers.openPopover((host) => {
    // 开合状态挂在宿主上：重画是整棵重画，局部变量活不过一次渲染（与块配置头的脸位同一条）
    host.dataset.calloutTypes = '1'
    const redraw = (): void => renderManager(host, o, redraw)
    redraw()
  }, o.anchor)
}

function renderManager(host: HTMLElement, o: CalloutTypesManagerOpts, redraw: () => void): void {
  const openId = host.dataset.faceOpen ?? ''
  host.replaceChildren()

  const head = document.createElement('h4')
  head.className = 'callout-types-title'
  head.textContent = t('ui.callout.typesTitle')
  host.appendChild(head)

  const all = [...o.types()]
  const live = all.filter((x) => x.deleted !== true)
  const gone = all.filter((x) => x.deleted === true)

  const list = document.createElement('div')
  list.className = 'callout-types-list'
  live.forEach((type, i) => list.appendChild(rowOf(type, i, live, o, host, redraw, false)))
  host.appendChild(list)

  if (gone.length > 0) {
    const sec = document.createElement('div')
    sec.className = 'callout-types-section'
    sec.textContent = t('ui.callout.deletedTypes')
    host.appendChild(sec)
    const goneList = document.createElement('div')
    goneList.className = 'callout-types-list'
    for (const type of gone) goneList.appendChild(rowOf(type, -1, live, o, host, redraw, true))
    host.appendChild(goneList)
  }

  /* ------------------------------------------------- 新建（内联一行） */
  const creating = host.dataset.creating === '1'
  if (creating) {
    const form = document.createElement('form')
    form.className = 'callout-types-new'
    const input = document.createElement('input')
    input.className = 'ui-field callout-type-name'
    input.type = 'text'
    input.placeholder = t('ui.callout.typeNamePlaceholder')
    input.dataset.calloutNew = '1'
    input.spellcheck = false
    const ok = document.createElement('button')
    ok.type = 'submit'
    ok.className = 'ui-btn'
    ok.textContent = t('ui.callout.create')
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'ui-btn ui-btn--ghost'
    cancel.textContent = t('ui.confirm.cancel')
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      const label = input.value.trim()
      if (label === '') {
        input.focus()
        return
      }
      o.dispatch('core.callout/add-type', { label })
      delete host.dataset.creating
      redraw()
    })
    cancel.addEventListener('click', () => {
      delete host.dataset.creating
      redraw()
    })
    form.append(input, ok, cancel)
    host.appendChild(form)
    queueMicrotask(() => {
      if (input.isConnected) input.focus()
    })
  } else {
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'ui-btn ui-btn--ghost callout-types-add'
    renderIcon(add, 'lucide:plus', 'plus', 'sm')
    add.appendChild(document.createTextNode(t('ui.callout.newType')))
    add.addEventListener('click', () => {
      host.dataset.creating = '1'
      redraw()
    })
    host.appendChild(add)
  }

  const note = document.createElement('p')
  note.className = 'callout-types-note'
  note.textContent = t('ui.callout.manageHint')
  host.appendChild(note)

  // 图标选择器展开态：只有一行能开着（一屏一栏，避免整表被撑高）
  if (openId !== '') {
    const owner = host.querySelector<HTMLElement>(`.callout-type-row[data-type-id="${cssEscape(openId)}"]`)
    const type = all.find((x) => x.id === openId)
    if (owner && type) {
      const panel = document.createElement('div')
      panel.className = 'callout-type-face-panel'
      renderIconPicker(panel, {
        layers: o.layers,
        anchor: null,
        current: type.icon,
        color: type.color ?? '',
        keepOpen: true,
        onPick: (icon) => {
          host.dataset.faceOpen = openId
          o.dispatch('core.callout/set-type-icon', { typeId: openId, icon })
          redraw()
        },
        onColor: (color) => {
          host.dataset.faceOpen = openId
          // 空串＝摘色（中性是合法态），命令层按 `isColorValue` 判
          o.dispatch('core.callout/set-type-color', { typeId: openId, color: color !== '' && isColorValue(color) ? color : '' })
          redraw()
        },
      })
      owner.after(panel)
    } else {
      delete host.dataset.faceOpen
    }
  }
}

/** 一行的三个件：脸（图标＋颜色）、名字、排序与删除/恢复 */
function rowOf(
  type: CalloutType,
  index: number,
  live: readonly CalloutType[],
  o: CalloutTypesManagerOpts,
  host: HTMLElement,
  redraw: () => void,
  tombstone: boolean,
): HTMLElement {
  const row = document.createElement('div')
  row.className = 'callout-type-row'
  row.dataset.typeId = type.id
  if (tombstone) row.dataset.deleted = '1'

  const face = document.createElement('button')
  face.type = 'button'
  face.className = 'callout-type-face'
  face.dataset.tip = t('ui.callout.editFace')
  face.setAttribute('aria-label', t('ui.callout.editFace'))
  face.disabled = tombstone
  const ico = document.createElement('span')
  ico.className = 'callout-type-ico'
  renderIcon(ico, type.icon, 'quote', 'md')
  if (type.color) ico.style.setProperty('--callout-c', identityColorCss(type.color))
  face.appendChild(ico)
  face.addEventListener('click', () => {
    host.dataset.faceOpen = host.dataset.faceOpen === type.id ? '' : type.id
    redraw()
  })
  row.appendChild(face)

  if (tombstone) {
    const name = document.createElement('span')
    name.className = 'callout-type-name-static ui-ellipsis ui-ellipsis-grow'
    name.textContent = type.label
    row.appendChild(name)
    const restore = iconButton('lucide:undo-2', t('ui.callout.restoreType'), () => {
      o.dispatch('core.callout/restore-type', { typeId: type.id })
      redraw()
    })
    row.appendChild(restore)
    return row
  }

  const name = document.createElement('input')
  name.className = 'ui-field callout-type-name'
  name.type = 'text'
  name.value = type.label
  name.spellcheck = false
  name.dataset.typeName = type.id
  const commit = (): void => {
    const next = name.value.trim()
    if (next === type.label) return
    o.dispatch('core.callout/rename-type', { typeId: type.id, label: next })
    redraw()
  }
  name.addEventListener('change', commit)
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
      name.blur()
    }
  })
  row.appendChild(name)

  row.appendChild(
    iconButton('lucide:chevron-up', t('ui.callout.moveUp'), () => {
      const before = live[index - 1]
      if (!before) return
      o.dispatch('core.callout/move-type', { typeId: type.id, beforeId: before.id })
      redraw()
    }, index === 0),
  )
  row.appendChild(
    iconButton('lucide:chevron-down', t('ui.callout.moveDown'), () => {
      // 下移一格＝插到「再下一个」之前；它是最后一个时 beforeId 空串＝挪到末尾
      const after = live[index + 2]
      o.dispatch('core.callout/move-type', { typeId: type.id, beforeId: after?.id ?? '' })
      redraw()
    }, index === live.length - 1),
  )
  // 缺省类型不可删：所有旧值、旧库、缺键都回落到它
  row.appendChild(
    iconButton('lucide:trash-2', t('ui.callout.deleteType'), () => {
      o.dispatch('core.callout/delete-type', { typeId: type.id })
      redraw()
    }, type.id === DEFAULT_CALLOUT),
  )
  return row
}

function iconButton(icon: string, tip: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'callout-type-btn'
  b.dataset.tip = tip
  b.setAttribute('aria-label', tip)
  b.disabled = disabled
  renderIcon(b, icon, 'circle', 'sm')
  b.addEventListener('click', onClick)
  return b
}

/** 属性值里的 id 只可能来自我们自己（uuid 或短名），这里仍按 CSS 转义规则走一遍 */
function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&')
}
