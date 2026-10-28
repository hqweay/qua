/**
 * 块 id — 假 UUIDv7（形状对齐 ；与 同一实现口径）。
 * 只做「单调时间前缀 + 随机尾段」，**不是真 UUIDv7 的时钟序列保证**。
 */

let seq = 0
const HEX = (n: number, w: number) => n.toString(16).padStart(w, '0')

export function uuidv7Hex(now: number = Date.now()): string {
  /**
   * **48 位时间戳只能取模，不能用位与**：`x & 0xffffffffffff` 里那个掩码会被
   * ToInt32 收成 `-1`，整个表达式退化成 `x | 0`（**32 位**、可为负）。
   * 负的时间戳经 `toString(16)` 得到 `-7fde…`，`padStart(12,'0')` 又把补位加在**负号前面**
   * ⇒ 产出 `000-7fde…` 这种 32 字符里带 `-` 的 id。
   *
   * 后果不是「id 变丑」：下游按形状认块 id（`view/dnd.ts` 的 `ID_SHAPE` 只收 32 位十六进制），
   * 于是侧槽窗口整片画不出来、块拖拽全部落空 —— 而且**只在时间戳低 32 位为负的那约 25 天里发生**
   * （每 ~49.7 天轮换一次），换台机器/换个月份就自愈，看起来像偶发。
   */
  const ts = Math.floor(now) % 0x1000000000000
  seq = (seq + 1) & 0x0fff
  const rnd = new Uint8Array(8)
  for (let i = 0; i < 8; i++) rnd[i] = Math.floor(Math.random() * 256)
  return (
    HEX(ts, 12) +
    HEX(0x7000 | seq, 4) +
    HEX(0x8000 | (((rnd[0]! << 8) | rnd[1]!) & 0x3fff), 4) +
    Array.from(rnd.slice(2), (b) => HEX(b, 2)).join('')
  )
}

export function isUuidv7Hex(s: string): boolean {
  return /^[0-9a-f]{32}$/.test(s) && s[12] === '7'
}

/* ------------------------------------------------------------ 确定性 id */

/** FNV-1a 64 位的一趟（`seed` 不同 ⇒ 两趟互相独立，用来把 64 位扩成 128 位） */
function fnv1a64(input: string, seed: bigint): bigint {
  let h = seed
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i))
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return h
}

/**
 * 64 位收尾混合（murmur 的 fmix64）。
 *
 * 为什么不能省：FNV 本身对**相近的短输入**（相邻日期 `…-22`／`…-23`）雪崩不足，
 * 输出只在末几位有差别。id 会被当键、被排序、被肉眼扫，形状太「连号」既难读，
 * 也让碰撞的分布更依赖输入域。这一步把每一位都搅进全部位。
 */
function fmix64(h: bigint): bigint {
  const M = (x: bigint) => x & 0xffffffffffffffffn
  h = M(h ^ (h >> 33n))
  h = M(h * 0xff51afd7ed558ccdn)
  h = M(h ^ (h >> 33n))
  h = M(h * 0xc4ceb9fe1a85ec53n)
  h = M(h ^ (h >> 33n))
  return h
}

/**
 * **确定性 id**：核心词汇的名字 → 稳定 id（纯函数，无表可查）。
 *
 * 为什么需要它：块 id 是随机的（`uuidv7Hex`），但有些核心词汇必须被代码**在任何一次
 * 重开之后**稳定找到——字段定义尤其如此：值是 `props[定义块 id]`，而定义块的显示名
 * 是可改的（改显示名不动任何值，这是属性设计的前提），所以**名字不能当键**。
 * 名字 → id 若靠查表，每次读属性都要多一次解析；靠算则是一次哈希，可单测、可 grep。
 *
 * 形状与 `uuidv7Hex` 一致（32 位小写 hex、版本位 `7`），这样 `isUuidv7Hex` 仍成立，
 * 落库/导出/调试看到的东西是同一类 id，不需要第二套形状。
 *
 * ⚠️ `kind` 参与哈希：不同种类的词汇即使同名也不撞 id（字段定义与标签可以有同样的名字）。
 * ⚠️ 同一个 `(kind, name)` 永远得到同一个 id —— 这是契约，改动即等于换掉所有引用。
 * ⚠️ 这是**哈希**，理论上存在碰撞；输入域是我们自己的封闭词汇表（`journal`／核心字段名），
 *    撞了会在单测里当场暴露，不靠运行时兜底。
 */
export function derivedId(kind: string, name: string): string {
  // `\u0000` 作分隔符：它不会出现在名字里，因此 `('a', 'b:c')` 与 `('a:b', 'c')` 不会拼接成同一个串
  const src = `${kind}\u0000${name}`
  const hi = fmix64(fnv1a64(src, 0xcbf29ce484222325n)).toString(16).padStart(16, '0')
  const lo = fmix64(fnv1a64(src, 0x9e3779b97f4a7c15n)).toString(16).padStart(16, '0')
  const hex = hi + lo
  // 版本位与随机 id 对齐：位置 12 恒 `7`（只覆盖一个 hex 字符，不减少熵到危险的地步）
  return hex.slice(0, 12) + '7' + hex.slice(13)
}

/* ---------------------------------------------------------------- model */
