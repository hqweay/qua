/**
 * 「欠账补做」的短计时器。
 *
 * 同一个机制此前在编辑器与可编辑块里各写一份（清掉旧计时器 → 排 200ms →
 * 到点补做）：外部变化进来时若正处在不能换 DOM 的时刻，先记一笔欠账排上这个，
 * 补做的回调若发现仍冻结就再 `arm()` 一次往后推。
 *
 * 为什么用计时器而不是 focusout：焦点可能只是从编辑器挪到了同一区域里的
 * 按钮上，从未离开——focusout 那条路永远等不到，正文就会一直停在旧形状。
 *
 * 「此刻冻不冻结」的判据归调用方（两边冻结的域不同）；这里只管计时器本身。
 */
export class DeferredFlush {
  private timer: number | null = null
  private readonly flush: () => void
  private readonly ms: number

  constructor(flush: () => void, ms = 200) {
    this.flush = flush
    this.ms = ms
  }

  /** 排一次补做（重复调用只保留最后一次） */
  arm(): void {
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      this.timer = null
      this.flush()
    }, this.ms)
  }

  dispose(): void {
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = null
  }
}
