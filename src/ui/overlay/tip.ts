/**
 * **tooltip 原语**：元素带 `data-tip` 属性 ⇒ 悬停/键盘聚焦后浮出一条说明。
 *
 * 为什么做成**委托**而不是每元素监听：冒烟之前的 127 处说明全是原生 `title`——
 * 那是浏览器渲染的，样式与延迟都不受控，主题切换也管不到它。逐元素挂
 * mouseenter/mouseleave 的话，动态建出来的行（表格、查询结果、挂载区）每一处
 * 都要记得挂、卸载时记得摘——漏一处就是「说明冒出来不消失」。
 * 委托只需要两个 `document` 级监听：元素只需要写一行 `el.dataset.tip = t('…')`，
 * 生死随元素走，没有要清理的句柄。
 *
 * ⚠️ 内容是**纯文本**（现在所有 title 都是一句话）；`data-tip` 为空 ⇒ 不浮出。
 * ⚠️ 不与浮层系统（layers）混用：说明是被动出现的最低交互层，Esc 归菜单管。
 */
import { placeNear } from '../../view/place.ts'

/** 悬停意图延迟：太快会把「路过」读成「要看」，太慢像没反应 */
const SHOW_DELAY = 400

let layer: HTMLElement | null = null
let showTimer: number | null = null
let shownFor: Element | null = null

const tipOf = (el: Element): string => el.getAttribute('data-tip') ?? ''

function layerEl(): HTMLElement {
  if (layer) return layer
  layer = document.createElement('div')
  layer.className = 'ui-tip'
  layer.setAttribute('role', 'tooltip')
  // 说明层不接收指针：接了的话，浮层恰好盖住目标会引发 mouseout 抖动
  layer.addEventListener('pointerdown', (e) => e.preventDefault())
  document.body.appendChild(layer)
  return layer
}

function show(target: Element): void {
  const tip = tipOf(target)
  if (!tip) return
  const el = layerEl()
  el.textContent = tip
  el.style.opacity = '0'
  // 先进文档再量（量必须在已挂载之后；落位只算坐标）
  const r = target.getBoundingClientRect()
  const boxW = el.offsetWidth
  const boxH = el.offsetHeight
  const p = placeNear({
    boxW,
    boxH,
    vw: window.innerWidth,
    vh: window.innerHeight,
    anchor: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    side: 'above',
    align: 'center',
    gap: 6,
    pad: 8,
  })
  el.style.left = `${p.left}px`
  el.style.top = `${p.top}px`
  el.style.opacity = '1'
  shownFor = target
}

function hide(): void {
  if (showTimer !== null) {
    clearTimeout(showTimer)
    showTimer = null
  }
  if (layer) layer.style.opacity = '0'
  shownFor = null
}

/** 同一个目标上反复 mouseover 不重排定时器；换目标则先收旧的再排新的 */
function schedule(target: Element, delay: number): void {
  if (shownFor === target) return
  hide()
  if (!tipOf(target)) return
  if (showTimer !== null) clearTimeout(showTimer)
  showTimer = window.setTimeout(() => {
    showTimer = null
    if (tipOf(target)) show(target)
  }, delay)
}

/** 离开后指针还落在当前目标里吗（穿过子元素不算离开） */
function leaving(to: Element | null): boolean {
  const cur = shownFor
  if (!cur) return false
  return !(to instanceof Node && cur.contains(to))
}

export function installTooltips(): () => void {
  const over = (e: Event) => {
    const t = e.target instanceof Element ? e.target.closest('[data-tip]') : null
    if (t) schedule(t, SHOW_DELAY)
    else hide()
  }
  const out = (e: MouseEvent) => {
    if (leaving(e.relatedTarget instanceof Element ? e.relatedTarget : null)) hide()
  }
  const focus = (e: FocusEvent) => {
    const t = e.target instanceof Element ? e.target.closest('[data-tip]') : null
    // 键盘用户没有「路过」可言：聚焦即给，不设意图延迟
    if (t) show(t)
    else hide()
  }
  const blur = (e: FocusEvent) => {
    if (leaving(e.relatedTarget instanceof Element ? e.relatedTarget : null)) hide()
  }
  // 任何滚动（含内层滚动容器）都收掉：锚点已经移位，说明会指错地方
  const onScroll = () => hide()
  const onDown = () => hide()

  document.addEventListener('mouseover', over)
  document.addEventListener('mouseout', out)
  document.addEventListener('focusin', focus)
  document.addEventListener('focusout', blur)
  document.addEventListener('scroll', onScroll, { capture: true, passive: true })
  document.addEventListener('pointerdown', onDown, { capture: true })
  return () => {
    document.removeEventListener('mouseover', over)
    document.removeEventListener('mouseout', out)
    document.removeEventListener('focusin', focus)
    document.removeEventListener('focusout', blur)
    document.removeEventListener('scroll', onScroll, { capture: true })
    document.removeEventListener('pointerdown', onDown, { capture: true })
    hide()
  }
}
