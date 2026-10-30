/**
 * **选项编辑器**：一个组件、两个视角。
 *
 * | 视角 | 谁用 | 看到什么 |
 * |---|---|---|
 * | 全量（`focusTag` 为空） | 属性定义页 | 这个属性的**所有**选项：改名、作用域、上下移、删除 |
 * | 本标签（`focusTag` 有值） | 标签的「标签属性」段 | 对本标签可见的选项 ＋ 被本标签排除的那些（可恢复） |
 *
 * 三条判据（为什么长这样）：
 *   · **选项是定义块的子块**：这里没有一份自己的列表，读写都落在块树上；
 *     改名就是改正文、重排就是兄弟序、删除就是软删 —— 没有第二份账要同步。
 *   · **写入全部走命令**（注入的 `ChoiceActions`）：撤销/落盘只有一条路，
 *     组件不知道事务、也碰不到块。
 *   · **标签视角不叠抽屉**：它就画在打开它的那一行下面。同一时刻只有一层浮层；
 *     再套一层抽屉会把「我现在在改谁」变成要看两处抬头才知道。
 *
 * 输入框只在**失焦/Enter** 才提交：逐字符写会把 IME 的组合中间态写成正文。
 */
import {
  choiceScopeOf,
  choiceVisible,
  choicesOf,
  plainText,
  propKindOf,
  type Block,
  type ChoiceScope,
} from '../core/index.ts'
import { t } from '../core/msg.ts'

/** 写入口（由装配层实现成命令；组件只声明「发生了什么」） */
export interface ChoiceActions {
  add: (defId: string, label: string, scope?: ChoiceScope) => void
  setLabel: (choiceId: string, label: string) => void
  move: (defId: string, choiceId: string, beforeId: string) => void
  setScope: (choiceId: string, scope: ChoiceScope) => void
  remove: (choiceId: string) => void
}

export interface ChoicesEditorDeps {
  /** 定义块（活引用）；不在/不是 select ⇒ 什么都不画 */
  def: () => Block | undefined
  /** 按 id 读标签（作用域面板的候选）；每次现读，不缓存整片森林 */
  tagById: (id: string) => Block | undefined
  /** 全库标签（作用域面板的候选，按名字排） */
  tags: () => readonly Block[]
  /** 标签视角的标签 id；空串 ＝ 全量视角（属性定义页） */
  focusTag: () => string
  write: ChoiceActions
  /** 标签显示名（`#名`） */
  tagName: (id: string) => string
}

export class ChoicesEditor {
  readonly root: HTMLElement
  private readonly deps: ChoicesEditorDeps
  /** 哪一个选项的作用域面板展开着（跨重绘保留：勾选标签会触发一次写与一次重画） */
  private openScope = ''

  constructor(deps: ChoicesEditorDeps) {
    this.deps = deps
    this.root = document.createElement('div')
    this.root.className = 'choices-editor'
    this.render()
  }

  render(): void {
    this.root.replaceChildren()
    const def = this.deps.def()
    if (!def || propKindOf(def) !== 'select') {
      delete this.root.dataset.defId
      return
    }
    this.root.dataset.defId = def.id
    const focusTag = this.deps.focusTag()
    const section = document.createElement('section')
    section.className = 'choices-section'

    const head = document.createElement('div')
    head.className = 'choices-head'
    const title = document.createElement('span')
    title.className = 'choices-title'
    title.textContent = t('ui.props.choice.title')
    head.appendChild(title)
    if (focusTag !== '') {
      const hint = document.createElement('span')
      hint.className = 'choices-hint'
      hint.textContent = t('ui.props.choice.tagHint', { tag: `#${this.deps.tagName(focusTag)}` })
      head.appendChild(hint)
    }
    section.appendChild(head)

    const visible = this.visibleChoices(def, focusTag)
    if (visible.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'props-empty'
      empty.textContent = t('ui.props.choice.empty')
      section.appendChild(empty)
    }
    const list = document.createElement('div')
    list.className = 'choices-list'
    for (const [i, choice] of visible.entries()) list.appendChild(this.choiceItem(def, choice, i, visible, focusTag === ''))
    section.appendChild(list)

    if (focusTag !== '') {
      const hidden = this.hiddenChoices(def, focusTag)
      if (hidden.length > 0) section.appendChild(this.hiddenBlock(hidden, focusTag))
      const other = this.otherTagOnly(def, focusTag)
      if (other) {
        const note = document.createElement('p')
        note.className = 'choices-hint'
        note.textContent = t('ui.props.choice.otherTagsHint')
        section.appendChild(note)
      }
      section.appendChild(this.addForm(def, focusTag))
    } else {
      section.appendChild(this.addForm(def, ''))
    }
    this.root.appendChild(section)
  }

  /* ---------------------------------------------------------- 两个视角的集合 */

  /** 本视角看得到的选项（兄弟顺序） */
  private visibleChoices(def: Block, focusTag: string): Block[] {
    const all = choicesOf(def)
    if (focusTag === '') return all
    const ids = new Set([focusTag])
    return all.filter((c) => choiceVisible(c, ids))
  }

  /** 被**本标签**排除的选项（`except` 里含本标签）：可以一键恢复 */
  private hiddenChoices(def: Block, focusTag: string): Block[] {
    return choicesOf(def).filter((c) => {
      const scope = choiceScopeOf(c)
      return scope.mode === 'except' && scope.tags.includes(focusTag)
    })
  }

  /** 有没有「别的标签专属」的选项（只用来提示去定义页看全量） */
  private otherTagOnly(def: Block, focusTag: string): boolean {
    return choicesOf(def).some((c) => {
      const scope = choiceScopeOf(c)
      return scope.mode === 'only' && !scope.tags.includes(focusTag)
    })
  }

  /* ---------------------------------------------------------- 行 */

  private choiceItem(def: Block, choice: Block, index: number, siblings: Block[], full: boolean): HTMLElement {
    const item = document.createElement('div')
    item.className = 'choice-item'
    item.dataset.choiceId = choice.id

    const row = document.createElement('div')
    row.className = 'choice-row ui-row'

    const name = document.createElement('input')
    name.className = 'prop-input choice-name'
    name.value = plainText(choice.content).trim()
    name.placeholder = t('ui.props.choice.name')
    const commit = (): void => {
      const next = name.value.trim()
      if (next === '' || next === plainText(choice.content).trim()) {
        name.value = plainText(choice.content).trim()
        return
      }
      this.deps.write.setLabel(choice.id, next)
    }
    name.addEventListener('keydown', (e) => {
      // 组合期只让输入法自己处理：Enter 常常是选词那一下
      if (e.key !== 'Enter' || e.isComposing) return
      e.preventDefault()
      commit()
      name.blur()
    })
    name.addEventListener('blur', commit)

    const badge = document.createElement('button')
    badge.type = 'button'
    badge.className = 'choice-scope'
    const scope = choiceScopeOf(choice)
    badge.dataset.mode = scope.mode
    badge.textContent = this.scopeLabel(scope)
    if (full) {
      badge.title = t('ui.props.choice.badgeTitle', { scope: badge.textContent })
      badge.addEventListener('click', () => {
        this.openScope = this.openScope === choice.id ? '' : choice.id
        this.render()
      })
    } else {
      badge.disabled = true
    }

    const controls = document.createElement('span')
    controls.className = 'choice-controls'
    if (full) {
      const up = this.iconButton('↑', t('ui.props.choice.moveUp'), () => {
        if (index === 0) return
        const before = siblings[index - 1]
        if (before) this.deps.write.move(def.id, choice.id, before.id)
      })
      up.dataset.choiceMove = 'up'
      up.disabled = index === 0
      const down = this.iconButton('↓', t('ui.props.choice.moveDown'), () => {
        if (index >= siblings.length - 1) return
        const next = siblings[index + 2]
        this.deps.write.move(def.id, choice.id, next ? next.id : '')
      })
      down.dataset.choiceMove = 'down'
      down.disabled = index >= siblings.length - 1
      controls.append(up, down)
    }
    const del = this.iconButton('×', t('ui.props.choice.delete'), () => this.deps.write.remove(choice.id))
    del.dataset.choiceDelete = '1'
    controls.appendChild(del)

    row.append(name, badge, controls)
    item.appendChild(row)

    if (full && this.openScope === choice.id) item.appendChild(this.scopePanel(choice))
    return item
  }

  private iconButton(text: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'choice-x'
    b.title = title
    b.textContent = text
    b.addEventListener('click', (e) => {
      e.preventDefault()
      onClick()
    })
    return b
  }

  /** 作用域徽标的文案（三态；悬空标签要说出来，别让它看起来正常） */
  private scopeLabel(scope: ChoiceScope): string {
    if (scope.mode === 'all') return t('ui.props.choice.scopeGlobal')
    const tags = scope.tags.map((id) => `#${this.deps.tagName(id)}`).join('、')
    const label =
      scope.mode === 'only' ? t('ui.props.choice.scopeOnly', { tags }) : t('ui.props.choice.scopeExcept', { tags })
    const missing = scope.tags.some((id) => !this.deps.tagById(id))
    return missing ? `${label}${t('ui.props.choice.sourceTagDeleted')}` : label
  }

  /* ---------------------------------------------------------- 作用域面板 */

  /**
   * 三态一个表达式：没有「既 only 又 except」，也没有优先级规则。
   * 勾选/取消标签**立刻写**（`set-choice-scope` 一笔事务），所以面板在重画后保持展开。
   */
  private scopePanel(choice: Block): HTMLElement {
    const scope = choiceScopeOf(choice)
    const box = document.createElement('div')
    box.className = 'choice-scope-panel'

    const modes = document.createElement('div')
    modes.className = 'choice-modes'
    const defs: { mode: ChoiceScope['mode']; label: string }[] = [
      { mode: 'all', label: t('ui.props.choice.modeAll') },
      { mode: 'only', label: t('ui.props.choice.modeOnly') },
      { mode: 'except', label: t('ui.props.choice.modeExcept') },
    ]
    for (const d of defs) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'choice-mode'
      b.dataset.mode = d.mode
      b.dataset.on = scope.mode === d.mode ? '1' : '0'
      b.textContent = d.label
      b.addEventListener('click', () => {
        if (d.mode === 'all') this.deps.write.setScope(choice.id, { mode: 'all' })
        else this.deps.write.setScope(choice.id, { mode: d.mode, tags: scope.mode === d.mode ? scope.tags : [] })
        this.render()
      })
      modes.appendChild(b)
    }
    box.appendChild(modes)

    if (scope.mode !== 'all') {
      const tags = document.createElement('div')
      tags.className = 'choice-tags'
      for (const tag of this.deps.tags()) {
        const lab = document.createElement('label')
        lab.className = 'choice-tag'
        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.checked = scope.tags.includes(tag.id)
        cb.dataset.tagId = tag.id
        cb.addEventListener('change', () => {
          const cur = choiceScopeOf(choice)
          if (cur.mode === 'all') return
          const set = new Set(cur.tags)
          if (cb.checked) set.add(tag.id)
          else set.delete(tag.id)
          this.deps.write.setScope(choice.id, { mode: cur.mode, tags: [...set] })
          this.render()
        })
        const name = document.createElement('span')
        name.textContent = `#${this.deps.tagName(tag.id)}`
        lab.append(cb, name)
        tags.appendChild(lab)
      }
      box.appendChild(tags)
    }
    return box
  }

  /* ---------------------------------------------------------- 已隐藏（标签视角） */

  private hiddenBlock(hidden: Block[], focusTag: string): HTMLElement {
    const box = document.createElement('div')
    box.className = 'choices-hidden'
    const head = document.createElement('div')
    head.className = 'choices-head'
    const title = document.createElement('span')
    title.className = 'choices-title'
    title.textContent = t('ui.props.choice.hidden')
    const hint = document.createElement('span')
    hint.className = 'choices-hint'
    hint.textContent = t('ui.props.choice.hiddenHint')
    head.append(title, hint)
    box.appendChild(head)
    for (const choice of hidden) {
      const row = document.createElement('div')
      row.className = 'choice-row ui-row'
      row.dataset.choiceId = choice.id
      const name = document.createElement('span')
      name.className = 'choice-name choice-name--static'
      name.textContent = plainText(choice.content).trim() || choice.id.slice(-6)
      const restore = document.createElement('button')
      restore.type = 'button'
      restore.className = 'choice-restore'
      restore.textContent = t('ui.props.choice.restore')
      restore.addEventListener('click', () => {
        const scope = choiceScopeOf(choice)
        const tags = scope.mode === 'except' ? scope.tags.filter((id) => id !== focusTag) : []
        this.deps.write.setScope(choice.id, tags.length === 0 ? { mode: 'all' } : { mode: 'except', tags })
      })
      row.append(name, restore)
      box.appendChild(row)
    }
    return box
  }

  /* ---------------------------------------------------------- 添加 */

  private addForm(def: Block, focusTag: string): HTMLElement {
    const form = document.createElement('form')
    form.className = 'choices-add'
    form.addEventListener('submit', (e) => e.preventDefault())

    const input = document.createElement('input')
    input.className = 'prop-input choice-add-name'
    input.placeholder = t('ui.props.choice.addPlaceholder')

    const add = document.createElement('button')
    add.type = 'submit'
    add.className = 'choice-add'
    add.textContent = t('ui.props.choice.addButton')

    /**
     * 标签视角：新增缺省**只对本标签可见**；一个「全局可用」开关把这次新增改成全局。
     * 全量视角：新增缺省全局，可先切 only/except 并勾标签。
     */
    if (focusTag !== '') {
      const globalBox = document.createElement('input')
      globalBox.type = 'checkbox'
      globalBox.className = 'choice-global'
      const label = document.createElement('label')
      label.className = 'choice-global-label'
      label.append(globalBox, document.createTextNode(` ${t('ui.props.choice.globalToggle')}`))
      add.addEventListener('click', () => {
        const name = input.value.trim()
        if (name === '') return
        const scope: ChoiceScope = globalBox.checked ? { mode: 'all' } : { mode: 'only', tags: [focusTag] }
        this.deps.write.add(def.id, name, scope)
        input.value = ''
        globalBox.checked = false
      })
      form.append(input, label, add)
      return form
    }

    const mode = document.createElement('select')
    mode.className = 'prop-input choice-add-mode'
    for (const [value, key] of [
      ['all', 'ui.props.choice.modeAll'],
      ['only', 'ui.props.choice.modeOnly'],
      ['except', 'ui.props.choice.modeExcept'],
    ] as const) {
      const o = document.createElement('option')
      o.value = value
      o.textContent = t(key)
      mode.appendChild(o)
    }
    const tags = document.createElement('div')
    tags.className = 'choice-tags choice-add-tags'
    const picked = new Set<string>()
    const paintTags = (): void => {
      tags.replaceChildren()
      tags.hidden = parseMode(mode.value) === 'all'
      if (tags.hidden) return
      for (const tag of this.deps.tags()) {
        const lab = document.createElement('label')
        lab.className = 'choice-tag'
        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.checked = picked.has(tag.id)
        cb.addEventListener('change', () => {
          if (cb.checked) picked.add(tag.id)
          else picked.delete(tag.id)
        })
        lab.append(cb, document.createTextNode(` #${this.deps.tagName(tag.id)}`))
        tags.appendChild(lab)
      }
    }
    mode.addEventListener('change', paintTags)
    paintTags()

    add.addEventListener('click', () => {
      const name = input.value.trim()
      if (name === '') return
      const m = parseMode(mode.value)
      this.deps.write.add(def.id, name, m === 'all' ? { mode: 'all' } : { mode: m, tags: [...picked] })
      input.value = ''
      picked.clear()
      mode.value = 'all'
      paintTags()
    })

    form.append(input, mode, tags, add)
    return form
  }
}

function parseMode(v: string): ChoiceScope['mode'] {
  return v === 'only' || v === 'except' ? v : 'all'
}
