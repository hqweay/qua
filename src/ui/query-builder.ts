/**
 * **查询构建器**：条件行 ＋ 一层 `all`/`any` ＋ 范围/上限/排序 ＋ JSON。
 *
 * 三条口径：
 *   · **一个构建器服务所有拥有者**（查询块／local tab／linked tab 的目标块）——
 *     它只知道「写这份条件」，不知道条件住在哪个属性袋里。那件事归 `ViewOwnerStore`。
 *   · **一次应用＝一轮撤销**：草稿改在本地，只有点「应用」才写一次（`core.query/set-spec`
 *     是一笔事务）。边打字边写会把 ⌘Z 变成「一个字一步」。
 *   · **条件行与 JSON 是同一份数据的两种视图**：切换 tab 不丢草稿；
 *     JSON 解析失败**保留文本**并报错，绝不静默清空（那会让一次手滑抹掉整份条件）。
 *
 * ⚠️ 这里零命令、零模型写：`apply` 由装配层注入（它才是「一次动作一笔事务」的地方）。
 */
import {
  DRAFT_OPS,
  canonicalSpec,
  draftOfSpec,
  nodeOfRow,
  specOfDraft,
  type Block,
  type DraftOp,
  type DraftRow,
  type PropKind,
  type QueryDraft,
  type QuerySpec,
} from '../core/index.ts'
import { t, type MsgId } from '../core/msg.ts'

export interface QueryBuilderDeps {
  /** 当前条件（现读：它可能被命令改过） */
  spec: () => QuerySpec
  /**
   * 可选的属性定义（按显示名排好；由装配层给，`ui` 不扫森林）。
   *
   * `kind` 决定**这一行能问哪些算子**：布尔属性没有「未填」这一态
   * （`core/props.ts` 的 `readField`），对它问「为空」与问「没有这一栏」是同一个答案 ——
   * 两个选项指向同一个结果，就是在教用户两种写法。
   */
  fields: () => readonly { id: string; label: string; kind?: PropKind }[]
  /** 写条件（一次事务／一轮撤销） */
  apply: (spec: QuerySpec) => void
  /** 关掉浮层 */
  close: () => void
  /** 解析失败之类要说话 */
  toast?: (text: string, kind?: 'ok' | 'warn' | 'info') => void
}

const OP_TEXT: Record<DraftOp, MsgId> = {
  eq: 'ui.query.op.eq',
  neq: 'ui.query.op.neq',
  contains: 'ui.query.op.contains',
  gt: 'ui.query.op.gt',
  gte: 'ui.query.op.gte',
  lt: 'ui.query.op.lt',
  lte: 'ui.query.op.lte',
  exists: 'ui.query.op.exists',
  empty: 'ui.query.op.empty',
}

const KIND_TEXT = {
  todo: 'ui.query.kind.todo',
  tag: 'ui.query.kind.tag',
  text: 'ui.query.kind.text',
  prop: 'ui.query.kind.prop',
} as const satisfies Record<DraftRow['kind'], MsgId>

/** 画进一个容器（浮层里那个盒子）。是纯渲染：状态都在闭包里，关掉浮层就没了。 */
export function renderQueryBuilder(box: HTMLElement, deps: QueryBuilderDeps): void {
  const draft: QueryDraft = draftOfSpec(deps.spec())
  let tab: 'rows' | 'json' = draft.verbatim === undefined ? 'rows' : 'json'
  /** JSON tab 的文本：只在用户动过它之后才盖过草稿（否则切回来会丢掉刚改的行） */
  let jsonText: string | null = draft.verbatim ?? null

  box.replaceChildren()
  // 宿主是 `.popover` 壳（定位与层级都住在那个类上）：只能加自己的类，不能整个覆盖——
  // 覆盖掉壳类，浮层就失去了 position:fixed，整盒画到文档流末尾（屏幕外）。
  box.classList.add('qb')

  const head = document.createElement('div')
  head.className = 'qb-head'
  const tabs: HTMLButtonElement[] = []
  for (const [id, label] of [
    ['rows', t('ui.query.builder.rows')],
    ['json', t('ui.query.builder.json')],
  ] as const) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'qb-tab'
    b.dataset.qbTab = id
    b.textContent = label
    b.addEventListener('click', () => {
      if (id === 'json') jsonText = jsonText ?? JSON.stringify(canonicalSpec(specOfDraft(draft)), null, 2)
      tab = id
      paint()
    })
    tabs.push(b)
    head.appendChild(b)
  }
  box.appendChild(head)

  const body = document.createElement('div')
  body.className = 'qb-body'
  box.appendChild(body)

  const foot = document.createElement('div')
  foot.className = 'qb-foot'
  const apply = document.createElement('button')
  apply.type = 'button'
  apply.className = 'qb-apply ui-btn'
  apply.textContent = t('ui.query.builder.apply')
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'qb-cancel ui-btn ui-btn--quiet'
  cancel.textContent = t('ui.query.builder.cancel')
  cancel.addEventListener('click', () => deps.close())
  foot.append(apply, cancel)
  box.appendChild(foot)

  /* ---------------------------------------------------------- 应用 */

  apply.addEventListener('click', () => {
    if (tab === 'json' && jsonText !== null) {
      let parsed: unknown
      try {
        parsed = JSON.parse(jsonText)
      } catch {
        // 保留文本 + 说一句：静默清空会让一次手滑抹掉整份条件
        deps.toast?.(t('ui.query.badJson'), 'warn')
        return
      }
      if (!parsed || typeof parsed !== 'object' || !('where' in parsed)) {
        deps.toast?.(t('ui.query.badJson'), 'warn')
        return
      }
      deps.apply(canonicalSpec(parsed as QuerySpec))
      deps.close()
      return
    }
    deps.apply(specOfDraft(draft))
    deps.close()
  })

  /* ---------------------------------------------------------- 画 */

  function paint(): void {
    for (const b of tabs) b.dataset.active = b.dataset.qbTab === tab ? '1' : '0'
    body.replaceChildren()
    if (tab === 'json') {
      const area = document.createElement('textarea')
      area.className = 'qb-json ui-input'
      area.rows = 12
      area.spellcheck = false
      area.value = jsonText ?? ''
      area.addEventListener('input', () => {
        jsonText = area.value
      })
      body.appendChild(area)
      return
    }
    body.appendChild(rowsPane())
  }

  function rowsPane(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'qb-rows'

    // 组合方式（一层）
    const mode = document.createElement('div')
    mode.className = 'qb-mode'
    for (const [id, label] of [
      ['all', t('ui.query.builder.all')],
      ['any', t('ui.query.builder.any')],
    ] as const) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'qb-mode-btn'
      b.dataset.qbMode = id
      b.dataset.active = draft.mode === id ? '1' : '0'
      b.textContent = label
      b.addEventListener('click', () => {
        draft.mode = id
        jsonText = null
        paint()
      })
      mode.appendChild(b)
    }
    wrap.appendChild(mode)

    draft.rows.forEach((row, i) => wrap.appendChild(rowEl(row, i)))
    if (draft.rows.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'qb-empty'
      empty.textContent = t('ui.query.builder.empty')
      wrap.appendChild(empty)
    }

    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'qb-add ui-btn ui-btn--quiet'
    add.textContent = t('ui.query.builder.addRow')
    add.addEventListener('click', () => {
      draft.rows.push({ kind: 'todo', value: 'todo' })
      jsonText = null
      paint()
    })
    wrap.appendChild(add)

    /* 范围 / 上限 / 排序 */
    const opts = document.createElement('div')
    opts.className = 'qb-opts'

    const scope = document.createElement('label')
    scope.className = 'qb-opt'
    scope.textContent = t('ui.query.builder.scope')
    const scopeSel = document.createElement('select')
    scopeSel.className = 'qb-scope ui-input'
    for (const [id, label] of [
      ['subtree', t('ui.query.builder.scopeSubtree')],
      ['all', t('ui.query.builder.scopeAll')],
    ] as const) {
      const o = document.createElement('option')
      o.value = id
      o.textContent = label
      scopeSel.appendChild(o)
    }
    scopeSel.value = draft.scope
    scopeSel.addEventListener('change', () => {
      draft.scope = scopeSel.value === 'all' ? 'all' : 'subtree'
      jsonText = null
    })
    scope.appendChild(scopeSel)
    opts.appendChild(scope)

    const limit = document.createElement('label')
    limit.className = 'qb-opt'
    limit.textContent = t('ui.query.builder.limit')
    const limitInput = document.createElement('input')
    limitInput.type = 'number'
    limitInput.min = '0'
    limitInput.className = 'qb-limit ui-input'
    limitInput.value = draft.limit === undefined ? '' : String(draft.limit)
    limitInput.addEventListener('input', () => {
      const n = Number(limitInput.value)
      if (limitInput.value.trim() === '' || !Number.isFinite(n) || n <= 0) delete draft.limit
      else draft.limit = Math.floor(n)
      jsonText = null
    })
    limit.appendChild(limitInput)
    opts.appendChild(limit)

    /* 顺序：按某一列升/降（成员顺序；显示顺序在视图配置里） */
    const sortWrap = document.createElement('label')
    sortWrap.className = 'qb-opt'
    sortWrap.textContent = t('ui.query.builder.sort')
    const colSel = document.createElement('select')
    colSel.className = 'qb-sort-col ui-input'
    const none = document.createElement('option')
    none.value = ''
    none.textContent = t('ui.query.builder.sortNone')
    colSel.appendChild(none)
    for (const f of deps.fields()) {
      const o = document.createElement('option')
      o.value = f.id
      o.textContent = f.label
      colSel.appendChild(o)
    }
    colSel.value = draft.sort?.by ?? ''
    const dirSel = document.createElement('select')
    dirSel.className = 'qb-sort-dir ui-input'
    for (const [id, label] of [
      ['asc', t('ui.view.sortAsc')],
      ['desc', t('ui.view.sortDesc')],
    ] as const) {
      const o = document.createElement('option')
      o.value = id
      o.textContent = label
      dirSel.appendChild(o)
    }
    dirSel.value = draft.sort?.dir ?? 'asc'
    const syncSort = (): void => {
      if (colSel.value === '') delete draft.sort
      else draft.sort = { by: colSel.value, dir: dirSel.value === 'desc' ? 'desc' : 'asc' }
      jsonText = null
    }
    colSel.addEventListener('change', syncSort)
    dirSel.addEventListener('change', syncSort)
    sortWrap.append(colSel, dirSel)
    opts.appendChild(sortWrap)

    wrap.appendChild(opts)
    return wrap
  }

  function rowEl(row: DraftRow, index: number): HTMLElement {
    const el = document.createElement('div')
    el.className = 'qb-row'
    el.dataset.qbRow = String(index)

    const kind = document.createElement('select')
    kind.className = 'qb-kind ui-input'
    for (const id of ['todo', 'tag', 'text', 'prop'] as const) {
      const o = document.createElement('option')
      o.value = id
      o.textContent = t(KIND_TEXT[id])
      kind.appendChild(o)
    }
    kind.value = row.kind
    kind.addEventListener('change', () => {
      const next = kind.value as DraftRow['kind']
      draft.rows[index] =
        next === 'todo'
          ? { kind: 'todo', value: 'todo' }
          : next === 'prop'
            ? { kind: 'prop', field: deps.fields()[0]?.id ?? '', op: 'eq', value: '' }
            : { kind: next, value: '' }
      jsonText = null
      paint()
    })
    el.appendChild(kind)

    if (row.kind === 'prop') {
      const field = document.createElement('select')
      field.className = 'qb-field ui-input'
      for (const f of deps.fields()) {
        const o = document.createElement('option')
        o.value = f.id
        o.textContent = f.label
        field.appendChild(o)
      }
      field.value = row.field ?? ''
      field.addEventListener('change', () => {
        row.field = field.value
        jsonText = null
      })
      el.appendChild(field)

      const op = document.createElement('select')
      op.className = 'qb-op ui-input'
      /**
       * **布尔属性不提供「为空」**：它没有未填态，`empty` 与 `exists:false` 是同一个答案。
       * 已经存下来的 `empty` 仍然显示（不许打开一次就悄悄改掉用户的条件）。
       */
      const kind = deps.fields().find((f) => f.id === (row.field ?? ''))?.kind
      const ops =
        kind === 'checkbox' && (row.op ?? 'eq') !== 'empty' ? DRAFT_OPS.filter((o) => o !== 'empty') : DRAFT_OPS
      for (const id of ops) {
        const o = document.createElement('option')
        o.value = id
        o.textContent = t(OP_TEXT[id])
        op.appendChild(o)
      }
      op.value = row.op ?? 'eq'
      op.addEventListener('change', () => {
        row.op = op.value as DraftOp
        if (row.op === 'exists' || row.op === 'empty') row.value = row.value === 'false' ? 'false' : 'true'
        jsonText = null
        paint()
      })
      el.appendChild(op)
    }

    const value = document.createElement('input')
    value.className = 'qb-value ui-input'
    value.value = row.value ?? ''
    value.placeholder = row.kind === 'tag' ? t('ui.query.builder.tagHint') : row.kind === 'text' ? t('ui.query.builder.textHint') : ''
    if (row.kind === 'todo') {
      // 待办是三态：用下拉而不是自由文本（写错一个词就是「永不命中」）
      const sel = document.createElement('select')
      sel.className = 'qb-value ui-input'
      for (const [id, label] of [
        ['todo', t('ui.query.todo.todo')],
        ['done', t('ui.query.todo.done')],
        ['none', t('ui.query.todo.none')],
      ] as const) {
        const o = document.createElement('option')
        o.value = id
        o.textContent = label
        sel.appendChild(o)
      }
      sel.value = row.value ?? 'todo'
      sel.addEventListener('change', () => {
        row.value = sel.value
        jsonText = null
      })
      el.appendChild(sel)
    } else if (row.op === 'exists' || row.op === 'empty') {
      const sel = document.createElement('select')
      sel.className = 'qb-value ui-input'
      for (const v of ['true', 'false']) {
        const o = document.createElement('option')
        o.value = v
        o.textContent = v === 'true' ? t('ui.query.builder.yes') : t('ui.query.builder.no')
        sel.appendChild(o)
      }
      sel.value = row.value === 'false' ? 'false' : 'true'
      sel.addEventListener('change', () => {
        row.value = sel.value
        jsonText = null
      })
      el.appendChild(sel)
    } else {
      value.addEventListener('input', () => {
        row.value = value.value
        jsonText = null
      })
      el.appendChild(value)
    }

    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'qb-del'
    del.textContent = '×'
    del.title = t('ui.query.builder.removeRow')
    del.addEventListener('click', () => {
      draft.rows.splice(index, 1)
      jsonText = null
      paint()
    })
    el.appendChild(del)

    /** 这一行当前会变成什么条件（给人话，不是给人猜） */
    const hint = document.createElement('span')
    hint.className = 'qb-row-hint'
    hint.textContent = rowLabel(
      row,
      (id) => deps.fields().find((f) => f.id === id)?.label ?? id.slice(-6),
      (op) => t(OP_TEXT[op]),
    )
    const ok = nodeOfRow(row) !== null
    hint.dataset.ok = ok ? '1' : '0'
    el.appendChild(hint)
    return el
  }

  paint()
}

/**
 * 一行条件的**人话**（chip 与行尾提示共用）。
 *
 * 文案住在这里而不是 `core/`：拼的是「字段名 ＋ 算子 ＋ 值」，字段名是**用户数据**
 * （属性定义的显示名）、算子那半截是 UI 词汇——两样都不是模型的事。
 */
export function rowLabel(row: DraftRow, fieldName: (id: string) => string, opText: (op: DraftOp) => string): string {
  if (row.kind === 'todo') {
    const v = row.value === 'done' ? 'done' : row.value === 'none' ? 'none' : 'todo'
    return t(v === 'done' ? 'ui.query.todo.done' : v === 'none' ? 'ui.query.todo.none' : 'ui.query.todo.todo')
  }
  if (row.kind === 'tag') return `#${row.value ?? ''}`
  if (row.kind === 'text') return t('ui.query.label.text', { text: row.value ?? '' })
  const name = row.field ? fieldName(row.field) : t('ui.query.label.noField')
  const op: DraftOp = row.op ?? 'eq'
  if (op === 'exists') return t(row.value === 'false' ? 'ui.query.label.notExists' : 'ui.query.label.exists', { name })
  if (op === 'empty') return t(row.value === 'false' ? 'ui.query.label.notEmpty' : 'ui.query.label.empty', { name })
  return t('ui.query.label.cmp', { name, op: opText(op), value: row.value ?? '' })
}

/** 一条条件的**筛选 chip**（抬头那一行；点击打开构建器） */
export function queryChips(spec: QuerySpec, fields: readonly { id: string; label: string }[]): string[] {
  const draft = draftOfSpec(spec)
  if (draft.verbatim !== undefined) return [t('ui.query.builder.complex')]
  return draft.rows.map((row) =>
    rowLabel(
      row,
      (id) => fields.find((f) => f.id === id)?.label ?? id.slice(-6),
      (op) => t(OP_TEXT[op]),
    ),
  )
}

export type { Block }
