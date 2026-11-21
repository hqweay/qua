/**
 * 字段入口的**唯一产地**：块标签 chip 的三角 ＋ 行内实例的字段手柄。
 *
 * 为什么单独成文件：这三种露面（正文行、卡片、表格标签列）原本各画各的——
 * 正文行有三角与手柄，卡片/表格的 chip 是裸的、投影里的实例没有手柄，
 * 于是「同一枚标签在不同面能做的事不一样」。把 DOM 形状与点击判据收在这里，
 * 三个面共用同一份，改一处就不会漏另外两处。
 *
 * 判据（承 `agent-inline-affordance-budget`）：
 *   · chip 是 0-cell 装饰，三角可以常驻；实例是 1-cell 原子，手柄复用已有的图标槽；
 *   · 只有目标**声明了字段**才有 body 可披露，空字段仍算（要去填），没声明不算；
 *   · 入口带自己的 `data-*`，点击分派排在 `data-ref-to` 导航之前——
 *     「就地改字段」和「去目标」是两件事，不能合成一次点击。
 */
import { declaredFieldIds, prop, COLOR_PROP, type Block } from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import { renderIcon } from '../icons.ts'
import { makeTagChipEl } from './run-dom.ts'
import { isTagFieldsOpen } from './tag-fields-open.ts'

/** 块标签 chip 的字段三角：0-cell、常驻、内部独立命中区 */
export function makeTagFieldsCaret(hostId: string, tagId: string, label: string): HTMLElement {
  const caret = document.createElement('span')
  caret.className = 'tag-chip-caret'
  caret.contentEditable = 'false'
  caret.draggable = false
  caret.dataset.tagFieldsFor = hostId
  caret.dataset.tagFieldsTag = tagId
  caret.dataset.tip = t('ui.chip.fieldsTitle', { label })
  // 卡片开着时宿主行可能刚被重画（写值就会）；三角是重建的，开合朝向按渲染输入补回来
  if (isTagFieldsOpen(hostId, tagId)) caret.setAttribute('aria-expanded', 'true')
  renderIcon(caret, 'lucide:chevron-right', 'chevron-right', 'sm')
  // 按下不挪光标、不起拖；click 冒到容器走 tagFields 分支（chip 本体仍走导航）
  caret.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
  })
  caret.addEventListener('dragstart', (e) => e.preventDefault())
  return caret
}

/**
 * 一枚块标签 chip 该不该带三角：目标标签声明了字段才有 body 可披露。
 * 三个面（正文行 / 卡片 / 表格）共吃这一条，别各自判。
 */
export function tagHasFields(tag: Block): boolean {
  return declaredFieldIds(tag).length > 0
}

/** chip 上色也收在这里：三个面同一条口径（配了色染，没配维持 accent） */
export function tagChipColor(tag: Block): string | undefined {
  return prop<string>(tag, COLOR_PROP)
}

/**
 * 三个面共用的**一枚标签 chip**：裸 chip ＋（有字段时）字段三角。
 *
 * 为什么连 chip 本身也收进来：正文行 / 卡片 / 表格此前各调一次 `makeTagChipEl`，
 * 只有正文行记得加三角 ⇒ 同一枚标签在卡片里就少了入口。现在它们只调这一个函数，
 * 「哪面有三角」不再由调用方记住。
 */
export function makeTaggedChip(hostId: string, tag: Block, name: string): HTMLElement {
  const chip = makeTagChipEl(tag.id, name, tagChipColor(tag))
  if (tagHasFields(tag)) chip.prepend(makeTagFieldsCaret(hostId, tag.id, name))
  return chip
}

/** 字段入口命中后交给谁；三个面装配时各自注入同一组回调 */
export interface FieldAffordanceHandlers {
  onRefFields?: (runId: string, el: HTMLElement) => void
  onTagFields?: (hostId: string, tagId: string, el: HTMLElement) => void
}

/**
 * 从点击路径里找字段入口，**排在 `data-ref-to` 导航之前**。
 *
 * 入参可以是 `composedPath()`（重渲染把目标摘掉后仍拿得到原路径），也可以是一个
 * `target`（卡片/表格那一层没有事件对象，只有委托给你的 target）——两种都接住。
 * 命中返回 true，调用方 `preventDefault` 并结束这一轮，不再走导航。
 */
export function routeFieldAffordance(
  from: EventTarget | readonly EventTarget[],
  handlers: FieldAffordanceHandlers,
): boolean {
  const path: readonly EventTarget[] = Array.isArray(from)
    ? from
    : (() => {
        const out: EventTarget[] = []
        for (let n: Node | null = from as Node; n; n = n.parentNode) out.push(n)
        return out
      })()
  const el = (n: EventTarget): n is HTMLElement => n instanceof HTMLElement
  // 手柄在实例原子内部，三角在 chip 内部：两者都是「独立命中区」，先认它们再认本体导航
  const handle = path.find((n) => el(n) && n.dataset.refFields !== undefined)
  if (handle && el(handle) && handle.dataset.refFields) {
    handlers.onRefFields?.(handle.dataset.refFields, handle)
    return true
  }
  const caret = path.find((n) => el(n) && n.dataset.tagFieldsFor !== undefined)
  if (caret && el(caret) && caret.dataset.tagFieldsFor && caret.dataset.tagFieldsTag) {
    handlers.onTagFields?.(caret.dataset.tagFieldsFor, caret.dataset.tagFieldsTag, caret)
    return true
  }
  return false
}
