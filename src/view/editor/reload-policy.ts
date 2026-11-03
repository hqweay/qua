/**
 * **外部变化之后「要不要／什么时候换 DOM」的那一份状态机**。
 *
 * 三件事原先在各处各写一遍：外部变化来了，这次该立刻重载、先合并一会儿，还是
 * 先记一笔欠账等手头这件事做完？分开写时它们会各自漂移——一边补了「组合期」，
 * 另一边还冻着；表现为某些视图停在旧形状，且**不报错**。
 *
 * 收的只是状态机。**「此刻算不算有人在这」不在这里判**：正文只看焦点有没有落进
 * 里层的编辑岛（本容器自己的行被换掉是安全的），可编辑块列看焦点是不是落在这片
 * 区域里的任何东西上（连 tab 条一起算——重排 tab 条同样会把正被按的那颗换掉）。
 * 把两份判据并成一个「看情况」的谓词，等于把差异藏进一个 `if`，于是两边都会在
 * 某一种容器上判错。⇒ 判据由构造参数 `frozen` 给，**域归调用方**。
 *
 * `debounceMs` 也是调用方的真差异：正文要跟着别的视图立刻变；一栏多行的重查更贵，
 * 值得把连着发生的几次变化合成一次。
 */
import { DeferredFlush } from './deferred-flush.ts'

export interface ReloadPolicyOpts {
  /**
   * 此刻能不能换 DOM。**域由调用方给**，见文件头。
   *
   * 不要在这里再判「指针按着」：那一位由本策略持有（`setPointerDown`），
   * 两处各判一次会让「抬起之后补做」的时机对不上。
   */
  frozen: () => boolean
  /** 外部变化到重载的合并窗口。`0` ＝ 同步重载 */
  debounceMs: number
  /** 真正重载那一下。`ids` ＝ 这次动过的块（拿得到时；补做那一趟没有） */
  onReload: (ids?: readonly string[]) => void
  /** 冻结期间欠下的那次补做的间隔（默认 200ms） */
  flushMs?: number
}

/**
 * 欠账补做的间隔为什么是 200ms：够 `click` 派发完（`mouseup` 之后同一任务里还有它），
 * 又仍在用户眼里是「立刻」。见 `bindPressFreeze`。
 */
const DEFAULT_FLUSH_MS = 200

export class ReloadPolicy {
  /** 有一笔重载欠着：被冻结，或自己的编辑让装载内容过期了 */
  private pending = false
  /** 指针按着：按下期间不换 DOM，否则正被按的按钮会在 `mouseup` 之前被搬走 */
  private pointerDown = false
  /** 合并窗口的计时器（`debounceMs === 0` 时不用） */
  private timer: number | null = null
  private readonly flusher: DeferredFlush
  private readonly opts: ReloadPolicyOpts

  constructor(opts: ReloadPolicyOpts) {
    this.opts = opts
    this.flusher = new DeferredFlush(() => this.flush(), opts.flushMs ?? DEFAULT_FLUSH_MS)
  }

  /** 此刻能不能换 DOM：域判据 ＋ 本策略持有的指针位 */
  frozen(): boolean {
    return this.pointerDown || this.opts.frozen()
  }

  /**
   * 一个变化到达：现在重载、合并一会儿，还是先欠着。
   *
   * 冻结时**不**把 `ids` 记下来：补做那一趟要么整片重装（不需要 id），要么由调用方
   * 在调这里之前已经按 id 画过那几行（正文的冻结分支就是这么做的）。
   */
  touch(ids?: readonly string[]): void {
    if (this.frozen()) {
      this.pending = true
      this.flusher.arm()
      return
    }
    if (this.opts.debounceMs <= 0) {
      this.pending = false
      this.opts.onReload(ids)
      return
    }
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      this.timer = null
      // 排队的这段时间里可能又冻上了（按下、焦点进里层）：留成欠账，等解冻再补
      if (this.frozen()) {
        this.pending = true
        this.flusher.arm()
        return
      }
      this.pending = false
      this.opts.onReload(ids)
    }, this.opts.debounceMs)
  }

  /** 指针位。放开时若还欠着一笔，排一次补做（不能当场做：`click` 还没派发） */
  setPointerDown(down: boolean): void {
    this.pointerDown = down
    if (!down && this.pending) this.flusher.arm()
  }

  /**
   * 把补做往后推一拍（不改变欠账有无）。
   *
   * 给「焦点刚刚变过」用：那一刻很可能正按下某颗按钮，立刻补会把按钮从指针下搬走；
   * 而欠账本身由 `touch` 记着，这里只管时机。
   */
  arm(): void {
    this.flusher.arm()
  }

  /**
   * 立刻尝试补做欠账（焦点刚离开这片区域时用）。
   *
   * 为什么需要它而不只靠补做计时器：计时器是为「焦点只是在这片区域**里面**挪动、
   * 从未离开」准备的；焦点真的离开了，就不该再等那 200ms。
   */
  flush(): void {
    /**
     * 按着的时候什么也不做、也**不重排计时器**：放开会调 `setPointerDown(false)`，
     * 由它排一次。否则一次长按/拖拽期间会每 200ms 醒一次。
     */
    if (this.pointerDown) return
    if (!this.pending) return
    if (this.opts.frozen()) {
      this.flusher.arm()
      return
    }
    this.pending = false
    this.opts.onReload()
  }

  dispose(): void {
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = null
    this.flusher.dispose()
  }
}
