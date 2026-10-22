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
import type { Block, Doc, FoldState } from '../model.ts'
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
 * v8 → v9：折叠从块上移到 `workspace.folded`（块上的 `collapsed` 不再被读 ⇒ 旧库作废重 seed）
 * v9 → v10：日记块的 id 由「时间戳＋日期数字」改成名字哈希派生。旧库里的日记 id 与新代码
 *            算出的对不上 ⇒ 「今天」会被判定为不存在而**新建一个空日记**，旧内容留在原地
 *            但日记流看不见（内容没丢，是「看不见」这种更糟的形态）⇒ 必须作废重 seed
 * v10 → v11：待办状态从块字段改成任务状态属性（`_todo` 与 `todo` 字段都不再被读）。
 *            旧库的待办状态会静默消失（勾选与删除线一起没了），所以作废重 seed
 * v11 → v12：新增库级 `trash`（删除改成「摘出到回收站」）。
 *            旧库没有这一格读出来就是 `[]`，本不必作废；加一版是为了让**写路径**只面对一种形状
 *            （落盘的每份库都带 `trash`），免得「有没有这一格」在下游变成两条分支。
 * v12 → v13：标签从「正文里占一格的原子」改成块级归属 `props._tags`。
 *            旧库的 `kind:'tag'` 原子不再被任何读路径认（标签会静默消失）⇒ 作废重 seed。
 */
export const WORKSPACE_VERSION = 13

/** 示例库：一片块森林 ＋ 行内锚点/原子 */
export interface Workspace {
  version: typeof WORKSPACE_VERSION
  /** 块森林（承 1／5：整个库是一片森林，没有「页实体」这一层） */
  blocks: Block[]
  /**
   * 折叠态（块 id → 收起）。它属于**库的视图状态**，不属于任何块：
   * 挂在块上会被树操作当货物搬走（合并/复制）、会进撤销栈、会跟着导出跑。
   */
  folded: FoldState
  /** 中心槽持有的「当前对象」（只有中心槽有这个概念） */
  activeId: string
  prefs: Prefs
  savedAt: number
  /**
   * **回收站**：被删掉的**根**块（子树完整）。每项带着 `_deletedAt`。
   *
   * 为什么不只是「删掉就不再存在」：地址（页名／标签名）是块 id 之外的第二个身份，
   * 删掉一个标签块会让所有指向它的边同时悬空，再打同名又造出一个新 id 的块 —— 旧边一条都不认。
   * 留住整棵子树，同一地址复活时才接得上。
   */
  trash: Block[]
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

/**
 * 折叠表：必须是 `Record<string, true>`。
 *
 * ⚠️ 只认 `true`：值的语义是「收起了」，写 `false` 与「不在表里」是同一件事的两种写法，
 *    留着它就能出现「表里有这个 id，但它是展开的」这种第三态。
 */
function isFoldState(x: unknown): x is FoldState {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false
  return Object.values(x).every((v) => v === true)
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
  if (!isFoldState(ws.folded)) return { status: 'corrupt', reason: 'shape' }
  // 回收站缺省成空数组：这是**新增**的一格，旧库没有它不代表字节坏了；
  // 但既然有，形状就必须对（「有但读不懂」与「没有」是两件事）。
  if (ws.trash !== undefined && (!Array.isArray(ws.trash) || !ws.trash.every(isBlockTree))) {
    return { status: 'corrupt', reason: 'shape' }
  }
  return {
    status: 'ok',
    ws: {
      ...(ws as Workspace),
      trash: ws.trash ?? [],
      prefs: normalizePrefs(ws.prefs as Partial<Prefs> | undefined),
    },
  }
}

/**
 * 一份页块的子树 → 编辑器文档（中心槽渲染它的子树）。
 *
 * `folded` 由调用方给：折叠表是**整库**的（块 id 全局唯一），但每个视图只该读它自己那份
 * （正文／反链／查询各带各的），所以这里不偷偷把库里的那份抄进来。
 */
export function pageDoc(p: Block, folded: FoldState = {}): Doc {
  return { roots: p.children, folded }
}
