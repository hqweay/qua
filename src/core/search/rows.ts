/**
 * FTS 行的**增量计划**（纯函数）：哪些块要重写、哪些要摘掉、rowid 怎么分配。
 *
 * 为什么单独一层：`db-rows.ts` 是内容行的唯一编码落点，但它不该知道分词器／异步；
 * 这里只吃「已经分好词的 token」，产出一批 `RowWrite` 与一张新的 `block → rowid` 映射。
 * 于是「增量」「全量重建」「单测」用的是同一份分配与删除口径。
 *
 * 三条不变量：
 *   · **软删的块不进索引**（与 `{text}` 扫描「只搜活块」同一口径）；
 *   · 删一块＝删**整棵子树**的索引（软删只有一个 op，子树的不可见是继承来的）；
 *   · `BlockFTSMap` 与 FTS 行**成对**出现：写一行索引必写映射，删一行索引必删映射。
 */
import { isDeleted, type Block } from '../model/model.ts'
import { plainText } from '../model/runs.ts'
import { walkForest } from '../model/walk.ts'
import type { Op } from '../kb/types.ts'
import { probeOf, type RowWrite, type StoredWorkspace } from '../storage/db-rows.ts'
import type { TokenizedText } from './tokenizer.ts'

export interface FtsTargets {
  /** 需要重新分词／写索引的块 */
  index: Set<string>
  /** 需要摘掉索引的块（软删／清除／空正文） */
  remove: Set<string>
}

/** 一块的**全部后代 id**（含自己；含被软删的，因为软删不摘树） */
function subtreeIds(root: Block): string[] {
  const out: string[] = []
  walkForest(
    [root],
    (b) => {
      out.push(b.id)
    },
    { includeDeleted: true },
  )
  return out
}

/**
 * 从一批 op 推出 FTS 要动的块。
 *
 * 只认**影响正文或存在性**的 op：
 *   · `block.upsert{content}` —— 正文变了；
 *   · `block.upsert{parent}` —— 新块／移动；新块要索引，移动重写一次无害（contentless 不存旧 token）；
 *   · `block.exist{deleted|present}` —— 软删／恢复整棵子树；
 *   · `block.exist{purged}` —— 真的不在（撤销一次插入）。
 *
 * 属性、别名、格式都不进正文索引（首版只索引正文的 `plainText` 投影）。
 */
export function ftsTargets(ws: StoredWorkspace, ops: readonly Op[]): FtsTargets {
  const ids = new Set<string>()
  const remove = new Set<string>()
  const structural = new Set<string>()
  for (const op of ops) {
    if (op.e !== 'block') continue
    if (op.op === 'exist') {
      if (op.state === 'purged') {
        remove.add(op.id)
        continue
      }
      // `deleted`／`present` 都是整棵子树的可见性变化
      const b = probeOf(ws.blocks, [op.id]).get(op.id)
      if (b) for (const id of subtreeIds(b)) op.state === 'deleted' ? remove.add(id) : ids.add(id)
      else if (op.state === 'deleted') remove.add(op.id)
      continue
    }
    if (op.value.content !== undefined || op.value.parent !== undefined) structural.add(op.id)
  }

  const look = probeOf(ws.blocks, structural)
  for (const id of structural) {
    const b = look.get(id)
    if (!b || isDeleted(b)) {
      remove.add(id)
      continue
    }
    ids.add(id)
  }
  // 同一批里既删又写（理论上的形状）：删除优先，避免索引里留一块已经不可见的内容
  for (const id of remove) ids.delete(id)
  return { index: ids, remove }
}

/** 需要送去分词的 (id, 正文)；空正文不进索引 */
export function indexTexts(ws: StoredWorkspace, ids: ReadonlySet<string>): { id: string; text: string }[] {
  const look = probeOf(ws.blocks, ids)
  const out: { id: string; text: string }[] = []
  for (const id of ids) {
    const b = look.get(id)
    if (!b || isDeleted(b)) continue
    const text = plainText(b.content)
    if (text.trim() === '') continue
    out.push({ id, text })
  }
  return out
}

export interface FtsBuilt {
  writes: RowWrite[]
  /** 新的映射（调用方在事务成功之后才替换） */
  map: Map<string, number>
  nextRowid: number
}

/**
 * 按「目标集合 ＋ 分好的词」产 FTS 行。
 *
 * 每次重写都**先删旧 rowid 再插新**：contentless 不存旧 token，但按 rowid 删除是
 * `contentless_delete=1` 的明确能力（不用回读旧正文）。
 */
export function buildFtsWrites(
  ws: StoredWorkspace,
  targets: FtsTargets,
  tokens: ReadonlyMap<string, TokenizedText>,
  prevMap: ReadonlyMap<string, number>,
  prevRowid: number,
): FtsBuilt {
  const map = new Map(prevMap)
  let nextRowid = prevRowid
  const writes: RowWrite[] = []
  const look = probeOf(ws.blocks, [...targets.index, ...targets.remove])

  const drop = (id: string): void => {
    const rowid = map.get(id)
    if (rowid === undefined) return
    writes.push({ table: 'BlockFTS', op: 'delete', key: { rowid } })
    writes.push({ table: 'BlockFTSMap', op: 'delete', key: { block_id: id } })
    map.delete(id)
  }

  for (const id of targets.remove) drop(id)

  for (const id of targets.index) {
    const b = look.get(id)
    if (!b || isDeleted(b)) {
      drop(id)
      continue
    }
    const text = plainText(b.content)
    const token = text.trim() === '' ? undefined : tokens.get(id)
    if (!token) {
      drop(id)
      continue
    }
    const old = map.get(id)
    if (old !== undefined) {
      writes.push({ table: 'BlockFTS', op: 'delete', key: { rowid: old } })
      map.delete(id)
    }
    const rowid = ++nextRowid
    writes.push({
      table: 'BlockFTS',
      op: 'insert',
      key: { rowid },
      values: { seg: token.seg, chars: token.chars, pinyin: token.pinyin },
    })
    writes.push({ table: 'BlockFTSMap', op: 'upsert', key: { block_id: id }, values: { fts_rowid: rowid } })
    map.set(id, rowid)
  }

  return { writes, map, nextRowid }
}

/**
 * 整库的 FTS 行（重建用；调用方负责先清空表）。
 *
 * 与增量共用 `buildFtsWrites`：把每个活块都当「要重写的目标」，从 1 开始分配 rowid。
 * 于是「重建」与「增量走到同一个状态」不是两条实现的口径对齐，而是**同一份代码**。
 */
export function buildAllFtsWrites(
  ws: StoredWorkspace,
  tokens: ReadonlyMap<string, TokenizedText>,
): FtsBuilt {
  const ids = new Set<string>()
  walkForest(ws.blocks, (b) => {
    if (plainText(b.content).trim() !== '') ids.add(b.id)
  })
  return buildFtsWrites(ws, { index: ids, remove: new Set() }, tokens, new Map(), 0)
}

/** 检查用：FTS 行与映射的稳定指纹（rowid 由分配器决定，比较时不看它） */
export function ftsFingerprint(writes: readonly RowWrite[], ws: StoredWorkspace): string[] {
  const texts = new Map<string, string>()
  // 写入里只有 rowid，没有块 id；用 map 行把 rowid 反查成块 id
  const rowOf = new Map<number, string>()
  for (const w of writes) {
    if (w.table === 'BlockFTSMap' && w.op === 'upsert') rowOf.set(Number(w.values!.fts_rowid), String(w.key.block_id))
  }
  for (const w of writes) {
    if (w.table !== 'BlockFTS' || w.op !== 'insert') continue
    const id = rowOf.get(Number(w.key.rowid)) ?? `?${String(w.key.rowid)}`
    const b = probeOf(ws.blocks, [id]).get(id)
    texts.set(id, `${id}|${w.values!.seg}|${w.values!.chars}|${w.values!.pinyin}|${b?.id ?? ''}`)
  }
  return [...texts.values()].sort()
}
