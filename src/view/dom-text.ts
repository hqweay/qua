/**
 * **DOM → 模型**：把 contenteditable 里看到的字，读回「run 序列 ＋ 偏移」。
 *
 * 这是从 `view.ts` 抽出来的纯函数层。判据：它**只依赖 DOM 与既有内容**，不持有编辑器状态，
 * 所以能单独测（这正是「状态层可脱离 DOM 断言」的反面 —— 它是「DOM 可脱离状态断言」）。
 *
 * ⚠️ 与 `block-dom.ts` 是一对：那边**模型 → DOM**，这边**DOM → 模型**。
 *   两条方向都必须认同一套契约：原子元素带 `data-atom-id`、占 **1 格**、
 *   `.left`（gutter）与标签 chip（`data-tag-id`）**永远不参与读数**。
 * ⚠️ 这条不变量是选区与光标能活下来的前提：读数与渲染对不上，偏移就会当场错位。
 */
import type { MarkType, RefRun, Run, RunWithId } from '../core/runs.ts'
import { normalizeRuns } from '../core/runs.ts'

/** 格式包装元素的 class 前缀（`mk-bold` 这类）与格式种类的对照——渲染与读回共用这一份 */
const MARK_CLASS: Record<string, MarkType> = {
  'mk-bold': 'bold',
  'mk-italic': 'italic',
  'mk-highlight': 'highlight',
  'mk-code': 'code',
}

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

/**
 * 这个元素是不是**正文里的组件体**（`ui/dock-widgets.ts` 画，`view/block-dom.ts` 挂）。
 *
 * 它占着 `.tx` 的位置（不像标签槽在 `.tx` 之外），但**不是正文**：那是组件自己
 * （一行摘要，或一段完整 UI），不是用户写的字。读数把它算进去，一次 `readRuns` 就会把
 * 「收藏 3 条 打开」写进块的 `content` —— 刷新之后那行字变成真正文，
 * 而组件体消失（`.tx` 里有了字，组件分支不再生效）⇒ 一块组件凭空变成一行普通文字。
 *
 * 与 chip 同一条判据（**无位点 ⇒ 读数为 0、光标不入**），只是它住在正文槽里，
 * 所以三处（读数／偏移／落光标）**都**要认它，不能靠「它不可编辑」来兜。
 *
 * ⚠️ 判据是**一个属性**（`data-widget-body`），不是类名：摘要与完整 UI 是两个高度档，
 *    类名不同（`.widget-row`／`.widget-body`），但「不占正文」这件事是同一件。
 */
export function isWidgetBody(n: Node): boolean {
  return n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).dataset.widgetBody !== undefined
}

/** DOM 子树长度：文本节点＝字符数，原子元素＝1，标签 chip 与组件体＝0，其余递归 */
export function nodeLen(n: Node): number {
  if (n.nodeType === Node.TEXT_NODE) return (n.textContent ?? '').length
  if (n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).dataset.atomId) return 1
  if (isTagChip(n) || isWidgetBody(n)) return 0
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
    if (isTagChip(n) || isWidgetBody(n)) return false
    for (const c of Array.from(n.childNodes)) if (walk(c)) return true
    return false
  }
  walk(root)
  return count
}

/**
 * 把 `.tx` 读回**行内内容**（run 序列）。
 *
 * - 文本节点 ⇒ 文本段，格式来自祖先上的 `mk-*` 包装元素（集合语义）；
 * - 原子元素 ⇒ 按 `data-atom-id` 从**既有内容**里原样带回（id/目标/资产不重生——
 *   DOM 上只有显示名，模型数据得从模型拿；id 对不上 ⇒ 造一枚悬空引用兜底，
 *   不静默吞掉那一格）；
 * - `.left`（gutter）与标签 chip 不参与读数（它们不在正文里）。
 *
 * 产出经归一化：相邻同形文本段合并 ⇒ 同一屏内容只有一种模型形状，
 * 「碰过但没改」能被 `sameRuns` 识别出来（不发空转的写）。
 */
export function readRuns(tx: HTMLElement, prev: readonly Run[]): Run[] {
  const segs: ({ text: string; marks: MarkType[] } | { atomId: string; label: string })[] = []
  const byId = new Map<string, RunWithId>()
  for (const r of prev) if (r.t !== 'text') byId.set(r.id, r)

  const walk = (n: Node, marks: readonly MarkType[]): void => {
    if (isTagChip(n) || isWidgetBody(n)) return
    if (n.nodeType === Node.TEXT_NODE) {
      const v = n.textContent ?? ''
      if (v !== '') segs.push({ text: v, marks: [...marks] })
      return
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return
    const el = n as HTMLElement
    if (el.classList.contains('left')) return
    if (el.dataset.atomId) {
      segs.push({ atomId: el.dataset.atomId, label: el.dataset.refLabel ?? el.textContent?.trim() ?? '' })
      return
    }
    const next = [...marks]
    for (const cls of Array.from(el.classList)) {
      const m = MARK_CLASS[cls]
      if (m && !next.includes(m)) next.push(m)
    }
    for (const c of Array.from(el.childNodes)) walk(c, next)
  }
  for (const c of Array.from(tx.childNodes)) walk(c, [])

  const out: Run[] = []
  for (const seg of segs) {
    if ('atomId' in seg) {
      const known = byId.get(seg.atomId)
      if (known) out.push(known)
      else {
        // DOM 里有这一格、模型里却没有对应 run：显示名从 DOM 取，目标留空（悬空可恢复）
        const run: RefRun = { id: seg.atomId, t: 'ref', ...(seg.label ? { label: seg.label } : {}) }
        out.push(run)
      }
      continue
    }
    if (seg.text === '') continue
    out.push(seg.marks.length === 0 ? { t: 'text', v: seg.text } : { t: 'text', v: seg.text, marks: seg.marks })
  }
  return normalizeRuns(out)
}

/**
 * 正文末尾在 `.tx` 里的**子节点下标**：第一个「不占正文的东西」的位置（没有就是末尾）。
 *
 * 为什么需要它：模型偏移走到正文末尾时，DOM 里紧跟其后的还有那些**无位点**的元素
 * （标签 chip、组件体）。直接落到 `childNodes.length` 会把光标放到它们**之后**，
 * 下次打字就排在它们后面 —— 模型里那仍是正文末尾，显示上却跑到了标签/摘要后面。
 * 落在它们之前才是同一个位置。
 *
 * ⚠️ 判据是「无位点」，不是枚举类名：将来再有第三种「住在正文槽里却不占正文」的东西，
 *    漏了它就会得到一个「看起来对、偶尔差一格」的落点（同 `nodeLen` 的口径）。
 */
export function textEndOff(tx: HTMLElement): number {
  const children = Array.from(tx.childNodes)
  const i = children.findIndex((n) => isTagChip(n) || isWidgetBody(n))
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
