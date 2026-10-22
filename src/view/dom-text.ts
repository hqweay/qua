/**
 * **DOM → 模型**：把 contenteditable 里看到的字，读回「文本 ＋ 偏移」。
 *
 * 这是从 `view.ts` 抽出来的纯函数层。判据：它**只依赖 DOM 与块 id**，不持有编辑器状态，
 * 所以能单独测（这正是「状态层可脱离 DOM 断言」的反面 —— 它是「DOM 可脱离状态断言」）。
 *
 * ⚠️ 与 `block-dom.ts` 是一对：那边**模型 → DOM**，这边**DOM → 模型**。
 *   两条方向都必须认同一套契约：原子元素带 `data-atomId`、占 **1 格**（`U+FFFC`）、
 *   `.left`（gutter）与标签 chip（`data-tag-id`）**永远不参与读数**。
 * ⚠️ 这条不变量是整套锚点能活下来的前提：读数与渲染对不上，区间锚点就会当场错位。
 */
import { ATOM_PLACEHOLDER } from '../core/index.ts'

/**
 * 这个元素是不是**标签 chip**（`view/block-dom.ts` 的 `makeTagChipEl`）。
 *
 * 标签是块级归属，chip 只是把归属显示出来 —— 它不属于正文，所以：
 *   · 读数跳过它（否则每打一个标签，正文就凭空多出 `#名字` 几个字）；
 *   · 偏移计算跳过它（否则光标位置与模型偏移整体错位）；
 *   · 落光标跳过它（否则会落进一个 `contenteditable=false` 的子树里，一打字就丢）。
 * 三条必须一起做：任何一条漏掉，另外两条都会得到「看起来对、偶尔差一格」的结果。
 */
export function isTagChip(n: Node): boolean {
  return n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).dataset.tagId !== undefined
}

/** DOM 子树长度：文本节点＝字符数，原子元素＝1，标签 chip＝0，其余递归 */
export function nodeLen(n: Node): number {
  if (n.nodeType === Node.TEXT_NODE) return (n.textContent ?? '').length
  if (n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).dataset.atomId) return 1
  if (isTagChip(n)) return 0
  let sum = 0
  for (const c of Array.from(n.childNodes)) sum += nodeLen(c)
  return sum
}

/** 某个 DOM 位置（node + offset）在 `.tx` 里等于第几个字符 */
export function offsetIn(root: HTMLElement, node: Node, off: number): number {
  let count = 0
  const walk = (n: Node): boolean => {
    if (n === node) {
      if (n.nodeType === Node.TEXT_NODE) {
        count += off
        return true
      }
      for (let i = 0; i < off; i++) count += nodeLen(n.childNodes[i]!)
      return true
    }
    if (n.nodeType === Node.TEXT_NODE) {
      count += (n.textContent ?? '').length
      return false
    }
    if (n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).dataset.atomId) {
      count += 1
      return false
    }
    if (isTagChip(n)) return false
    for (const c of Array.from(n.childNodes)) if (walk(c)) return true
    return false
  }
  walk(root)
  return count
}

/** 把 `.tx` 读回模型文本（原子 → `U+FFFC`）；`.left` 里的 gutter 与标签 chip 跳过 */
export function readBlockText(tx: HTMLElement): string {
  let out = ''
  const walk = (n: Node): void => {
    if (n.nodeType === Node.TEXT_NODE) {
      out += n.textContent ?? ''
      return
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return
    const el = n as HTMLElement
    if (el.dataset.atomId) {
      out += ATOM_PLACEHOLDER
      return
    }
    if (el.classList.contains('left')) return
    if (isTagChip(el)) return
    for (const c of Array.from(el.childNodes)) walk(c)
  }
  walk(tx)
  return out
}

/**
 * 正文末尾在 `.tx` 里的**子节点下标**：第一个标签 chip 的位置（没有 chip 就是末尾）。
 *
 * 为什么需要它：模型偏移走到正文末尾时，DOM 里紧跟其后的还有 chip。
 * 直接落到 `childNodes.length` 会把光标放到 chip **之后**，下次打字就排在 chip 后面
 * —— 模型里那仍是正文末尾，显示上却跑到了标签后面。落在 chip 之前才是同一个位置。
 */
export function textEndOff(tx: HTMLElement): number {
  const children = Array.from(tx.childNodes)
  const i = children.findIndex(isTagChip)
  return i < 0 ? children.length : i
}

/** 某个 DOM 节点属于哪个块（向上找到带 `data-block-id` 的祖先）*/export function blockIdOf(node: Node | null, stopAt: HTMLElement): string | null {
  let n: Node | null = node
  while (n && n !== stopAt) {
    if (n.nodeType === Node.ELEMENT_NODE) {
      const id = (n as HTMLElement).dataset.blockId
      if (id) return id
    }
    n = n.parentNode
  }
  return null
}
