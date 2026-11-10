/**
 * **中心槽的「这一屏」筛选**（顶栏那颗漏斗）：把快速筛选套到**当前打开的大纲**上。
 *
 * 它与查询块／派生栏的 chips 是**同一份判定、同一个面板**，只有两处不同：
 *   · **状态住会话内存**（按「当前对象」一格）——它是「我此刻在看什么」，不是内容，
 *     换页就换一格；不落盘、不入库、不进撤销栈（与派生栏 v1 同一条口径）。
 *   · **判定喂给编辑器的行遍历**（`BlockEditor.setRowFilter`），不是记录列表：
 *     大纲的行是嵌套的，所以「排除」**连同子树**去掉（被排除的块带着它的内容一起消失），
 *     「包含」命中的块留下、它的祖先链留作上下文（`filterVisibleRows`）。
 *
 * 为什么按「当前对象」分格而不是全局一格：漏斗是**每一屏**一份；
 * 在中心槽里「一屏」就是当前对象。给全局一格会让「从页 A 筛完切到页 B」时
 * 页 B 莫名其妙也只剩几行，而用户从没在 B 上按过那颗按钮。
 */
import {
  displayNameOf,
  hasChildrenViewBody,
  hasQueryBody,
  isQueryBlock,
  quickFilterActive,
  quickFilterAdd,
  quickFilterDrop,
  quickFilterVerdict,
  tagIdsOf,
  type Block,
  type QuickFilterAtom,
  type QuickFilterRow,
  type QuickFilterState,
  type RowVerdict,
  type VisibleRow,
} from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import { renderIcon } from '../../view/icons.ts'
import type { BlockEditor } from '../../view/editor/editor.ts'
import type { Chrome } from '../../ui/chrome/chrome.ts'
import { renderQuickFilter } from '../../ui/chrome/quick-filter.ts'
import type { MemoryKb } from '../../core/kb/memory.ts'

export interface OutlineFilterDeps {
  chrome: () => Chrome
  kb: MemoryKb
  /** 当前打开的对象（中心槽的 `activeId`） */
  activeId: () => string
  /** 主编辑器（大纲）——只有它有行筛选接缝 */
  editor: () => BlockEditor
  /** 中心此刻在放一张面（搜索／设置／派生面）？那几张面不归这个漏斗 */
  surfaceShown: () => boolean
}

export interface OutlineFilter {
  /** 装好接缝（只做一次）：行筛选的 provider ＋ 按钮点击 */
  install: () => void
  /** 重画按钮与面板（导航之后、库变化之后） */
  render: () => void
  /** 当前这一屏的 chips（诊断与断言用） */
  state: () => QuickFilterState
  /** 把这一屏的 chips 落下来（`null` ＝ 没变化）；改了才重画编辑器 */
  set: (next: QuickFilterState | null) => void
  /** 清掉这一屏的筛选 */
  clear: () => void
}

const EMPTY: QuickFilterState = { include: [], remove: [] }

export function setupOutlineFilter(deps: OutlineFilterDeps): OutlineFilter {
  const filters = new Map<string, QuickFilterState>()
  let open = false
  let installed = false

  const stateOf = (key: string): QuickFilterState => filters.get(key) ?? EMPTY
  const activeState = (): QuickFilterState => stateOf(deps.activeId())

  /** 一行的判定：页＝祖先链、标签＝自己的归属边（与派生面/查询块同一份事实） */
  const rowOf = (block: Block, path: readonly Block[]): QuickFilterRow => ({ path, tags: tagsOf(deps.kb, block) })

  /** 编辑器来问「此刻有没有筛选」——没有就返回 null（行集原样，不是「筛了一遍恰好全过」） */
  const predicate = (): ((block: Block, path: readonly Block[]) => RowVerdict) | null => {
    const state = activeState()
    if (!quickFilterActive(state)) return null
    return (block, path) => quickFilterVerdict(state, rowOf(block, path))
  }

  /**
   * 这一屏能不能筛。
   *
   * 它不是「编辑器看得见」的同义词：**查询块／视图容器的身体自己有漏斗**
   * （那一张视图的切片才是它的镜头），中心这里再给一颗只会筛掉那一行本身。
   */
  const canFilter = (): boolean => {
    if (deps.surfaceShown()) return false
    const b = deps.kb.get(deps.activeId())
    if (!b) return false
    return !isQueryBlock(b) && !hasQueryBody(b) && !hasChildrenViewBody(b)
  }

  /** 候选：这一屏**未筛**的行（`rowsAll`），路径按 depth 现拼 */
  const candidates = (): QuickFilterRow[] => {
    const rows: VisibleRow[] = deps.editor().rowsAll()
    const out: QuickFilterRow[] = []
    const stack: Block[] = []
    for (const r of rows) {
      stack.length = r.depth
      out.push(rowOf(r.block, [...stack]))
      stack[r.depth] = r.block
    }
    return out
  }

  const labelOf = (atom: QuickFilterAtom): string => {
    if ('tag' in atom) return atom.tag
    const b = deps.kb.get(atom.up.is)
    return b ? displayNameOf(b) || atom.up.is.slice(-4) : atom.up.is.slice(-4)
  }

  const paintButton = (): void => {
    const btn = deps.chrome().centerFilterEl
    renderIcon(btn, 'lucide:filter', 'filter')
    const state = activeState()
    const active = quickFilterActive(state)
    if (active) btn.dataset.active = '1'
    else delete btn.dataset.active
    const count = state.include.length + state.remove.length
    btn.title = active ? t('ui.filter.buttonActive', { count }) : t('ui.filter.buttonHint')
    btn.setAttribute('aria-label', t('ui.filter.button'))
  }

  const paintPanel = (): void => {
    renderQuickFilter(deps.chrome().centerFilterPanelEl, {
      records: candidates,
      state: activeState,
      labelOf,
      onAdd: (atom, to) => api.set(quickFilterAdd(activeState(), atom, to)),
      onDrop: (atom) => api.set(quickFilterDrop(activeState(), atom)),
      onClear: () => api.clear(),
      search: true,
      emptyText: 'ui.filter.emptyCenter',
    })
  }

  const api: OutlineFilter = {
    install: () => {
      if (installed) return
      installed = true
      // 接缝只装一次：provider 现读「当前对象」那一格，换页自动换（不需要重装）
      deps.editor().setRowFilter(predicate, false)
      deps.chrome().centerFilterEl.addEventListener('click', () => {
        if (!canFilter()) return
        open = !open
        if (open) paintPanel()
        deps.chrome().centerFilterPanelEl.hidden = !open
        paintButton()
      })
      // 首屏装载可能早于本节装配（编辑器还没造好）⇒ 装完自己补画一次
      api.render()
    },

    render: () => {
      const chrome = deps.chrome()
      const ok = canFilter()
      chrome.centerFilterEl.hidden = !ok
      if (!ok) open = false
      chrome.centerFilterPanelEl.hidden = !ok || !open
      if (ok) {
        paintButton()
        if (open) paintPanel()
      }
    },

    state: activeState,

    set: (next) => {
      if (!next) return
      const key = deps.activeId()
      if (quickFilterActive(next)) filters.set(key, next)
      else filters.delete(key)
      deps.editor().renderAll()
      paintButton()
      if (open) paintPanel()
    },

    clear: () => {
      const key = deps.activeId()
      if (!filters.delete(key)) return
      deps.editor().renderAll()
      paintButton()
      if (open) paintPanel()
    },
  }
  return api
}

/**
 * 一行的标签（归属边）。
 *
 * 走 `_tags` 里的 id 现读块，**不用 `kb.tagsOf`**：后者每次调用扫一遍标签表
 * （实测 2.5ms/次），而这里每次重画要对整屏每行问一次。
 */
function tagsOf(kb: MemoryKb, block: Block): Block[] {
  const out: Block[] = []
  for (const id of tagIdsOf(block)) {
    const t = kb.get(id)
    if (t) out.push(t)
  }
  return out
}
