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
import { onCommitKeys } from './keys.ts'
import {
  CLOSURE_USE,
  allChoicesOf,
  cardinalityOf,
  checkOf,
  choiceScopeOf,
  choiceVisible,
  choicesOf,
  propKindOf,
  uiPositionOf,
  useOf,
  type Block,
  type ChoiceScope,
  type PropChoice,
  type UiPosition,
} from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import { renderIcon } from '../../view/icons.ts'
import { sectionInfo } from '../../view/info.ts'

/** 写入口（由装配层实现成命令；组件只声明「发生了什么」） */
export interface ChoiceActions {
  add: (defId: string, label: string, scope?: ChoiceScope) => void
  setLabel: (choiceId: string, label: string) => void
  move: (defId: string, choiceId: string, beforeId: string) => void
  setScope: (choiceId: string, scope: ChoiceScope) => void
  /** 选项在块左侧的图标（空串＝无图标） */
  setIcon: (choiceId: string, icon: string) => void
  /** 写/摘勾选框映射；`closure: true` 同时标为库级唯一的任务状态 */
  setCheck: (defId: string, spec: { on: string; off: string; closure: boolean } | null) => void
  /** 单值/多值（多选不能是勾选框/任务状态；切回单值有「仍有块选了多个值」的守卫） */
  setCardinality: (defId: string, cardinality: 'one' | 'many') => void
  /** 定义块的快捷入口位置（block-left ＝ 块左侧图标；panel ＝ 只留属性卡） */
  setUiPosition: (defId: string, position: UiPosition) => void
  remove: (choiceId: string) => void
  /** 恢复一条被删的选项（撤墓碑；值一个字节不动） */
  restore: (choiceId: string) => void
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
  /** 图标选择器（装配层开浮层；未接 ⇒ 图标只读） */
  pickIcon?: (anchor: DOMRect, current: string, onPick: (icon: string) => void, trigger?: HTMLElement) => void
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

    /**
     * **快捷入口位置**：只在属性定义页给（标签视角改的是全局定义，越权）。
     *
     * 勾上 ⇒ 这一条属性在每行的块标后画当前值的图标；不勾 ⇒ 有值时落在**块下属性行**。
     * 块属性卡里**仍然**能改，三者读同一份行派生、写同一条命令。
     *
     * **「允许多个值」不在这里**：基数轴推广到全 kind 之后，那个开关搬去了定义页的
     * 通用值配置段（`def-config-section.ts`），这一段只管 select 自己的版面。
     */
    if (focusTag === '') {
      const gutter = document.createElement('label')
      gutter.className = 'choices-gutter'
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.className = 'prop-check'
      box.dataset.choiceGutter = '1'
      box.checked = uiPositionOf(def) === 'block-left'
      box.addEventListener('change', () => {
        this.deps.write.setUiPosition(def.id, box.checked ? 'block-left' : 'panel')
        this.render()
      })
      const text = document.createElement('span')
      text.textContent = t('ui.props.choice.gutter')
      // 「不勾选会落到哪」是解释，不是第二个决定：退到说明图标，行上只留开关。
      gutter.append(box, text, sectionInfo(t('ui.props.choice.gutterTitle')))
      section.appendChild(gutter)
    }

    const visible = this.visibleChoices(def, focusTag)
    if (visible.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'props-empty'
      empty.textContent = t('ui.props.choice.empty')
      section.appendChild(empty)
    }
    const list = document.createElement('div')
    list.className = 'choices-list'
    for (const [i, choice] of visible.entries()) list.appendChild(this.choiceItem(def, choice, i, visible, focusTag))
    section.appendChild(list)

    if (focusTag === '') {
      section.appendChild(this.checkSection(def))
      const deleted = this.deletedBlock(def)
      if (deleted) section.appendChild(deleted)
    }

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

  /**
   * **勾选框映射**（`_check {on, off}`）与任务状态用途（`_use: 'closure'`）。
   *
   * 两个决定分开：
   *   · 「显示为勾选框」只影响编辑/显示（勾选写 on、取消写 off），普通属性也能用；
   *   · 「勾选表示完成」把它标成库级唯一的关闭态用途（划线/⌘↵/closureOf）。
   * 多值属性不能勾选（单值才能「勾一个」）；少于两个选项时不给开。
   */
  private checkSection(def: Block): HTMLElement {
    const box = document.createElement('div')
    box.className = 'choices-check'
    if (cardinalityOf(def) === 'many') return box

    const all = choicesOf(def)
    const check = checkOf(def)
    const closure = useOf(def) === CLOSURE_USE

    const toggle = document.createElement('label')
    toggle.className = 'cc-toggle'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.className = 'prop-check'
    cb.dataset.choiceCheck = '1'
    cb.checked = check !== undefined
    cb.disabled = all.length < 2
    cb.addEventListener('change', () => {
      if (cb.checked) {
        const on = all[0]?.id ?? ''
        const off = all[1]?.id ?? ''
        this.deps.write.setCheck(def.id, on && off ? { on, off, closure: false } : null)
      } else {
        this.deps.write.setCheck(def.id, null)
      }
      this.render()
    })
    const label = document.createElement('span')
    label.textContent = t('ui.props.choice.check')
    toggle.append(cb, label)
    // 「至少两个选项」是**输入约束**，不是说明文字：留在界面上，不塞进 tip。
    if (all.length < 2) {
      const hint = document.createElement('span')
      hint.className = 'choices-hint'
      hint.textContent = t('ui.props.choice.checkNeedTwo')
      toggle.appendChild(hint)
    }
    box.appendChild(toggle)
    if (!check) return box

    /**
     * 映射区：一行一个决定。图标说「勾／未勾」，颜色说哪一边是关闭态；
     * 值域仍由下拉承担——三个视觉层各管一件事，不再靠一行挤五个元素。
     */
    const map = document.createElement('div')
    map.className = 'cc-map'
    const names = new Map(all.map((c) => [c.id, c.label.trim() || c.id.slice(-6)]))
    const selectRow = (which: 'on' | 'off'): HTMLElement => {
      const row = document.createElement('label')
      row.className = 'cc-row'
      row.dataset.ccRole = which
      const ico = document.createElement('span')
      ico.className = 'cc-ico'
      renderIcon(
        ico,
        which === 'on' ? 'lucide:circle-check' : 'lucide:circle',
        which === 'on' ? 'circle-check' : 'circle',
        'md',
      )
      const text = document.createElement('span')
      text.className = 'cc-label'
      text.textContent = t(which === 'on' ? 'ui.props.choice.checkOn' : 'ui.props.choice.checkOff')
      const sel = document.createElement('select')
      sel.className = 'prop-input'
      sel.dataset.choiceCheckWhich = which
      const seen = new Set<string>()
      for (const c of all) {
        seen.add(c.id)
        const o = document.createElement('option')
        o.value = c.id
        o.textContent = names.get(c.id) ?? c.id.slice(-6)
        sel.appendChild(o)
      }
      const current = check[which]
      // 映射指向软删/不可见选项时仍显示出来，不静默改成另一个值
      if (!seen.has(current)) {
        const o = document.createElement('option')
        o.value = current
        o.textContent = t('ui.props.choice.deleted')
        sel.appendChild(o)
      }
      sel.value = current
      sel.addEventListener('change', () => {
        const next = { on: which === 'on' ? sel.value : check.on, off: which === 'off' ? sel.value : check.off }
        this.deps.write.setCheck(def.id, { ...next, closure })
        this.render()
      })
      row.append(ico, text, sel)
      return row
    }
    map.append(selectRow('on'), selectRow('off'))

    /**
     * 关闭态：开关 ＋ 短语 ＋ 说明图标。
     *
     * 说明（块标后变方框、划线、`⌘↵`）是解释而非操作，退到 `data-tip`；
     * 行本身只留用户要做的那个决定。外层用 `div` 包：点说明图标不该顺手切换开关。
     */
    const statusRow = document.createElement('div')
    statusRow.className = 'cc-state'
    statusRow.dataset.on = closure ? '1' : '0'
    const slabel = document.createElement('label')
    slabel.className = 'cc-state-label'
    const sbox = document.createElement('input')
    sbox.type = 'checkbox'
    sbox.className = 'prop-check'
    sbox.dataset.choiceStatus = '1'
    sbox.checked = closure
    sbox.addEventListener('change', () => {
      this.deps.write.setCheck(def.id, { on: check.on, off: check.off, closure: sbox.checked })
      this.render()
    })
    const stext = document.createElement('span')
    stext.className = 'cc-label'
    stext.textContent = t('ui.props.choice.checkStatus')
    slabel.append(sbox, stext)
    statusRow.append(slabel, sectionInfo(t('ui.props.choice.checkStatusHint')))
    map.appendChild(statusRow)

    box.appendChild(map)
    return box
  }

  /* ---------------------------------------------------------- 两个视角的集合 */

  /** 本视角看得到的选项（兄弟顺序） */
  private visibleChoices(def: Block, focusTag: string): PropChoice[] {
    const all = choicesOf(def)
    if (focusTag === '') return all
    const ids = new Set([focusTag])
    return all.filter((c) => choiceVisible(c, ids))
  }

  /** 被**本标签**排除的选项（`except` 里含本标签）：可以一键恢复 */
  private hiddenChoices(def: Block, focusTag: string): PropChoice[] {
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

  /**
   * 一行选项。
   *
   * **标签视角只准动「本标签专属」的选项**（`only` 且 tags 恰好是 `[focusTag]`）：
   * 全局的、`except` 的、多标签共享的选项动一下会影响所有标签，那里只给
   * 「对本标签隐藏」；改名/删除/排序是**属性定义页**的事（全量视角）。
   */
  private choiceItem(def: Block, choice: PropChoice, index: number, siblings: PropChoice[], focusTag: string): HTMLElement {
    const full = focusTag === ''
    const scope = choiceScopeOf(choice)
    const localOnly = !full && scope.mode === 'only' && scope.tags.length === 1 && scope.tags[0] === focusTag
    const editable = full || localOnly

    const item = document.createElement('div')
    item.className = 'choice-item'
    item.dataset.choiceId = choice.id

    const row = document.createElement('div')
    row.className = 'choice-row ui-row'

    const name = document.createElement('input')
    name.className = 'prop-input choice-name'
    name.value = choice.label.trim()
    name.placeholder = t('ui.props.choice.name')
    if (editable) {
      const commit = (): void => {
        const next = name.value.trim()
        if (next === '' || next === choice.label.trim()) {
          name.value = choice.label.trim()
          return
        }
        this.deps.write.setLabel(choice.id, next)
        this.render()
      }
      onCommitKeys(name, {
        stop: true,
        commit: () => {
          commit()
          name.blur()
        },
      })
      name.addEventListener('blur', commit)
    } else {
      name.readOnly = true
      name.tabIndex = -1
      name.classList.add('choice-name--static')
      name.dataset.tip = t('ui.props.choice.sharedReadonly')
    }

    const badge = document.createElement('button')
    badge.type = 'button'
    badge.className = 'choice-scope'
    badge.dataset.mode = scope.mode
    badge.textContent = this.scopeLabel(scope)
    if (full) {
      badge.dataset.tip = t('ui.props.choice.badgeTitle', { scope: badge.textContent })
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
        if (before) {
          this.deps.write.move(def.id, choice.id, before.id)
          this.render()
        }
      })
      up.dataset.choiceMove = 'up'
      up.disabled = index === 0
      const down = this.iconButton('↓', t('ui.props.choice.moveDown'), () => {
        if (index >= siblings.length - 1) return
        const next = siblings[index + 2]
        this.deps.write.move(def.id, choice.id, next ? next.id : '')
        this.render()
      })
      down.dataset.choiceMove = 'down'
      down.disabled = index >= siblings.length - 1
      controls.append(up, down)
    }
    if (editable) {
      const del = this.iconButton('×', t('ui.props.choice.delete'), () => {
        this.deps.write.remove(choice.id)
        this.render()
      })
      del.dataset.choiceDelete = '1'
      controls.appendChild(del)
    } else {
      const hide = document.createElement('button')
      hide.type = 'button'
      hide.className = 'choice-hide'
      hide.dataset.choiceHide = '1'
      hide.textContent = t('ui.props.choice.hideForTag')
      hide.dataset.tip = t('ui.props.choice.hideForTagTitle')
      hide.addEventListener('click', (e) => {
        e.preventDefault()
        this.hideFromTag(choice, focusTag)
      })
      controls.appendChild(hide)
    }

    /**
     * **图标预览／入口**：这个值在块左侧长什么样。没有图标时画虚线框——
     * 它同时是「这里可以选一个图标」的可点提示。
     *
     * 图标集是 `view/icons.ts` 的一份数据；浮层由装配层开（`pickIcon`），
     * 组件只负责「点的是哪一行、选完写哪一格」。
     */
    const icon = choice.icon ?? ''
    const ico = document.createElement('button')
    ico.type = 'button'
    ico.className = 'choice-icon'
    ico.dataset.choiceIcon = '1'
    ico.dataset.tip = icon === '' ? t('ui.props.choice.pickIcon') : t('ui.props.choice.iconTitle')
    renderIcon(ico, icon, 'square-dashed', 'sm')
    if (editable && this.deps.pickIcon) {
      ico.addEventListener('click', (e) => {
        e.preventDefault()
        this.deps.pickIcon?.(ico.getBoundingClientRect(), icon, (next) => {
          this.deps.write.setIcon(choice.id, next)
          this.render()
        }, ico)
      })
    } else {
      ico.disabled = true
    }

    row.append(ico, name, badge, controls)
    item.appendChild(row)

    if (full && this.openScope === choice.id) item.appendChild(this.scopePanel(choice))
    return item
  }

  /** 「对本标签隐藏」：只改这一个标签能看到它这件事，不动别的标签 */
  private hideFromTag(choice: PropChoice, focusTag: string): void {
    const scope = choiceScopeOf(choice)
    let next: ChoiceScope
    if (scope.mode === 'all') next = { mode: 'except', tags: [focusTag] }
    else if (scope.mode === 'except') next = { mode: 'except', tags: [...scope.tags, focusTag] }
    else {
      const tags = scope.tags.filter((id) => id !== focusTag)
      next = tags.length === 0 ? { mode: 'all' } : { mode: 'only', tags }
    }
    this.deps.write.setScope(choice.id, next)
    this.render()
  }

  private iconButton(text: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'choice-x'
    b.dataset.tip = title
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
    if (scope.tags.length === 0) return t('ui.props.choice.scopeNoTags')
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
  private scopePanel(choice: PropChoice): HTMLElement {
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

    /**
     * **悬空的标签 id**（来源标签已删）不会出现在上面的勾选清单里：用户只能先切回
     * 全局再切回来才清得掉。给一个显式入口，清掉的是「这一格里的失效引用」，
     * 不是删标签、也不是把作用域悄悄升成全局。
     */
    const scopedTags = scope.mode === 'all' ? [] : scope.tags
    const dangling = scopedTags.filter((id) => !this.deps.tagById(id))
    if (dangling.length > 0) {
      const prune = document.createElement('button')
      prune.type = 'button'
      prune.className = 'choice-prune'
      prune.dataset.choicePrune = '1'
      prune.textContent = t('ui.props.choice.pruneScopes')
      prune.dataset.tip = t('ui.props.choice.pruneScopesTitle')
      prune.addEventListener('click', () => {
        const tags = scopedTags.filter((id) => Boolean(this.deps.tagById(id)))
        this.deps.write.setScope(
          choice.id,
          tags.length === 0 && scope.mode === 'except' ? { mode: 'all' } : { mode: scope.mode, tags },
        )
        this.render()
      })
      box.appendChild(prune)
    }
    return box
  }

  /* ---------------------------------------------------------- 已删除（全量视角） */

  /**
   * **墓碑段**：删掉的选项仍留在数组里（`deleted: true`），这里把它们列出来，
   * 每条一个「恢复」。
   *
   * 为什么不做成「删了就消失」：值侧指向它的块一个字节都没动，用户需要一条路
   * 把名字找回来 —— 「删选项连值一起删」正是被这个需求反噬的。
   * 只在全量视角给：标签视角改的是「本标签看不看得到」，与全局的删/恢复不是一件事。
   */
  private deletedBlock(def: Block): HTMLElement | null {
    const gone = allChoicesOf(def).filter((c) => c.deleted === true)
    if (gone.length === 0) return null
    const box = document.createElement('div')
    box.className = 'choices-hidden choices-deleted'
    const head = document.createElement('div')
    head.className = 'choices-head'
    const title = document.createElement('span')
    title.className = 'choices-title'
    title.textContent = t('ui.props.choice.deletedSection')
    head.appendChild(title)
    box.appendChild(head)
    for (const choice of gone) {
      const row = document.createElement('div')
      row.className = 'choice-row ui-row'
      row.dataset.choiceId = choice.id
      row.dataset.choiceDeleted = '1'
      const name = document.createElement('span')
      name.className = 'choice-name choice-name--static'
      name.textContent = choice.label.trim() || choice.id.slice(-6)
      const restore = document.createElement('button')
      restore.type = 'button'
      restore.className = 'choice-restore'
      restore.dataset.choiceRestore = '1'
      restore.textContent = t('ui.props.choice.restore')
      restore.addEventListener('click', () => {
        this.deps.write.restore(choice.id)
        this.render()
      })
      row.append(name, restore)
      box.appendChild(row)
    }
    return box
  }

  /* ---------------------------------------------------------- 已隐藏（标签视角） */

  private hiddenBlock(hidden: PropChoice[], focusTag: string): HTMLElement {
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
      name.textContent = choice.label.trim() || choice.id.slice(-6)
      const restore = document.createElement('button')
      restore.type = 'button'
      restore.className = 'choice-restore'
      restore.textContent = t('ui.props.choice.restore')
      restore.addEventListener('click', () => {
        const scope = choiceScopeOf(choice)
        const tags = scope.mode === 'except' ? scope.tags.filter((id) => id !== focusTag) : []
        this.deps.write.setScope(choice.id, tags.length === 0 ? { mode: 'all' } : { mode: 'except', tags })
        this.render()
      })
      row.append(name, restore)
      box.appendChild(row)
    }
    return box
  }

  /* ---------------------------------------------------------- 添加 */

  /**
   * 添加一行。
   *
   * **点击按钮与按 Enter 走同一条 `doAdd`**：只把按钮绑 click、表单只 `preventDefault`
   * 的话，Enter 会触发一次什么都没做的 submit（用户看到的是「按回车没反应」）。
   */
  private addForm(def: Block, focusTag: string): HTMLElement {
    const form = document.createElement('form')
    form.className = 'choices-add'

    const input = document.createElement('input')
    input.className = 'prop-input choice-add-name'
    input.placeholder = t('ui.props.choice.addPlaceholder')

    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'choice-add'
    add.textContent = t('ui.props.choice.addButton')

    let doAdd: () => void = () => {}

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
      doAdd = (): void => {
        const name = input.value.trim()
        if (name === '') return
        const scope: ChoiceScope = globalBox.checked ? { mode: 'all' } : { mode: 'only', tags: [focusTag] }
        this.deps.write.add(def.id, name, scope)
        this.render()
      }
      form.append(input, label, add)
    } else {
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

      doAdd = (): void => {
        const name = input.value.trim()
        if (name === '') return
        const m = parseMode(mode.value)
        this.deps.write.add(def.id, name, m === 'all' ? { mode: 'all' } : { mode: m, tags: [...picked] })
        this.render()
      }
      form.append(input, mode, tags, add)
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault()
      doAdd()
    })
    add.addEventListener('click', () => doAdd())
    onCommitKeys(input, { stop: true, commit: doAdd })
    return form
  }
}

function parseMode(v: string): ChoiceScope['mode'] {
  return v === 'only' || v === 'except' ? v : 'all'
}
