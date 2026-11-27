/**
 * 引述块的类型表：**一张可编辑的记录表**，不是七种块类型。
 *
 * 「这一块是什么语气」是 `_callout` 的值；值域＝一串类型记录（id／名字／图标／颜色），
 * 记录挂在固定 id 的隐藏单例块上（`_calloutTypes`），**不进森林**。
 * 与 `select` 的选项是同一个形状、同一条判据：不写正文、不长子树、不被单独提及、
 * 不成页 ⇒ 记录而不是块。这样「所有警告」仍是一条 `eq` 条件，不是七个类型的 OR。
 *
 * 三条口径：
 *   · **值侧不透明**：块上只存记录 id，值层不知道 id 指向记录还是别的东西；
 *   · **未知值不静默改盘**：读不出来按缺省引述画，盘上的值一个字节不动；
 *   · **删除是墓碑**：删过的类型留在表里标 `deleted`，旧引述照样读得出名字；
 *     缺省类型（`quote`）不可删——所有旧库、旧值、缺键都回落到它。
 *
 * 读路径有两种「拿表」的场合，别混：
 *   · 有块查找器的面（徽章／行／面包屑／卡片）→ `calloutTypesOf(find)`；
 *   · 纯判据（查询求值、写侧校验）→ 值原样读出，只在显示层解析名字；
 *   · 表还没物化的旧库 → 回退内置表（物化发生在第一次改类型时）。
 *
 * ⚠️ 本文件零 DOM：颜色只回答「记录里写了什么」，CSS 串由渲染层过
 *    `identityColorCss` 生成（core 存 CSS 会让渲染层没法再判「这是槽名还是 hex」）。
 */
import { derivedId } from '../model/ids.ts'
import { CALLOUT_TYPES_PROP, prop, type Block } from '../model/model.ts'
import { parseChoices, type PropChoice } from '../props/choices.ts'
import { t } from './msg.ts'

/** 一条引述类型记录（存进注册表 `_calloutTypes` 的形状） */
export interface CalloutType {
  id: string
  label: string
  /** `lucide:<name>` 或字面/emoji；空＝渲染时回落引述图标 */
  icon: string
  /** 色板 key 或 `#rrggbb`；空＝中性（无强调色） */
  color?: string
  /** 墓碑：删过的类型留在表里，旧值仍读得出名字 */
  deleted?: true
}

/** 缺省类型：所有旧库、旧值与缺键都回落到它，且它不可删 */
export const DEFAULT_CALLOUT = 'quote'

/**
 * 注册表的块 id：确定性派生 ⇒ 同一个库永远同一个 id，删了再建也还是它。
 * 块本身不可见（无正文／别名／露面），只在读路径按 id 取。
 */
export const CALLOUT_TYPES_BLOCK_ID = derivedId('core', 'callout-types')

/** 找一块（读路径注入的形状；与 `FindBlock` 结构相同，本文件不依赖 relations） */
export type BlockLookup = (id: string) => Block | undefined

interface BuiltinSpec {
  readonly id: string
  readonly msgId:
    | 'ui.callout.quote'
    | 'ui.callout.info'
    | 'ui.callout.warning'
    | 'ui.callout.error'
    | 'ui.callout.tip'
    | 'ui.callout.important'
    | 'ui.callout.note'
  readonly icon: string
  readonly color?: string
}

/**
 * 内置七种的**唯一清单**（顺序＝菜单顺序）。
 *
 * 图标一律带 `lucide:` 前缀：静态卡片曾把裸名传给 `renderIcon`，渲染成了字面文本
 * ——值里带协议头，两个读面（编辑器徽章、静态卡片）就只有一个答案。
 *
 * 颜色用身份色板（不是文字色 `--ui-ink-*`）：强调色与标签/页的脸色是同一族，
 * 换主题时一起走。
 */
const BUILTIN_SPECS: readonly BuiltinSpec[] = [
  { id: 'quote', msgId: 'ui.callout.quote', icon: 'lucide:quote', color: 'cyan' },
  { id: 'info', msgId: 'ui.callout.info', icon: 'lucide:info', color: 'blue' },
  { id: 'warning', msgId: 'ui.callout.warning', icon: 'lucide:triangle-alert', color: 'yellow' },
  { id: 'error', msgId: 'ui.callout.error', icon: 'lucide:circle-alert', color: 'red' },
  { id: 'tip', msgId: 'ui.callout.tip', icon: 'lucide:lightbulb', color: 'green' },
  { id: 'important', msgId: 'ui.callout.important', icon: 'lucide:octagon-alert', color: 'purple' },
  // 中性：没有强调色。灰不在身份色板里，硬塞一个会让「无颜色」与「浅灰」两种语义打架
  { id: 'note', msgId: 'ui.callout.note', icon: 'lucide:sticky-note' },
]

/** 内置表：每次现造（`t()` 在调用时取当前语言；物化成记录之后就冻结） */
export function builtinCalloutTypes(): CalloutType[] {
  return BUILTIN_SPECS.map((s) => ({
    id: s.id,
    label: t(s.msgId),
    icon: s.icon,
    ...(s.color !== undefined ? { color: s.color } : {}),
  }))
}

/** 缺省类型的兜底记录（`quote` 从记录表里被删掉也不至于没有名字） */
function fallbackType(): CalloutType {
  return builtinCalloutTypes()[0]!
}

/** 注册表块上的记录；`undefined` ＝ 没有这张表（旧库）或形状不认识 */
function registryTypesOf(raw: unknown): CalloutType[] | undefined {
  const parsed = parseChoices(raw)
  if (!parsed) return undefined
  return parsed.map((c) => ({
    id: c.id,
    label: c.label,
    icon: c.icon ?? '',
    ...(c.color !== undefined ? { color: c.color } : {}),
    ...(c.deleted ? { deleted: true as const } : {}),
  }))
}

/**
 * 库里的类型表：注册表记录 → 内置表（还没物化）→ 内置表（形状坏了）。
 *
 * 读路径**永远不该因为表不可用而丢掉名字**——旧库没有这一块是常态。
 */
export function calloutTypesOf(find?: BlockLookup): CalloutType[] {
  const block = find?.(CALLOUT_TYPES_BLOCK_ID)
  const records = block ? registryTypesOf(prop<unknown>(block, CALLOUT_TYPES_PROP)) : undefined
  return records && records.length > 0 ? records : builtinCalloutTypes()
}

/** 活着的类型（墓碑不算）：候选清单、菜单、选择器的唯一来源 */
export function liveCalloutTypes(types: readonly CalloutType[]): CalloutType[] {
  return types.filter((x) => x.deleted !== true)
}

/**
 * 值 → 记录：**记录（含墓碑）优先 → 缺省记录 → 内置兜底**。
 *
 * 墓碑仍要解析出名字：类型删了，旧引述不该变成「引述」或裸 id。
 * 完全不认识的 id 落缺省——这是显示层的降级，盘上的值不会被改。
 */
export function calloutTypeOf(
  raw: string | undefined,
  types: readonly CalloutType[] = builtinCalloutTypes(),
): CalloutType {
  const id = typeof raw === 'string' ? raw : ''
  if (id !== '') {
    const hit = types.find((x) => x.id === id)
    if (hit) return hit
  }
  return types.find((x) => x.id === DEFAULT_CALLOUT) ?? fallbackType()
}

/** 显示名（徽章／菜单／面包屑／引用 chip／静态卡片同一条链） */
export function calloutLabel(raw?: string, types?: readonly CalloutType[]): string {
  return calloutTypeOf(raw, types).label
}

/**
 * 规范化的类型 id：认识（含墓碑）就原样，否则缺省。
 * 写侧的「存在且未删」闸比它更严——这里只回答「显示成哪一个」。
 */
export function canonicalCallout(raw?: string, types?: readonly CalloutType[]): string {
  return calloutTypeOf(raw, types).id
}

/** 写侧闸：这个 id 在表里**存在且未删**（开放值域的防拼错） */
export function liveCalloutTypeOf(id: string, types: readonly CalloutType[]): CalloutType | undefined {
  return types.find((x) => x.id === id && x.deleted !== true)
}

/** 规范化后的重名判据（创建／改名共用）：去首尾空白、折叠内部空白、小写 */
export function normalizeCalloutLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

/** 这个名字是否已被另一个类型占用（墓碑也算占位：恢复时不能撞名） */
export function calloutLabelTaken(types: readonly CalloutType[], label: string, exceptId?: string): boolean {
  const key = normalizeCalloutLabel(label)
  if (key === '') return false
  return types.some((x) => x.id !== exceptId && normalizeCalloutLabel(x.label) === key)
}

/** 分组／条件面的选项域：**含墓碑**（旧值要读得出名字；条件存 id，改名不断旧查询） */
export function calloutGroupChoices(
  types: readonly CalloutType[] = builtinCalloutTypes(),
): { id: string; label: string }[] {
  return types.map((x) => ({ id: x.id, label: x.label }))
}

/** 注册表记录的写侧形状（落盘前过一遍同一份形状判据） */
export function toCalloutRecords(types: readonly CalloutType[]): PropChoice[] {
  return types.map((x) => ({
    id: x.id,
    label: x.label,
    icon: x.icon,
    ...(x.color !== undefined ? { color: x.color } : {}),
    ...(x.deleted ? { deleted: true as const } : {}),
  }))
}

/**
 * 承载类型表的那一块（无正文／别名／露面：它不参与组织，只承载记录）。
 *
 * 形状住在模型侧而不是写路径里：**首建**（事务内）与**种子**都要造它，
 * 两处各写一份就会漂移——种子造出来的表结构不认识、或读路径认不出那张表。
 * 写入（首建进森林／整表替换）仍归 `core/kb`，因为那要点事务。
 */
export function mkCalloutTypesBlock(records: readonly CalloutType[]): Block {
  const now = Date.now()
  return {
    id: CALLOUT_TYPES_BLOCK_ID,
    content: [],
    children: [],
    created: now,
    modified: now,
    props: { [CALLOUT_TYPES_PROP]: toCalloutRecords(records) },
  }
}
