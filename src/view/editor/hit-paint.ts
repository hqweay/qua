/**
 * **命中区间 → CSS Custom Highlight**：块正文里的临时高亮只有一个落点。
 *
 * 为什么是「区间」而不是「命中词」：调用方（提及栏）已经从模型算出了
 * **plain 偏移**（`core/relations/mention.ts` 的 `mentionSpotsOf`），同一份偏移
 * 既能画高亮、也能在之后切成引用 run。按词再搜一遍等于第二份判据——两处一旦
 * 对「第几处命中」的口径不同（大小写、原子占格），画出来的和能转的就不是同一处。
 *
 * 为什么用 `CSS.highlights` 而不是往 `.tx` 里插 `<mark>`：编辑器按 DOM 读回模型
 * （`readRuns`），插标记会被当成内容；而且换标记会挪光标、打断输入法预编辑串。
 * Custom Highlight 是纯渲染层的一层画笔。
 *
 * ⚠️ **Range 不缓存**：编辑器的块行在重画时是**整行替换**的
 * （`editor.ts` 的 `renderBlock` 用 `el.replaceWith`），任何跨帧留存的 Range 都会
 * 指向已经被摘掉的节点——它不报错，只是高亮悄悄消失。所以每次画都从当前 DOM
 * 现找文本节点；调用方在装载后与 DOM 变化后各调一次（见挂载区的 `MutationObserver`）。
 */

import { offsetIn } from './dom-text.ts'

/** 一个块正文里的命中区间：plain 偏移（文本段按字符数，原子占 1 格） */
export interface PlainSpan {
  start: number
  end: number
}

interface Segment {
  node: Text
  /** 这一段第一个字符的 plain 偏移 */
  start: number
}

/** 补一条「派生 key」的样式（基名与 `-2`、`-3` 观感相同，不做第二套） */
const styledKeys = new Set<string>()
function ensureStyle(key: string, bgVar = '--ui-hit-bg'): void {
  if (styledKeys.has(key)) return
  styledKeys.add(key)
  const style = document.createElement('style')
  style.dataset.highlightKey = key
  /**
   * 命中底色与搜索命中（`styles/center.css` 的 `search-match`）取**同一个 token**：
   * 两个入口画的是同一件事，各定一档就会「同一处命中在两处深浅不同」。
   * 常显类标记（备注区间）传自己的 token——它不是「刚命中」的瞬间事件，淡一档。
   */
  style.textContent = `::highlight(${key}) { background-color: var(${bgVar}); color: inherit; }`
  document.head.appendChild(style)
}

/**
 * 按 plain 偏移把 `.tx` 的文本节点切成段：文本段按长度计，**原子整枚算 1 格**
 * （与 `mentionSpotsOf` 的坐标口径一致）。`.mk` 只是格式包装，不增减字符。
 */
function segmentsOf(tx: HTMLElement): Segment[] {
  const out: Segment[] = []
  let off = 0
  for (const child of tx.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      const node = child as Text
      out.push({ node, start: off })
      off += node.data.length
      continue
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue
    const el = child as HTMLElement
    if (el.classList.contains('atom')) {
      // 原子（引用／标签／图）占 1 格，里面那串 label 字不是正文
      off += 1
      continue
    }
    const node = firstTextNode(el)
    if (!node) continue
    out.push({ node, start: off })
    off += node.data.length
  }
  return out
}

/** `.mk` 可能嵌套好几层（多个 mark）；正文那一段文字只有一个文本节点 */
function firstTextNode(el: HTMLElement): Text | null {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  return walker.nextNode() as Text | null
}

/** plain 偏移 → DOM 点。落在两段之间时归**后一段**（那里才是下一个字符）。 */
function pointAt(segments: readonly Segment[], off: number): { node: Text; offset: number } | null {
  if (segments.length === 0) return null
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!
    const len = seg.node.data.length
    if (off >= seg.start && off < seg.start + len) return { node: seg.node, offset: off - seg.start }
    if (off === seg.start + len) {
      const next = segments[i + 1]
      return next ? { node: next.node, offset: 0 } : { node: seg.node, offset: len }
    }
  }
  const last = segments[segments.length - 1]!
  return { node: last.node, offset: last.node.data.length }
}

/**
 * 一次扫出**这一屏所有**行的 `.tx`，按块 id 收好。
 *
 * 逐块 `querySelector` 是 O(命中数 × 全 DOM)：一处命中也要走一整遍子树，
 * 而错过一次重画就补画一次。一次 `querySelectorAll` 换来的是一趟遍历。
 */
function txById(host: HTMLElement): Map<string, HTMLElement> {
  const out = new Map<string, HTMLElement>()
  for (const tx of host.querySelectorAll<HTMLElement>('.blk[data-block-id] > .tx')) {
    const id = tx.parentElement?.dataset?.['blockId']
    // 同一个块在这一屏只认第一行：镜像/多处露面时后一份是同一段文字的第二次投影
    if (id && !out.has(id)) out.set(id, tx)
  }
  return out
}

/**
 * **命中区间 → DOM Range**（画高亮与 hover 定位共用）。
 *
 * 为什么抽出来：`::highlight` 只是画层，没有可命中的元素 —— 想知道「鼠标现在压在
 * 哪一处命中上」，只能拿同一份区间反算出 Range，再问它的矩形。若在这里另写一份
 * 偏移换算，画亮的那一处与能点的那一处迟早不是同一个位置。
 */
export function rangeAtSpan(tx: HTMLElement, span: PlainSpan): Range | null {
  const segments = segmentsOf(tx)
  const from = pointAt(segments, span.start)
  const to = pointAt(segments, span.end)
  if (!from || !to) return null
  const r = document.createRange()
  r.setStart(from.node, from.offset)
  r.setEnd(to.node, to.offset)
  return r
}

/**
 * 把一组块的命中区间画成一条高亮。
 *
 * 一条 key **只 set 一次**：`CSS.highlights` 是按 key 整条替换的，逐块 set 会让
 * 后面的块把前面的覆盖掉。
 *
 * 没有命中、或块不在这一屏（大纲只画顶层，子块没有行）⇒ 静默跳过；`CSS.highlights`
 * 不支持时同样跳过（降级是「少一样装饰」，不是报错）。
 *
 * **返回这一屏画出的 Range**：调用方还要把它们之一滚进视口（「滚到第一处命中」）。
 * 自己另建一份 Range 等于把「命中在哪」算第二遍——两处一旦口径不同，
 * 画亮的那一处和滚到的那一处就不是同一个位置。
 */
export function paintHits(
  host: HTMLElement,
  blocks: ReadonlyMap<string, readonly PlainSpan[]>,
  key: string,
  bgVar = '--ui-hit-bg',
): Range[] {
  const ranges: Range[] = []
  const screen = txById(host)
  for (const [blockId, spans] of blocks) {
    const tx = screen.get(blockId)
    if (!tx || spans.length === 0) continue
    for (const span of spans) {
      const r = rangeAtSpan(tx, span)
      if (r) ranges.push(r)
    }
  }
  if (ranges.length === 0) {
    clearHits(key)
    return ranges
  }
  if (typeof CSS === 'undefined' || !CSS.highlights) return ranges
  ensureStyle(key, bgVar)
  CSS.highlights.set(key, new Highlight(...ranges))
  return ranges
}

/** 摘掉这条 key 的高亮（切走这一栏／拆掉宿主都要走这里） */
export function clearHits(key: string): void {
  if (typeof CSS !== 'undefined' && CSS.highlights) CSS.highlights.delete(key)
}

/**
 * 落点在哪一处命中上（**半开区间**：区间末尾那一格不算，那里是下一个字符）。
 *
 * ⌥ 单击与块菜单的 `when` 都读这一条 —— 两份判据的下场是
 * 「高亮上有、点了却能点空」。
 */
export function spanAt<T extends PlainSpan>(spans: readonly T[], offset: number): T | null {
  for (const s of spans) if (offset >= s.start && offset < s.end) return s
  return null
}

/**
 * **鼠标位置 → plain 偏移**（读回的逆向：`offsetIn` 是那套坐标的唯一一份实现）。
 *
 * 为什么不用 `::highlight` 去命中：Custom Highlight 只是画层，没有可打的元素，
 * 也就没有 `elementFromPoint` 可问 —— 只能反过来从坐标问浏览器「那里是哪个字」。
 */
export function offsetAtPoint(tx: HTMLElement, x: number, y: number): number | null {
  const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
  const range = doc.caretRangeFromPoint?.(x, y) ?? null
  if (!range || !tx.contains(range.startContainer)) return null
  return offsetIn(tx, range.startContainer, range.startOffset)
}
