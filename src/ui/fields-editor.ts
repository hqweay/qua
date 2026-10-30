/**
 * **字段声明**（页/标签声明了哪些属性可用）。
 *
 * 判据：声明是「这条属性在我的成员/子块上有一格」，不是「给这一块设一个值」。
 * 所以这里只做三件事：列已声明、解除声明、从现有定义里加一条。
 * 值的编辑在属性面板 —— 这里不给值控件（不是「只能在一个地方改」，而是
 * 「这个抽屉管声明，那个面板管值」，两个抽屉各管一件事）。
 *
 * ⚠️ 解除声明**不动值**：成员块上的值落回「本块自有」，重新声明后自动回来。
 * ⚠️ 只有页/标签能声明（`declareField` 的判据）；没有露面时按钮禁用并说明原因。
 * ⚠️ `select` 属性的「选项」编辑器**就地展开在这一行下面**：抽屉上不再叠抽屉，
 *    同一时刻只有一层浮层。
 */
import {
  declareField,
  displayNameOf,
  hasList,
  listsOf,
  propKindOf,
  undeclareField,
  type Block,
} from '../core/index.ts'
import type { KbClient } from '../core/kb/types.ts'
import { plainText } from '../core/runs.ts'
import { t } from '../core/msg.ts'
import { ChoicesEditor, type ChoiceActions } from './choices-editor.ts'

export interface FieldsEditorDeps {
  /** 读门面：已声明的字段与定义清单都是命名的库读 */
  kb: KbClient
  block: () => Block | undefined
  write: (mutate: () => void) => void
  close: () => void
  /** 选项编辑器的写入口（命令） */
  choices: ChoiceActions
  toast?: (text: string, kind?: 'ok' | 'warn' | 'info') => void
}

/** 抽屉自己的局部状态：跨重绘保留「哪条属性的选项展开着」 */
interface FieldsEditorState {
  openDef: Block | null
  /** 标签视角的标签 id；页上为空（页的字段段没有「标签作用域」可言） */
  focusTagId: string
  editor: ChoicesEditor | null
}

/**
 * 把字段声明画进 `host`（通常是抽屉的 body）。
 *
 * 与别名编辑器同形：每次写入后重绘自己（连续加/解声明），关闭由抽屉的 ✕ 负责。
 */
export function renderFieldsEditor(host: HTMLElement, deps: FieldsEditorDeps): void {
  const state: FieldsEditorState = { openDef: null, focusTagId: '', editor: null }

  const draw = (): void => {
    const b = deps.block()
    host.replaceChildren()
    host.classList.add('fields-editor')
    if (!b) {
      deps.close()
      return
    }

    /* --------------------------------------------------------- 已声明 */

    const declared = deps.kb.declaredFieldsOf(b.id)
    const declaredBox = document.createElement('div')
    declaredBox.className = 'fields-section'
    const declaredHead = document.createElement('div')
    declaredHead.className = 'fields-section-title'
    declaredHead.textContent = t('ui.alias.declared')
    declaredBox.appendChild(declaredHead)

    if (declared.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'props-empty'
      empty.textContent = t('ui.alias.noFields')
      declaredBox.appendChild(empty)
    }
    for (const def of declared) {
      const row = document.createElement('div')
      row.className = 'fields-row ui-row'
      row.dataset.fieldId = def.id
      const label = document.createElement('span')
      label.className = 'fields-label ui-ellipsis ui-ellipsis-grow'
      label.textContent = plainText(def.content).trim() || def.id
      const kind = document.createElement('span')
      kind.className = 'fields-kind'
      kind.textContent = t(`ui.props.kind.${propKindOf(def)}`)
      if (propKindOf(def) === 'select') {
        const opt = document.createElement('button')
        opt.type = 'button'
        opt.className = 'fields-choices'
        opt.dataset.aliasFieldChoices = '1'
        opt.textContent = t('ui.props.choice.open')
        opt.title = t('ui.props.choice.openTitle')
        opt.addEventListener('click', () => {
          state.openDef = state.openDef?.id === def.id ? null : def
          state.focusTagId = hasList(b, 'tag') ? b.id : ''
          state.editor ??= new ChoicesEditor({
            def: () => state.openDef ?? undefined,
            tagById: (id) => deps.kb.get(id),
            tags: () => deps.kb.tags(),
            focusTag: () => state.focusTagId,
            write: deps.choices,
            tagName: (id) => {
              const tag = deps.kb.get(id)
              return tag ? displayNameOf(tag) || id.slice(-6) : id.slice(-6)
            },
          })
          draw()
        })
        row.append(label, kind, opt)
      } else {
        row.append(label, kind)
      }
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'fields-remove'
      remove.dataset.aliasFieldRemove = '1'
      remove.title = t('ui.alias.removeField')
      remove.textContent = '×'
      remove.addEventListener('click', () => {
        deps.write(() => undeclareField(b, def.id))
        draw()
      })
      row.appendChild(remove)
      declaredBox.appendChild(row)
    }
    host.appendChild(declaredBox)

    if (state.openDef) {
      state.editor?.render()
      if (state.editor) host.appendChild(state.editor.root)
    }

    /* --------------------------------------------------------- 可添加 */

    const used = new Set(declared.map((d) => d.id))
    const candidates = deps.kb.propDefs().filter((d) => !used.has(d.id))
    const addBox = document.createElement('div')
    addBox.className = 'fields-section'
    const addHead = document.createElement('div')
    addHead.className = 'fields-section-title'
    addHead.textContent = t('ui.alias.addField')
    addBox.appendChild(addHead)

    const canDeclare = listsOf(b).length > 0
    if (!canDeclare) {
      const hint = document.createElement('p')
      hint.className = 'fields-hint'
      hint.textContent = t('ui.alias.needList')
      addBox.appendChild(hint)
    }
    if (candidates.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'props-empty'
      empty.textContent = t('ui.alias.noCandidates')
      addBox.appendChild(empty)
    }
    for (const def of candidates) {
      const row = document.createElement('div')
      row.className = 'fields-row ui-row'
      row.dataset.fieldId = def.id
      const label = document.createElement('span')
      label.className = 'fields-label ui-ellipsis ui-ellipsis-grow'
      label.textContent = plainText(def.content).trim() || def.id
      const kind = document.createElement('span')
      kind.className = 'fields-kind'
      kind.textContent = t(`ui.props.kind.${propKindOf(def)}`)
      const add = document.createElement('button')
      add.type = 'button'
      add.className = 'fields-add'
      add.dataset.aliasFieldAdd = '1'
      add.textContent = t('ui.alias.addField')
      add.disabled = !canDeclare
      add.addEventListener('click', () => {
        if (!canDeclare) {
          deps.toast?.(t('ui.alias.needList'), 'warn')
          return
        }
        deps.write(() => declareField(b, def.id))
        draw()
      })
      row.append(label, kind, add)
      addBox.appendChild(row)
    }
    host.appendChild(addBox)
  }

  draw()
}
