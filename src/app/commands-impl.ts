/**
 * `App` 门面的实现（本体能用什么，命令就能用什么）。
 *
 * **为什么拆成几个工厂**：`App` 有二十来个方法，但它们在「改什么」上差异很大——
 * 页的增删改、视图的皮肤与槽、演示与诊断。混在一个对象里，任何改动都要在一个 200 行的
 * 字面量里找位置（原先就是这样）。拆开后每段只认出自己需要的那几项能力。
 *
 * **装配层仍是唯一拼装点**：本文件不认识 `ws`／`ed`／`registry` 这些全局身份，
 * 只通过参数拿到「读什么、写什么、刷新什么」。库的唯一持有者始终是装配层（门禁 17）。
 *
 * ⚠️ 纪律：这里**不碰 `document`**（59 ：命令不知道 UI）。要聚焦、要滚动、要弹菜单，
 *   一律走注入的能力。
 */
import {
  addParentTag,
  addRole,
  allPropDefs,
  allTags,
  checkAddParent,
  clearValue,
  cyclePathLabels,
  danglingParentIds,
  declareField,
  declaredFieldIds,
  ensureTag,
  ensureFirstBlock,
  findInForest,
  findPath,
  flatten,
  FEED_INITIAL,
  hasRole,
  renameBlock,
  isJournal,
  journalDate,
  journalFeedDays,
  journalId,
  mkBlock,
  mkJournalBlock,
  mkPropDef,
  normalizeAlias,
  parentTagIds,
  propKindOf,
  propLabel,
  pruneParentTags,
  removeParentTag,
  setValue,
  undeclareField,
  removeBlock,
  shiftISO,
  todayISO,
  type AtomKind,
  type Block,
} from '../core/index.ts'

/**
 * 编辑器装载的根集合：**只有「当前对象」自己一行**，它的子块**缩进挂在它下面**（2026-10-20）。
 *
 * zoom 的形状：
 * ```
 *   May 3rd, 2026 › 1      ← 面包屑（祖先链）
 *   • 2                    ← 被聚焦的块，正文第一行
 *   │  • 4                 ← 它的子块，缩进在它下面
 * ```
 *
 * ⚠️ **不是** `[b, ...b.children]`（那是把子块拉成兄弟，会显示成两棵树）。
 * ⚠️ 但也不能直接把 `b` 放进编辑器：那样 `syncActivePage` 写回时
 *   `p.children = roots` 会把「b 自己」塞进 b 的 children（自环）。
 *   所以给 b 一个**浅拷贝、children 用同一批子块**——子块照常缩进渲染，
 *   写回时再靠 `syncActivePage` 剥掉首行。
 */
/**
 * 落点归一到「**装哪个根**」：`rootsFor(p)` 是唯一规则（块自己就是根，不再拷子树）。
 *
 * ⚠️ 早先 journal 单独走「只装子块」：日期行只读、光标无处可落，于是直接把日期行丢掉。
 *    代价是**日记块自己不在 DOM 里**——它作为当前对象时 `data-depth=0`，没有日期就
 *    等于「一屏不知道是哪一天」，聚焦之后也一样（`rootsFor` 是打开页与聚焦共用的同一条规则）。
 *    现在与页同口径：**块自己是第一行**（journal 渲染成只读日期行），子块缩进挂在下面；
 *    「打得开却打不了字」由 `ensureFirstBlock` 管——空 journal 补一个可编辑子块，
 *    光标的落点由 `focusFirstBlock` 跳过只读行。
 */
export function rootsFor(block: Block): Block[] {
  if (isJournal(block)) ensureFirstBlock(block.children)
  return [block]
}

/**
 * **一列真实的根**：日记流／查询列表／多页并排。
 * 现在 block store 是唯一真相：这里返回**活引用**，不是浅拷贝；编辑直接写 store。
 */
export function rootsForMany(blocks: readonly Block[]): Block[] {
  return blocks.slice()
}

/**
 * **打开一个落点时该装哪些根** —— 打开页／聚焦块／历史回放**共用这一条**。
 *
 * 判据：落点是**今天的 journal** ⇒ 装**日记流**（今日在顶 ＋ 更早存在的天）；
 *       否则就是「这块自己 ＋ 它的子树」。
 *
 * 为什么非得抽出来：这条规则**曾经只在「打开页」里有**。历史回放走的是另一条路
 * （`historyGo` → `zoomTo` → `open()`），那里只 `rootsFor` 装单块 ⇒ 在日记流里
 * zoom 进某一天、再按「后退」，回到的不是 feed 而是一个孤立的天（**QB-002**）。
 * 两条路各写一份，改了一边就会漏另一边 —— 这类分叉必须收成一处。
 *
 * ⚠️ **今天是一个「入口」，不是一个普通的块**：左槽里的「Daily note」、
 * 冷启动、「回今日」，指的都是同一件事。
 * ⚠️ 历史里的**其它**日记天仍走单日（左槽只有「今天」这一个入口）。
 */
export function rootsForTarget(target: Block, blocks: readonly Block[]): Block[] {
  const feed = isJournal(target) && journalDate(target) === todayISO() ? journalFeedDays(blocks, todayISO(), FEED_INITIAL) : null
  return feed ? rootsForMany(feed) : rootsFor(target)
}
import { demoState } from '../core/seed.ts'
import { DEFAULT_PREFS, type ThemeMode, type Workspace } from '../core/workspace.ts'
import { t, type MsgId } from '../core/msg.ts'
import { nextTheme } from '../core/theme.ts'
import type { App, DemoState } from '../core/ports.ts'
import type { Row } from '../ui/layers.ts'

/* ═══════════════════════════════════════════════════════ 页 */

/** 一个空页块：正文为空、图标是系统属性 `_icon` */
export function makePageBlock(): Block {
  const b = mkBlock('')
  addRole(b, 'page')
  b.props = { ...(b.props ?? {}), _icon: 'lucide:file' }
  return b
}

/**
 * 冲突块在提示里怎么称呼。
 *
 * 只到「页／标签」这一层，不做面包屑：`[[ ]]` 打出去的名字撞的是**名字空间**里
 * 的那个块，用户要判断的是「我是不是想引用那个页」，知道它是页还是标签就够了。
 *
 * 导出给装配层：编辑器在编辑边界上拒绝一次改名时，提示要说清「撞的是哪种块」——
 * 同一句话两处拼，措辞就会分叉。
 */
export function takenWhere(b: Block): string {
  if (hasRole(b, 'page')) return t('ui.where.page')
  if (hasRole(b, 'tag')) return t('ui.where.tag')
  return t('ui.where.block')
}

export interface PageDeps {
  /** 读块森林（**返回的是活引用**，push/splice 直接生效） */
  blocks: () => Block[]
  /** 读回收站（同样是活引用）：删页是「摘进回收站」，不是抹掉 */
  trash: () => Block[]
  /**
   * 插行内原子（打标签用）。
   *
   * ⚠️ 为什么注入的是**一个函数**而不是 `editor` 对象本身：活动编辑器是会变的
   *    （正文 vs 反链 footer），注入对象会在切换后指向旧实例；注入函数每次取当前的。
   * ⚠️ 它必须落到**共享 store**，否则别的视图（反链/查询）看不到这条边。
   */
  insertAtom: (kind: AtomKind, opts: Parameters<App['ed']['insertAtom']>[1]) => string | null
  /**
   * 把正文里的一段区间换成一条标签边（敲 `#名字` 的成边路径）。
   *
   * 与 `insertAtom` 分开注入，是因为两者是**不同的动作**：
   * 一个在光标处插入一格，一个把已经写好的字换成那一格。
   */
  linkTagRange: (blockId: string, from: number, to: number, label: string, targetId: string) => string | null
  activeId: () => string
  setActiveId: (id: string) => void
  /** 把某页的子树装进编辑器（marks/atoms 是库级平铺） */
  loadPage: (roots: Block[], marks: unknown[], atoms: unknown[]) => void
  marks: () => unknown[]
  atoms: () => unknown[]
  /** 切页前把编辑器里的内容写回当前页 + 立即持久化 */
  flush: () => void
  saveNow: () => void
  scheduleSave: () => void
  /** 刷新左槽（页块列表）与顶栏页名——由装配层决定用哪个组件 */
  refreshList: () => void
  refreshTitle: () => void
  /** 把光标放到当前页首块 */
  focusFirstBlock: () => void
  toast: (text: string, kind?: 'ok' | 'warn' | 'info') => void
  /** 打开引用选择器：装配层负责把它渲染成菜单 */
  openRefPicker: (rows: Row[]) => void
  pageTitle: (b: Block) => string
  pageIcon: (b: Block) => string
}

/** 页命令（页名＝块正文，所以「改名」就是改块） */
export function pageCommands(d: PageDeps): Pick<
  App,
  | 'listPages'
  | 'activePageId'
  | 'newPage'
  | 'openPage'
  | 'deletePage'
  | 'renamePage'
  | 'focusTitle'
  | 'showRefPicker'
  | 'insertTag'
> {
  const count = (p: Block): number => flatten({ roots: p.children }).length
  /**
   * 「页」＝任何带 `page` 角色的块（**不要求顶层**）：角色是机制位，不是容器位置。
   * journal 也是一块，但它不是页（「一天一个」）⇒ 混进来会让页数/上一页下一页说不清。
   */
  const pages = (): Block[] => flatten({ roots: d.blocks() }).filter((p) => hasRole(p, 'page'))

  return {
    // ⚠️ **只列 `page` 角色**：journal 也是一块，但它不是「页」的不变量是「一天一个」），
    //    混进来会让「页数」「下一页」这类语义变成说不清的数。
    listPages: () => pages().map((p) => ({ id: p.id, title: d.pageTitle(p), icon: d.pageIcon(p), blocks: count(p) })),
    activePageId: () => d.activeId(),

    newPage: () => {
      const p = makePageBlock()
      d.blocks().push(p)
      d.setActiveId(p.id)
      // 新页必须是**可编辑的**：给它一个空子块（否则「新建页面」后打不了字）
      d.loadPage(rootsFor(p), d.marks(), d.atoms())
      d.refreshList()
      d.refreshTitle()
      d.saveNow()
      d.focusFirstBlock()
    },

    openPage: (id) => {
      // 页可以嵌在别的块下面（角色不要求顶层）⇒ 整片森林里找，不只看顶层
      const p = findInForest(d.blocks(), id)
      if (!p) return
      d.flush()
      /**
       * **今天**是一个「入口」，不是一个普通的块：从左槽点它 = **回今日日记流**，
       * 与冷启动 / 「回今日」同一条规则（今日在顶，更早存在的天往下）。
       * 只装这一天会把日记流收成一段 —— 用户点的明明是「Daily note」这个入口。
       * ⚠️ 历史里的其它日记天仍走单日（左槽只有「今天」这一个入口）。
       */
      /**
       * ⚠️ 落到**今天** ⇒ 当前对象是**今天这一块**（不是流的第一段）。
       *    库里若留着更早的未打开的一天（它不是今天），「回今日」却停在昨天，落点很怪。
       *    装载顺序由 `rootsForTarget` 负责（今日在顶 ＋ 存在的更早的天）。
       */
      d.setActiveId(isJournal(p) && journalDate(p) === todayISO() ? journalId(todayISO()) : id)
      d.loadPage(rootsForTarget(p, d.blocks()), d.marks(), d.atoms())
      d.refreshList()
      d.refreshTitle()
      d.saveNow()
    },

    deletePage: (id) => {
      const before = pages()
      // 「至少留一页」只数**页**（journal 不是页，删掉它不违反这条）
      if (before.length <= 1) {
        d.toast(t('ui.toast.keepOnePage'), 'warn')
        return
      }
      const i = before.findIndex((p) => p.id === id)
      if (i < 0) return
      removeBlock({ roots: d.blocks(), trash: d.trash() }, id)
      // 落点必须是**页**（删的可能是 journal，邻位也可能是 journal）
      const rest = pages()
      const p = rest[Math.min(i, rest.length - 1)] ?? rest[0]
      if (p) {
        d.setActiveId(p.id)
        d.loadPage(rootsFor(p), d.marks(), d.atoms())
      }
      d.refreshList()
      d.refreshTitle()
      d.saveNow()
      d.toast(t('ui.toast.pageDeleted'))
    },

    renamePage: (id, title) => {
      const p = findInForest(d.blocks(), id)
      if (!p) return
      // ：journal 的「标题」是日期的只读投影（来自 `_date`），改不了
      if (isJournal(p)) {
        d.toast(t('ui.toast.journalReadonly'), 'warn')
        return
      }
      // 撞名就**停在原地**：地址是引用能落到哪儿的唯一依据，两个块同地址等于
      // 其中一个从此引用不到。拒绝之后列表与标题都按库里的旧名字重画，
      // 让界面立刻回到「这次没改成功」的样子，而不是留着一个假装改了的标题。
      const r = renameBlock(d.blocks(), p, title)
      if (!r.ok) {
        d.toast(t('ui.toast.nameTaken', { name: title, where: takenWhere(r.conflict) }), 'warn')
        if (p.id === d.activeId()) d.refreshTitle()
        d.refreshList()
        return
      }
      if (p.id === d.activeId()) d.refreshTitle()
      d.refreshList()
      d.scheduleSave()
    },

    /** ：没有页标题输入框 ⇒ 焦点交给页块正文的首块 */
    focusTitle: () => d.focusFirstBlock(),

    /**
     * **打标签**＝插一条指向标签块的边。
     *
     * 两步一次做完（「找到或创建标签块」＋「插原子」），中间不留半截状态：
     * 只建块没插边 ⇒ 库里多一个没人引用的标签；只插边没建块 ⇒ 边指着不存在的目标。
     *
     * **两种入口，同一条实现**：
     *   · 命令 / 选择器：在**光标处插入**一格（`replace` 省略）；
     *   · 正文里敲出 `#名字`：把**已经写好的那几个字**换成那一格（传 `replace`）。
     *
     * ⚠️ 空名字直接拒绝（不建无名标签）：没有名字的标签没有身份，建了就是孤儿。
     * ⚠️ 建了新标签要 `refreshList` ＋ `scheduleSave`：森林变了，且这是要落盘的内容。
     */
    insertTag: (tag, replace) => {
      const { block, created, reused } = ensureTag(d.blocks(), tag)
      if (!block) {
        d.toast(t('ui.toast.tagEmpty'), 'warn')
        return
      }
      const target = { kind: 'page' as const, id: block.id }
      const ok = replace
        ? d.linkTagRange(replace.blockId, replace.from, replace.to, block.text, block.id)
        : d.insertAtom('tag', { label: block.text, target })
      if (!ok) return
      if (created) {
        d.refreshList()
        d.toast(t('ui.toast.tagCreated', { tag: block.text }))
      } else if (reused) {
        // 同名块已存在 ⇒ 复用它并加 tag 角色。**必须让用户看见**，否则这是一次静默的模型改动
        d.refreshList()
        d.toast(t('ui.toast.tagReused', { tag: block.text }), 'info')
      } else {
        d.toast(t('ui.toast.tagAdded', { tag: block.text }))
      }
      d.scheduleSave()
    },

    showRefPicker: () => {
      const rows: Row[] = d.blocks().map((p) => ({
        id: `pick/${p.id}`,
        label: d.pageTitle(p).trim() === '' ? t('ui.page.untitled') : d.pageTitle(p),
        hint: t('ui.refPicker.blocks', { count: count(p) }),
        icon: d.pageIcon(p),
        group: 'pick/1',
        command: 'core.editor/insert-page-ref',
        args: { pageId: p.id },
      }))
      d.openRefPicker(rows)
    },
  }
}

/* ═══════════════════════════════════════════════════════ 日记 */

/**
 * 日记（日记流）。
 *
 * 两种形态，共用「先幂等物化，再打开」：
 *   · **日记流**（`journalToday`／冷启动）：`date` 在顶，更早的「存在的天」按 `_date` 降序往下；
 *   · **单日**（`journalShift`／左槽打开某天）：只装那一天。
 *
 * · **幂等**：id 由 `(本地日)` 确定性派生（`journalId`）⇒ 「一天一个」是结构保证，
 *   不靠扫描去重；并发/多设备打开同一天会拿到同一个 id。
 * · **只读**：日期只进 `_date`，不进 `text`；这里没有任何写 `_date` 的分支。
 * · **不引入焦点栈**：翻日/回流只是把中心槽的「当前对象」换一块或换一串（同口径）。
 */
export function journalCommands(d: PageDeps): Pick<App, 'journalToday' | 'journalShift'> {
  /** 幂等物化：库里没有这一天的块才创建（排在最前，`forest()` 的 `blocks[0]` 即冷启动默认内容） */
  const ensure = (date: string): string => {
    const id = journalId(date)
    if (!d.blocks().some((b) => b.id === id)) d.blocks().unshift(mkJournalBlock(date))
    return id
  }

  /** 打开一个块（与 `openPage` **同一条**装载规则：落到今天 ⇒ 日记流） */
  const openBlock = (id: string): void => {
    d.flush()
    const b = d.blocks().find((x) => x.id === id)
    // 全新的一天还没有任何子块 ⇒ 先归一：journal 的首行是**只读日期**，
    // 没有子块就**没有任何地方可以落光标**（打不了字）
    if (b) ensureFirstBlock(b.children)
    /**
     * ⚠️ 「哪一天是当前对象」由**日期**决定，不由装载顺序决定：
     *    日期块自己的 `id` 就是它的身份，`setActiveId` 必须拿它的 id
     *    （按「流的第一段」去设在库里留着更早的未打开天时会把人送到那一天）。
     */
    d.setActiveId(id)
    d.loadPage(b ? rootsForTarget(b, d.blocks()) : [], d.marks(), d.atoms())
    d.refreshList()
    d.refreshTitle()
    d.saveNow()
    // ⚠️ 与 `openPage` 的差异：那里不落光标（用户是从左槽点进来的，焦点归点击），
    //    这里**要落光标**——用户刚按了「翻日／回今日」，落点就该是正文首块。
    d.focusFirstBlock()
  }

  /**
   * 打开**日记流**：`date` 在顶、更早的「存在的天」往下。
   *
   * ⚠️ 只取森林里**存在的** journal 块（`journalFeedDays`），不按日历逐天生造空天。
   * ⚠️ 每个加载的天都要 `ensureFirstBlock`：日期行只读，没有子块就「打得开却打不了字」。
   */
  const openFeed = (date: string): void => {
    d.flush()
    const anchorId = ensure(date)
    const days = journalFeedDays(d.blocks(), date, FEED_INITIAL)
    for (const day of days) ensureFirstBlock(day.children)
    /**
     * ⚠️ 「回今日」把**今天**设成当前对象，而不是流的**第一段**：库里若留着更早的
     *    未打开的一天（它不是今天），按下「回今日」人却停在昨天，是很怪的落点。
     *    装载顺序不变（`days` 已按日期降序），只是当前对象归今天。
     */
    d.setActiveId(anchorId)
    d.loadPage(rootsForMany(days), d.marks(), d.atoms())
    d.refreshList()
    d.refreshTitle()
    d.saveNow()
    d.focusFirstBlock()
  }

  return {
    journalToday: (date) => {
      const ok = typeof date === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)
      // 「去某一天」＝只打开那一天（选日期是落点，不是筛选）；「回今日」＝今天在顶的日记流
      if (ok) openBlock(ensure(date as string))
      else openFeed(todayISO())
    },
    journalShift: (days) => {
      const b = d.blocks().find((x) => x.id === d.activeId())
      // 从「当前对象」的日期出发；当前不是 journal 就从今天出发（翻日永远有起点）
      const from = b && isJournal(b) ? journalDate(b) : todayISO()
      // 单日模式：翻到相邻的一天（流里的「翻一天」是另一种动作）
      openBlock(ensure(shiftISO(from, days)))
    },
  }
}

/* ═══════════════════════════════════════════════════════ zoom */

/**
 * zoom：**中心槽的「当前对象」从顶层块放宽为任意块**。
 *
 * ⚠️ 与「打开一个页」是**同一条规则的两个实例**：都是「容器 ＋ 它的 children」。
 *   所以这里不新增状态、不新增对象，也没有焦点栈：
 *   · 面包屑＝`findPath(森林, 当前对象)` 去掉末尾（**派生**，承 15 E1 的 parent 链）；
 *   · 退回＝把当前对象换成祖先（与 zoom in **同一个动作**，只是目标不同）。
 * ⚠️ zoom **不跟随**左右槽（它们的内容显式钉住）。
 */
export function zoomCommands(d: PageDeps): Pick<App, 'zoomTo' | 'zoomOut'> {
  /** 把中心槽指向任意块（在**整片森林**里找，不只是顶层） */
  const open = (id: string): void => {
    d.flush()
    d.setActiveId(id)
    const b = findInForest(d.blocks(), id)
    /**
     * ⚠️ 装载规则与「打开页」**同一条**（`rootsForTarget`）：
     *    落到今天 ⇒ 装日记流；否则装这一块自己。
     *    少了这层，历史回放会把「日记流」收成一个孤立的天（**QB-002**）。
     */
    d.loadPage(b ? rootsForTarget(b, d.blocks()) : [], d.marks(), d.atoms())
    d.refreshList()
    d.refreshTitle()
    d.saveNow()
    d.focusFirstBlock()
  }

  return {
    zoomTo: (id) => {
      const b = findInForest(d.blocks(), id)
      if (!b) return
      /**
       * 叶子块也能 zoom：`scope: subtree` **含块自身**，叶子就是「只看这一块」——
       * 若叶子不给 zoom，点击行为会**时 zoom 时不 zoom**，用户没法预测一次点击的结果。
       */
      open(id)
    },
    zoomOut: () => {
      const path = findPath(d.blocks(), d.activeId())
      // 已经是最外层（页 / journal 本身就是顶层块）⇒ 没有可退的
      if (!path || path.length <= 1) return
      open(path[0]!.id)
    },
  }
}

/* ═══════════════════════════════════════════════════════ 视图 */

export interface ViewDeps {
  /** 可直接改的偏好（装配层持有） */
  prefs: () => { theme: ThemeMode; dock: { left: { open: boolean }; right: { open: boolean } } }
  applyChrome: () => void
  /** 主题变了要重画的东西（顶栏开关撤掉后＝重画调试菜单的勾选） */
  renderDebugState: () => void
  scheduleSave: () => void
  scheduleBadge: () => void
  toast: (text: string, kind?: 'ok' | 'warn' | 'info') => void
}

export function viewCommands(d: ViewDeps): Pick<App, 'setTheme' | 'toggleTheme' | 'toggleDock'> {
  return {
    /**
     * 三档**直选**（不是循环切换）。
     * 原来只有 `toggle-theme`（循环），那是给一个常驻按钮用的；
     * 顶栏开关撤掉后改由菜单三选一 ⇒ 必须能直接落到某一档。
     */
    setTheme: (mode) => {
      const m = (['system', 'light', 'dark'] as ThemeMode[]).includes(mode as ThemeMode) ? (mode as ThemeMode) : 'system'
      d.prefs().theme = m
      d.applyChrome()
      d.renderDebugState()
      d.scheduleSave()
      d.scheduleBadge()
    },

    toggleTheme: () => {
      d.prefs().theme = nextTheme(d.prefs().theme)
      d.applyChrome()
      d.renderDebugState()
      d.scheduleSave()
      d.scheduleBadge()
    },

    /** 槽的开关归槽自己：`⌘⌥1/2` 与抬头按钮走同一条 */
    toggleDock: (side) => {
      const slot = d.prefs().dock[side]
      slot.open = !slot.open
      d.applyChrome()
      d.scheduleSave()
      d.scheduleBadge()
    },
  }
}

/* ═══════════════════════════════════════════════════════ 演示与诊断 */

export interface DemoDeps {
  /**
   * 换掉整个库。⚠️ 这里是**整体替换**（demo 专用）：新库由装配层接管，
   * 所以用回调而不是返回对象——库的唯一持有者仍是装配层（门禁 17）。
   */
  replaceWorkspace: (next: Workspace) => void
  prefs: () => { theme: ThemeMode }
  setVirtualize: (on: boolean, radius: number) => void
  scheduleSave: () => void
  scheduleBadge: () => void
  toast: (text: string, kind?: 'ok' | 'warn' | 'info') => void
  /** 「组合期命令零触发」自检：派发一次合成按键，返回触发了几个命令 */
  probeComposing: () => number
  compositionSeq: () => string[]
}

const STATE_LABEL: Record<DemoState, MsgId> = {
  seed: 'ui.state.seed',
  empty: 'ui.state.empty',
  sparse: 'ui.state.sparse',
  degraded: 'ui.state.degraded',
  boot: 'ui.state.boot',
}

export function demoCommands(d: DemoDeps): Pick<App, 'loadState' | 'setVirtualize' | 'runImeProbe'> {
  return {
    loadState: (state) => {
      const fresh = demoState(state)
      // 换的是内容，不是外观：保留用户当前的主题档位
      fresh.prefs = { ...DEFAULT_PREFS, ...fresh.prefs, theme: d.prefs().theme }
      d.replaceWorkspace(fresh)
      d.toast(t('ui.toast.stateLoaded', { state: t(STATE_LABEL[state]) }))
    },

    setVirtualize: (on, radius) => {
      const r = typeof radius === 'number' ? radius : 12
      d.setVirtualize(on, r)
      d.scheduleSave()
      d.scheduleBadge()
      d.toast(on ? t('ui.toast.virtOn', { radius: r }) : t('ui.toast.virtOff'))
    },

    runImeProbe: () => {
      const fired = d.probeComposing()
      d.scheduleBadge()
      return { fired, seq: d.compositionSeq() }
    },
  }
}


/* ═══════════════════════════════════════════════════════ 属性 */

/** 属性写入的宿主能力（装配层负责 undo 快照、落盘、重画；这里只做模型判断） */
export interface PropsDeps {
  blocks: () => Block[]
  /** 一次写入：`blockId` 省略＝改了森林结构（例如新建定义块） */
  write: (blockId: string | undefined, mutate: () => void) => void
  toast: (text: string, kind?: 'ok' | 'warn' | 'info') => void
}

export function propsCommands(
  d: PropsDeps,
): Pick<App, 'setPropValue' | 'clearPropValue' | 'createPropDef' | 'addProp' | 'undeclareProp'> {
  const find = (id: string): Block | undefined => findInForest(d.blocks(), id)

  const addProp = (blockId: string, propId: string): void => {
    const b = find(blockId)
    if (!b) return
    // 页/标签声明它（字段可用）；普通块只有值：先放一个空槽，让它出现在属性区
    if (hasRole(b, 'page') || hasRole(b, 'tag')) d.write(blockId, () => declareField(b, propId))
    else d.write(blockId, () => setValue(b, propId, ''))
  }

  return {
    setPropValue: (blockId, propId, value) => {
      const b = find(blockId)
      if (!b) return
      d.write(blockId, () => setValue(b, propId, value))
    },

    clearPropValue: (blockId, propId) => {
      const b = find(blockId)
      if (!b) return
      d.write(blockId, () => clearValue(b, propId))
    },

    /**
     * 新建字段定义。
     *
     * **默认复用**：已有**同名同 kind** 的定义 ⇒ 指向同一个 `propId`，
     * 并显示来源（「已有同名定义（来自 #书）」）；kind 不同或显式新建 ⇒ 新定义。
     * 误复用可改回、误分槽要迁数据 ⇒ 默认选「错了好改」的那一边。
     */
    createPropDef: (blockId, label, kind) => {
      const name = label.trim()
      if (name === '') {
        d.toast(t('ui.props.needLabel'), 'warn')
        return ''
      }
      const k = kind.trim() === '' ? 'text' : kind.trim()
      const existing = allPropDefs(d.blocks()).find(
        (def) => normalizeAlias(propLabel(def)) === normalizeAlias(name) && propKindOf(def) === k,
      )
      let propId = ''
      if (existing) {
        propId = existing.id
        const from = allTags(d.blocks())
          .filter((tag) => declaredFieldIds(tag).includes(propId))
          .map((tag) => `#${tag.text}`)
          .join('、')
        d.toast(t('ui.props.reused', { source: from === '' ? t('ui.props.own') : from }), 'info')
      } else {
        const def = mkPropDef(name, k === 'text' || k === 'number' || k === 'date' || k === 'checkbox' || k === 'select' || k === 'ref' || k === 'url' ? k : 'text')
        d.write(undefined, () => {
          // 定义住在**森林顶层**：不被任何标签子树带走
          d.blocks().push(def)
        })
        propId = def.id
        d.toast(t('ui.props.created', { label: name }))
      }
      if (blockId) addProp(blockId, propId)
      return propId
    },

    addProp,

    undeclareProp: (blockId, propId) => {
      const b = find(blockId)
      if (!b) return
      d.write(blockId, () => undeclareField(b, propId))
    },
  }
}


/* ═══════════════════════════════════════════════════════ 标签层级 */

/** 标签归属写入的宿主能力 */
export interface TagTreeDeps {
  blocks: () => Block[]
  write: (blockId: string | undefined, mutate: () => void) => void
  toast: (text: string, kind?: 'ok' | 'warn' | 'info') => void
  shortId: (id: string) => string
}

export function tagTreeCommands(
  d: TagTreeDeps,
): Pick<App, 'addTagParent' | 'removeTagParent' | 'pruneTagParents'> {
  const find = (id: string): Block | undefined => findInForest(d.blocks(), id)

  return {
    /**
     * 加一条「child 属于 parent」。
     *
     * 两个入口（子标签的「属于」、父标签的「包含」）**写的是同一处**：
     * `child._parentTags`。成环在写入前拒绝，并给出循环路径。
     */
    addTagParent: (childId, parentId) => {
      const child = find(childId)
      const parent = find(parentId)
      if (!child || !parent) return false
      const check = checkAddParent(child, parent, d.blocks())
      if (!check.ok) {
        if (check.reason === 'cycle') {
          const path = cyclePathLabels(check.path ?? [], d.blocks(), d.shortId).join(' → ')
          d.toast(t('ui.tagpanel.cycle', { path }), 'warn')
        } else if (check.reason === 'self') d.toast(t('ui.tagpanel.self'), 'warn')
        else if (check.reason === 'duplicate') d.toast(t('ui.tagpanel.duplicate'), 'info')
        return false
      }
      d.write(childId, () => addParentTag(child, parent, d.blocks()))
      d.toast(t('ui.tagpanel.added', { child: child.text, parent: parent.text }))
      return true
    },

    removeTagParent: (childId, parentId) => {
      const child = find(childId)
      if (!child || !parentTagIds(child).includes(parentId)) return
      d.write(childId, () => removeParentTag(child, parentId))
    },

    pruneTagParents: (childId) => {
      const child = find(childId)
      if (!child || danglingParentIds(child, d.blocks()).length === 0) return
      let n = 0
      d.write(childId, () => {
        n = pruneParentTags(child, d.blocks())
      })
      if (n > 0) d.toast(t('ui.tagpanel.pruned', { count: n }))
    },
  }
}
