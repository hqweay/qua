/**
 * **换体期间的滚动保护**（查询面板切栏、视图宿主换分支这类「整片换身体」的手势共用）。
 *
 * 换体的瞬间，旧身体已摘出文档、新身体才刚挂上（还是空的）——这一刻文档比滚动位矮。
 * 只要换体途中有人读几何（`getComputedStyle`／`scrollHeight` 都会强制布局），
 * 浏览器就按**中间态**把 `scrollTop` 收到新上限；等身体装满、文档长回来，
 * 滚动位已经丢了。屏幕上就是「切一下栏，整页抖一下」。
 *
 * `keepScrollWhile` 在换体前把滚动位记下来、换完写回去：新身体装得下就分毫不动；
 * 装不下（换过去的那栏本来就更矮）浏览器照常收敛——那是物理上限，不是抖动。
 */

/** 最近的可滚动祖先（真的在滚的那个）；找不到 ⇒ null（这一屏不滚，也就没有要保的位置） */
export function scrollParentOf(el: HTMLElement): HTMLElement | null {
  for (let cur = el.parentElement; cur !== null; cur = cur.parentElement) {
    const style = getComputedStyle(cur)
    if (/(auto|scroll)/.test(style.overflowY) && cur.scrollHeight > cur.clientHeight) return cur
  }
  return null
}

/**
 * 在 `run` 换体期间保住滚动位。
 *
 * 滚动祖先按**换体前**的文档找（体还在，才量得出「谁在滚」）；换体后的写回
 * 交给浏览器按新内容收敛。`run` 内部的**有意滚动**（reveal 到落点行）会被这里
 * 盖掉——带落点的装载不要走这个包装，让落点说了算。
 */
export function keepScrollWhile(anchor: HTMLElement, run: () => void): void {
  const scroller = scrollParentOf(anchor)
  if (!scroller) {
    run()
    return
  }
  const top = scroller.scrollTop
  run()
  scroller.scrollTop = top
}
