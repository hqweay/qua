/**
 * 块 id — 假 UUIDv7（形状对齐 ；与 同一实现口径）。
 * 只做「单调时间前缀 + 随机尾段」，**不是真 UUIDv7 的时钟序列保证**。
 */

let seq = 0
const HEX = (n: number, w: number) => n.toString(16).padStart(w, '0')

export function uuidv7Hex(now: number = Date.now()): string {
  const ts = Math.floor(now) & 0xffffffffffff
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

/* ---------------------------------------------------------------- model */
