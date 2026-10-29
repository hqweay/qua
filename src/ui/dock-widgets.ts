/**
 * **组件块的两个露面**：槽里的卡（body）与正文里的行（row）。
 *
 * 同一个块的两处露面画法不同，但**配置共享、undo 共享**（一源多视）：
 * 在正文里看见的摘要与在槽里看见的列表，读的是同一格 `_items`。
 *
 * 这一层只画 **body／row**；卡壳（头/折叠/单卡/关闭/拖拽）仍由 `dock.ts` 的
 * `buildDockCard` 提供。组件块和窗口卡的差别只在 body：
 *   · 窗口卡 → `BlockEditor`（内容块）；
 *   · 组件块 → 这里的 renderer（`core/collection-widget` 等）。
 *
 * ⚠️ 组件只拿**读门面**（`KbClient` 的窄方法），不拿整片森林；写一律回调用方
 *    （`addItem`/`removeItem` → 命令 → 事务），这样 undo/同步/索引仍只有一条写路径。
 * ⚠️ 这一层不认 `ws`/`registry`/`store`；装配层把能力收成 `WidgetDeps` 再传进来。
 */
import {
  collectionItems,
  collectionSummary,
  displayNameOf,
  isCollectionBlock,
  type Block,
  type FindBlock,
} from '../core/index.ts'
import type { KbClient } from '../core/kb/types.ts'
import { t } from '../core/msg.ts'
import { bindDropTarget, clearDragItem, setDragItem } from '../view/dnd.ts'
import { renderIcon } from '../view/icons.ts'
import { renderBlock, type BlockRenderCtx } from './block-renderers.ts'
import { cardList, cardNote } from './card-parts.ts'

export interface WidgetDeps {
  /** 读门面：集合里的项按 id 取活块 */
  kb: KbClient
  activeId: () => string
  /** 打开到中心槽 */
  open: (id: string) => void
  /** Shift+点：在右槽打开一张窗口 */
  openInDock: (id: string) => void
  /** 往集合里加一条引用（走命令面） */
  addItem: (collectionId: string, blockId: string) => void
  /** 从集合里摘一条引用（只摘引用，不删块） */
  removeItem: (collectionId: string, blockId: string) => void
  /** 集合内拖序：`to` 是当前列表里的插入下标 */
  moveItem: (collectionId: string, blockId: string, to: number) => void
  /** 打开块选择器（锚在「选择块」按钮上） */
  pickBlock: (collectionId: string, anchor: DOMRect) => void
  untitledLabel: string
}

/** 组件卡的标题：块名 > 类型默认；集合没有名字时不能显示成「无标题」 */
export function widgetTitle(block: Block): string {
  const name = displayNameOf(block).trim()
  if (name !== '') return name
  if (isCollectionBlock(block)) return t('ui.widget.collection')
  return t('ui.widget.untitled')
}

/**
 * 组件块的 body：按类型分派。
 *
 * ⚠️ 兜底**不是**「假装这是一行普通块」：没有渲染器的类型仍然要说出「为什么这一格是空的」，
 *    否则用户看到的是一张什么都没有的卡，而原因在另一层。
 */
export function widgetBody(block: Block, deps: WidgetDeps): HTMLElement {
  if (isCollectionBlock(block)) return collectionBody(block, deps)
  return cardNote(t('ui.widget.noRenderer'))
}

/**
 * **正文里的组件体**：一块组件在正文里那一格（`.tx` 之内、`contenteditable=false`）。
 *
 * 两种形状，判据是类型声明（`widget.body.kind`）：
 *   · `summary` —— 一行摘要（图标 ＋ 名字 ＋ 几条 ＋「打开」）：不可编辑、点它 ＝ 打开那张卡；
 *   · `inline`  —— 完整 UI 的一个**有界盒子**（高度两档，内部滚动）。
 *
 * 为什么摘要是**另一种形状**而不是「inline 的最低高度档」：摘要不可聚焦，
 * 点它的语义是「打开那张卡」；内联体可聚焦，点它的语义是「在正文里操作」。
 * 同一个东西不能有两种点击语义（那会让「点它到底开不开卡」没有答案）。
 *
 * ⚠️ 与 `widgetBody` 的分工：那边是槽里的**卡**，这边是正文里的**体**；
 *    两者读同一格配置，但**容器不同**（卡有自己的壳与宽度，体在 `.tx` 里跟正文同宽），
 *    合成一个函数会让「画多高、跟谁一样宽」变成分支条件。
 * ⚠️ `find` 由调用方给（正文渲染时是共享 store 的 `find`）：摘要要数「还有几条活着」，
 *    而这一层不持有森林。
 */
export function widgetBodyInDoc(
  block: Block,
  find: FindBlock | undefined,
  deps: WidgetDeps,
  kind: 'summary' | 'full',
): HTMLElement {
  if (kind === 'summary') return widgetSummary(block, find)
  const el = document.createElement('div')
  el.className = 'widget-body'
  el.appendChild(widgetBody(block, deps))
  return el
}

/**
 * 摘要那一档：图标 ＋ 名字 ＋ 条数 ＋「打开」。
 *
 * 它是**指路牌**，不是可操作的面 —— 所以整格只做一件事：打开那张卡。
 */
function widgetSummary(block: Block, find: FindBlock | undefined): HTMLElement {
  const el = document.createElement('span')
  el.className = 'widget-row'
  renderIcon(el, 'lucide:list-tree', 'list-tree', 'sm')

  const label = document.createElement('span')
  label.className = 'widget-row-label ui-ellipsis'
  label.textContent = widgetTitle(block)
  el.appendChild(label)

  const count = document.createElement('span')
  count.className = 'widget-row-count'
  if (isCollectionBlock(block)) {
    const s = collectionSummary(block, find ?? (() => undefined))
    count.textContent =
      s.total === 0
        ? t('ui.widget.rowEmpty')
        : s.alive === s.total
          ? t('ui.widget.rowCount', { n: String(s.total) })
          : t('ui.widget.rowCountMissing', { n: String(s.alive), gone: String(s.total - s.alive) })
  }
  el.appendChild(count)

  const open = document.createElement('span')
  open.className = 'widget-row-open'
  open.textContent = t('ui.widget.rowOpen')
  el.appendChild(open)
  return el
}

/** 集合项载荷：`collectionId:itemId` */
function parseItem(raw: string): { collectionId: string; itemId: string } | null {
  const at = raw.indexOf(':')
  if (at <= 0 || at === raw.length - 1) return null
  return { collectionId: raw.slice(0, at), itemId: raw.slice(at + 1) }
}

/** 集合卡：一组**引用**，不是一组子块 */
function collectionBody(block: Block, deps: WidgetDeps): HTMLElement {
  const items = collectionItems(block)
  /**
   * 集合卡要带 `collection-list`：那一档有自己的拖放落点样式（不是通用列表）。
   *
   * ⚠️ **空集合也要带**：拖一个块进空集合是它的主要用法之一，
   *    少了这个类就没有落点高亮——而「拖进来没反应」正是这类缺陷的形态。
   */
  const list = cardList('collection-list')
  if (items.length === 0) list.appendChild(cardNote(t('ui.widget.collectionEmpty')))

  const ctx: BlockRenderCtx = {
    isActive: (id) => id === deps.activeId(),
    onActivate: (b) => deps.open(b.id),
    onOpenInDock: (b) => deps.openInDock(b.id),
    untitledLabel: deps.untitledLabel,
  }

  for (const id of items) {
    const row = document.createElement('div')
    row.className = 'collection-row'
    row.dataset.itemId = id

    // 拖序手柄：只动集合里的引用，不动块本身
    const grip = document.createElement('span')
    grip.className = 'collection-grip'
    grip.draggable = true
    grip.title = t('ui.widget.moveItem')
    grip.setAttribute('aria-hidden', 'true')
    renderIcon(grip, 'lucide:grip-vertical', 'grip-vertical', 'sm')
    grip.addEventListener('dragstart', (e) => setDragItem(e.dataTransfer, block.id, id))
    grip.addEventListener('dragend', () => clearDragItem())
    row.appendChild(grip)

    const target = deps.kb.get(id)
    if (target) {
      // 行本身就是 `renderBlock` 的按钮：点＝打开、Shift+点＝右槽窗口（与正文同一套手势）
      row.appendChild(renderBlock(target, ctx))
    } else {
      // 悬空引用保留：位置是配置，块回来时它自己回来
      const missing = document.createElement('span')
      missing.className = 'collection-missing'
      missing.textContent = t('ui.widget.deletedItem')
      row.appendChild(missing)
    }

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'collection-x'
    remove.title = t('ui.widget.removeItem')
    remove.setAttribute('aria-label', t('ui.widget.removeItem'))
    renderIcon(remove, 'lucide:x', 'x', 'sm')
    remove.addEventListener('click', (e) => {
      e.stopPropagation()
      deps.removeItem(block.id, id)
    })
    row.appendChild(remove)
    list.appendChild(row)
  }

  // 选择块：不依赖拖拽，点开一个块选择器（锚在这个按钮上）
  const add = document.createElement('button')
  add.type = 'button'
  add.className = 'collection-add'
  add.title = t('ui.widget.addBlock')
  add.setAttribute('aria-label', t('ui.widget.addBlock'))
  renderIcon(add, 'lucide:plus', 'plus', 'sm')
  const addText = document.createElement('span')
  addText.textContent = t('ui.widget.addBlock')
  add.appendChild(addText)
  add.addEventListener('click', (e) => {
    e.stopPropagation()
    deps.pickBlock(block.id, add.getBoundingClientRect())
  })
  list.appendChild(add)

  /**
   * 集合内拖序：载荷是 `collectionId:itemId`；只接自己这一张卡的项。
   * 落点下标按指针落在哪一行的上半/下半算；`moveItem` 自己处理「先摘再插」的偏移。
   */
  bindDropTarget(list, {
    kind: 'item',
    effect: 'move',
    targetId: () => null,
    accept: (raw) => parseItem(raw)?.collectionId === block.id,
    hint: () => t('ui.widget.moveItemHint'),
    onDrop: (raw, _target, e) => {
      const parsed = parseItem(raw)
      if (!parsed) return
      const rows = [...list.querySelectorAll<HTMLElement>(':scope > .collection-row')]
      let to = rows.length
      for (let i = 0; i < rows.length; i++) {
        const rect = rows[i]!.getBoundingClientRect()
        if (e.clientY < rect.top + rect.height / 2) {
          to = i
          break
        }
      }
      deps.moveItem(block.id, parsed.itemId, to)
    },
  })

  /**
   * 拖一个块进集合 = 加一条引用（`effect: 'copy'`）。
   * 落点只认块载荷；集合自己不能收自己（那会是一个无意义自环）。
   */
  bindDropTarget(list, {
    kind: 'block',
    effect: 'copy',
    targetId: () => null,
    accept: (id) => id !== block.id && deps.kb.get(id) !== undefined,
    hint: () => t('ui.widget.addItemHint'),
    onDrop: (id) => deps.addItem(block.id, id),
  })

  return list
}
