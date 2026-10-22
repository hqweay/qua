/**
 * 落盘形状（**纯编解码，零 I/O**）。
 *
 * 这是「库里存的是什么」的唯一权威：版本号、块森林的深度校验、偏好归一。
 * 它不认识 `localStorage`、不认识内核、也不认识 DOM —— 所以能直接单测
 * （`tests/workspace.test.ts` 就是拿它跑的）。
 *
 * 适配器只负责**字节的进与出**（见 `local-storage.ts` 的信封）；
 * 「这些字节是不是一份能打开的库」归这里。
 */
import type { Atom, Mark } from '../annotations.ts'
import type { Block, Doc } from '../model.ts'
import { normalizePrefs, type Prefs } from './prefs.ts'

export type { DockPrefs, DockSlotPrefs, Prefs, ThemeMode } from './prefs.ts'
export { DEFAULT_DOCK, DEFAULT_PREFS, normalizePrefs } from './prefs.ts'

/**
 * 落盘形状的版本；**只在显式作废旧库时加一**（/ 71.9）。
 *
 * v1 → v2：`_icon` 值域改为 `lucide:<name>`（2026-10-20）
 * v2 → v3：三皮肤删除
 * v3 → v4：`localStorage` 落盘值套上**信封**（`storage/local-storage.ts`），旧值是裸 JSON ⇒ 作废
 * v4 → v5：`role` 改多值 `roles: Role[]`（旧库的 `role` 无法被新代码识别 ⇒ 作废，不写迁移）
 * v5 → v6：删掉 `favorites` 角色，`backref` 同时从角色表移除（它只活在渲染期的合成行里，从不落盘）。
 *           角色值会跟着 seed 与旧库一起落盘，旧库带着已不存在的角色就与角色表对不上 ⇒ 作废重 seed
 * v6 → v7：角色从顶层 `roles` 挪进 `props._roles`。旧库的角色字段新代码不读 ⇒
 *           页/标签会静默失去身份，所以必须作废重 seed（不写迁移）
 * v7 → v8：角色只剩 `page`／`tag`；日记／字段定义／查询视图的身份改由 `_date`／`_kind`／`_query`
 *           推导。旧库带着已不存在的角色值 ⇒ 作废重 seed
 */
export const WORKSPACE_VERSION = 8

/** 示例库：一片块森林 ＋ 行内锚点/原子 */
export interface Workspace {
  version: typeof WORKSPACE_VERSION
  /** 块森林（承 1／5：整个库是一片森林，没有「页实体」这一层） */
  blocks: Block[]
  /** 中心槽持有的「当前对象」（只有中心槽有这个概念） */
  activeId: string
  prefs: Prefs
  savedAt: number
  /** 行内锚点与原子按块 id 索引（demo 平铺存放；接内核后进表） */
  marks: Mark[]
  atoms: Atom[]
}

/**
 * 校验结果：**版本身份**与**结构健康**是两件事，分开报。
 *
 * `too-new`／`expired` 是「库好好的，只是版本对不上」—— 里面还带着版本号；
 * `corrupt` 是「这坨字节打不开」。调用方据此决定「只读」还是「显式作废」。
 */
export type ParseResult =
  | { status: 'ok'; ws: Workspace }
  | { status: 'empty' }
  /** 旧版本：允许作废并重新 seed，但必须是**显式分支**（不许静默覆盖） */
  | { status: 'expired'; version: number }
  /** 比当前应用新：拒绝打开，绝不覆盖 */
  | { status: 'too-new'; version: number }
  /** JSON 坏了或形状不对：进入只读错误态，留给用户自行备份/抢救 */
  | { status: 'corrupt'; reason: 'parse' | 'shape' }

function isBlock(x: unknown): x is Block {
  if (!x || typeof x !== 'object') return false
  const b = x as Block
  if (typeof b.id !== 'string' || typeof b.text !== 'string' || !Array.isArray(b.children)) return false
  // 角色是可兼位的数组（住在属性袋的 `_roles`）；形状不对就是「这坨字节打不开」，不猜、不修
  const roles = b.props?.['_roles']
  if (roles !== undefined && (!Array.isArray(roles) || !roles.every((r) => typeof r === 'string'))) return false
  return true
}

/** 深度校验一棵子树（属性袋只检查「是对象」，不校验每个 key —— 那是 schema 层的事） */
function isBlockTree(x: unknown): x is Block {
  if (!isBlock(x)) return false
  return x.children.every(isBlockTree)
}

/** 纯解析（可脱离浏览器单测）：`raw === null` ＝ 从没存过 */
export function parseWorkspace(raw: string | null): ParseResult {
  if (raw === null) return { status: 'empty' }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { status: 'corrupt', reason: 'parse' }
  }
  if (!value || typeof value !== 'object') return { status: 'corrupt', reason: 'shape' }
  const ws = value as Partial<Workspace> & { version?: unknown }
  if (typeof ws.version !== 'number' || !Number.isInteger(ws.version)) return { status: 'corrupt', reason: 'shape' }
  if (ws.version > WORKSPACE_VERSION) return { status: 'too-new', version: ws.version }
  if (ws.version < WORKSPACE_VERSION) return { status: 'expired', version: ws.version }
  if (!Array.isArray(ws.blocks) || ws.blocks.length === 0 || !ws.blocks.every(isBlockTree)) {
    return { status: 'corrupt', reason: 'shape' }
  }
  return { status: 'ok', ws: { ...(ws as Workspace), prefs: normalizePrefs(ws.prefs as Partial<Prefs> | undefined) } }
}

/** 一份页块的子树 → 编辑器文档（中心槽渲染它的子树） */
export function pageDoc(p: Block): Doc {
  return { roots: p.children }
}
