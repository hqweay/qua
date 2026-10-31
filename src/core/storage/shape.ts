/**
 * 落盘形状（**纯编解码，零 I/O**）。
 *
 * 这是「库里存的是什么」的唯一权威：版本号、块森林的深度校验。
 * 设备状态（主题／槽宽／钉住／折叠态）**不在库里**，见 `storage/device.ts`。
 * 它不认识 `localStorage`、不认识内核、也不认识 DOM —— 所以能直接单测
 * （`tests/workspace.test.ts` 就是拿它跑的）。
 *
 * 适配器只负责**字节的进与出**（见 `local-storage.ts` 的信封）；
 * 「这些字节是不是一份能打开的库」归这里。
 */
import { ALIASES_PROP, ACTIVE_VIEW_PROP, DISPLAY_PROP, LISTS_PROP, VIEWS_PROP, type Block, type Doc, type FoldState } from '../model.ts'
import { LEGACY_ALIAS_PROP, normalizeAlias } from '../alias.ts'
import { isMountsValue, MOUNTS_PROP } from '../mount.ts'
import { canonicalViewRef, EMBED_PROP } from '../embed.ts'
import { isActiveViewValue, isViewsValue, sourceConflicts } from '../view.ts'
import { isAnno, isRun } from '../runs.ts'

/**
 * 落盘形状的版本；**只在显式作废旧库时加一**（原型不做迁移，旧库直接作废重 seed）。
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
 * v13 → v14：地址与露面分家——`props._alias`（单数）改成 `props._aliases`（0..N），
 *            角色 `props._roles` 改成列表 `props._lists`，新增 `props._display`。
 *            旧键新代码**不读**（`isBlock` 直接判 corrupt）⇒ 作废重 seed，不写迁移。
 * v14 → v15：设备偏好（主题／槽宽／钉住）搬出库，改存 `qua.device`（`storage/device.ts`）。
 *            旧库里的 `prefs` 新代码不读（那份偏好会静默回到默认）⇒ 作废重 seed；
 *            同时保证落盘的每一份库都**没有**这一格，读路径不必判「有没有 prefs」。
 * v15 → v16：折叠态搬出库，改存 `qua.device` 的 `folded` 一格。
 *            理由是它与偏好同性质：**这台设备此刻怎么看**，不是内容；
 *            旧库里的 `folded` 新代码不读（那几个块会静默展开）⇒ 作废重 seed。
 *            ⇒ 版本号动一格，是为了让「库里没有折叠表」成为**唯一形状**，
 *            读路径不必再判「这库有没有带 folded」。
 * v16 → v17：删除改成**原位软删**——删除标记（`_deletedAt`）写在块上，块带子树留在树里原位；
 *            库级 `trash` 数组退场（回收站是标记的**派生视图**，不再是一份存储）。
 *            旧库把被删块存在 `trash` 里，新代码不读那一格（那些块会「消失」——
 *            在旧模型里它们本来也不可见）⇒ 作废重 seed，不写迁移。
 * v17 → v18：查询条件升形——`where` 新增 role 成员条件原子、spec 新增 `sort` 键
 *            （日记流的来源从命名的库读改成一份 QuerySpec 字面量）。
 *            旧库的 `_query` 块没有这两种形状，判「条件合法」的读路径会拒绝它们
 *            ⇒ 作废重 seed，不写迁移。
 * v18 → v19：行内内容模型换形——`Block.text`（含占位符）与库级 `marks[]`/`atoms[]`
 *            扁平数组退场，正文改存 `Block.content`＝run 序列、可引用区间住
 *            `Block.annos`。旧库的字符串正文新代码不读（内容会静默消失）
 *            ⇒ 作废重 seed，不写迁移。
 * v19 → v20：`Block` 新增**必填**的 `created`／`modified`（墙钟毫秒）。旧库的块没有
 *            出生时刻，而它补不回来——补一个假值会让「创建时间」从第一天就说谎
 *            ⇒ 作废重 seed，**不写**迁移分支。
 * v20 → v21：归属边的存储名从 `_parentTags` 换成 `_belongsTo`（端点放开、第一个是命名父）。
 *            旧键新代码不读 ⇒ 作废重 seed，不写迁移。
 * v21 → v22：新增系统属性 `_mounts`（块底挂载查询面板的配置）。
 *            旧库没有这一格读出来就是「没有自定义 tab」，本不必作废；加一版是为了让
 *            **写路径**只面对一种形状（与 v11→v12 加 `trash` 同一条理由）。
 * v22 → v23：行内图片从「`{t:'image', asset:{hash,name,state}}`」改成
 *            「`{t:'asset', asset: hash, label?, w?, h?}`」——载荷与派生状态搬出正文。
 *            旧库的 `t:'image'` 新代码判非法（形状校验会拒绝整份库）⇒ 作废重 seed，不写迁移。
 * v23 → v24：块 id 的生成修了「48 位时间戳被位与收成 int32」——旧库里有 `000-7fde…`
 *            这种 32 字符**带 `-`** 的 id。下游按形状认块 id（拖拽/侧槽窗口），
 *            带 `-` 的 id 会被判成「不是块」⇒ 作废重 seed，不写迁移。
 * v24 → v25：`RefRun` 新增**可选**字段 `anchor`（这一处引用的锚文本）。
 *            加字段即升版是本文件的原型纪律（上面每一版都是同一条理由）：
 *            旧库照旧作废重 seed，换来的是**写路径只面对一种形状**——
 *            「这一枚 run 有没有 anchor」在读侧永远只有一个答案。
 * v25 → v26：`AssetRun` **去掉** `w`/`h`。它们是那份字节的属性，由资产索引回答
 *            （`AssetView`）；留在 run 上就是同一件事的第二个答案——两份能不一致，
 *            而不一致时没有任何一层会报错。写路径只面对一种形状：run 说「哪一份字节」，
 *            索引说「它是什么、多大」。
 * v26 → v27：新增系统属性 `_views`／`_activeView`（视图配置与激活视图 id）。
 *            旧库没有这两格读出来就是「大纲」，本不必作废；加一版与 v11→v12 同一条理由：
 *            让**写路径只面对一种形状**（配置都由一处写、一处校验），
 *            读路径也就不必在「有没有这一格」上分叉。
 * v27 → v28：`select` 的值从「选项名」改成**选项块 id**（选项＝定义块的子块），
 *            旧的「选项名数组」退场。值空间的含义变了 ⇒ 旧库不能读成新库：
 *            同名旧值指向一个不存在的选项时显示「选项已删除」，看起来像丢数据。
 *            作废重 seed（旧库本来没有可用的 select 选项，代价为零）。
 * v28 → v29：**拥有者模型**——查询条件/视图配置/挂载栏/露面指针统一归位。
 *            · `_queryResult` 删除（结果改按表面实例冻结，不再入库）；
 *            · `QuerySpec` 删顶层 `todo`（只留 `where:{todo}` 原子）；
 *            · `_mounts` 从 `{label,spec}[]` 改成 `MountEntry[]`（local／linked／derived ＋ 稳定 id）；
 *            · 日记面板的栏从**隐藏配置块**搬到 `Prefs.journalMounts`；
 *            · `_embed` 从 `{block}` 改成 `ViewRef{block,view}`；露面块不再有自己的 `_views`；
 *            · 视图 kind 新增 `list`，结构映射表的配置键从 `list` 改叫 `listTable`。
 *            五条都是「同一件事有两处答案」或「派生值当内容」，没有一条能靠映射救回来
 *            ⇒ 作废重 seed，不写迁移。
 * v29 → v30：**查询条件**里 `{todo}` 原子退场（三态改由属性条件表达），
 *            「有没有这一栏」改判「值 ∪ 自有槽 ∪ 标签声明」。
 *            旧库的 `_query` 带着已删的原子 ⇒ 读不出来（`readSpec` 会说不合法，
 *            求值器只会静默空集）⇒ 作废重 seed。
 */
export const WORKSPACE_VERSION = 30

/** 示例库：一片块森林（行内内容与 annos 住块上，没有库级锚点数组） */
export interface Workspace {
  version: typeof WORKSPACE_VERSION
  /** 块森林（整个库是一片森林，没有「页实体」这一层） */
  blocks: Block[]
  /** 中心槽持有的「当前对象」（只有中心槽有这个概念） */
  activeId: string
  savedAt: number
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

/** 旧落盘键：`_roles` 只用来**判 corrupt**，不提供任何读路径（不静默升级旧库） */
const LEGACY_ROLES_PROP = '_roles'

/**
 * 一个块的形状是否**能被新代码读**。
 *
 * 判据：只校验「形状」，不校验语义不变量（例如「列表非空 ⇒ 有名字」由写入路径维护，
 * 不在这里补）；但**旧键一律判 corrupt**——静默读旧形状会让「地址」与「角色」
 * 变成两份互相矛盾的真相，而用户看到的是「有些页莫名其妙不见了」。
 */
function isBlock(x: unknown): x is Block {
  if (!x || typeof x !== 'object') return false
  const b = x as Block
  if (typeof b.id !== 'string' || !Array.isArray(b.content) || !b.content.every(isRun) || !Array.isArray(b.children)) return false
  // **时间戳是必填字段**，少一个就是旧库/坏字节：把它当成「可以缺」的读进来，
  // 后面每个读它的地方都得处理一个不该存在的分支（`created` 不可能缺席）。
  if (typeof b.created !== 'number' || typeof b.modified !== 'number') return false
  if (b.annos !== undefined && (!Array.isArray(b.annos) || !b.annos.every(isAnno))) return false
  if (b.props === undefined) return true
  if (!b.props || typeof b.props !== 'object' || Array.isArray(b.props)) return false
  // 旧形状不静默读：v13 的 `_roles` / `_alias` 在新模型里没有对应物
  if (LEGACY_ROLES_PROP in b.props || LEGACY_ALIAS_PROP in b.props) return false

  const aliases = b.props[ALIASES_PROP]
  if (aliases !== undefined) {
    // 空数组与「没有这一格」是两种写法，留着就会让「有没有名字」有两份答案
    if (!Array.isArray(aliases) || aliases.length === 0) return false
    if (!aliases.every((a) => typeof a === 'string' && a.trim() !== '')) return false
    // 块内别名必须两两不相交（规范化后）：否则同一块有两个相同的地址
    const seen = new Set<string>()
    for (const a of aliases as string[]) {
      const n = normalizeAlias(a)
      if (n === '' || seen.has(n)) return false
      seen.add(n)
    }
  }

  const lists = b.props[LISTS_PROP]
  if (lists !== undefined) {
    if (!Array.isArray(lists) || !lists.every((l) => l === 'page' || l === 'tag')) return false
    if (new Set(lists).size !== lists.length) return false
  }

  const display = b.props[DISPLAY_PROP]
  if (display !== undefined && display !== 'alias' && display !== 'text') return false
  /**
   * 挂载区配置：形状判据与**读路径**共用一份（`core/mount.ts` 的 `isMountsValue`）——
   * 读路径那边坏了只当没有，落盘这边坏了判 corrupt，但「什么算坏」只能有一个答案。
   */
  const mounts = b.props[MOUNTS_PROP]
  if (mounts !== undefined && !isMountsValue(mounts)) return false
  /**
   * 露面指针：`{ block, view }`。**只判块那一半**——`view` 缺席是「跟随默认看法」，
   * 不是坏形状（读路径按 `''` 处理）；把缺席判成 corrupt 会让所有老老实实的露面打不开库。
   */
  const embed = b.props[EMBED_PROP]
  if (embed !== undefined && canonicalViewRef(embed) === null) return false
  /**
   * 视图配置：**这里只判容器形状**（是不是一份列表 / 是不是字符串）。
   * 逐项内容归 `canonicalViews` 逐条重建 —— 那里坏一项只丢一项、退回大纲；
   * 在这里按「一项坏了就整库 corrupt」处理，会让一个错键把整个库变成打不开。
   */
  const views = b.props[VIEWS_PROP]
  if (views !== undefined && !isViewsValue(views)) return false
  const activeView = b.props[ACTIVE_VIEW_PROP]
  if (activeView !== undefined && !isActiveViewValue(activeView)) return false
  // 不变量：在列表里 ⇒ 至少有一个名字（不能出现在页/标签列表里却没有任何地址）。
  // 这里只拦「有列表、完全没有 _aliases」；别名数组本身的空/空串已在上面判 corrupt。
  if (Array.isArray(lists) && lists.length > 0 && !Array.isArray(aliases)) return false
  /**
   * 不变量：**源的声明互斥**（`_query`／`_items`／`_embed` 只许有一个）。
   *
   * 并存时 `sourceOf` 会悄悄选一个，而另一个「改了却不生效」—— 那是静默的，
   * 用户只会看到「条件改了结果没变」。在落盘这一侧拦住，坏形状就进不了库。
   */
  if (sourceConflicts(b)) return false
  return true
}

/**
 * 深度校验一棵子树（属性袋只检查「是对象」，不校验每个 key —— 那是 schema 层的事） */
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
  return {
    status: 'ok',
    ws: ws as Workspace,
  }
}

/**
 * 一份页块的子树 → 编辑器文档（中心槽渲染它的子树）。
 *
 * `folded` 由调用方给：折叠表是**设备**级的（块 id 全局唯一），但每个视图只该读它自己那份
 * （正文／反链／查询各带各的），所以这里不偷偷把别处那份抄进来。
 */
export function pageDoc(p: Block, folded: FoldState = {}): Doc {
  return { roots: p.children, folded }
}
