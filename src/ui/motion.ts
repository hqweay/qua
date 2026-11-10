/**
 * **FLIP 原语**：量旧位 → 同步换 → 量新位 → `transform` 补位移。
 *
 * 只服务「同一个东西换位置」（空间连续性）这一类动效——其它动作保持瞬时，
 * 高频键盘工具加动画＝延迟。不用 View Transitions：重名作废整次过渡、作用域
 * 不可交互；不引动画库：一条原语用不上引擎。时长与曲线只**读 token**
 * （`--ui-dur-2`／`--ui-ease-out`），不发明第二套词汇。
 *
 * ⚠️ 挂**手势落点**，不挂 `render()`／`sync()`：命令面／面板改值走的是同一份
 *    重算路径，但那只该是「瞬移」（眼睛不在拖拽上，动画读作延迟）。
 * ⚠️ `mutate` 里的 DOM 换是**同步**的（写事务 → 通知 → 重画同一条调用栈）；
 *    重画会**重建元素**，所以新旧两套矩形都按 key 对上——旧节点不留在文档里。
 */
const FLIP_ID = 'qua-flip'
/** 让位预算：卡多到全板都动会读作闪，只动被拖那张 */
const MAX_MOVERS = 40

/** 读 token 里的时长：token 写 `200ms`，引擎可能序列化成 `.2s`——两种都得认 */
function parseTime(v: string): number {
  const m = /^\s*([\d.]+)(ms|s)\s*$/.exec(v)
  if (!m) return NaN
  return m[2] === 's' ? Number(m[1]) * 1000 : Number(m[1])
}

export interface FlipOptions {
  /** 卡多过预算时**必动**的那个 key（被拖的卡自己） */
  priority?: string
}

export function flip(
  container: HTMLElement,
  selector: string,
  keyOf: (el: HTMLElement) => string,
  mutate: () => void,
  opts: FlipOptions = {},
): void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    mutate()
    return
  }
  // 旧位必须在 mutate **前**量：重画会把旧元素摘出文档，摘走之后再量全是 0
  const before = new Map<string, { x: number; y: number; w: number }>()
  for (const el of container.querySelectorAll<HTMLElement>(selector)) {
    const key = keyOf(el)
    if (key === '') continue
    const r = el.getBoundingClientRect()
    before.set(key, { x: r.left, y: r.top, w: r.width })
  }
  mutate()
  const rootStyle = getComputedStyle(document.documentElement)
  const dur = parseTime(rootStyle.getPropertyValue('--ui-dur-2'))
  const ease = rootStyle.getPropertyValue('--ui-ease-out').trim() || 'ease-out'
  if (!Number.isFinite(dur) || dur <= 0) return

  const movers: { el: HTMLElement; dx: number; dy: number }[] = []
  for (const el of container.querySelectorAll<HTMLElement>(selector)) {
    const prev = before.get(keyOf(el))
    if (!prev) continue
    const b = el.getBoundingClientRect()
    // 隐藏元素的矩形是 0：让位给它没有意义
    if (prev.w === 0 || b.width === 0) continue
    const dx = prev.x - b.left
    const dy = prev.y - b.top
    if (dx === 0 && dy === 0) continue
    movers.push({ el, dx, dy })
  }
  // 超预算只动被拖那张：全板让位在大板上是「闪了一下」
  const trimmed =
    movers.length > MAX_MOVERS && opts.priority !== undefined
      ? movers.filter((m) => keyOf(m.el) === opts.priority)
      : movers
  for (const { el, dx, dy } of trimmed) {
    const anim = el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], {
      duration: dur,
      easing: ease,
    })
    anim.id = FLIP_ID
  }
}
