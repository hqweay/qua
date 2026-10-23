/**
 * 浮层渲染层 —— **菜单不是手写组件，是绑定表的渲染结果**。
 *
 * 同一个渲染器服务五处：块菜单 / 斜杠菜单 / **划选气泡** / 命令面板 / 引用选择器。
 * 面板（上下文键、绑定表、速查、模型 JSON）与 toast 也在这里，保证三套皮肤下观感一致。
 *
 * ⚠️ 划选气泡（`openSelectionBar`）与菜单**不是同一个东西**：
 *   它锚在选区上方、常驻在选区存在期间（不是按 Esc 才关），且**不能抢焦点**——
 *   一抢焦点原生选区就塌了，加粗就加到了空选区上。
 */
import { keyLabel, type Binding } from '../core/bindings.ts'
import { DECL_BY_NAME, type CommandDecl } from '../core/commands/index.ts'
// ⚠️ 三个收敛点之三：UI 组件的文案一律走 t
import { t } from '../core/msg.ts'
import { renderIcon } from '../view/icons.ts'

export interface Row {
  id: string
  label: string
  hint?: string
  icon?: string
  group?: string
  command?: string
  args?: unknown
  keyHint?: string
  disabled?: boolean
}

const GROUP_TITLES: Record<string, string> = {
  'block/1-basic': t('menu.group.basic'),
  'block/2-structure': t('menu.group.structure'),
  'block/3-kind': t('menu.group.blockKind'),
  'block/4-inline': t('menu.group.inline'),
  'block/5-mark': t('menu.group.mark'),
  'slash/1-basic': t('menu.group.basic'),
  'slash/2-inline': t('menu.group.inlineAtom'),
  'slash/3-structure': t('menu.group.structure'),
  'sel/1-mark': t('menu.group.mark'),
  'sel/2-ref': t('menu.group.ref'),
  'dbg/1-look': t('menu.group.debugLook'),
  'dbg/2-theme': t('menu.group.debugTheme'),
  'dbg/3-state': t('menu.group.debugState'),
}

export function groupTitle(g: string | undefined): string {
  if (!g) return ''
  // 命令面板的分组就是命令自己的 category，别把 `palette/` 前缀露给用户
  if (g.startsWith('palette/')) return g.slice('palette/'.length)
  return GROUP_TITLES[g] ?? g
}

/** 绑定 → 行（菜单/斜杠/工具栏/面板都用它；标题来自**命令表**，绑定只负责挂载点） */
export function rowsFromBindings(
  bs: Binding[],
  keyHints: Map<string, string> = new Map(),
  opts: { showKeywords?: boolean } = {},
): Row[] {
  return bs.map((b) => {
    const decl = DECL_BY_NAME.get(b.command)
    return {
      id: `${b.command}|${b.group ?? ''}|${JSON.stringify(b.args ?? null)}`,
      label: b.label ?? decl?.title ?? b.command,
      // 关键词只在**斜杠菜单**里露出来（那就是它的搜索别名）；块菜单里只留键位，别吵
      hint: opts.showKeywords ? (b.keywords?.join(' · ') ?? decl?.keywords?.join(' · ')) : undefined,
      icon: b.icon,
      group: b.group,
      command: b.command,
      args: b.args,
      keyHint: b.key ? keyLabel(b.key) : keyHints.get(b.command),
    }
  })
}

export interface MenuOpts {
  rows: Row[]
  anchor: DOMRect | null
  title?: string
  searchable?: boolean
  /** 斜杠菜单要保持编辑器焦点（打字继续过滤）⇒ false */
  focusSearch?: boolean
  placeholder?: string
  emptyText?: string
  onPick: (row: Row) => void
  onQuery?: (q: string) => void
  onClose?: () => void
}

export class Layers {
  private el: HTMLElement | null = null
  private listEl: HTMLElement | null = null
  private inputEl: HTMLInputElement | null = null
  private rows: Row[] = []
  /** 未过滤的全部行（过滤必须从这里取，否则第二次搜索会搜「上一次的结果」） */
  private allRows: Row[] = []
  private active = 0
  private opts: MenuOpts | null = null
  private drawerEl: HTMLElement | null = null
  private toastEl: HTMLElement | null = null
  private popEl: HTMLElement | null = null
  /** 划选气泡（顶部工具栏作废后的落点，2026-10-19）*/
  private selEl: HTMLElement | null = null
  open = false

  constructor(private isMac: () => boolean) {
    document.addEventListener(
      'keydown',
      (e) => {
        if (!this.open) return
        const ke = e as KeyboardEvent
        const k = ke.key
        if (k === 'ArrowDown' || k === 'ArrowUp') {
          ke.preventDefault()
          ke.stopPropagation()
          this.move(k === 'ArrowDown' ? 1 : -1)
          return
        }
        if (k === 'Enter') {
          ke.preventDefault()
          ke.stopPropagation()
          this.pickActive()
          return
        }
        if (k === 'Escape') {
          ke.preventDefault()
          ke.stopPropagation()
          this.closeMenu()
          return
        }
        if (k === 'Tab') {
          ke.preventDefault()
          ke.stopPropagation()
          this.move(ke.shiftKey ? -1 : 1)
        }
      },
      true,
    )
    document.addEventListener('mousedown', (e) => {
      if (!this.open) return
      const t = e.target as Node
      if (this.el?.contains(t) || this.popEl?.contains(t)) return
      if ((t as HTMLElement).closest?.('.blk')) return
      this.closeMenu()
    })
  }

  /* ------------------------------------------------------------ 菜单 */

  openMenu(o: MenuOpts): void {
    this.closeMenu(false)
    this.opts = o
    this.allRows = o.rows
    this.rows = o.rows
    this.active = 0
    const box = document.createElement('div')
    box.className = 'layer'
    box.setAttribute('role', 'dialog')
    if (o.title) {
      const head = document.createElement('div')
      head.className = 'layer-head'
      head.textContent = o.title
      box.appendChild(head)
    }
    if (o.searchable !== false) {
      const input = document.createElement('input')
      input.className = 'layer-input'
      input.placeholder = o.placeholder ?? t('ui.search.placeholder')
      input.spellcheck = false
      input.addEventListener('input', () => this.applyQuery(input.value))
      input.addEventListener('keydown', (e) => e.stopPropagation())
      box.appendChild(input)
      this.inputEl = input
    } else {
      this.inputEl = null
    }
    const list = document.createElement('div')
    list.className = 'layer-list'
    list.setAttribute('role', 'listbox')
    box.appendChild(list)
    this.listEl = list
    this.el = box
    document.body.appendChild(box)
    this.open = true
    this.renderRows()
    this.place(box, o.anchor)
    if (o.searchable !== false && o.focusSearch !== false) {
      const input = this.inputEl
      requestAnimationFrame(() => input?.focus())
    }
  }

  /** 斜杠菜单：编辑器里继续打字 ⇒ 只更新行，不重建、不抢焦点 */
  setRows(rows: Row[], query?: string): void {
    if (!this.open || !this.opts) return
    this.allRows = rows
    this.rows = rows
    this.active = Math.min(this.active, Math.max(0, rows.length - 1))
    if (query !== undefined && this.inputEl) this.inputEl.value = query
    this.renderRows()
  }

  private applyQuery(q: string): void {
    this.opts?.onQuery?.(q)
    if (!this.opts?.onQuery) {
      const s = q.trim().toLowerCase()
      this.rows = s === '' ? this.allRows : this.allRows.filter((r) => `${r.label} ${r.hint ?? ''} ${r.command ?? ''}`.toLowerCase().includes(s))
      this.active = 0
      this.renderRows()
    }
  }

  private renderRows(): void {
    if (!this.listEl) return
    this.listEl.textContent = ''
    if (this.rows.length === 0) {
      const d = document.createElement('div')
      d.className = 'layer-empty'
      d.textContent = this.opts?.emptyText ?? t('ui.search.empty')
      this.listEl.appendChild(d)
      return
    }
    let lastGroup = ''
    this.rows.forEach((r, i) => {
      const g = groupTitle(r.group)
      if (g && g !== lastGroup) {
        lastGroup = g
        const h = document.createElement('div')
        h.className = 'layer-group'
        h.textContent = g
        this.listEl!.appendChild(h)
      }
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'layer-item'
      item.dataset.index = String(i)
      if (i === this.active) item.dataset.active = '1'
      if (r.disabled) item.disabled = true
      const ico = document.createElement('span')
      ico.className = 'layer-ico'
      // 行没有图标时保留原来的 `·` 占位（不硬塞一个图标，免得每行都长一样）
      if (r.icon) renderIcon(ico, r.icon, 'circle-help')
      else ico.textContent = '·'
      const label = document.createElement('span')
      label.className = 'layer-label'
      label.textContent = r.label
      const hint = document.createElement('span')
      hint.className = 'layer-hint'
      hint.textContent = r.hint ?? (r.keyHint ? '' : (r.command ?? ''))
      item.append(ico, label, hint)
      if (r.keyHint) {
        const key = document.createElement('span')
        key.className = 'layer-key'
        key.textContent = r.keyHint
        item.appendChild(key)
      }
      item.addEventListener('mouseenter', () => {
        this.active = i
        this.renderActive()
      })
      item.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        this.active = i
        this.pickActive()
      })
      this.listEl!.appendChild(item)
    })
    this.scrollActiveIntoView()
  }

  private renderActive(): void {
    for (const el of Array.from(this.listEl?.querySelectorAll<HTMLElement>('.layer-item') ?? [])) {
      if (Number(el.dataset.index) === this.active) el.dataset.active = '1'
      else delete el.dataset.active
    }
  }

  private scrollActiveIntoView(): void {
    const el = this.listEl?.querySelector<HTMLElement>(`.layer-item[data-index="${this.active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }

  private move(delta: number): void {
    if (this.rows.length === 0) return
    this.active = (this.active + delta + this.rows.length) % this.rows.length
    this.renderActive()
    this.scrollActiveIntoView()
  }

  private pickActive(): void {
    const row = this.rows[this.active]
    if (!row || row.disabled) return
    const onPick = this.opts?.onPick
    this.closeMenu()
    onPick?.(row)
  }

  closeMenu(notify = true): void {
    if (!this.open) return
    this.el?.remove()
    this.el = null
    this.listEl = null
    this.inputEl = null
    this.rows = []
    this.allRows = []
    this.open = false
    const cb = this.opts?.onClose
    this.opts = null
    if (notify) cb?.()
  }

  private place(box: HTMLElement, anchor: DOMRect | null): void {
    const pad = 8
    const w = Math.min(430, window.innerWidth - pad * 2)
    box.style.width = `${w}px`
    const h = box.offsetHeight
    if (!anchor) {
      box.style.left = `${Math.max(pad, (window.innerWidth - w) / 2)}px`
      box.style.top = `${Math.max(pad, window.innerHeight * 0.16)}px`
      return
    }
    const left = Math.min(Math.max(pad, anchor.left), window.innerWidth - w - pad)
    const below = anchor.bottom + 6
    const top = below + h > window.innerHeight - pad ? Math.max(pad, anchor.top - h - 6) : below
    box.style.left = `${left}px`
    box.style.top = `${top}px`
  }

  /* -------------------------------------------------------- 划选气泡 */

  /**
   * 划选气泡：**选中一段文本时浮出，选区塌了就自己消失**（替代顶部工具栏）。
   *
   * 三条与菜单不同的纪律（都来自"选区很脆"这件事）：
   *   1. **不抢焦点**：`mousedown` 一律 `preventDefault`，焦点留在编辑器 ⇒ 原生选区不塌；
   *   2. **不进 `this.open`**：菜单的 Esc／方向键／点击外部关闭逻辑会跟它打架，
   *      且「气泡开着」不是一个"模态"状态（用户还能继续打字）；
   *   3. **锚在选区上方**（不是下方——下方会盖住刚选中的那行）。
   */
  openSelectionBar(o: { rows: Row[]; anchor: DOMRect | null; activeMarks: Set<string>; onPick: (row: Row) => void }): void {
    const box = document.createElement('div')
    box.className = 'selbar'
    box.setAttribute('role', 'toolbar')
    let lastGroup = ''
    o.rows.forEach((r, i) => {
      const g = groupTitle(r.group)
      if (g && g !== lastGroup) {
        lastGroup = g
        const sep = document.createElement('span')
        sep.className = 'sel-sep'
        box.appendChild(sep)
      }
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'sel-btn'
      b.dataset.command = r.command ?? ''
      if (r.icon) renderIcon(b, r.icon, 'circle-help')
      else b.textContent = r.label
      b.title = `${r.label}${r.keyHint ? `（${r.keyHint}）` : ''}`
      // 按压态：选区里已经有这种格式 ⇒ 这一颗亮着（承原工具栏的 `data-on`）
      const suffix = (r.command ?? '').startsWith('core.anno/toggle-') ? (r.command ?? '').slice('core.anno/toggle-'.length) : ''
      if (suffix && o.activeMarks.has(suffix)) b.dataset.on = '1'
      // ⚠️ mousedown 而不是 click：click 之前浏览器会先清掉选区（同 gutter 的踩坑）
      b.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        o.onPick(r)
      })
      void i
      box.appendChild(b)
    })
    document.body.appendChild(box)
    this.selEl?.remove()
    this.selEl = box
    const pad = 8
    const w = box.offsetWidth
    const h = box.offsetHeight
    const a = o.anchor ?? new DOMRect(window.innerWidth / 2, 120, 0, 0)
    const left = Math.min(Math.max(pad, a.left + a.width / 2 - w / 2), window.innerWidth - w - pad)
    // 优先放在选区上方（间隔一个行高的一半，别贴着上一行的字底）；上方放不下才落到下方
    const above = a.top - h - 10
    const top = above >= pad ? above : Math.min(a.bottom + 10, window.innerHeight - h - pad)
    box.style.left = `${left}px`
    box.style.top = `${Math.max(pad, top)}px`
  }

  closeSelectionBar(): void {
    this.selEl?.remove()
    this.selEl = null
  }

  selectionBarOpen(): boolean {
    return this.selEl !== null
  }

  /* ---------------------------------------------------------- 信息气泡 */

  openPopover(render: (host: HTMLElement) => void, anchor: DOMRect | null): void {
    this.closePopover()
    const box = document.createElement('div')
    box.className = 'popover'
    render(box)
    document.body.appendChild(box)
    this.popEl = box
    const pad = 8
    const w = box.offsetWidth
    const h = box.offsetHeight
    const a = anchor ?? new DOMRect(window.innerWidth / 2, 120, 0, 0)
    const left = Math.min(Math.max(pad, a.left), window.innerWidth - w - pad)
    const top = a.bottom + 8 + h > window.innerHeight - pad ? Math.max(pad, a.top - h - 8) : a.bottom + 8
    box.style.left = `${left}px`
    box.style.top = `${top}px`
  }

  closePopover(): void {
    this.popEl?.remove()
    this.popEl = null
  }

  popoverOpen(): boolean {
    return this.popEl !== null
  }

  /**
   * 这个节点是不是在**任何浮层**里（菜单 / 信息气泡 / 抽屉）。
   *
   * 「点浮层里的东西」不能被当成「点到外面」——比如属性区的 ref 选择器就是复用菜单，
   * 点它一下不该把宿主面板收起来。
   */
  contains(node: Node | null): boolean {
    if (!node) return false
    return (
      (this.el?.contains(node) ?? false) ||
      (this.popEl?.contains(node) ?? false) ||
      (this.drawerEl?.contains(node) ?? false) ||
      (this.selEl?.contains(node) ?? false)
    )
  }

  /** 这个节点是不是在当前信息气泡里（点气泡内的按钮不该被「点外面关闭」吞掉） */
  popoverContains(node: Node | null): boolean {
    return node !== null && (this.popEl?.contains(node) ?? false)
  }

  /* ------------------------------------------------------------ 抽屉面板 */

  openDrawer(title: string, render: (host: HTMLElement) => void): void {
    this.closeDrawer()
    const box = document.createElement('div')
    box.className = 'drawer'
    const head = document.createElement('div')
    head.className = 'drawer-head'
    const t = document.createElement('span')
    t.textContent = title
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'ghost'
    close.textContent = '✕'
    close.addEventListener('click', () => this.closeDrawer())
    head.append(t, close)
    const body = document.createElement('div')
    body.className = 'drawer-body'
    render(body)
    box.append(head, body)
    document.body.appendChild(box)
    this.drawerEl = box
  }

  closeDrawer(): void {
    this.drawerEl?.remove()
    this.drawerEl = null
  }

  drawerOpen(): boolean {
    return this.drawerEl !== null
  }

  /* ------------------------------------------------------------ toast */

  toast(text: string, kind: 'ok' | 'warn' | 'info' = 'info'): void {
    if (!this.toastEl) {
      const c = document.createElement('div')
      c.className = 'toasts'
      document.body.appendChild(c)
      this.toastEl = c
    }
    const t = document.createElement('div')
    t.className = `toast toast-${kind}`
    t.textContent = text
    this.toastEl.appendChild(t)
    setTimeout(() => t.classList.add('out'), 2200)
    setTimeout(() => t.remove(), 2800)
  }

  closeAll(): void {
    this.closeMenu()
    this.closePopover()
    this.closeDrawer()
    this.closeSelectionBar()
  }

  anyOpen(): boolean {
    return this.open || this.popoverOpen() || this.drawerOpen()
  }

  macLabel(key: string): string {
    return keyLabel(key, this.isMac())
  }
}

/** 命令面板的行：**全部命令**（含没有任何键位的），键位只作为提示 */
export function paletteRows(decls: CommandDecl[], keyHints: Map<string, string>): Row[] {
  return decls
    .filter((d) => !d.hidden)
    .map((d) => ({
      id: d.name,
      label: d.title,
      // hint 放**命令名**：命令面板列的是命令表本身，键位只是右边的一个提示
      hint: d.name,
      icon: '›',
      group: `palette/${d.category}`,
      command: d.name,
      keyHint: keyHints.get(d.name),
    }))
    .sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label))
}
