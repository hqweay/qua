/**
 * **Surface 运行时**：把五维装配成一个能活的浮面。
 *
 * 它刻意**不拥有内容**：`spec.content` 只是借来 append 一下，退场时原样摘下还给调用方。
 * 于是撤销栈、选区、IME 这些住在内容里的状态与浮面生命周期完全无关；同一块内容
 * 从 hover 浮层搬到底部栏，只是一次 re-parent。
 *
 * 三条口径：
 *   · 位置每次 `reflow` 重新求解，永远是派生值。拖动只往约束集加一条 `at`，
 *     所以滚动 / resize 不会把它拽回锚点；锚点消失也不是特判 —— `solve` 返回
 *     `null` ⇒ 约束集空了 ⇒ 退场。
 *   · 存活只看持有者集合；`pointer / focus / gesture / pin / anchor` 任一在就活。
 *     拖动自动拿 `gesture`（拖过边界不会把自己关掉），`focusout` 自动还回去。
 *   · 焦点归一个全局交互面栈，键盘去栈顶；外壳挂 `document.body`，
 *     因此不进 `#editor` 的 `focusin` 冒泡链，不会把活动编辑器抢回正文。
 *
 * ⚠️ 每帧只写元素自己的 `transform`，不碰 `left/top`（那是**一次**落位），
 *    更不写公共祖先的 CSS 变量 —— 继承会给整棵子树招来重算。
 */
import { t } from '../../core/infra/msg.ts'
import { HolderSet } from './holders.ts'
import { solve } from './solve.ts'
import type { Constraint, Rect, Surface, SurfaceSpec } from './types.ts'

/** 全局交互面栈：z 与键盘焦点都按它排 */
const stack: Surface[] = []

function bringToTop(s: Surface): void {
  const i = stack.indexOf(s)
  if (i >= 0) stack.splice(i, 1)
  stack.push(s)
  for (const [n, item] of stack.entries()) item.el.style.zIndex = String(1000 + n)
}

function viewportRect(): Rect {
  return { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }
}

export function createSurface(spec: SurfaceSpec): Surface {
  const holders = new HolderSet()
  const el = document.createElement('div')
  el.className = 'surface'
  el.setAttribute('role', 'dialog')
  // 外观只有一个数轴：0 一瞬 / 1 一次交互 / 2 常驻（归入纸）
  el.dataset.elevation = String(Math.max(0, Math.min(2, Math.round(spec.elevation ?? 1))))

  const head = document.createElement('div')
  head.className = 'surface-head'
  if (spec.draggable) head.classList.add('is-draggable')

  const grip = document.createElement('span')
  grip.className = 'surface-grip'
  grip.setAttribute('aria-label', t('ui.surface.grip'))
  const title = document.createElement('span')
  title.className = 'surface-title'
  title.textContent = spec.title ?? ''
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'surface-close no-drag'
  close.setAttribute('aria-label', t('ui.surface.close'))
  close.textContent = '\u00d7'
  head.append(grip, title, close)

  const body = document.createElement('div')
  body.className = 'surface-body'
  body.appendChild(spec.content)
  el.append(head, body)
  if (spec.foot) {
    const foot = document.createElement('div')
    foot.className = 'surface-foot'
    foot.textContent = spec.foot
    el.appendChild(foot)
  }
  document.body.appendChild(el)

  let placed: Rect | null = null
  let userAt: { x: number; y: number } | null = null
  let dragging = false
  let dismissed = false

  const constraints = (): readonly Constraint[] => {
    const base = spec.constraints()
    if (!userAt) return base
    // 本次拖动覆盖装配层记住的旧落点：同一个优先级只该有一条，否则 find 会取到旧的
    return [...base.filter((c) => c.kind !== 'at'), { kind: 'at', x: userAt.x, y: userAt.y }]
  }

  const reflow = (): void => {
    if (dismissed || dragging) return
    const r = solve({
      size: { w: el.offsetWidth, h: el.offsetHeight },
      bounds: spec.bounds?.() ?? viewportRect(),
      constraints: constraints(),
    })
    if (!r) {
      dismiss()
      return
    }
    placed = r
    el.style.left = `${r.x}px`
    el.style.top = `${r.y}px`
  }

  function dismiss(): void {
    if (dismissed) return
    dismissed = true
    spec.content.remove()
    el.remove()
    document.removeEventListener('keydown', onKey, true)
    document.removeEventListener('pointerdown', onDocDown, true)
    window.removeEventListener('resize', reflow)
    window.removeEventListener('scroll', reflow, true)
    const i = stack.indexOf(surface)
    if (i >= 0) stack.splice(i, 1)
    spec.onDismiss?.()
    holders.clear()
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    dismiss()
  }
  const onDocDown = (e: PointerEvent): void => {
    if (el.contains(e.target as Node)) return
    dismiss()
  }

  holders.onChange(() => {
    if (!holders.alive) dismiss()
  })

  if (spec.focus !== 'none') {
    el.addEventListener('focusin', () => {
      holders.set('focus', 'focus')
      bringToTop(surface)
    })
    el.addEventListener('focusout', (e) => {
      if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return
      holders.release('focus')
    })
  }
  close.addEventListener('click', () => holders.clear())

  /** 拖动：抬头把手限定，pointer capture 保证移出抬头也收得到 move */
  if (spec.draggable) {
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target instanceof HTMLElement && e.target.classList.contains('no-drag'))) return
      dragging = true
      const startX = e.clientX
      const startY = e.clientY
      let dx = 0
      let dy = 0
      const releaseGesture = holders.acquire('drag', 'gesture')
      head.setPointerCapture(e.pointerId)
      const onMove = (ev: PointerEvent): void => {
        dx = ev.clientX - startX
        dy = ev.clientY - startY
        el.style.transform = `translate(${dx}px, ${dy}px)`
      }
      const onUp = (): void => {
        head.removeEventListener('pointermove', onMove)
        head.removeEventListener('pointerup', onUp)
        head.removeEventListener('pointercancel', onUp)
        dragging = false
        const base = placed ?? { x: 0, y: 0, w: 0, h: 0 }
        userAt = { x: base.x + dx, y: base.y + dy }
        el.style.transform = ''
        reflow()
        spec.onMoved?.(userAt.x, userAt.y)
        // 用户显式摆过位置 ⇒ 产生一个持续的意图：别随指针移开就收。
        // 这就是「pin」的最小形态 —— 不是新功能，只是集合里多一枚 token。
        holders.set('dragged', 'pin')
        releaseGesture()
      }
      head.addEventListener('pointermove', onMove)
      head.addEventListener('pointerup', onUp)
      head.addEventListener('pointercancel', onUp)
      e.preventDefault()
    })
  }

  const surface: Surface = {
    el,
    holders,
    moveTo(x: number, y: number): void {
      userAt = { x, y }
      reflow()
      spec.onMoved?.(x, y)
    },
    reflow,
    dismiss,
  }

  document.addEventListener('keydown', onKey, true)
  document.addEventListener('pointerdown', onDocDown, true)
  window.addEventListener('resize', reflow)
  window.addEventListener('scroll', reflow, true)
  bringToTop(surface)
  reflow()
  return surface
}
