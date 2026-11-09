/**
 * **一次点击去哪／看什么**：修饰键只回答这一个问题，不回答「打开什么」。
 *
 * 为什么把它收成一份纯函数：同一个动作在正文块标、面包屑、行内引用、属性区、
 * 左槽行、查询的六种看法、日历格里各写一遍 if/else，必然有两处漂移
 * （实测：槽里的行认 Shift 不认 ⌘，而文档头面包屑正好相反）。
 * 事件层只把鼠标上的修饰键交进来（`clickModsOf`），分流由装配层按这唯一一份判据做。
 *
 * 五档与优先级：
 *   · `⌥` → `inspect`：**看这一处自己的第二层**（有 run 的露面＝那一枚的详情；
 *     块级指针＝这一块的属性面板）。优先级最高：组合键只产生一种语义。
 *   · `⌘/Ctrl + Shift` → `tabWide`：在新页签打开，**并一次性进宽屏**。
 *   · `Shift` → `dock`：在右槽开一个窗口（并排看）。
 *   · `⌘/Ctrl` → `tab`：在新页签打开（另开一处看）。
 *   · 无修饰 → `center`：默认动作（打开/聚焦）。
 *
 * ⚠️ **`tabWide` 不是第五个落点**，是 `tab` 的一次性加强：档位仍住窗口（布局归窗口、内容归 tab），
 *    切 tab 不换档位、Esc 一次退回。只承认这一个两键组合——其余组合仍按优先级归一，
 *    不开「两两组合」的矩阵（⌥+Shift 仍是看第二层）。
 * ⚠️ **`⌥` 不是落点**：它不改「你在哪」，只把这一处自己的东西展开一层。
 *    所以 `inspect` 与另外几档的区别是**生命周期**（瞬态 vs 常驻），不是位置。
 */
export type OpenAction = 'center' | 'dock' | 'tab' | 'inspect' | 'tabWide'

/** 三个真正的落点（`inspect` 不是「去哪」；`tabWide` 是 `tab` 的加强，不是新落点）。 */
export type OpenPlace = Exclude<OpenAction, 'inspect' | 'tabWide'>

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
 * 一次点击的动作：`⌥` 优先，其次 `⌘/Ctrl + Shift`，再 `Shift`，最后 `⌘/Ctrl`。
 *
 * 组合键只产生一种语义，不让用户去记两两组合；`tabWide` 是唯一被承认的两键组合，
 * 因为它是「⌘+点」的加强（同一落点 ＋ 一次性给足空间），不是新的落点种类。
 */
export function openActionOf(mods: OpenMods = {}): OpenAction {
  if (mods.altKey) return 'inspect'
  if ((mods.metaKey === true || mods.ctrlKey === true) && mods.shiftKey === true) return 'tabWide'
  if (mods.shiftKey) return 'dock'
  if (mods.metaKey || mods.ctrlKey) return 'tab'
  return 'center'
}

/**
 * 复合动作在这里**只拆一次**：只关心「去哪」的下游（命令参数白名单等）用 `openPlaceOf`
 * 归一，不必懂宽屏；装配层用 `openAxisOf` 施加一次性档位。
 *
 * 为什么不把 axis 做成每个入口多传的一个参数：那些入口的修饰键结构被抄窄过三次
 * （见 `ClickMods` 注释），多一个必传字段就多一处静默退化的机会。
 */
export function openPlaceOf(action: OpenAction): Exclude<OpenAction, 'tabWide'> {
  return action === 'tabWide' ? 'tab' : action
}

/** 这一次打开要不要顺手进档位；`null` ＝ 不碰窗口（档位是窗口任务态：不写 prefs、不跨会话）。 */
export function openAxisOf(action: OpenAction): 'wide' | null {
  return action === 'tabWide' ? 'wide' : null
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
