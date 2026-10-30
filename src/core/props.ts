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
import { isDeleted, hasList, isPropDefBlock, prop, type Block, type BlockProps, type TodoState } from './model.ts'
import { displayNameOf } from './alias.ts'
import { plainText, textRuns } from './runs.ts'
import { walkForest } from './walk.ts'
import { derivedId, uuidv7Hex } from './ids.ts'
import { allTags, resolveTagIds, tagsById } from './tags.ts'
import { t } from './msg.ts'

/**
 * 两个属性值是不是同一件事（**结构相等**：属性值可以是数组／对象，`Object.is` 不够）。
 *
 * 判据用途：只有真变了才算一次改动（写时刻、发 `prop.set`）。
 */
function sameValue(a: unknown, b: unknown): boolean {
  return Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b)
}

/** 声明列表的系统属性（有序 ref 列表；pos ＝ 数组下标） */
export const FIELD_DEFS_PROP = '_fieldDefs'

/**
 * **一个属性在哪儿被顺手改**（定义块上的系统属性）。
 *
 * 两个值：
 *   · `block-left` —— **快捷入口**画在块左侧的 gutter。给「一次点击就能改」的高频二元开关用；
 *   · `panel`（缺省）—— 只在右侧属性面板里，需要展开、填值。
 *
 * ⚠️ 它决定的是**入口画在哪**，不是「只有那一处能改」。曾经的规则是「一个值不开两个编辑面」
 *    ⇒ 归 `block-left` 的行从面板里排除，面板只写一句「在块左侧编辑」。那一句是死路：
 *    用户在卡里看到这条属性、却改不了它，得先想起来「左侧还有个小方框」。
 *    现在两处共存，前提是**读同一份行派生、写同一条命令、写完两边都重画**
 *    （`fieldRows` 是那份派生，`gutterFieldsOf` 只是它的一个视图）。
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
 * 会变成同一个状态，而「按任务筛选」要的正是它们分开 —— 所以三态在值上，不在类型里。
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
  const now = Date.now()
  return {
    id: id ?? uuidv7Hex(),
    content: textRuns(label),
    children: [],
    created: now,
    modified: now,
    props: { _kind: kind, ...extra },
  }
}

/** 是不是属性定义块（**看数据 `_kind`**，不看名字、也没有额外的标记） */
export function isPropDef(b: Block): boolean {
  return isPropDefBlock(b)
}

/** 定义块上的显示名（**正文即 label**，不存第二份） */
export function propLabel(def: Block): string {
  return plainText(def.content).trim()
}

/** 定义的 kind（落盘缺省按 text：旧数据/手写定义不该让面板整段消失） */
export function propKindOf(def: Block): PropKind {
  const k = prop<unknown>(def, '_kind')
  return isPropKind(k) ? k : 'text'
}

/* ------------------------------------------------------------ 选项（select） */

/**
 * **一个 `select` 属性能选哪些值 ＝ 定义块的直接子块。**
 *
 * 没有 `_choiceOf` 之类的新标记：父块是定义 ⇒ 它的直接子块就是选项。
 * 角色由位置派生，与「外观按类型、chrome 按身份」同一条判据 ——
 * 另存一份「这是选项」的声明，就会多出一份能与位置不一致的答案。
 *
 * 软删的选项不算：它们留在原位等恢复，但此刻不提供选择。
 */
export function choicesOf(def: Block): Block[] {
  return def.children.filter((c) => !isDeleted(c))
}

/**
 * 一个选项的可见范围（**唯一的可见性来源**）。
 *
 * 三态互斥，所以没有「既 only 又 except」的冲突态，也没有优先级规则。
 * 缺省/坏值按 `all`：旧数据或手写数据不该让控件整片空掉。
 */
export type ChoiceScope = { mode: 'all' } | { mode: 'only'; tags: string[] } | { mode: 'except'; tags: string[] }

/** 选项作用域住在选项块上（系统属性；形状见 `ChoiceScope`） */
export const CHOICE_SCOPE_PROP = '_choiceScope'

/**
 * 把一格未知值读成三态作用域；`null` ＝ 形状不认识（命令层据此拒绝写入）。
 *
 * 归一化只做两件不承载语义的事：标签去重、`only`/`except` 的空集合退回 `all`
 * （「空集」与「所有人」是同一个答案，留两种写法就多一条要同步的判据）。
 * **悬空的标签 id 原样保留**：标签被删不等于作用域失效 —— 静默摘掉会让一个
 * `only` 悄悄变成「所有人都能选」。
 */
export function parseChoiceScope(raw: unknown): ChoiceScope | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const v = raw as { mode?: unknown; tags?: unknown }
  if (v.mode === 'all') return { mode: 'all' }
  if (v.mode !== 'only' && v.mode !== 'except') return null
  if (!Array.isArray(v.tags)) return null
  const tags = [...new Set(v.tags.filter((x): x is string => typeof x === 'string' && x !== ''))]
  if (tags.length === 0) return { mode: 'all' }
  return { mode: v.mode, tags }
}

/** 选项的可见范围；坏值回落「所有用这个属性的块都能选它」 */
export function choiceScopeOf(choice: Block): ChoiceScope {
  return parseChoiceScope(prop<unknown>(choice, CHOICE_SCOPE_PROP)) ?? { mode: 'all' }
}

/**
 * 这个选项对一组标签可见吗。
 *
 * 多标签取**并集**：`only` 任一命中即可见，`except` 任一命中即隐藏。
 * 空标签集：`all` 可见、`only` 不可见、`except` 可见（没有要排除的）。
 */
export function choiceVisible(choice: Block, tagIds: ReadonlySet<string>): boolean {
  const scope = choiceScopeOf(choice)
  if (scope.mode === 'all') return true
  const hit = scope.tags.some((id) => tagIds.has(id))
  return scope.mode === 'only' ? hit : !hit
}

/** 一块带着哪些标签 id（**标签页编辑时把自身算进去**：只看自己的选项） */
function tagIdSetOf(block: Block, forest: readonly Block[]): Set<string> {
  const out = new Set(resolveTagIds(block, tagsById(forest)).map((tag) => tag.id))
  if (hasList(block, 'tag')) out.add(block.id)
  return out
}

/**
 * 这个块在某个属性上**能选**的选项（兄弟顺序）。
 *
 * 适用性来自块自己打着的标签（`_fieldDefs` 的声明），可见性来自每个选项的
 * `_choiceScope`；定义缺失或不是 `select` ⇒ 空数组（控件空态，不是崩）。
 */
export function choicesFor(block: Block, propId: string, forest: readonly Block[]): Block[] {
  const def = findPropDef(forest, propId)
  if (!def || propKindOf(def) !== 'select') return []
  const tagIds = tagIdSetOf(block, forest)
  return choicesOf(def).filter((c) => choiceVisible(c, tagIds))
}

/**
 * 按 id 找选项块（**含软删**）：当前值可能指向一个已经不提供选择的选项，
 * 控件仍要显示它的名字，而不是把值静默清掉。
 */
export function choiceById(forest: readonly Block[], choiceId: string): Block | undefined {
  if (choiceId === '') return undefined
  let hit: Block | undefined
  walkForest(
    forest,
    (b) => {
      if (b.id !== choiceId) return
      hit = b
      return false
    },
    { includeDeleted: true },
  )
  return hit
}

/** 同一属性下的选项是否重名（**同名不是错**：身份是 id，名字只是显示） */
function duplicateChoiceName(def: Block, choice: Block): boolean {
  const name = plainText(choice.content).trim()
  const same = choicesOf(def).filter((c) => plainText(c.content).trim() === name)
  return same.length > 1
}

/**
 * **选项的显示名**（属性面板、表格、选项编辑器都只走这一个入口）。
 *
 * 选项名就是它自己的正文；同一属性下有同名选项时追加作用域，
 * 仍重名再补短 id —— 两个同名选项必须能被指着说清楚是哪一条。
 */
export function choiceDisplayLabel(choice: Block, def: Block, tagName: (id: string) => string): string {
  const name = plainText(choice.content).trim() || choice.id.slice(-6)
  if (!duplicateChoiceName(def, choice)) return name
  const scope = choiceScopeOf(choice)
  const tags = scope.mode === 'all' ? '' : scope.tags.map((id) => `#${tagName(id)}`).join('、')
  const suffix =
    scope.mode === 'all'
      ? t('ui.props.choice.scopeAllSuffix')
      : scope.mode === 'only'
        ? t('ui.props.choice.scopeOnlySuffix', { tags })
        : t('ui.props.choice.scopeExceptSuffix', { tags })
  const label = `${name}${suffix}`
  const again = choicesOf(def).filter((c) => {
    const sc = choiceScopeOf(c)
    const tg = sc.mode === 'all' ? '' : sc.tags.map((id) => `#${tagName(id)}`).join('、')
    const suf =
      sc.mode === 'all'
        ? t('ui.props.choice.scopeAllSuffix')
        : sc.mode === 'only'
          ? t('ui.props.choice.scopeOnlySuffix', { tags: tg })
          : t('ui.props.choice.scopeExceptSuffix', { tags: tg })
    return `${plainText(c.content).trim() || c.id.slice(-6)}${suf}` === label
  })
  return again.length > 1 ? `${label}（${choice.id.slice(-6)}）` : label
}

/**
 * **属性显示名**（`propId → label`）：同名属性带声明来源。
 *
 * 同名不同 `propId` 是合法的（AO4）；不标来源时两行长得一模一样，用户分不出
 * 改的是哪一个。来源是**派生的**（标签的 `_fieldDefs`），不是第二份存储。
 * picker、属性卡、字段抽屉、表格列头都吃这一张表。
 */
export function propDisplayLabels(forest: readonly Block[]): Map<string, string> {
  const defs = allPropDefs(forest)
  const declaredBy = new Map<string, Block[]>()
  for (const tag of allTags(forest)) {
    for (const propId of declaredFieldIds(tag)) {
      const list = declaredBy.get(propId)
      if (list) list.push(tag)
      else declaredBy.set(propId, [tag])
    }
  }
  const byLabel = new Map<string, Block[]>()
  for (const def of defs) {
    const label = propLabel(def) || def.id
    const list = byLabel.get(label)
    if (list) list.push(def)
    else byLabel.set(label, [def])
  }
  const out = new Map<string, string>()
  for (const def of defs) {
    const label = propLabel(def) || def.id
    if ((byLabel.get(label) ?? []).length <= 1) {
      out.set(def.id, label)
      continue
    }
    const tags = declaredBy.get(def.id) ?? []
    const source = tags.length > 0 ? ` · ${tags.map((tag) => `#${displayNameOf(tag)}`).join('、')}` : t('ui.props.undeclaredSuffix')
    out.set(def.id, `${label}${source}`)
  }
  /**
   * **追加来源后仍可能重名**：两个都未声明、或两个都被同一个标签声明。
   * 显示名的作用是「用户指着它说清是哪一个」——同一张表里两个相同的名字，
   * 那张表就没完成这件事。最后一步补短 id（id 是身份，显示名只是它的投影）。
   */
  const clashes = new Map<string, string[]>()
  for (const [id, label] of out) {
    const list = clashes.get(label)
    if (list) list.push(id)
    else clashes.set(label, [id])
  }
  for (const [label, ids] of clashes) {
    if (ids.length <= 1) continue
    for (const id of ids) out.set(id, `${label}（${id.slice(-6)}）`)
  }
  return out
}

/**
 * `select` 行的两格派生（**属性面板与表格共用这一份**）。
 *
 * `choices` 是「这个块此刻能选的」；`currentChoiceLabel` 是「值指向的那一个叫什么」
 * —— 即使它已被作用域隐藏或软删。两者分开，才做得到「当前值照常显示、不静默丢值」。
 */
export function choiceCells(
  block: Block,
  propId: string,
  def: Block,
  forest: readonly Block[],
): { choices: Block[]; currentChoiceLabel?: string } {
  const tagIds = tagIdSetOf(block, forest)
  const choices = choicesOf(def).filter((c) => choiceVisible(c, tagIds))
  const value = valueOf(block, propId)
  if (typeof value !== 'string' || value === '') return { choices }
  const current = choiceById(forest, value)
  if (!current) return { choices }
  const tagName = (id: string): string => {
    const tag = tagsById(forest).get(id)
    return tag ? displayNameOf(tag) : id.slice(-6)
  }
  return { choices, currentChoiceLabel: choiceDisplayLabel(current, def, tagName) }
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
  /**
   * `select` 行：这个块此刻能选的选项（`choicesFor` 的结果，兄弟顺序）。
   *
   * UI **不许**再读定义块上的任何「选项目录」——「这个块有哪些选项」只有这一个读法，
   * 属性面板与表格都吃它。
   */
  choices?: Block[]
  /**
   * `select` 行：当前值对应的选项名（**即使它被作用域隐藏或已软删**）。
   *
   * 找不到（选项真的没了／值来自另一个库）时缺席，由 UI 用字典兜底
   * 「选项已删除」——值本身不动，用户可显式清空。
   */
  currentChoiceLabel?: string
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

  /** 同一份行派生里补 `select` 的两格：值控件的选项与当前值名字都从这里来 */
  const fill = (row: FieldRow): FieldRow => {
    if (!row.def || row.kind !== 'select') return row
    const { choices, currentChoiceLabel } = choiceCells(block, row.propId, row.def, forest)
    row.choices = choices
    if (currentChoiceLabel !== undefined) row.currentChoiceLabel = currentChoiceLabel
    return row
  }

  for (const tag of resolveTagIds(block, tagsById(forest))) {
    for (const propId of declaredFieldIds(tag)) {
      const existing = rows.get(propId)
      if (existing) {
        existing.sources.push(tag)
        continue
      }
      const def = defs.get(propId)
      rows.set(
        propId,
        fill({
          propId,
          label: def ? propLabel(def) || propId : propId,
          kind: def ? propKindOf(def) : 'text',
          value: valueOf(block, propId),
          filled: hasValue(block, propId),
          def,
          sources: [tag],
          order: order++,
        }),
      )
    }
  }

  for (const propId of ownFieldIds(block)) {
    if (rows.has(propId)) continue
    const def = defs.get(propId)
    rows.set(
      propId,
      fill({
        propId,
        label: def ? propLabel(def) || propId : propId,
        kind: def ? propKindOf(def) : 'text',
        value: valueOf(block, propId),
        filled: hasValue(block, propId),
        def,
        sources: [],
        order: order++,
      }),
    )
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
 * 这个块上**该在 gutter 画快捷入口**的属性。
 *
 * 为什么和 `fieldRows` 分开而写在 core：gutter 与右侧面板吃的是**同一份行派生**
 * （声明 ∪ 自有、同一 propId 只一行）。若各写一套过滤，两个编辑面迟早会对同一条属性
 * 给出不同答案（一边有值、一边说待填）。
 *
 * 判据：定义声明了 `_uiPosition: 'block-left'` ⇒ gutter 上画**快捷入口**，**不管有没有值**。
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
 * ⚠️ 右侧面板用的是**同一份行派生**（见 `ui/properties.ts`），而且现在**也画全部行**：
 *    `_uiPosition` 只决定快捷入口在哪，不排除另一个编辑面。两面读同一份、写同一条命令、
 *    写完两边都重画，所以不会出现「一边改了、另一边没跟上」。
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

/**
 * 写一个值（**一块一槽**：键是 propId；不碰任何标签）。
 *
 * **顺带记改动时刻**：属性值住在属性袋里、时刻住在块上，而写属性的事务按属性袋的差异
 * 发 `prop.set` —— 它不会去看时刻变了没有。不在这里一起写，就会得到一条「值变了、
 * 修改时间是旧的」的账，而面板上那一行最显眼。
 * ⚠️ 只认「值真的变了」：点一下已经选中的那个选项不是一次改动。
 */
export function setValue(block: Block, propId: string, value: unknown): void {
  const prev = block.props?.[propId]
  block.props = { ...(block.props ?? {}), [propId]: value }
  if (!sameValue(prev, value)) block.modified = Date.now()
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
  // 摘一个值是一次改动（早退那条路径已经保证「本来就没有」走不到这里）
  block.modified = Date.now()
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
