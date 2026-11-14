/**
 * **行内格式词汇表**（条件树 mark 行的编辑面）：布尔轴按钮 ＋ 两个色轴 ＋ 实时预览。
 *
 * 词汇本身只有一份，住在 `core/model/runs.ts`（`MARK_KINDS`／`COLOR_SLOTS`／
 * `markDescriptors`）；预览复用**正文渲染的同一套 class 链**（`mk-*`／`mk-ink[data-slot]`，
 * 颜色全在 token 上）——条件里选出来的格式与正文里看到的格式是同一句话。
 *
 * 与划选气泡是**同一份词汇的两种交互**：气泡改的是选区（发格式命令），这里改的是
 * 条件的 marks 值（点当前槽即取消，与气泡的手感一致）。气泡绑在选区与命令路径上
 * 不能整体搬，所以这里按同一份词汇自画按钮；两处共享的是 core 的常量与投影。
 */
import { COLOR_SLOTS, MARK_KINDS, type ColorSlot, type Marks, type MarkKind } from '../../core/model/runs.ts'
import { t, type MsgId } from '../../core/infra/msg.ts'
import { renderIcon } from '../../view/icons.ts'

/** 布尔轴：五颗按钮（与划选气泡的格式组同一组词汇） */
const BOOL_BUTTONS: readonly { kind: MarkKind; icon: string; label: MsgId }[] = [
  { kind: 'bold', icon: 'lucide:bold', label: 'menu.label.bold' },
  { kind: 'italic', icon: 'lucide:italic', label: 'menu.label.italic' },
  { kind: 'underline', icon: 'lucide:underline', label: 'menu.label.underline' },
  { kind: 'strike', icon: 'lucide:strikethrough', label: 'menu.label.strike' },
  { kind: 'code', icon: 'lucide:code', label: 'menu.label.code' },
]

const AXIS_ICON: Record<'ink' | 'bg', string> = { ink: 'lucide:baseline', bg: 'lucide:highlighter' }
const AXIS_LABEL: Record<'ink' | 'bg', MsgId> = { ink: 'menu.label.ink', bg: 'menu.label.bg' }

export interface MarkPickerOpts {
  /** 当前值（组件不持有状态：每次画都现读，调用方在 onChange 里写回行） */
  marks: () => Marks
  /** 下一态交给调用方（写回行、同步「应用」可用性）；组件随后自己重画 */
  onChange: (next: Marks) => void
}

/** mark 行的编辑面：按钮条 ＋ 展开的值轴 ＋ 预览文本。组件自绘自刷，不依赖整树重画 */
export function markPicker(opts: MarkPickerOpts): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'qt-markwrap'
  const bar = document.createElement('div')
  bar.className = 'qt-markbar'
  bar.setAttribute('role', 'toolbar')
  const preview = document.createElement('span')
  preview.className = 'qt-markpreview'
  wrap.append(bar, preview)

  /** 展开的值轴（同一时刻最多一个；再点收回——气泡同款手势） */
  let openAxis: 'ink' | 'bg' | null = null

  /** 预览文本：把 marks 套上去。两根色轴并存时嵌两层（与正文渲染同构） */
  const paintPreview = (marks: Marks): void => {
    const root = document.createElement('span')
    root.textContent = t('ui.query.mark.preview')
    const ink = marks.ink
    const bg = marks.bg
    const outer = bg !== undefined ? document.createElement('span') : root
    const inner = ink !== undefined ? document.createElement('span') : root
    if (bg !== undefined) {
      outer.className = 'mk-bg'
      outer.dataset.slot = bg
      outer.appendChild(root)
    }
    if (ink !== undefined) {
      inner.className = 'mk-ink'
      inner.dataset.slot = ink
      // 两个轴都在：ink 套在 bg 内层；只有一个轴时 inner === root，class 直接落上去
      if (inner !== root) outer.appendChild(inner)
    }
    for (const k of MARK_KINDS) {
      if (marks[k] === true) root.classList.add(`mk-${k}`)
    }
    preview.replaceChildren(outer)
  }

  const paint = (): void => {
    bar.replaceChildren()
    const marks = opts.marks()
    for (const b of BOOL_BUTTONS) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'qt-mkbtn'
      btn.dataset.tip = t(b.label)
      renderIcon(btn, b.icon, 'circle-help')
      if (marks[b.kind] === true) btn.dataset.on = '1'
      btn.addEventListener('click', () => {
        // 布尔轴与值轴写进同一个映射，TS 对联合键的写入收窄成 `undefined`——按格写入
        const next = { ...marks } as Record<string, true | ColorSlot>
        if (next[b.kind] === true) delete next[b.kind]
        else next[b.kind] = true
        opts.onChange(next as Marks)
        paint()
      })
      bar.append(btn)
    }
    for (const axis of ['ink', 'bg'] as const) {
      const cur = marks[axis]
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'qt-mkbtn qt-mkaxis'
      btn.dataset.tip = t(AXIS_LABEL[axis])
      renderIcon(btn, AXIS_ICON[axis], 'circle-help')
      if (cur !== undefined) {
        // 当前值只占图标下缘一条 2px 色标（气泡同款），值域进展开层
        const chip = document.createElement('span')
        chip.className = 'qt-axisvalue'
        chip.dataset.slot = cur
        btn.appendChild(chip)
      }
      if (openAxis === axis) btn.dataset.on = '1'
      btn.addEventListener('click', () => {
        openAxis = openAxis === axis ? null : axis
        paint()
      })
      bar.append(btn)
      if (openAxis === axis) bar.append(swatchRow(axis, cur))
    }
    paintPreview(marks)
  }

  /** 一个值轴的七个色槽；点当前槽即取消（`toggleMark` 的既有语义） */
  const swatchRow = (axis: 'ink' | 'bg', current: ColorSlot | undefined): HTMLElement => {
    const row = document.createElement('div')
    row.className = 'qt-swatches'
    row.dataset.axis = axis
    for (const slot of COLOR_SLOTS) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'qt-swatch'
      b.dataset.slot = slot
      if (slot === current) b.dataset.on = '1'
      b.dataset.tip = `${t(AXIS_LABEL[axis])}·${t(`ui.color.${slot}` as MsgId)}`
      b.addEventListener('click', () => {
        const next: Marks = { ...opts.marks() }
        if (slot === current) delete next[axis]
        else next[axis] = slot
        opts.onChange(next)
        paint()
      })
      row.append(b)
    }
    return row
  }

  paint()
  return wrap
}
