/**
 * **锚定落位**：一块浮层该出现在视口的哪个坐标。
 *
 * 为什么它单独成文件、而且是个**纯函数**：菜单、信息浮层、划选气泡三处此前各自
 * 手写了一遍 `Math.min(Math.max(pad, …))`。三份实现的差别不在「想不一样」，
 * 而在「各自忘了另外两种对齐」——于是「加一种对齐」只能加到一份上，
 * 另外两处仍然只有左对齐（而且没人会发现）。
 *
 * 纯函数还带来一个别的结构给不了的东西：**它能在单测里跑**。
 * 落位是最容易「看着对、实际差 8px」的一类代码，而这类偏差在真浏览器里
 * 只能靠量，量一次就得起一整套冒烟。纯函数把「算」与「量」分开。
 *
 * ⚠️ 它只算**坐标**，不写 DOM、不读 DOM。读写留给调用方——
 *    因为「读 box 尺寸」必须发生在 box 已经进文档之后，那是调用方的时序问题。
 */

/** 一块浮层相对锚点的落位输入。尺寸由调用方量好传进来，这里不碰 DOM。 */
export interface Placement {
  /** 浮层尺寸（已量好） */
  boxW: number
  boxH: number
  /** 视口尺寸 */
  vw: number
  vh: number
  /** 锚点矩形；`null` ＝ 没有锚点（居中落位） */
  anchor: { left: number; top: number; right: number; bottom: number } | null
  /** 期望落在锚点哪一侧；那一侧放不下就**翻到另一侧** */
  side: 'below' | 'above'
  /** 水平对齐：贴锚点左边 / 居中 / 贴右边 */
  align: 'left' | 'center' | 'right'
  /** 浮层与锚点的间隙 */
  gap: number
  /** 与视口边缘的最小留白 */
  pad: number
}

export interface PlacementResult {
  left: number
  top: number
  /** 是否真的翻了面（调用方可据此换箭头方向／贴边样式） */
  flipped: boolean
  /** 竖直方向是否被视口夹住（两侧都放不下 ⇒ 只能夹） */
  clamped: boolean
}

/** 把 `v` 夹进 `[lo, hi]`；`hi < lo`（视口比浮层还小）时取 `lo`，不返回负数宽 */
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi))
}

/**
 * 算出浮层的左上角坐标。
 *
 * 三条口径（三处消费者共享，不许各自再写一份）：
 *   1. **水平**按 `align` 对齐锚点，然后夹进视口（贴边的浮层永远不越界）；
 *   2. **竖直**优先放 `side`，放不下就翻面；翻面也放不下就夹进视口；
 *   3. **没有锚点**时水平居中、竖直落在视口上部（`0.16 * vh`）——
 *      命令面板这类「不属于任何一处」的浮层都走这一档。
 */
export function placeNear(p: Placement): PlacementResult {
  const { boxW, boxH, vw, vh, anchor, side, align, gap, pad } = p

  if (!anchor) {
    return {
      left: clamp((vw - boxW) / 2, pad, vw - boxW - pad),
      top: clamp(vh * 0.16, pad, vh - boxH - pad),
      flipped: false,
      clamped: false,
    }
  }

  // ---- 水平 ----
  const rawLeft =
    align === 'left'
      ? anchor.left
      : align === 'right'
        ? anchor.right - boxW
        : anchor.left + (anchor.right - anchor.left) / 2 - boxW / 2
  const left = clamp(rawLeft, pad, vw - boxW - pad)

  // ---- 竖直：优先放 side，放不下翻面，两面都放不下就夹 ----
  const below = anchor.bottom + gap
  const above = anchor.top - boxH - gap
  const preferBelow = side === 'below'
  const primary = preferBelow ? below : above
  const secondary = preferBelow ? above : below
  const primaryFits = primary >= pad && primary + boxH <= vh - pad
  const secondaryFits = secondary >= pad && secondary + boxH <= vh - pad

  if (primaryFits) return { left, top: primary, flipped: false, clamped: false }
  if (secondaryFits) return { left, top: secondary, flipped: true, clamped: false }
  return { left, top: clamp(primary, pad, vh - boxH - pad), flipped: false, clamped: true }
}
