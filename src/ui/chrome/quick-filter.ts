/**
 * 快速筛选的 chips 弹层：两列（包含／排除）＋ 候选 chips。
 *
 * 这是派生面（反链卡／引用栏／提及栏）抬头上的 chrome：它**不持有状态**——
 * 两列 chips 与结果集都由调用方现给，组件只画与转发手势。状态住会话瞬态
 * （调用方的组件实例里），不写偏好、不入库、不产生任何写路径。
 *
 * 手势两条，与列头写的一致：
 *   · **点候选** ＝ 加入「包含」；**Shift+点候选** ＝ 加入「排除」。
 *   · **点已选 chip** ＝ 摘除；**Shift+点包含列的 chip** ＝ 挪到排除列。
 *
 * 每次手势后调用方重画这份内容（弹层不关——用户常连点几颗），
 * 重画就是再调一次 `renderQuickFilter`，没有第二份渲染路径。
 */
import { t, type MsgId } from '../../core/infra/msg.ts'
import { quickFilterCandidates, type QuickFilterAtom, type QuickFilterState, type ViewRecord } from '../../core/index.ts'

export interface QuickFilterDeps {
  /** 候选与计数的数据源：这一屏的结果集（未筛的那批，口径见 core 的候选注释） */
  records: () => readonly ViewRecord[]
  /** 现在的两列 chips（组件不持有状态） */
  state: () => QuickFilterState
  /** 已选 chip 的显示名（持有方经读门面解析 id；名字是显示层的事，不进状态） */
  labelOf: (atom: QuickFilterAtom) => string
  /** 加一颗（已在另一列时由模型层挪列）；改完由持有方重画这一屏与这份内容 */
  onAdd: (atom: QuickFilterAtom, to: 'include' | 'remove') => void
  /** 摘一颗 */
  onDrop: (atom: QuickFilterAtom) => void
}

/** 把 chips 弹层画进 `host`（通常是浮层给的那一格）。一次手势后由调用方重画 */
export function renderQuickFilter(host: HTMLElement, deps: QuickFilterDeps): void {
  host.classList.add('quick-filter')
  host.replaceChildren()

  const state = deps.state()

  /* 两列：包含／排除。空列不画占位——列头本身就是这一列的说明 */
  const cols = document.createElement('div')
  cols.className = 'quick-filter-cols'
  cols.append(
    filterCol('include', 'ui.filter.include', state.include, deps),
    filterCol('remove', 'ui.filter.remove', state.remove, deps),
  )
  host.appendChild(cols)

  /* 候选：这一屏结果集里出现过的页与标签，各带计数 */
  const candidates = quickFilterCandidates(deps.records())
  const lists = document.createElement('div')
  lists.className = 'quick-filter-candidates'
  if (candidates.pages.length === 0 && candidates.tags.length === 0) {
    const p = document.createElement('p')
    p.className = 'quick-filter-empty'
    p.textContent = t('ui.filter.empty')
    lists.appendChild(p)
  } else {
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
    group('quick-filter-pages', 'ui.filter.pages', candidates.pages)
    group('quick-filter-tags', 'ui.filter.tags', candidates.tags)
  }
  host.appendChild(lists)
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
 * 一颗 chip。候选带计数徽标（数＝结果集命中行数）；已选的不带——
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
