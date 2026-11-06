/**
 * **属性取值菜单**：单选关掉即写，多选留在原地逐项勾。
 *
 * 为什么住在 app 层：它要开浮层（`Layers`）＋ 写值（调用方给命令/回调），
 * 而视图层不能 import ui（`view` 不得反向依赖 `ui`）。正文 gutter、属性卡、
 * 表格共用这一个实现——三处各写一份，就会出现「正文能多选、表格只能单选」。
 *
 * 单选/多选不是两个菜单：行、图标、空态都一样，差别只有「选中后关不关」与
 * 「写回 string 还是 string[]」。这个差别由定义的 `_cardinality` 决定，不由调用方猜。
 */
import { ICON_PROP, cardinalityOf, plainText, prop, type Block } from '../core/index.ts'
import { t } from '../core/infra/msg.ts'
import type { Layers, Row } from '../ui/overlay/layers.ts'

export interface ChoicePickerOpts {
  layers: Layers
  /** 属性定义块（`_cardinality` 从这里读，调用方不再传「是不是多选」） */
  def: Block
  /** 这个块此刻能选的选项（已按作用域过滤，兄弟序） */
  choices: readonly Block[]
  /** 单选：当前选项 id；多选：当前选项 id 列表 */
  current: string | readonly string[]
  /** 锚点（缺省 ⇒ 菜单自己找落点，与命令面板同一条兜底） */
  anchor?: DOMRect | null
  /** 选项显示名（同名选项带作用域；缺省只用正文） */
  labelOf?: (choice: Block) => string
  /** 选中后写回：单选给 string，多选给 string[]（顺序＝选项兄弟序） */
  onPick: (next: string | string[]) => void
  title?: string
}

/** 打开取值菜单；多选时保持打开，每点一行写一次（每次一次撤销） */
export function openChoicePicker(o: ChoicePickerOpts): void {
  const multi = cardinalityOf(o.def) === 'many'
  const labelOf = o.labelOf ?? ((c: Block) => plainText(c.content).trim() || c.id.slice(-6))
  const iconOf = (c: Block): string | undefined =>
    prop<string>(c, ICON_PROP) ?? prop<string>(o.def, ICON_PROP)
  const known = new Set(o.def.children.map((c) => c.id))
  const selected = new Set<string>(
    multi
      ? Array.isArray(o.current)
        ? o.current
        : o.current === ''
          ? []
          : [String(o.current)]
      : o.current === ''
        ? []
        : [String(o.current)],
  )

  const rows = (): Row[] =>
    o.choices.map((c) => {
      const icon = iconOf(c)
      return {
        id: `choice/${c.id}`,
        label: labelOf(c),
        ...(icon ? { icon } : {}),
        ...(selected.has(c.id)
          ? { keyHint: multi ? '✓' : t('ui.props.choice.current') }
          : {}),
      }
    })

  o.layers.openMenu({
    rows: rows(),
    anchor: o.anchor ?? null,
    title: o.title ?? t(multi ? 'ui.props.pickChoiceMulti' : 'ui.props.pickChoice'),
    searchable: true,
    focusSearch: true,
    emptyText: t('ui.props.choice.empty'),
    // 多选：勾一项不关，继续勾；单选沿用「选中即关」
    ...(multi ? { keepOpen: true } : {}),
    onPick: (row) => {
      const id = String(row.id).slice('choice/'.length)
      if (!multi) {
        o.onPick(id)
        return
      }
      if (selected.has(id)) selected.delete(id)
      else selected.add(id)
      /**
       * 写回的顺序＝**选项兄弟序**（不是勾选顺序）：多值是一个集合，
       * 顺序再承载语义就得维护第二份 order，而选项的顺序已经有一份了。
       * 不在定义里的旧值（另一个库/已 purge）原样留在末尾，不静默丢。
       */
      const next = o.def.children.filter((c) => selected.has(c.id)).map((c) => c.id)
      for (const x of selected) if (!known.has(x)) next.push(x)
      o.onPick(next)
      o.layers.setRows(rows())
    },
  })
}
