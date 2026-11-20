/**
 * **自动化块的身体**（三段式：当／如果／就 ＋ 运行）。
 *
 * 与查询体同一条分工：行的正文是名字（`.tx`），身体是另一格（`.blk-view-body`）；
 * 定义住 `_automation`，**画出来的一句话是渲染不是落盘**。
 *
 * 编辑面（v1 手动链）：
 *   · 「就」的步骤全量可编辑——加步骤的菜单来自**命令契约本身**（`automation: true`
 *     的声明），参数格的画法来自 args 的 `ref` 元数据（那两格是唯一来源，这里不硬编码）；
 *   · 「当」显示触发器 chips（事件引擎接上之前，事件触发器只是数据——显示不执行）；
 *   · 「如果」显示条件 chips（条件的编辑面随事件引擎一片来；机器形状已在）。
 *
 * 每次编辑＝整份 canonical 定义写回 `_automation`（一笔事务、一步撤销）；
 * 本组件订阅 store，外部改动（撤销/别的视图）就地重画，不依赖行重建。
 */
import {
  choicesOf,
  isPropDefBlock,
  propKindOf,
  propLabel,
  type AutomationDef,
  type AutomationStep,
  type AutomationTrigger,
  type ArgRef,
  type Block,
} from '../../core/index.ts'
import { DECL_BY_NAME } from '../../core/commands/decls.ts'
import { STEP_COMMANDS } from '../../core/automation/run.ts'
import { canonicalAutomation, readAutomation } from '../../core/automation/automation.ts'
import { displayNameOf } from '../../core/identity/alias.ts'
import type { QuerySpec } from '../../core/query/query.ts'
import { queryChips } from '../query/query-builder.ts'
import { t } from '../../core/infra/msg.ts'
import type { Row } from '../overlay/layers.ts'

/** 身体的宿主能力（装配层注入；组件自己不碰命令面与浮层） */
export interface AutomationBodyDeps {
  /** 候选清单的读面（步骤参数的 picker 数据；机器面同源，不另建清单） */
  kb: {
    propDefs(): readonly Block[]
    tags(): readonly Block[]
    pages(): readonly Block[]
    get(id: string): Block | undefined
  }
  /** 本块的 id（重画时按 id 现取——undo 可能换块对象，活引用会过期） */
  blockId: string
  /** 本块此刻的样子（重画统一现取；行没了给 undefined） */
  getBlock(): Block | undefined
  /** store 订阅（外部改动 ⇒ sync）；返回退订函数 */
  subscribe(fn: (source?: unknown, ids?: readonly string[]) => void): () => void
  /** 打开一个选择菜单（行由组件造；浮层归装配层） */
  openMenu(rows: Row[], onPick: (row: Row) => void, title: string): void
  /**
   * 运行（目标选择也在装配层）：打开的选择器**就是「如果」的命中集**——
   * 有条件列命中块（外加「全部运行」一行），没条件才是全库可搜（每块都算数）。
   */
  onRun(): void
  onToggle(on: boolean): void
  /** 整份定义写回（canonical 之后的；装配层负责事务、撤销与重画） */
  writeDef(def: AutomationDef): void
  /** 打开「如果」的条件编辑弹层（同一台条件树；应用写 `_automation.when`） */
  editWhen(): void
  /** 全库挑一块（触发器父块等处的点名候选；空词列页/标签，打字全库搜） */
  pickBlock(title: string, onPick: (blockId: string) => void): void
}

export interface AutomationBody {
  root: HTMLElement
  dispose(): void
}

export function createAutomationBody(deps: AutomationBodyDeps): AutomationBody {
  const root = document.createElement('div')
  root.className = 'blk-auto'
  let off: (() => void) | null = null
  let disposed = false

  const render = (): void => {
    if (disposed) return
    const block = deps.getBlock()
    if (!block) return
    const def = readAutomation(block)
    root.replaceChildren()

    /* ---- 抬头：启停开关 ＋ 运行 ---- */
    const head = document.createElement('div')
    head.className = 'blk-auto-head'
    head.contentEditable = 'false'
    const enabled = def?.enabled === true
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'blk-auto-toggle'
    toggle.dataset.on = enabled ? '1' : '0'
    toggle.textContent = enabled ? t('ui.automation.on') : t('ui.automation.off')
    toggle.addEventListener('click', () => deps.onToggle(!enabled))
    const run = document.createElement('button')
    run.type = 'button'
    run.className = 'blk-auto-run'
    if (enabled) run.dataset.enabled = '1'
    run.textContent = t('ui.automation.run')
    run.title = t('ui.automation.runHint')
    run.addEventListener('click', () => deps.onRun())
    head.append(toggle, run)
    root.appendChild(head)

    // 坏形状：一句话指到定义（修复面＝打开那一块改 `_automation`；不静默消失）
    if (!def) {
      const broken = document.createElement('div')
      broken.className = 'blk-auto-broken'
      broken.textContent = t('ui.automation.broken')
      root.appendChild(broken)
      return
    }

    root.appendChild(section('when', t('ui.automation.secWhen'), whenRows(def)))
    root.appendChild(section('cond', t('ui.automation.secIf'), condRows(def)))
    root.appendChild(section('steps', t('ui.automation.secThen'), stepRows(def)))
  }

  /* ------------------------------------------------------------ 三段 */

  const section = (kind: string, title: string, rows: HTMLElement[]): HTMLElement => {
    const sec = document.createElement('div')
    sec.className = 'blk-auto-sec'
    sec.dataset.sec = kind
    const label = document.createElement('span')
    label.className = 'blk-auto-sec-label'
    label.textContent = title
    sec.appendChild(label)
    for (const r of rows) sec.appendChild(r)
    return sec
  }

  /** 一枚 chip（只读；点击行为由调用方接） */
  const chip = (text: string, cls: string, onClick?: () => void): HTMLElement => {
    const c = document.createElement(onClick ? 'button' : 'span')
    if (onClick) {
      ;(c as HTMLButtonElement).type = 'button'
      c.addEventListener('click', onClick)
    }
    c.className = `blk-auto-chip ui-ellipsis ${cls}`
    c.textContent = text
    return c
  }

  /** 一条触发器的人话（chip 显示；与引擎的触发键同一份形状来源） */
  const triggerText = (tr: AutomationTrigger): string => {
    if (tr === 'manual') return t('ui.automation.trigger.manual')
    if (tr.kind === 'prop') {
      const name = labelOfProp(tr.prop)
      if (tr.to === undefined) return t('ui.automation.trigger.propAny', { prop: name })
      // checkbox 的值位是布尔：人话用勾选两态，不走选项名解析
      if (typeof tr.to === 'boolean') {
        return t('ui.automation.trigger.propTo', { prop: name, to: t(tr.to ? 'ui.automation.valueChecked' : 'ui.automation.valueUnchecked') })
      }
      return t('ui.automation.trigger.propTo', { prop: name, to: choiceLabelOf(tr.prop, tr.to) })
    }
    if (tr.kind === 'tag') {
      return t(tr.on === 'added' ? 'ui.automation.trigger.tagOn' : 'ui.automation.trigger.tagOff', { tag: labelOfTag(tr.tag) })
    }
    if (tr.parent === undefined) return t('ui.automation.trigger.childAdded')
    return t('ui.automation.trigger.childAddedUnder', { parent: labelOfBlock(tr.parent) })
  }

  const whenRows = (def: AutomationDef): HTMLElement[] => {
    const rows: HTMLElement[] = []
    const line = document.createElement('div')
    line.className = 'blk-auto-chips'
    const hasAuto = def.triggers.some((tr) => tr !== 'manual')
    if (!hasAuto) {
      // 手动运行的 UI 之家是头部「运行…」按钮：当段只列自动触发器，没有就说一句
      line.appendChild(chip(t('ui.automation.noAutoTrigger'), 'is-muted'))
    }
    def.triggers.forEach((tr, i) => {
      if (tr === 'manual') return
      // 点已有的触发器 ⇒ 改／删它（菜单在装配层）
      line.appendChild(chip(triggerText(tr), 'is-event', () => openTriggerMenu(def, i)))
    })
    line.appendChild(chip(t('ui.automation.addTrigger'), 'is-edit', () => openTriggerAddMenu(def)))
    rows.push(line)
    return rows
  }

  /** 已有事件触发器的菜单：删除；`child.added` 另给「改父块」 */
  const openTriggerMenu = (def: AutomationDef, at: number): void => {
    const tr = def.triggers[at]
    if (tr === undefined || tr === 'manual') return
    const rows: Row[] = [{ id: 'trigger/remove', label: t('ui.automation.removeTrigger'), group: 'trigger/1' }]
    if (tr.kind === 'child.added') {
      rows.push({ id: 'trigger/reparent', label: t('ui.automation.reparent'), group: 'trigger/1' })
    }
    deps.openMenu(rows, (row) => {
      if (row.id === 'trigger/remove') {
        write({ ...def, triggers: def.triggers.filter((_, i) => i !== at) })
        return
      }
      if (row.id === 'trigger/reparent') {
        pickParent((parentId) => {
          const next = def.triggers.map((x, i) => (i === at && x !== 'manual' && x.kind === 'child.added' ? { ...x, parent: parentId === '' ? undefined : parentId } : x))
          write({ ...def, triggers: next })
        })
      }
    }, triggerText(tr))
  }

  /** 加触发器：四种事件（属性变化／打标签／摘标签／新建子块）；手动是出生默认档 */
  const openTriggerAddMenu = (def: AutomationDef): void => {
    const rows: Row[] = [
      { id: 'add/prop', label: t('ui.automation.trigger.addProp'), group: 'trigger/1' },
      { id: 'add/tagOn', label: t('ui.automation.trigger.addTagOn'), group: 'trigger/1' },
      { id: 'add/tagOff', label: t('ui.automation.trigger.addTagOff'), group: 'trigger/1' },
      { id: 'add/child', label: t('ui.automation.trigger.addChild'), group: 'trigger/1' },
    ]
    deps.openMenu(rows, (row) => {
      if (row.id === 'add/prop') {
        pickPropForTrigger(def)
        return
      }
      if (row.id === 'add/tagOn' || row.id === 'add/tagOff') {
        const on: 'added' | 'removed' = row.id === 'add/tagOn' ? 'added' : 'removed'
        pickTagForTrigger(def, on)
        return
      }
      if (row.id === 'add/child') {
        pickParentForTrigger(def)
        return
      }
    }, t('ui.automation.addTriggerTitle'))
  }

  /** 属性变化触发器：先选字段，再选「变成什么」（select 给选项，checkbox 给两态，其余＝任何变化） */
  const pickPropForTrigger = (def: AutomationDef): void => {
    deps.openMenu(
      deps.kb.propDefs().map((d) => ({ id: d.id, label: propLabel(d) || d.id, group: 'trigger/prop', icon: 'lucide:tag' })),
      (row) => {
        const propId = row.id
        const defBlock = deps.kb.propDefs().find((x) => x.id === propId)
        const kind = defBlock ? propKindOf(defBlock) : undefined
        if (kind === 'select') {
          deps.openMenu(
            [{ id: '', label: t('ui.automation.trigger.propAnyValue'), group: 'trigger/val' }, ...choicesOf(defBlock!).map((c) => ({ id: c.id, label: c.label, group: 'trigger/val' }))],
            (vrow) => {
              const triggers: AutomationTrigger[] = [...def.triggers, vrow.id === '' ? { kind: 'prop', prop: propId } : { kind: 'prop', prop: propId, to: vrow.id }]
              write({ ...def, triggers })
            },
            t('ui.automation.pickValueTitle'),
          )
          return
        }
        if (kind === 'checkbox') {
          deps.openMenu(
            [
              { id: 'any', label: t('ui.automation.trigger.propAnyValue'), group: 'trigger/val' },
              { id: 'on', label: t('ui.automation.valueChecked'), group: 'trigger/val' },
              { id: 'off', label: t('ui.automation.valueUnchecked'), group: 'trigger/val' },
            ],
            (vrow) => {
              const to = vrow.id === 'any' ? undefined : vrow.id === 'on'
              const triggers: AutomationTrigger[] = [...def.triggers, to === undefined ? { kind: 'prop', prop: propId } : { kind: 'prop', prop: propId, to }]
              write({ ...def, triggers })
            },
            t('ui.automation.pickValueTitle'),
          )
          return
        }
        write({ ...def, triggers: [...def.triggers, { kind: 'prop', prop: propId }] })
      },
      t('ui.automation.trigger.addPropTitle'),
    )
  }

  const pickTagForTrigger = (def: AutomationDef, on: 'added' | 'removed'): void => {
    deps.openMenu(
      deps.kb.tags().map((tag) => ({ id: tag.id, label: `#${displayNameOf(tag)}`, group: 'trigger/tag' })),
      (row) => {
        write({ ...def, triggers: [...def.triggers, { kind: 'tag', tag: row.id, on }] })
      },
      t('ui.automation.pickTagTitle'),
    )
  }

  /** 新建子块触发器：任意父块，或点名一个（更深的作用域走「如果」） */
  const pickParentForTrigger = (def: AutomationDef): void => {
    deps.openMenu(
      [
        { id: '', label: t('ui.automation.trigger.anyParent'), group: 'trigger/parent' },
        { id: 'pick', label: t('ui.automation.trigger.pickParent'), group: 'trigger/parent' },
      ],
      (row) => {
        if (row.id === '') {
          write({ ...def, triggers: [...def.triggers, { kind: 'child.added' }] })
          return
        }
        pickParent((parentId) => {
          write({ ...def, triggers: [...def.triggers, parentId === '' ? { kind: 'child.added' } : { kind: 'child.added', parent: parentId }] })
        })
      },
      t('ui.automation.trigger.addChildTitle'),
    )
  }

  const pickParent = (onPick: (parentId: string) => void): void => {
    deps.pickBlock(t('ui.automation.trigger.pickParentTitle'), onPick)
  }

  const condRows = (def: AutomationDef): HTMLElement[] => {
    const rows: HTMLElement[] = []
    const line = document.createElement('div')
    line.className = 'blk-auto-chips'
    // 主语显式化：条件说的是「目标块」——手动时是你选的那块，批量时是每一块，事件时是变化的块
    line.appendChild(chip(t('ui.automation.condSubject'), 'is-subject'))
    if (def.when === undefined) {
      // 无条件也可点：点开同一台条件树（加了条件就不再是「对所有目标」）
      line.appendChild(chip(t('ui.automation.noCond'), 'is-muted', () => deps.editWhen()))
    } else {
      for (const text of condChips(def.when)) line.appendChild(chip(text, 'is-cond', () => deps.editWhen()))
    }
    line.appendChild(chip(t('ui.automation.editCond'), 'is-edit', () => deps.editWhen()))
    rows.push(line)
    return rows
  }

  const condChips = (when: NonNullable<QuerySpec['where']>): string[] => {
    try {
      return queryChips({ where: when }, deps.kb.propDefs().map((d) => ({ id: d.id, label: propLabel(d) || d.id, kind: propKindOf(d) })), (propId) => {
        const def = deps.kb.propDefs().find((x) => x.id === propId)
        return def ? choicesOf(def).map((c) => ({ id: c.id, label: c.label })) : []
      }, (id) => labelOfBlock(id), (id) => labelOfTag(id))
    } catch {
      return [t('ui.automation.complexCond')]
    }
  }

  /* ---- 步骤 ---- */

  const stepRows = (def: AutomationDef): HTMLElement[] => {
    const rows: HTMLElement[] = []
    def.steps.forEach((step, i) => {
      rows.push(stepRow(step, i))
    })
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'blk-auto-add'
    add.textContent = t('ui.automation.addStep')
    add.addEventListener('click', () => openStepMenu(def, def.steps.length))
    rows.push(add)
    return rows
  }

  const stepRow = (step: AutomationStep, index: number): HTMLElement => {
    const row = document.createElement('div')
    row.className = 'blk-auto-step'
    const decl = DECL_BY_NAME.get(step.cmd)
    // 名字来自命令契约本身；契约里没有（别的版本写进来的）按 id 原样显示——读侧降级是设计
    const title = document.createElement('span')
    title.className = 'blk-auto-step-cmd'
    title.textContent = decl?.title ?? step.cmd
    row.appendChild(title)
    for (const cell of stepCells(step)) row.appendChild(cell)
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'blk-auto-step-del'
    del.textContent = '×'
    del.title = t('ui.automation.removeStep')
    del.addEventListener('click', () => {
      const def = readAutomation(deps.getBlock() ?? ({} as Block))
      if (!def) return
      write({ ...def, steps: def.steps.filter((_, i) => i !== index) })
    })
    row.appendChild(del)
    return row
  }

  /** 一个参数格：有值显示成 chip（点开重选），空显示成「待选」（必填格显式说） */
  const argCell = (key: string, current: string, placeholder: string, onPick: () => void): HTMLElement => {
    const filled = current !== ''
    const c = chip(filled ? current : placeholder, filled ? 'is-arg' : 'is-empty', onPick)
    c.dataset.arg = key
    return c
  }

  const stepCells = (step: AutomationStep): HTMLElement[] => {
    const decl = DECL_BY_NAME.get(step.cmd)
    const required = (decl?.args?.required as string[] | undefined) ?? []
    const cells: HTMLElement[] = []
    switch (step.cmd) {
      case 'core.props/set-value': {
        cells.push(propCell(step, required.includes('propId')))
        cells.push(valueCell(step))
        break
      }
      case 'core.props/clear-value': {
        cells.push(propCell(step, required.includes('propId')))
        break
      }
      case 'core.tags/add': {
        cells.push(tagCell(step))
        break
      }
      case 'core.tags/remove': {
        cells.push(tagCell(step))
        break
      }
      case 'core.tree/insert-child': {
        cells.push(textCell(step, 'text'))
        break
      }
      case 'core.tree/move': {
        cells.push(moveTargetCell(step))
        break
      }
      default:
        break
    }
    return cells
  }

  /* ---- 各参数格（编辑动作＝打开选择菜单或行内输入） ---- */

  const withStep = (step: AutomationStep, mutate: (args: Record<string, ArgRef>) => Record<string, ArgRef>): void => {
    const def = readAutomation(deps.getBlock() ?? ({} as Block))
    if (!def) return
    const steps = def.steps.map((s) => (s === step ? { cmd: s.cmd, args: mutate(s.args) } : s))
    write({ ...def, steps })
  }

  const propCell = (step: AutomationStep, required: boolean): HTMLElement => {
    const propId = typeof step.args.propId === 'string' ? step.args.propId : ''
    return argCell('propId', labelOfProp(propId), t(required ? 'ui.automation.pickProp' : 'ui.automation.pickPropAny'), () => {
      deps.openMenu(
        deps.kb.propDefs().map((d) => ({
          id: d.id,
          label: propLabel(d) || d.id,
          group: 'pick/props',
          icon: 'lucide:tag',
        })),
        (row) => withStep(step, (args) => ({ ...args, propId: row.id })),
        t('ui.automation.pickPropTitle'),
      )
    })
  }

  /** 值格：按 propId 现解 kind 再定画法（契约文档写明的分工） */
  const valueCell = (step: AutomationStep): HTMLElement => {
    const propId = typeof step.args.propId === 'string' ? step.args.propId : ''
    const def = deps.kb.propDefs().find((x) => x.id === propId)
    const kind = def ? propKindOf(def) : undefined
    const shown = valueShown(step.args.value, kind, propId)
    const cell = argCell('value', shown, t('ui.automation.pickValue'), () => {
      if (!def || kind === undefined) {
        // 还没选字段：先选字段（值格的画法由 kind 定，没有 kind 就没有画法）
        return
      }
      if (kind === 'select') {
        deps.openMenu(
          choicesOf(def).map((c) => ({ id: c.id, label: c.label, group: 'pick/choices', ...(c.icon ? { icon: c.icon } : {}) })),
          (row) => withStep(step, (args) => ({ ...args, value: row.id })),
          t('ui.automation.pickValueTitle'),
        )
        return
      }
      if (kind === 'checkbox') {
        withStep(step, (args) => ({ ...args, value: args.value === true ? false : true }))
        return
      }
      if (kind === 'date') {
        openDateInput(step)
        return
      }
      if (kind === 'ref') {
        deps.openMenu(
          refTargets().map((b) => ({ id: b.id, label: displayNameOf(b), group: 'pick/refs' })),
          (row) => withStep(step, (args) => ({ ...args, value: row.id })),
          t('ui.automation.pickValueTitle'),
        )
        return
      }
      // text／number／asset：行内输入（number 校验交给写闸；这里只收字面量）
      openValueInput(step, kind === 'number' ? 'number' : 'text')
    })
    if (kind === 'checkbox' && typeof step.args.value === 'boolean') {
      cell.textContent = t(step.args.value ? 'ui.automation.valueChecked' : 'ui.automation.valueUnchecked')
    }
    return cell
  }

  /** date 值格：原生日期输入（本地的 ISO 日）；外加「今天」档（写 `{ref:'now'}`，run 时定格） */
  const openDateInput = (step: AutomationStep): void => {
    const wrap = document.createElement('div')
    wrap.className = 'blk-auto-input'
    const input = document.createElement('input')
    input.type = 'date'
    input.title = t('ui.automation.dateInput')
    input.addEventListener('change', () => {
      if (input.value === '') return
      withStep(step, (args) => ({ ...args, value: input.value }))
    })
    const today = document.createElement('button')
    today.type = 'button'
    today.textContent = t('ui.automation.valueToday')
    today.title = t('ui.automation.valueTodayHint')
    today.addEventListener('click', () => withStep(step, (args) => ({ ...args, value: { ref: 'now' } })))
    wrap.append(input, today)
    showInline(wrap)
  }

  const openValueInput = (step: AutomationStep, type: 'text' | 'number'): void => {
    const input = document.createElement('input')
    input.type = type
    input.placeholder = t('ui.automation.valueInput')
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      e.stopPropagation()
      const v = type === 'number' ? Number(input.value) : input.value
      if (input.value === '' || (type === 'number' && !Number.isFinite(v))) return
      withStep(step, (args) => ({ ...args, value: v }))
    })
    showInline(input)
  }

  const tagCell = (step: AutomationStep): HTMLElement => {
    const tagId = typeof step.args.tagId === 'string' ? step.args.tagId : ''
    return argCell('tagId', labelOfTag(tagId), t('ui.automation.pickTag'), () => {
      deps.openMenu(
        deps.kb.tags().map((tag) => ({ id: tag.id, label: `#${displayNameOf(tag)}`, group: 'pick/tags' })),
        (row) => withStep(step, (args) => ({ ...args, tagId: row.id })),
        t('ui.automation.pickTagTitle'),
      )
    })
  }

  const textCell = (step: AutomationStep, key: string): HTMLElement => {
    const cur = typeof step.args[key] === 'string' ? (step.args[key] as string) : ''
    const cell = argCell(key, cur, t('ui.automation.enterText'), () => openValueInput(step, 'text'))
    return cell
  }

  const moveTargetCell = (step: AutomationStep): HTMLElement => {
    const parentId = typeof step.args.parentId === 'string' ? step.args.parentId : ''
    return argCell('parentId', labelOfBlock(parentId), t('ui.automation.pickMoveTo'), () => {
      deps.openMenu(
        deps.kb.pages().map((p) => ({ id: p.id, label: displayNameOf(p), group: 'pick/pages' })),
        (row) => withStep(step, (args) => ({ ...args, parentId: row.id })),
        t('ui.automation.pickMoveTitle'),
      )
    })
  }

  /* ---- 加步骤：菜单来自命令契约（automation 标记 ＋ title），不在这里硬编码第二份 ---- */

  const openStepMenu = (def: AutomationDef, at: number): void => {
    const rows: Row[] = STEP_COMMANDS.map((cmd) => {
      const decl = DECL_BY_NAME.get(cmd)
      return {
        id: cmd,
        label: decl?.title ?? cmd,
        group: 'pick/steps',
        icon: 'lucide:zap',
      }
    })
    deps.openMenu(rows, (row) => {
      const decl = DECL_BY_NAME.get(row.id)
      if (!decl) return
      const args: Record<string, ArgRef> = {}
      // 默认档：move 默认「移到页的末尾」；其余步骤的参数留空（空格显示「待选」）
      if (row.id === 'core.tree/move') args.parentId = ''
      const steps = [...def.steps]
      steps.splice(Math.min(at, steps.length), 0, { cmd: row.id, args })
      write({ ...def, steps })
    }, t('ui.automation.addStepTitle'))
  }

  /* ------------------------------------------------------------ 公用 */

  /** ref 值的候选：页 ＋ 标签块（与「移动到…」的候选集合同一份口径） */
  const refTargets = (): Block[] => [...deps.kb.pages(), ...deps.kb.tags()]

  /** 一个 arg 引用的人话（chip 显示）：字面量按 kind 翻名字，引用值带标记 */
  const valueShown = (v: ArgRef, kind: string | undefined, propId: string): string => {
    if (v === null || v === undefined) return ''
    if (typeof v === 'object' && 'ref' in v) {
      if (v.ref === 'now') return t('ui.automation.valueToday')
      if (v.ref === 'target') return t('ui.automation.valueTarget')
    }
    if (typeof v !== 'string') return String(v)
    if (kind === 'select') return choiceLabelOf(propId, v)
    if (kind === 'ref') return labelOfBlock(v)
    return v
  }

  const labelOfProp = (propId: string): string => {
    if (propId === '') return ''
    const def = deps.kb.propDefs().find((x) => x.id === propId)
    if (def && isPropDefBlock(def)) return propLabel(def) || def.id
    return propId === '_date' ? t('ui.automation.propDate') : propId
  }

  const labelOfTag = (tagId: string): string => {
    if (tagId === '') return ''
    const b = deps.kb.get(tagId)
    return b ? `#${displayNameOf(b)}` : t('ui.automation.gone')
  }

  const labelOfBlock = (id: string): string => {
    if (id === '') return ''
    const b = deps.kb.get(id)
    return b ? displayNameOf(b) : t('ui.automation.gone')
  }

  const choiceLabelOf = (propId: string, choiceId: string): string => {
    const def = deps.kb.propDefs().find((x) => x.id === propId)
    const c = def ? choicesOf(def).find((x) => x.id === choiceId) : undefined
    return c?.label ?? t('ui.automation.gone')
  }

  /** 行内输入（值格点了之后当场给一个输入框；Enter 写回、Esc 收起） */
  const showInline = (el: HTMLElement): void => {
    root.querySelector('.blk-auto-inline')?.remove()
    el.classList.add('blk-auto-inline')
    root.appendChild(el)
    const input = el instanceof HTMLInputElement ? el : el.querySelector('input')
    input?.focus()
  }

  const write = (def: AutomationDef): void => {
    deps.writeDef(canonicalAutomation(def))
  }

  /* ---- 订阅：外部改动（撤销／别的视图）就地重画 ---- */

  off = deps.subscribe((_source, ids) => {
    // undefined ＝ 全量通知（换库等）；带了 ids 就只认自己的那一块
    if (ids !== undefined && !ids.includes(deps.blockId)) return
    render()
  })

  render()

  return {
    root,
    dispose: () => {
      disposed = true
      off?.()
      off = null
    },
  }
}
