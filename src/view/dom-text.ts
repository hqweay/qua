/**
 * **DOM → 模型**：把 contenteditable 里看到的字，读回「文本 ＋ 偏移」。
 *
 * 这是从 `view.ts` 抽出来的纯函数层。判据：它**只依赖 DOM 与块 id**，不持有编辑器状态，
 * 所以能单独测（这正是「状态层可脱离 DOM 断言」的反面 —— 它是「DOM 可脱离状态断言」）。
 *
 * ⚠️ 与 `block-dom.ts` 是一对：那边**模型 → DOM**，这边**DOM → 模型**。
 *   两条方向都必须认同一套契约：原子元素带 `data-atomId`、占 **1 格**（`U+FFFC`）、
 *   `.left`（gutter）**永远不参与读数**。
 * ⚠️ 这条不变量是整套锚点能活下来的前提：读数与渲染对不上，区间锚点就会当场错位。
 */
import { ATOM_PLACEHOLDER } from '../core/index.ts'

/** DOM 子树长度：文本节点＝字符数，原子元素＝1，其余递归 */
export function nodeLen(n: Node): number {
  if (n.nodeType === Node.TEXT_NODE) return (n.textContent ?? '').length
  if (n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).dataset.atomId) return 1
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
    for (const c of Array.from(n.childNodes)) if (walk(c)) return true
    return false
  }
  walk(root)
  return count
}

/** 把 `.tx` 读回模型文本（原子 → `U+FFFC`）；`.left` 里的 gutter 跳过 */
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
    for (const c of Array.from(el.childNodes)) walk(c)
  }
  walk(tx)
  return out
}

/** 某个 DOM 节点属于哪个块（向上找到带 `data-block-id` 的祖先）*/
export function blockIdOf(node: Node | null, stopAt: HTMLElement): string | null {
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
