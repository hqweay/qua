/**
 * **一次点击去哪／看什么**：修饰键只回答这一个问题，不回答「打开什么」。
 *
 * 为什么把它收成一份纯函数：同一个动作在正文块标、面包屑、行内引用、属性区、
 * 左槽行、查询的六种看法、日历格里各写一遍 if/else，必然有两处漂移
 * （实测：槽里的行认 Shift 不认 ⌘，而文档头面包屑正好相反）。
 * 事件层只把鼠标上的修饰键交进来（`clickModsOf`），分流由装配层按这唯一一份判据做。
 *
 * 四档与优先级：
 *   · `⌥` → `inspect`：**看这一处自己的第二层**（有 run 的露面＝那一枚的详情；
 *     块级指针＝这一块的属性面板）。优先级最高：组合键只产生一种语义。
 *   · `Shift` → `dock`：在右槽开一个窗口（并排看）。
 *   · `⌘`/`Ctrl` → `tab`：在新页签打开（另开一处看）。
 *   · 无修饰 → `center`：默认动作（打开/聚焦）。
 *
 * ⚠️ **`⌥` 不是落点**：它不改「你在哪」，只把这一处自己的东西展开一层。
 *    所以 `inspect` 与另外三档的区别是**生命周期**（瞬态 vs 常驻），不是位置。
 */
export type OpenAction = 'center' | 'dock' | 'tab' | 'inspect'

/** 三个真正的落点（`inspect` 不在这里：它不是「去哪」）。 */
export type OpenPlace = Exclude<OpenAction, 'inspect'>

export interface OpenMods {
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
}

/**
 * 一次点击带下来的**全部**修饰键。
 *
 * 为什么四个都必填：这份结构被「顺手抄窄」过几次（表格标题格、卡片、属性区），
 * 每次都是 `{ altKey, shiftKey }` —— 于是 ⌘+点在这些入口静默退化成普通点击，
 * 而可选字段让类型检查也拦不住。必填 ＋ `clickModsOf()` 唯一取法，让下一次
 * 「再抄一份窄的」在编译期就红。
 */
export interface ClickMods {
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
}

/**
 * 从事件取修饰键的唯一入口。
 *
 * 收成结构类型（而不是 `MouseEvent`）：`core` 零 DOM，而调用方既有鼠标事件也有
 * 键盘事件，它们在这四个字段上同形。
 */
export function clickModsOf(e: {
  altKey?: boolean
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
}): ClickMods {
  return {
    altKey: e.altKey === true,
    shiftKey: e.shiftKey === true,
    metaKey: e.metaKey === true,
    ctrlKey: e.ctrlKey === true,
  }
}

/**
 * 一次点击的动作：`⌥` 优先于 `Shift`，`Shift` 优先于 `⌘`/`Ctrl`。
 *
 * 组合键只产生一种语义（⌥+Shift 仍是「看第二层」），不让用户去记两两组合。
 */
export function openActionOf(mods: OpenMods = {}): OpenAction {
  if (mods.altKey) return 'inspect'
  if (mods.shiftKey) return 'dock'
  if (mods.metaKey || mods.ctrlKey) return 'tab'
  return 'center'
}

/**
 * 中心落点的**语义**：内容面「聚焦到这一块」；导航面（左槽行、面包屑返回）
 * 只换当前对象、不抢焦点。两者本来就有差异，统一入口时不要把它们悄悄合并。
 */
export interface OpenOpts {
  center?: 'focus' | 'keep'
  feed?: boolean
  restore?: 'saved' | 'none'
}
