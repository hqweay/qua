/**
 * **拖拽的一条缝**：拖源只报「我是谁」，落点只答「拖到我这里是什么意思」。
 *
 * 为什么要有这个文件：原先拖拽有两处各写一遍，而**通信方式还不一样** ——
 * 正文的落点读组件私有状态（`editor.dragId`），侧槽的落点读 `dataTransfer`。
 * 于是「从侧槽／面板拖一个块到正文」是**空操作**（`dragId` 是 null），不报错、也不提示。
 *
 * 三条硬约束（每一条都对应一个实际会犯的错）：
 *   1. **载荷必须能独立成立**。不能是「我认得刚才那次拖拽」——那是内部状态，跨组件就断。
 *      块载荷里只有块 id（`BLOCK_MIME`）；卡片载荷里只有卡片实例 id（`CARD_MIME`）。
 *      `text/plain` 也留一份，仅为拖到外部应用时有可读内容。
 *   2. **悬停期读不到载荷**。HTML5 在 `dragover`／`dragenter` 期间 `getData()` 一律返回空串
 *      （保护模式，只能看 `types`）⇒ 模块必须自己记住「现在拖的是谁」，否则悬停给不出提示。
 *      这份记忆是**所有落点共用的那一份**（同一时刻只可能有一次拖拽），不是某个组件的私产。
 *   3. **含义由落点注入**。模块不认识归属边、不认识命令、不认识树 —— 它只知道
 *      「X 落到了落点 Y」。加第四种落点不用改本文件。
 *
 * 放 `view/` 的理由：碰 DOM ⇒ 不是 `core`；要被 `ui/` 用（侧槽），而 `ui → view` 是允许方向。
 */
import { t } from '../core/msg.ts'

/** 块载荷的 MIME：只有它能被当成「拖的是一个块」 */
export const BLOCK_MIME = 'application/x-qua-block'

/** 侧槽卡片载荷的 MIME：只有它能被当成「拖的是一张卡」（移动窗口/排序） */
export const CARD_MIME = 'application/x-qua-dock-card'

/** 集合项载荷的 MIME：`collectionId:itemId`——移动集合里的一条引用，不是移动块 */
export const ITEM_MIME = 'application/x-qua-collection-item'

/** 拖到**外部应用**时的可读内容（不是给别人当块用的） */
const TEXT_MIME = 'text/plain'

/** 块 id 的形状（32 位十六进制）。只验形状，不查库 —— 「在不在库里」是落点的事 */
const ID_SHAPE = /^[0-9a-f]{32}$/

export function isBlockId(v: unknown): v is string {
  return typeof v === 'string' && ID_SHAPE.test(v)
}

/** 此刻正在拖的那个块/那张卡（`dragover` 期间唯一可得的来源） */
let draggingBlock: string | null = null
let draggingCard: string | null = null
let draggingItem: string | null = null

/** 拖源：只报「我是谁」 */
export function setDragBlock(dt: DataTransfer | null, id: string): void {
  draggingBlock = id
  if (!dt) return
  dt.setData(BLOCK_MIME, id)
  // 只有拿到块 id 时才写 text/plain：拖一段普通文字进来不该被当成块
  dt.setData(TEXT_MIME, id)
  // 同一个块可以移（正文）、可以建关系（面板）、可以钉住（侧槽）⇒ 三种都允许
  dt.effectAllowed = 'all'
}

/** 卡片拖源：移动窗口/排序。载荷只有卡片实例 id，与块载荷分开 */
export function setDragCard(dt: DataTransfer | null, id: string): void {
  draggingCard = id
  if (!dt) return
  dt.setData(CARD_MIME, id)
  dt.setData(TEXT_MIME, id)
  dt.effectAllowed = 'move'
}

/** 集合项拖源：载荷是 `collectionId:itemId`（只用于集合内排序） */
export function setDragItem(dt: DataTransfer | null, collectionId: string, itemId: string): void {
  draggingItem = `${collectionId}:${itemId}`
  if (!dt) return
  dt.setData(ITEM_MIME, draggingItem)
  dt.setData(TEXT_MIME, itemId)
  dt.effectAllowed = 'move'
}

/** 收掉这次的拖拽（`dragend`／`drop` 之后必须调，否则悬停期会读到脏值） */
export function clearDragBlock(): void {
  draggingBlock = null
  hideHint()
}

export function clearDragCard(): void {
  draggingCard = null
  hideHint()
}

export function clearDragItem(): void {
  draggingItem = null
  hideHint()
}

/** 全局拖拽结束：三种载荷一起清（`dragend` 可能落在任何地方，甚至不来） */
export function clearDrag(): void {
  draggingBlock = null
  draggingCard = null
  draggingItem = null
  hideHint()
}

export function currentDraggedId(): string | null {
  return draggingBlock
}

export function currentDraggedCardId(): string | null {
  return draggingCard
}

export function currentDraggedItem(): string | null {
  return draggingItem
}

/** 载荷里是不是块（只按 MIME 判，不看内容） */
export function hasBlockPayload(dt: DataTransfer | null): boolean {
  return dt?.types?.includes(BLOCK_MIME) ?? false
}

/** 载荷里是不是卡片（只按 MIME 判，不看内容） */
export function hasCardPayload(dt: DataTransfer | null): boolean {
  return dt?.types?.includes(CARD_MIME) ?? false
}

/** 载荷里是不是集合项（只按 MIME 判，不看内容） */
export function hasItemPayload(dt: DataTransfer | null): boolean {
  return dt?.types?.includes(ITEM_MIME) ?? false
}

/**
 * 松手期：从载荷里读块 id。
 *
 * 形状不对（外部拖来的文字、别的应用的自定义类型）一律 `null` ——
 * 不在这里「猜一个」，也不用 `kb.get` 事后兜底：不是块就不是块。
 */
export function draggedBlockId(dt: DataTransfer | null): string | null {
  const raw = dt?.getData(BLOCK_MIME) ?? ''
  return isBlockId(raw) ? raw : null
}

/** 松手期：从载荷里读卡片 id（卡片 id 是块 id 或派生卡名，只验非空） */
export function draggedCardId(dt: DataTransfer | null): string | null {
  const raw = dt?.getData(CARD_MIME) ?? ''
  return raw === '' ? null : raw
}

/** 松手期：集合项载荷（`collectionId:itemId`）；没有分隔符就当作不是集合项 */
export function draggedItem(dt: DataTransfer | null): string | null {
  const raw = dt?.getData(ITEM_MIME) ?? ''
  return raw.includes(':') ? raw : null
}

/* ------------------------------------------------------------ 悬停提示 */

/**
 * 悬停期的那一句话。
 *
 * 为什么由模块自己画：含义既然按落点变，就必须在**松手前**说出来；每个落点各画一份
 * 会漂移（有的写了、有的忘了）。模块只负责把落点给的那句话贴在指针旁，不知道它的意思。
 */
let hintEl: HTMLElement | null = null

function showHint(text: string, e: DragEvent): void {
  if (text === '') {
    hideHint()
    return
  }
  if (!hintEl) {
    hintEl = document.createElement('div')
    hintEl.className = 'dnd-hint'
    hintEl.setAttribute('role', 'presentation')
    document.body.appendChild(hintEl)
  }
  hintEl.textContent = text
  // 指针右下 12px：避开光标本身，也不会盖住落点的高亮线
  hintEl.style.left = `${e.clientX + 12}px`
  hintEl.style.top = `${e.clientY + 12}px`
}

function hideHint(): void {
  if (!hintEl) return
  hintEl.remove()
  hintEl = null
}

/* ------------------------------------------------------------ 落点 */

export interface DropTargetOpts {
  /**
   * 载荷种类：`block`（缺省）＝块 id；`card`＝侧槽卡片实例 id；
   * `item`＝集合项（`collectionId:itemId`）。三种载荷分开判 MIME。
   */
  kind?: 'block' | 'card' | 'item'
  /**
   * 这一刻拖到这儿代表谁（`null` ＝ 不指向具体块）。
   *
   * ⚠️ 是**函数而不是值**：同一个容器里的落点常常随指针动（正文三区、列表行）。
   *    静态落点写 `() => id` 就行。
   */
  targetId: (e: DragEvent) => string | null
  /** 接不接受（缺省全接）。拒绝时**不** `preventDefault` ⇒ 浏览器不把它当落点，也就不会亮 */
  accept?: (draggedId: string, e: DragEvent) => boolean
  /** **落点自己说会变成什么**——悬停时就要能读出来（必填） */
  hint: (draggedId: string, e: DragEvent) => string
  /** 三种含义各用各的光标：移入／建立关系／打开窗口 */
  effect?: 'move' | 'link' | 'copy'
  /** 松手：含义由落点注入（通常是一次 `registry.invoke`） */
  onDrop: (draggedId: string, targetId: string | null, e: DragEvent) => void
  /** 高亮用的 dataset 键（缺省 `drop`；侧槽用 `dropPin` 保持现有 CSS 契约） */
  attr?: string
  /** 自己画高亮（正文三区那种要分 before/after/inside 的）。给了就不用 `attr` */
  mark?: (draggedId: string, e: DragEvent) => void
  /** 收掉高亮（与 `mark` 配对） */
  unmark?: () => void
}

/**
 * 绑一个落点；返回解绑函数。
 *
 * 「拒绝」由落点声明：不能拖进自己的子树是**树**的规则（正文落点），
 * 成环是**边图**的规则（由命令层拒绝）。两套规则各归各的图，模块不掺和。
 */
export function bindDropTarget(el: HTMLElement, o: DropTargetOpts): () => void {
  const attr = o.attr ?? 'drop'
  const kind = o.kind ?? 'block'
  const draggedNow =
    kind === 'card' ? currentDraggedCardId : kind === 'item' ? currentDraggedItem : currentDraggedId
  const hasPayload = kind === 'card' ? hasCardPayload : kind === 'item' ? hasItemPayload : hasBlockPayload
  const readId = kind === 'card' ? draggedCardId : kind === 'item' ? draggedItem : draggedBlockId
  const clear = kind === 'card' ? clearDragCard : kind === 'item' ? clearDragItem : clearDragBlock
  const mark = (id: string, e: DragEvent): void => {
    if (o.mark) o.mark(id, e)
    else el.dataset[attr] = '1'
  }
  const unmark = (): void => {
    if (o.unmark) o.unmark()
    else delete el.dataset[attr]
    hideHint()
  }

  const dragover = (e: DragEvent): void => {
    const id = draggedNow()
    /**
     * 悬停期只能看 `types`（保护模式读不到内容）⇒ 这里只能判「有没有对应载荷」。
     * 内容形状的校验必须留到 `drop`：`dragover` 里 `getData` 一律空串，
     * 想靠它提前验形状是不可能的（真试过）。
     */
    if (!id || !hasPayload(e.dataTransfer)) return
    if (o.accept && !o.accept(id, e)) return
    // **最内层的落点赢**：一行落在槽里时，别让整槽的落点也把提示/高亮抢过去
    e.stopPropagation()
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = o.effect ?? 'move'
    mark(id, e)
    showHint(o.hint(id, e), e)
  }

  const dragleave = (e: DragEvent): void => {
    // 移到自己的子元素上不算离开
    const next = e.relatedTarget as Node | null
    if (next && el.contains(next)) return
    unmark()
  }

  const drop = (e: DragEvent): void => {
    /**
     * 载荷在 drop 期才可读，而且**只认载荷**：形状不对就当没这回事。
     * 不拿 `currentDraggedId()` 兜底 —— 那会让「拖一段普通文字进正文」借上一次的记忆
     * 把刚才那块搬走（这是最容易漏的一条：悬停期读不到载荷，兜底看起来像是在帮忙）。
     */
    const id = readId(e.dataTransfer)
    unmark()
    if (!id) return
    if (o.accept && !o.accept(id, e)) return
    e.stopPropagation()
    e.preventDefault()
    o.onDrop(id, o.targetId(e), e)
    clear()
  }

  const dragend = (): void => unmark()

  el.addEventListener('dragover', dragover)
  el.addEventListener('dragleave', dragleave)
  el.addEventListener('drop', drop)
  el.addEventListener('dragend', dragend)
  return () => {
    el.removeEventListener('dragover', dragover)
    el.removeEventListener('dragleave', dragleave)
    el.removeEventListener('drop', drop)
    el.removeEventListener('dragend', dragend)
    unmark()
  }
}

/**
 * 全局兜底：拖出窗口后松手，`dragend` 可能落在别处（甚至不来）。
 * 不清理的话，下一次悬停会读到上一次的块 id —— 那正是「拖了个不存在的块」。
 */
if (typeof document !== 'undefined') {
  document.addEventListener('dragend', () => clearDrag())
  // 外部应用拖进来的东西松手后也会冒泡到这里：顺手把提示收掉
  document.addEventListener('drop', () => hideHint(), true)
}

/** 编辑器三区的提示文案（落点自己要说的那句话，集中在这里免得三种写法） */
export function zoneHint(zone: 'before' | 'after' | 'inside'): string {
  if (zone === 'before') return t('ui.dnd.moveBefore')
  if (zone === 'after') return t('ui.dnd.moveAfter')
  return t('ui.dnd.moveInto')
}
