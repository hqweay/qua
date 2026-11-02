/**
 * 浮层的**退场**：挂上退场类，等动画走完再摘节点。
 *
 * 为什么入场不用 JS 而退场要：入场是「新元素带上 animation」，元素在文档里，
 * 动画自己会跑；退场那一刻元素马上要被摘掉——没人等它走完，动画就没机会发生。
 * 所以退场是唯一需要写代码的那一半。
 *
 * ⚠️ 超时兜底必须有：`prefers-reduced-motion`（或样式里删掉动画）时
 *    `animationend` 永远不会来，元素会永远留在屏幕上。兜底时限要盖过
 *    样式里最长的退场动画（120ms）＋ 浏览器掉帧的余量。
 *
 * ⚠️ `pointer-events: none` 立即生效：退场中的浮层不再接收点击——
 *    它在用户的意图里已经关了，不能让「正在消失的东西」还能被点中。
 */
export function dismissFloating(el: HTMLElement, afterRemove?: () => void): void {
  el.classList.add('is-out')
  el.style.pointerEvents = 'none'
  let done = false
  const finish = (): void => {
    if (done) return
    done = true
    el.remove()
    afterRemove?.()
  }
  el.addEventListener('animationend', finish, { once: true })
  setTimeout(finish, 400)
}
