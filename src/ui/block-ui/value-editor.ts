/**
 * **值控件族**：按 kind 画一行值的编辑器（`makeCellEditor`）＋ 多值 chips ＋
 * ref 值的 inline 岛登记表。`properties.ts` 从这里再导出，**对外的符号名不变**
 * （表格格子与行内实例浮层照旧 import 那边）。
 *
 * 为什么单独一个文件：这一族已经被**三个表面**共用（属性面板、表格格子、行内浮层），
 * deps 缝（`CellEditorDeps`／`RefIslandDeps`）就是为共享专门设计的——
 * 面板行怎么排（`makeFieldRow`）与值控件长什么样（这一族）是两件事；
 * 「面板里 Enter 能提交、表格里不能」那类分叉靠共用这一份挡住。
 *
 * 岛登记表（`REF_ISLANDS`）键＝岛根元素：岛的编辑器要**等宿主挂进文档才建**、
 * 退役要退订 store——登记在元素上而不是面板字段里，行怎么重建都找得到自己那座岛。
 * 面板重建时的扫与退役走 `ensureRefIslandsIn`／`disposeRefIslandsIn` 两个入口。
 */
import {
  allowsMany,
  assetRefKindOf,
  assetRefsOf,
  choiceDisplayLabel,
  clickModsOf,
  ICON_PROP,
  prop,
  refViewOf,
  valueItemsOf,
  valueListOf,
  type Block,
  type BlockStore,
  type FieldRow,
} from '../../core/index.ts'
import type { BlockEditor, Run } from '../../view/editor/editor.ts'
import { t } from '../../core/infra/msg.ts'
import { EDIT_ISLAND_ATTR } from '../../view/editor/block-dom.ts'
import { renderIcon } from '../../view/icons.ts'
import { EditableBlock } from './editable-block.ts'
import { chipDel } from './config-sections.ts'
import { onCommitKeys } from './keys.ts'
import { makeAssetThumb } from './asset-value.ts'
import type { FieldRowDeps } from './properties.ts'


/**
 * 值控件要的那一小撮能力：`ref` 要选择器与显示名，`select` 要标签名。
 *
 * 全都可以缺省：表格格子里没有属性区那套依赖时，控件退化成只读/短 id 显示，
 * 而不是「点了报错」。
 */
export type CellEditorDeps = Partial<
  Pick<
    FieldRowDeps,
    'pickRef' | 'pickChoice' | 'pickAsset' | 'refLabel' | 'tagName' | 'openRef' | 'activateAsset' | 'refIcon'
  >
> & {
  /** ref 值 inline 岛的装配（缺省 ⇒ 该面永远画 chip）；见 `RefIslandDeps` */
  refIsland?: RefIslandDeps
}

/**
 * ref 值 inline 岛需要的装配（`EditableBlock` 的那一套，原样透传）。
 *
 * 岛是 `EditableBlock` 的又一个挂点（镜像/抬头/侧槽窗口/备注浮窗同一条装配线），
 * 三件套都在组件里：岛根断链、唯一重载路径、整份事件表。这里只递参数。
 */
export interface RefIslandDeps {
  store: BlockStore
  /** 写事务入口（见 `Run`）：编辑**直接写回目标块本体**——禁止拷贝语义 */
  write: Run
  /** 目标块解析（值存的是 id）；解析不到（悬空值）就不画岛 */
  blockOf: (id: string) => Block | undefined
  /** 与正文同一份事件表（装配层 `wireViewEditor` 的整份 viewEvents） */
  wire: (ed: BlockEditor, change: (kind: string) => void) => void
  /** 岛里的编辑：落盘、刷角标 */
  onChange: (kind: string) => void
  /** 获得焦点：装配层把「活动编辑器」切过来（键位走命令层，认的是它） */
  onFocus: (ed: BlockEditor) => void
}

/**
 * 活动岛登记表：键＝岛根元素，值＝建编辑器／退役两件收尾。
 *
 * 岛的编辑器要**等宿主挂进文档才建**（构造时量 DOM），退役要**退订 store**——
 * 这两件事的时机都归面板的一次重建（见 `PropertiesPanel.render()`），
 * 登记在元素上而不是面板字段里，行怎么重建都找得到自己那座岛。
 */
const REF_ISLANDS = new WeakMap<HTMLElement, { ensure: () => void; dispose: () => void }>()

/**
 * ref 值行装目标块的正文（深度 1 的 inline 岛）。
 *
 * 三个口径都写在参数里：
 *   · **深度 1** ＝ `viewRootId`（目标的子树不归岛画——它们在大纲里本就有位置，
 *     岛里再展开是把一棵树画第二遍）＋ `embedBodies: false`（露面身体同样不展开，
 *     与镜像同一档构造性截断）；
 *   · **禁止拷贝语义** ＝ 编辑直接写回目标块本体（`write` 是装配层事务）；
 *   · `allowRootRemove: false`——岛绑定单一块，「值指向的块没了」走摘值/换目标，
 *     不是岛内删除键的职责。
 *
 * 自刷新与冻结都归 `EditableBlock`（唯一重载路径）；面板重建对它的
 * 保留/退役见 `PropertiesPanel` 的岛守卫（正被编辑的行整行保留）。
 */
function mountRefValueIsland(deps: RefIslandDeps, area: HTMLElement, targetId: string): void {
  const target = deps.blockOf(targetId)
  if (!target) return // 悬空值不画岛（读侧按悬空显示）
  // 岛根包着编辑器宿主（`EditableBlock` 构造时 root.appendChild(host)）：
  // 宿主必须是**新元素**，area 只当岛根的落点——同一个元素两头当，父子互包当场炸
  const host = document.createElement('div')
  // `inline-editor` 是既有的「裸正文」档（抬头/卡片格共用）：行 chrome 收掉、字号承容器——
  // 共用类名选择，不另写一份按容器的覆盖
  host.className = 'prop-ref-island inline-editor'
  const island = new EditableBlock({
    host,
    store: deps.store,
    write: deps.write,
    initialRoots: [target],
    viewRootId: target.id,
    embedBodies: false,
    structuralScope: 'roots',
    allowRootRemove: false,
    load: (ed, ids) => {
      if (!ed) return
      if (ids && !ids.includes(targetId)) return
      ed.reloadFromStore()
    },
    wire: deps.wire,
    onChange: deps.onChange,
    onFocus: deps.onFocus,
  })
  island.root.dataset.refTarget = targetId
  area.appendChild(island.root)
  REF_ISLANDS.set(island.root, {
    ensure: () => void island.ensureEditor(),
    dispose: () => island.dispose(),
  })
}

/**
 * 多值的**一枚 chip**：值文本 ＋ 摘除。
 *
 * 多值的读法一律从这里长出来（而不是各自拼字符串）：`asset` 用缩略图、
 * `select`／`ref`／`text`／`number` 用 chip —— 但「一格值是一个列表」这件事
 * 只有一种表达，写回时用 `valueListOf`／`valueItemsOf` 还原成数组，
 * **绝不 `String(value)`**（那会把 `a,b` 写回去，List 就退化成单值了）。
 */
function valueChips(
  items: readonly { text: string; refId?: string; icon?: string }[],
  onRemove: (index: number) => void,
  opts: { onOpen?: (index: number, e: MouseEvent) => void } = {},
): HTMLElement {
  const box = document.createElement('div')
  box.className = 'prop-chips'
  box.dataset.propChips = '1'
  for (const [i, item] of items.entries()) {
    const chip = document.createElement('span')
    chip.className = 'prop-chip'
    chip.dataset.chip = '1'
    const body = document.createElement('span')
    body.className = 'prop-chip-text ui-ellipsis'
    if (item.icon !== undefined && item.icon !== '') {
      const ico = document.createElement('span')
      ico.className = 'prop-chip-ico'
      ico.setAttribute('aria-hidden', 'true')
      renderIcon(ico, item.icon, 'circle', 'md')
      body.appendChild(ico)
    }
    const text = document.createElement('span')
    text.className = 'prop-chip-label ui-ellipsis'
    text.textContent = item.text
    body.appendChild(text)
    /**
     * 引用类的值本身是一枚**露面**：点名字＝打开目标（与正文引用、块下属性行同一条语义）。
     * 面板不在编辑器事件宿主里，所以这里显式调 `onOpen`；`data-ref-to` 仍留着，
     * 它是「指向某块」的语义标记，不是第二套跳转实现。
     */
    if (item.refId !== undefined && item.refId !== '') {
      body.dataset.refTo = item.refId
      body.classList.add('prop-chip-ref')
    }
    if (opts.onOpen) {
      body.classList.add('prop-chip-open')
      body.dataset.tip = t('ui.props.openRef')
      body.addEventListener('click', (e) => {
        e.stopPropagation()
        opts.onOpen!(i, e)
      })
    }
    const x = document.createElement('button')
    x.type = 'button'
    x.className = 'prop-chip-x'
    x.dataset.chipRemove = '1'
    x.dataset.tip = t('ui.props.multiRemove')
    x.textContent = '×'
    x.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      onRemove(i)
    })
    chip.append(body, x)
    box.appendChild(chip)
  }
  return box
}

/** 多值的「追加一个」入口（`+`）：形状与定义页的「＋候选标签」同一枚，读者认得 */
function chipAddButton(title: string, onClick: (anchor: DOMRect) => void): HTMLButtonElement {
  const add = document.createElement('button')
  add.type = 'button'
  add.className = 'prop-chip-add'
  add.dataset.chipAdd = '1'
  add.dataset.tip = title
  add.textContent = '+'
  add.addEventListener('click', (e) => {
    e.preventDefault()
    onClick(add.getBoundingClientRect())
  })
  return add
}

/** 值控件画在哪：面板/抽屉给整宽富控件，表格格只给一行（格子定高，不被预览撑破） */
export type CellEditorSurface = 'panel' | 'cell'

/**
 * 一行值的编辑器（按 kind）。返回控件元素。
 *
 * `ref` 与其它类型不同：它不是「输入一个值」，而是**选一个块**。
 * 所以它需要 deps（弹选择器、解析显示名），不能只靠 `commit`。
 *
 * ⚠️ **属性区与表格单元格共用这一份**：两处各写一套控件，迟早出现
 *    「面板里 Enter 能提交、表格里不能」这种只在某处复现的分叉。
 *
 * 多值（`many`）也在这里：它是**值的形状**（一格是一个列表），不是某一种 kind 的脾气
 * —— 所以 `text`／`number`／`select`／`ref`／`asset` 各自有控件，但共用「chips ＋ 追加」
 * 这一副形状与「写回整份数组」这一条写路径。
 */
export function makeCellEditor(
  row: FieldRow,
  commit: (v: unknown) => void,
  deps?: CellEditorDeps,
  owner?: Block,
  surface: CellEditorSurface = 'panel',
): HTMLElement {
  const kind = row.kind
  /**
   * **同一个值不重复提交**。
   *
   * 控件会给两条提交路径：`change`（失焦/选择）与 Enter（表格里显式派一次 `change`）。
   * 用键盘在输入框里敲完直接 Enter 时两条都会走到 —— 第二次提交的值与第一次相同，
   * 于是产出一次「零 op 的事务」，把 `lastOps` 冲成空数组：
   * 账面上「改了却没写」，而实际写了。这里按**控件自己记住的最后一个值**去重。
   */
  let last: unknown = row.value
  const same = (a: unknown, b: unknown): boolean => {
    // 多值的「同一个值」是**同样的数组**（引用比较恒不等 ⇒ 每次重画都多一笔零 op 事务）
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i])
    const ea = a === undefined || a === null || a === ''
    const eb = b === undefined || b === null || b === ''
    if (ea && eb) return true
    return a === b
  }
  const send = (v: unknown): void => {
    if (same(last, v)) return
    last = v
    commit(v)
  }
  if (kind === 'checkbox') {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'prop-check'
    /**
     * **三态**：有槽没勾（`false`）与没有这一槽（`undefined`）是两件事 ——
     * 「是任务但没填」与「不是任务」在待办条件里分得开，靠的就是这两位。
     * 浏览器只能画两态 ⇒ 用 `indeterminate` 把「没有值」画出来。
     */
    box.checked = row.value === true
    box.indeterminate = row.value === undefined || row.value === null
    box.addEventListener('change', () => send(box.checked))
    /**
     * **格子里要有字**：勾选框是**值**的控件，而这一格读起来是「谁 · 什么值」。
     * 只画一个方框时，表格列里看见的是「□ □」、看板列头看见的是 `false`／`true` ——
     * 读者得先知道方框属于哪个字段才认得出它。
     *
     * 所以二元值给一段**只读**的说明文字（「已完成／未完成」），它不参与编辑：
     * 改值仍然只有方框这一处。没有值（`undefined`）时不给字——那正是「未填」。
     */
    if (row.value === true || row.value === false) {
      const l = document.createElement('label')
      l.className = 'prop-check-row'
      const text = document.createElement('span')
      text.className = 'prop-check-text'
      text.textContent = row.value === true ? t('ui.props.checkboxOn') : t('ui.props.checkboxOff')
      l.append(box, text)
      return l
    }
    return box
  }
  /**
   * **这一格是不是多值**（`_cardinality: 'many'` ＋ 注册表说这个 kind 允许多值）。
   *
   * 两个条件都要：注册表是写路径的闸，控制面不该比它更宽 —— 坏数据里
   * `checkbox + many` 不该画出 chips（那会让用户以为这种形态是合法的）。
   */
  const many = row.cardinality === 'many' && allowsMany(kind)
  /**
   * `ref`：显示目标的名字，点一下换目标。
   *
   * ⚠️ **不提供手打 id 的输入框**：32 位 hex 没人记得住，让它可编辑等于让人拼手速。
   *    值的形状仍然是「一个块 id」（模型层不变），只是入口换成了选择器。
   *
   * **带修饰键 ⇒ 去那个块**（不带＝换目标）。这一支与正文引用同一份语义：
   * `openRef` 把 mods 原样交给 `openActionOf`（⇧ 右槽／⌘ 新 tab／⌥ 详情），
   * 这里不发明第二套「哪个键去哪儿」。编辑面（面板／表格）的主动作仍是换值——
   * 阅读面（块下行）反过来：点值就跳，见 `props-line.ts`。
   *
   * ⚠️ **多值时不换成「换目标」语义**：一串引用里换成「点一下把整串换成一个」
   *    是破坏性动作。多值时值本身是阅读面（chip 可点），编辑走 `×` 摘除与 `+` 追加，
   *    每次追加写回**整份数组**。
   */
  if (kind === 'ref') {
    if (many) {
      const ids = valueListOf(row.value)
      const box = document.createElement('div')
      box.className = 'prop-multi-value'
      box.dataset.propMulti = '1'
      if (deps?.refIsland !== undefined && refViewOf(row.def) === 'inline') {
        // **inline 看法的多值**：每个值一台岛（目标正文就地编辑，写回各自源块）。
        // 值层不变——仍是整份 id 数组：摘除写回数组、追加走选择器，岛只是值的看法。
        // 抽屉的一个属性就那么几个值，逐台岛的账付得起；表格/检视卡不传岛 deps，照旧 chips。
        for (const id of ids) {
          const item = document.createElement('span')
          item.className = 'prop-ref-item'
          mountRefValueIsland(deps.refIsland, item, id)
          item.appendChild(chipDel(t('ui.props.multiRemove'), () => {
            const next = ids.filter((x) => x !== id)
            send(next.length === 0 ? undefined : next)
          }))
          box.appendChild(item)
        }
      } else {
        box.appendChild(
          valueChips(
            ids.map((id) => ({ text: deps?.refLabel?.(id) ?? id, refId: id, icon: deps?.refIcon?.(id) })),
            (i) => {
              const next = ids.filter((_, j) => j !== i)
              send(next.length === 0 ? undefined : next)
            },
            deps?.openRef ? { onOpen: (i, e) => deps.openRef!(ids[i]!, clickModsOf(e)) } : {},
          ),
        )
      }
      if (deps?.pickRef && owner) {
        const pick = deps.pickRef
        box.appendChild(
          chipAddButton(t('ui.props.refAdd'), (anchor) => {
            pick(owner, row.propId, '', (targetId) => {
              if (targetId === '' || ids.includes(targetId)) return
              send([...ids, targetId])
            }, anchor)
          }),
        )
      }
      return box
    }
    if (deps?.pickRef && owner) {
      const pick = deps.pickRef
      const current = row.value === undefined || row.value === null ? '' : String(row.value)
      const wrap = document.createElement('span')
      wrap.className = 'prop-ref-value'

      /** 换目标退成一枚尾键——「看它/编辑它」与「换它」是两件事，不能挤在同一个点击上 */
      const changeKey = (): HTMLElement => {
        const change = document.createElement('button')
        change.type = 'button'
        change.className = 'prop-ref-change'
        change.dataset.tip = t('ui.props.refChange')
        change.setAttribute('aria-label', t('ui.props.refChange'))
        renderIcon(change, 'lucide:pencil', 'pencil', 'sm')
        change.addEventListener('click', (e) => {
          e.stopPropagation()
          pick(
            owner,
            row.propId,
            current,
            (targetId) => send(targetId === '' ? undefined : targetId),
            change.getBoundingClientRect(),
            change,
          )
        })
        return change
      }

      const islandDeps = deps.refIsland
      if (islandDeps && current !== '' && refViewOf(row.def) === 'inline') {
        // **inline 看法**：值行直接装目标块的正文（深度 1，装配见 `mountRefValueIsland`）。
        // 看法是 opt-in（缺省 chip）；正被编辑的行整行冻结（见 `PropertiesPanel.render()`），
        // 不会走到这里重造。
        mountRefValueIsland(islandDeps, wrap, current)
      } else {
        /**
         * **值本身是阅读面**：点名字＝打开目标（带修饰键走同一份 `openRef` 路由）。
         */
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'prop-input prop-ref'
        btn.dataset.refId = current
        btn.dataset.tip = current === '' ? t('ui.props.pickRef') : t('ui.props.refOpenHint')
        const icon = current === '' ? undefined : deps.refIcon?.(current)
        if (icon !== undefined && icon !== '') {
          const ico = document.createElement('span')
          ico.className = 'prop-ref-ico'
          ico.setAttribute('aria-hidden', 'true')
          renderIcon(ico, icon, 'circle', 'md')
          btn.appendChild(ico)
        }
        const name = document.createElement('span')
        name.className = 'prop-ref-name ui-ellipsis'
        name.textContent = current === '' ? t('ui.props.pending') : (deps.refLabel?.(current) ?? current)
        btn.appendChild(name)
        btn.addEventListener('click', (e) => {
          if (current !== '' && deps.openRef) {
            deps.openRef(current, clickModsOf(e))
            return
          }
          pick(owner, row.propId, current, (targetId) => send(targetId === '' ? undefined : targetId), btn.getBoundingClientRect(), btn)
        })
        wrap.appendChild(btn)
      }
      if (current !== '') wrap.appendChild(changeKey())
      return wrap
    }
  }
  if (kind === 'select' && many) {
    /**
     * 多值：**每一项一枚 chip**，`×` 摘这一项、`+` 开多选浮层。
     *
     * 此前是一颗「a、b」按钮：它把「一格有多个值」压成一句话，读者分不清
     * 哪些是可摘的项、也点不到其中某一个。chips 与 `asset` 的缩略图同一档 —— 都是
     * 「一格值是一个列表」的露面。
     *
     * 写回的是**整份数组**，与单选同一条 `set-value` 命令；每次勾选一次撤销。
     * 顺序按选项序（`currentChoiceIds`，与标签逐项对齐），摘除按 **id** 而不是按下标猜。
     */
    const ids = row.currentChoiceIds ?? valueListOf(row.value)
    const labels = row.currentChoiceLabels ?? []
    const iconOf = new Map((row.choices ?? []).map((c) => [c.id, c.icon]))
    const box = document.createElement('div')
    box.className = 'prop-multi-value'
    box.dataset.propMulti = '1'
    box.appendChild(
      valueChips(
        ids.map((id, i) => ({ text: labels[i] ?? t('ui.props.choice.deleted'), icon: iconOf.get(id) })),
        (i) => {
          const next = ids.filter((_, j) => j !== i)
          send(next.length === 0 ? undefined : next)
        },
      ),
    )
    if (deps?.pickChoice && owner) {
      const pick = deps.pickChoice
      box.appendChild(
        chipAddButton(t('ui.props.pickChoiceMulti'), (anchor) => {
          pick(owner, row.propId, ids, (next) => send(next.length === 0 ? undefined : next), anchor)
        }),
      )
    }
    return box
  }
  if (kind === 'select') {
    const sel = document.createElement('select')
    sel.className = 'prop-input'
    /**
     * 选项只从 `row.choices` 来（派生好的一份）：UI 不认识「选项目录存在哪」，
     * 也就不会出现「属性面板与表格各读一处、两处能不一致」。
     */
    const choices = row.choices ?? []
    const current = row.value === undefined || row.value === null ? '' : String(row.value)
    const tagName = deps?.tagName ?? ((id: string) => id.slice(-6))
    const empty = document.createElement('option')
    empty.value = ''
    empty.textContent = t('ui.props.pending')
    sel.appendChild(empty)
    for (const c of choices) {
      const o = document.createElement('option')
      o.value = c.id
      o.textContent = row.def ? choiceDisplayLabel(c, row.def, tagName) : c.label.trim() || c.id.slice(-6)
      sel.appendChild(o)
    }
    /**
     * **当前值不在可见选项里**（作用域隐藏 / 选项软删 / 值来自另一个库）时，
     * 仍然画出来并保持选中：值在模型里还在，控件不许替用户把它丢掉。
     * 用户可显式切走或清空 —— 那是他的动作，不是这一次渲染的副作用。
     */
    if (current !== '' && !choices.some((c) => c.id === current)) {
      const o = document.createElement('option')
      o.value = current
      const base = row.currentChoiceLabel ?? t('ui.props.choice.deleted')
      // 软删的选项**保留旧名**再标「已删除」：用户才知道要恢复哪一条
      o.textContent = row.currentChoiceDeleted ? t('ui.props.choice.deletedNamed', { label: base }) : base
      o.dataset.missing = '1'
      if (row.currentChoiceDeleted) o.dataset.deleted = '1'
      o.dataset.tip = row.currentChoiceDeleted
        ? t('ui.props.choice.deletedTitle', { label: base })
        : t('ui.props.choice.notInScope')
      sel.appendChild(o)
    }
    sel.value = current
    sel.addEventListener('change', () => send(sel.value === '' ? undefined : sel.value))
    /**
     * **当前值的图标预览**：有图标才加这一枚（没有的 select 保持原样，不给每一条
     * 都塞一个虚线占位）。它读的是行派生里的选项块，与 gutter 同一个 `_icon`。
     */
    const currentChoice = choices.find((c) => c.id === current)
    const icon = currentChoice?.icon ?? (row.def ? prop<string>(row.def, ICON_PROP) : undefined)
    if (icon === undefined) return sel
    const wrap = document.createElement('span')
    wrap.className = 'prop-select'
    const ico = document.createElement('span')
    ico.className = 'prop-select-ico'
    renderIcon(ico, icon, 'square-dashed', 'md')
    wrap.append(ico, sel)
    return wrap
  }
  /**
   * `asset`：**预览在上、地址在下**（表格格仍收成一行）。
   *
   * 值只有一份，图与地址是它的两种投影：图是「它是什么」，地址是「它从哪来」。
   * 两件事放在同一条带上，读者分不出哪部分可点、哪部分可改；分开之后：
   *   · 预览带是值的舞台（点图＝默认动作：lightbox／外链／详情）；
   *   · 地址带是唯一的编辑入口（手填链接／选文件），也是唯一吸收收缩量的格。
   *
   * 多值预览横向滚动，但滚动本身要**看得出来**：计数徽标 ＋ 细滚动条 ＋
   * 右缘渐隐（只在真的溢出时出现，`data-overflow` 现算），容器可聚焦用方向键滚。
   *
   * 两态值（hash／http(s)）在 `asset-value.ts` 现算成地址，这里只管读写：
   *   · 已有值画成露面（内态缺失／外链腐烂时自己退化成一句实话，值不动）；
   *   · 手填仍可写外链或资产 id，写路径按 kind＋`isAssetRef` 校验；
   *   · 选文件走装配层入库，拿到 hash 再写这一格 —— 组件不碰文件对话框与资产库。
   *
   * ⚠️ **单值／多值都从 `assetRefsOf` 读**：定义切成 `many` 后值是数组，
   *    这里追加／摘除都保持数组形状，绝不 `String(value)`（那会把 `a,b` 写回成一个字符串）。
   *    基数开关在定义页的通用段（`buildDefCardinality`，asset 在注册表里 `many: true`）。
   */
  if (kind === 'asset') {
    const refs = assetRefsOf(row.value)
    const box = document.createElement('div')
    box.className = 'prop-asset'
    box.dataset.assetEditor = '1'
    box.dataset.assetMany = many ? '1' : '0'
    box.dataset.assetSurface = surface

    if (refs.length > 0) {
      const preview = document.createElement('div')
      preview.className = 'prop-asset-preview'
      if (refs.length > 1) {
        preview.dataset.tip = t('ui.props.assetScrollHint', { n: refs.length })
        const count = document.createElement('span')
        count.className = 'prop-asset-count'
        count.textContent = t('ui.props.assetCount', { n: refs.length })
        count.dataset.tip = t('ui.props.assetScrollHint', { n: refs.length })
        preview.appendChild(count)
      }
      const thumbs = document.createElement('div')
      thumbs.className = 'prop-asset-thumbs'
      if (refs.length > 1) {
        // 多值才需要滚：容器可聚焦，方向键能滚；计数徽标在右上角说明「还有」
        thumbs.tabIndex = 0
        thumbs.setAttribute('aria-label', t('ui.props.assetScrollHint', { n: refs.length }))
      }
      for (const ref of refs) {
        const thumb = makeAssetThumb(ref, {
          onRemove: () => {
            // 多值摘一项仍写数组；摘空了就是「没有这一格」（与 chips 一条口径）
            const next = refs.filter((x) => x !== ref)
            send(many ? (next.length === 0 ? undefined : next) : undefined)
          },
        })
        if (deps?.activateAsset) {
          thumb.dataset.assetOpen = '1'
          thumb.addEventListener('click', (e) => {
            e.stopPropagation()
            deps.activateAsset!(ref, row.label)
          })
        }
        thumbs.appendChild(thumb)
      }
      preview.appendChild(thumbs)
      box.appendChild(preview)

      // 溢出是「此刻的几何」，不是值的性质：首帧、图片解码后各量一次
      const syncOverflow = (): void => {
        preview.dataset.overflow = thumbs.scrollWidth > thumbs.clientWidth + 1 ? '1' : '0'
      }
      requestAnimationFrame(syncOverflow)
      thumbs.addEventListener('scroll', syncOverflow, { passive: true })
      for (const img of thumbs.querySelectorAll('img')) img.addEventListener('load', syncOverflow, { once: true })
    }

    const address = document.createElement('div')
    address.className = 'prop-asset-address'
    // 地址带的引导图标说明「这一格是引用」：库内 hash 是文件，外链是链接。
    const lead = document.createElement('span')
    lead.className = 'prop-asset-lead'
    lead.setAttribute('aria-hidden', 'true')
    renderIcon(lead, refs[0] && assetRefKindOf(refs[0]) === 'internal' ? 'lucide:file' : 'lucide:link', 'link', 'sm')
    address.appendChild(lead)

    const input = document.createElement('input')
    input.className = 'prop-input prop-asset-input'
    input.type = 'text'
    input.spellcheck = false
    input.placeholder = t(many ? 'ui.props.assetAddPlaceholder' : 'ui.props.assetPlaceholder')
    input.setAttribute('aria-label', t('ui.props.assetAddress'))
    input.value = many ? '' : (refs[0] ?? '')
    input.addEventListener('change', () => {
      const next = input.value.trim()
      if (next === '') {
        if (!many) send(undefined)
        return
      }
      send(many ? [...refs, next] : next)
    })
    address.appendChild(input)
    if (deps?.pickAsset) {
      const pick = deps.pickAsset
      const btn = document.createElement('button')
      btn.type = 'button'
      // 「选择文件」是动作不是数据：窄槽里按视觉纪律 5 先做减法，文字退 tooltip ＋ aria，
      // 让出宽度给地址（那格才是能省略、能拿回全文的）。
      btn.className = 'prop-asset-pick ghost'
      btn.dataset.assetPick = '1'
      btn.dataset.tip = t('ui.props.assetPickHint')
      btn.setAttribute('aria-label', t('ui.props.assetPick'))
      renderIcon(btn, 'lucide:image-plus', 'image-plus', 'sm')
      btn.addEventListener('click', () =>
        pick((hash) => {
          if (many) {
            if (!refs.includes(hash)) send([...refs, hash])
          } else send(hash)
        }),
      )
      address.appendChild(btn)
    }
    box.appendChild(address)
    return box
  }
  /**
   * **`text`／`number` 的多值**：chips ＋ 一个「加一个值」的输入框。
   *
   * 为什么不用「一行一个输入框」：多值的项数是用户随手长的，行数跟着变会
   * 让属性区的行高跳（面板与表格都在按「行数 × 行高」估高）；chips 是**一格**。
   *
   * 读值走 `valueItemsOf`（不滤类型：`number` 多值存的是数字数组，
   * 走只认字符串的 `valueListOf` 会读成空列表 ⇒ 有值却显示待填）。
   */
  if (many && (kind === 'text' || kind === 'number')) {
    const values = valueItemsOf(row.value)
    const box = document.createElement('div')
    box.className = 'prop-multi-value'
    box.dataset.propMulti = '1'
    const commitOne = (raw: string): void => {
      const text = raw.trim()
      if (text === '') return
      if (kind === 'number') {
        const n = Number(text)
        // 解析失败 ⇒ 不写（回退，一次 op 都不产），与单值数字同一条
        if (!Number.isFinite(n)) return
        send([...values, n])
        return
      }
      send([...values, text])
    }
    box.appendChild(
      valueChips(
        values.map((v) => ({ text: String(v) })),
        (i) => {
          const next = values.filter((_, j) => j !== i)
          send(next.length === 0 ? undefined : next)
        },
      ),
    )
    const add = document.createElement('input')
    add.className = 'prop-input prop-multi-add'
    add.placeholder = t('ui.props.multiAdd')
    add.inputMode = kind === 'number' ? 'decimal' : 'text'
    if (row.format === 'url' || row.format === 'email' || row.format === 'phone') add.spellcheck = false
    /**
     * 提交走 `onCommitKeys`（Enter 由它兜住并 `stopPropagation`）：这个输入框可能长在
     * 表格格里，Enter 冒到命令层会命中「拆块」，也会让属性卡的 Enter 去提交别的行。
     * 失焦也提交一次 —— 用户打完字直接点别处是最常见的那条路。
     */
    const submit = (): void => {
      commitOne(add.value)
      add.value = ''
    }
    onCommitKeys(add, { commit: submit, stop: true })
    add.addEventListener('change', submit)
    box.appendChild(add)
    return box
  }
  const input = document.createElement('input')
  input.className = 'prop-input'
  /**
   * 输入框类型跟着**格式**走（不是跟着 kind）：`url`／`email`／`tel` 的原生键盘与
   * 浏览器提示是白拿的；校验仍在写路径（命令层），这里只影响键盘与拼写检查。
   */
  input.type =
    kind === 'date'
      ? 'date'
      : row.format === 'url'
        ? 'url'
        : row.format === 'email'
          ? 'email'
          : row.format === 'phone'
            ? 'tel'
            : 'text'
  if (row.format === 'url' || row.format === 'email' || row.format === 'phone') input.spellcheck = false
  if (kind === 'number') input.inputMode = 'decimal'
  input.placeholder = t('ui.props.pending')
  input.value = row.value === undefined || row.value === null ? '' : String(row.value)
  input.addEventListener('change', () => {
    if (input.value === '') {
      send(undefined)
      return
    }
    /**
     * **数字提交的是 `number`**（不是字符串）：排序与统计按值比，字符串会退化成字典序
     * （`10` 排在 `9` 前面），而且从表面看只是「顺序有点怪」。
     * 解析失败 ⇒ 不写（回退原值，一次 op 都不产）。
     */
    if (kind === 'number') {
      const n = Number(input.value)
      if (!Number.isFinite(n)) {
        input.value = row.value === undefined || row.value === null ? '' : String(row.value)
        return
      }
      send(n)
      return
    }
    send(input.value)
  })
  return input
}

/** 面板重建时把进了文档的岛补建编辑器（构造时量 DOM，等挂好才建；游离的等下一帧） */
export function ensureRefIslandsIn(body: ParentNode): void {
  for (const node of Array.from(body.querySelectorAll(`[${EDIT_ISLAND_ATTR}]`))) {
    if (!(node instanceof HTMLElement)) continue
    const entry = REF_ISLANDS.get(node)
    if (!entry) continue
    if (node.isConnected) entry.ensure()
    else requestAnimationFrame(() => {
      if (node.isConnected) entry.ensure()
    })
  }
}

/** 面板收起/换主体：全部岛退役——岛的订阅不比面板活得久 */
export function disposeRefIslandsIn(body: ParentNode): void {
  for (const node of Array.from(body.querySelectorAll(`[${EDIT_ISLAND_ATTR}]`))) {
    if (node instanceof HTMLElement) REF_ISLANDS.get(node)?.dispose()
  }
}
