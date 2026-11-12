/**
 * 备注标记的 hover 提示（**只读**）：路标上把字写出来。
 *
 * 判定复用与画层**同一份区间**（编辑器的 `annoSpans` 缓存，`paintAnnoMarks` 同帧刷新），
 * 机制与挂载区的提及命中提示同型（T262 那套）：rAF 节流、停留才浮、锚在命中字
 * 的矩形上**不跟指针跑**（跟着跑的目标永远追不上）。
 *
 * 与 data-tip 层的关系：那个只认元素上的 `data-tip` 属性，而标记是 Custom Highlight
 * 画的、**没有元素** ⇒ 这里直接借用 `.ui-tip` 的样式类自管一枚元素（opacity 开关）。
 * 该样式自带 `pointer-events: none` —— 正是只读提示要的：提示不接指针，
 * 也就不需要「挪上提示的宽限」那一套。
 *
 * ⚠️ 与挂载区的 hover 链是**同型第二份**（宿主不同：正文标记 vs 派生行命中）；
 *    抽共享 helper 挂起——等第三个消费者出现再抽，现在抽是把猜测固化成接口。
 */
import { offsetAtPoint, rangeAtSpan, spanAt, type PlainSpan } from './hit-paint.ts'
import { placeNear } from '../place.ts'

/** 一枚命中：区间 ＋ 它是哪枚 anno（反查备注身份用） */
export interface AnnoHitSpan extends PlainSpan {
  annoId: string
}

export interface AnnoHoverDeps {
  container: HTMLElement
  /** 活跃备注区间（与画层同源；调用方在画标记时缓存） */
  spans: () => ReadonlyMap<string, readonly AnnoHitSpan[]>
  /** 组合期等「此刻不该浮」的守卫；true ⇒ 立即收 */
  quiet: () => boolean
  /** 区间的 tip 文本；空串 ⇒ 不浮 */
  textOf: (blockId: string, annoId: string) => string
  /**
   * hover 命中变化（进/出一段被备注的字）：调用方据此画 hot 态（底色加深）。
   * `null` ＝ 离开；离开/收起/销毁都保证补发一次 null。
   */
  onHot: (hit: { blockId: string; annoId: string } | null) => void
}

const SHOW_DELAY = 150
/** 指针离开后的宽限：容许在命中段内小幅挪动不闪 */
const HIDE_GRACE = 240
/** 提示文本的上限：它是路标不是正文，长的去备注栏看 */
const MAX_TIP_CHARS = 300

export class AnnoHover {
  private readonly deps: AnnoHoverDeps
  private hoverPoint: { x: number; y: number } | null = null
  private hoverFrame = 0
  private tipEl: HTMLElement | null = null
  private tipShowTimer = 0
  private tipHideTimer = 0
  private readonly offEvents: () => void

  constructor(deps: AnnoHoverDeps) {
    this.deps = deps
    const c = deps.container
    c.addEventListener('mousemove', this.onMove)
    c.addEventListener('mouseleave', this.onLeave)
    document.addEventListener('scroll', this.onScroll, { capture: true })
    document.addEventListener('pointerdown', this.onDown)
    this.offEvents = () => {
      c.removeEventListener('mousemove', this.onMove)
      c.removeEventListener('mouseleave', this.onLeave)
      document.removeEventListener('scroll', this.onScroll, { capture: true })
      document.removeEventListener('pointerdown', this.onDown)
    }
  }

  /** 挂载区换了宿主／编辑器销毁：监听与元素一起收（挂载区每段一台编辑器） */
  dispose(): void {
    this.offEvents()
    if (this.hoverFrame) cancelAnimationFrame(this.hoverFrame)
    this.clearTimers()
    this.tipEl?.remove()
    this.tipEl = null
    this.setHot(null)
  }

  private readonly onMove = (e: MouseEvent): void => {
    this.hoverPoint = { x: e.clientX, y: e.clientY }
    if (this.hoverFrame) return
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = 0
      this.pickHover()
    })
  }

  private readonly onLeave = (): void => {
    this.hoverPoint = null
    this.scheduleHide()
  }

  private readonly onScroll = (): void => {
    this.hide()
  }

  private readonly onDown = (): void => {
    this.hide()
  }

  private pickHover(): void {
    const p = this.hoverPoint
    if (!p) return
    if (this.deps.quiet()) {
      this.hide()
      return
    }
    const el = document.elementFromPoint(p.x, p.y)
    const blk = el?.closest<HTMLElement>('.blk')
    const blockId = blk?.dataset?.['blockId']
    if (!blk || !blockId || !this.deps.container.contains(blk)) {
      this.scheduleHide()
      return
    }
    const tx = blk.querySelector<HTMLElement>(':scope > .tx')
    if (!tx) {
      this.scheduleHide()
      return
    }
    const offset = offsetAtPoint(tx, p.x, p.y)
    const span = offset === null ? null : spanAt(this.deps.spans().get(blockId) ?? [], offset)
    if (!span) {
      this.scheduleHide()
      return
    }
    /**
     * `caretRangeFromPoint` 会把行的空白处「贴」到最近的字符上——只靠 offset 判定的话，
     * 命中字右边那一大片空白都会弹出提示。再要求指针真的压在这一处的某个矩形里
     * （±2px 容差：字的边缘本来就有半像素误差）。
     */
    const rects = rangeAtSpan(tx, span)?.getClientRects() ?? []
    const rect = Array.from(rects).find(
      (r) => p.x >= r.left - 2 && p.x <= r.right + 2 && p.y >= r.top - 2 && p.y <= r.bottom + 2,
    )
    if (!rect) {
      this.scheduleHide()
      return
    }
    this.setHot({ blockId, annoId: span.annoId })
    this.scheduleShow(blockId, span, rect)
  }

  /** hover 命中态：hot 回报＋手型光标（标记是画层没有元素，cursor 只能动态切容器） */
  private setHot(hit: { blockId: string; annoId: string } | null): void {
    this.deps.container.style.cursor = hit ? 'pointer' : ''
    this.deps.onHot(hit)
  }

  /** 同一处：已在显示就只挪位置；换了一处：已显示的直接换，没显示的等停留 */
  private scheduleShow(blockId: string, span: AnnoHitSpan, anchor: DOMRect): void {
    this.cancelHide()
    const at = this.tipAt
    if (
      this.tipEl &&
      at &&
      at.blockId === blockId &&
      at.annoId === span.annoId &&
      at.start === span.start &&
      at.end === span.end
    ) {
      this.place(anchor)
      return
    }
    if (this.tipEl) {
      this.show(blockId, span, anchor)
      return
    }
    if (this.tipShowTimer) return
    this.tipShowTimer = window.setTimeout(() => {
      this.tipShowTimer = 0
      this.show(blockId, span, anchor)
    }, SHOW_DELAY)
  }

  private show(blockId: string, span: AnnoHitSpan, anchor: DOMRect): void {
    this.cancelHide()
    this.tipAt = { blockId, annoId: span.annoId, start: span.start, end: span.end }
    const raw = this.deps.textOf(blockId, span.annoId)
    if (raw === '') {
      this.hide()
      return
    }
    let tip = this.tipEl
    if (!tip) {
      tip = document.createElement('div')
      tip.className = 'ui-tip'
      document.body.appendChild(tip)
      this.tipEl = tip
    }
    tip.textContent = raw.length > MAX_TIP_CHARS ? `${raw.slice(0, MAX_TIP_CHARS)}…` : raw
    this.place(anchor)
    tip.style.opacity = '1'
  }

  private place(anchor: DOMRect): void {
    const tip = this.tipEl
    if (!tip) return
    const at = placeNear({
      boxW: tip.offsetWidth,
      boxH: tip.offsetHeight,
      vw: window.innerWidth,
      vh: window.innerHeight,
      anchor: { left: anchor.left, top: anchor.top, right: anchor.right, bottom: anchor.bottom },
      side: 'above',
      align: 'left',
      gap: 6,
      pad: 8,
    })
    tip.style.left = `${at.left}px`
    tip.style.top = `${at.top}px`
  }

  private scheduleHide(): void {
    this.cancelHide()
    this.tipHideTimer = window.setTimeout(() => {
      this.tipHideTimer = 0
      this.hide()
    }, HIDE_GRACE)
  }

  private cancelHide(): void {
    if (this.tipHideTimer) {
      window.clearTimeout(this.tipHideTimer)
      this.tipHideTimer = 0
    }
  }

  private clearTimers(): void {
    if (this.tipShowTimer) {
      window.clearTimeout(this.tipShowTimer)
      this.tipShowTimer = 0
    }
    this.cancelHide()
  }

  private hide(): void {
    this.clearTimers()
    this.tipAt = null
    this.tipEl?.remove()
    this.tipEl = null
    this.setHot(null)
  }

  private tipAt: { blockId: string; annoId: string; start: number; end: number } | null = null
}
