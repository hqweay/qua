/**
 * 「GitHub 上有没有比当前运行版本更新的发布」——**纯判据，零依赖**。
 *
 * 与壳的那一半（网络／缓存／弹窗）分家：这一份要能在单测里逐条钉住（版本比较、通道闸、
 * 坏载荷），壳那一半只做编排。载荷一律当**外部输入**看待——GitHub 改字段不许让主进程抛。
 */

/** 一次检查的结论。`unavailable` 是**静默**的：连不上不算错，不该打扰用户 */
export type UpdateCheck =
  | { kind: 'up-to-date'; current: string }
  | { kind: 'available'; current: string; next: string; url: string; notes: string; publishedAt: string }
  | { kind: 'unavailable'; reason: 'no-release' | 'bad-payload' }

export interface Version {
  core: readonly [number, number, number]
  /** 预发布标识符（`beta.6` → `['beta', '6']`）；空数组＝正式版 */
  pre: readonly string[]
}

/** 发布说明在弹窗里占的行数是有上限的：截断是**故意**的，不是没读到 */
const NOTES_LIMIT = 800

/**
 * 解析 semver 的**够用子集**：三段数字 + 可选预发布段（tag 形状的 `v` 前缀先剥掉）。
 *
 * 不引依赖：这里只需要「谁更大」，不需要 range／tilde／caret。
 * 解析不了 ⇒ `null`（调用方当作「这一条不算发布」，不是抛）。
 */
export function parseVersion(raw: unknown): Version | null {
  if (typeof raw !== 'string') return null
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw.trim())
  if (!m) return null
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])] as const,
    pre: m[4] ? m[4].split('.') : [],
  }
}

/** semver 排序：`a > b` ⇒ 正数。数字段按数值比（`beta.10` 大于 `beta.6`），字母段按字典序 */
export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i += 1) {
    const d = a.core[i] - b.core[i]
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return comparePre(a.pre, b.pre)
}

function comparePre(a: readonly string[], b: readonly string[]): number {
  // 有预发布段的版本**小于**同号的正式版（`0.1.0-beta.6 < 0.1.0`）
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    const x = a[i]
    const y = b[i]
    // 前缀相同则短的小（`beta < beta.6`）
    if (x === undefined) return -1
    if (y === undefined) return 1
    const d = compareIdentifier(x, y)
    if (d !== 0) return d
  }
  return 0
}

function compareIdentifier(x: string, y: string): number {
  const nx = /^\d+$/.test(x)
  const ny = /^\d+$/.test(y)
  // 纯数字段按数值比（`6 < 10`）；数字段小于字母段
  if (nx && ny) return Number(x) === Number(y) ? 0 : Number(x) < Number(y) ? -1 : 1
  if (nx) return -1
  if (ny) return 1
  return x === y ? 0 : x < y ? -1 : 1
}

/**
 * 从 GitHub 的 releases 载荷里挑出「该推给这个用户的那一条」。
 *
 * 三条判据（都要能被单测打红）：
 *   ① **draft 一律不算**——未发布就是用户还看不见（发布动作在人手上）；
 *   ② **通道是单向闸**：正式版用户不会被拉进预发布；beta 用户照样收得到更高的正式版
 *      （`0.1.0-beta.6 → 0.1.0` 正是要发生的事，挡住就等于把 beta 用户留在原地）；
 *   ③ 比的是**最高版本**，不是列表首个（API 的返回序不是契约）。
 */
export function pickLatest(raw: unknown, current: string): UpdateCheck {
  const cur = parseVersion(current)
  if (!cur) return { kind: 'unavailable', reason: 'bad-payload' }
  if (!Array.isArray(raw)) return { kind: 'unavailable', reason: 'bad-payload' }

  const allowPrerelease = cur.pre.length > 0
  let best: { v: Version; item: Record<string, unknown> } | null = null

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    if (item.draft === true) continue
    if (item.prerelease === true && !allowPrerelease) continue
    const v = parseVersion(item.tag_name)
    if (!v) continue
    if (!best || compareVersions(v, best.v) > 0) best = { v, item }
  }

  if (!best) return { kind: 'unavailable', reason: 'no-release' }
  if (compareVersions(best.v, cur) <= 0) return { kind: 'up-to-date', current }

  const url = typeof best.item.html_url === 'string' ? best.item.html_url : ''
  // 有版本没地址＝用户点了也没地方去，按坏载荷处理（不推一个走不通的「更新」）
  if (!url) return { kind: 'unavailable', reason: 'bad-payload' }

  return {
    kind: 'available',
    current,
    next: String(best.item.tag_name).trim().replace(/^[vV]/, ''),
    url,
    notes: clipNotes(best.item.body),
    publishedAt: typeof best.item.published_at === 'string' ? best.item.published_at : '',
  }
}

function clipNotes(body: unknown): string {
  if (typeof body !== 'string') return ''
  const flat = body.replace(/\r\n/g, '\n').trim()
  if (flat.length <= NOTES_LIMIT) return flat
  return `${flat.slice(0, NOTES_LIMIT).trimEnd()}…`
}
