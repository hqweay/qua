/**
 * **浮层渲染**：触发表（`/` 命令 · `#` 标签 · `@` 页块）＋ 划选气泡 ＋ 菜单入口（palette/menu/slash）。
 * 三个触发字符共用**一个**浮层组件，差别只在「列什么行」；「选中之后做什么」由 `pickRow`
 * 按行的 `pick` 决定——浮层不认识插入语义。
 *
 * 会话状态（`triggerCh`／`stageTag`／`lastQuery`）住本片，经 `triggerState` 读写：
 * 编辑器事件表与「关闭所有浮层」要从外面清它——状态只此一份，不许复制成两份。
 * 森林与 registry 都是**现取**的：换库之后这里必须看到新库；装配顺序晚于本片的也照此办理。
 */
import { paletteRows, rowsFromBindings, type PickMods, type Row } from '../../ui/overlay/layers.ts'
import { createTriggers, memberRows, type MemberTagRef, type TriggerDeps } from '../../app/retrieval/triggers.ts'
import { selectionRefRows } from '../../app/retrieval/selection-ref-rows.ts'
import { resolveBindings, type Binding } from '../../core/infra/bindings.ts'
import { type ActsOn, type MenuRequest, type MenuTarget, type Registry } from '../../core/commands/index.ts'
import { blockMenuCtxOf, findInForest, inboundRefCount, type ColorAxis, type CtxKeys, type TriggerChar } from '../../core/index.ts'
import { projectManualAutomations } from '../../core/automation/projection.ts'
import { Layers } from '../../ui/overlay/layers.ts'
import type { BlockEditor } from '../../view/editor/editor.ts'
import type { TriggerQuery } from '../../view/editor/editor-events.ts'
import type { Prefs, Workspace } from '../../core/infra/workspace.ts'
import type { MemoryKb } from '../../core/kb/memory.ts'
import { t } from '../../core/infra/msg.ts'

/** 被否掉的触发出现：Esc／点外关掉浮层后字还留着，判定再认出这一次就不弹 */
type TriggerDismissed = Pick<TriggerQuery, 'blockId' | 'ch' | 'from'>

/** 划选气泡与触发浮层的「此刻」状态：编辑器事件表（triggerQuery）与 closeLayers 经它读写 */
export interface TriggerState {
  triggerCh: TriggerChar | null
  readonly stageTag: MemberTagRef | null
  lastQuery: string
  /** 最近一次上报的触发（关浮层时要靠它认出「否掉的是哪一次」；词没了 ⇒ null） */
  lastHit: TriggerQuery | null
  /** 被否掉的出现；`null` ＝ 没有有效的否决（词删了／另起了一次触发都会清掉） */
  dismissed: TriggerDismissed | null
}

export interface RetrievalDeps {
  ws: Workspace
  kb: MemoryKb
  layers: Layers
  uiCtx: () => CtxKeys
  keyHints: () => Map<string, string>
  isMac: () => boolean
  prefs: () => Prefs
  getEd: () => BlockEditor
  getRegistry: () => Registry
  /** 面板晚于本片装配：最近色记账走闭包 */
  getPanels: () => { recordRecentColor(slot: string): void }
  scheduleDeviceSave: () => void
}

export function setupRetrieval(deps: RetrievalDeps) {
  const { ws, kb, layers, uiCtx, keyHints, isMac, prefs, getEd, getRegistry, getPanels, scheduleDeviceSave } = deps

  /**
   * **自动化的面板投影**（派生的动态命令，不是第二张命令表）：
   * 目标＝此刻聚焦的那一块；不适用灰掉并说明——发现性靠它，不是靠隐藏。
   * 灰行的 hint 与运行前拦截的 toast 共用同一组文案 id（两个答案不许分叉）。
   */
  const automationPaletteRows = (): Row[] => {
    const ed = getEd()
    const targetId = ed.sel?.aBlock ?? ed.caretBlock() ?? undefined
    return projectManualAutomations(kb, targetId).map((e) => ({
      id: e.id,
      label: e.title,
      // 灰行的 hint 说的是「为什么现在不能跑」；可运行的行不占提示位
      hint: e.reason ? t(`ui.automation.blocked.${e.reason}`, { name: e.title }) : '',
      icon: e.icon,
      group: `palette/${t('menu.cat.automation')}`,
      command: 'core.automation/run',
      args: { automationId: e.automationId, ...(targetId !== undefined ? { blockId: targetId } : {}) },
      disabled: !e.runnable,
    }))
  }

  // 会话状态（唯一持有者；外面经 triggerState 读写，不许复制成两份）
  let triggerCh: TriggerChar | null = null
  let stageTag: MemberTagRef | null = null
  let lastQuery = ''
  let lastHit: TriggerQuery | null = null
  let dismissed: TriggerDismissed | null = null

  /**
   * **否决此刻的触发出现**：Esc／点外关掉浮层时字还留着（Esc 的口径——那段字
   * 就是纯文本），继续打字不该把浮层弹回来。判定是纯文本的，它认不出「已被否掉」，
   * 所以这里记下「哪一块的哪个偏移上那次触发被否了」；词没了（删了／被选中替换）
   * 自然失效，不专门清。
   */
  function dismissCurrent(): void {
    if (!lastHit) return
    const { blockId, ch, from } = lastHit
    dismissed = { blockId, ch, from }
  }
/* ------------------------------------------------------------ 浮层渲染 */

/**
 * **触发表**：`/` 命令源 · `#` 标签源 · `@` 页块源。
 *
 * 三个触发字符共用**一个**浮层组件（`layers.openMenu`），差别只在「列什么行」；
 * 「选中之后做什么」由下面 `pickRow` 按行的 `pick` 决定——浮层不认识插入语义。
 *
 * ⚠️ 森林是**现取**的（`() => ws.blocks`）：换库之后这里必须看到新库。
 * ⚠️ `#` 有三枚徽标（`↵`／`⌥↵`／`⇧↵`）：三种落点由按键区分，不由行区分。
 */
const triggerDeps: TriggerDeps = {
  forest: () => ws.blocks,
  ctx: uiCtx,
  keyHints,
  shortcutHint: `↵ ${isMac() ? '⌥↵' : 'Alt+↵'} ${isMac() ? '⇧↵' : 'Shift+↵'}`,
  // `@` 新建页行的第二落点徽标：⌥↵ 建普通块（与划选转引用同键同义）
  newPageAltHint: t('ui.retrieval.newPageAlt', { key: isMac() ? '⌥↵' : 'Alt+↵' }),
  // `@` 候选排除「正在打字的这一块」：它自己的正文含着查询词，点它＝引用自己
  selfBlockId: () => getEd().caretBlock() ?? getEd().sel?.aBlock ?? null,
  // 块行的反链数：主编辑器的 store 即共享关系索引，查表 O(这一块的边数)
  refCount: (id) => inboundRefCount(getEd().store.index, id),
}

const triggers = createTriggers(triggerDeps)

/**
 * 划选气泡：**选区存在就在它上方浮一排格式按钮，选区塌了就消失**。
 *
 * 这是「顶部工具栏」的替代品（2026-10-19）。为什么改成这样：
 *   · 中性现代的口径是 chrome 极弱 —— 一排常驻按钮是**最重**的 chrome；
 *   · 加粗/高亮这类命令**只对选区有意义**（光标态按下去没有任何效果），
 *     常驻等于长期摆着几个点不动的按钮；把「有没有选区」做成**唯一开关**，
 *     可用性靠 `when` 表达（「这次怎么显示」归查询或绑定，不是给块加字段）。
 *
 * ⚠️ 气泡**不进 `layers.open`**（那是菜单/命令面板的模态状态）：它在的时候用户还能打字，
 *    Esc 也不该关它 —— 关它的唯一条件是「选区没了」。
 */
/**
 * 「关联到…」搜索窗开着的时候，划选气泡要**挂起**。
 *
 * 为什么必须显式挂起：气泡的层级 `--ui-z-selbar` 比菜单的 `--ui-z-menu` 高，而它唯一的关闭条件是
 * 「选区没了」——浮层抢焦点并不必然清掉模型选区，于是气泡会盖在搜索结果上面。
 * 这里是「选区存在期间常驻」那条纪律的**唯一例外**：用户此刻在与同一个选区做决定。
 */
let selectionRefPickerOpen = false

/**
 * 划选气泡当前展开的颜色值轴。
 *
 * 为什么由装配层持有：`core.anno/pick-*` 是命令，命令只说「要选值了」，
 * 浮层与它的展开态归装配层（`showRefPicker` 同一条分工）；气泡每次刷新都重建 DOM，
 * 把状态塞进 DOM 会随重建丢掉。选区一塌就在这里清掉，不另设超时或关闭按钮。
 */
let selColorAxis: ColorAxis | null = null

/** 同一轴再点一次＝收起；不写库、不进撤销 */
function toggleColorAxis(axis: ColorAxis): void {
  selColorAxis = selColorAxis === axis ? null : axis
  refreshSelectionBar()
}

function refreshSelectionBar(): void {
  if (selectionRefPickerOpen) {
    layers.closeSelectionBar()
    selColorAxis = null
    return
  }
  /**
   * ⚠️ **先量选区、再算上下文**：`uiCtx()` 是整条 when 键空间（含整库展平、格式
   * 与块数），而选区塌了／没有矩形时气泡根本不会开。把它放在 `uiCtx()` 前面，
   * 光标每动一次（每一次按键都会发 selectionchange）就不必付那份代价。
   */
  const rect = getEd().selectionRect()
  // 气泡开着时不要被「菜单打开」这类状态误关：选区还在就该在
  if (!rect) {
    layers.closeSelectionBar()
    selColorAxis = null
    return
  }
  const ctx = uiCtx()
  const rows = rowsFromBindings(resolveBindings('selection', ctx), keyHints())
  if (rows.length === 0) {
    layers.closeSelectionBar()
    selColorAxis = null
    return
  }
  layers.openSelectionBar({
    rows,
    anchor: rect,
    activeMarks: new Set(getEd().marksAtSel()),
    expandedAxis: selColorAxis,
    recentColors: prefs().recentColors,
    onPick: (row) => {
      if (row.command) getRegistry().invoke(row.command, (row.args as Record<string, unknown>) ?? {}, 'selection', ctx)
      // 色盘的两条通道：`-live`（拖动实时上色）只发命令——收轴或重建气泡都会销毁那枚
      // input，面板后面的 input/change 就全落空；`-custom`（面板关掉）只记账最近色，
      // 格式命令在 input 里已经实时发过，这里重画一次把按压态与最近段跟上
      if (row.id.endsWith('-live')) return
      if (row.id.endsWith('-custom')) {
        const slot = (row.args as { slot?: unknown } | undefined)?.slot
        if (typeof slot === 'string') getPanels().recordRecentColor(slot)
        refreshSelectionBar()
        return
      }
      // 值用完即收：色点和入口都走同一条 onPick，只有真正选了值才收二级
      if (row.command === 'core.anno/set-ink' || row.command === 'core.anno/set-bg') selColorAxis = null
      // 命令改了格式 ⇒ 气泡的**按压态**要跟着变（高亮那颗该亮起来）。
      // 不重刷的话，点完加粗按钮看不出"已经加粗了"。
      refreshSelectionBar()
    },
  })
}

/**
 * **「关联到…」**：划选气泡一键按钮旁边的逃逸口。
 *
 * 一键直达是高频路径（同名地址／没有就建页，零决策），只有「想关联别的页或块」
 * 才展开这里。首项预选、↵ 即完成，且首项恒等价于那颗一键按钮 ⇒ 逃逸口不额外
 * 收一次决策的税。查询词预填选中的字且全选，直接打字就是改写。
 *
 * ⚠️ 冻结的是**模型选区**（`ed.sel`），不是 DOM Range：浮层要抢焦点让用户打字，
 *    原生 Range 会塌；模型选区不会，命令写入也只认它。取消时用 `setSel` 整段还回去。
 * ⚠️ 搜索过程零写入：行源只读，所有落库发生在 `onPick` 那一笔命令事务里。
 */
function showSelectionRefPicker(): void {
  const spot = getEd().selectionSpot()
  if (!spot) return
  // getter 跨调用不保窄化：先取一份再展开（模型选区，不是 DOM Range）
  const curSel = getEd().sel
  const frozenSel = curSel ? { ...curSel } : null
  const anchor = getEd().selectionRect()
  const rows = selectionRefRows({ kb, selfId: spot.blockId })
  /** `closeMenu` 在 `onPick` 之前回调 `onClose`；下一帧靠它区分「取消」与「已选」 */
  let picked = false
  selectionRefPickerOpen = true
  layers.closeSelectionBar()
  layers.openMenu({
    rows: rows(spot.text),
    anchor,
    title: t('ui.selRef.title'),
    width: 480,
    searchable: true,
    focusSearch: true,
    initialQuery: spot.text,
    placeholder: t('ui.selRef.placeholder'),
    emptyText: t('ui.selRef.empty'),
    onQuery: (q) => layers.setRows(rows(q)),
    onPick: (row, mods) => {
      const pick = row.pick
      if (!pick) return
      picked = true
      const args: Record<string, unknown> = {}
      if (pick.kind === 'newPage') {
        // ↵ 不带 create ⇒ 与一键默认同义；⌥↵ 强制建普通块
        if (mods.altKey) args.create = 'block'
      } else if (pick.kind === 'block' || pick.kind === 'page' || pick.kind === 'tag') {
        args.to = pick.id
      } else return
      getRegistry().invoke('core.editor/selection-to-ref', args, 'selection', uiCtx())
    },
    onClose: () => {
      selectionRefPickerOpen = false
      /** 同步还模型选区：`closeMenu` 先回调这里、再调 `onPick`，命令紧接着要读它 */
      if (frozenSel) getEd().setSel(frozenSel)
      refreshSelectionBar()
      /**
       * 取消（Esc／点外）还要把整段选区**投影回 DOM**：焦点归还触发的那一轮
       * `selectionchange` 会把浏览器原生 Range 折叠，而气泡靠 `selectionRect()`
       * 定位 —— 只还模型选区的话用户看到的是「Esc 之后选区没了」。等这一轮
       * 抖动过去再投一次；选中路径上 `picked` 已置真，别去动刚落好的光标。
       */
      requestAnimationFrame(() => {
        if (picked) return
        if (frozenSel) getEd().setSel(frozenSel)
        refreshSelectionBar()
      })
    },
  })
}

/**
 * **打开检索浮层**（三个触发字符共用这一个入口）。
 *
 * 行为与原来的斜杠菜单同形：不抢焦点（`focusSearch:false`）、`searchable:false`
 * ——打字继续进 `.tx`，`triggerQuery` 每次上报就来 `setRows`。
 */
function openTrigger(ch: TriggerChar, query: string, anchor: DOMRect | null, title?: string): void {
  const trigger = triggers.get(ch)
  if (!trigger) return
  triggerCh = ch
  lastQuery = query
  layers.openMenu({
    rows: trigger.source(query),
    anchor,
    title: title ?? trigger.title,
    searchable: false,
    focusSearch: false,
    emptyText: trigger.emptyText,
    // ⚠️ `ch` 走闭包而不是读全局：`closeMenu` 会在 `onPick` 之前回调 `onClose` 把状态清掉，
    //    读全局就会读到「已经没开着了」，于是这次选中什么都不做（真实踩过）。
    onPick: (row, mods) => pickRow(ch, row, mods),
    onClose: () => {
      // Esc／点外关掉而字还留着 ⇒ 否决这次出现：继续打字不复活（Esc 的口径）。
      // 选中一行的路径也会先走这里，但 pickRow 当场清掉否决——抹词之后留否决
      // 会误伤「在同一位置重新敲触发字符」；别靠「下一发上报是 null」来失效它，
      // 下一次输入往往直接就是新命中，中间没有 null 上报。
      dismissCurrent()
      triggerCh = null
    },
  })
}

/**
 * **`#` 的第二段：成员搜索**（⇧↵ 选中一个标签后进入）。
 *
 * 与第一段（`openTrigger`）的分工：第一段的查询词是**块内文本**（打字继续进 `.tx`），
 * 第二段的查询词住**浮层自己的输入框**（`focusSearch`＋`onQuery`）——`#` 触发词不能含空格，
 * 「标签名 ＋ 成员搜索」没法共用同一段正文；也不该共用：第二段是**浮层的状态**，
 * 关掉就回到打字（块内 `#玩具` 原样保留，触发判据还活着，继续打字自动重开第一段）。
 *
 * 落点仍走 `pickRow` ⇒ `acceptTrigger` 同一笔事务：抹掉 `#玩具`、（需要时）建记录、插露面。
 */
function openMemberStage(tag: MemberTagRef): void {
  stageTag = tag
  triggerCh = null
  layers.openMenu({
    rows: memberRows(tag, '', triggerDeps),
    anchor: getEd().caretRect(),
    title: t('ui.retrieval.memberTitle', { name: tag.name }),
    searchable: true,
    focusSearch: true,
    emptyText: t('ui.retrieval.memberEmpty'),
    onPick: (row, mods) => {
      stageTag = null
      pickRow('#', row, mods)
    },
    onQuery: (q) => layers.setRows(memberRows(tag, q, triggerDeps)),
    onClose: () => {
      // 第二段 Esc 时第一段那串 `#名` 还在正文里：同样否决，回到正文继续打字不复活
      dismissCurrent()
      stageTag = null
    },
  })
}

/**
 * **选中之后做什么**：浮层只报「选中了谁 ＋ 按了什么键」，落点在这里决定。
 *
 * 这条分叉是拍板过的：同一条 `#名` 行按 `↵` 是「插进正文」（`ref` 露面，不写归属），
 * 按 `⌥↵` 是「归到本块」（写 `_tags`，正文里那串字消失、行尾出 chip）。
 * 让按键去区分插法，而不是让同一行有两种「长得一样、按下去不一样」的入口 ——
 * 行的身份已经决定它是不是标签类；按键只在这个范围内换结果。
 *
 * ⚠️ `⌘Enter` 已归「切换待办」，所以这里**不用** ⌘／Ctrl 做归类。
 */
function pickRow(ch: TriggerChar, row: Row, mods: PickMods): void {
  const pick = row.pick
  // 浮层已关：从这里往后「现在开着的是谁」一律清掉（同一笔动作只发生一次）
  triggerCh = null
  // 选中即落笔：除进入第二段成员搜索外，触发字符这一路马上被抹掉——
  // 「否决这一次出现」只服务 Esc／点外关掉而字还留着的路径；字没了还留着否决，
  // 下一次在同一位置敲同一个触发字符就会被误伤（浮层死）
  dismissed = null
  if (!pick) return

  // 命令行：先把 `/查询词` 让出来，再走命令 —— 命令自己决定落在哪一格（与原来同形）
  if (pick.kind === 'command') {
    const id = getEd().caretBlock()
    if (id) getEd().triggers.dropTrigger(id)
    if (pick.command) getRegistry().invoke(pick.command, (pick.args as Record<string, unknown>) ?? {}, 'slash', uiCtx())
    return
  }

  if (pick.kind === 'page' || pick.kind === 'block') {
    // 页行被别名点名时带 `anchor`（行显的就是它，落进正文读同一个名字）；
    // 主名与块行（正文命中）不带——引用继续跟随块名，不冻快照。
    getEd().triggers.acceptTrigger({
      ch,
      pick: { kind: 'ref', to: pick.id, label: pick.name, ...(pick.kind === 'page' && pick.anchor ? { anchor: pick.anchor } : {}) },
    })
    return
  }

  // `@` 无同名页：当场建页（或复用同名地址）并在原位插引用；同一笔事务。
  // ⌥↵ 是另一条路：不建页，以查询词造一个普通块——与划选转引用的强制建块同键同义
  if (pick.kind === 'newPage' && mods.altKey) {
    getEd().triggers.acceptTrigger({ ch, pick: { kind: 'newBlock', name: pick.name } })
    return
  }
  if (pick.kind === 'newPage') {
    getEd().triggers.acceptTrigger({ ch, pick: { kind: 'newPage', name: pick.name } })
    return
  }

  /**
   * `#` 的三种落点**只看按键**，不看选中的是哪一栏：
   *   · `⇧↵` ⇒ **进入成员搜索**（第二段浮层：该标签的成员 ＋「新建实例『输入文本』」）；
   *     「立即建一条实例」由第二段的新建行覆盖，名字终于由输入文本给；
   *   · `⌥↵` ⇒ 把标签归到本块（写宿主 `_tags`，行尾出 chip）；
   *   · `↵`   ⇒ 行内标签：实例行引用那条记录、标签类行引用类块。
   *
   * 新建标签行是例外：`⇧↵` 仍就地建标签＋建**同名**实例——
   * 那条路上名字就是用户打的字，没有「标签名冒充实例名」的分叉。
   */
  if (pick.kind === 'newTag') {
    const action = mods.shiftKey ? 'instance' : mods.altKey ? 'assign' : 'inline'
    getEd().triggers.acceptTrigger({ ch, pick: { kind: 'newTag', name: pick.name, action } })
    return
  }

  if (ch === '#' && mods.shiftKey && (pick.kind === 'tag' || pick.kind === 'instance')) {
    openMemberStage(pick.kind === 'tag' ? { tagId: pick.id, name: pick.name } : { tagId: pick.tagId, name: pick.tag })
    return
  }

  const tagName = pick.kind === 'instance' ? pick.tag : pick.kind === 'tag' ? pick.name : ''
  if (ch === '#' && tagName !== '' && mods.altKey) {
    getEd().triggers.acceptTrigger({ ch, pick: { kind: 'tag', name: tagName } })
    return
  }

  /**
   * 第二段的新建实例行：名字＝用户在浮层里输入的文本，标签＝第二段锚定的那一个。
   * （tagId 直用、失效不做——判据在 `acceptTrigger`，这里只传话。）
   */
  if (pick.kind === 'newObj') {
    if (!pick.tagId) return
    getEd().triggers.acceptTrigger({ ch, pick: { kind: 'newObj', name: pick.name, tagId: pick.tagId } })
    return
  }

  /**
   * 实例一条记录 ＝ 提及「这个标签的一次出现」：与 `@` 的引用同一个落点，
   * 只多一个 `flavor:'#'` 的显示风味。选中的是哪条记录由浮层那一行给出。
   */
  if (pick.kind === 'instance') {
    getEd().triggers.acceptTrigger({ ch, pick: { kind: 'ref', to: pick.id, label: pick.name, flavor: '#' } })
    return
  }

  if (pick.kind === 'tag') {
    getEd().triggers.acceptTrigger({ ch, pick: { kind: 'ref', to: pick.id, label: pick.name, flavor: '#' } })
  }
}

/** 「最近执行」名单的封顶数（与 `normalizePrefs` 的裁剪一致；两处只此一处语义，改一起改） */
const RECENT_COMMANDS_MAX = 12

/**
 * 记一笔「最近执行」（设备态，不进库）：只认**从面板成功执行**的命令——
 * 失败与「未处理」不进名单。最新在前、去重、封顶；名单只是面板顶部的「再来一次」。
 */
function noteRecentCommand(name: string): void {
  const prev = prefs().recentCommands ?? []
  if (prev[0] === name) return
  prefs().recentCommands = [name, ...prev.filter((n) => n !== name)].slice(0, RECENT_COMMANDS_MAX)
  scheduleDeviceSave()
}

/**
 * 这一次菜单的上下文。
 *
 * 有 target 且来自记录面时，块级键从 target 块现算，光标／选区／提及一律置空
 * （记录面没有这些东西）。编辑器面的 target 不重算：右键前光标已落进那块，
 * 活动编辑器的 ctx 就是它。
 */
function menuCtxOf(req: MenuRequest): CtxKeys {
  const base = req.ctx ?? uiCtx()
  if (!req.target || req.target.surface !== 'record') return base
  const b = findInForest(ws.blocks, req.target.blockId)
  if (!b) return base
  return {
    ...base,
    ...blockMenuCtxOf(b, ws.blocks, {
      isDocRoot: false,
      isForestRoot: ws.blocks.some((x) => x.id === b.id),
    }),
    // 记录面没有光标/选区/提及命中：这些键必须压成「没有」，不能借正文那一刻的状态
    blockSelection: false,
    blockSelectionCount: 0,
    selectionEmpty: true,
    selectionCount: 0,
    selectionRef: false,
    mentionHit: false,
  }
}

/** 这一行能在这个表面执行吗：`actsOn` 分域（子菜单行读自己的 `actsOn`）。 */
function rowAllowed(b: Binding, surface: MenuTarget['surface'] | undefined): boolean {
  if (surface !== 'record') return true
  const actsOn: ActsOn =
    b.actsOn ?? (b.command ? (getRegistry().decl(b.command)?.actsOn ?? 'editor') : 'editor')
  return actsOn === 'block'
}

/**
 * 把菜单的目标块盖进每一行 args。
 *
 * **行自带的 args 优先**：露面的两行（「移除这次露面」）要指露面块，而不是被右键的源块。
 * 命令因此永远拿到显式目标，不再从「活动编辑器的光标」猜。
 */
function stampTarget(row: Row, target: MenuTarget | undefined): Row {
  if (!target) return row
  const own =
    row.args && typeof row.args === 'object' && !Array.isArray(row.args)
      ? (row.args as Record<string, unknown>)
      : {}
  return { ...row, args: { blockId: target.blockId, ...own } }
}

function showMenu(req: MenuRequest): void {
  /**
   * 别的菜单取代检索浮层时把状态清掉：`openMenu` 换掉旧浮层不会回调 `onClose`，
   * 留着 `triggerCh` 会让下一次按键去改一个已经不在的浮层。
   */
  triggerCh = null
  if (req.kind === 'palette') {
    const ctx = req.ctx ?? uiCtx()
    // 空查询带「最近执行」段、有查询词收起——收放判据在 `paletteRows`，这里只传话
    const buildRows = (q: string): Row[] =>
      paletteRows(getRegistry().list(), keyHints(), {
        recents: prefs().recentCommands,
        query: q,
        extra: automationPaletteRows(),
      })
    layers.openMenu({
      rows: buildRows(''),
      anchor: null,
      title: req.title ?? t('menu.title.palettePlain'),
      searchable: true,
      focusSearch: true,
      placeholder: t('ui.palette.placeholder'),
      emptyText: t('ui.palette.empty'),
      onQuery: (q) => layers.setRows(buildRows(q)),
      onPick: (row) => {
        if (!row.command) return
        const r = getRegistry().invoke(row.command, (row.args as Record<string, unknown>) ?? {}, 'palette', ctx)
        if (r.ok && r.handled) noteRecentCommand(row.command)
      },
    })
    return
  }
  if (req.kind === 'menu') {
    const ctx = menuCtxOf(req)
    const surface = req.target?.surface
    const rows = [
      ...rowsFromBindings(
        resolveBindings('menu', ctx, { prefix: req.prefix }).filter((b) => rowAllowed(b, surface)),
        keyHints(),
      ).map((r) => stampTarget(r, req.target)),
      ...(req.extraRows ?? []).map((r) => stampTarget(r, req.target)),
    ]
    layers.openMenu({
      rows,
      anchor: req.anchor,
      ...(req.trigger ? { trigger: req.trigger } : {}),
      title: req.title,
      searchable: false,
      focusSearch: false,
      onPick: (row) => {
        /**
         * **子菜单是菜单的结构，不是命令**：带着同一个 target/ctx 再开一层。
         * 写成命令（旧 `core.menu/sub`）会让 handler 去找 DOM 锚点，而记录面没有
         * 编辑器元素可找。锚点沿用父菜单：钻进去是「换一页」，不是另开一张浮层。
         */
        if (row.submenu) {
          showMenu({
            kind: 'menu',
            prefix: row.submenu,
            anchor: req.anchor,
            ...(req.trigger ? { trigger: req.trigger } : {}),
            title: row.label,
            ...(req.target ? { target: req.target } : {}),
          })
          return
        }
        req.before?.()
        if (req.onPick) req.onPick(row, row.command ? getRegistry().decl(row.command) : undefined)
        else if (row.command) getRegistry().invoke(row.command, (row.args as Record<string, unknown>) ?? {}, 'menu', ctx)
      },
    })
    return
  }
  if (req.kind === 'slash') openTrigger('/', req.query ?? '', req.anchor, req.title ?? t('menu.title.slashFilter'))
}


  /** 会话状态的唯一持有者：编辑器事件表与 closeLayers 经它读写（见 TriggerState） */
  const triggerState: TriggerState = {
    get triggerCh() { return triggerCh },
    set triggerCh(v) { triggerCh = v },
    get stageTag() { return stageTag },
    get lastQuery() { return lastQuery },
    set lastQuery(v) { lastQuery = v },
    get lastHit() { return lastHit },
    set lastHit(v) { lastHit = v },
    get dismissed() { return dismissed },
    set dismissed(v) { dismissed = v },
  }

  return { triggers, triggerState, showMenu, openTrigger, refreshSelectionBar, showSelectionRefPicker, toggleColorAxis }
}
