/**
 * 页命令：页是一块，所以「新建 / 打开 / 改名 / 删」全是块的增删改。
 */
import {
  aliasesOf,
  DISPLAY_PROP,
  displayNameOf,
  FEED_INITIAL,
  flatten,
  hasList,
  hasTag,
  EMBED_PROP,
  EMBED_TYPE,
  isEmbedBlock,
  isJournal,
  isPropDefBlock,
  isQueryBlock,
  journalDate,
  journalId,
  listsOf,
  mkBlock,
  mkPageBlock,
  plainText,
  primaryAliasOf,
  prop,
  tagIdsOf,
  setBlockType,
  todayISO,
  uuidv7Hex,
  writeRename,
  type Block,
} from '../../core/index.ts'
import { ensureTagInTx } from '../../core/kb/ensure-tag.ts'
import { FEED_SPEC } from '../../core/feed.ts'
import { t } from '../../core/msg.ts'
import type { App } from '../../core/ports.ts'
import type { Row } from '../../ui/layers.ts'
import { rootsFor, rootsForMany, takenWhere } from './roots.ts'
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
  | 'showEmbedPicker'
  | 'insertTag'
  | 'extractToPage'
> {
  // 子块数：只数 p 的后代（不含 p 自己），与「页里有多少行」的口径一致
  const count = (p: Block): number => {
    let n = 0
    const walk = (b: Block): void => {
      n++
      b.children.forEach(walk)
    }
    p.children.forEach(walk)
    return n
  }
  /**
   * 「页」＝任何带 `page` 露面的块（**不要求顶层**）：露面位是机制位，不是容器位置。
   * journal 也是一块，但它不是页（「一天一个」）⇒ 混进来会让页数/上一页下一页说不清。
   * 清单是**命名的库读**（`kb.pages`），调用方不扫森林。
   */
  const pages = (): readonly Block[] => d.kb.pages()

  return {
    // ⚠️ **只列 `page` 露面**：journal 也是一块，但它不是「页」的不变量是「一天一个」），
    //    混进来会让「页数」「下一页」这类语义变成说不清的数。
    listPages: () => pages().map((p) => ({ id: p.id, title: d.pageTitle(p), icon: d.pageIcon(p), blocks: count(p) })),
    activePageId: () => d.activeId(),

    newPage: () => {
      /**
       * 页块**自带空首子块**（`mkPageBlock`），整棵子树同一笔插进库：
       * 「新建页」是一次结构写，必须产 op——直接 `blocks().push` 的页换库后没有行可落，
       * 重开就丢了；拆成「先建页、打开再补子块」则会存在只有页没处写字的半截状态。
       *
       * **落点是森林顶层**：页是长寿命对象，不是「某天发生的一件事」——它的诞生时刻
       * 已经由 `created` 记着，不需要再挂到那一天下面。记录仍落当天（`core/obj.ts`）。
       */
      const p = mkPageBlock()
      d.insertBlock(p, null, d.kb.roots().length)
      d.setActiveId(p.id)
      d.loadPage(rootsFor(p))
      d.refreshList()
      d.refreshTitle()
      d.saveNow()
      d.focusFirstBlock()
    },

    openPage: (id) => {
      // 页可以嵌在别的块下面（露面位不要求顶层）⇒ 整库按 id 解析，不只看顶层
      const p = d.kb.get(id)
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
       *    装载顺序由一份 QuerySpec 字面量负责（今日在顶 ＋ 存在的更早的天）。
       */
      const isTodayEntry = isJournal(p) && journalDate(p) === todayISO()
      d.setActiveId(isTodayEntry ? journalId(todayISO()) : id, { feed: isTodayEntry })
      const feedDays = isTodayEntry
        ? d
            .kb.query({ ...FEED_SPEC, limit: FEED_INITIAL })
            .map((h) => d.kb.get(h.blockId))
            .filter((b): b is Block => b !== undefined)
        : []
      d.loadPage(isTodayEntry ? rootsForMany(feedDays) : rootsFor(p))
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
      d.removeBlock(id)
      // 落点必须是**页**（删的可能是 journal，邻位也可能是 journal）
      const rest = pages()
      const p = rest[Math.min(i, rest.length - 1)] ?? rest[0]
      if (p) {
        d.setActiveId(p.id)
        d.loadPage(rootsFor(p))
      }
      d.refreshList()
      d.refreshTitle()
      d.saveNow()
      d.toast(t('ui.toast.pageDeleted'))
    },

    renamePage: (id, title) => {
      const p = d.kb.get(id)
      if (!p) return
      // ：journal 的「标题」是日期的只读投影（来自 `_date`），改不了
      if (isJournal(p)) {
        d.toast(t('ui.toast.journalReadonly'), 'warn')
        return
      }
      // 撞名就**停在原地**：地址是引用能落到哪儿的唯一依据，两个块同地址等于
      // 其中一个从此引用不到。判据与 `claimAlias` 同一份（`kb.resolveAlias` 就是
      // 「这个地址现在归谁」）；拒绝之后列表与标题都按库里的旧名字重画，
      // 让界面立刻回到「这次没改成功」的样子，而不是留着一个假装改了的标题。
      const hit = d.kb.resolveAlias(title)
      if (hit && hit.id !== p.id) {
        d.toast(t('ui.toast.nameTaken', { name: title, where: takenWhere(hit) }), 'warn')
        if (p.id === d.activeId()) d.refreshTitle()
        d.refreshList()
        return
      }
      d.write(id, () => writeRename(p, primaryAliasOf(p), title))
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
     * 建标签块与写归属**同一笔事务**（与编辑器打行内标签同形）：名字解析走读门面
     * （`ensureTagInTx` 的窄口），创建经 `tx.insert` —— 产 op，换库不丢。
     *
     * ⚠️ 标签标的是**整个块**，不是光标处那一格 —— 所以落点是「当前块」，
     *    与光标在块内的哪个位置无关。要在句子里指某个东西，用引用（`[[ ]]`）。
     * ⚠️ 空名字直接拒绝（不建无名标签）：没有名字的标签没有身份，建了就是孤儿。
     * ⚠️ 建了新标签要 `refreshList`：森林变了，左槽的标签清单要跟着更新。
     */
    insertTag: (tag) => {
      const hostId = d.caretBlockId()
      const host = hostId ? d.kb.get(hostId) : undefined
      if (!host) return
      // 这名字此刻有没有主：决定 toast 是「新建」还是「复用」（判据与 ensureTag 同一份）
      const wasTag = d.kb.findTag(tag) !== undefined
      const wasAddress = wasTag || d.kb.resolveAlias(tag) !== undefined
      // 找到或创建 ＋ 写归属，**同一笔事务**（与编辑器打行内标签同形）：
      // 拆开就会留下「只有标签、没有归属」或「归属指向不存在 id」的半批
      const r = d.run((tx) => {
        const block = ensureTagInTx(d.kb, tag, tx)
        if (!block) return null
        if (hasTag(host, block.id)) return { block, tagged: false }
        tx.setTags(host.id, [...tagIdsOf(host), block.id])
        return { block, tagged: true }
      }).result
      if (!r) {
        d.toast(t('ui.toast.tagEmpty'), 'warn')
        return
      }
      if (!r.tagged) {
        d.toast(t('ui.toast.tagAlready', { tag: displayNameOf(r.block) }), 'info')
        return
      }
      if (!wasAddress) {
        d.refreshList()
        d.toast(t('ui.toast.tagCreated', { tag: displayNameOf(r.block) }))
      } else if (!wasTag) {
        // 同名块已存在 ⇒ 复用它并加 tag 露面。**必须让用户看见**，否则这是一次静默的模型改动
        d.refreshList()
        d.toast(t('ui.toast.tagReused', { tag: displayNameOf(r.block) }), 'info')
      } else {
        d.toast(t('ui.toast.tagAdded', { tag: displayNameOf(r.block) }))
      }
    },

    /**
     * **提取为页**：把一块（连子树）搬到森林顶层，补 `page` 露面，并在原位置留一枚引用。
     *
     * 与 `标记为页` 的区别在**位置**：那条只动露面、原地不动；这条是显式点名
     * 「把它提成独立页」，所以连带搬家。原块 id 不变 ⇒ 所有引用不受影响；
     * 原位置留一枚 ref run（不是名字文本），改名后能跟着变。
     *
     * 三个前提在**命令层先判**，避免「移了半步才发现不行」：
     *   · 森林顶层不再提取（没有可移动的落点；标记为页就够）；
     *   · journal / tag / schema / query 不提取（它们是身份块，不是内容）；
     *   · 名字撞了就停：地址空间全局唯一，先移后标会留下「根上、没身份」的块。
     */
    extractToPage: (id) => {
      const b = d.kb.get(id)
      if (!b) return false
      const parent = d.kb.parentOf(id)
      if (!parent) {
        d.toast(t('ui.toast.extractRoot'), 'info')
        return false
      }
      // 纯标签是分类，不是内容；兼位成页的块仍可提取（它就是页）
      if (isJournal(b) || (hasList(b, 'tag') && !hasList(b, 'page')) || isPropDefBlock(b) || isQueryBlock(b)) {
        d.toast(t('ui.toast.extractNotAllowed'), 'warn')
        return false
      }
      const current = primaryAliasOf(b).trim()
      const text = plainText(b.content).trim()
      const name = current || text || t('ui.page.untitledAlias', { id: b.id.slice(-6) })
      const hit = d.kb.resolveAlias(name)
      if (hit && hit.id !== b.id) {
        d.toast(t('ui.toast.nameTaken', { name, where: takenWhere(hit) }), 'warn')
        return false
      }
      const at = parent.children.findIndex((x) => x.id === b.id)
      if (at < 0) return false
      const run = { id: uuidv7Hex(), t: 'ref' as const, to: b.id, label: name }
      const ref = mkBlock([run])
      d.run((tx) => {
        if (current === '') tx.setAliases(id, [...aliasesOf(b), name])
        if (!hasList(b, 'page')) tx.setLists(id, [...listsOf(b), 'page'])
        if (prop(b, DISPLAY_PROP) === undefined) tx.setProp(id, DISPLAY_PROP, 'alias')
        tx.move(id, null, d.kb.roots().length)
        tx.insert(ref, parent.id, at)
      })
      const roots = d.rootIds().map((rid) => d.kb.get(rid)).filter((x): x is Block => x !== undefined)
      d.loadPage(roots)
      d.refreshList()
      d.refreshTitle()
      d.saveNow()
      // 引用块在原 parent 里时，光标落到它后面；提取的是当前页自己时它不在视图里，只 toast
      if (d.rootIds().some((rid) => d.kb.pathOf(ref.id).some((p) => p.id === rid))) d.focusBlock(ref.id, 1)
      d.toast(t('ui.toast.extractedToPage', { name }), 'ok')
      return true
    },

    /**
     * **嵌入哪一块？**：候选是整片森林里的内容块（露面块自己也可以被再露面，但不含 `at` 自己）。
     *
     * 为什么不复用页/标签那份候选：那一份的判据是「有身份」（可被引用），
     * 而露面的源可以是**任意内容块**（一棵大纲树的根通常没有地址）。两份候选的判据不同，
     * 但**选择器本身**仍复用同一个（`openRefPicker`）——分叉的只有候选集合。
     */
    showEmbedPicker: (at) => {
      const rows: Row[] = flatten({ roots: [...d.kb.roots()] })
        .filter((b) => b.id !== at)
        .map((b) => ({
          id: `embed/${b.id}`,
          label: d.pageTitle(b).trim() === '' ? t('ui.embed.untitled') : d.pageTitle(b),
          icon: d.pageIcon(b),
          group: isEmbedBlock(b) ? 'embed/2' : 'embed/1',
          args: { blockId: at, targetId: b.id, view: 'mirror' },
        }))
      d.openRefPicker(
        rows,
        (row) => {
          const { blockId, targetId } = row.args as { blockId: string; targetId: string }
          const path = d.kb.pathOf(blockId)
          const parent = path.length > 1 ? path[path.length - 2]! : null
          const embed = mkBlock('')
          setBlockType(embed, EMBED_TYPE)
          embed.props = { ...(embed.props ?? {}), [EMBED_PROP]: { block: targetId } }
          const index = parent ? d.kb.children(parent.id).findIndex((b) => b.id === blockId) + 1 : 0
          // 一次插入一笔事务：落点与 `insertNear` 同一条规则（段根没有兄弟位 ⇒ 插成它的子块）
          d.run((tx) => {
            if (parent) tx.insert(embed, parent.id, index)
            else tx.insert(embed, blockId, 0)
          })
          d.toast(t('ui.embed.inserted'))
        },
        t('ui.embed.pick'),
      )
    },

    showRefPicker: () => {
      /**
       * 候选来源是**身份**，不是位置。
       *
       * ⚠️ 早先列的是 `kb.roots()`（森林顶层）——那等于用「住在哪」当「可不可引用」的判据。
       *    它曾经看起来没问题，只因为当时所有页都恰好住在顶层；内容改成落进当天之后，
       *    **每一个新建的页都不在顶层** ⇒ 那个选择器会静默少掉它们（不报错，只是「找不到」）。
       * ⚠️ 正确的判据是「有地址、可被引用」：页与标签都是（`page`／`tag` 露面）。
       *    两者都扫**整片森林**（`kb.pages`／`kb.tags`），所以嵌在任何位置的目标都在候选里。
       * ⚠️ journal 天不进候选：它的「名字」是日期，引用它没有稳定语义（哪天？）。
       */
      const pageRow = (p: Block): Row => ({
        id: `pick/${p.id}`,
        label: d.pageTitle(p).trim() === '' ? t('ui.page.untitled') : d.pageTitle(p),
        hint: t('ui.refPicker.blocks', { count: count(p) }),
        icon: d.pageIcon(p),
        group: 'pick/1',
        command: 'core.editor/insert-page-ref',
        args: { pageId: p.id },
      })
      const tagRow = (tag: Block): Row => ({
        id: `pick/${tag.id}`,
        label: `#${displayNameOf(tag)}`,
        icon: 'lucide:hash',
        group: 'pick/2',
        command: 'core.editor/insert-page-ref',
        args: { pageId: tag.id },
      })
      const rows: Row[] = [...pages().map(pageRow), ...d.kb.tags().map(tagRow)]
      d.openRefPicker(rows)
    },
  }
}
