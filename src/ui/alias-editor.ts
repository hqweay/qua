/**
 * **别名与露面**（这一行叫什么、出现在哪个列表里、这一行显示哪个）。
 *
 * 判据：地址（`_aliases`）与描述（`text`）是两件事 ——
 *   · 名字全局唯一、有顺序（首个是主名）；
 *   · 列表只是「露面」，可以兼位、也可以一个都不进；
 *   · `_display` 只决定**这一行自己的头**显示什么，引用永远叫主名叶子。
 * 把这个编辑器做成一个浮层，是因为名字的写入必须和正文编辑走**同一条写路径**
 * （撤销、落盘、重画都在 `deps.write` 后面），而不是在渲染层里改模型。
 *
 * ⚠️ 组件不持有森林：`forest()` / `block()` 每次现取（库会被整体替换）。
 * ⚠️ 每次写操作后**重绘自己**（不关闭）：连续添加/改主名/摘露面是同一轮动作。
 */
import {
  addAlias,
  addList,
  addressesOf,
  aliasLeaf,
  aliasesOf,
  canRemoveAlias,
  DISPLAY_PROP,
  displayNameOf,
  hasList,
  normalizeAlias,
  primaryAliasOf,
  prop,
  removeAlias,
  removeList,
  setPrimaryAlias,
  type Block,
} from '../core/index.ts'
import type { KbClient } from '../core/kb/types.ts'
import { t } from '../core/msg.ts'

export interface AliasEditorDeps {
  /** 读门面：查重（这个地址现在归谁）按名现取 */
  kb: KbClient
  /** 当前正在编辑的块（每次现取；撤销/换库后旧引用可能已经不在森林里） */
  block: () => Block | undefined
  /** 一次写入：撤销快照、索引修补、重画与落盘都在装配层那一条路上 */
  write: (mutate: () => void) => void
  /** 关闭浮层（保留给「块已经不存在」等退出路径） */
  close: () => void
  /** 冲突/拒绝的提示（装配层注入；缺省时静默，不抛） */
  toast?: (text: string, kind?: 'ok' | 'warn' | 'info') => void
}

/** 冲突块在提示里怎么称呼（页 / 标签 / 块） —— 与页命令的同一套文案 */
function whereOf(b: Block): string {
  if (hasList(b, 'page')) return t('ui.where.page')
  if (hasList(b, 'tag')) return t('ui.where.tag')
  return t('ui.where.block')
}

/** 一个小节：标题 ＋ 内容（每个编辑器里重复三遍，抽出来只为一处排版） */
function section(title: string): { box: HTMLElement; body: HTMLElement } {
  const box = document.createElement('div')
  box.className = 'alias-section'
  const head = document.createElement('div')
  head.className = 'alias-section-title'
  head.textContent = title
  const body = document.createElement('div')
  body.className = 'alias-section-body'
  box.append(head, body)
  return { box, body }
}

/**
 * 把别名编辑器画进 `host`（通常是 `layers.openPopover` 给的浮层）。
 *
 * 写操作全部经 `deps.write`，然后**重绘自己**：不关闭浮层，用户可以连续
 * 「加一个名字 → 设成主名 → 去掉旧名」。关闭只发生在用户点击浮层之外。
 */
export function renderAliasEditor(host: HTMLElement, deps: AliasEditorDeps): void {
  const b = deps.block()
  host.replaceChildren()
  host.classList.add('alias-editor')
  if (!b) {
    deps.close()
    return
  }

  const toast = (text: string, kind: 'ok' | 'warn' | 'info' = 'info'): void => deps.toast?.(text, kind)
  const redraw = (): void => renderAliasEditor(host, deps)

  /* ------------------------------------------------------------ 头部 */

  const title = document.createElement('h4')
  title.textContent = t('ui.alias.title')
  host.appendChild(title)

  const head = document.createElement('div')
  head.className = 'alias-head'
  const leaf = document.createElement('span')
  leaf.className = 'alias-leaf'
  leaf.textContent = displayNameOf(b)
  head.appendChild(leaf)
  const primary = primaryAliasOf(b)
  if (primary !== '' && aliasLeaf(primary) !== primary) {
    const full = document.createElement('span')
    full.className = 'alias-full'
    full.textContent = t('ui.alias.fullName', { name: primary })
    head.appendChild(full)
  }
  host.appendChild(head)

  /* ---------------------------------------------------------- 别名列表 */

  const aliases = aliasesOf(b)
  // 浮层标题已经是「别名」⇒ 这一节不再重复一遍小标题（重复的字只占高度）
  const listBox = document.createElement('div')
  listBox.className = 'alias-section'
  const list = document.createElement('div')
  list.className = 'alias-list'
  for (const name of aliases) {
    const row = document.createElement('div')
    row.className = 'alias-row'
    row.dataset.aliasName = name
    const isPrimary = name === primary
    if (isPrimary) row.dataset.primary = '1'

    const mark = document.createElement('button')
    mark.type = 'button'
    mark.className = 'alias-primary'
    mark.dataset.aliasPrimary = '1'
    mark.title = t('ui.alias.primary')
    mark.textContent = isPrimary ? '★' : '☆'
    if (isPrimary) mark.dataset.active = '1'
    else {
      mark.addEventListener('click', () => {
        deps.write(() => setPrimaryAlias(b, name))
        redraw()
      })
    }
    row.appendChild(mark)

    const label = document.createElement('span')
    label.className = 'alias-label'
    label.textContent = name
    row.appendChild(label)

    const removable = canRemoveAlias(b)
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'alias-del'
    del.dataset.aliasRemove = '1'
    del.title = removable ? t('ui.alias.remove') : t('ui.alias.needOne')
    del.textContent = '×'
    del.disabled = !removable
    del.addEventListener('click', () => {
      if (!canRemoveAlias(b)) {
        toast(t('ui.alias.needOne'), 'warn')
        return
      }
      deps.write(() => removeAlias(b, name))
      redraw()
    })
    row.appendChild(del)
    list.appendChild(row)
  }
  listBox.appendChild(list)

  /* ------------------------------------------------------ 添加一个名字 */

  const form = document.createElement('form')
  form.className = 'alias-add'
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const name = input.value.trim()
    if (name === '') {
      toast(t('ui.alias.emptyName'), 'warn')
      return
    }
    // 同一块上已经有这个地址：`claimAlias` 会排除自己，`addAlias` 只会静默去重；
    // 这里显式提示，避免用户以为「加了但没反应」。
    if (addressesOf(b).includes(normalizeAlias(name))) {
      toast(t('ui.alias.exists'), 'info')
      return
    }
    // 即将写进 `_aliases` ⇒ 一律按「要占地址」查重，不看它此刻有没有名字。
    // 判据与 `claimAlias` 同一份（`kb.resolveAlias` 就是「这个地址现在归谁」）
    const claim = deps.kb.resolveAlias(name)
    if (claim && claim.id !== b.id) {
      toast(t('ui.toast.nameTaken', { name, where: whereOf(claim) }), 'warn')
      return
    }
    deps.write(() => {
      addAlias(b, name)
      // 第一次得到名字 ⇒ 这一行默认显示名字（用户显式选过的显示模式不动）
      if (prop(b, DISPLAY_PROP) === undefined) {
        b.props = { ...(b.props ?? {}), [DISPLAY_PROP]: 'alias' }
      }
    })
    redraw()
    // 重绘后把焦点放回输入框：连着加第二个名字时不用再点一次
    host.querySelector<HTMLInputElement>('.alias-input')?.focus()
  })
  const input = document.createElement('input')
  input.className = 'alias-input'
  input.placeholder = t('ui.alias.add')
  input.spellcheck = false
  const add = document.createElement('button')
  add.type = 'submit'
  add.className = 'alias-add-btn'
  add.textContent = t('ui.alias.add')
  form.append(input, add)
  listBox.appendChild(form)
  host.appendChild(listBox)

  /* ------------------------------------------------------------ 露面 */

  const listsBox = section(t('ui.alias.lists'))
  for (const list of ['page', 'tag'] as const) {
    const label = document.createElement('label')
    label.className = 'alias-check'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.dataset.aliasList = list
    box.checked = hasList(b, list)
    box.addEventListener('change', () => {
      if (box.checked && aliasesOf(b).length === 0) {
        // 不变量：在列表里 ⇒ 至少有一个名字。没有名字就拒绝进列表。
        box.checked = false
        toast(t('ui.alias.needName'), 'warn')
        return
      }
      const turnOn = box.checked
      deps.write(() => {
        if (turnOn) addList(b, list)
        else removeList(b, list)
      })
      redraw()
    })
    const text = document.createElement('span')
    text.textContent = t(list === 'page' ? 'ui.alias.pageList' : 'ui.alias.tagList')
    label.append(box, text)
    listsBox.body.appendChild(label)
  }
  host.appendChild(listsBox.box)

  /* -------------------------------------------------------- 显示模式 */

  if (aliases.length > 0) {
    const displayBox = section(t('ui.alias.display'))
    const current = prop<string>(b, DISPLAY_PROP) === 'text' ? 'text' : 'alias'
    const group = document.createElement('div')
    group.className = 'alias-display'
    for (const mode of ['alias', 'text'] as const) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.dataset.aliasDisplay = mode
      if (mode === current) btn.dataset.active = '1'
      btn.textContent = t(mode === 'alias' ? 'ui.alias.showAlias' : 'ui.alias.showText')
      btn.addEventListener('click', () => {
        if (mode === current) return
        deps.write(() => {
          b.props = { ...(b.props ?? {}), [DISPLAY_PROP]: mode }
        })
        redraw()
      })
      group.appendChild(btn)
    }
    displayBox.body.appendChild(group)
    host.appendChild(displayBox.box)
  }
}
