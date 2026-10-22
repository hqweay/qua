/**
 * 两个侧槽的内容：**左槽＝今日，右槽＝反链**。
 *
 * 原先这段长在 `main.ts` 里。搬出来的判据：它做的是「用块渲染器排出一列块」，
 * 属于 UI 组件的知识；装配层只需要说「现在有哪几页、当前是哪一页、点了怎么开」。
 *
 * ⚠️ 这里**不认 `ws`／`ed`／`registry`**，只认下面这个 `DockContentDeps`。
 * ⚠️ 渲染一律走 `renderBlock`：槽只排一列，块由类型决定长相（角色只叠 chrome）。
 */
import { findJournalDay, todayISO, type Atom, type Block, type Index } from '../core/index.ts'
import { backrefsOf } from '../core/backrefs.ts'
import { t } from '../core/msg.ts'
import { renderBlock, type BlockRenderCtx } from './block-renderers.ts'
import { renderDockStack, type DockCard, type DockSlotEls } from './dock.ts'

export interface DockContentDeps {
  /** 块森林（页在顶层） */
  blocks: () => Block[]
  activeId: () => string
  /** 打开某个页（页 id 或反链项的来源页 id） */
  openPage: (id: string) => void
  newPage: () => void
  /** 库级行内原子（反链的数据源） */
  atoms: () => Atom[]
  /** 共享索引（反链走查表，不再扫全库；由 store 缓存） */
  index: () => Index
}

/** 额外内容：常驻卡片（活编辑器）与调用方准备的卡片 */
export interface DockExtra {
  /** 排在内建卡片之前的卡片（由调用方决定内容） */
  cards?: DockCard[]
  /**
   * **常驻节点**：不在每次重画里重建（例如承载 `BlockEditor` 的钉住卡片）。
   * 它们挂在堆叠最上面，重画其余卡片时原地不动 —— 移动会打断 contenteditable 的光标。
   */
  persistent?: HTMLElement[]
}

/**
 * 左槽：**今日**（journal 块）。
 *
 * ⚠️ 这里没有「我选的一组块」这种卡片：那个概念（用户自己命名的分组）还没有载体。
 *    曾用「普通块 ＋ 一个专用角色 ＋ 内部一列块 id」冒充它 —— 但冒充出来的东西会被读成
 *    产品概念，还白占一个角色值；等真概念从模型里长出来时再进左槽。
 */
export function renderTodayInto(deps: DockContentDeps, slot: DockSlotEls, extra: DockExtra = {}): void {
  const ctx: BlockRenderCtx = {
    isActive: (id) => id === deps.activeId(),
    onActivate: (b) => deps.openPage(b.id),
    untitledLabel: t('ui.page.untitled'),
  }

  const cards: DockCard[] = []
  const forest = deps.blocks()

  // Daily note：在库里找今天的 journal 块（冷启动时它一定已经物化，见 seed／装配层）
  const today = findJournalDay(forest, todayISO())
  if (today) {
    const body = document.createElement('div')
    body.id = 'journal-today'
    body.className = 'block-list'
    body.appendChild(renderBlock(today, ctx))
    cards.push({ id: 'journal', title: t('ui.dock.today'), body })
  }

  renderDockStack(slot.stack, [...(extra.cards ?? []), ...cards], t('ui.dock.empty'), extra.persistent)
}

/** 右槽：反链面板 */
export function renderBackrefsInto(deps: DockContentDeps, slot: DockSlotEls, extra: DockExtra = {}): void {
  const target = deps.activeId()
  const sources = backrefsOf({ blocks: deps.blocks(), atoms: deps.atoms(), targetId: target, index: deps.index() })

  const ctx: BlockRenderCtx = {
    isActive: (id) => id === deps.activeId(),
    onActivate: (b) => deps.openPage(b.id),
    untitledLabel: t('ui.page.untitled'),
  }

  const list = document.createElement('div')
  list.className = 'block-list'
  if (sources.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'dock-empty'
    empty.textContent = t('ui.dock.noBackRefs')
    list.appendChild(empty)
  }
  // 反链项**不是库里的块**，是查询结果：现造一行出来，靠 `props._icon` 拿箭头（大纲行已经读它）。
  // 不给它挂角色 —— 角色说的是「这块在系统里担任什么机制位」，而它没有库身份，从不落盘。
  for (const s of sources) {
    const row: Block = { id: s.pageId, text: s.text, children: [], props: { _icon: 'lucide:corner-up-left' } }
    list.appendChild(renderBlock(row, ctx))
  }

  const cards: DockCard[] = [{ id: 'backrefs', title: t('ui.dock.backRefs'), body: list }]
  renderDockStack(slot.stack, [...(extra.cards ?? []), ...cards], t('ui.dock.empty'), extra.persistent)
}
