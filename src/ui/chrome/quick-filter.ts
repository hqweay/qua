/**
 * 快速筛选的 chips 面板：两列（包含／排除）＋ 候选 chips。
 *
 * 这是**每一个可筛表面**共用的 chrome（派生栏、查询块、中心大纲）：它
 * **不持有状态**——两列 chips 与记录集都由调用方现给，组件只画与转发手势。
 * 状态住调用方（查询块＝视图配置 `filter`；派生栏／大纲＝会话瞬态）。
 *
 * 手势三条，与列头写的一致：
 *   · **点候选** ＝ 加入「包含」；**Shift+点候选** ＝ 加入「排除」。
 *   · **点已选 chip** ＝ 摘除；**Shift+点包含列的 chip** ＝ 挪到排除列。
 *   · **有筛选时给「清除筛选」**：一次退回没有条件，不必逐颗摘。
 *
 * 每次手势后调用方重画这份内容（面板不关——用户常连点几颗），
 * 重画就是再调一次 `renderQuickFilter`，没有第二份渲染路径。
 */
import { t, type MsgId } from '../../core/infra/msg.ts'
import { quickFilterActive, quickFilterCandidates, type QuickFilterAtom, type QuickFilterState, type QuickFilterRow } from '../../core/index.ts'

export interface QuickFilterDeps {
  /** 候选与计数的数据源：这一屏**未筛**的那批记录 */
  records: () => readonly QuickFilterRow[]
  /** 现在的两列 chips（组件不持有状态） */
  state: () => QuickFilterState
  /** 已选 chip 的显示名（名字是显示层的事，不进状态） */
  labelOf: (atom: QuickFilterAtom) => string
  /** 加一颗（已在另一列时由模型层挪列）；改完由持有方重画这一屏与这份内容 */
  onAdd: (atom: QuickFilterAtom, to: 'include' | 'remove') => void
  /** 摘一颗 */
  onDrop: (atom: QuickFilterAtom) => void
  /** 清空两列（有筛选时才有这颗按钮） */
  onClear?: () => void
  /**
   * 候选多了要能找：给输入框（词只筛候选，不筛已选）。
   * 只在候选可能成百的面（查询结果／整页大纲）打开；窄栏不加，省一行。
   */
  search?: boolean
  /** 空候选时的那句话（各处材料不同，措辞跟着说） */
  emptyText?: MsgId
}

/** 把 chips 面板画进 `host`。一次手势后由调用方重画 */
export function renderQuickFilter(host: HTMLElement, deps: QuickFilterDeps): void {
  host.classList.add('quick-filter')
  host.replaceChildren()

  const state = deps.state()
  const active = quickFilterActive(state)

  /* 两列：包含／排除。空列不画占位——列头本身就是这一列的说明 */
  const cols = document.createElement('div')
  cols.className = 'quick-filter-cols'
  cols.append(
    filterCol('include', 'ui.filter.include', state.include, deps),
    filterCol('remove', 'ui.filter.remove', state.remove, deps),
  )
  host.appendChild(cols)

  /**
   * 搜索框：只筛候选，不筛已选（已选那两列是这一屏的条件本身，被搜索藏掉
   * 就会出现「有条件却看不见」）。输入即重画，词随重画保住——
   * 词是这份面板的局部状态，不改调用方手里那份 chips。
   */
  const term = document.createElement('input')
  term.type = 'search'
  term.className = 'quick-filter-search'
  term.placeholder = t('ui.filter.searchHint')
  term.setAttribute('aria-label', t('ui.filter.searchHint'))
  term.dataset.filterSearch = '1'
  if (deps.search === true) host.appendChild(term)

  const candidates = quickFilterCandidates(deps.records())
  const drawCandidates = (q: string): void => {
    const hit = (label: string): boolean => q === '' || label.toLowerCase().includes(q.toLowerCase())
    const pages = candidates.pages.filter((c) => hit(c.label))
    const tags = candidates.tags.filter((c) => hit(c.label))
    lists.replaceChildren()
    if (pages.length === 0 && tags.length === 0) {
      const p = document.createElement('p')
      p.className = 'quick-filter-empty'
      p.textContent = t(deps.emptyText ?? 'ui.filter.empty')
      lists.appendChild(p)
      return
    }
    group('quick-filter-pages', 'ui.filter.pages', pages)
    group('quick-filter-tags', 'ui.filter.tags', tags)
  }
  const lists = document.createElement('div')
  lists.className = 'quick-filter-candidates'
  host.appendChild(lists)
  const group = (cls: string, title: MsgId, items: typeof candidates.pages): void => {
    if (items.length === 0) return
    const g = document.createElement('div')
    g.className = `quick-filter-group ${cls}`
    const h = document.createElement('span')
    h.className = 'quick-filter-group-title'
    h.textContent = t(title)
    g.appendChild(h)
    for (const c of items) {
      g.appendChild(
        chip(c.atom, c.label, c.count, {
          click: (a) => deps.onAdd(a, 'include'),
          shift: (a) => deps.onAdd(a, 'remove'),
          hint: 'ui.filter.chipHint',
        }),
      )
    }
    lists.appendChild(g)
  }
  drawCandidates('')
  if (deps.search === true) {
    term.addEventListener('input', () => drawCandidates(term.value.trim()))
  }

  if (active && deps.onClear) {
    const clear = document.createElement('button')
    clear.type = 'button'
    clear.className = 'quick-filter-clear'
    clear.dataset.filterClear = '1'
    clear.textContent = t('ui.filter.clear')
    clear.addEventListener('click', (e) => {
      e.stopPropagation()
      deps.onClear?.()
    })
    host.appendChild(clear)
  }
}

/** 一列已选 chips：列头 ＋ 这一颗颗（点击＝摘，Shift+点＝挪列） */
function filterCol(col: 'include' | 'remove', title: MsgId, atoms: readonly QuickFilterAtom[], deps: QuickFilterDeps): HTMLElement {
  const el = document.createElement('div')
  el.className = 'quick-filter-col'
  el.dataset.col = col
  const h = document.createElement('span')
  h.className = 'quick-filter-col-title'
  h.textContent = t(title)
  el.appendChild(h)
  const gestures =
    col === 'include'
      ? { click: (a: QuickFilterAtom) => deps.onDrop(a), shift: (a: QuickFilterAtom) => deps.onAdd(a, 'remove'), hint: 'ui.filter.activeHint' as MsgId }
      : { click: (a: QuickFilterAtom) => deps.onDrop(a), shift: () => {}, hint: 'ui.filter.chipHintRemove' as MsgId }
  for (const a of atoms) el.appendChild(chip(a, deps.labelOf(a), undefined, gestures))
  return el
}

interface ChipGestures {
  click: (atom: QuickFilterAtom) => void
  shift: (atom: QuickFilterAtom) => void
  /** 提示这一颗上两种手势各是什么（`title`） */
  hint: MsgId
}

/**
 * 一颗 chip。候选带计数徽标（数＝这批记录里命中行数）；已选的不带——
 * 那颗数字在筛选生效后就说不清是「总命中」还是「剩余」，两说都错，干脆不说。
 */
function chip(atom: QuickFilterAtom, label: string, count: number | undefined, gestures: ChipGestures): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'quick-filter-chip'
  const name = document.createElement('span')
  name.className = 'quick-filter-chip-name ui-ellipsis'
  name.textContent = label
  btn.appendChild(name)
  if (count !== undefined) {
    const n = document.createElement('span')
    n.className = 'quick-filter-chip-n'
    n.textContent = String(count)
    btn.appendChild(n)
  }
  btn.title = t(gestures.hint)
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    if (e.shiftKey) gestures.shift(atom)
    else gestures.click(atom)
  })
  return btn
}
