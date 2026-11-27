/**
 * **选项（`select` 的值域）＝ 属性定义块上的一条记录，不是块。**
 *
 * 判据（为什么选项不必是块）：封闭枚举的成员用不上块的能力——不写正文、不长子树、
 * 不被单独提及、不成页。用块能力换来的代价是每一项都得进森林（被查询扫到、被导出
 * 带上、删了还要软删保位）。值要成实体时该走的是 `ref`，不是「选项升块籍」。
 *
 * 三个性质，一条都不能少：
 *   · **值侧不透明**：块上的值仍是 `props[propId] = 记录 id`，值层不知道 id 指向记录
 *     还是块 —— 于是「选项改块」「记录改块」在值上零迁移；
 *   · **归属只有一份真相**：定义块的 `_choices` 数组，**数组序＝选项序**。选项记录上
 *     不存任何反向指针（没有 `_choiceOf`），chrome 要「这是选项」的徽标时按定义现算；
 *   · **删除是墓碑**：记录不在森林里，不享受块级软删。删掉的记录留在数组里标
 *     `deleted`，值指向它时照样读得出名字（同类工具的数据库版「删选项连值一起删」是反面样本）。
 *
 * 墓碑与「软删的块」是同一个思路的两种载体：状态跟着身份走，位置不动，恢复是撤掉标记。
 *
 * ⚠️ 本文件零 DOM、零 store —— 记录就是属性袋里的一段纯数据，能直接单测。
 */
import { isColorValue, prop, type Block, type BlockProps } from '../model/model.ts'
import { identityColorCss } from '../identity/faces.ts'
import { uuidv7Hex } from '../model/ids.ts'

/** 定义块上装选项记录的槽（系统属性；空数组 ＝ 没有选项，不落盘留空壳） */
export const CHOICES_PROP = '_choices'

/**
 * 旧形状的槽名：选项还是子块时，作用域住在**选项块**的 `props._choiceScope` 上。
 *
 * 保留它只为一件事：**桌面真机遗留库**里那些旧选项子块仍然带着这一格，新读路径
 * （`choiceById` 的块兜底）要把作用域读出来。它不是新形状的一部分，也不再写入。
 */
export const CHOICE_SCOPE_PROP = '_choiceScope'

/**
 * 一个选项的可见范围（**唯一的可见性来源**）。
 *
 * 三态互斥，所以没有「既 only 又 except」的冲突态，也没有优先级规则。
 * 缺省/坏值按 `all`：旧数据或手写数据不该让控件整片空掉。
 */
export type ChoiceScope = { mode: 'all' } | { mode: 'only'; tags: string[] } | { mode: 'except'; tags: string[] }

/**
 * **一条选项记录**（住在定义块的 `props._choices` 里）。
 *
 * `id` 是值侧认的那个身份（与块 id 同形但不进森林）；`label` 是显示名 ——
 * 改名**零值迁移**，两个同名选项是两个 id（身份不是名字）。
 */
export interface PropChoice {
  id: string
  label: string
  /** 块左侧／chip 上的图标（`lucide:*` 或 emoji）；空＝没有 */
  icon?: string
  /** 选项自己的颜色（色板 key 或 `#rrggbb`）；空＝借定义块的色 */
  color?: string
  /** 一句话说明（选项编辑器的次要行，不当正文） */
  desc?: string
  /** 可见范围；缺省 `all` 不落盘（`all` 与「没有这一格」是同一个答案） */
  scope?: ChoiceScope
  /** 墓碑：删过的记录留在原位，值仍读得出名字；恢复＝撤掉这个标记 */
  deleted?: true
}

/**
 * 把一格未知值读成三态作用域；`null` ＝ 形状不认识（命令层据此拒绝写入）。
 *
 * 归一化只做一件不承载语义的事：标签去重。**空集合保留**：编辑作用域时会经过
 * 「刚切到 only、还没勾标签」的中间态，把它归一成 `all` 会让复选框整片禁用，
 * 用户再也选不上标签。空集本身有明确含义（only ＝ 谁都看不见）。
 * **悬空的标签 id 也原样保留**：标签被删不等于作用域失效 —— 静默摘掉会让一个
 * `only` 悄悄变成「所有人都能选」。
 */
export function parseChoiceScope(raw: unknown): ChoiceScope | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const v = raw as { mode?: unknown; tags?: unknown }
  if (v.mode === 'all') return { mode: 'all' }
  if (v.mode !== 'only' && v.mode !== 'except') return null
  if (!Array.isArray(v.tags)) return null
  const tags = [...new Set(v.tags.filter((x): x is string => typeof x === 'string' && x !== ''))]
  return { mode: v.mode, tags }
}

/** 一条记录的合法形状（写侧 op 发看点与落盘校验共用这一份） */
function isChoiceRecord(v: unknown): v is PropChoice {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const c = v as Record<string, unknown>
  if (typeof c.id !== 'string' || c.id === '') return false
  if (typeof c.label !== 'string' || c.label.trim() === '') return false
  for (const k of ['icon', 'color', 'desc'] as const) {
    if (c[k] !== undefined && typeof c[k] !== 'string') return false
  }
  if (c.scope !== undefined && parseChoiceScope(c.scope) === null) return false
  if (c.deleted !== undefined && c.deleted !== true) return false
  return true
}

/**
 * `_choices` 的形状判据：记录数组，**id 唯一**、数组序即选项序。
 *
 * 为什么把「id 唯一」写进判据：值只存 id，两条同 id 的记录会让「这个值显示哪个名字」
 * 变成一个没有答案的问题。重复 id 不是「宽容数据」的一种，是坏形状。
 * 空数组合法（＝这个属性还没有选项）。
 */
export function isChoicesValue(v: unknown): boolean {
  if (!Array.isArray(v)) return false
  const seen = new Set<string>()
  for (const c of v) {
    if (!isChoiceRecord(c)) return false
    if (seen.has(c.id)) return false
    seen.add(c.id)
  }
  return true
}

/** 严格解析：`null` ＝ 形状不认识（读路径另有宽容版 `choicesOf`） */
export function parseChoices(raw: unknown): PropChoice[] | null {
  return isChoicesValue(raw) ? (raw as PropChoice[]) : null
}

/** **活着的**选项（墓碑不算）：候选清单的唯一来源，数组序＝选项序 */
export function choicesOf(def: Block): PropChoice[] {
  return allChoicesOf(def).filter((c) => c.deleted !== true)
}

/** 全部记录（**含墓碑**）：值指向已删选项时要读得出名字，靠这一份 */
export function allChoicesOf(def: Block): PropChoice[] {
  return parseChoices(prop<unknown>(def, CHOICES_PROP)) ?? []
}

/**
 * 就地把选项数组写回定义块（`tx.patch` 里的写路径唯一入口）。
 *
 * 「空数组」与「没有这一格」是同一个答案：留一个空壳会让快照比较多出一处噪声，
 * 也让「这个属性有没有域」有两种读法。删到零条时连槽一起摘掉。
 */
export function setChoices(def: Block, next: readonly PropChoice[]): void {
  const props: BlockProps = { ...(def.props ?? {}) }
  if (next.length === 0) delete props[CHOICES_PROP]
  else props[CHOICES_PROP] = next.map((c) => ({ ...c }))
  if (Object.keys(props).length === 0) delete def.props
  else def.props = props
  def.modified = Date.now()
}

/** 单条记录的补丁（纯函数：返回新数组，原数组不动） */
export function patchChoice(
  list: readonly PropChoice[],
  id: string,
  fn: (c: PropChoice) => PropChoice,
): PropChoice[] {
  return list.map((c) => (c.id === id ? fn({ ...c }) : c))
}

/** 新记录的 id：与块 id 同形（32 位十六进制），但**永不进森林** */
export function newChoiceId(): string {
  return uuidv7Hex()
}

/**
 * 记录的可见范围；缺省/坏形状回落「所有用这个属性的块都能选它」。
 *
 * 走 `parseChoiceScope` 是为了**归一**（标签去重）：记录里的 scope 可能是手写/旧数据，
 * 读侧只该有一种形状 —— 与旧形状的 `_choiceScope` 共用同一份判据。
 */
export function choiceScopeOf(choice: PropChoice): ChoiceScope {
  return parseChoiceScope(choice.scope) ?? { mode: 'all' }
}

/**
 * 这个选项对一组标签可见吗。
 *
 * 多标签取**并集**：`only` 任一命中即可见，`except` 任一命中即隐藏。
 * 空标签集：`all` 可见、`only` 不可见、`except` 可见（没有要排除的）。
 */
export function choiceVisible(choice: PropChoice, tagIds: ReadonlySet<string>): boolean {
  const scope = choiceScopeOf(choice)
  if (scope.mode === 'all') return true
  const hit = scope.tags.some((id) => tagIds.has(id))
  return scope.mode === 'only' ? hit : !hit
}

/**
 * 选项色 → CSS 值（只给图标描边用，不染文字与方框）。
 *
 * 坏值与空值都缺席：坏值不可能从写路径进来，但要防遗留库里的脏数据；
 * 缺色是合法中性态，不该在这里补一个第二真相（借定义块的脸）。
 */
export function choiceColorCss(choice: PropChoice | undefined): string | undefined {
  const color = choice?.color
  if (color === undefined || !isColorValue(color)) return undefined
  return identityColorCss(color)
}
