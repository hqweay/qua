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
import { captureFocus, type FocusReturn } from './focus-return.ts'
import { placeNear } from './place.ts'

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
  /**
   * 「这一行选中了谁」——**浮层只报对象，不报动作**。
   *
   * 同一条 `#名` 行按 `Enter` 与 `⌥Enter` 是两个不同的结果（插进正文 / 归到本块），
   * 所以「插什么」必须由**调用方那一栏**决定（触发字符表），不能写进行里：
   * 写进行里就成了「同一行有两种按法、还得记住哪行是哪行」。
   */
  pick?: RowPick
}

/** 一行的选中对象。`fresh` 的那两种还没有块 id（要在落点里当场建出来）。 */
export type RowPick =
  | { kind: 'command'; command: string; args?: unknown }
  | { kind: 'tag'; id: string; name: string }
  | { kind: 'newTag'; name: string }
  | { kind: 'newPage'; name: string }
  | { kind: 'instance'; id: string; name: string; tag: string }
  | { kind: 'page'; id: string; name: string }
  | { kind: 'block'; id: string; name: string }

/**
 * 选中时按下的修饰键。
 *
 * ⚠️ 只传**判据**，不传 `KeyboardEvent`：浮层不是「谁按了什么」的日志处，
 *    调用方也不需要为了读一个 `altKey` 拿到整个原生事件（与行内原子的点击同理）。
 */
export interface PickMods {
  altKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
}

const NO_MODS: PickMods = { altKey: false, metaKey: false, ctrlKey: false, shiftKey: false }

const GROUP_TITLES: Record<string, string> = {
  'block/1-basic': t('menu.group.basic'),
  'block/2-structure': t('menu.group.structure'),
  'block/3-kind': t('menu.group.blockKind'),
  'block/3-role': t('menu.group.identity'),
  'block/4-inline': t('menu.group.inline'),
  'block/5-mark': t('menu.group.mark'),
  'slash/1-basic': t('menu.group.basic'),
  'slash/2-inline': t('menu.group.inlineAtom'),
  'slash/3-structure': t('menu.group.structure'),
  'sel/1-mark': t('menu.group.mark'),
  'sel/2-ref': t('menu.group.ref'),
  'pick/1': t('menu.group.pickPage'),
  'pick/2': t('menu.group.pickTag'),
  // 检索浮层（`#` 标签源 / `@` 页块源）：分组是「结果从哪儿来」，不是命令分类
  'retrieval/1-instance': t('menu.group.instance'),
  'retrieval/2-tag': t('menu.group.pickTag'),
  'retrieval/3-new': t('menu.group.new'),
  'retrieval/1-page': t('menu.group.pickPage'),
  'retrieval/2-block': t('menu.group.block'),
  'dbg/1-look': t('menu.group.debugLook'),
  'dbg/2-theme': t('menu.group.debugTheme'),
  'dbg/3-state': t('menu.group.debugState'),
  'view/8-sort': t('menu.group.viewSort'),
  'view/9-add': t('menu.group.viewAdd'),
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
  /**
   * 选中一行。`mods` 是**按下时的修饰键**：同一个对象在不同按键下可以落到不同结果
   * （`#名` 按 `Enter` 插进正文、按 `⌥Enter` 归到本块），所以这枚参数必须在选中那一刻取。
   */
  onPick: (row: Row, mods: PickMods) => void
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
  /**
   * 信息浮层的锚点**取值函数**（不是矩形快照）。
   *
   * 见 `openPopover` 的说明：快照记不住自己指向谁，窗口一变／正文一滚它就失效。
   */
  private popAnchor: (() => DOMRect | null) | null = null
  /** 菜单打开之前焦点在哪（关闭时归还；见 `ui/focus-return.ts`） */
  private menuFocus: FocusReturn | null = null
  /** 信息浮层打开之前焦点在哪（同上） */
  private popFocus: FocusReturn | null = null
  /** 抽屉打开之前焦点在哪（同上） */
  private drawerFocus: FocusReturn | null = null
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
          // 修饰键必须传出去：同一个对象按 ⌘/⌥ 是不同的落点（⌘Enter 已归「切换待办」，
          // 所以浮层这里不替它编语义，只如实上报按了什么）
          this.pickActive({ altKey: ke.altKey, metaKey: ke.metaKey, ctrlKey: ke.ctrlKey, shiftKey: ke.shiftKey })
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
    /**
     * 气泡/抽屉的 `Esc`：它们里面是表单，按键不归键位表（`layerOpen` 已把它们算作覆盖层），
     * 所以关闭动作只能由覆盖层自己接。菜单的 `Esc` 仍走上面那段。
     */
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape') return
        if (this.popEl) {
          e.preventDefault()
          e.stopPropagation()
          this.closePopover()
          return
        }
        if (this.drawerEl) {
          e.preventDefault()
          e.stopPropagation()
          this.closeDrawer()
        }
      },
      true,
    )
  }

  /* ------------------------------------------------------------ 菜单 */

  openMenu(o: MenuOpts): void {
    this.closeMenu(false)
    /**
     * **焦点归还**：菜单会抢焦点（搜索框要能打字），关掉之后必须还回去。
     * 不还的后果见 `ui/focus-return.ts`：关掉后打字一个字符都进不去，且不报错。
     */
    this.menuFocus = captureFocus()
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
      label.className = 'layer-label ui-ellipsis ui-ellipsis-grow'
      label.textContent = r.label
      const hint = document.createElement('span')
      hint.className = 'layer-hint ui-ellipsis'
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
        this.pickActive({ altKey: e.altKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey })
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

  private pickActive(mods: PickMods = NO_MODS): void {
    const row = this.rows[this.active]
    if (!row || row.disabled) return
    const onPick = this.opts?.onPick
    this.closeMenu()
    onPick?.(row, mods)
  }

  closeMenu(notify = true): void {
    if (!this.open) return
    const box = this.el
    this.el?.remove()
    this.el = null
    this.listEl = null
    this.inputEl = null
    this.rows = []
    this.allRows = []
    this.open = false
    const cb = this.opts?.onClose
    this.opts = null
    // 先归还焦点再回调：回调里可能立刻打开另一个覆盖层（那会重新记一次焦点）
    const fr = this.menuFocus
    this.menuFocus = null
    fr?.restore(box)
    if (notify) cb?.()
  }

  /**
   * 菜单落位：宽度先定（430 上限、且不许超出视口），再按锚点算坐标。
   *
   * ⚠️ 坐标算在 `ui/place.ts` 的 `placeNear` 里——**三处浮层共用那一份**。
   *    这里只负责「量 box 尺寸」和「写回坐标」，那两件事都要求 box 已经进文档。
   */
  private place(box: HTMLElement, anchor: DOMRect | null): void {
    const pad = 8
    const w = Math.min(430, window.innerWidth - pad * 2)
    box.style.width = `${w}px`
    const at = placeNear({
      boxW: w,
      boxH: box.offsetHeight,
      vw: window.innerWidth,
      vh: window.innerHeight,
      anchor,
      side: 'below',
      align: 'left',
      gap: 6,
      pad,
    })
    box.style.left = `${at.left}px`
    box.style.top = `${at.top}px`
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
    /**
     * 划选气泡：**锚在选区上方**（下方会盖住刚选中的那行）。
     *
     * 落位仍走同一份 `placeNear` —— 与菜单的差别只是偏好方向（`side: 'above'`）
     * 与水平居中。此前这里另写了一遍钳位，于是「加一种对齐」只能加到一处。
     */
    const a = o.anchor ?? null
    const at = placeNear({
      boxW: box.offsetWidth,
      boxH: box.offsetHeight,
      vw: window.innerWidth,
      vh: window.innerHeight,
      anchor: a,
      side: 'above',
      align: 'center',
      gap: 10,
      pad: 8,
    })
    box.style.left = `${at.left}px`
    box.style.top = `${at.top}px`
  }

  closeSelectionBar(): void {
    this.selEl?.remove()
    this.selEl = null
  }

  selectionBarOpen(): boolean {
    return this.selEl !== null
  }

  /* ---------------------------------------------------------- 信息气泡 */

  /**
   * 打开信息浮层。
   *
   * `anchor` 收**两种形态**：一个矩形（快照），或一个**取矩形的函数**（实时）。
   *
   * 为什么需要第二种：矩形快照记不住自己指向谁。窗口一被拖动、正文一被滚动，
   * 那个矩形就变成「曾经指向某处」——浮层留在原地、锚点早已跑开（实测滚动 300px 后
   * 两者相距 308px），而且**不报错**。传函数则每次重算都对着当前那处。
   *
   * ⚠️ 两种形态的差别是**只在桌面端才显形**的：Web 上很少拖窗口边、也很少在浮层开着
   *    时滚动整页；桌面应用这两件事都是日常动作。
   */
  openPopover(render: (host: HTMLElement) => void, anchor: DOMRect | null | (() => DOMRect | null)): void {
    this.closePopover()
    const box = document.createElement('div')
    box.className = 'popover'
    // 浮层是对话框：它里面有可编辑的字段，读屏与键盘导航都该知道「这是一层」
    box.setAttribute('role', 'dialog')
    render(box)
    document.body.appendChild(box)
    this.popEl = box
    this.popAnchor = typeof anchor === 'function' ? anchor : anchor ? () => anchor : null
    /**
     * 焦点归还：浮层本身**不抢**焦点（只有里面的输入框在 autofocus 时才会拿走），
     * 但用户一旦点进去，关掉之后就没人负责把焦点还回来。见 `ui/focus-return.ts`。
     */
    this.popFocus = captureFocus()
    this.placePopover()
    // 窗口尺寸变了要重算（拖窗口边是桌面端常态）；正文滚动同理
    window.addEventListener('resize', this.reflow)
    window.addEventListener('scroll', this.reflow, true)
  }

  /**
   * 按当前锚点重算浮层位置。
   *
   * ⚠️ **锚点消失就关掉浮层**（而不是留着它悬空）：目标那一行被滚动出视口、
   *    或者那一块被删掉时，一个「指向不存在的东西」的浮层比没有浮层更糟——
   *    用户会对着它操作，而操作落在一个已经不在的位置上。
   */
  private placePopover(): void {
    const box = this.popEl
    if (!box) return
    const anchor = this.popAnchor?.() ?? null
    if (this.popAnchor && !anchor) {
      this.closePopover()
      return
    }
    const at = placeNear({
      boxW: box.offsetWidth,
      boxH: box.offsetHeight,
      vw: window.innerWidth,
      vh: window.innerHeight,
      anchor,
      side: 'below',
      align: 'left',
      gap: 8,
      pad: 8,
    })
    box.style.left = `${at.left}px`
    box.style.top = `${at.top}px`
  }

  /** 重算落位（`resize`／`scroll` 的监听体；箭头函数保证 `this` 与解绑是同一个引用） */
  private reflow = (): void => {
    this.placePopover()
  }

  closePopover(): void {
    window.removeEventListener('resize', this.reflow)
    window.removeEventListener('scroll', this.reflow, true)
    const box = this.popEl
    this.popAnchor = null
    this.popEl?.remove()
    this.popEl = null
    const fr = this.popFocus
    this.popFocus = null
    fr?.restore(box)
  }

  popoverOpen(): boolean {
    return this.popEl !== null
  }

  /**
   * 这个节点是不是在当前信息气泡里（点气泡内的按钮不该被「点外面关闭」吞掉）
   */
  popoverContains(node: Node | null): boolean {
    return node !== null && (this.popEl?.contains(node) ?? false)
  }

  /* ------------------------------------------------------------ 抽屉面板 */

  openDrawer(title: string, render: (host: HTMLElement) => void): void {
    this.closeDrawer()
    const box = document.createElement('div')
    box.className = 'drawer'
    box.setAttribute('role', 'dialog')
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
    this.drawerFocus = captureFocus()
  }

  closeDrawer(): void {
    const box = this.drawerEl
    this.drawerEl?.remove()
    this.drawerEl = null
    const fr = this.drawerFocus
    this.drawerFocus = null
    fr?.restore(box)
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
