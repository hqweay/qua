/**
 * **`ref` 的候选域**（`_refDomain`）：候选从哪儿来。
 *
 * 四档，同一根轴上的位置（「不限」＝键缺席，不是第四种成员）：
 *
 *   · **标签** `{kind:'tags', ids}`      —— 这些标签的成员（含下级标签闭包）
 *   · **锚块** `{kind:'block', id}`      —— 这个块下面的块（`id` 可为 `'$self'`：每一处引用所在块）
 *   · **查询** `{kind:'query', id}`      —— 一个查询块此刻的结果集
 *   · **不限** —— 没写这一格
 *
 * 值层一个字节都不动：`props[propId]` 仍是任意块 id。这里只回答**候选从哪儿来**——
 * 属性行上那个「选一个块」的浮层列哪些行。
 *
 * ## 为什么是软约束
 *
 * 域过滤**候选**，不校验**存量值**（与「类／集合」型属性的通行做法一致）：约束改了、
 * 标签删了、查询结果变了 ⇒ 已经引用的块**照常显示**，值不清、不报错。
 * 判据：一旦出现「写值路径按域拒写」「显示时把不在域里的值藏起来」，这条约束就变硬了。
 *
 * ## 为什么是一个判别联合，不是并排几个键
 *
 * 两个键（`_refTags` ＋ `_refQuery`）就有「谁赢」的静默规则。而「有约束／无约束」必须由
 * **在不在场**表达——合成一个布尔再用真值判断，会在「约束存在但一个候选都没有」时
 * 悄悄退回全部块（那时用户看到的是「限制没生效」，比空清单更难查）。
 *
 * ## 为什么锚块与查询都走查询求值器
 *
 * 锚块档就是 `{up:{is:id}}` 这条原子的形状。这里只存锚点，**不存语义**：
 * 求值交给 `KbClient.query`（与查询视图同一份实现），所以「本块之下」只有一种答案，
 * 并且 `'$self'` 由 `resolveSelfSpec` 现成解析，不另写特例。
 *
 * ## 悬空一律退回不限 ＋ 说出来
 *
 * 标签全不在世、锚块删了、查询块删了 —— 三种失效同一规则：退回不限，
 * 并把「约束失效」这件事告诉界面（`dangling`）。**不许**让某档失效表现成「空候选」：
 * 同一格换个档位就变成另一种失败态，用户分不清「我删了块」和「真的没有东西」。
 */
import { isQueryBlock, prop, hasList, type Block } from '../model/model.ts'
import { membersOf } from '../identity/tag-tree.ts'
import { sourceOf } from '../views/view.ts'
import { SELF, type QueryContext, type QueryHit, type QuerySpec } from '../query/query.ts'
import { isRefTagIds, refTagIds } from './ref-target.ts'

/** 定义块上的**候选域**槽（一个判别联合；缺席 ＝ 不限） */
export const REF_DOMAIN_PROP = '_refDomain'

export type RefDomain =
  | { kind: 'tags'; ids: string[] }
  | { kind: 'block'; id: string }
  | { kind: 'query'; id: string }

/** 域的种类（含「不限」——键缺席时读到的那一档） */
export type RefDomainMode = 'any' | 'tags' | 'block' | 'query'

/**
 * 域的形状判据（写路径发看点与系统键登记表共用这一份）。
 *
 * 空 `tags` 数组**非法**：`[]` 与缺席是两件事（空的「限定标签」没有意义，只会让
 * 「为什么没生效」变成要读代码才能回答的问题）。写侧摘键表达「不限」。
 */
export function isRefDomainValue(v: unknown): v is RefDomain {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const d = v as Record<string, unknown>
  if (d.kind === 'tags') return isRefTagIds(d.ids) && (d.ids as string[]).length > 0
  if (d.kind === 'block' || d.kind === 'query') return typeof d.id === 'string' && d.id !== ''
  return false
}

/**
 * 读一个定义块的候选域。
 *
 * `_refDomain` 在场就用它；否则认**旧形状** `_refTags`（桌面真机库里遗留的那一批）：
 * 非空 id 数组 ≡ 标签档。两份同时在场时 `_refDomain` 赢，写路径会把旧键清掉。
 * 坏形状一律读成「不限」——不猜，也不让一格手写数据把值控件变成死按钮。
 */
export function refDomainOf(def: Block | undefined): RefDomain | undefined {
  if (!def) return undefined
  const raw = prop<unknown>(def, REF_DOMAIN_PROP)
  if (isRefDomainValue(raw)) return raw
  const legacy = refTagIds(def)
  return legacy.length > 0 ? { kind: 'tags', ids: [...legacy] } : undefined
}

/** 抬头要念的名字来源（界面自己把 id 翻成名字：core 不产用户文案） */
export type RefDomainLabel =
  | { kind: 'tags'; ids: readonly string[] }
  | { kind: 'block'; id: string; self: boolean }
  | { kind: 'query'; id: string }

/**
 * 求值要用到的库读面（结构类型：`KbClient` 天然满足）。
 *
 * 刻意不接受整片森林：查询走索引路径还是纯函数路径由库决定，这里不替它选。
 */
export interface RefDomainSource {
  get(id: string): Block | undefined
  roots(): readonly Block[]
  query(spec: QuerySpec, ctx: QueryContext): QueryHit[]
}

export interface RefDomainResolution {
  mode: RefDomainMode
  /**
   * `null` ＝ **不限**（键缺席，或约束失效后退回）；
   * `Set` ＝ 候选就是这些；**空集** ＝ 有约束、但此刻一个候选都没有（诚实的「没有候选」）。
   */
  ids: Set<string> | null
  /** 约束失效的种类（`ids` 此时为 `null`）；界面要把这句实话念出来 */
  dangling: 'block' | 'query' | null
  /** 抬头念什么（`null` ＝ 不限） */
  label: RefDomainLabel | null
}

const NO_DOMAIN = (): RefDomainResolution => ({ mode: 'any', ids: null, dangling: null, label: null })

/**
 * **候选集**：一次求值的唯一入口（打开选择器时调，不进渲染路径）。
 *
 * `hostId` ＝ **值所在块**：`'$self'` 锚点与查询里的 `$self` 都按它解析
 * （规则与嵌入查询块「`$self`＝这个表面贴在哪一块上」同一条）。
 * 没给宿主时 `'$self'` 锚点给**空集**，不退回全库 —— 与 `runQuery` 对 `$self` 的既有口径一字不差。
 */
export function refDomainIds(
  def: Block | undefined,
  src: RefDomainSource,
  hostId?: string,
): RefDomainResolution {
  const d = refDomainOf(def)
  if (!d) return NO_DOMAIN()

  if (d.kind === 'tags') {
    const label: RefDomainLabel = { kind: 'tags', ids: [...d.ids] }
    const roots = src.roots()
    const live = d.ids.filter((id) => {
      const b = src.get(id)
      return b !== undefined && hasList(b, 'tag')
    })
    /**
     * 标签全不在世 ⇒ 退回不限（软约束：失效的旧定义不该把值控件变死按钮）。
     * 与 267.3 的口径同一个落点；界面按 `label.ids` 仍能说出「原来限的是哪些」。
     */
    if (live.length === 0) return { mode: 'tags', ids: null, dangling: null, label }
    const out = new Set<string>()
    for (const tagId of live) {
      for (const member of membersOf(tagId, roots)) out.add(member)
    }
    return { mode: 'tags', ids: out, dangling: null, label }
  }

  if (d.kind === 'block') {
    const self = d.id === SELF
    const label: RefDomainLabel = { kind: 'block', id: d.id, self }
    if (self && hostId === undefined) return { mode: 'block', ids: new Set(), dangling: null, label }
    const anchorId = self ? (hostId as string) : d.id
    if (src.get(anchorId) === undefined) return { mode: 'block', ids: null, dangling: 'block', label }
    const hits = src.query({ where: { up: { is: anchorId } } }, {})
    return { mode: 'block', ids: new Set(hits.map((h) => h.blockId)), dangling: null, label }
  }

  const label: RefDomainLabel = { kind: 'query', id: d.id }
  const qb = src.get(d.id)
  if (!qb || !isQueryBlock(qb)) return { mode: 'query', ids: null, dangling: 'query', label }
  const source = sourceOf(qb)
  if (source.kind !== 'query') return { mode: 'query', ids: null, dangling: 'query', label }
  /**
   * 上下文：`$self` ＝ 值所在块；结果里剔除它自己（一个属性不该拿自己当候选）。
   * 宿主未知（没有 owner 的选择器）⇒ 不传，`$self` 在求值器里自然解析不了。
   */
  const ctx: QueryContext = hostId === undefined ? {} : { selfId: hostId, excludeIds: [hostId] }
  const hits = src.query(source.spec, ctx)
  return { mode: 'query', ids: new Set(hits.map((h) => h.blockId)), dangling: null, label }
}

/**
 * 域里的**标签名**（标签档抬头用）。悬空标签跳过——名字已经不存在，念出来只会让人去找。
 */
export function refDomainTagNames(
  label: RefDomainLabel | null,
  name: (id: string) => string,
): string[] {
  if (!label || label.kind !== 'tags') return []
  return label.ids.map((id) => name(id)).filter((n) => n !== '')
}
