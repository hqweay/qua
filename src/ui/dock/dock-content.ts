/**
 * 两个侧槽的**派生卡**：回收站。
 *
 * 这里只产「一张卡的内容」，不负责排槽、不负责卡片的头/折叠/单卡——
 * 那些是 `ui/dock.ts` 的事。原先这些函数各自排一整槽，导致槽的顺序只能写死在
 * 两个函数里；拆成「产卡」之后，装配层才能按 `cards` 列表把窗口与派生卡混排。
 *
 * ⚠️ 挂载区卡不在这里：它要**直接渲染并编辑源块**，卡身就是块底那台挂载区组件
 *    （`ui/chrome/mount-area.ts`），住在 `ui/cards/mount-card.ts`。这里只放「一行只读」的卡。
 * ⚠️ 这里**不认 `ws`／`ed`／`registry`**，只认下面这个 `DockContentDeps`。
 *
 * 没有「我选的一组块」这种卡：那个概念（用户自己命名的分组）还没有载体。曾用「普通块 ＋
 * 一个专用角色 ＋ 内部一列块 id」冒充它 —— 但冒充出来的东西会被读成产品概念，还白占一个
 * 角色值；等真概念从模型里长出来时再进槽。
 */
import { blockSummary, isBlankTrashEntry } from '../../core/index.ts'
import type { KbClient } from '../../core/kb/types.ts'
import { t } from '../../core/infra/msg.ts'
import type { DockCard } from './dock.ts'
import { cardList, cardNote, emptyCardList } from '../chrome/card-parts.ts'

/** 清空的口径：全部条目，或只有「空块」（判据在 core，`isBlankTrashEntry`） */
export type TrashScope = 'all' | 'blank'

/**
 * 清空口径的**唯一一份**（视图状态：会话内记忆，不落库——它是「这次在看什么」，
 * 不是配置）。回收站卡有两个宿主（侧槽的卡／中心的面），各自重画都是新 DOM，
 * 状态住任何一家的闭包里都会分叉成两份口径。
 */
let trashScopeValue: TrashScope = 'all'
export const trashScope = {
  get: (): TrashScope => trashScopeValue,
  set: (s: TrashScope): void => {
    trashScopeValue = s
  },
}

/** 确认框的形状（`Layers.confirm` 的参数子集——卡不关心焦点归还这些实现细节） */
export interface TrashConfirm {
  title: string
  body: string
  confirmLabel: string
  danger: boolean
  onConfirm: () => void
}

export interface DockContentDeps {
  /** 读门面：回收站项按 id 取数 */
  kb: KbClient
  /**
   * 从回收站恢复一块（走命令面，不在这里直接改模型）。
   *
   * 为什么收成依赖而不是让卡自己改：恢复要进撤销栈、要排落盘、要让索引失效——
   * 三条路径只有一处入口（命令 → 编辑器写入口）。卡里直接改会漏掉撤销与落盘。
   */
  restoreBlock: (id: string) => void
  /**
   * 永久清除一批操作根（含子树，不可恢复）。同样走命令面：op 要落盘、索引要修补。
   */
  purgeTrash: (ids: readonly string[]) => void
  /** 切口径（口径现值由本模块的 `trashScope` 持有）：宿主改完状态会重画 */
  onTrashScope: (s: TrashScope) => void
  /** 后果性操作的确认框（`Layers.confirm`）：清空前的最后一道闸 */
  confirm: (o: TrashConfirm) => void
}


/**
 * 右槽：**回收站**卡（派生）。
 *
 * 为什么它是一张卡而不是一个「回收站页面」：删掉的块**仍在树上的原位**（原位软删），
 * 它们不是另一个命名空间里的东西。一张卡就够了，不需要再造一个「页」去装它们——
 * 那正是「一切皆块」要避免的第二种实体。
 *
 * 四条判据：
 *   ① 只列**操作根**（`kb.trash()` 已经是这个口径）：删一棵子树只出现一条，
 *      后代的不可见是继承来的；
 *   ② 每一行带它自己的正文（不是空白行）：用户靠正文认出「这是我删的那个」；
 *   ③ 恢复与清空都走命令面，不在这里直接改模型——
 *      撤销（恢复）、落盘、索引三条路径只有一处入口；
 *   ④ **清空作用于当前口径下的可见集合**（全部／空块）：删什么在按之前就看得见，
 *      确认框只负责告知后果（数量、含子树、不可恢复），不承担选范围——
 *      不可逆动作的透明性优先于 chrome 最小化。
 *
 * ⚠️ 这一行**不是**库里的块，是回收站里那一块的一次露面：所以不 `renderBlock`
 *    （那会把它画成可编辑的行、带上块标与菜单），而是画一行只读的「正文 ＋ 恢复」。
 *    渲染成可编辑行会诱使人就地改它——而它此刻是「被删的」，改它没有语义。
 */
export function trashCard(deps: DockContentDeps): DockCard {
  const items = deps.kb.trash()
  if (items.length === 0) {
    // 空态要说两句：一句「为什么是空的」，一句「删掉的东西去哪了」；没有东西就没有工具行
    const empty = emptyCardList(t('ui.dock.trashEmpty'))
    empty.appendChild(cardNote(t('ui.dock.trashHint')))
    return { id: 'trash', title: t('ui.dock.trash'), body: empty }
  }

  // 口径只是清空（与列表）前的一次筛选，不是回收站的第二种状态
  const kbGet = (id: string) => deps.kb.get(id)
  const entries = trashScope.get() === 'blank' ? items.filter((b) => isBlankTrashEntry(b, kbGet)) : items

  const body = document.createElement('div')

  /**
   * 工具行长在 body 里（卡头没有本卡专属动作的通道）：
   * 左边口径切换，右边「清空 N」——N 是**当前口径**下的条数。
   */
  const tools = document.createElement('div')
  tools.className = 'trash-tools'
  for (const s of ['all', 'blank'] as const) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'trash-scope'
    btn.textContent = t(s === 'all' ? 'ui.dock.trashScopeAll' : 'ui.dock.trashScopeBlank')
    btn.setAttribute('aria-pressed', trashScope.get() === s ? 'true' : 'false')
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (trashScope.get() !== s) deps.onTrashScope(s)
    })
    tools.appendChild(btn)
  }
  const ids = entries.map((b) => b.id)
  const clear = document.createElement('button')
  clear.type = 'button'
  clear.className = 'trash-clear'
  clear.textContent = `${t('ui.dock.trashClear')} ${ids.length}`
  clear.disabled = ids.length === 0
  clear.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (ids.length === 0) return
    deps.confirm({
      title: t('ui.dock.trashClearTitle'),
      body: t('ui.dock.trashClearBody', { count: String(ids.length) }),
      confirmLabel: t('ui.dock.trashClearConfirm'),
      danger: true,
      onConfirm: () => deps.purgeTrash(ids),
    })
  })
  tools.appendChild(clear)
  body.appendChild(tools)

  if (entries.length === 0) {
    body.appendChild(cardNote(t('ui.dock.trashScopeBlankEmpty')))
    return { id: 'trash', title: t('ui.dock.trash'), body }
  }

  const list = cardList()
  body.appendChild(list)

  for (const b of entries) {
    const row = document.createElement('div')
    row.className = 'trash-row'
    // 读数契约：冒烟与探针按这个属性取「回收站里有哪些块」
    row.dataset.trashRow = b.id

    const text = document.createElement('span')
    text.className = 'trash-text ui-ellipsis ui-ellipsis-grow'
    // 呈现摘要（引用读目标名、图片读文件名）；真空块给一句占位，否则行看起来像坏的
    const plain = blockSummary(b, kbGet)
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
  return { id: 'trash', title: t('ui.dock.trash'), body }
}
