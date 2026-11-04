/**
 * FTS 行的**增量计划**（纯函数）：哪些块的哪个来源要重写、哪些要摘掉、rowid 怎么分配。
 *
 * 为什么单独一层：`db-rows.ts` 是内容行的唯一编码落点，但它不该知道分词器／异步；
 * 这里只吃「已经分好词的 token」，产出一批 `RowWrite` 与一张新的 `键 → rowid` 映射。
 * 于是「增量」「全量重建」「单测」用的是同一份分配与删除口径。
 *
 * 一块最多五行索引（每来源一行，见 `sources.ts`）：
 *   · `content` —— 正文投影；
 *   · `alias`   —— 全部地址文本（首个是主名）；
 *   · `tag`     —— 它带的标签的**现算名**（归属住在 `_tags`，名字跟着标签块走）；
 *   · `prop`    —— 存下来的属性值（文本值原样；选项值索引**选项块的现算名**）；
 *   · `link`    —— 外链的显示文本与地址 ＋ 引用指向目标的**现算名**（锚文本不算——
 *                  那是「这一处的显示」，不是目标的身份）。
 *
 * 四条不变量：
 *   · **软删的块不进索引**（与 `{text}` 扫描「只搜活块」同一口径）；
 *   · 删一块＝删**整棵子树**的全部来源行（软删只有一个 op，子树的不可见是继承来的）；
 *   · `BlockFTSMap` 与 FTS 行**成对**出现：写一行索引必写映射，删一行索引必删映射；
 *   · 名字类来源（tag／prop 选项／link 引用）索引的是**现算名** ⇒ 名字变了要牵连重索引
 *     （见 `ftsTargets` 的扩散名单）。
 */
import { ALIASES_PROP, aliasesOf, hasList, isDeleted, isPropDefBlock, type Block } from '../model/model.ts'
import { displayTextOf } from '../identity/alias.ts'
import { plainText } from '../model/runs.ts'
import { walkForest } from '../model/walk.ts'
import { TAGS_PROP, tagIdsOf } from '../identity/tags.ts'
import type { Op } from '../kb/types.ts'
import { probeOf, type RowWrite, type StoredWorkspace } from '../storage/db-rows.ts'
import { ftsRowKey, parseFtsRowKey, FTS_SOURCES, type FtsSource } from './sources.ts'
import type { TokenizedText } from './tokenizer.ts'

export { FTS_SOURCES, ftsRowKey, parseFtsRowKey }
export type { FtsSource }

export interface FtsTargets {
  /** 需要重新分词／写索引的 (来源 → 块集合) */
  index: Map<FtsSource, Set<string>>
  /** 需要摘掉索引的 (来源 → 块集合) */
  remove: Map<FtsSource, Set<string>>
}

function addIn(map: Map<FtsSource, Set<string>>, source: FtsSource, id: string): void {
  let set = map.get(source)
  if (!set) {
    set = new Set()
    map.set(source, set)
  }
  set.add(id)
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
 * 指向 `targetId` 的**引用源块**（可见块里正文带指向它的引用 run，含行内标签露面）。
 *
 * 引用的显示名是渲染时现算的（目标改名跟着走），索引里那份「目标现算名」同理——
 * 目标的可解析性或名字一变，源块的 link 行就要重铺。改名／删除都是低频动作，
 * 这里一次全库扫描的代价可以接受（选项改名、标签改名各有一份同类的扩散名单）。
 */
function refSourceIds(ws: StoredWorkspace, targetId: string): Set<string> {
  const out = new Set<string>()
  walkForest(ws.blocks, (b) => {
    for (const r of b.content) {
      if (r.t === 'ref' && r.to === targetId) {
        out.add(b.id)
        break
      }
    }
  })
  return out
}

/** 打了某个标签的可见块（归属住在 `_tags`；软删的成员早已不在索引里） */
function tagMemberIds(ws: StoredWorkspace, tagId: string): Set<string> {
  const out = new Set<string>()
  walkForest(ws.blocks, (b) => {
    if (tagIdsOf(b).includes(tagId)) out.add(b.id)
  })
  return out
}

/**
 * 属性值取了某个选项块的可见块（字段值存在「定义块的块 id」这个属性名下，值是选项块 id）。
 *
 * ⚠️ 只认**存下来的值**：定义块上的缺省槽不是任何块存过的值，选项改名不牵连它
 * （「带缺省未填」的块本来就没有属性行）。
 */
function choiceTakerIds(ws: StoredWorkspace, choiceId: string): Set<string> {
  const out = new Set<string>()
  walkForest(ws.blocks, (b) => {
    const props = b.props
    if (!props) return
    for (const name of Object.keys(props)) {
      if (name.startsWith('_')) continue
      if (props[name] === choiceId) out.add(b.id)
    }
  })
  return out
}

/** 一次遍历拿齐「块 ＋ 它的树父」（选项块的判定要看父块是不是字段定义） */
function probeWithParent(
  ws: StoredWorkspace,
  ids: ReadonlySet<string>,
): Map<string, { block: Block; parent: Block | null }> {
  const want = new Set(ids)
  const found = new Map<string, { block: Block; parent: Block | null }>()
  if (want.size === 0) return found
  walkForest(ws.blocks, (b, ctx) => {
    if (!want.has(b.id)) return
    found.set(b.id, { block: b, parent: ctx.parent })
    want.delete(b.id)
    if (want.size === 0) return false
  })
  return found
}

/**
 * 从一批 op 推出「哪个来源的哪些块」要动。
 *
 * 块级 op（正文／位置／存在）影响**全部来源**；属性 op 按**属性名**分派：
 * 地址、标签归属、字段值各动各的行，其余系统槽不进索引。
 *
 * 名字类来源的**牵连重索引**（改 A 要重铺 B 的行）：
 *   · 改地址 → 这个块的别名行；它是标签 ⇒ 全部成员块的标签行；被引用 ⇒ 引用块的 link 行；
 *   · 改字段定义下选项块的正文 ⇒ 所有取该选项的块的 prop 行；
 *   · 目标被软删／恢复／清除 ⇒ 引用它的块的 link 行（可解析性变了）。
 *
 * 刻意**不**做的扩散：改正文不牵连引用块的 link 行——没有地址的块的「名字」来自
 * 正文投影，逐键扩散等于给打字路径加一次全库扫描；那条路的过期行由重建收口
 * （索引是派生数据，重建读的是当前森林）。有地址的块（页／标签）改名走地址 op，
 * 已在上面覆盖。
 */
export function ftsTargets(ws: StoredWorkspace, ops: readonly Op[]): FtsTargets {
  const index: Map<FtsSource, Set<string>> = new Map()
  const remove: Map<FtsSource, Set<string>> = new Map()
  const structural = new Set<string>()
  const contentChanged = new Set<string>()

  for (const op of ops) {
    if (op.e !== 'block') continue
    if (op.op === 'exist') {
      if (op.state === 'purged') {
        for (const s of FTS_SOURCES) addIn(remove, s, op.id)
        for (const id of refSourceIds(ws, op.id)) addIn(index, 'link', id)
        continue
      }
      // `deleted`／`present` 都是整棵子树的可见性变化
      const b = probeOf(ws.blocks, [op.id]).get(op.id)
      if (b) {
        const into = op.state === 'deleted' ? remove : index
        for (const id of subtreeIds(b)) for (const s of FTS_SOURCES) addIn(into, s, id)
        // 引用它的块：目标的可解析性变了，link 行要跟着改
        for (const id of refSourceIds(ws, op.id)) addIn(index, 'link', id)
      } else if (op.state === 'deleted') {
        for (const s of FTS_SOURCES) addIn(remove, s, op.id)
      }
      continue
    }
    if (op.value.content !== undefined || op.value.parent !== undefined) structural.add(op.id)
    if (op.value.content !== undefined) contentChanged.add(op.id)
  }

  for (const op of ops) {
    if (op.e !== 'prop') continue
    if (op.name === ALIASES_PROP) {
      addIn(index, 'alias', op.block)
      const b = probeOf(ws.blocks, [op.block]).get(op.block)
      // 标签块改名 ⇒ 名字住在成员块的标签行里，全部成员要重铺
      if (b && hasList(b, 'tag')) for (const id of tagMemberIds(ws, op.block)) addIn(index, 'tag', id)
      // 名字变了 ⇒ 引用它的块的 link 行（行内提及与普通引用同路）
      for (const id of refSourceIds(ws, op.block)) addIn(index, 'link', id)
      continue
    }
    if (op.name === TAGS_PROP) {
      addIn(index, 'tag', op.block)
      continue
    }
    if (op.name.startsWith('_')) continue
    addIn(index, 'prop', op.block)
  }

  for (const id of structural) for (const s of FTS_SOURCES) addIn(index, s, id)

  // 正文级联：只有「选项块改名」这一条——它的名字住在取值块的 prop 行里
  const look = probeWithParent(ws, contentChanged)
  for (const [id, probed] of look) {
    if (probed.parent && isPropDefBlock(probed.parent)) {
      for (const tid of choiceTakerIds(ws, id)) addIn(index, 'prop', tid)
    }
  }

  // 同一批里既删又写（理论上的形状）：删除优先，避免索引里留一块已经不可见的内容
  for (const [s, ids] of remove) {
    const idx = index.get(s)
    if (idx) for (const id of ids) idx.delete(id)
  }
  // 空集合剪掉：调用方用 `size === 0` 判「这批要不要碰索引」，空集合会让它误判
  for (const map of [index, remove]) {
    for (const [s, ids] of map) if (ids.size === 0) map.delete(s)
  }
  return { index, remove }
}

/**
 * 一批块的**全部来源行文本**（送分词的原料）。
 *
 * 名字类文本全部**现算**：标签名、选项名、引用目标名都从当前森林解析——
 * 这是「改名跟着走」的前提，也是「改了名要牵连重铺那一行」的原因。
 * 软删的块、解析不到的目标、空文本：各自安静地不产行（空的来源行不存在，
 * `buildFtsWrites` 据此把「没文本了」的行摘掉）。
 *
 * 选项名的解析走**属性名**：字段值的属性名就是字段定义块的 id，先找到定义块，
 * 再在它的直接子块里找值指向的那个选项——不用为了「哪些 id 是选项」扫全库。
 */
export function ftsSourceTexts(
  ws: StoredWorkspace,
  ids: ReadonlySet<string>,
): { key: string; text: string }[] {
  const look = probeOf(ws.blocks, ids)
  const out: { key: string; text: string }[] = []

  // 引用目标、标签块、字段定义块都可能在森林任意处：并成一个探测集，一次找齐
  const wanted = new Set<string>()
  for (const id of ids) {
    const b = look.get(id)
    if (!b || isDeleted(b)) continue
    for (const r of b.content) if (r.t === 'ref' && r.to) wanted.add(r.to)
    for (const tid of tagIdsOf(b)) wanted.add(tid)
    const props = b.props
    if (props) {
      for (const name of Object.keys(props)) {
        if (name.startsWith('_')) continue
        if (typeof props[name] === 'string') wanted.add(name)
      }
    }
  }
  const helpers = probeOf(ws.blocks, wanted)

  for (const id of ids) {
    const b = look.get(id)
    if (!b || isDeleted(b)) continue

    const content = plainText(b.content)
    if (content.trim() !== '') out.push({ key: ftsRowKey(id, 'content'), text: content })

    const aliases = aliasesOf(b)
    if (aliases.length > 0) out.push({ key: ftsRowKey(id, 'alias'), text: aliases.join(' ') })

    // 标签名：现算（`displayTextOf` 的口径——解析不到的悬空 id 不产文本）
    const tagNames: string[] = []
    for (const tid of new Set(tagIdsOf(b))) {
      const t = helpers.get(tid)
      if (!t || isDeleted(t)) continue
      const n = displayTextOf(t)
      if (n.trim() !== '') tagNames.push(n)
    }
    if (tagNames.length > 0) out.push({ key: ftsRowKey(id, 'tag'), text: tagNames.join(' ') })

    // 属性值：文本值原样；指向选项块的值索引选项名（选项名是用户搜的词，id 不是）
    const propTexts: string[] = []
    const props = b.props ?? {}
    for (const name of Object.keys(props)) {
      if (name.startsWith('_')) continue
      const v = props[name]
      if (typeof v !== 'string' || v.trim() === '') continue
      propTexts.push(choiceNameOf(helpers, name, v) ?? v)
    }
    if (propTexts.length > 0) out.push({ key: ftsRowKey(id, 'prop'), text: propTexts.join(' ') })

    // 链接与引用：外链取显示文本＋地址；引用取目标现算名（锚文本是显示层的事）
    const linkTexts: string[] = []
    for (const r of b.content) {
      if (r.t === 'link') {
        const s = `${r.v} ${r.url}`.trim()
        if (s !== '') linkTexts.push(s)
      } else if (r.t === 'ref' && r.to) {
        const t = helpers.get(r.to)
        if (!t || isDeleted(t)) continue
        const n = displayTextOf(t).trim()
        if (n !== '') linkTexts.push(n)
      }
    }
    if (linkTexts.length > 0) out.push({ key: ftsRowKey(id, 'link'), text: linkTexts.join(' ') })
  }
  return out
}

/**
 * 一个字符串属性值的可搜文本：指向字段定义下某个选项 ⇒ 选项名；否则原样。
 *
 * 返回 `null` 表示按原值索引。定义块不存在／不是定义／子块里没有这个值——
 * 都按「普通文本值」处理，不猜。
 */
function choiceNameOf(
  helpers: ReturnType<typeof probeOf>,
  propName: string,
  value: string,
): string | null {
  const def = helpers.get(propName)
  if (!def || !isPropDefBlock(def)) return null
  for (const c of def.children) {
    if (c.id === value) {
      const n = plainText(c.content).trim()
      return n === '' ? null : n
    }
  }
  return null
}

export interface FtsBuilt {
  writes: RowWrite[]
  /** 新的映射（键见 `ftsRowKey`；调用方在事务成功之后才替换） */
  map: Map<string, number>
  nextRowid: number
}

/**
 * 按「目标集合 ＋ 分好的词」产 FTS 行。
 *
 * 每次重写都**先删旧 rowid 再插新**：contentless 不存旧 token，但按 rowid 删除是
 * `contentless_delete=1` 的明确能力（不用回读旧文本）。目标里有、分词结果里没有
 * （文本空了／目标块不可见了）⇒ 那一行被摘掉——「删除→不可搜」走的正是这条路。
 */
export function buildFtsWrites(
  targets: FtsTargets,
  tokens: ReadonlyMap<string, TokenizedText>,
  prevMap: ReadonlyMap<string, number>,
  prevRowid: number,
): FtsBuilt {
  const map = new Map(prevMap)
  let nextRowid = prevRowid
  const writes: RowWrite[] = []

  const drop = (id: string, source: FtsSource): void => {
    const key = ftsRowKey(id, source)
    const rowid = map.get(key)
    if (rowid === undefined) return
    writes.push({ table: 'BlockFTS', op: 'delete', key: { rowid } })
    writes.push({ table: 'BlockFTSMap', op: 'delete', key: { block_id: id, source } })
    map.delete(key)
  }

  for (const [source, ids] of targets.remove) for (const id of ids) drop(id, source)

  for (const [source, ids] of targets.index) {
    for (const id of ids) {
      const key = ftsRowKey(id, source)
      const token = tokens.get(key)
      if (!token) {
        drop(id, source)
        continue
      }
      const old = map.get(key)
      if (old !== undefined) {
        writes.push({ table: 'BlockFTS', op: 'delete', key: { rowid: old } })
        map.delete(key)
      }
      const rowid = ++nextRowid
      writes.push({
        table: 'BlockFTS',
        op: 'insert',
        key: { rowid },
        values: { seg: token.seg, chars: token.chars, pinyin: token.pinyin },
      })
      writes.push({
        table: 'BlockFTSMap',
        op: 'upsert',
        key: { block_id: id, source },
        values: { fts_rowid: rowid },
      })
      map.set(key, rowid)
    }
  }

  return { writes, map, nextRowid }
}

/** 从一批文本行反推目标集合（重建用：文本行就是「应当存在的行」） */
function targetsFromTexts(texts: readonly { key: string; text: string }[]): FtsTargets {
  const index: Map<FtsSource, Set<string>> = new Map()
  for (const { key } of texts) {
    const parsed = parseFtsRowKey(key)
    if (!parsed) continue
    addIn(index, parsed.source, parsed.blockId)
  }
  return { index, remove: new Map() }
}

/**
 * 整库的 FTS 行（重建用；调用方负责先清空表）。
 *
 * 与增量共用 `buildFtsWrites`：把每个活块的每个来源都当「要重写的目标」，从 1 开始分配 rowid。
 * 于是「重建」与「增量走到同一个状态」不是两条实现的口径对齐，而是**同一份代码**。
 */
export function buildAllFtsWrites(
  ws: StoredWorkspace,
  tokens: ReadonlyMap<string, TokenizedText>,
): FtsBuilt {
  const ids = new Set<string>()
  walkForest(ws.blocks, (b) => {
    ids.add(b.id)
  })
  return buildFtsWrites(targetsFromTexts(ftsSourceTexts(ws, ids)), tokens, new Map(), 0)
}
