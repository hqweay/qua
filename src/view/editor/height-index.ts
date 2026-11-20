/**
 * **行高前缀索引**：给虚拟化窗口的「头/尾占位有多高」「滚动位置落在第几行」两个问题
 * 提供 O(log N) 的答案，而不是每次换窗把全量行累加一遍。
 *
 * 为什么需要它：可见行数 N 可能到十万级，而一次滚动只关心窗口附近那几十行。
 * 旧写法（`rows.slice(0, from).reduce(...)` ＋ 反向再减一遍）每次换窗都是 O(N)，
 * 于是「虚拟化只省了 DOM，没省行投影」。行高有增有改（窗口内的行会被实测回填），
 * 所以用 Fenwick（树状数组）：点更新 O(log N)，前缀和 O(log N)。
 *
 * 口径：`heights[i]` 是第 i 行的**当前最佳高度**（实测优先，否则估算）。
 * 索引本身不判断「该用哪个高度」——那是渲染层的 `rowHeight`；这里只负责记账与查询。
 */
export class RowHeightIndex {
  private values: number[] = []
  private tree: number[] = []

  constructor(heights: readonly number[] = []) {
    this.reset(heights)
  }

  get count(): number {
    return this.values.length
  }

  /** 全量高度和（尾占位 = total − prefix(to)） */
  get total(): number {
    let s = 0
    for (let i = this.tree.length - 1; i > 0; i -= i & -i) s += this.tree[i]!
    return s
  }

  /** 换一批行高（O(N)；只在行集合/估算前提变化时调，不在滚动路径上） */
  reset(heights: readonly number[]): void {
    this.values = heights.map((h) => (Number.isFinite(h) && h > 0 ? h : 0))
    const n = this.values.length
    const tree = new Array<number>(n + 1).fill(0)
    for (let i = 0; i < n; i++) tree[i + 1] = this.values[i]!
    // 线性建树：把每个节点并进它的父节点
    for (let i = 1; i <= n; i++) {
      const j = i + (i & -i)
      if (j <= n) tree[j]! += tree[i]!
    }
    this.tree = tree
  }

  /** 第 i 行的当前高度（越界给 0） */
  get(i: number): number {
    return this.values[i] ?? 0
  }

  /** 前 `count` 行的高度和（`count = 0` ⇒ 0；`count = N` ⇒ total） */
  prefix(count: number): number {
    const n = this.values.length
    let i = Math.max(0, Math.min(n, Math.trunc(count)))
    let s = 0
    while (i > 0) {
      s += this.tree[i]!
      i -= i & -i
    }
    return s
  }

  /** 点更新（窗口内实测到真实高度后回填）；越界或非有限值忽略 */
  set(i: number, height: number): void {
    if (!Number.isInteger(i) || i < 0 || i >= this.values.length) return
    if (!Number.isFinite(height) || height <= 0) return
    const delta = height - this.values[i]!
    if (delta === 0) return
    this.values[i] = height
    for (let j = i + 1; j < this.tree.length; j += j & -j) this.tree[j]! += delta
  }

  /**
   * **高度坐标 `offset` 落在第几行**（0-based）。
   *
   * 口径：[0, h0) ⇒ 0，[h0, h0+h1) ⇒ 1；`offset` 超出总高 ⇒ 最后一行。
   * 调用方用它把「视口顶部离文档顶多远」直接换成行下标，不再从上往下累加。
   */
  find(offset: number): number {
    const n = this.values.length
    if (n === 0) return 0
    if (!Number.isFinite(offset) || offset <= 0) return 0
    let pos = 0
    let rem = offset
    let bit = 1
    while (bit << 1 <= n) bit <<= 1
    for (; bit > 0; bit >>= 1) {
      const next = pos + bit
      if (next <= n && this.tree[next]! <= rem) {
        pos = next
        rem -= this.tree[next]!
      }
    }
    // pos ＝ 前缀和 ≤ offset 的行数 ⇒ 命中的行就是 pos（0-based）；超出则钳到最后一行
    return Math.min(pos, n - 1)
  }
}
