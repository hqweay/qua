/**
 * **多键排序的行编辑器**：一行一键（字段 ＋ 方向 ＋ 上移/下移/移除），数组序即优先级。
 *
 * 草稿态：行内改动只改草稿，「应用」才把整份交给调用方落盘——排序是一份数组，
 * 逐手势写盘会产生多笔撤销，且半途的中间序没有意义。
 * 消费方两处（视图选项面板与派生栏镜头面板）：候选键由调用方给，
 * 这里只管编辑交互；空草稿也照常应用（＝不排序，调用方自己决定怎么清）。
 */
import { t } from '../../core/infra/msg.ts'
import type { SortKey } from '../../core/index.ts'

/** 一行候选：排序键 ＋ 显示名 */
export interface SortRowField {
  id: string
  label: string
}

export function paintSortRows(
  body: HTMLElement,
  fields: readonly SortRowField[],
  draft: SortKey[],
  apply: (draft: SortKey[]) => void,
): void {
  const repaint = (): void => {
    body.replaceChildren()
    paintSortRows(body, fields, draft, apply)
  }
  draft.forEach((s, i) => {
    const row = document.createElement('div')
    row.className = 'qsp-row'
    const col = document.createElement('select')
    col.className = 'qsp-field ui-input'
    for (const f of fields) {
      const o = document.createElement('option')
      o.value = f.id
      o.textContent = f.label
      col.append(o)
    }
    col.value = s.by
    if (col.value !== s.by) col.value = ''
    col.onchange = () => {
      draft[i] = { ...s, by: col.value }
      repaint()
    }
    const dir = document.createElement('select')
    dir.className = 'qsp-dir ui-input'
    for (const [v, key] of [
      ['asc', 'ui.view.sortAsc'],
      ['desc', 'ui.view.sortDesc'],
    ] as const) {
      const o = document.createElement('option')
      o.value = v
      o.textContent = t(key)
      dir.append(o)
    }
    dir.value = s.dir
    dir.onchange = () => {
      draft[i] = { ...s, dir: dir.value === 'desc' ? 'desc' : 'asc' }
      repaint()
    }
    const ops = document.createElement('span')
    ops.className = 'qsp-ops'
    for (const [label, disabled, act] of [
      ['↑', i === 0, (): void => {
        ;[draft[i - 1], draft[i]] = [draft[i]!, draft[i - 1]!]
      }],
      ['↓', i === draft.length - 1, (): void => {
        ;[draft[i + 1], draft[i]] = [draft[i]!, draft[i + 1]!]
      }],
      ['×', false, (): void => {
        draft.splice(i, 1)
      }],
    ] as const) {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = label
      b.disabled = disabled
      b.addEventListener('click', () => {
        act()
        repaint()
      })
      ops.append(b)
    }
    row.append(col, dir, ops)
    body.append(row)
  })
  // 添加一行：只列还没在用的字段；选了当场落一行（方向缺省升序，行内可改）
  const unused = fields.filter((f) => !draft.some((s) => s.by === f.id))
  const add = document.createElement('select')
  add.className = 'qsp-add ui-input'
  const placeholder = document.createElement('option')
  placeholder.value = ''
  placeholder.textContent = t('ui.query.sortAdd')
  add.append(placeholder)
  for (const f of unused) {
    const o = document.createElement('option')
    o.value = f.id
    o.textContent = f.label
    add.append(o)
  }
  add.disabled = unused.length === 0
  add.onchange = () => {
    if (add.value === '') return
    draft.push({ by: add.value, dir: 'asc' })
    repaint()
  }
  body.append(add)
  const applyBtn = document.createElement('button')
  applyBtn.type = 'button'
  applyBtn.className = 'qsp-apply ui-btn'
  applyBtn.textContent = t('ui.query.builder.apply')
  applyBtn.addEventListener('click', () => apply(draft))
  body.append(applyBtn)
}
