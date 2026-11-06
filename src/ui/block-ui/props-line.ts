/**
 * **块下属性行**：一条只读投影 ＋ 一次点击进编辑面。
 *
 * 为什么是投影而不是第二个编辑器：值住在 `props`，这一行每次渲染从 `fieldRows`
 * 现算；写入仍然只有一条路（属性面板里的值控件 → `core.props/set-value`）。
 * 这就是它与「把属性写成正文」（`key:: value`）的分界 —— 位置变了，真相没变。
 *
 * 为什么点一下是开面板而不是就地出输入框：行在正文里、只有一行高（虚拟化按定高估），
 * 常驻输入框会把「一行字」变成一排控件，还要处理焦点、IME、重排换掉正在输入的节点。
 * 面板里的值控件是现成的，点过去就落在那一栏上（`focusPropId`）。
 *
 * ⚠️ 值文本**只在这里格式化**：gutter 图标、表格列、面板各自有自己的画法，
 *    但「这一行写什么」只有这一份，免得同一块在四个面上给出四种说法。
 */
import { t } from '../../core/infra/msg.ts'
import type { BelowFields, FieldRow } from '../../core/index.ts'

export interface PropsLineDeps {
  /** 点一项（或 `+N`）⇒ 打开属性面板；给了 `propId` 就聚焦那一栏 */
  inspect: (blockId: string, propId?: string) => void
  /** `ref` 值的显示名（目标可能已删，交给调用方兜底） */
  refLabel: (targetId: string) => string
  /** 最多画几对（其余收成 `+N`）；缺省 3，与多值图标的 `cap` 同一档 */
  cap?: number
}

/**
 * 一行属性画成什么字（**这一行的唯一格式化点**）。
 *
 * 空值不进来（`belowFieldsFor` 只给有值的行），所以这里不做「待填」分支；
 * 选项已删/作用域隐藏时保留旧名并标注 —— 与面板同一条兜底。
 */
export function fieldRowText(row: FieldRow, refLabel: (id: string) => string): string {
  if (row.kind === 'select') {
    if (row.cardinality === 'many') return (row.currentChoiceLabels ?? []).join('、')
    return row.currentChoiceLabel ?? t('ui.props.choice.deleted')
  }
  if (row.kind === 'checkbox') {
    return row.value === true ? t('ui.props.checkboxOn') : t('ui.props.checkboxOff')
  }
  if (row.kind === 'ref') {
    return row.value === undefined || row.value === null || row.value === ''
      ? ''
      : refLabel(String(row.value))
  }
  return row.value === undefined || row.value === null ? '' : String(row.value)
}

export function renderPropsLine(
  blockId: string,
  data: BelowFields,
  into: HTMLElement,
  deps: PropsLineDeps,
): void {
  const cap = deps.cap ?? 3
  const shown = data.rows.slice(0, cap)
  into.replaceChildren()
  into.title = t('ui.props.lineHint')

  shown.forEach((row, i) => {
    if (i > 0) {
      const sep = document.createElement('span')
      sep.className = 'blk-prop-sep'
      sep.textContent = '·'
      sep.setAttribute('aria-hidden', 'true')
      into.appendChild(sep)
    }
    const pair = document.createElement('button')
    pair.type = 'button'
    pair.className = 'blk-prop'
    pair.dataset.propId = row.propId
    const name = document.createElement('span')
    name.className = 'blk-prop-name'
    name.textContent = row.label
    const value = document.createElement('span')
    value.className = 'blk-prop-value ui-ellipsis'
    value.textContent = fieldRowText(row, deps.refLabel)
    pair.append(name, value)
    pair.addEventListener('click', () => deps.inspect(blockId, row.propId))
    into.appendChild(pair)
  })

  /**
   * `+N` ＝ **没画出来的项**（超出上限的有值行 ＋ 声明了但没填的行）。
   * 不静默截断：条数写出来，点进去能看到全部（面板里空值标「待填」）。
   */
  const more = data.rows.length - shown.length + data.pending
  if (more > 0) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'blk-prop-more'
    btn.textContent = t('ui.props.lineMore', { n: more })
    btn.title = t('ui.props.lineMoreHint')
    btn.addEventListener('click', () => deps.inspect(blockId))
    into.appendChild(btn)
  }
}
