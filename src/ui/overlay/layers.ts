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
import { keyLabel, type Binding } from '../../core/infra/bindings.ts'
import { COLOR_SLOTS, type ColorSlot } from '../../core/model/runs.ts'
import { DECL_BY_NAME, type CommandDecl } from '../../core/commands/index.ts'
// ⚠️ 三个收敛点之三：UI 组件的文案一律走 t
import { t } from '../../core/infra/msg.ts'
import { renderIcon } from '../../view/icons.ts'
import { captureFocus, type FocusReturn } from './focus-return.ts'
import { placeNear } from './place.ts'
import { dismissFloating } from './overlay-dismiss.ts'
import { menuKeyAction } from './menu-key.ts'
import { groupTitle } from './group-titles.ts'
import { QueryGate } from './query-gate.ts'

export interface Row {
  id: string
  label: string
  /**
   * 带高亮的显示片段（可选）。有它时渲染 `parts`，`label` 只作无障碍/回退文本。
   * 用结构化片段而不是 HTML：正文是用户内容，拼 HTML 就等于把转义责任散给每个调用方。
   */
  parts?: { text: string; mark?: boolean }[]
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
  | { kind: 'instance'; id: string; name: string; tag: string; tagId: string }
  | { kind: 'newObj'; name: string; tagId?: string; tag: string }
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
  /**
   * 浮层期望宽度（px）。缺省 430 是命令面板/块菜单的宽度；
   * 贴着按钮的下拉（视图切换）要窄一些，否则一颗 80px 的按钮弹出一整条 430 的菜单。
   */
  width?: number
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
  /**
   * **选中后不关**（多选取值用）：每点一行还留在原地，由调用方 `setRows` 更新勾选态。
   * 缺省 `false`：菜单是一次性动作面板，选完即关。
   */
  keepOpen?: boolean
  onQuery?: (q: string) => void
  onClose?: () => void
  /**
   * **这次打开的触发元素**（点的那颗按钮／右键的那颗块标）。给了它，
   * 同一颗触发器再触发一次＝**收起**（toggle）——入口按钮就是这张菜单的开关，
   * 「点了没反应」（拆掉重建再滑进来一次）在用户眼里等于坏了。
   * 不给（菜单行二级入口、键盘入口）＝老行为：先关再开。
   */
  trigger?: HTMLElement
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
  /**
   * 输入框的「什么时候真的过滤」：组合期不过滤、同值只放行一次。
   * 每次开菜单换一份新状态（上一次的查询词不该影响这一次）。
   */
  private gate = new QueryGate()
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
  /**
   * 信息浮层关闭前的回调（宿主拆自己的人）。
   * 为什么挂在 Layers 而不是让调用方自己监听：浮层的关闭有一条又一条出口
   * （Esc／点外部／被另一个浮层顶掉／锚点消失），漏掉任何一条，宿主就漏拆。
   */
  private popClose: (() => void) | null = null
  /** 菜单/浮层的触发元素（`MenuOpts.trigger` 的去处；关闭时清掉） */
  private menuTrigger: HTMLElement | null = null
  private popTriggerEl: HTMLElement | null = null
  private popTriggerKey: string | undefined = undefined
  /** 抽屉打开之前焦点在哪（同上） */
  private drawerFocus: FocusReturn | null = null
  /** 确认框（背板 ＋ 盒子）；打开之前的焦点同上 */
  private confirmEl: HTMLElement | null = null
  private confirmFocus: FocusReturn | null = null
  /** 划选气泡（顶部工具栏作废后的落点，2026-10-19）*/
  private selEl: HTMLElement | null = null
  open = false

  constructor(private isMac: () => boolean) {
    document.addEventListener(
      'keydown',
      (e) => {
        if (!this.open) return
        const ke = e as KeyboardEvent
        const action = menuKeyAction(ke)
        // 组合期一律不接（`↵` 是在确认候选，不是在选行）；认不出的键交给别人
        if (action === 'ignore' || action === 'pass') return
        ke.preventDefault()
        ke.stopPropagation()
        if (action === 'pick') {
          // 修饰键必须传出去：同一个对象按 ⌘/⌥ 是不同的落点（⌘Enter 已归「切换待办」，
          // 所以浮层这里不替它编语义，只如实上报按了什么）
          this.pickActive({ altKey: ke.altKey, metaKey: ke.metaKey, ctrlKey: ke.ctrlKey, shiftKey: ke.shiftKey })
          return
        }
        if (action === 'close') {
          this.closeMenu()
          return
        }
        this.move(action === 'up' || action === 'tab-prev' ? -1 : 1)
      },
      true,
    )
    document.addEventListener('mousedown', (e) => {
      if (!this.open) return
      const t = e.target as Node
      if (this.el?.contains(t) || this.popEl?.contains(t)) return
      // 按在触发元素上不算「点到外面」：关与开都归触发器自己的 handler
      //（同触发器再点一次＝toggle，判据在 `openMenu`）。这里抢先关掉的话，
      // click 到 handler 时菜单已经没了，toggle 判据永远落空。
      if (this.menuTrigger?.contains(t)) return
      /**
       * **点任何别处都关**（含正文里的块行）。
       *
       * 早先这里放过 `.blk`：菜单开着时点正文不算「点到外面」。结果是菜单只能靠
       * Esc／选项／点空白关掉，而正文本身几乎全是 `.blk` —— 用户想「点一下别处继续写」
       * 时菜单一直挡着，还得再找一次 Esc。菜单是一次性动作面板，不是常驻面板。
       */
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
        /**
         * **分层**：菜单在最上面，`Esc` 先归它（上面的菜单分支已经 `preventDefault`）。
         * `stopPropagation()` 挡不住**同一个 document 上的后一个监听器**，所以这里要显式
         * 认「这一发 Esc 已经被菜单吃掉」——否则一次 Esc 会把菜单和底下的浮层一起关掉。
         */
        if (e.defaultPrevented) return
        if (this.confirmEl) {
          e.preventDefault()
          e.stopPropagation()
          this.closeConfirm()
          return
        }
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
    /**
     * **同一颗触发器再触发一次＝收起**（toggle）。判据收在这里而不是散在各入口：
     * 入口只报「我是谁」，开还是收是浮层自己的状态。
     * 触发元素被整行重渲染换掉（新节点）时判据落空 ⇒ 退回先关再开，与旧行为一致。
     */
    if (this.open && o.trigger && this.menuTrigger === o.trigger) {
      this.closeMenu()
      return
    }
    this.closeMenu(false)
    this.menuTrigger = o.trigger ?? null
    /**
     * **焦点归还**：菜单会抢焦点（搜索框要能打字），关掉之后必须还回去。
     * 不还的后果见 `ui/focus-return.ts`：关掉后打字一个字符都进不去，且不报错。
     */
    this.menuFocus = captureFocus()
    this.opts = o
    this.allRows = o.rows
    this.rows = o.rows
    this.active = 0
    this.gate = new QueryGate()
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
      // 组合期的输入法中间态不重建候选；组合结束只发一次（与随后的同值 input 合并）
      input.addEventListener('compositionstart', () => this.gate.compositionStart())
      input.addEventListener('compositionend', () => {
        if (this.gate.compositionEnd(input.value)) this.applyQuery(input.value)
      })
      input.addEventListener('input', () => {
        if (this.gate.input(input.value)) this.applyQuery(input.value)
      })
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

  /**
   * 换空态文案（搜索框用：没输入时说「输入关键词」，输入了没命中才说「没有匹配项」）。
   * 只改文案，不重排已有行；列表为空时立刻重画一次。
   */
  setEmptyText(text: string): void {
    if (!this.opts) return
    this.opts.emptyText = text
    if (this.rows.length === 0) this.renderRows()
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
      item.dataset.id = r.id
      if (i === this.active) item.dataset.active = '1'
      if (r.disabled) item.disabled = true
      const ico = document.createElement('span')
      ico.className = 'layer-ico'
      // 行没有图标时保留原来的 `·` 占位（不硬塞一个图标，免得每行都长一样）
      if (r.icon) renderIcon(ico, r.icon, 'circle-help')
      else ico.textContent = '·'
      const label = document.createElement('span')
      label.className = 'layer-label ui-ellipsis ui-ellipsis-grow'
      if (r.parts && r.parts.length > 0) {
        for (const p of r.parts) {
          if (p.mark === true) {
            const mark = document.createElement('mark')
            mark.textContent = p.text
            label.appendChild(mark)
          } else {
            label.appendChild(document.createTextNode(p.text))
          }
        }
      } else {
        label.textContent = r.label
      }
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
    const keep = this.opts?.keepOpen === true
    if (!keep) this.closeMenu()
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
    this.menuTrigger = null
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
    const w = Math.min(this.opts?.width ?? 430, window.innerWidth - pad * 2)
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

    /**
     * 色板：ink/bg 各一排。值轴不是开关（一个轴上只能有一个槽），所以不走 Row/绑定表，
     * 直接按轴渲染一组色点；按压态读 `activeMarks` 里的 `键:槽` 描述符。
     * 点下去仍走 `onPick` ⇒ 与格式按钮同一条命令路径（撤销、重画、按压态刷新都免费）。
     */
    const SWATCH_LABEL: Record<ColorSlot, string> = {
      red: t('ui.color.red'),
      orange: t('ui.color.orange'),
      yellow: t('ui.color.yellow'),
      green: t('ui.color.green'),
      blue: t('ui.color.blue'),
      violet: t('ui.color.violet'),
      gray: t('ui.color.gray'),
    }
    const addSwatches = (): void => {
      for (const axis of ['ink', 'bg'] as const) {
        const axisTitle = axis === 'ink' ? t('menu.label.ink') : t('menu.label.bg')
        const group = document.createElement('div')
        group.className = 'sel-swatches'
        group.dataset.axis = axis
        const lead = document.createElement('span')
        lead.className = 'sel-swatches-lead'
        lead.dataset.tip = axisTitle
        renderIcon(lead, axis === 'ink' ? 'lucide:baseline' : 'lucide:highlighter', 'circle-help', 'sm')
        group.appendChild(lead)
        for (const slot of COLOR_SLOTS) {
          const b = document.createElement('button')
          b.type = 'button'
          b.className = 'sel-swatch'
          b.dataset.slot = slot
          b.dataset.tip = `${axisTitle}·${SWATCH_LABEL[slot]}`
          if (o.activeMarks.has(`${axis}:${slot}`)) b.dataset.on = '1'
          // ⚠️ mousedown 而不是 click：click 之前浏览器会先清掉选区（同格式按钮的踩坑）
          b.addEventListener('mousedown', (e) => {
            e.preventDefault()
            e.stopPropagation()
            o.onPick({
              id: `swatch-${axis}-${slot}`,
              label: `${axisTitle}·${SWATCH_LABEL[slot]}`,
              command: `core.anno/set-${axis}`,
              args: { slot },
            })
          })
          group.appendChild(b)
        }
        box.appendChild(group)
      }
    }

    let lastGroup = ''
    let swatchesAdded = false
    o.rows.forEach((r, i) => {
      const g = groupTitle(r.group)
      if (g && g !== lastGroup) {
        // 格式组画完、进入下一组之前插色板：它属于格式，不该被引用组隔开
        if (lastGroup !== '' && !swatchesAdded) {
          addSwatches()
          swatchesAdded = true
        }
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
      b.dataset.tip = `${r.label}${r.keyHint ? `（${r.keyHint}）` : ''}`
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
    // 只有一组（没有引用组）时色板放末尾
    if (!swatchesAdded) addSwatches()
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
  openPopover(
    render: (host: HTMLElement) => void,
    anchor: DOMRect | null | (() => DOMRect | null),
    onClose?: () => void,
    trigger?: { el?: HTMLElement; key?: string },
  ): void {
    /**
     * **同一颗触发器再点一次＝收起**（toggle）：入口按钮就是这层浮层的开关，
     * 先拆再建等于每次点都让它重滑进来一次（与 `openMenu` 同一条判据、同一处收口）。
     *
     * 身份优先按 `key`（正文里的原子随重渲染整颗换新节点，节点靠不住；run id 才稳），
     * 没有 key 的（chrome 里的按钮）按元素本身。两边都不给＝老行为：先关再开。
     */
    const same =
      trigger &&
      ((trigger.key !== undefined && this.popTriggerKey === trigger.key) ||
        (trigger.key === undefined && trigger.el !== undefined && this.popTriggerEl === trigger.el))
    if (this.popEl && same) {
      this.closePopover()
      return
    }
    this.closePopover()
    this.popTriggerEl = trigger?.el ?? null
    this.popTriggerKey = trigger?.key
    const box = document.createElement('div')
    box.className = 'popover'
    // 浮层是对话框：它里面有可编辑的字段，读屏与键盘导航都该知道「这是一层」
    box.setAttribute('role', 'dialog')
    render(box)
    document.body.appendChild(box)
    this.popEl = box
    this.popClose = onClose ?? null
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
    const close = this.popClose
    this.popClose = null
    this.popAnchor = null
    this.popEl = null
    this.popTriggerEl = null
    this.popTriggerKey = undefined
    // 先回调、后摘 DOM：宿主在这时面对的还是仍在文档里的编辑器（收尾不靠游离节点）
    close?.()
    box?.remove()
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

  /**
   * 这个节点是不是当前气泡的**触发元素**。外点关闭的豁免判据：
   * 按下触发器不算「点到外面」，关与开都归触发器自己的 handler（同 `openMenu` 的 toggle）。
   */
  popoverTriggerContains(node: Node | null): boolean {
    return node !== null && (this.popTriggerEl?.contains(node) ?? false)
  }

  /* ------------------------------------------------------------ 抽屉面板 */

  openDrawer(title: string, render: (host: HTMLElement) => void): void {
    this.closeDrawer(false)
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

  closeDrawer(animate = true): void {
    const box = this.drawerEl
    this.drawerEl = null
    // 状态立即归零（drawerOpen/Esc 判据不再看它）；DOM 走完退场动画再摘。
    // 紧接着要开下一张（openDrawer 先关再开）时不动画：两张同屏交叉滑没有意义。
    if (box) {
      if (animate) dismissFloating(box)
      else box.remove()
    }
    const fr = this.drawerFocus
    this.drawerFocus = null
    fr?.restore(box)
  }

  drawerOpen(): boolean {
    return this.drawerEl !== null
  }

  /* ------------------------------------------------------------ 确认框 */

  /**
   * **后果性操作的确认框**：一句后果 ＋ 两颗按钮。破坏性动作的最后一道闸——
   * 它只负责「让用户在知道后果的前提下再说一次要」，不做任何选择（选择是菜单的事）。
   *
   * 三条交互纪律（与菜单/抽屉同源）：
   *   · `Esc` ＝ 取消（构造器的 Esc 分支里它排在抽屉前面：它在最上层）；
   *   · 点背板 ＝ 取消——确认框是问句，不是陷阱，「反悔」必须有一条不用瞄准的出路；
   *   · 焦点落在确认钮上：键盘流 Enter 直接确认；关掉后焦点归还原处。
   */
  confirm(o: {
    title: string
    /** 后果文案：写清会发生什么、能不能反悔（后果性操作的确认文案不可减） */
    body?: string
    confirmLabel: string
    cancelLabel?: string
    /** 危险动作：确认钮用警示色（删除类） */
    danger?: boolean
    onConfirm: () => void
  }): void {
    this.closeConfirm()
    const backdrop = document.createElement('div')
    backdrop.className = 'confirm-backdrop'
    // 只有**按在背板本身**才算「点到外面」：盒子里的按钮冒泡上来时不能抢先关框
    //（关在 click 之前，那颗按钮就永远等不到自己的 click——实测踩过）。
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) this.closeConfirm()
    })

    const box = document.createElement('div')
    box.className = 'confirm'
    box.setAttribute('role', 'alertdialog')
    if (o.danger) box.dataset.danger = '1'

    const title = document.createElement('div')
    title.className = 'confirm-title'
    title.textContent = o.title
    box.appendChild(title)
    if (o.body) {
      const body = document.createElement('div')
      body.className = 'confirm-body'
      body.textContent = o.body
      box.appendChild(body)
    }

    const row = document.createElement('div')
    row.className = 'confirm-actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'ghost'
    cancel.textContent = o.cancelLabel ?? t('ui.confirm.cancel')
    cancel.addEventListener('click', () => this.closeConfirm())
    const ok = document.createElement('button')
    ok.type = 'button'
    ok.className = 'confirm-ok'
    ok.textContent = o.confirmLabel
    ok.addEventListener('click', () => {
      this.closeConfirm()
      o.onConfirm()
    })
    row.append(cancel, ok)
    box.appendChild(row)

    // Enter ＝ 确认（焦点在确认钮上时浏览器本来就会做；这里把整框变成键盘可完成的）
    box.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return
      e.preventDefault()
      ok.click()
    })

    backdrop.appendChild(box)
    document.body.appendChild(backdrop)
    this.confirmEl = backdrop
    this.confirmFocus = captureFocus()
    requestAnimationFrame(() => ok.focus())
  }

  closeConfirm(): void {
    const backdrop = this.confirmEl
    this.confirmEl = null
    if (backdrop) backdrop.remove()
    const fr = this.confirmFocus
    this.confirmFocus = null
    fr?.restore(backdrop)
  }

  confirmOpen(): boolean {
    return this.confirmEl !== null
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

  /**
   * **命令键要不要放行给覆盖层里的编辑器**。
   *
   * 覆盖层默认接管按键（菜单有 ↑↓/↵、抽屉与信息浮层里的输入框要打字）。但信息浮层
   * 里可以放一台**真编辑器**（搜索面的右列预览）：焦点在它的可编辑宿主里时，
   * `↵`／`Tab`／`⌘Z` 必须归编辑器，否则「能进不能出」。
   *
   * 三条边界：菜单／抽屉开着时一律不放行（它们自己有按键语义）；焦点在浮层的
   * `<input>` 上时不放行（那是搜索框/表单）；焦点已经离开浮层时也不放行。
   */
  allowsEditorKeys(): boolean {
    if (this.open || this.drawerEl) return false
    const box = this.popEl
    if (!box) return false
    const active = document.activeElement
    return active instanceof HTMLElement && box.contains(active) && active.isContentEditable
  }

  macLabel(key: string): string {
    return keyLabel(key, this.isMac())
  }
}

/**
 * 命令面板的行：**全部命令**（含没有任何键位的），键位只作为提示。
 *
 * 空查询时把「最近执行」的名单置顶（同样只列未隐藏的命令；顺序＝名单顺序）——
 * 面板是搜索工具不是浏览页，155 条平铺没人看，顶部那段才是「再来一次」的入口。
 * 有查询词时收起最近段：搜索结果里同一命令出现两次只会互相稀释。
 * 过滤在这里做（调用方经 `onQuery` 回填），空间与浮层自带的过滤同款：标题＋命令名。
 */
export function paletteRows(
  decls: CommandDecl[],
  keyHints: Map<string, string>,
  opts: { recents?: string[]; query?: string } = {},
): Row[] {
  const q = (opts.query ?? '').trim().toLowerCase()
  const row = (d: CommandDecl, id: string) => ({
    id,
    label: d.title,
    // hint 放**命令名**：命令面板列的是命令表本身，键位只是右边的一个提示
    hint: d.name,
    icon: '›',
    group: `palette/${d.category}`,
    command: d.name,
    keyHint: keyHints.get(d.name),
  })
  const visibleDecls = decls.filter((d) => !d.hidden)
  const byName = new Map(visibleDecls.map((d) => [d.name, d]))
  const recent =
    q === ''
      ? (opts.recents ?? [])
          .map((n) => byName.get(n))
          .filter((d): d is CommandDecl => d !== undefined)
          .map((d) => row(d, `recent//${d.name}`))
      : []
  const rest = visibleDecls
    .filter((d) => q === '' || `${d.title} ${d.name}`.toLowerCase().includes(q))
    .map((d) => row(d, d.name))
    .sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label))
  return [...recent, ...rest]
}
