/**
 * **实测行高表**：虚拟化占位的「量到过就用实测」那一格。
 *
 * 为什么它要独立成一层（而不是塞在 `RenderOps` 里）：它的行为全是**纯判据**
 * （存、查、按宽度作废、单格作废），没有 DOM 也没有编辑器状态——而它恰好是
 * 「占位准不准」这件事的全部逻辑，值得被单测直接钉住，不用起浏览器。
 *
 * 为什么需要它：`visibleRowHeight` 是纯估（`LINE_H` ＋ 头 ＋ 属性行数），而正文
 * `.tx` 是 `pre-wrap` 且无 clamp ⇒ 长正文折行会把这一行撑高，估高对不上。
 * 实测：一条折行块真高 107px、估 30px；46 行的文档总高虚拟化开 1709 vs 全挂载 1993。
 * 更麻烦的是**短块估高偏 2px 恰好抵掉长块亏空**，所以总量上看不出来，只在
 * 「少数长块」时局部塌陷——滚到那一段落点才偏。
 *
 * 判据：
 *   · **量到过就用实测**，没量过才退回估算（窗口外的行挂不到 DOM，估仍是主路径）；
 *   · **宽度变了整表作废**——折行数随可用宽度变，同一块在 1440 与 800 宽下高度不同；
 *   · **单行重画只删那一格**——改长改短都只影响那一行。
 */
export class HeightCache {
  private table = new Map<string, number>()

  /** 记账时的内容区宽度（判据用；undefined ＝ 表是空的或无条件作废过） */
  private at: number | undefined

  get size(): number {
    return this.table.size
  }

  has(id: string): boolean {
    return this.table.has(id)
  }

  /**
   * 记一条实测高。
   *
   * ⚠️ **0 高不记账**：折叠子树的 `display:none` 量出来是 0，记进去会把那一段的
   *    占位直接压成零高——表现是「文档中间凭空少一段」。
   */
  set(id: string, height: number): void {
    if (height > 0) this.table.set(id, height)
  }

  /** 这一行占多高：量到过用实测，否则问 `estimate`（调用方给当前的估算） */
  heightOf(id: string, estimate: () => number): number {
    const measured = this.table.get(id)
    return measured !== undefined ? measured : estimate()
  }

  /**
   * 作废。
   *
   * 传宽度 ⇒ **只在宽度真的变了时清**（竖直方向的变化不改变任何一行的折行，
   * 清表会让整份文档的占位白抖一下）。
   * 不传 ⇒ **无条件清**（换虚拟化档、换装载单位：前提已变，不赌宽度）。
   */
  invalidate(width?: number): void {
    if (width !== undefined) {
      if (this.at === width) return
      this.at = width
    } else {
      this.at = undefined
    }
    this.table.clear()
  }

  /** 这一行的高度不再可信（DOM 被换掉）：只删这一格，不动其余 */
  forget(id: string): void {
    this.table.delete(id)
  }

  /** 还没量过的行 id（离屏批量测量按它排活） */
  pending(ids: readonly string[]): string[] {
    return ids.filter((id) => !this.table.has(id))
  }
}
