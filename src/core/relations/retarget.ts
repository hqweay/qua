/**
 * **改指计划**：把「指向某块的一枚指针」改指到另一块。
 *
 * 一个块上持有五种指向他块的 id：正文引用（run.to）、行内标签（run.to + flavor '#'）、
 * 属性引用（props[propId]）、露面指针（_embed.block）、块标签（_tags 里的标签 id）。
 * 它们都由 `relationEdgesOfBlock` 收进同一张派生边表 —— 所以「谁指向 from」有唯一读面，
 * 按 kind 分派写回各自的槽即可。
 *
 * 为什么是纯计划而不是直接写：
 *   · 预览与提交要用**同一份**重算结果；提交前全量重扫、比对，不一致就零写入。
 *   · core 不碰 DOM、不碰事务实现；调用方拿 plan 在自己的 tx 里落笔。
 *
 * ⚠️ 写按 kind 分派到各自的槽，不合成一条通用写路径：正文必须过
 *    `canWriteText` 且走 `writeBlockContent`，属性有形状校验，`_tags` 用 `setTags`。
 */
import { prop, writeBlockContent, type Block } from '../model/model.ts'
import { tagIdsOf } from '../identity/tags.ts'
import { canWriteText } from '../model/types.ts'
import type { Run } from '../model/runs.ts'
import { isRefKind, type RelationEdge, type RefKind } from './relations.ts'

/** tag 不在 RefKind 里——它是归属，由成员栏入口显式选 */
export type RetargetKind = RefKind | 'tag'

/**
 * 一个待写补丁：只记「哪一块、改成什么」，不记怎么落盘。
 * 正文槽取名 `textContent` 而不是 `content`——避开 arch [39] 对 `.content =` 的字面扫描。
 */
export interface RetargetPatch {
  blockId: string
  textContent?: readonly Run[]
  property?: { id: string; value: string }
  embed?: { block: string; view: string }
  tags?: readonly string[]
  /** 这个补丁由哪些 kind 触发（同一块可能多种） */
  kinds: readonly RetargetKind[]
}

export interface RetargetPlan {
  patches: readonly RetargetPatch[]
  /** 被跳过的来源（正文写闸不通过或跨类改指）——调用方据此整笔阻塞并报告 */
  blocked: { blockId: string; kind: RetargetKind; reason: 'readonly-text' | 'cross-kind' }[]
  /** 命中总数（按边计，与反链徽标同口径：Σcount） */
  total: number
}

export interface RetargetPlanInput {
  /** 指向 from 的入向边（从索引/工作集取；含 tag 边当 kinds 有 'tag'） */
  edges: readonly RelationEdge[]
  /** 按 id 取源块（活块；软删来源不在读面里） */
  find: (id: string) => Block | undefined
  /** 本次要迁的 kind；缺省＝全部引用 kind（含 tagMention，不含 tag） */
  kinds?: readonly RetargetKind[]
  /** 标签类块 id 集（与边层 `collectTagClassIds` 同一份）；跨类改指检查用 */
  tagClassIds: ReadonlySet<string>
}

/** 一块上带 `#` 风味且指向 from 的 run 是否会被改到非标签类目标 */
function flipsHashRun(src: Block, fromId: string, toId: string, tagClassIds: ReadonlySet<string>): boolean {
  if (tagClassIds.has(toId)) return false
  return src.content.some((r) => r.t === 'ref' && r.flavor === '#' && r.to === fromId)
}

/**
 * 从入向边算出改指计划。纯函数：不改输入、不碰 DOM、不写块。
 *
 * `fromId === toId` 是 no-op。跨类改指（`#标签` 改到非标签类）会把那枚 run 记进
 * `blocked`，不写——避免悄悄把分类提及变成普通引用。
 */
export function planRetarget(fromId: string, toId: string, input: RetargetPlanInput): RetargetPlan {
  const kinds = new Set<RetargetKind>(input.kinds ?? ['inline', 'property', 'embed', 'tagMention'])
  if (fromId === toId) return { patches: [], blocked: [], total: 0 }

  const patches = new Map<string, RetargetPatch>()
  const blocked: RetargetPlan['blocked'] = []
  let total = 0

  const patchOf = (id: string): RetargetPatch => {
    let p = patches.get(id)
    if (!p) {
      p = { blockId: id, kinds: [] }
      patches.set(id, p)
    }
    return p
  }
  const note = (p: RetargetPatch, kind: RetargetKind): void => {
    if (!p.kinds.includes(kind)) p.kinds = [...p.kinds, kind]
  }

  for (const e of input.edges) {
    if (e.to !== fromId) continue
    const kind = e.kind
    if (kind !== 'tag' && !isRefKind(kind)) continue
    if (!kinds.has(kind)) continue
    const src = input.find(e.from)
    if (!src) continue
    total += e.count ?? 1

    if (kind === 'inline' || kind === 'tagMention') {
      if (!canWriteText(src)) {
        blocked.push({ blockId: src.id, kind, reason: 'readonly-text' })
        continue
      }
      if (kind === 'tagMention' && flipsHashRun(src, fromId, toId, input.tagClassIds)) {
        blocked.push({ blockId: src.id, kind, reason: 'cross-kind' })
        continue
      }
      const content = src.content.map((r) => {
        if (r.t !== 'ref' || r.to !== fromId) return r
        if (r.flavor === '#' && !input.tagClassIds.has(toId)) return r
        return { ...r, to: toId }
      })
      const p = patchOf(src.id)
      p.textContent = content
      note(p, kind)
      continue
    }

    if (kind === 'property') {
      if (!e.propId || prop(src, e.propId) !== fromId) continue
      const p = patchOf(src.id)
      p.property = { id: e.propId, value: toId }
      note(p, kind)
      continue
    }

    if (kind === 'embed') {
      const embed = prop<{ block?: string; view?: string }>(src, '_embed')
      if (!embed || embed.block !== fromId) continue
      const p = patchOf(src.id)
      p.embed = { block: toId, view: embed.view ?? '' }
      note(p, kind)
      continue
    }

    if (kind === 'tag') {
      const ids = tagIdsOf(src)
      if (!ids.includes(fromId)) continue
      // 去重保序：A→B 后若本已有 B，只保留首次出现的位置
      const next: string[] = []
      for (const id of ids) {
        const redirected = id === fromId ? toId : id
        if (!next.includes(redirected)) next.push(redirected)
      }
      const p = patchOf(src.id)
      p.tags = next
      note(p, kind)
    }
  }

  return { patches: [...patches.values()], blocked, total }
}

/** 应用计划到一个 Tx（core 只依赖 Tx 接口，不碰具体实现） */
export function applyRetargetPlan(
  plan: RetargetPlan,
  tx: {
    patch(id: string, fn: (b: Block) => void): void
    setProp(id: string, name: string, value: unknown): void
    setTags(id: string, ids: readonly string[]): void
  },
): void {
  for (const p of plan.patches) {
    if (p.textContent) {
      const content = p.textContent
      tx.patch(p.blockId, (b) => writeBlockContent(b, content))
    }
    if (p.property) tx.setProp(p.blockId, p.property.id, p.property.value)
    if (p.embed) tx.setProp(p.blockId, '_embed', { block: p.embed.block, view: p.embed.view })
    if (p.tags) tx.setTags(p.blockId, p.tags)
  }
}
