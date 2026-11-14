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
 *     定义→滑杆）?? **主标签借形**（归属序第一个带显式 `_icon` 的标签）?? 无（调用方画圆点）。
 *     回落集**比指位小一档**：页/日记的自位身份已由内容形态表达（首行加粗／只读日期行），
 *     file 图标在自位是纯装饰；标签/查询/定义的默认图标是**结构旗**，正文为空也成立。
 *     借形与借色同一资格：归属是身份信息，形与色不该一半借一半不借——
 *     「成员不是标签所以图标不借」的旧口径随任意块自位脸入口一起废止（当时图标唯一
 *     显示位是 chip；现在块标有了自位脸，借入只是回落位，泛滥担忧由色轴同一资格承担）。
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
  hasList,
  isColorValue,
  isHexColor,
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
 * **自位的脸**：块标上画什么。显式 `_icon` 优先；缺省回落结构旗；再缺省借主标签的形；
 * 都没有 ⇒ `undefined`（调用方画圆点——「无脸默认」）。
 *
 * 特异性排序（①最具体的发言赢）：自己显式配的 > 自己就是的定义 > 挂上去的归属。
 * 借形只认标签**显式** `_icon`（与借色同一资格）：标签没配脸就不借，一层不递归。
 *
 * @param byId 标签 id → 标签块（给了才走借形档；调用方用 `tagsById` 建一次表，
 *   逐行渲染可用 `faceOfByFind`，别逐行扫森林）
 */
export function faceOf(b: Block, byId?: ReadonlyMap<string, Block>): string | undefined {
  const explicit = prop<string>(b, ICON_PROP)
  if (explicit !== undefined && explicit.trim() !== '') return explicit
  if (hasList(b, 'tag')) return STRUCTURAL_FACE.tag
  if (isQueryBlock(b)) return STRUCTURAL_FACE.query
  if (isPropDefBlock(b)) return STRUCTURAL_FACE.def
  if (byId) {
    for (const t of resolveTagIds(b, byId)) {
      const ico = prop<string>(t, ICON_PROP)
      if (ico !== undefined && ico.trim() !== '') return ico
    }
  }
  return undefined
}

/**
 * `faceOf` 的逐行渲染形状：手里只有 `FindBlock` 时用这个（借形档要查标签块）。
 * （整屏批量渲染仍请先 `tagsById` 建表走 `faceOf`。）
 */
export function faceOfByFind(b: Block, find?: FindBlock): string | undefined {
  if (!find) return faceOf(b)
  const byId = new Map<string, Block>()
  for (const id of tagIdsOf(b)) {
    const t = find(id)
    if (t) byId.set(id, t)
  }
  return faceOf(b, byId)
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
 * **标签的脸借给成员——形与色同一资格**（归属序第一个带显式 `_icon` 的标签借形，
 * 见 `faceOf`；色按下面这条链借）。
 *
 * 借色只认**显式** `_color`（色板封闭集内的值）：有色标签自己没配色就不借，
 * 一层借色不递归——「借来的色再借出去」没有第二份真相。
 * `_color` 带了色板外的值按缺席处理（未知值渲染中性，「无颜色」是合法态不是错误态）。
 *
 * @param byId 标签 id → 标签块（调用方用 `tagsById` 建一次表；逐块扫森林会退化成 O(n²)）
 */
export function colorOf(b: Block, byId: ReadonlyMap<string, Block>): IdentityFaceColor {
  const own = prop<string>(b, COLOR_PROP)
  if (own !== undefined && isColorValue(own)) return { kind: 'solid', color: own }
  const colors: string[] = []
  for (const t of resolveTagIds(b, byId)) {
    const c = prop<string>(t, COLOR_PROP)
    if (c !== undefined && isColorValue(c)) colors.push(c)
  }
  if (colors.length === 1) return { kind: 'solid', color: colors[0]! }
  if (colors.length >= 2) return { kind: 'ring', colors }
  return { kind: 'none' }
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

/**
 * 身份色的一个 CSS 值（solid＝描边/圆点/字，soft＝chip 底）。
 * **板 key 走预调 token 对；hex（用户色）走程序化**——没有第二份 soft token 可引：
 * soft 用 `color-mix` 现算（15% 叠透明，与内置 soft 同一观感档），
 * solid 在暗色主题下提亮一档（纯 hex 在暗底上会陷进去；`light-dark` 两臂由 CSS 按主题取）。
 * 登记的代价：自定义色的可读性没有预调兜底（登记过的代价）。
 */
export function identityColorCss(value: string, variant: 'solid' | 'soft' = 'solid'): string {
  if (isHexColor(value)) {
    if (variant === 'soft') return `color-mix(in srgb, ${value} 15%, transparent)`
    return `light-dark(${value}, color-mix(in srgb, ${value} 72%, white))`
  }
  return `var(${IDENTITY_VAR_PREFIX}${value}${variant === 'soft' ? '-soft' : ''})`
}

/**
 * 块标**内点**的色：solid ＝ 自己的色；ring ＝ 第一个有色标签（`_tags` 序）；
 * 中性 ＝ `undefined`（回落默认，交互语言不吃身份色）。
 */
export function identityDotColor(c: IdentityFaceColor): string | undefined {
  if (c.kind === 'solid') return identityColorCss(c.color)
  if (c.kind === 'ring') return identityColorCss(c.colors[0]!)
  return undefined
}

/**
 * 块标**外环**的渐变：≥2 个有色标签时按 `_tags` 序的 conic——
 * 点保持可读（主标签的身份），环说「不止一个」。恰 2 个时读作双色环。
 */
export function identityRingGradient(c: IdentityFaceColor): string | undefined {
  if (c.kind !== 'ring') return undefined
  const stops = c.colors.map((k) => identityColorCss(k)).join(', ')
  return `conic-gradient(from 0deg, ${stops})`
}
