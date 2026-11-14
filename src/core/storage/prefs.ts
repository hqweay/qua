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
import type { SecLayout } from '../query/feed.ts'
import type { DerivedViewKind } from '../views/view.ts'
import { DERIVED_VIEW_KINDS } from '../views/view.ts'
import { canonicalMountEntries, type MountEntry } from '../views/mount.ts'
import { canonicalDockEntries, dockKey, type DockEntry } from '../views/dock.ts'

export type ThemeMode = 'system' | 'light' | 'dark'

export interface Prefs {
  /** 主题三档；设备状态，不入 KB */
  theme: ThemeMode
  /**
   * 日记流的段排列（设备级视图状态，不进 KB——日记流非块、无 props 可挂，与 dock 开关同位）。
   * 值域首版只认 `column`／`row`（grid 轴已定、入口未做）。
   */
  feedLayout: SecLayout
  /**
   * **日记面板的那几栏**（local／derived；与 `feedLayout` 同层）。
   *
   * 为什么是设备状态而不是一个隐藏配置块：日记表面是**系统视图**，不是块 ——
   * 它不可寻址、不进回收站、不参与复制。拿一个块当它的拥有者，
   * 就是用一个不可寻址的对象存「这一台设备怎么看」，而 `feedLayout` 就在旁边。
   *
   * 代价（登记）：日记面板的 local 栏不跨设备；要跨设备/共享就写成查询块（内容对象）。
   */
  journalMounts: MountEntry[]
  /**
   * **派生栏（引用／同类／提及）的看法**（设备状态）。
   *
   * 派生栏没有拥有者：它不拥有条件、也不拥有视图列表。给它造一个 owner 会把
   * 「这一台设备怎么看这一栏」变成内容 —— 换个设备就跟着走，还会多一份能分叉的配置。
   * 键的形状见 `mountViewKey`（块宿主带块 id、日记宿主不带）。
   */
  mountViews: Record<string, DerivedViewKind>
  /**
   * **派生栏（引用／提及）的分组键**（设备状态，与 `mountViews` 同层同键）。
   *
   * 派生栏没有可写的视图配置：分组跟看法一样只是「这一台设备怎么看这一栏」，
   * 存成内容就会跨设备跟着走、还会多一份能分叉的配置。键见 `mountViewKey`。
   */
  mountGroups: Record<string, string>
  /** 三槽的开关与宽度；入口条已作废 */
  dock: DockPrefs
  virtualize: boolean
  radius: number
  /** 角标默认展开？ */
  badgeOpen: boolean
  /**
   * 用户覆盖的键位（设备态：键位回答「这一台机器怎么用」，不进库、不参与同步）。
   *
   * 键＝绑定身份（命令＋参数），值＝新键位；`null` ＝ 摘掉这条键位。
   * 生效在**读绑定表的时候**（`core/infra/bindings.ts`），这里只存用户写下的那份。
   */
  keys: Record<string, string | null>
  /**
   * 命令面板「最近执行」的名单（设备态：这一台机器上跑过什么，不进库、不参与同步）。
   * 只记**从面板成功执行**的命令名，最新在前、去重封顶；形状归 `normalizePrefs`。
   */
  recentCommands: string[]
  /**
   * 图标选择器「最近使用」的名单（设备态：这一台机器上用过什么，不进库）。
   * 只记选过的图标值，最新在前、去重封顶；收藏卡从块退到设备状态的同一判据。
   */
  recentIcons: string[]
  /**
   * 最近的自定义色（hex，258.1；设备态同上）——色行上的「最近自定义」快捷点。
   * 内置板 key 不进来（板本身常驻）；跨设备的「我的色板」要色值进 KB，另行立项。
   */
  recentColors: string[]
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
   * 每项是一个 `DockEntry`：块露面（窗口／组件卡）、派生卡、`cmd:` 小卡、或工具面卡。
   * **种类由 `kind` 说，不由字符串形状猜**（见 `core/dock.ts` 顶部）。
   *
   * 它只是**视图状态**：块仍然只有森林里那一份，这里存的是「看哪几个、怎么排」。
   * 隐藏的卡也留在这里（位置是布局，可用性是内容）；删块/撤销不会污染清单。
   * `cmd` 条目不是块，所以同一个命令可以同时出现在左右两槽；块仍全局最多一张。
   */
  cards: DockEntry[]
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
   * 常驻的窗口卡（**只记 pin 了**的）。pin 的卡重启保留；没 pin 的块窗口卡重启即清
   * （`pruneEphemeralWindows`）。按卡片实例 key 存（与 `collapsedCards` 同一口径），
   * 跨槽移动后状态跟着卡走。
   *
   * 只作用于**窗口卡**：派生卡／命令小卡／组件卡是槽的家具，永远保留，
   * 所以没有 pin 位（它们的入口也不会写这张表，UI 不给它们 pin 开关）。
   */
  pinnedCards: Record<string, true>
  /**
   * 单卡（只看这一张）：每侧独立。`null` ＝ 不单卡。
   *
   * 目标不可见时**不生效**（照常显示其它卡）；状态保留，目标回来时自动再生效。
   *
   * ⚠️ 单卡**不改 `collapsedCards`**：收着的卡进单卡时「这一张此刻展开」是叠在
   *    渲染上的一层（与中心「聚焦即展开」同一条判据），退出单卡自动回到收着 ——
   *    所以不需要记「solo 前收没收」那种快照。判据只有一份：`core/dock.ts` 的
   *    `isCardCollapsed`。
   */
  solo: { left: string | null; right: string | null }
}

/**
 * 默认槽状态：**左右都开**。
 *
 * 判据（「不加空侧栏」的准确读法）：反对的是**空侧栏**，不是侧栏本身。
 * 左槽默认「四个快捷在上、日历与归属树在下」；右槽默认「检视卡在上、反链在下」。
 * 宽度 `null` ⇒ 用 token 的默认值（`--ui-dock-w-left`／`--ui-dock-w-right`）。
 */
export const DEFAULT_DOCK: DockPrefs = {
  left: {
    open: true,
    width: null,
    cards: [
      { kind: 'cmd', command: 'core.journal/today' },
      { kind: 'cmd', command: 'core.page/new' },
      { kind: 'cmd', command: 'core.command-palette/show' },
      { kind: 'cmd', command: 'core.journal/prev' },
      { kind: 'derived', card: 'calendar' },
      { kind: 'derived', card: 'belongs' },
    ],
  },
  right: {
    open: true,
    width: null,
    cards: [
      { kind: 'derived', card: 'inspect' },
      { kind: 'derived', card: 'mount' },
      { kind: 'derived', card: 'trash' },
    ],
  },
  collapsedCards: {},
  pinnedCards: {},
  solo: { left: null, right: null },
}

export const DEFAULT_PREFS: Prefs = {
  theme: 'system',
  feedLayout: 'column',
  journalMounts: [],
  mountViews: {},
  mountGroups: {},
  dock: DEFAULT_DOCK,
  virtualize: false,
  radius: 12,
  badgeOpen: false,
  keys: {},
  recentCommands: [],
  recentIcons: [],
  recentColors: [],
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

  const pick = (
    slot: Partial<DockSlotPrefs> | undefined,
    fallback: DockSlotPrefs,
    pins: string[],
  ): DockSlotPrefs & { legacyPinned: string[] } => {
    // `cards` 缺失 ⇒ 默认布局 ＋ 旧 `pins`；存在就只认它（逐项归一，坏项丢掉）
    const hasCards = Array.isArray(slot?.cards)
    const cards = canonicalDockEntries(hasCards ? slot!.cards : [...fallback.cards, ...pins])
    return {
      open: typeof slot?.open === 'boolean' ? slot.open : fallback.open,
      width: typeof slot?.width === 'number' && Number.isFinite(slot.width) ? slot.width : null,
      cards,
      // 旧「钉住清单」是今天 pin 的前身：被钉住的窗口重启清理不碰。
      // 只在它真的并进 cards 时认（`cards` 一旦存在就只认它，旧 pins 整体作废）。
      legacyPinned: hasCards ? [] : pins,
    }
  }

  const left = pick(dock?.left, DEFAULT_DOCK.left, legacyPins(dock?.left))
  const right = pick(dock?.right, DEFAULT_DOCK.right, legacyPins(dock?.right))
  // 一个块全局最多一张窗口：同一个块/派生卡不留在两边。
  // 左槽先到先得——默认布局里左槽是导航位，冲突时保留它更符合直觉。
  // `cmd` 不是块，同一个命令可以两槽都有（它没有窗口状态可冲突）。
  // 盘**摊平一层参与去重**：同一颗快捷卡不该同时躺在两槽的盘里；
  // 从右槽盘里摘走成员后盘空了就一并解散（容器是内容的推论）。
  const shared = (e: DockEntry): boolean => e.kind !== 'cmd'
  const leftKeys = new Set<string>()
  for (const e of left.cards) {
    if (shared(e)) leftKeys.add(dockKey(e))
    if (e.kind === 'tray') for (const m of e.cards) if (shared(m)) leftKeys.add(dockKey(m))
  }
  const dropShared = (cards: DockEntry[]): DockEntry[] => {
    const out: DockEntry[] = []
    for (const e of cards) {
      if (e.kind !== 'tray') {
        if (!shared(e) || !leftKeys.has(dockKey(e))) out.push(e)
        continue
      }
      const members = e.cards.filter((m) => !shared(m) || !leftKeys.has(dockKey(m)))
      if (members.length === e.cards.length) out.push(e)
      else if (members.length > 0) out.push({ ...e, cards: members })
      // 全被摘走 ⇒ 盘空了解散；一只都不缺就原样保留（不去重不动它）
    }
    return out
  }
  right.cards = dropShared(right.cards)

  const collapsedCards: Record<string, true> = {}
  if (dock?.collapsedCards && typeof dock.collapsedCards === 'object' && !Array.isArray(dock.collapsedCards)) {
    for (const [k, v] of Object.entries(dock.collapsedCards)) if (v === true && k !== '') collapsedCards[k] = true
  }
  const pinnedCards: Record<string, true> = {}
  if (dock?.pinnedCards && typeof dock.pinnedCards === 'object' && !Array.isArray(dock.pinnedCards)) {
    for (const [k, v] of Object.entries(dock.pinnedCards)) if (v === true && k !== '') pinnedCards[k] = true
  }
  // 旧钉住清单并进来的块窗口＝已 pin（表里只留真的在 cards 里的键）
  for (const id of [...left.legacyPinned, ...right.legacyPinned]) {
    if (left.cards.some((e) => dockKey(e) === id) || right.cards.some((e) => dockKey(e) === id)) pinnedCards[id] = true
  }
  const solo = (side: 'left' | 'right', cards: DockEntry[]): string | null => {
    const id = dock?.solo?.[side]
    return typeof id === 'string' && id !== '' && cards.some((e) => dockKey(e) === id) ? id : null
  }

  /**
   * 派生栏的看法：逐格验形，**未知值丢掉**（不是回退成某个值）。
   *
   * 丢掉 = 那一格没有配置 ⇒ 大纲。写成 `'outline'` 会把「用户选过大纲」与
   * 「没有过选择」混成同一件事，而后者将来改默认值时该跟着变。
   */
  const mountViews: Record<string, DerivedViewKind> = {}
  if (p.mountViews && typeof p.mountViews === 'object' && !Array.isArray(p.mountViews)) {
    for (const [k, v] of Object.entries(p.mountViews)) {
      if (typeof k !== 'string' || k === '') continue
      if (typeof v === 'string' && (DERIVED_VIEW_KINDS as readonly string[]).includes(v)) {
        mountViews[k] = v as DerivedViewKind
      }
    }
  }
  // 派生栏的分组键：同 mountViews 的逐格验形（非空串才收，'' ＝ 没分组，不必记）
  const mountGroups: Record<string, string> = {}
  if (p.mountGroups && typeof p.mountGroups === 'object' && !Array.isArray(p.mountGroups)) {
    for (const [k, v] of Object.entries(p.mountGroups)) {
      if (typeof k === 'string' && k !== '' && typeof v === 'string' && v !== '') mountGroups[k] = v
    }
  }

  // 用户键位覆盖：身份非空、值是键位串或「摘掉」（null）。别的形状丢掉，不猜
  const keys: Record<string, string | null> = {}
  if (p.keys && typeof p.keys === 'object' && !Array.isArray(p.keys)) {
    for (const [id, key] of Object.entries(p.keys)) {
      if (typeof id !== 'string' || id === '') continue
      if (key === null || (typeof key === 'string' && key !== '')) keys[id] = key
    }
  }

  // 最近执行的命令名：非空串才收，去重、封顶——它只是面板顶部的「再来一次」名单
  const recentCommands = Array.isArray(p.recentCommands)
    ? [...new Set(p.recentCommands.filter((n): n is string => typeof n === 'string' && n !== ''))].slice(0, 12)
    : []

  // 最近使用的图标值：非空串才收，去重、封顶（24 ≈ 两屏网格的一行量）——它是选择器的快捷行
  const recentIcons = Array.isArray(p.recentIcons)
    ? [...new Set(p.recentIcons.filter((n): n is string => typeof n === 'string' && n !== ''))].slice(0, 24)
    : []

  // 最近的自定义色：只收 hex 形状（`#rrggbb`）且统一小写，去重、封顶 6——色行一行的量
  const recentColors = Array.isArray(p.recentColors)
    ? [
        ...new Set(
          p.recentColors
            .filter((n): n is string => typeof n === 'string' && /^#[0-9a-fA-F]{6}$/.test(n))
            .map((n) => n.toLowerCase()),
        ),
      ].slice(0, 6)
    : []

  return {
    ...DEFAULT_PREFS,
    ...p,
    // 段排列只认两档（grid 轴未开）：别的值一律回单列，不让坏形状进偏好
    feedLayout: p.feedLayout === 'row' ? 'row' : 'column',
    // 日记面板的栏：逐项重建（坏项丢掉），与 `_mounts` 共用同一份判据
    journalMounts: canonicalMountEntries(p.journalMounts),
    mountViews,
    mountGroups,
    keys,
    recentCommands,
    recentIcons,
    recentColors,
    dock: {
      // `legacyPinned` 只在归一内部用，不进落盘形状
      left: { open: left.open, width: left.width, cards: left.cards },
      right: { open: right.open, width: right.width, cards: right.cards },
      collapsedCards,
      pinnedCards,
      solo: { left: solo('left', left.cards), right: solo('right', right.cards) },
    },
    railOpen: undefined,
  }
}
