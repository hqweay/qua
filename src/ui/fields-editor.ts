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
  declaredFieldIds,
  displayNameOf,
  hasList,
  listsOf,
  propDisplayLabels,
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
    const owner: Block = b

    /* --------------------------------------------------------- 已声明 */

    const declared = deps.kb.declaredFieldsOf(b.id)
    const labels = propDisplayLabels(deps.kb.roots())
    const shownOf = (def: Block): string => labels.get(def.id) ?? (plainText(def.content).trim() || def.id)
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
      label.textContent = shownOf(def)
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

    /**
     * 候选按 `_fieldDefs` 分三组（本标签／未声明／其他标签），是声明的**分组视图**。
     * 其他标签的属性不隐藏：藏起来会让清单看起来是空的，用户以为库里没有那条属性。
     */
    const declarations = new Map<string, Block[]>()
    for (const tag of deps.kb.tags()) {
      for (const propId of declaredFieldIds(tag)) {
        const list = declarations.get(propId)
        if (list) list.push(tag)
        else declarations.set(propId, [tag])
      }
    }
    const ownTagId = hasList(b, 'tag') ? b.id : ''
    const groupOf = (def: Block): 0 | 1 | 2 => {
      const declaring = declarations.get(def.id) ?? []
      if (ownTagId !== '' && declaring.some((tag) => tag.id === ownTagId)) return 0
      return declaring.length === 0 ? 1 : 2
    }
    const groupTitles = [t('ui.props.groupOwn'), t('ui.props.groupUndeclared'), t('ui.props.groupOther')]
    const buckets: Block[][] = [[], [], []]
    for (const def of candidates) buckets[groupOf(def)]!.push(def)
    for (const [i, bucket] of buckets.entries()) {
      if (bucket.length === 0) continue
      const head = document.createElement('div')
      head.className = 'fields-group-title'
      head.textContent = groupTitles[i]!
      addBox.appendChild(head)
      for (const def of bucket) addBox.appendChild(candidateRow(def))
    }
    host.appendChild(addBox)

    /** 一行候选：名字用 `propDisplayLabels`（同名属性带来源），点它自己的按钮声明 */
    function candidateRow(def: Block): HTMLElement {
      const row = document.createElement('div')
      row.className = 'fields-row ui-row'
      row.dataset.fieldId = def.id
      const label = document.createElement('span')
      label.className = 'fields-label ui-ellipsis ui-ellipsis-grow'
      label.textContent = shownOf(def)
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
        deps.write(() => declareField(owner, def.id))
        draw()
      })
      row.append(label, kind, add)
      return row
    }
  }

  draw()
}
