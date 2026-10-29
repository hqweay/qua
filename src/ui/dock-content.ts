/**
 * 两个侧槽的**派生卡**：归属树／反链／回收站。
 *
 * 这里只产「一张卡的内容」，不负责排槽、不负责卡片的头/折叠/单卡——
 * 那些是 `ui/dock.ts` 的事。原先这些函数各自排一整槽，导致槽的顺序只能写死在
 * 两个函数里；拆成「产卡」之后，装配层才能按 `cards` 列表把窗口与派生卡混排。
 *
 * ⚠️ 这里**不认 `ws`／`ed`／`registry`**，只认下面这个 `DockContentDeps`。
 * ⚠️ 渲染一律走 `renderBlock`：槽只排一列，块由类型决定长相（角色只叠 chrome）。
 *
 * 没有「我选的一组块」这种卡：那个概念（用户自己命名的分组）还没有载体。曾用「普通块 ＋
 * 一个专用角色 ＋ 内部一列块 id」冒充它 —— 但冒充出来的东西会被读成产品概念，还白占一个
 * 角色值；等真概念从模型里长出来时再进槽。
 */
import { displayTextOf, type Block } from '../core/index.ts'
import { textRuns } from '../core/runs.ts'
import type { KbClient } from '../core/kb/types.ts'
import { t } from '../core/msg.ts'
import { renderBlock, type BlockRenderCtx } from './block-renderers.ts'
import type { DockCard } from './dock.ts'
import { cardList, cardNote, emptyCardList } from './card-parts.ts'

export interface DockContentDeps {
  /** 读门面：反链源根、回收站项都按 id 取数 */
  kb: KbClient
  activeId: () => string
  /** 打开某个根（页/天/被 zoom 的根；反链项给的是来源根 id）——中心槽 */
  openPage: (id: string) => void
  /** 在右槽打开某个块（Shift+点行／块标） */
  openInDock: (id: string) => void
  /**
   * 从回收站恢复一块（走命令面，不在这里直接改模型）。
   *
   * 为什么收成依赖而不是让卡自己改：恢复要进撤销栈、要排落盘、要让索引失效——
   * 三条路径只有一处入口（命令 → 编辑器写入口）。卡里直接改会漏掉撤销与落盘。
   */
  restoreBlock: (id: string) => void
}

function ctx(deps: DockContentDeps): BlockRenderCtx {
  return {
    isActive: (id) => id === deps.activeId(),
    onActivate: (b) => deps.openPage(b.id),
    onOpenInDock: (b) => deps.openInDock(b.id),
    untitledLabel: t('ui.page.untitled'),
  }
}

/**
 * 右槽：反链卡（结果总是存在，空时给一句空文案）
 */
export function backrefsCard(deps: DockContentDeps): DockCard {
  const target = deps.activeId()
  const sources = deps.kb.backlinksOf(target)

  const list = sources.length === 0 ? emptyCardList(t('ui.dock.noBackRefs')) : cardList()
  // 反链项**不是库里的块**，是查询结果：现造一行出来，靠 `props._icon` 拿箭头（大纲行已经读它）。
  // 不给它挂角色 —— 角色说的是「这块在系统里担任什么机制位」，而它没有库身份，从不落盘。
  // 时间戳只是为了让形状成立（`Block` 的必填字段）：这一行没有生命周期，现造现丢，
  // 所以不去装成「它刚被创建」——给它一个固定的零值，一眼看出它不是库里的块。
  for (const s of sources) {
    const row: Block = {
      id: s.rootId,
      content: textRuns(s.text),
      children: [],
      created: 0,
      modified: 0,
      props: { _icon: 'lucide:corner-up-left' },
    }
    list.appendChild(renderBlock(row, ctx(deps)))
  }

  return { id: 'backrefs', title: t('ui.dock.backRefs'), body: list }
}

/**
 * 右槽：**回收站**卡（派生）。
 *
 * 为什么它是一张卡而不是一个「回收站页面」：删掉的块**仍在树上的原位**（原位软删），
 * 它们不是另一个命名空间里的东西。一张卡就够了，不需要再造一个「页」去装它们——
 * 那正是「一切皆块」要避免的第二种实体。
 *
 * 三条判据：
 *   ① 只列**操作根**（`kb.trash()` 已经是这个口径）：删一棵子树只出现一条，
 *      后代的不可见是继承来的；
 *   ② 每一行带它自己的正文（不是空白行）：用户靠正文认出「这是我删的那个」；
 *   ③ 恢复走命令面（`core.block/restore`），不在这里直接改模型——
 *      撤销、落盘、索引三条路径只有一处入口。
 *
 * ⚠️ 这一行**不是**库里的块，是回收站里那一块的一次露面：所以不 `renderBlock`
 *    （那会把它画成可编辑的行、带上块标与菜单），而是画一行只读的「正文 ＋ 恢复」。
 *    渲染成可编辑行会诱使人就地改它——而它此刻是「被删的」，改它没有语义。
 */
export function trashCard(deps: DockContentDeps): DockCard {
  const items = deps.kb.trash()
  if (items.length === 0) {
    // 空态要说两句：一句「为什么是空的」，一句「删掉的东西去哪了」
    const empty = emptyCardList(t('ui.dock.trashEmpty'))
    empty.appendChild(cardNote(t('ui.dock.trashHint')))
    return { id: 'trash', title: t('ui.dock.trash'), body: empty }
  }
  const list = cardList()

  for (const b of items) {
    const row = document.createElement('div')
    row.className = 'trash-row'
    // 读数契约：冒烟与探针按这个属性取「回收站里有哪些块」
    row.dataset.trashRow = b.id

    const text = document.createElement('span')
    text.className = 'trash-text ui-ellipsis ui-ellipsis-grow'
    // 正文投影（与搜索／导出同一份口径）；空块给一句占位，否则行看起来像坏的
    const plain = displayTextOf(b)
    text.textContent = plain === '' ? t('ui.dock.trashBlank') : plain
    row.appendChild(text)

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'trash-restore'
    btn.textContent = t('ui.dock.trashRestore')
    btn.title = t('cmd.block.restore')
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      deps.restoreBlock(b.id)
    })
    row.appendChild(btn)

    list.appendChild(row)
  }

  return { id: 'trash', title: t('ui.dock.trash'), body: list }
}
