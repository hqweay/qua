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
  queryNodeOfTree,
  treeOfSpec,
  type AutomationDef,
  type AutomationStep,
  type AutomationTrigger,
  type ArgRef,
  type Block,
} from '../../core/index.ts'
import { DECL_BY_NAME } from '../../core/commands/decls.ts'
import { STEP_COMMANDS } from '../../core/automation/run.ts'
import { mentionsContentAtoms } from '../../core/automation/automation.ts'
import { renderIcon } from '../../view/icons.ts'
import { canonicalAutomation, followsRefs, readAutomation } from '../../core/automation/automation.ts'
import { topUpOf, triggerQueryFromWhen, withUp } from '../../core/automation/trigger-query.ts'
import { displayNameOf } from '../../core/identity/alias.ts'
import type { QueryNode, QuerySpec } from '../../core/query/query.ts'
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
  /** 是否已固定到命令面板（库态偏好：跟库走；身体只读，写走 onPin） */
  pinned(): boolean
  onPin(on: boolean): void
  /** 整份定义写回（canonical 之后的；装配层负责事务、撤销与重画） */
  writeDef(def: AutomationDef): void
  /** 打开「如果」的条件编辑弹层（同一台条件树；应用写 `_automation.when`） */
  editWhen(): void
  /** 编辑「新建子块」触发器的**父块筛选**（同一台条件树；应用写 trigger.parent，清空＝任意父块） */
  editParentFilter(triggerIndex: number): void
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
    const manual = def?.triggers.some((tr) => tr === 'manual') ?? false
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
    run.title = manual ? t('ui.automation.runHint') : t('ui.automation.noManualHint')
    // 没有手动触发 ⇒ 这条只能由事件跑；运行按钮是手动入口，置灰并说明
    run.disabled = !manual
    run.addEventListener('click', () => deps.onRun())
    // 固定到命令面板：库态偏好（跟库同步），只有手动动作才有意义
    const pinned = deps.pinned()
    const pin = document.createElement('button')
    pin.type = 'button'
    pin.className = 'blk-auto-pin'
    pin.setAttribute('aria-pressed', pinned ? 'true' : 'false')
    const pinTip = manual ? (pinned ? t('ui.automation.unpinFromPalette') : t('ui.automation.pinToPalette')) : t('ui.automation.pinNeedsManual')
    pin.dataset.tip = pinTip
    pin.setAttribute('aria-label', pinTip)
    pin.disabled = !manual
    renderIcon(pin, pinned ? 'lucide:pin' : 'lucide:pin-off', 'pin')
    pin.addEventListener('click', () => {
      deps.onPin(!pinned)
      render()
    })
    head.append(toggle, run, pin)
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
    // 行容器纵向堆：多行（多步骤／长条件换行）不与标签水平挤成一排
    const body = document.createElement('div')
    body.className = 'blk-auto-rows'
    for (const r of rows) body.appendChild(r)
    sec.appendChild(body)
    return sec
  }

  /**
   * 一枚 chip（只读；点击行为由调用方接）。
   *
   * 本体 inline-flex（图标与文字**同轴居中**，不再和 inline 基线搏斗）；
   * 文字包进内层 label——省略号是 label 的职责（flex 容器自己省略不了裸文本节点）。
   */
  const chip = (text: string, cls: string, onClick?: () => void): HTMLElement => {
    const c = document.createElement(onClick ? 'button' : 'span')
    if (onClick) {
      ;(c as HTMLButtonElement).type = 'button'
      c.addEventListener('click', onClick)
    }
    c.className = `blk-auto-chip ${cls}`
    const label = document.createElement('span')
    label.className = 'blk-auto-chip-label ui-ellipsis'
    label.textContent = text
    c.appendChild(label)
    return c
  }

  /** 一条触发器的人话（chip 显示；与引擎的触发键同一份形状来源） */
  const triggerText = (tr: AutomationTrigger): string => {
    const base = triggerBaseText(tr)
    // 穿不穿引用是这条触发器的**态**，不是条件的措辞：同一个父块条件，开与关的
    // 判定面差一整层，行上不写出来就只剩「跑不跑」一个信号
    return followsRefs(tr) ? base + t('ui.automation.trigger.refsSuffix') : base
  }

  const triggerBaseText = (tr: AutomationTrigger): string => {
    if (tr === 'manual') return t('ui.automation.trigger.manual')
    // 常见形状给专句；其余按事件轴走通用句式（收纳重排时再按「当/如果/就」统一）
    const cond = (): string => parentCondChips(tr.query).join(' ')
    // 「在 X 下新建子块时」：容纳链上的 {is} 保持点名句式，其余条件走人话投影
    if (tr.birth === true) {
      const inner = topUpOf(tr.query)
      if (inner !== undefined) {
        if ('is' in inner && typeof inner.is === 'string') {
          return t('ui.automation.trigger.childAddedUnder', { parent: labelOfBlock(inner.is) })
        }
        return t('ui.automation.trigger.childAddedQuery', { cond: parentCondChips(inner).join(' ') })
      }
    }
    if (tr.on === 'entered' || tr.on === 'left' || tr.on === 'changed') {
      const q = tr.query
      if ('prop' in q && 'exists' in q.prop && q.prop.exists === true) {
        const name = labelOfProp(q.prop.id)
        if (tr.on === 'entered') return t('ui.automation.trigger.propAny', { prop: name })
        if (tr.on === 'left') return t('ui.automation.trigger.propCleared', { prop: name })
        return t('ui.automation.trigger.propChanged', { prop: name })
      }
      if ('prop' in q && 'eq' in q.prop) {
        const name = labelOfProp(q.prop.id)
        const to = q.prop.eq
        // checkbox 的值位是布尔：人话用勾选两态，不走选项名解析
        const toText = typeof to === 'boolean' ? t(to ? 'ui.automation.valueChecked' : 'ui.automation.valueUnchecked') : choiceLabelOf(q.prop.id, to as string)
        return t('ui.automation.trigger.propTo', { prop: name, to: toText })
      }
      if ('tag' in q) {
        const tag = typeof q.tag === 'string' ? q.tag : q.tag.id
        if (tr.on === 'entered') return t('ui.automation.trigger.tagOn', { tag: labelOfTag(tag) })
        if (tr.on === 'left') return t('ui.automation.trigger.tagOff', { tag: labelOfTag(tag) })
      }
    }
    const key = tr.birth === true
      ? 'ui.automation.trigger.edgeBirth'
      : tr.on === 'entered'
        ? 'ui.automation.trigger.edgeEntered'
        : tr.on === 'left'
          ? 'ui.automation.trigger.edgeLeft'
          : 'ui.automation.trigger.edgeChanged'
    return t(key, { cond: cond() })
  }

  /** 父块筛选条件的人话（与「如果」同一份投影，fields/choices 同源） */
  const parentCondChips = (when: QueryNode): string[] => {
    try {
      return queryChips({ where: when }, deps.kb.propDefs().map((d) => ({ id: d.id, label: propLabel(d) || d.id, kind: propKindOf(d) })), (propId) => {
        const def = deps.kb.propDefs().find((x) => x.id === propId)
        return def ? choicesOf(def).map((c) => ({ id: c.id, label: c.label })) : []
      }, (id) => labelOfBlock(id), (id) => labelOfTag(id))
    } catch {
      return [t('ui.automation.complexCond')]
    }
  }

  const whenRows = (def: AutomationDef): HTMLElement[] => {
    const rows: HTMLElement[] = []
    const line = document.createElement('div')
    line.className = 'blk-auto-chips'
    // 多触发是 OR：连接词显形（muted 文本，不是 chip）——与条件树 chip 的「或」同族
    let first = true
    def.triggers.forEach((tr, i) => {
      if (!first) {
        const or = document.createElement('span')
        or.className = 'blk-auto-or'
        or.textContent = t('ui.automation.trigger.or')
        line.appendChild(or)
      }
      first = false
      // 点已有的触发器 ⇒ 改／删它（菜单在装配层）。手动是触发器之一，不是隐含底：
      // 它在，就说明「这块是手动动作」（块菜单/面板可列）；摘掉它，就只剩事件。
      const c = chip(triggerText(tr), 'is-event', () => openTriggerMenu(def, i))
      c.dataset.trigger = tr === 'manual' ? 'manual' : 'event'
      line.appendChild(c)
    })
    line.appendChild(chip(t('ui.automation.addTrigger'), 'is-edit', () => openTriggerAddMenu(def)))
    rows.push(line)
    return rows
  }

  /** 已有触发器的菜单：删除；`child.added` 另给「改父块筛选」与「引用窗口」开关 */
  const openTriggerMenu = (def: AutomationDef, at: number): void => {
    const tr = def.triggers[at]
    if (tr === undefined) return
    if (tr === 'manual') {
      // 手动是语义「是不是手动动作」的控制：摘掉它 = 块菜单/面板不再列这条。
      // 但定义至少要有一个触发（形状判据），只剩它时不给摘。
      const only = def.triggers.length <= 1
      deps.openMenu(
        [
          {
            id: 'trigger/remove-manual',
            label: t('ui.automation.removeManual'),
            hint: only ? t('ui.automation.trigger.keepOne') : '',
            group: 'trigger/1',
            disabled: only,
          },
        ],
        (row) => {
          if (row.id !== 'trigger/remove-manual' || only) return
          write({ ...def, triggers: def.triggers.filter((x) => x !== 'manual') })
        },
        t('ui.automation.trigger.manual'),
      )
      return
    }
    const rows: Row[] = [{ id: 'trigger/remove', label: t('ui.automation.removeTrigger'), group: 'trigger/1' }]
    // 父块条件槽：一个槽，三种填法是它的编辑动作（点名／条件筛／清空＝任意父块）——不是并列模式
    if (tr.birth === true && topUpOf(tr.query) !== undefined) {
      rows.push({ id: 'trigger/reparent', label: t('ui.automation.reparent'), group: 'trigger/1' })
      rows.push({ id: 'trigger/pickparent', label: t('ui.automation.trigger.pickParent'), group: 'trigger/1' })
      const whenQuery = def.when !== undefined ? triggerQueryFromWhen(def.when) : null
      if (whenQuery) {
        rows.push({ id: 'trigger/clearparent', label: t('ui.automation.trigger.clearParent'), hint: t('ui.automation.trigger.anyParentWhenHint'), group: 'trigger/1' })
      }
      // 容纳链怎么走：这一格只说「这一跳算不算」，不动条件本身
      rows.push({
        id: 'trigger/followrefs',
        label: t('ui.automation.trigger.followRefsToggle', { on: t(followsRefs(tr) ? 'ui.automation.on' : 'ui.automation.off') }),
        hint: t('ui.automation.trigger.followRefsHint'),
        group: 'trigger/2',
      })
    }
    deps.openMenu(rows, (row) => {
      if (row.id === 'trigger/remove') {
        write({ ...def, triggers: def.triggers.filter((_, i) => i !== at) })
        return
      }
      if (row.id === 'trigger/reparent') {
        deps.editParentFilter(at)
        return
      }
      if (row.id === 'trigger/pickparent') {
        deps.pickBlock(t('ui.automation.trigger.pickParentTitle'), (parentId) => {
          write({ ...def, triggers: def.triggers.map((x, i) => (i === at && x !== 'manual' && x.birth === true ? { ...x, query: withUp(x.query, { is: parentId }) } : x)) })
        })
        return
      }
      if (row.id === 'trigger/clearparent') {
        const whenQuery = def.when !== undefined ? triggerQueryFromWhen(def.when) : null
        if (!whenQuery) return
        write({ ...def, triggers: def.triggers.map((x, i) => (i === at && x !== 'manual' && x.birth === true ? { ...x, query: whenQuery } : x)) })
        return
      }
      if (row.id === 'trigger/followrefs') {
        const next = !followsRefs(tr)
        write({
          ...def,
          triggers: def.triggers.map((x, i) => {
            if (i !== at || x === 'manual' || x.birth !== true) return x
            // 关＝删键（与「开回默认＝删格」同口径：只有打开才落盘）
            const { followRefs: _drop, ...rest } = x
            return next ? { ...rest, followRefs: true as const } : rest
          }),
        })
        return
      }
    }, triggerText(tr))
  }

  /** 加触发器：手动（出生默认，可摘后可再加回）＋四种事件（属性变化／打标签／摘标签／新建子块） */
  const openTriggerAddMenu = (def: AutomationDef): void => {
    const rows: Row[] = []
    if (!def.triggers.some((tr) => tr === 'manual')) {
      rows.push({
        id: 'add/manual',
        label: t('ui.automation.trigger.manual'),
        hint: t('ui.automation.trigger.manualAddHint'),
        group: 'trigger/1',
      })
    }
    rows.push(
      { id: 'add/prop', label: t('ui.automation.trigger.addProp'), group: 'trigger/1' },
      { id: 'add/tagOn', label: t('ui.automation.trigger.addTagOn'), group: 'trigger/1' },
      { id: 'add/tagOff', label: t('ui.automation.trigger.addTagOff'), group: 'trigger/1' },
      { id: 'add/child', label: t('ui.automation.trigger.addChild'), group: 'trigger/1' },
    )
    deps.openMenu(rows, (row) => {
      if (row.id === 'add/manual') {
        write({ ...def, triggers: [...def.triggers, 'manual'] })
        return
      }
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
              // 「任何变化」＝三支边沿（进入／离开／期间有变）——同规则去重使同笔变更只跑一次
              const triggers: AutomationTrigger[] = [...def.triggers, ...(vrow.id === '' ? propAnyTriggers(propId) : [propToTrigger(propId, vrow.id)])]
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
              const triggers: AutomationTrigger[] = [
                ...def.triggers,
                ...(vrow.id === 'any' ? propAnyTriggers(propId) : [propToTrigger(propId, vrow.id === 'on')]),
              ]
              write({ ...def, triggers })
            },
            t('ui.automation.pickValueTitle'),
          )
          return
        }
        write({ ...def, triggers: [...def.triggers, ...propAnyTriggers(propId)] })
      },
      t('ui.automation.trigger.addPropTitle'),
    )
  }

  /** 「{prop} 变了」的统一形状：三支边沿各一条，同笔变更靠 (规则,目标) 去重只跑一次 */
  const propAnyTriggers = (propId: string): AutomationTrigger[] => [
    { on: 'entered', query: { prop: { id: propId, exists: true } } },
    { on: 'left', query: { prop: { id: propId, exists: true } } },
    { on: 'changed', query: { prop: { id: propId, exists: true } } },
  ]

  const propToTrigger = (propId: string, to: string | boolean): AutomationTrigger => ({
    on: 'entered',
    query: { prop: { id: propId, eq: to } },
  })

  const pickTagForTrigger = (def: AutomationDef, on: 'added' | 'removed'): void => {
    deps.openMenu(
      deps.kb.tags().map((tag) => ({ id: tag.id, label: `#${displayNameOf(tag)}`, group: 'trigger/tag' })),
      (row) => {
        write({ ...def, triggers: [...def.triggers, { on: on === 'added' ? 'entered' : 'left', query: { tag: row.id } }] })
      },
      t('ui.automation.pickTagTitle'),
    )
  }

  /**
   * 建「新建子块」触发器的**第二问**：父块定了，紧接着问一句「沿不沿引用」。
   *
   * 为什么挪到创建流程里：这一格不点开触发器菜单就永远看不见（行上只有一个后缀），
   * 而它决定规则按谁判定——藏在二级菜单里等于默认没人配。创建是低频动作，
   * 多一次二选一比「半年后才发现有这个开关」便宜。默认项排第一个，回车即过。
   */
  const addChildTrigger = (def: AutomationDef, query: QueryNode, after?: () => void): void => {
    deps.openMenu(
      [
        { id: 'off', label: t('ui.automation.trigger.followRefsOff'), hint: t('ui.automation.trigger.followRefsOffHint'), group: 'trigger/refs' },
        { id: 'on', label: t('ui.automation.trigger.followRefsOn'), hint: t('ui.automation.trigger.followRefsHint'), group: 'trigger/refs' },
      ],
      (row) => {
        write({
          ...def,
          triggers: [...def.triggers, { on: 'entered', query, birth: true, ...(row.id === 'on' ? { followRefs: true as const } : {}) }],
        })
        after?.()
      },
      t('ui.automation.trigger.followRefsTitle'),
    )
  }

  /** 新建子块触发器：一个父块条件槽的三种填法——空（＝任意父块，条件即「如果」）／点名／条件筛 */
  const pickParentForTrigger = (def: AutomationDef): void => {
    const whenQuery = def.when !== undefined ? triggerQueryFromWhen(def.when) : null
    deps.openMenu(
      [
        ...(whenQuery
          ? [{ id: '', label: t('ui.automation.trigger.anyParent'), hint: t('ui.automation.trigger.anyParentWhenHint'), group: 'trigger/parent' }]
          : []),
        { id: 'pick', label: t('ui.automation.trigger.pickParent'), group: 'trigger/parent' },
        { id: 'query', label: t('ui.automation.trigger.queryParent'), hint: t('ui.automation.trigger.queryParentHint'), group: 'trigger/parent' },
      ],
      (row) => {
        if (row.id === '') {
          // 槽空态＝任意父块：条件跟着「如果」走（「任意父块＋无条件」＝每笔新建都触发，保护性拒绝）
          addChildTrigger(def, whenQuery!)
          return
        }
        if (row.id === 'query') {
          // 加触发器时还没有下标：先落一条占位父条件，随即开条件树改它
          addChildTrigger(def, { up: { any: [] } }, () => deps.editParentFilter(def.triggers.length))
          return
        }
        pickParent((parentId) => {
          addChildTrigger(def, { up: { is: parentId } })
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
      const warns = condWarnOf(def.when)
      const hasFresh = def.triggers.some((tr) => tr !== 'manual' && tr.birth === true)
      condChips(def.when).forEach((text, i) => {
        const c = chip(text, 'is-cond', () => deps.editWhen())
        // 错配提示走记号＋悬停（界面少字）：内容依赖的条件在「新建子块」触发下
        // 出生即不命中——警告色图标点出哪一枚 chip 有这个 caveat，解释悬停里给
        if (hasFresh && warns[i] === true) {
          c.dataset.severity = 'warn'
          c.dataset.tip = t('ui.automation.freshContentHint')
          const ico = document.createElement('span')
          ico.className = 'blk-auto-sev-ico'
          renderIcon(ico, 'lucide:alert-triangle', 'circle-help', 'sm')
          c.prepend(ico)
        }
        line.appendChild(c)
      })
    }
    line.appendChild(chip(t('ui.automation.editCond'), 'is-edit', () => deps.editWhen()))
    rows.push(line)
    return rows
  }

  /**
   * 每一枚条件 chip 要不要带警告（与 condChips 的拆分同一顺序）：
   * 顶层未挂修饰 ⇒ 逐项判；整棵树一条 ⇒ 按整体判。{up} 子树说的是祖先，豁免。
   */
  const condWarnOf = (when: NonNullable<QuerySpec['where']>): boolean[] => {
    const draft = treeOfSpec({ where: when })
    if (!draft) return [mentionsContentAtoms(when)]
    if (draft.root.dir !== undefined || draft.root.not) return [mentionsContentAtoms(when)]
    return draft.root.items.map((item) => mentionsContentAtoms(queryNodeOfTree(item) ?? when))
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
