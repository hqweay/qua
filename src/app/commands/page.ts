/**
 * 页命令：页是一块，所以「新建 / 打开 / 改名 / 删」全是块的增删改。
 */
import {
  addTagId,
  displayNameOf,
  ensureTag,
  findInForest,
  flatten,
  hasList,
  hasTag,
  isJournal,
  journalDate,
  journalId,
  removeBlock,
  renameBlock,
  todayISO,
  type Block,
} from '../../core/index.ts'
import { t } from '../../core/msg.ts'
import type { App } from '../../core/ports.ts'
import type { Row } from '../../ui/layers.ts'
import { makePageBlock, rootsFor, rootsForTarget, takenWhere } from './roots.ts'
import type { PageDeps } from './types.ts'

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
  const pages = (): Block[] => flatten({ roots: d.blocks() }).filter((p) => hasList(p, 'page'))

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
      const isTodayEntry = isJournal(p) && journalDate(p) === todayISO()
      d.setActiveId(isTodayEntry ? journalId(todayISO()) : id, { feed: isTodayEntry })
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
     * **打标签＝给这一块加一格分类**（`props._tags`）。
     *
     * 两步一次做完（「找到或创建标签块」＋「写进块的归属」），中间不留半截状态：
     * 只建块没写归属 ⇒ 库里多一个没人用的标签；只写归属没建块 ⇒ 归属指向不存在的 id。
     *
     * ⚠️ 标签标的是**整个块**，不是光标处那一格 —— 所以落点是「当前块」，
     *    与光标在块内的哪个位置无关。要在句子里指某个东西，用引用（`[[ ]]`）。
     * ⚠️ 空名字直接拒绝（不建无名标签）：没有名字的标签没有身份，建了就是孤儿。
     * ⚠️ 建了新标签要 `refreshList`：森林变了，左槽的标签清单要跟着更新。
     */
    insertTag: (tag) => {
      const hostId = d.caretBlockId()
      const host = hostId ? findInForest(d.blocks(), hostId) : undefined
      if (!host) return
      const { block, created, reused } = ensureTag(d.blocks(), tag)
      if (!block) {
        d.toast(t('ui.toast.tagEmpty'), 'warn')
        return
      }
      if (hasTag(host, block.id)) {
        d.toast(t('ui.toast.tagAlready', { tag: displayNameOf(block) }), 'info')
        return
      }
      d.write(host.id, () => {
        addTagId(host, block.id)
      })
      if (created) {
        d.refreshList()
        d.toast(t('ui.toast.tagCreated', { tag: displayNameOf(block) }))
      } else if (reused) {
        // 同名块已存在 ⇒ 复用它并加 tag 露面。**必须让用户看见**，否则这是一次静默的模型改动
        d.refreshList()
        d.toast(t('ui.toast.tagReused', { tag: displayNameOf(block) }), 'info')
      } else {
        d.toast(t('ui.toast.tagAdded', { tag: displayNameOf(block) }))
      }
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
