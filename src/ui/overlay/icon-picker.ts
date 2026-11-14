/**
 * **图标选择器**（浮层）：三源里本轮接**矢量**（全量 catalog 即目录）与**手动**
 * （一个输入框）；emoji 随数据集一轮接为默认 tab。
 *
 * 形状（浮层三问）：会消失 ⇒ 浮层语言（影与圆角）；36px 格＋2px gap、8 列
 * （命中区推到指头）；有选中态 ⇒ hover 中性、选中 accent。
 *
 * 键盘：开即聚焦搜索框；↑↓←→／↵／Esc；**IME 组合期不触发选中**（搜索面先例——
 * 组合中的 Enter 是「确认候选字」，不是「选这个图标」）。
 * 每格 `data-tip` 带图标名，无解释文字——名字即目录。
 *
 * 三件可选件（都是显式动作）：
 *   · **⊘ 无图标**：摘键，回落角色默认——「入口在，值可以不在」的摘法；
 *   · **最近使用**：设备态，由调用方给名单、在选中时记账（不进 KB）；
 *   · **颜色行**（调用方给了颜色回调才画）：⊘ 中性 ＋ 色板封闭集，
 *     点了立即生效不关浮层——色与脸是两条轴，一次只动一条。
 */
import { IDENTITY_COLORS } from '../../core/index.ts'
import { ICON_PATHS, createIcon, isIconRef } from '../../view/icons.ts'
import { identityTokenVar } from '../../core/identity/faces.ts'
import type { Layers } from './layers.ts'
import { t } from '../../core/infra/msg.ts'

export interface IconPickerOpts {
  layers: Layers
  anchor: DOMRect | null
  trigger?: HTMLElement
  /** 当前图标值（'' ＝ 无脸）；当前值的那一格标选中态 */
  current: string
  /** 选了图标（'' ＝ 摘）⇒ 关浮层（`keepOpen` 时例外，见下） */
  onPick: (icon: string) => void
  /** 当前身份色（色板 key 或 ''）；给了 onColor 才画颜色行 */
  color?: string
  /** 选了色（'' ＝ 摘）⇒ 不关浮层、就地更新选中态 */
  onColor?: (color: string) => void
  /** 最近使用的图标值（最新在前）；给了才画那一行 */
  recent?: readonly string[]
  /**
   * **选完不关**（宿主自己管理生命周期）：嵌在别的浮层/面板里时用——
   * 别的浮层（别名编辑器）已经占着 popover 位，再开一层就是把宿主顶掉了。
   * 选完重画自己以更新选中态，宿主在 onPick 里自己决定要不要收。
   */
  keepOpen?: boolean
}

/** 网格列数：键盘 ←→ 按它跨行（与 CSS 的 `grid-template-columns` 同一个数） */
const GRID_COLS = 8

interface Cell {
  /** 图标槽的值（`lucide:<name>` 或字面）；'' ＝ ⊘ 摘键 */
  value: string
  el: HTMLButtonElement
}

export function openIconPicker(o: IconPickerOpts): void {
  o.layers.openPopover(
    (host) => renderIconPicker(host, o),
    o.anchor,
    undefined,
    o.trigger ? { el: o.trigger } : undefined,
  )
}

/** 把选择器画进 `host`（独立浮层与内嵌宿主共用这一份装配；选中态每次现算） */
export function renderIconPicker(host: HTMLElement, o: IconPickerOpts): void {
  let tab: 'vector' | 'manual' = 'vector'
  let query = ''
  let cells: Cell[] = []
  let active = -1

  const box = document.createElement('div')
  box.className = 'icon-picker'

  /* ------------------------------------------------------------ 颜色行 */

  if (o.onColor) {
    const colorRow = document.createElement('div')
    colorRow.className = 'icon-picker-colors'
    const mkSwatch = (key: string, tip: string): HTMLButtonElement => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'icon-picker-swatch'
      b.dataset.tip = tip
      if (key === '') b.dataset.none = '1'
      else b.style.setProperty('--swatch', identityTokenVar(key))
      b.addEventListener('click', () => {
        o.onColor!(key)
        syncColor(key)
      })
      return b
    }
    const none = mkSwatch('', t('ui.iconPicker.noColor'))
    colorRow.appendChild(none)
    const swatches = new Map<string, HTMLButtonElement>([['', none]])
    for (const key of IDENTITY_COLORS) {
      const b = mkSwatch(key, t('ui.iconPicker.colorTip', { color: key }))
      swatches.set(key, b)
      colorRow.appendChild(b)
    }
    const syncColor = (key: string): void => {
      for (const [k, el] of swatches) {
        if (k === key) el.dataset.on = '1'
        else delete el.dataset.on
      }
    }
    syncColor(o.color ?? '')
    box.appendChild(colorRow)
  }

  /* ------------------------------------------------------------ tab 条 */

  const tabs = document.createElement('div')
  tabs.className = 'icon-picker-tabs'
  const tabVector = document.createElement('button')
  tabVector.type = 'button'
  tabVector.className = 'icon-picker-tab ui-btn'
  tabVector.textContent = t('ui.iconPicker.tabVector')
  const tabManual = document.createElement('button')
  tabManual.type = 'button'
  tabManual.className = 'icon-picker-tab ui-btn'
  tabManual.textContent = t('ui.iconPicker.tabManual')
  tabs.append(tabVector, tabManual)
  box.appendChild(tabs)

  /* ------------------------------------------------------------ 矢量面 */

  const search = document.createElement('input')
  search.type = 'text'
  search.className = 'icon-picker-search ui-field'
  search.placeholder = t('ui.iconPicker.searchPlaceholder')
  search.spellcheck = false

  const recentRow = document.createElement('div')
  recentRow.className = 'icon-picker-grid icon-picker-recent'
  const recentTitle = document.createElement('div')
  recentTitle.className = 'icon-picker-section'
  recentTitle.textContent = t('ui.iconPicker.recent')

  const grid = document.createElement('div')
  grid.className = 'icon-picker-grid'

  const setTab = (next: 'vector' | 'manual'): void => {
    tab = next
    if (tab === 'vector') tabVector.dataset.on = '1'
    else delete tabVector.dataset.on
    if (tab === 'manual') tabManual.dataset.on = '1'
    else delete tabManual.dataset.on
    manualBox.hidden = tab !== 'manual'
    search.hidden = tab !== 'vector'
    recentRow.hidden = tab !== 'vector' || (o.recent?.length ?? 0) === 0
    recentTitle.hidden = recentRow.hidden
    if (tab === 'vector') {
      renderGrid()
      search.focus()
    } else {
      cells = []
      markActive()
      manualInput.focus()
    }
  }
  tabVector.addEventListener('click', () => setTab('vector'))
  tabManual.addEventListener('click', () => setTab('manual'))
  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase()
    renderGrid()
  })

  /** 一格：图标 ＋ 原始值住 data-icon（样式与断言都看它） */
  const mkCell = (value: string, tip: string): Cell => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'icon-picker-cell'
    b.dataset.tip = tip
    if (value === '') {
      b.dataset.none = '1'
      b.appendChild(createIcon('ban', 'sm'))
    } else {
      const host = document.createElement('span')
      b.dataset.icon = value
      if (isIconRef(value)) {
        const name = value.slice('lucide:'.length)
        if (name in ICON_PATHS) host.appendChild(createIcon(name as keyof typeof ICON_PATHS, 'sm'))
        else host.appendChild(createIcon('circle-help', 'sm'))
      } else {
        host.textContent = value
      }
      b.appendChild(host)
    }
    b.addEventListener('click', () => {
      o.onPick(value)
      if (o.keepOpen) renderIconPicker(host, o)
      else o.layers.closePopover()
    })
    return { value, el: b }
  }

  const renderGrid = (): void => {
    grid.replaceChildren()
    cells = []
    // ⊘ 排最前：显式摘键是显式动作，不该藏在滚动尽头
    const none = mkCell('', t('ui.iconPicker.noIcon'))
    cells.push(none)
    grid.appendChild(none.el)
    const names = Object.keys(ICON_PATHS).filter((n) => n.includes(query))
    // 集合大 ⇒ 上限不是砍功能，是把「翻不到底」变成「打字就有」（搜索是主入口）
    for (const n of names.slice(0, 96)) {
      const cell = mkCell(`lucide:${n}`, n)
      cells.push(cell)
      grid.appendChild(cell.el)
    }
    markActive()
  }

  /** 最近使用：同一套格子，行在最上（点了也记账——记账归调用方的 onPick） */
  const renderRecent = (): void => {
    recentRow.replaceChildren()
    for (const v of o.recent ?? []) {
      // 名字已不在 catalog 的（vendor 升级后改名）不画——画出来只会是占位问号
      if (isIconRef(v) && !(v.slice('lucide:'.length) in ICON_PATHS)) continue
      recentRow.appendChild(mkCell(v, v.startsWith('lucide:') ? v.slice('lucide:'.length) : v).el)
    }
  }
  renderRecent()

  /* ------------------------------------------------------------ 手动面 */

  const manualBox = document.createElement('div')
  manualBox.className = 'icon-picker-manual'
  const manualInput = document.createElement('input')
  manualInput.type = 'text'
  manualInput.className = 'icon-picker-manual-input ui-field'
  manualInput.placeholder = t('ui.iconPicker.manualPlaceholder')
  manualInput.spellcheck = false
  const manualHint = document.createElement('p')
  manualHint.className = 'icon-picker-manual-hint'
  manualHint.textContent = t('ui.iconPicker.manualHint')
  const manualApply = (): void => {
    const v = manualInput.value.trim()
    if (v === '') return
    o.onPick(v)
    if (o.keepOpen) renderIconPicker(host, o)
    else o.layers.closePopover()
  }
  manualInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault()
      manualApply()
    }
  })
  const manualBtn = document.createElement('button')
  manualBtn.type = 'button'
  manualBtn.className = 'ui-btn'
  manualBtn.textContent = t('ui.iconPicker.manualApply')
  manualBtn.addEventListener('click', manualApply)
  manualBox.append(manualInput, manualBtn, manualHint)

  /* ------------------------------------------------------------ 键盘 */

  const markActive = (): void => {
    cells.forEach((c, i) => {
      if (i === active) c.el.dataset.active = '1'
      else delete c.el.dataset.active
    })
  }
  box.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    if (e.key === 'Escape') {
      // 内嵌（keepOpen）时 Escape 归宿主管（外面那层浮层自己有关闭语义）；
      // 独立浮层时 Escape 就是收起自己
      if (!o.keepOpen) {
        e.stopPropagation()
        o.layers.closePopover()
      }
      return
    }
    if (tab !== 'vector' || cells.length === 0) return
    const move = (delta: number): void => {
      e.preventDefault()
      active = Math.min(cells.length - 1, Math.max(0, (active < 0 ? 0 : active) + delta))
      markActive()
      cells[active]?.el.scrollIntoView({ block: 'nearest' })
    }
    if (e.key === 'ArrowRight') move(1)
    else if (e.key === 'ArrowLeft') move(-1)
    else if (e.key === 'ArrowDown') move(GRID_COLS)
    else if (e.key === 'ArrowUp') move(-GRID_COLS)
    else if (e.key === 'Enter') {
      if (active >= 0) {
        e.preventDefault()
        o.onPick(cells[active]!.value)
        if (o.keepOpen) renderIconPicker(host, o)
        else o.layers.closePopover()
      }
    }
  })

  /* ------------------------------------------------------------ 装配 */

  box.append(search, recentTitle, recentRow, grid, manualBox)
  setTab('vector')
  host.replaceChildren(box)
}
