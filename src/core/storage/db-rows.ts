/**
 * **库的行编码**：块森林 ⇄ `qua.db` 的四张表（纯函数，零 I/O）。
 *
 * ## 为什么要有这一层
 *
 * 库里存的不是「一整份 JSON」，而是**块自己的行**。让写成本与库体量脱钩的唯一办法是：
 * 一次编辑只碰**它动过的那几行**，而不是把整片森林序列化一遍。
 * ⇒ 「一个块长成哪几行」必须有**唯一一份**定义，主进程与渲染层各写一遍就会静默分叉
 * （一边加列、另一边不加，读回来那一格就没了，而且不报错）。
 *
 * 所以：**主进程只做通用 SQL**（建表、`select *`、按 `RowWrite` 落行，不认识任何块语义），
 * 列名与语义全在本文件。两个进程共用的表名常量在 `core/library.ts`。
 *
 * ## 四张表的分工（对应「一个块只有四个内容槽」）
 *
 * | 表 | 装什么 | 为什么单独一张 |
 * |---|---|---|
 * | `Block` | `id`／`content`／`annos`／`created`／`modified` ＋ 落库编码的 `parent`／`left` | 关系库里没有嵌套数组，父子与兄弟序必须落成列 |
 * | `BlockProperty` | 属性袋（`_icon`、`_tags`、字段值…） | 一格一行：改一个属性只写那一格 |
 * | `BlockAlias` | 地址（`_aliases`，有序，首个是主名） | 地址是**身份**，要被按名字查 |
 * | `BlockList` | 露面（`_lists`：page／tag） | 露面是集合，与「有什么数据」是两套语义 |
 *
 * ## 四条编码口径
 *
 * 1. **`parent`／`left` 是落库编码，不是运行模型的字段**（`Block` 只有 `children`）。
 *    投影只在一个方向发生：装载 `left` → 建 `children`；写入 `children` → 生成 `(parent, left)`。
 *    **同一层里不许各存一份。**
 * 2. **op 里已经带着位置**（`BlockPatch` 的 `parent` ＋ `prev`，见 `core/kb/types.ts`）：
 *    落库当场把 `prev` 解析成 `left`，**不重新算一遍**。位置只有一份来源，
 *    写库不会因为「算的时候树已经变了」而把块放到别处。
 * 3. **数组拆行，且必须能区分「单值」与「一元数组」**：`_tags`／`_belongsTo`／`_items`／
 *    `_fieldDefs`／`_ownProps`／`_choices` 都是**有序**的字符串列表，拆成多行 ＋ `pos` 才查得动；
 *    但 `['a']` 与 `'a'` 都只有一行 ⇒ 用 `multi` 位说清它是哪种。
 *    非字符串数组（如 `_mounts` 的 `[{label,spec}]`）**整份当一格 JSON**：它不是引用列表，
 *    拆行只会把「一栏配置」拆成没有意义的碎片。
 * 4. **空数组 ＝ 没有这一格**。模型层的所有写路径都遵守这条（空集合就删掉那一格），
 *    落库写成 0 行、读回来看作「缺席」，两边就是同一个答案。
 *
 * ## 哪些键不进属性表
 *
 * | 键 | 去哪 | 为什么 |
 * |---|---|---|
 * | `_aliases` | `BlockAlias` | 身份要按名字查，且有序 |
 * | `_lists` | `BlockList` | 露面是集合 |
 * | `_display`／`_kind`／`_date`／`_query`／`_type` | `Block` 的列 | 每行渲染都读；升列后读一块不必再查属性表 |
 * | `_deletedAt` | `Block.deleted` | 软删标记：遍历过滤与回收站派生都要读它 |
 * | `_queryResult` | **不落库** | 它是「那次查询的冻结结果」，派生值；落盘会在条件变了之后说谎 |
 *
 * ⚠️ `_queryResult` 不落库 ⇒ 查询视图每次装载都要重算一次（`QueryView.mount` 本来就是
 * 「没有冻结结果就 freeze 一次」），所以这一格缺席是**预期形状**，不是丢数据。
 */
import { ALIASES_PROP, DELETED_AT_PROP, DISPLAY_PROP, LISTS_PROP, type Block, type BlockList } from '../model.ts'
import { META_KEYS } from '../library.ts'
import type { Op } from '../kb/types.ts'
import type { Workspace } from './shape.ts'
import { walkForest } from '../walk.ts'

/**
 * 库里读出来的库**没有** `version`：库的 schema 版本只有一个判据（`PRAGMA user_version`，
 * 主进程在装载前就能拿到），payload 再带一份就是「两份版本并存」——
 * 真实故障形状是 `user_version` 认了、payload 还是旧值：装载成功、模型按旧口径解释、不报错。
 * ⇒ 编码层不碰版本，由装载方补上当前值。
 */
export type StoredWorkspace = Omit<Workspace, 'version'>

/* ------------------------------------------------------------ 行形状 */

/** 主进程 `select *` 的结果（列名与 DDL 逐字一致，见 `electron/library/sqlite.ts`） */
export interface RawLibraryRows {
  blocks: Record<string, unknown>[]
  props: Record<string, unknown>[]
  aliases: Record<string, unknown>[]
  lists: Record<string, unknown>[]
  meta: Record<string, string>
}

/**
 * 一次行写入。
 *
 * `delete` 只给一部分主键 ＝ 删「这块的全部行」（`{block}`）；
 * `upsert` 只给一部分列 ＝ 只改那几列（`on conflict do update set` 只覆盖给到的列）。
 */
export interface RowWrite {
  table: 'Block' | 'BlockProperty' | 'BlockAlias' | 'BlockList' | 'meta'
  /**
   * `upsert` 这一行可能还不存在（新块、新属性、新地址）；
   * `update` 这一行**必须已经存在**（改一个已存在块的正文／时刻／软删标记）；
   * `relink` 写这一块的位置，并**把兄弟链修好**（见 `chainRelink`）。
   *
   * 为什么必须分开 `update` 与 `upsert`：SQLite 的 `insert … on conflict do update`
   * **先校验 NOT NULL**，所以「只改一列」走 upsert 会撞 `NOT NULL constraint failed`（实测）。
   * 而 `update` 匹配不到行会报错——「改一个盘上没有的块」是 bug，不该静默变成插入。
   *
   * 为什么 `relink` 必须是一个独立动词：`left` 是**前兄弟指针**，它有两个邻居 ——
   * 光写自己那一格，旧位置的后继还指着你（它现在没有前驱了，会变成链头 ⇒ 顺序乱），
   * 新位置的后继还指着你的前驱（你会被跳过）。两条都得改，且只有落库这一侧
   * 知道「谁接在谁后面」。见 `electron/library/sqlite.ts` 的 `relinkSql`。
   */
  op: 'upsert' | 'update' | 'delete' | 'relink'
  key: Record<string, string | number | null>
  values?: Record<string, string | number | null>
}

/** 升成 `Block` 列的系统属性：模型里的键 → 列名 */
const COLUMN_PROPS: Readonly<Record<string, string>> = {
  [DISPLAY_PROP]: 'display',
  _kind: 'kind',
  _date: 'date',
  _query: 'query',
  _type: 'type',
}

/** 列名 → 模型里的键（装载方向；与 `COLUMN_PROPS` 必须一一对应） */
const COLUMN_TO_PROP: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(COLUMN_PROPS).map(([prop, col]) => [col, prop]),
)

/** 不进属性表的键（它们各有去处，见文件头的表） */
const NOT_A_PROP = new Set<string>([ALIASES_PROP, LISTS_PROP, DELETED_AT_PROP, '_queryResult', ...Object.keys(COLUMN_PROPS)])

/**
 * 找块的探测（只在**结构写入**与 **anno 写入**上用到）。
 *
 * 为什么打字路径用不到它：`block.upsert{content}` 的 op 自带内容，
 * `prop`／`alias`／`list` 的 op 自带那一格的新值 ⇒ 都不必回头读模型。
 * 只有「新建/移动一棵子树」和「anno 整列替换」需要看这块现在长什么样，
 * 而那两条都不是打字路径。
 */
export interface ForestProbe {
  get(id: string): Block | undefined
}

/**
 * 一次遍历找齐给定的 id（**找到就停**；找不到的留给调用方判）。
 *
 * 只在结构写入与 anno 写入上用；打字路径不经过它（op 自带新值）。
 */
export function probeOf(forest: readonly Block[], ids: Iterable<string>): ForestProbe {
  const want = new Set(ids)
  const found = new Map<string, Block>()
  if (want.size > 0) {
    walkForest(
      forest,
      (b) => {
        if (!want.has(b.id)) return
        found.set(b.id, b)
        want.delete(b.id)
        if (want.size === 0) return false
      },
      // 被软删的块也要找得到：恢复/移动它们时要写整行（`deleted` 列得清掉）
      { includeDeleted: true },
    )
  }
  return { get: (id) => found.get(id) }
}

/** 一块在森林里的位置（找不到 ⇒ 顶层：它本来就不该被写到别的父下面） */
function positionOf(forest: readonly Block[], id: string): { parent: string | null; left: string | null } {
  return positionsOf(forest).get(id) ?? { parent: null, left: null }
}

/**
 * 整片森林的「id → 位置」表（`parent` ＋ `left`）。
 *
 * 与 `walkForest` 的口径一致（**含被软删的块**：软删不摘树，行必须保住原位）。
 * 用在「整份写」与测试里；增量写不需要它（op 自带 `parent`／`prev`）。
 */
export function positionsOf(forest: readonly Block[]): Map<string, { parent: string | null; left: string | null }> {
  const out = new Map<string, { parent: string | null; left: string | null }>()
  walkForest(
    forest,
    (b, ctx) => {
      const prev = ctx.index === 0 ? null : (ctx.parent ? ctx.parent.children[ctx.index - 1] : forest[ctx.index - 1])
      out.set(b.id, { parent: ctx.parent?.id ?? null, left: prev?.id ?? null })
    },
    { includeDeleted: true },
  )
  return out
}

/* ------------------------------------------------------------ 写：模型 → 行 */

/**
 * 一个块的**全部行**（块行 ＋ 属性行 ＋ 地址行 ＋ 露面行）。
 *
 * 只在「这块是新进来的 / 整份写」时用：按 patch 逐格写会把这件事变成
 * 「每个 patch 键都必须记得落一次」——漏一个就是静默少一格。
 *
 * 三张子表**先按块清空再写**：清空这一步不是可选的——一个块上的属性可以被删掉，
 * 只写「现在有的那些」会把已经删掉的那一行留在库里，读回来它就复活了。
 */
function blockWrites(b: Block, pos: { parent: string | null; left: string | null }): RowWrite[] {
  const id = b.id
  return [
    blockRow(b, pos),
    { table: 'BlockProperty', op: 'delete', key: { block: id } },
    ...propWrites(b),
    { table: 'BlockAlias', op: 'delete', key: { block: id } },
    ...aliasWrites(b),
    { table: 'BlockList', op: 'delete', key: { block: id } },
    ...listWrites(b),
  ]
}

function blockRow(b: Block, pos: { parent: string | null; left: string | null }): RowWrite {
  const props = b.props ?? {}
  const values: Record<string, string | number | null> = {
    content: JSON.stringify(b.content),
    annos: b.annos === undefined || b.annos.length === 0 ? null : JSON.stringify(b.annos),
    parent: pos.parent,
    left: pos.left,
    created: b.created,
    modified: b.modified,
    // 软删标记是**墙钟毫秒**（原位软删），不是布尔：恢复要能说清「什么时候删的」
    deleted: typeof props[DELETED_AT_PROP] === 'number' ? (props[DELETED_AT_PROP] as number) : null,
  }
  for (const [prop, col] of Object.entries(COLUMN_PROPS)) values[col] = columnValue(prop, props[prop])
  return { table: 'Block', op: 'upsert', key: { id: b.id }, values }
}

/** 一个属性值的列编码（`undefined` ⇒ 这一列写 null；`_query` 是对象 ⇒ JSON） */
function columnValue(prop: string, v: unknown): string | number | null {
  if (v === undefined || v === null) return null
  if (typeof v === 'string') return v
  if (typeof v === 'number') return v
  return prop === '_query' ? JSON.stringify(v) : JSON.stringify(v)
}

/** 一块的**全部**属性行（调用方负责先按块清空，见 `blockWrites`） */
function propWrites(b: Block): RowWrite[] {
  return Object.entries(b.props ?? {}).flatMap(([name, value]) => propRows(b.id, name, value))
}

/**
 * 一格属性：**先删这一格再按值铺行**。
 *
 * 先删不是可选的：一格的值可以从数组变单值、也可以变短，不先删就会留下上一版的尾巴
 * （`['a','b']` 改成 `['a']` 之后库里还留着一行 `pos=1`，读回来那个 `b` 就复活了）。
 */
function onePropRows(block: string, name: string, value: unknown): RowWrite[] {
  return [{ table: 'BlockProperty', op: 'delete', key: { block, name } }, ...propRows(block, name, value)]
}

/** 一格属性 → 行（数组拆多行；空数组 ＝ 没有这一格） */
export function propRows(block: string, name: string, value: unknown): RowWrite[] {
  if (NOT_A_PROP.has(name) || value === undefined) return []
  if (Array.isArray(value) && value.every((x) => typeof x === 'string')) {
    if (value.length === 0) return []
    return value.map((x, pos) => ({
      table: 'BlockProperty' as const,
      op: 'upsert' as const,
      key: { block, name, pos },
      values: { multi: 1, value: JSON.stringify(x) },
    }))
  }
  return [
    {
      table: 'BlockProperty',
      op: 'upsert',
      key: { block, name, pos: 0 },
      values: { multi: 0, value: JSON.stringify(value ?? null) },
    },
  ]
}

function aliasWrites(b: Block): RowWrite[] {
  return aliasRows(b.id, b.props?.[ALIASES_PROP])
}

/**
 * 地址 → 行。
 *
 * 主键是**名字**（地址全局唯一）：换一块认领同一个名字时，upsert 会连 `block` 一起改掉，
 * 于是「这个名字归谁」永远只有一行答案。
 */
function aliasRows(block: string, raw: unknown): RowWrite[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .map((name, pos) => ({ table: 'BlockAlias' as const, op: 'upsert' as const, key: { name }, values: { block, pos } }))
}

function listWrites(b: Block): RowWrite[] {
  return listRows(b.id, b.props?.[LISTS_PROP])
}

function listRows(block: string, raw: unknown): RowWrite[] {
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.filter((x): x is BlockList => x === 'page' || x === 'tag'))].map((list) => ({
    table: 'BlockList' as const,
    op: 'upsert' as const,
    key: { block, list },
  }))
}

/** 库级两格：当前对象与落盘时刻（它们不是块，走 `meta`） */
export function metaWrites(ws: StoredWorkspace): RowWrite[] {
  return [
    { table: 'meta', op: 'upsert', key: { key: META_KEYS.activeId }, values: { value: ws.activeId } },
    { table: 'meta', op: 'upsert', key: { key: META_KEYS.savedAt }, values: { value: String(ws.savedAt) } },
  ]
}

/**
 * **整份写**：整片森林的每一行（种子、换库、撤销之后）。
 *
 * 调用方负责先把四张内容表清空（主进程的 `replaceContentRows` 在同一事务里做），
 * 这里只给「应当存在的行」——这样「表里有什么」永远等于「模型里有什么」。
 */
export function workspaceToRowWrites(ws: StoredWorkspace): RowWrite[] {
  const out: RowWrite[] = []
  /**
   * 走 `walkForest`（块树遍历的唯一入口）：它给的 `ctx.parent`／`ctx.index` 就是落库要的
   * `parent`／`left` 的原料 —— 左兄弟 = 同一层里 `index - 1` 那一块。
   */
  walkForest(
    ws.blocks,
    (b, ctx) => {
      const left = ctx.index === 0 ? null : (ctx.parent ? ctx.parent.children[ctx.index - 1] : ws.blocks[ctx.index - 1])
      /**
       * 整份写不需要「先清这块的旧行」：调用方已经把四张内容表清空了
       * （`replaceContentRows` 在同一事务里做）——留着那些 delete 只是白写一遍。
       */
      for (const w of blockWrites(b, { parent: ctx.parent?.id ?? null, left: left?.id ?? null })) {
        if (w.op !== 'delete') out.push(w)
      }
    },
    // 被软删的块也在树里原位，它们的行必须一起写（否则恢复时那块没有行）
    { includeDeleted: true },
  )
  return [...out, ...metaWrites(ws)]
}

/**
 * **增量写**：这批 op 说到的那些格。
 *
 * ## 两条路，判据是「op 里有没有这一格的新值」
 *
 * | op | 写什么 | 为什么 |
 * |---|---|---|
 * | `block.upsert{content, modified}`（打字） | 只改这两列（`update`） | 一次打字只碰一格；整块写会把这块的属性/地址一起重写，白写 |
 * | `block.upsert{parent, prev}`（新建/移动） | **整块**（`upsert` ＋ 子表） | 新块的行还不存在，而 op 只带落点 ⇒ 只能回头读模型 |
 * | `block.delete`（软删） | 只改 `deleted` 一列 | 原位软删：块留在树里，行也在 |
 * | `prop` / `alias` / `list` | 只动那一格 | op 自带新值 |
 * | `anno` | 只改 `annos` 一列（要读模型） | annos 是一整列，op 是按条报的 |
 *
 * ## 为什么「改一格」走 `update` 而不是 `upsert`
 *
 * SQLite 的 `insert … on conflict do update` **先校验 NOT NULL**（实测：对已存在的行做
 * 部分列的 upsert 也会撞 `NOT NULL constraint failed: Block.created`）。
 * 而 `update` 匹配不到行会报错 —— 「改一个盘上没有的块」是 bug，
 * 不该静默变成「插入一行只有这一列的块」。⇒ 两种语义各用一个动词。
 *
 * 成本：**只与这批 op 碰到的块数有关**（打字 ＝ 1 块 ＋ 库级 2 格），与库里有多少块无关。
 */
export function rowWritesFor(
  ws: StoredWorkspace,
  ops: readonly Op[],
  /**
   * **模型里有、盘上还没有**的块（装配期补出来的那几块：今日那块、空天的首子块）。
   *
   * 它们没有 op（补块发生在事务之外），但盘上确实还没有它们 ——
   * 不写进去的后果不是报错：那块永远没有行，它下面的字会以「父块不存在」的形状
   * 变成顶层块，下次装载时自己冒出来。
   */
  ensure: readonly string[] = [],
): RowWrite[] {
  const out: RowWrite[] = []
  /** 需要整块的块（新进来/被移动的）：只有它们要回头读模型 */
  const structural = new Set<string>()
  const annoBlocks = new Set<string>()
  for (const op of ops) {
    if (op.e === 'block' && op.op === 'upsert' && op.value.parent !== undefined) structural.add(op.id)
    else if (op.e === 'anno') annoBlocks.add(op.block)
  }
  const look = probeOf(ws.blocks, [...ensure, ...structural, ...annoBlocks])

  const done = new Set<string>()
  /**
   * 装配期补出来的块：**整块写**（它们没有 op，位置只能从森林现算）。
   * 先写它们，再把 `done` 留给 op 那一轮判重 —— 顺序反过来会让
   * 「op 里带着落点的新块」被这里的现算位置覆盖掉。
   */
  for (const id of ensure) {
    const b = look.get(id)
    if (!b) continue
    out.push(...blockWrites(b, positionOf(ws.blocks, id)))
  }
  for (const op of ops) {
    switch (op.e) {
      case 'block': {
        if (op.op === 'delete') {
          // 原位软删：块带着子树留在树里，只写删除时刻（`op.at` 就是它，见 `Tx.remove`）
          out.push({ table: 'Block', op: 'update', key: { id: op.id }, values: { deleted: op.at } })
          break
        }
        if (op.value.parent !== undefined) {
          if (done.has(op.id)) break
          done.add(op.id)
          const b = look.get(op.id)
          if (!b) {
            /**
             * op 说「这块现在挂在这里」，模型里却没有它 ⇒ 盘上也不该有它。
             * 显式清掉（块行 ＋ 三张子表）：留着会得到一个「行还在、树上没有」的幽灵块，
             * 下次装载它会自己冒出来，而且没有任何一层会报错。
             */
            out.push(...clearBlock(op.id))
            break
          }
          /**
           * 位置**只从 op 拿**（`parent` ＋ `prev`）：落库当场解析成 `left`，
           * 不重新算一遍。位置只有一份来源 —— 算的时候树可能已经变了。
           *
           * ⚠️ 整块写会把这一行的 `parent`／`left` 一起覆盖，但**兄弟链还有两个邻居**：
           * 旧位置的后继（还指着我）与新位置的后继（还指着我的前驱）。
           * 不修它们，链就断了 —— 断链不报错，只会在下次装载时把顺序排错
           * （`tests/storage/db-rows.test.ts` 的「首位插入」「中间块移走」两条钉着它）。
           */
          /**
           * ⚠️ **`relink` 必须排在这一行之前**：它的第一条语句要读「我改之前的前驱」，
           * 先写我自己那一格就把它冲掉了（实测：中间块移走后原位置顺序错成 `a,z,m`）。
           */
          out.push({ table: 'Block', op: 'relink', key: { id: op.id }, values: { parent: op.value.parent, left: op.value.prev ?? null } })
          out.push(...blockWrites(b, { parent: op.value.parent, left: op.value.prev ?? null }))
          break
        }
        const values: Record<string, string | number | null> = {}
        if (op.value.content !== undefined) values.content = JSON.stringify(op.value.content)
        if (op.value.modified !== undefined) values.modified = op.value.modified
        if (Object.keys(values).length > 0) out.push({ table: 'Block', op: 'update', key: { id: op.id }, values })
        break
      }
      case 'prop': {
        if (op.op === 'delete') {
          out.push({ table: 'BlockProperty', op: 'delete', key: { block: op.block, name: op.name } })
          out.push(...columnWrites(op.block, op.name, undefined))
          // 地址／露面被整格摘掉时，它们自己的表也要跟着清（否则盘上留着一份「模型里已经没有」的身份）
          if (op.name === ALIASES_PROP) out.push({ table: 'BlockAlias', op: 'delete', key: { block: op.block } })
          if (op.name === LISTS_PROP) out.push({ table: 'BlockList', op: 'delete', key: { block: op.block } })
          break
        }
        out.push(...columnWrites(op.block, op.name, op.value))
        // 地址与露面各有自己的表（整袋值 ⇒ 先按块清旧行、再按新值写；地址表以**名字**为键）
        if (op.name === ALIASES_PROP) {
          out.push({ table: 'BlockAlias', op: 'delete', key: { block: op.block } })
          out.push(...aliasRows(op.block, op.value))
          break
        }
        if (op.name === LISTS_PROP) {
          out.push({ table: 'BlockList', op: 'delete', key: { block: op.block } })
          out.push(...listRows(op.block, op.value))
          break
        }
        out.push(...onePropRows(op.block, op.name, op.value))
        break
      }
      case 'anno': {
        // annos 是一整列：op 按条报，列只能整列替换 ⇒ 这里要看模型
        if (done.has(op.block)) break
        done.add(op.block)
        const b = look.get(op.block)
        if (b) out.push({ table: 'Block', op: 'update', key: { id: op.block }, values: { annos: b.annos?.length ? JSON.stringify(b.annos) : null } })
        break
      }
    }
  }
  return [...dedupe(out), ...metaWrites(ws)]
}

/**
 * 升成列的系统属性：`_display`／`_kind`／`_date`／`_query`／`_type`／`_deletedAt`。
 *
 * 它们不进属性表（见文件头的表），所以「写一格属性」在这里要分叉一次：
 * 是列 ⇒ 改列；不是列 ⇒ 走属性表（由调用方做）。
 */
function columnWrites(block: string, name: string, value: unknown): RowWrite[] {
  if (name === DELETED_AT_PROP) {
    return [{ table: 'Block', op: 'update', key: { id: block }, values: { deleted: typeof value === 'number' ? value : null } }]
  }
  const col = COLUMN_PROPS[name]
  if (col === undefined) return []
  return [{ table: 'Block', op: 'update', key: { id: block }, values: { [col]: columnValue(name, value) } }]
}

/** 清掉一块的全部行（块行 ＋ 属性 ＋ 地址 ＋ 露面） */
function clearBlock(id: string): RowWrite[] {
  return [
    { table: 'Block', op: 'delete', key: { id } },
    { table: 'BlockProperty', op: 'delete', key: { block: id } },
    { table: 'BlockAlias', op: 'delete', key: { block: id } },
    { table: 'BlockList', op: 'delete', key: { block: id } },
  ]
}

/**
 * 同一行可能被这批发两条写（例如一次 patch 同时改 `_aliases` 与 `_display`）。
 * 去重只去掉**完全一样**的（同表同键同操作同值），不去掉「先删后写」那一对：
 * 那个顺序是语义的一部分（先删旧行、再写新行）。
 */
function dedupe(writes: readonly RowWrite[]): RowWrite[] {
  const seen = new Set<string>()
  const out: RowWrite[] = []
  for (const w of writes) {
    const k = `${w.table}\u0000${w.op}\u0000${JSON.stringify(w.key)}\u0000${JSON.stringify(w.values ?? null)}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(w)
  }
  return out
}

/* ------------------------------------------------------------ 读：行 → 模型 */

/**
 * 行 → 一片森林。
 *
 * 两条兜底都是**显式**的，不许静默丢块：
 *   · 兄弟链断了／成环 ⇒ 走不到的那些块按 id 排到同层末尾（宁可顺序错，也不要少一块）；
 *   · 父 id 指向不存在的块 ⇒ 那块当顶层（否则它和它整棵子树都会从界面上消失）。
 */
export function rowsToWorkspace(raw: RawLibraryRows): StoredWorkspace {
  const blocks = new Map<string, Block>()
  for (const r of raw.blocks) {
    const b: Block = {
      id: str(r.id)!,
      content: json(r.content, []),
      children: [],
      created: num(r.created) ?? 0,
      modified: num(r.modified) ?? 0,
    }
    const annos = json<Block['annos']>(r.annos, undefined)
    if (annos !== undefined && annos !== null && annos.length > 0) b.annos = annos
    blocks.set(b.id, b)
  }

  // 升列的属性：从列铺回属性袋（属性行里不会有它们，见 `NOT_A_PROP`）
  for (const r of raw.blocks) {
    const b = blocks.get(str(r.id)!)
    if (!b) continue
    for (const [col, prop] of Object.entries(COLUMN_TO_PROP)) {
      const v = r[col]
      if (v === null || v === undefined) continue
      b.props = { ...(b.props ?? {}), [prop]: prop === '_query' ? json(v, undefined) : v }
    }
    const deleted = num(r.deleted)
    if (deleted !== null) b.props = { ...(b.props ?? {}), [DELETED_AT_PROP]: deleted }
  }

  // 属性行：同 (block, name) 的行合起来是「单值」或「有序数组」，由 `multi` 位说清
  const propGroups = new Map<string, { block: string; name: string; multi: number; rows: { pos: number; value: unknown }[] }>()
  for (const r of raw.props) {
    const block = str(r.block)!
    const name = str(r.name)!
    const key = `${block}\u0000${name}`
    const group = propGroups.get(key) ?? { block, name, multi: num(r.multi) ?? 0, rows: [] }
    group.rows.push({ pos: num(r.pos) ?? 0, value: json(r.value, null) })
    propGroups.set(key, group)
  }
  for (const g of propGroups.values()) {
    const b = blocks.get(g.block)
    if (!b) continue
    g.rows.sort((a, c) => a.pos - c.pos)
    const value = g.multi === 1 ? g.rows.map((x) => x.value) : g.rows[0]?.value
    if (value === undefined) continue
    b.props = { ...(b.props ?? {}), [g.name]: value }
  }

  // 地址：按 pos 排（首个是主名）
  for (const r of [...raw.aliases].sort((a, c) => (num(a.pos) ?? 0) - (num(c.pos) ?? 0))) {
    const b = blocks.get(str(r.block)!)
    const name = str(r.name)
    if (!b || name === null) continue
    const prev = (b.props?.[ALIASES_PROP] as string[] | undefined) ?? []
    b.props = { ...(b.props ?? {}), [ALIASES_PROP]: [...prev, name] }
  }

  // 露面：集合（顺序不承载语义）
  for (const r of raw.lists) {
    const b = blocks.get(str(r.block)!)
    const list = str(r.list)
    if (!b || (list !== 'page' && list !== 'tag')) continue
    const prev = (b.props?.[LISTS_PROP] as BlockList[] | undefined) ?? []
    b.props = { ...(b.props ?? {}), [LISTS_PROP]: [...prev, list] }
  }

  // 树：`left` 是源，`children` 是投影（单向）
  const byParent = new Map<string | null, { id: string; left: string | null }[]>()
  for (const r of raw.blocks) {
    const id = str(r.id)!
    const parent = str(r.parent)
    // 父不在库里 ⇒ 当顶层：否则它和整棵子树都读不出来
    const key = parent !== null && blocks.has(parent) ? parent : null
    const list = byParent.get(key) ?? []
    list.push({ id, left: str(r.left) })
    byParent.set(key, list)
  }
  const children = new Map<string | null, Block[]>()
  for (const [parent, rows] of byParent) children.set(parent, chainOrder(rows).map((id) => blocks.get(id)!))
  for (const [parent, list] of children) {
    if (parent === null) continue
    const b = blocks.get(parent)
    if (b) b.children = list
  }

  const meta = raw.meta
  const savedAt = Number(meta[META_KEYS.savedAt] ?? 0)
  return {
    blocks: children.get(null) ?? [],
    activeId: meta[META_KEYS.activeId] ?? '',
    savedAt: Number.isFinite(savedAt) ? savedAt : 0,
  }
}

/**
 * 兄弟链 → 顺序数组。
 *
 * `left` 记的是**前一个兄弟**的 id，所以「谁接在谁后面」要把边反过来读。
 * 两个断点都不许丢块：指向不存在的前兄弟（悬空）当链头；两条都声称接在同一个人后面（分叉）
 * 时后来的那个也当链头。走不到的（成环）最后按 id 补在末尾。
 */
function chainOrder(rows: readonly { id: string; left: string | null }[]): string[] {
  const known = new Set(rows.map((r) => r.id))
  const next = new Map<string, string>()
  const heads: string[] = []
  for (const r of rows) {
    if (r.left === null || !known.has(r.left) || r.left === r.id || next.has(r.left)) heads.push(r.id)
    else next.set(r.left, r.id)
  }
  // 链头之间按 id 定序（`left: null` 的不必然只有一个：森林可以有多个根）
  heads.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const out: string[] = []
  const seen = new Set<string>()
  const walk = (start: string): void => {
    let cur: string | undefined = start
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur)
      out.push(cur)
      cur = next.get(cur)
    }
  }
  for (const h of heads) walk(h)
  for (const id of [...known].sort()) if (!seen.has(id)) walk(id)
  return out
}

/* ------------------------------------------------------------ 取值小工具 */

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'bigint') return Number(v)
  return null
}

function json<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string') return fallback
  try {
    return JSON.parse(v) as T
  } catch {
    return fallback
  }
}
