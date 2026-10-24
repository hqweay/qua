/**
 * **属性（property）、标签属性（tag properties）、块属性（block properties）**。
 *
 * 三个词指的是三样东西，别混：
 *   · **属性** —— 那个全局定义：一个住在森林顶层的普通块，正文＝显示名、`_kind`＝种类；
 *   · **标签属性** —— 某个标签（或页）**声明**了哪些属性可用（`_fieldDefs`）；
 *   · **块属性** —— 某个块自己有哪些属性的**值**（`props[propId]`）。
 *
 * 根不变量：**属性的身份是全局 `propId`，不是它的名字。**
 *   · `propId` ＝ 定义块的 **id**（不另造 id 空间）；
 *   · 定义块不能住在任何一个使用者的子树里，否则删掉那个标签会带走别人的定义；
 *   · 声明只提供「可用性」，值永远在**块上**（一块一槽）。
 *
 * 标签属性**不向成员继承**：`fieldRows` 只算**块实际打着的标签**，没有祖先闭包。
 * ⇒ 叫「标签属性」说的是「这个标签名下的属性清单」，不是「所有成员都有的属性」。
 *
 * ⚠️ `_fieldDefs` 里存的是 **ref（id）**，不是名字：改名零迁移，重名不撞车。
 * ⚠️ 本文件零 DOM：属性面板只消费这里的派生结果，写入通过命令。
 */
import { hasList, isPropDefBlock, prop, type Block, type BlockProps, type TodoState } from './model.ts'
import { walkForest } from './walk.ts'
import { derivedId, uuidv7Hex } from './ids.ts'
import { resolveTagIds, tagsById } from './tags.ts'

/** 声明列表的系统属性（有序 ref 列表；pos ＝ 数组下标） */
export const FIELD_DEFS_PROP = '_fieldDefs'

/**
 * **一个属性在哪儿被编辑**（定义块上的系统属性）。
 *
 * 两个值，互斥：
 *   · `block-left` —— 编辑入口在**块左侧的 gutter**。给「一次点击就能改」的高频二元开关用；
 *   · `panel`（缺省）—— 在右侧属性面板里，需要展开、填值。
 *
 * ⚠️ **同一个属性不会同时出现在两处**：否则同一个值有两个编辑面，必然出现
 *    「面板里改了、gutter 没跟上」这类分叉。位置是**定义的一部分**，不是视图偏好。
 */
export type UiPosition = 'block-left' | 'panel'

export const UI_POSITION_PROP = '_uiPosition'

/** 定义块声明的编辑位置（缺省 `panel`：没写就是「要展开填」的那一类） */
export function uiPositionOf(def: Block | undefined): UiPosition {
  return def && prop<string>(def, UI_POSITION_PROP) === 'block-left' ? 'block-left' : 'panel'
}

/* ------------------------------------------------------------ 核心词汇 */

/**
 * **「任务状态」**：这件事做完了没有。
 *
 * 它是**全局属性**，不是块上的裸字段、也不是 `_` 结构槽 —— 判据：值域与语义是**用户词汇**
 * （「做完了」是什么意思，是给人看的），而且要能进查询、进导出、进属性面板。
 * 凡是「有定义块承载值域」的都走 prop-def，所以这里有定义块、有一个稳定 propId。
 *
 * ⚠️ id 由名字确定性派生：代码在重开之后要靠它找到这个定义，而名字是可改的
 *    （改显示名不动任何值，这是属性设计的前提）。
 * ⚠️ 定义块的正文（显示名）与标签名是**数据**，住在 `seed.ts` —— 它们会成为库里的内容，
 *    不是界面文案；界面语言变了，已存在的块名不会跟着变。
 */
export const TASK_STATUS_PROP_ID = derivedId('prop', 'core/task-status')

/**
 * 「任务状态」的派生读法：**值就是属性槽**，没有第二份块字段。
 *
 * 三态与旧的 `'todo' | 'done' | 无` 对得上：
 *   · `true` ⇒ `'done'`（做完了）；
 *   · `false` ⇒ `'todo'`（**是任务、还没做完**）；
 *   · **有槽但没值** ⇒ 也是 `'todo'`（**刚挂上、还没点过的那一下**）；
 *   · 没有这一槽 ⇒ `undefined`（这块压根不是任务）。
 *
 * ⚠️ **判据是「有没有这一槽」，不是「有没有值」。** 这是 `e4cb946`（槽位说有没有、
 *    `props[propId]` 说值是什么）之后最容易踩的一处：槽位与值是两个问题。
 *    把「未填」并进 `undefined` 会让**刚加上的任务立刻不算任务** —— 屏幕上有一个空心方框
 *    （渲染看的是槽位），查询「未完成」却查不到它（这里看的是值），同一个块两种答案。
 *
 * 为什么 `false` 与「未填」都算 `'todo'`、而不并进缺失：那样「还没做完」与「不是任务」
 * 会变成同一个状态，而「按任务筛选」要的正是它们分开。查询层的 `TodoFilter` 因此一行都不用改。
 */
export function todoOf(block: Block): TodoState | undefined {
  const v = valueOf(block, TASK_STATUS_PROP_ID)
  if (v === true) return 'done'
  // 槽位在 ⇒ 它是任务：`false` 是「点了但没做完」，`undefined` 是「还没点过」，两者都是 todo
  if (v === false || ownPropIds(block).includes(TASK_STATUS_PROP_ID)) return 'todo'
  return undefined
}

export type PropKind = 'text' | 'number' | 'date' | 'checkbox' | 'select' | 'ref' | 'url'

export const PROP_KINDS: readonly PropKind[] = ['text', 'number', 'date', 'checkbox', 'select', 'ref', 'url']

export function isPropKind(v: unknown): v is PropKind {
  return typeof v === 'string' && (PROP_KINDS as readonly string[]).includes(v)
}

/* ------------------------------------------------------------ 定义块 */

/**
 * 造一个属性定义块（**森林顶层**，正文＝显示名；`propId` 就是它的 id）。
 *
 * `id` 只给**核心词汇**用：它们的 id 必须跨重开稳定（名字 → id 走 `derivedId`），
 * 而普通用户新建的定义仍拿到随机 id —— 那条路不需要、也不该承诺稳定性。
 * 参数放在最后，现有调用点（`label`／`kind`／`extra`）不受影响。
 */
export function mkPropDef(label: string, kind: PropKind = 'text', extra: BlockProps = {}, id?: string): Block {
  return {
    id: id ?? uuidv7Hex(),
    text: label,
    children: [],
    props: { _kind: kind, ...extra },
  }
}

/** 是不是属性定义块（**看数据 `_kind`**，不看名字、也没有额外的标记） */
export function isPropDef(b: Block): boolean {
  return isPropDefBlock(b)
}

/** 定义块上的显示名（**正文即 label**，不存第二份） */
export function propLabel(def: Block): string {
  return def.text.trim()
}

/** 定义的 kind（落盘缺省按 text：旧数据/手写定义不该让面板整段消失） */
export function propKindOf(def: Block): PropKind {
  const k = prop<unknown>(def, '_kind')
  return isPropKind(k) ? k : 'text'
}

/** 定义的选项目录（select 用；`_choices` 是字符串数组） */
export function propChoices(def: Block): string[] {
  const raw = prop<unknown>(def, '_choices')
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
}

/** 森林里全部属性定义（先序） */
export function allPropDefs(forest: readonly Block[]): Block[] {
  const out: Block[] = []
  walkForest(forest, (b) => {
    if (isPropDef(b)) out.push(b)
  })
  return out
}

/** 按 `propId` 找定义（`propId` 就是块 id） */
export function findPropDef(forest: readonly Block[], propId: string): Block | undefined {
  return allPropDefs(forest).find((d) => d.id === propId)
}

/* ------------------------------------------------------------ 声明 */

/** 一个标签/页声明了哪些属性 —— 即它的标签属性清单（有序 ref 列表；悬空 ref 不静默补，交给解析方跳过） */
export function declaredFieldIds(owner: Block): string[] {
  const raw = prop<unknown>(owner, FIELD_DEFS_PROP)
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === 'string')
}

/**
 * 把一条属性声明到标签/页上，从此成为它的标签属性（幂等；追加到末尾 ＝ 显示顺序）。
 *
 * **只有页与标签能声明属性**：声明必须有自动获得方（标签的成员、页的子块），
 * 普通块没有 ⇒ 无消费方的声明是噪音。返回值说明有没有真的改动。
 * ⚠️ 判据是**露面**（`hasList`），不是「有名字」：一个有名内容块不该凭空获得
 *    「成员自动继承这些字段」的语义。
 */
export function declareField(owner: Block, propId: string): boolean {
  if (!hasList(owner, 'page') && !hasList(owner, 'tag')) return false
  const ids = declaredFieldIds(owner)
  if (ids.includes(propId)) return false
  owner.props = { ...(owner.props ?? {}), [FIELD_DEFS_PROP]: [...ids, propId] }
  return true
}

/** 解除声明（**只解除这一条**；定义块与成员块上的值都不动） */
export function undeclareField(owner: Block, propId: string): boolean {
  const ids = declaredFieldIds(owner)
  if (!ids.includes(propId)) return false
  owner.props = { ...(owner.props ?? {}), [FIELD_DEFS_PROP]: ids.filter((id) => id !== propId) }
  return true
}

/** 一个标签/页声明的属性定义（按声明顺序；解析不到的定义跳过 —— 悬空 ref 是状态） */
export function declaredFields(owner: Block, forest: readonly Block[]): Block[] {
  const byId = new Map(allPropDefs(forest).map((d) => [d.id, d]))
  const out: Block[] = []
  for (const id of declaredFieldIds(owner)) {
    const d = byId.get(id)
    if (d) out.push(d)
  }
  return out
}

/* ----------------------------------------------------- 标签属性与块属性 */

/** 自有属性槽的系统属性（有序 ref 列表；pos ＝ 数组下标） */
export const OWN_PROPS_PROP = '_ownProps'

/** 这一块自己登记了哪些属性（**有没有**，与**有没有值**是两个问题） */
export function ownPropIds(block: Block): string[] {
  const raw = prop<unknown>(block, OWN_PROPS_PROP)
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === 'string')
}

/**
 * 给**普通块**加一条自有属性（幂等；追加到末尾 ＝ 显示顺序）。
 *
 * 为什么要一个槽位，而不是写个空值占位：`props[propId] = ''` 会让「键在不在」与
 * 「值空不空」变成同一个问题的两个答案，而 `hasValue` 判的是后者 —— 于是行显示「待填」，
 * 值却已经写进库了。槽位是**声明**，值仍旧只在 `props[propId]` 里，两者各答各的问题。
 *
 * 与标签的 `_fieldDefs` 同构：标签说「我的成员有这些属性」，块说「我自己有这些属性」。
 * 判据也一致：都存有序 id 列表、都不写假值。
 */
export function declareOwnProp(block: Block, propId: string): boolean {
  const ids = ownPropIds(block)
  if (ids.includes(propId)) return false
  block.props = { ...(block.props ?? {}), [OWN_PROPS_PROP]: [...ids, propId] }
  return true
}

/**
 * 块上**自有**的属性 id（有序）：登记过的槽位在前，其后是有值但没登记的
 * （值先于声明写入的路径、以及手工写进去的数据），系统属性不算。
 *
 * ⚠️ 「这块有没有这条属性」只走这一个读法：槽位算、有值也算。只认值会让
 *    刚加还没填的行从面板里消失；只认槽位则会让任何写进来的值因为没有登记而不可见。
 */
export function ownFieldIds(block: Block): string[] {
  const out = ownPropIds(block)
  for (const k of Object.keys(block.props ?? {})) {
    if (k.startsWith('_') || out.includes(k)) continue
    out.push(k)
  }
  return out
}

export function valueOf(block: Block, propId: string): unknown {
  return block.props?.[propId]
}

export function hasValue(block: Block, propId: string): boolean {
  const v = valueOf(block, propId)
  if (v === undefined || v === null) return false
  if (typeof v === 'string' && v === '') return false
  if (Array.isArray(v) && v.length === 0) return false
  return true
}

/** 属性面板的一行（派生，不落库） */
export interface FieldRow {
  propId: string
  /** 显示名：定义块的正文；定义缺失时退回 propId（数据不静默消失） */
  label: string
  kind: PropKind
  value: unknown
  /** 有值 ⇔ 不是「待填」 */
  filled: boolean
  /** 定义块（缺失＝悬空定义，仍显示值） */
  def?: Block
  /** 直接标签里**声明了这条属性**的那些（按正文顺序）；空＝本块自有 */
  sources: Block[]
  /** 稳定排序键（声明的先后；同 propId 取最早那次） */
  order: number
}

/**
 * 块属性的全部行：**标签属性 ∪ 块属性**，同一个 `propId` 只出现一次。
 *
 * ⚠️ **只算直接标签**：`#演员` 的成员不会因为 `#人物` 声明了属性就冒出那些属性。
 *    「算作」只影响成员列表（`core/tag-tree.ts` 的 `membersOf`），不影响这里。
 * ⚠️ 顺序：标签按打的先后、标签内按 `_fieldDefs` 顺序；同一 `propId` 取**最早那次**声明，
 *    因此多标签声明同一属性时行序不会随标签集合抖动（只随标签顺序变）。
 * ⚠️ 块属性排在标签属性之后：顺序由写入路径决定（先声明后显示），性质上两类现在都可能「待填」。
 */
export function fieldRows(block: Block, forest: readonly Block[]): FieldRow[] {
  const defs = new Map(allPropDefs(forest).map((d) => [d.id, d]))
  const rows = new Map<string, FieldRow>()
  let order = 0

  for (const tag of resolveTagIds(block, tagsById(forest))) {
    for (const propId of declaredFieldIds(tag)) {
      const existing = rows.get(propId)
      if (existing) {
        existing.sources.push(tag)
        continue
      }
      const def = defs.get(propId)
      rows.set(propId, {
        propId,
        label: def ? propLabel(def) || propId : propId,
        kind: def ? propKindOf(def) : 'text',
        value: valueOf(block, propId),
        filled: hasValue(block, propId),
        def,
        sources: [tag],
        order: order++,
      })
    }
  }

  for (const propId of ownFieldIds(block)) {
    if (rows.has(propId)) continue
    const def = defs.get(propId)
    rows.set(propId, {
      propId,
      label: def ? propLabel(def) || propId : propId,
      kind: def ? propKindOf(def) : 'text',
      value: valueOf(block, propId),
      filled: hasValue(block, propId),
      def,
      sources: [],
      order: order++,
    })
  }

  return [...rows.values()].sort((a, b) => a.order - b.order)
}

/** 属性 id 集合（模型口径的 `fieldsOf`：标签属性 ∪ 块属性） */
export function fieldIdsOf(block: Block, forest: readonly Block[]): string[] {
  return fieldRows(block, forest).map((r) => r.propId)
}

/** gutter 上的一件（派生，不落库） */
export interface GutterField {
  propId: string
  /** 定义块（必在：没有定义的行不进 gutter —— 没有 kind 就不知道该画成什么） */
  def: Block
  kind: PropKind
  value: unknown
  /** 有没有值。渲染方用它区分「未填」与「已填」，**不是**准入条件 */
  filled: boolean
}

/**
 * 这个块上**该在 gutter 编辑**的属性。
 *
 * 为什么和 `fieldRows` 分开而写在 core：gutter 与右侧面板吃的是**同一份行派生**
 * （声明 ∪ 自有、同一 propId 只一行），差别只有「哪些行归我」。若各写一套过滤，
 * 两个编辑面迟早会对同一条属性给出不同答案（一边有值、一边说待填）。
 *
 * 判据：定义声明了 `_uiPosition: 'block-left'` ⇒ 归 gutter，**不管有没有值**。
 *
 * ⚠️ 「有值」不是准入条件，这是这条规则的全部要点：gutter 上要出现的是
 *    **这个块有这条属性**，不是「这条属性有值」。前者是**入口**，后者是**状态**。
 *    要求有值就变成「第一个值必须先在别处填」——而这类属性存在的理由正是
 *    「一次点击就能改」的高频二元开关，没有第一下就没有第二下。
 *    ⇒ 未填的行照样返回，`filled` 交给渲染方决定怎么画（空心／不画／灰掉）。
 *
 * ⚠️ 调用方是**那一列的局部渲染**（只认一个块），不是整片森林的装饰层。
 *    整屏渲染请用批量的 `gutterFieldsFor`：本函数每调一次都要重扫定义块与标签块，
 *    逐行调就是 O(n²)。
 * ⚠️ 右侧面板用的是**同一份行派生**再按位置过滤（见 `ui/properties.ts`），
 *    所以两个编辑面不会对同一条属性给出不同答案。
 */
export function gutterFieldsOf(block: Block, forest: readonly Block[]): GutterField[] {
  // 口径必须与批量的 `gutterFieldsFor` 一致：它吃的是同一份 `fieldRows`（声明 ∪ 自有、同 id 一行），
  // 只是「扫库」在行级重复做了一遍 —— 所以单块用它、整屏用批量。
  const out: GutterField[] = []
  for (const row of fieldRows(block, forest)) {
    if (!row.def) continue
    if (uiPositionOf(row.def) !== 'block-left') continue
    out.push({ propId: row.propId, def: row.def, kind: row.kind, value: row.value, filled: row.filled })
  }
  return out
}

/**
 * 一次渲染批里所有该在 gutter 编辑的属性：**一次扫库，逐行分发**。
 *
 * 为什么不复用 `gutterFieldsOf` 逐行算：它每次调用都要重新扫一遍定义块与标签块，
 * 于是整屏渲染从 O(n) 变成 O(n²)。这里把「扫库」提到批级，行级只做查表。
 *
 * 返回 `Map<blockId, GutterField[]>`；没有 gutter 属性的块**不出现在 map 里**
 * （空数组与缺席同义，少一次存在性判断）。
 *
 * 行的口径与 `fieldRows` 一致：**标签属性在前（按标签的先后、标签内按声明顺序），
 * 块属性在后**，同一 `propId` 只出现一次。
 */
export function gutterFieldsFor(
  blocks: readonly Block[],
  forest: readonly Block[],
): Map<string, GutterField[]> {
  // 定义块与标签块各扫**一次**：行级只查表
  const defs = new Map(allPropDefs(forest).map((d) => [d.id, d]))
  const tagById = tagsById(forest)

  const out = new Map<string, GutterField[]>()
  for (const block of blocks) {
    const fields = new Map<string, GutterField>()
    const take = (propId: string): void => {
      if (fields.has(propId)) return
      const def = defs.get(propId)
      // 没有定义就不知道该画成什么，不进 gutter（与 `fieldRows` 跳过悬空定义同因）
      if (!def) return
      if (uiPositionOf(def) !== 'block-left') return
      fields.set(propId, {
        propId,
        def,
        kind: propKindOf(def),
        value: valueOf(block, propId),
        filled: hasValue(block, propId),
      })
    }
    for (const tag of resolveTagIds(block, tagById)) for (const propId of declaredFieldIds(tag)) take(propId)
    for (const propId of ownFieldIds(block)) take(propId)
    if (fields.size > 0) out.set(block.id, [...fields.values()])
  }
  return out
}

/* ------------------------------------------------------------ 写值 */

/** 写一个值（**一块一槽**：键是 propId；不碰任何标签） */
export function setValue(block: Block, propId: string, value: unknown): void {
  block.props = { ...(block.props ?? {}), [propId]: value }
}

/**
 * 删一个值（只删这一槽；标签的声明与定义都不动）。
 *
 * ⚠️ **自有属性槽跟着一起删**：对普通块来说「这条属性」是用户手动加进来的，清空值
 *    是这个动作唯一的退路 —— 留下一个永远「待填」的行，用户就再也没法把它去掉。
 *    标签声明的属性正相反：声明在标签上，值清空后行仍在（那才是「待填」的意义）。
 */
export function clearValue(block: Block, propId: string): void {
  const hadSlot = ownPropIds(block).includes(propId)
  if ((!block.props || !(propId in block.props)) && !hadSlot) return
  const next = { ...(block.props ?? {}) }
  delete next[propId]
  if (hadSlot) {
    const slots = ownPropIds(block).filter((id) => id !== propId)
    if (slots.length === 0) delete next[OWN_PROPS_PROP]
    else next[OWN_PROPS_PROP] = slots
  }
  // 属性袋不留空壳：`{}` 与「没有属性」在快照比较里是两种东西
  if (Object.keys(next).length === 0) delete block.props
  else block.props = next
}

/* ------------------------------------------------------------ 摘标签后的清理 */

/**
 * 摘掉一个标签后，**可清理**的值有哪些。
 *
 * 判据（与「值留存」口径配套）：
 *   · 该标签声明了它；② 块上有值；③ **剩余标签都不声明它**（被别处声明 ⇒ 不是这一节的值）。
 * 摘标签**默认不清理**（值留存）—— 本函数只回答「清理的话会清哪些」，由用户决定。
 */
export function cleanableValues(block: Block, removedTag: Block, forest: readonly Block[]): string[] {
  const declared = declaredFieldIds(removedTag)
  if (declared.length === 0) return []
  const remaining = resolveTagIds(block, tagsById(forest)).filter((t) => t.id !== removedTag.id)
  const stillDeclared = new Set(remaining.flatMap((t) => declaredFieldIds(t)))
  return declared.filter((pid) => hasValue(block, pid) && !stillDeclared.has(pid))
}
