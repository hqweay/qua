/**
 * **上下文展开**：把「点过的祖先」叠到一栏的装载根上。
 *
 * 为什么是换根、不是在 DOM 里展开一层：挂载区／查询视图只装命中行，祖先不在这一栏的
 * `doc` 里，没有可展开的节点。把祖先装成真实的 root，命中行自然落在它的子树里 ——
 * 零视图模型、零块拷贝，展开出来的就是库里那一块。
 *
 * 纯逻辑、零 DOM：两个面板共用同一份，单测直接钉。
 *
 * 三层口径：
 *   · **有效**：展开 id 必须仍是一片活块，且出现在某个基础命中的祖先链里；
 *   · **只渲染最外层**：内层已经被外层的子树装进来了；但内层仍留在 `expanded` 里，
 *     收起外层时它会重新浮出来（一层层退回）；
 *   · **去重**：某个祖先覆盖了多个命中时，那些命中不再单列，否则同一块出现两遍。
 */
import type { Block, FoldState } from './model.ts'

export interface ContextBase {
  /** 最外层命中（已经去过重） */
  roots: readonly Block[]
  /** 命中根 id → 祖先链（根→父，不含自己） */
  contexts: ReadonlyMap<string, readonly Block[]>
}

export interface ContextPlan {
  roots: Block[]
  contexts: Map<string, readonly Block[]>
  /** 这一栏里哪些根是**展开出来的上下文根**（行首给「收起上下文」） */
  contextRoots: Set<string>
  /** 上下文根 → 它覆盖的原始命中行（先序） */
  covers: Map<string, string[]>
  /** 仍然有效的展开 id（含暂时被外层盖住的内层，供逐层收起） */
  expanded: Set<string>
  /** 这次渲染后要滚到的命中行；只在传入 `focusHint` 时给 */
  focusId: string | null
}

/**
 * @param base 基础装载根（反链／查询的最外层命中）
 * @param expanded 用户点过的祖先 id（可能嵌套、可能已经过期）
 * @param pathOf 整片森林里的 root→id；与 `KbClient.pathOf` 同一个口径
 * @param focusHint 刚点的那一行（原始命中或上下文根）——用于算滚动落点
 */
export function expandContexts(
  base: ContextBase,
  expanded: ReadonlySet<string>,
  pathOf: (id: string) => readonly Block[],
  focusHint?: string,
): ContextPlan {
  const basePaths = new Map<string, readonly Block[]>()
  for (const r of base.roots) basePaths.set(r.id, base.contexts.get(r.id) ?? [])

  const noExpansion = (valid: Set<string>): ContextPlan => ({
    roots: [...base.roots],
    contexts: new Map(base.contexts),
    contextRoots: new Set(),
    covers: new Map(),
    expanded: valid,
    focusId: null,
  })
  if (expanded.size === 0) return noExpansion(new Set())

  // ① 有效：仍解析得到，且出现在某个基础命中的祖先链里
  const resolved = new Map<string, readonly Block[]>()
  const valid = new Set<string>()
  for (const id of expanded) {
    const path = pathOf(id)
    if (path.length === 0 || path[path.length - 1]!.id !== id) continue
    if (!base.roots.some((r) => basePaths.get(r.id)!.some((a) => a.id === id))) continue
    resolved.set(id, path)
    valid.add(id)
  }
  if (valid.size === 0) return noExpansion(valid)

  // ② 最外层：自己的祖先里有另一个展开 id ⇒ 它会被那个祖先的子树装进来
  const outermost = new Set<string>()
  for (const id of valid) {
    if (!resolved.get(id)!.slice(0, -1).some((a) => valid.has(a.id))) outermost.add(id)
  }

  // ③ 按基础命中的原顺序装根：被覆盖的命中换成「覆盖它的那个最外层祖先」一次
  const roots: Block[] = []
  const contexts = new Map<string, readonly Block[]>()
  const contextRoots = new Set<string>()
  const covers = new Map<string, string[]>()

  for (const r of base.roots) {
    const path = basePaths.get(r.id)!
    const outer = path.find((a) => outermost.has(a.id))
    if (!outer) {
      roots.push(r)
      if (path.length > 0) contexts.set(r.id, path)
      continue
    }
    if (!contextRoots.has(outer.id)) {
      contextRoots.add(outer.id)
      contexts.set(outer.id, resolved.get(outer.id)!.slice(0, -1))
      covers.set(outer.id, [])
      roots.push(outer)
    }
    covers.get(outer.id)!.push(r.id)
  }

  return {
    roots,
    contexts,
    contextRoots,
    covers,
    expanded: valid,
    focusId: resolveFocus(base, basePaths, covers, focusHint),
  }
}

/** 滚动落点：优先刚点的那一行；点的是上下文根 ⇒ 它覆盖的第一条命中 */
function resolveFocus(
  base: ContextBase,
  basePaths: ReadonlyMap<string, readonly Block[]>,
  covers: ReadonlyMap<string, readonly string[]>,
  focusHint?: string,
): string | null {
  if (!focusHint) return null
  if (basePaths.has(focusHint)) return focusHint
  if (covers.has(focusHint)) return covers.get(focusHint)![0] ?? null
  // 更高层的祖先（上下文根的面包屑）：找它下面的第一条命中
  const hit = base.roots.find((r) => basePaths.get(r.id)!.some((a) => a.id === focusHint))
  return hit?.id ?? null
}

/**
 * 展开出来的路径必须**真的展开到命中行**：面板自己的折叠表若把这些祖先/中间层收着，
 * `loadPage` 之后命中行会在一个折起来的子树里 —— 点了像没反应。
 *
 * 只清「上下文根 → 命中行的父」这一段；命中行自己的折叠态保留（那是用户对它的选择）。
 */
export function unfoldForContext(
  folded: FoldState | undefined,
  covers: ReadonlyMap<string, readonly string[]>,
  pathOf: (id: string) => readonly Block[],
): FoldState | undefined {
  if (covers.size === 0) return folded
  const next: FoldState = { ...(folded ?? {}) }
  let changed = false
  for (const [rootId, hits] of covers) {
    for (const hit of hits) {
      const path = pathOf(hit)
      const at = path.findIndex((b) => b.id === rootId)
      if (at < 0) continue
      for (let i = at; i < path.length - 1; i++) {
        const id = path[i]!.id
        if (next[id]) {
          delete next[id]
          changed = true
        }
      }
    }
  }
  return changed ? (Object.keys(next).length > 0 ? next : undefined) : folded
}
