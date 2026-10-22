/**
 * 两个侧槽的内容：**左槽＝收藏容器块，右槽＝反链**。
 *
 * 原先这段长在 `main.ts` 里。搬出来的判据：它做的是「用块渲染器排出一列块」，
 * 属于 UI 组件的知识；装配层只需要说「现在有哪几页、当前是哪一页、点了怎么开」。
 *
 * ⚠️ 这里**不认 `ws`／`ed`／`registry`**，只认下面这个 `DockContentDeps`。
 * ⚠️ 渲染一律走 `renderBlock`（29 「一源多视」）：槽只排一列，块由类型决定长相（角色只叠 chrome）。
 */
import { findJournalDay, todayISO, liveFavorites, containerTitle, type Atom, type Block, type Index } from '../core/index.ts'
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
  /* ---- 收藏容器块（收藏 ＝ 命名容器块 ＋ 一列块引用） ---- */
  /** 库里的收藏容器块（可能不止一个，顺序各自独立） */
  favoriteContainers: () => Block[]
  /** 从某个容器里移出一条收藏 */
  removeFavorite: (containerId: string, blockId: string) => void
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
 * 左槽：**今日**（journal 块）＋ **收藏容器块**。
 *
 * ⚠️ 2026-10-20 修掉一处既有偏差：这里原先直接列出**全部页块**，那不是「收藏」——
 * 按 ，收藏是**命名容器块内部的一列块引用**（有序），与「库里有哪几页」无关。
 *    现在：容器块自己是一条记录（名字 = 它的正文），内容 = 它 `_favorites` 里的引用，
 *    按顺序渲染；悬空引用**不静默丢弃**（`liveFavorites` 过滤，`pruneFavorites` 显式清）。
 */
export function renderFavoritesInto(deps: DockContentDeps, slot: DockSlotEls, extra: DockExtra = {}): void {
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

  // 收藏：**每个容器块一张卡**（可以有多张 —— 同一块可被多个容器收藏，顺序各自独立）
  const containers = deps.favoriteContainers()
  if (containers.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'dock-empty'
    empty.id = 'favorites-empty'
    empty.textContent = t('ui.dock.noFavorites')
    cards.push({ id: 'favorites', title: t('ui.dock.favorites'), body: wrap(empty) })
  }
  for (const c of containers) {
    const list = document.createElement('div')
    list.className = 'block-list favorites-list'
    list.dataset.containerId = c.id
    const items = liveFavorites(forest, c)
    if (items.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'dock-empty'
      empty.textContent = t('ui.dock.containerEmpty')
      list.appendChild(empty)
    }
    for (const b of items) {
      const row = document.createElement('div')
      row.className = 'favorite-row'
      row.dataset.blockId = b.id
      // 引用行 = 块自己的渲染（一源多视，29 ）+ 一个「移出收藏」动作
      row.appendChild(renderBlock(b, ctx))
      const off = document.createElement('button')
      off.type = 'button'
      off.className = 'favorite-remove ghost'
      off.title = t('ui.dock.removeFavorite')
      off.textContent = '×'
      off.addEventListener('click', (e) => {
        e.stopPropagation()
        deps.removeFavorite(c.id, b.id)
      })
      row.appendChild(off)
      list.appendChild(row)
    }
    cards.push({
      id: `favorites/${c.id}`,
      title: containerTitle(c) || t('ui.dock.untitledContainer'),
      body: list,
    })
  }

  renderDockStack(slot.stack, [...(extra.cards ?? []), ...cards], t('ui.dock.empty'), extra.persistent)
}

/** 把一段节点包成一个 body 容器（`DockCard.body` 要的是元素） */
function wrap(el: HTMLElement): HTMLElement {
  const box = document.createElement('div')
  box.className = 'block-list'
  box.appendChild(el)
  return box
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
  // 反链项**不是库里的块**，是查询结果：用 `backref` 角色渲染（没有专属布局，只是带箭头的一行）
  for (const s of sources) {
    const row: Block = { id: s.pageId, text: s.text, children: [], roles: ['backref'] }
    list.appendChild(renderBlock(row, ctx))
  }

  const cards: DockCard[] = [{ id: 'backrefs', title: t('ui.dock.backRefs'), body: list }]
  renderDockStack(slot.stack, [...(extra.cards ?? []), ...cards], t('ui.dock.empty'), extra.persistent)
}
