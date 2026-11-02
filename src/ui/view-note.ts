/**
 * 视图区的一句话（空态／缺配置提示）。
 *
 * 四个视图渲染器（画廊／看板／日历／脑图）此前各自手写同一段
 * `createElement('p') → className → textContent → append`——重复的代价不是那几行，
 * 而是「视图没内容时要说话」这个形状没有名字，新视图照着旁边写就会漏。
 * 卡侧的同族原语在 `card-parts.ts`（`cardNote`）：那边是卡里的一句话，这边是视图区的一句话。
 *
 * 类名沿用 `tv-unsupported`（从平表扩散出来的历史名）：改类名要动 CSS 与既有断言，不是这次的事。
 */
export function viewNote(text: string): HTMLElement {
  const p = document.createElement('p')
  p.className = 'tv-unsupported'
  p.textContent = text
  return p
}
