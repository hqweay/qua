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

/** 单个槽的本地状态（宽度、开关、钉住的块都是设备状态，不入 KB） */
export interface DockSlotPrefs {
  open: boolean
  /** 用户拖过的宽度；`null` ＝ 没拖过，用 token 里的默认值 */
  width: number | null
  /**
   * 钉在这个槽里的块 id（**有序**，按钉入的先后）。
   *
   * 它只是**视图状态**：块仍然只有森林里那一份，这里存的是「要看哪几个」。
   * 于是删块/撤销都不会被这份清单污染 —— 渲染时按 id 去森林里找，找不到就不画。
   */
  pins: string[]
}

export interface DockPrefs {
  left: DockSlotPrefs
  right: DockSlotPrefs
}

/**
 * 默认槽状态：**左右都开**。
 *
 * 判据（32 「不加空侧栏」的准确读法）：反对的是**空侧栏**，不是侧栏本身。
 * 右槽默认装「反链」这一块，有内容 ⇒ 开着不违反 。
 * 宽度 `null` ⇒ 用 token 的默认值（`--ui-dock-w-left`／`--ui-dock-w-right`）。
 */
export const DEFAULT_DOCK: DockPrefs = {
  left: { open: true, width: null, pins: [] },
  right: { open: true, width: null, pins: [] },
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
 */
export function normalizePrefs(raw: Partial<Prefs> | undefined): Prefs {
  const p = raw ?? {}
  const dock = p.dock
  const pick = (slot: DockSlotPrefs | undefined, fallback: DockSlotPrefs): DockSlotPrefs => ({
    open: typeof slot?.open === 'boolean' ? slot.open : fallback.open,
    width: typeof slot?.width === 'number' && Number.isFinite(slot.width) ? slot.width : null,
    // 形状兜底：缺字段 ⇒ 空；非字符串与重复值一律丢掉（重复会让同一个块在槽里出现两次）
    pins: Array.isArray(slot?.pins)
      ? [...new Set(slot.pins.filter((id): id is string => typeof id === 'string' && id !== ''))]
      : [],
  })
  return {
    ...DEFAULT_PREFS,
    ...p,
    // 段排列只认两档（grid 轴未开）：别的值一律回单列，不让坏形状进偏好
    feedLayout: p.feedLayout === 'row' ? 'row' : 'column',
    dock: {
      left: pick(dock?.left, DEFAULT_DOCK.left),
      right: pick(dock?.right, DEFAULT_DOCK.right),
    },
    railOpen: undefined,
  }
}
