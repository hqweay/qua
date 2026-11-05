/**
 * **浮层输入框的「什么时候真的过滤」判据**（纯状态，不碰 DOM）。
 *
 * 两件事只在这里定义一次：
 *   · **组合期不过滤**：输入法的中间态（拼音、候选窗）会连续触发 `input`，
 *     每一个中间态都重建一遍候选行，不只是白算，还会让列表在用户选词时闪动；
 *   · **组合结束只发一次**：`compositionend` 与随后的 `input` 常常是同一份值，
 *     不去重就会用同一个词重建两遍。
 *
 * ⚠️ 没有防抖：本地过滤是即时的，延迟只发生在「该不该问」这一层，不是「等多久」。
 */
export class QueryGate {
  private composing = false
  private last = ''

  /** 组合开始：**忽略**随后到达的 `input`（包括候选窗更新的每一次） */
  compositionStart(): void {
    this.composing = true
  }

  /** 组合结束：这一份值才算数（与随后那次同值 `input` 合并成一次） */
  compositionEnd(value: string): boolean {
    this.composing = false
    return this.accept(value)
  }

  /** 普通输入：组合期一律不接受 */
  input(value: string): boolean {
    return !this.composing && this.accept(value)
  }

  /** 同一份值只放行一次 */
  private accept(value: string): boolean {
    if (value === this.last) return false
    this.last = value
    return true
  }
}
