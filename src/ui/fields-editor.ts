/**
 * **字段声明**（页/标签声明了哪些属性可用）。
 *
 * 判据：声明是「这条属性在我的成员/子块上有一格」，不是「给这一块设一个值」。
 * 所以这里只做三件事：列已声明、解除声明、从现有定义里加一条。
 * 值的编辑仍在属性面板 —— 同一个值不该有两个编辑面。
 *
 * ⚠️ 解除声明**不动值**：成员块上的值落回「本块自有」，重新声明后自动回来。
 * ⚠️ 只有页/标签能声明（`declareField` 的判据）；没有露面时按钮禁用并说明原因。
 */
import {
  declareField,
  listsOf,
  propKindOf,
  undeclareField,
  type Block,
} from '../core/index.ts'
import type { KbClient } from '../core/kb/types.ts'
import { plainText } from '../core/runs.ts'
import { t } from '../core/msg.ts'

export interface FieldsEditorDeps {
  /** 读门面：已声明的字段与定义清单都是命名的库读 */
  kb: KbClient
  block: () => Block | undefined
  write: (mutate: () => void) => void
  close: () => void
  toast?: (text: string, kind?: 'ok' | 'warn' | 'info') => void
}

/**
 * 把字段声明画进 `host`（通常是抽屉的 body）。
 *
 * 与别名编辑器同形：每次写入后重绘自己（连续加/解声明），关闭由抽屉的 ✕ 负责。
 */
export function renderFieldsEditor(host: HTMLElement, deps: FieldsEditorDeps): void {
  const b = deps.block()
  host.replaceChildren()
  host.classList.add('fields-editor')
  if (!b) {
    deps.close()
    return
  }

  const redraw = (): void => renderFieldsEditor(host, deps)

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
    row.className = 'fields-row'
    row.dataset.fieldId = def.id
    const label = document.createElement('span')
    label.className = 'fields-label'
    label.textContent = plainText(def.content).trim() || def.id
    const kind = document.createElement('span')
    kind.className = 'fields-kind'
    kind.textContent = t(`ui.props.kind.${propKindOf(def)}`)
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'fields-remove'
    remove.dataset.aliasFieldRemove = '1'
    remove.title = t('ui.alias.removeField')
    remove.textContent = '×'
    remove.addEventListener('click', () => {
      deps.write(() => undeclareField(b, def.id))
      redraw()
    })
    row.append(label, kind, remove)
    declaredBox.appendChild(row)
  }
  host.appendChild(declaredBox)

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
    row.className = 'fields-row'
    row.dataset.fieldId = def.id
    const label = document.createElement('span')
    label.className = 'fields-label'
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
      redraw()
    })
    row.append(label, kind, add)
    addBox.appendChild(row)
  }
  host.appendChild(addBox)
}
