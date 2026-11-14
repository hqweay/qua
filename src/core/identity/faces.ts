/**
 * **脸与信号**：图标与身份色的回落链（判据进 core，view 只画）。
 *
 * 图标在一个 `_icon` 里干两份工作，这里把它拆开、各给一条链：
 *
 * | 工作 | 例子 | 数据还是 chrome |
 * |---|---|---|
 * | **脸**（用户给的识别符） | 标签设了 🎯，全库每个点名它的行都显示 🎯 | 数据（`_icon` 显式值） |
 * | **信号**（角色回落） | 入口行里页=file、日记=calendar、标签=hash | chrome（渲染时按派生身份回落，**不落盘**） |
 *
 * **信号回答「这是哪类东西」，脸回答「这是哪一个东西」。**
 * 同一个槽承载两者：显式值＝脸，缺省＝信号回落 ——「入口在，值可以不在」推广到全部图标位。
 *
 * 三条链：
 *   · **`faceOf`**（自位，块标）：显式 `_icon` ?? 结构身份默认（标签→hash／查询→漏斗／
 *     定义→滑杆）?? 无（调用方画圆点）。回落集**比指位小一档**：页/日记的自位身份已由
 *     内容形态表达（首行加粗／只读日期行），file 图标在自位是纯装饰；
 *     标签/查询/定义的默认图标是**结构旗**，正文为空也成立。
 *   · **`iconOf`**（指位，入口行／候选行／菜单行）：显式 `_icon` ?? 全角色默认
 *     （标签→hash／日记→calendar／页→file／查询→漏斗／定义→滑杆）?? 无
 *     （普通块＝空白但占位：页/块的区分由有图标/无图标继续承载）。
 *   · **`colorOf`**（自位色）：显式 `_color` ?? 恰一个有色标签→借色 ??
 *     ≥2 有色标签→色环（调用方按 `_tags` 序画 conic）?? 中性。
 *
 * ⚠️ 三个函数只回答「画什么」，不碰 DOM。返回 `undefined` ＝「这一档没有」，由调用方决定
 *    画圆点还是留白——core 不替 view 拍显示。
 * ⚠️ 默认图标**不落盘**：创建路径不写 `lucide:hash`／`lucide:file`／`lucide:calendar`。
 *    「用户明确选了 file」与「默认 file」不可区分是已登记的代价，真需要区分时加显式哨兵值。
 */
import {
  COLOR_PROP,
  ICON_PROP,
  IDENTITY_COLORS,
  hasList,
  isJournalBlock,
  isPropDefBlock,
  isQueryBlock,
  prop,
  type Block,
} from '../model/model.ts'
import { resolveTagIds, tagIdsOf } from './tags.ts'
import type { FindBlock } from '../relations/ref.ts'

/** 结构旗：自位回落集（比指位小一档——页/日记在自位不借角色图标） */
const STRUCTURAL_FACE: Record<string, string> = {
  tag: 'lucide:hash',
  query: 'lucide:list-filter',
  def: 'lucide:sliders-horizontal',
}

/** 全角色默认：指位回落集（页与日记也进集——入口行要靠图标认出「这是哪类东西」） */
const ROLE_ICON: Record<string, string> = {
  tag: 'lucide:hash',
  journal: 'lucide:calendar',
  page: 'lucide:file',
  query: 'lucide:list-filter',
  def: 'lucide:sliders-horizontal',
}

/** 这个块的派生身份对应哪一档角色（兼位按「越本质越靠前」：标签 > 日记 > 页 > 结构） */
function roleOf(b: Block): string | undefined {
  if (hasList(b, 'tag')) return 'tag'
  if (isJournalBlock(b)) return 'journal'
  if (hasList(b, 'page')) return 'page'
  if (isQueryBlock(b)) return 'query'
  if (isPropDefBlock(b)) return 'def'
  return undefined
}

/**
 * **自位的脸**：块标上画什么。显式 `_icon` 优先；缺省回落到结构旗；
 * 普通块/页/日记没有结构旗 ⇒ `undefined`（调用方画圆点——「无脸默认」）。
 */
export function faceOf(b: Block): string | undefined {
  const explicit = prop<string>(b, ICON_PROP)
  if (explicit !== undefined && explicit.trim() !== '') return explicit
  if (hasList(b, 'tag')) return STRUCTURAL_FACE.tag
  if (isQueryBlock(b)) return STRUCTURAL_FACE.query
  if (isPropDefBlock(b)) return STRUCTURAL_FACE.def
  return undefined
}

/**
 * **指位的图标**：入口行/候选行/菜单行上画什么。显式 `_icon` 优先；
 * 缺省回落到全角色默认；普通块 ⇒ `undefined`（调用方留白但占位）。
 */
export function iconOf(b: Block): string | undefined {
  const explicit = prop<string>(b, ICON_PROP)
  if (explicit !== undefined && explicit.trim() !== '') return explicit
  const role = roleOf(b)
  return role ? ROLE_ICON[role] : undefined
}

/** 自位色的三种回答：中性 ／ 一个色 ／ 色环（≥2 个有色标签，按归属顺序） */
export type IdentityFaceColor =
  | { kind: 'none' }
  | { kind: 'solid'; color: string }
  | { kind: 'ring'; colors: string[] }

/**
 * **自位的色**：自己的脸自己上色（`_color` 上自己的块标/图标）；
 * **标签的脸借给成员——色借、图标不借**（成员不是标签，图标上 chip）。
 *
 * 借色只认**显式** `_color`（色板封闭集内的值）：有色标签自己没配色就不借，
 * 一层借色不递归——「借来的色再借出去」没有第二份真相。
 * `_color` 带了色板外的值按缺席处理（未知值渲染中性，「无颜色」是合法态不是错误态）。
 *
 * @param byId 标签 id → 标签块（调用方用 `tagsById` 建一次表；逐块扫森林会退化成 O(n²)）
 */
export function colorOf(b: Block, byId: ReadonlyMap<string, Block>): IdentityFaceColor {
  const own = prop<string>(b, COLOR_PROP)
  if (own !== undefined && isPaletteKey(own)) return { kind: 'solid', color: own }
  const colors: string[] = []
  for (const t of resolveTagIds(b, byId)) {
    const c = prop<string>(t, COLOR_PROP)
    if (c !== undefined && isPaletteKey(c)) colors.push(c)
  }
  if (colors.length === 1) return { kind: 'solid', color: colors[0]! }
  if (colors.length >= 2) return { kind: 'ring', colors }
  return { kind: 'none' }
}

/** 色板封闭集判据：色板外的值一律按「没配色」处理，不报错 */
function isPaletteKey(v: string): boolean {
  return (IDENTITY_COLORS as readonly string[]).includes(v)
}

/**
 * `colorOf` 的逐行渲染形状：手里只有 `FindBlock` 时用这个，不必为每行建一张标签表。
 * （整屏批量渲染仍请先 `tagsById` 建表走 `colorOf`，别逐行扫库。）
 */
export function colorOfByFind(b: Block, find?: FindBlock): IdentityFaceColor {
  if (!find) return { kind: 'none' }
  const byId = new Map<string, Block>()
  for (const id of tagIdsOf(b)) {
    const t = find(id)
    if (t) byId.set(id, t)
  }
  return colorOf(b, byId)
}

/** 身份 token 的名字前缀（`tokens.css` 的 `--ui-identity-<key>[-soft]`；封闭集测试钉两表一一对应） */
const IDENTITY_VAR_PREFIX = '--ui-identity-'

/** 身份色板的一个 token 引用（solid＝描边/圆点，soft＝chip 底）。key 只来自色板封闭集 */
export function identityTokenVar(key: string, variant: 'solid' | 'soft' = 'solid'): string {
  return `var(${IDENTITY_VAR_PREFIX}${key}${variant === 'soft' ? '-soft' : ''})`
}

/**
 * 身份色 → **元素上的局部槽**的值：solid ＝ 一个 token；ring ＝ 按 `_tags` 序的
 * conic-gradient（10px 级小面积）；中性 ＝ `undefined`（调用方回落默认色，
 * 交互语言不吃身份色）。
 *
 * ⚠️ 只产字符串，不碰 DOM —— 颜色的出现方式（描边/圆点/底色）归 view。
 */
export function identityColorVar(c: IdentityFaceColor): string | undefined {
  if (c.kind === 'solid') return identityTokenVar(c.color)
  if (c.kind === 'ring') {
    const stops = c.colors.map((k) => identityTokenVar(k)).join(', ')
    return `conic-gradient(from 0deg, ${stops})`
  }
  return undefined
}
