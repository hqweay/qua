/**
 * 预览命中高亮的**键分配**。
 *
 * 为什么需要它：`CSS.highlights` 是按 key 整条删的（`delete(key)`），没有「只删我这
 * 几段 range」。两个宿主共用一条 key ⇒ 后关的那一面会把前一面还开着的高亮一起清掉，
 * 而且不报错。tab 与 ⌘P 浮层已经各有一条（`faceChrome` 给基名），但那只覆盖「两种
 * 形态各一个」——再加第三个预览宿主时，手编第三条 key 就会漏。
 *
 * 口径：基名第一次分配原样返回（既有的 `search-match` / `search-match-overlay`
 * 这两条名字不动），之后同名再要就派生 `-2`、`-3`……由宿主在拆掉时归还。
 * 纯数据、零依赖：单测可直接 import。
 */

const inUse = new Set<string>()

/** 领一条本次会话唯一的高亮 key（同一基名可领多条） */
export function claimHighlightKey(base: string): string {
  if (!inUse.has(base)) {
    inUse.add(base)
    return base
  }
  let n = 2
  while (inUse.has(`${base}-${n}`)) n++
  const key = `${base}-${n}`
  inUse.add(key)
  return key
}

/** 归还（宿主拆掉时调；不归还的话下一次会一直派生新名字） */
export function releaseHighlightKey(key: string): void {
  inUse.delete(key)
}
