/**
 * **输入防抖**：连续输入只提交最后一次，空串与显式提交（Enter）立刻发。
 *
 * 为什么单独成一个小类而不是在组件里塞一个 `setTimeout`：
 *  - 交互层（`ui/search/search-face.ts`）的组件测试要真 DOM，而这里的规则（组合期不推进、
 *    空串不受防抖、销毁要摘定时器）是**纯状态机**，放 core 里能直接单测；
 *  - 「输入法组合期不查」这条一旦漏掉，每敲一个拼音字母都会发一次查询，
 *    而这一点在单测里比在真浏览器里容易钉住。
 *
 * ⚠️ 它只负责**什么时候发**，不负责查什么、怎么渲染：
 * `fire` 拿到的是**这一次要提交的原始输入**，空串也原样传出去（调用方据此走「最近更新」）。
 */
export class DebouncedInput {
  private timer: ReturnType<typeof setTimeout> | null = null
  /** 最近一次输入（防抖窗口结束时提交它，而不是排定时器时的那份快照） */
  private latest = ''
  private pending = false
  private composing = false
  private closed = false
  private readonly fire: (value: string) => void
  private readonly delayMs: number

  constructor(fire: (value: string) => void, delayMs: number) {
    this.fire = fire
    this.delayMs = delayMs
  }

  /** 一次输入（`input` 事件）。组合期只记值、不推进。 */
  input(value: string): void {
    if (this.closed) return
    this.latest = value
    if (this.composing) return
    // 空词立刻发：清空输入要马上回到「最近更新」，不能被防抖拖慢
    if (value.trim() === '') {
      this.cancelTimer()
      this.fire(value)
      return
    }
    this.cancelTimer()
    this.pending = true
    this.timer = setTimeout(() => {
      this.timer = null
      this.pending = false
      if (this.closed) return
      this.fire(this.latest)
    }, this.delayMs)
  }

  /** IME 组合开始：这段时间里的 `input` 都是中间态，不发。 */
  compositionStart(): void {
    this.composing = true
    this.cancelTimer()
  }

  /** IME 组合结束：合并成**一次**（浏览器随后那次 `input` 已经被组合期挡掉）。 */
  compositionEnd(value: string): void {
    this.latest = value
    this.composing = false
    if (this.closed) return
    this.cancelTimer()
    this.fire(value)
  }

  /** 立刻提交待发的那一次（Enter / 显式刷新）；没有待发的就什么都不做。 */
  flush(): void {
    if (!this.pending) return
    this.cancelTimer()
    this.fire(this.latest)
  }

  /** 外部已经按别的口径查过了：丢弃待发的这一次，避免补发一枪。 */
  cancel(): void {
    this.cancelTimer()
  }

  /** 面拆掉：定时器必须摘掉，否则回调落在已销毁的实例上。 */
  dispose(): void {
    this.closed = true
    this.cancelTimer()
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending = false
  }
}
