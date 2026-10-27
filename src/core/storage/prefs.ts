/**
 * 本地偏好（**设备状态**：不进 KB、不参与同步）。
 *
 * 单独成文件的原因：偏好有它自己的形状兜底与默认值，和「库里有几块」完全是两件事。
 * `shape.ts` 只负责把这些字段拼进整份库；这里负责它们**各自的意义与默认**。
 */

/**
 * 主题三档：**跟随系统 / 亮 / 暗**。
 * 默认 `system`：颜色由 CSS 的 `color-scheme` ＋ `light-dark()` 决定，JS 只记档位、不切类。
 *
 * ⚠️ **不再有 `skin`**（2026-10-20）：甲／乙／丙三套内建皮肤整体删除，
 *    内建只保留一种「中性现代大纲」。观感要调就改 token，不再按皮肤分叉。
 */
import type { SecLayout } from '../feed.ts'

export type ThemeMode = 'system' | 'light' | 'dark'

export interface Prefs {
  /** 主题三档；设备状态，不入 KB */
  theme: ThemeMode
  /**
   * 日记流的段排列（设备级视图状态，不进 KB——日记流非块、无 props 可挂，与 dock 开关同位）。
   * 值域首版只认 `column`／`row`（grid 轴已定、入口未做）。
   */
  feedLayout: SecLayout
  /** 三槽的开关与宽度；入口条已作废 */
  dock: DockPrefs
  virtualize: boolean
  radius: number
  /** 角标默认展开？ */
  badgeOpen: boolean
  /** @deprecated 2026-10-19 起的旧形状；只用于读迁移，写一律写 `dock` */
  railOpen?: boolean
}

/** 单个槽的本地状态（宽度、开关、卡片顺序都是设备状态，不入 KB） */
export interface DockSlotPrefs {
  open: boolean
  /** 用户拖过的宽度；`null` ＝ 没拖过，用 token 里的默认值 */
  width: number | null
  /**
   * 这一槽的 Widget，**有序**。
   *
   * 三种 id 混在同一个列表里：
   *   · 块 id（32 位 hex）＝ 一个块的一次露面（窗口卡；以后也可以是组件块）；
   *   · 派生卡 id（`belongs`／`journal`／`inspect`／`backrefs`）＝ 宿主现算的视图卡；
   *   · `cmd:<命令名>` ＝ 一个**小卡**：没有块，点击执行这条命令。
   *
   * 它只是**视图状态**：块仍然只有森林里那一份，这里存的是「看哪几个、怎么排」。
   * 隐藏的卡也留在这里（位置是布局，可用性是内容）；删块/撤销不会污染清单。
   * `cmd:` 条目不是块，所以同一个命令可以同时出现在左右两槽；块 id 仍全局最多一张。
   */
  cards: string[]
}

export interface DockPrefs {
  left: DockSlotPrefs
  right: DockSlotPrefs
  /**
   * 收起的卡（**只记收起的**，与块的 `folded` 同一口径）。
   *
   * 按卡片实例 id 存——跨槽移动后状态跟着卡走；不按 `(side,id)`。
   * 收起只隐藏 body，不销毁编辑器（窗口里可能有正在输入的表单/正文）。
   */
  collapsedCards: Record<string, true>
  /**
   * 单卡（只看这一张）：每侧独立。`null` ＝ 不单卡。
   *
   * 目标不可见时**不生效**（照常显示其它卡）；状态保留，目标回来时自动再生效。
   */
  solo: { left: string | null; right: string | null }
}

/**
 * 默认槽状态：**左右都开**。
 *
 * 判据（32 「不加空侧栏」的准确读法）：反对的是**空侧栏**，不是侧栏本身。
 * 左槽默认「四个快捷在上、归属树与今日在下」；右槽默认「检视卡在上、反链在下」。
 * 宽度 `null` ⇒ 用 token 的默认值（`--ui-dock-w-left`／`--ui-dock-w-right`）。
 */
export const DEFAULT_DOCK: DockPrefs = {
  left: {
    open: true,
    width: null,
    cards: [
      'cmd:core.journal/today',
      'cmd:core.page/new',
      'cmd:core.command-palette/show',
      'cmd:core.journal/prev',
      'belongs',
      'journal',
    ],
  },
  right: { open: true, width: null, cards: ['inspect', 'backrefs'] },
  collapsedCards: {},
  solo: { left: null, right: null },
}

export const DEFAULT_PREFS: Prefs = {
  theme: 'system',
  feedLayout: 'column',
  dock: DEFAULT_DOCK,
  virtualize: false,
  radius: 12,
  badgeOpen: false,
}

/**
 * 偏好归一：只做**形状兜底**（缺字段补默认），**不做旧库迁移**（原型不需要兼容）。
 *
 * 设备状态例外地保留一条**读时并入**：老设备状态里只有 `pins`（旧钉住清单），
 * 没有 `cards`。它不落盘版本、不作废旧库；一次性把 `pins` 接进 `cards` 即可，
 * 之后 `cards` 一旦存在就只认它（用户删掉的窗口不会被旧 `pins` 复活）。
 */
export function normalizePrefs(raw: Partial<Prefs> | undefined): Prefs {
  const p = raw ?? {}
  const dock = p.dock as
    | (Partial<DockPrefs> & {
        left?: Partial<DockSlotPrefs> & { pins?: unknown }
        right?: Partial<DockSlotPrefs> & { pins?: unknown }
      })
    | undefined
  /** 旧设备状态的钉住清单（只作为 `cards` 缺失时的种子） */
  const legacyPins = (slot: { pins?: unknown } | undefined): string[] =>
    Array.isArray(slot?.pins)
      ? slot.pins.filter((id): id is string => typeof id === 'string' && id !== '')
      : []
  const ids = (v: unknown): string[] =>
    Array.isArray(v) ? [...new Set(v.filter((id): id is string => typeof id === 'string' && id !== ''))] : []

  const pick = (slot: Partial<DockSlotPrefs> | undefined, fallback: DockSlotPrefs, pins: string[]): DockSlotPrefs => {
    const cards = Array.isArray(slot?.cards) ? ids(slot.cards) : ids([...fallback.cards, ...pins])
    return {
      open: typeof slot?.open === 'boolean' ? slot.open : fallback.open,
      width: typeof slot?.width === 'number' && Number.isFinite(slot.width) ? slot.width : null,
      cards,
    }
  }

  const left = pick(dock?.left, DEFAULT_DOCK.left, legacyPins(dock?.left))
  const right = pick(dock?.right, DEFAULT_DOCK.right, legacyPins(dock?.right))
  // 一个块全局最多一张窗口：同一个块 id（或派生卡）不留在两边。
  // 左槽先到先得——默认布局里左槽是导航位，冲突时保留它更符合直觉。
  // `cmd:` 不是块，同一个命令可以两槽都有（它没有窗口状态可冲突）。
  const leftSet = new Set(left.cards.filter((id) => !id.startsWith('cmd:')))
  right.cards = right.cards.filter((id) => id.startsWith('cmd:') || !leftSet.has(id))

  const collapsedCards: Record<string, true> = {}
  if (dock?.collapsedCards && typeof dock.collapsedCards === 'object' && !Array.isArray(dock.collapsedCards)) {
    for (const [k, v] of Object.entries(dock.collapsedCards)) if (v === true && k !== '') collapsedCards[k] = true
  }
  const solo = (side: 'left' | 'right', cards: string[]): string | null => {
    const id = dock?.solo?.[side]
    return typeof id === 'string' && id !== '' && cards.includes(id) ? id : null
  }

  return {
    ...DEFAULT_PREFS,
    ...p,
    // 段排列只认两档（grid 轴未开）：别的值一律回单列，不让坏形状进偏好
    feedLayout: p.feedLayout === 'row' ? 'row' : 'column',
    dock: {
      left,
      right,
      collapsedCards,
      solo: { left: solo('left', left.cards), right: solo('right', right.cards) },
    },
    railOpen: undefined,
  }
}
