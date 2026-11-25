/**
 * **容器标题行的编辑面**：给「身体不是那行字」的块（代码／露面／将来的图片）一个
 * 单行可编辑题注。
 *
 * 为什么不是 `<input>`：它住在块行的 `data-edit-island` 里，外层编辑器的键位、
 * 选区同步与粘贴都按岛让路；`contenteditable` 与代码岛同一条宿主契约，不另开表单世界。
 *
 * 写路径不在这里：每次 `input` 只把当前单行文本交给 `onCommit`，由编辑器用
 * `ed.write` ＋ 撤销条目落模型（见 `BlockEditor.setCaption`）。
 */
import { captionOf, type Block } from '../../core/model/model.ts'
import { t } from '../../core/infra/msg.ts'
import { EDIT_ISLAND_ATTR } from './edit-island.ts'

/** 标题是单行：粘贴多行时折成空格，不当成第二段正文 */
const singleLine = (s: string): string => s.replace(/[\r\n]+/g, ' ')

function caretToEnd(el: HTMLElement): void {
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  const sel = document.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

function selectContents(el: HTMLElement): void {
  const range = document.createRange()
  range.selectNodeContents(el)
  const sel = document.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

export interface CaptionRowOptions {
  /** 空标题时的占位（展开态）；它不落盘 */
  placeholder: string
  /** 收起态的空占位：代码给首行预览、露面给目标名——收起时它就是这一块的题 */
  collapsedPlaceholder?: string
  /** 单行文本（可能为空串＝摘标题）；调用方负责写模型与撤销 */
  onCommit: (text: string) => void
  /**
   * 行头右侧的动作组（上建块／下建块／删除）。
   *
   * 为什么挂在这里而不是行级绝对定位：题注是这一行的第一条 flex 行，动作组跟在名字后面
   * 右对齐——不压标签槽、不随 hover 改行宽（透明度切换，不换布局）。
   * 按钮自己带 `data-block-act`，点击由编辑器的事件表接（与块标同一处委托）。
   */
  actions?: HTMLElement
  /** 动作组里点了哪一颗（`above`／`below`／`delete`）：命令归调用方，这里只读 DOM 意图 */
  onAction?: (act: 'above' | 'below' | 'delete') => void
  /** 右键这一行（题注）：与右键块标/正文同一条块菜单。`trigger` 用于「同一处再右键＝收起」 */
  onContextMenu?: (rect: DOMRect, trigger: HTMLElement) => void
}

export function makeCaptionRow(block: Block, opts: CaptionRowOptions): HTMLElement {
  const row = document.createElement('div')
  row.className = 'blk-caption'
  row.contentEditable = 'false'
  row.setAttribute(EDIT_ISLAND_ATTR, '1')
  row.dataset.captionFor = block.id

  const text = document.createElement('span')
  text.className = 'blk-caption-text ui-ellipsis ui-ellipsis-grow'
  text.contentEditable = 'true'
  text.spellcheck = false
  text.setAttribute('role', 'textbox')
  text.setAttribute('aria-label', t('ui.block.caption'))
  text.dataset.ph = opts.placeholder
  text.dataset.phCollapsed = opts.collapsedPlaceholder ?? opts.placeholder
  text.textContent = captionOf(block)

  let composing = false
  const paintEmpty = (): void => {
    const empty = (text.textContent ?? '').trim() === ''
    text.dataset.empty = empty ? '1' : '0'
    if (empty) delete row.dataset.has
    else row.dataset.has = '1'
  }
  paintEmpty()

  const commit = (): void => {
    if (composing) return
    const raw = singleLine(text.textContent ?? '')
    if (raw !== (text.textContent ?? '')) {
      text.textContent = raw
      caretToEnd(text)
    }
    paintEmpty()
    opts.onCommit(raw)
  }

  const onInput = (): void => {
    if (composing) return
    commit()
  }
  const onCompositionStart = (): void => {
    composing = true
  }
  const onCompositionEnd = (): void => {
    composing = false
    commit()
  }
  /**
   * **标题行只截自己要的键，其余放行给应用键位表。**
   *
   * 曾经这里无条件 `stopPropagation()`，等于把「题注也是这一块的标题」这个事实关掉：
   * ⌘⇧↵（上建块）、Tab（缩进）、⌘⇧D 全都到不了命令层，而**查询块的标题**
   * （就是 `.tx` 本身）一直能用这些键——同一个「标题」在两种块上两种手感。
   * 现在两边对齐：结构键接同一条命令，其余（含撤销）照旧走应用键位表。
   *
   * ⚠️ Enter 不拆标题：题注不是这一块的正文（代码块的正文是代码），把标题切成
   *    「后半段搬进下一块的正文」是用户没要求的转换。它只表示「标题写完，往下走」⇒
   *    在下方建一个空块（与查询块标题「Enter 出兄弟块」同一效果，命令不同是因为
   *    切的对象不同）。
   */
  const onKeyDown = (e: KeyboardEvent): void => {
    // 嵌套 contenteditable 里原生 ⌘A 会落到外层编辑区（实测选区为空）；这里显式只选标题
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      e.stopPropagation()
      selectContents(text)
      return
    }
    // ⌘⇧↵ ＝ 在上方新建块（与正文里同一条动作）；必须在冒泡前拦，否则会再走一次拆块
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'Enter') {
      if (!opts.onAction) return // 没有结构动作的宿主：放行，不制造死键
      e.preventDefault()
      e.stopPropagation()
      commit()
      opts.onAction('above')
      return
    }
    // Enter ＝ 在下方新建块（标题写完往下走；不切标题文本）
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault()
      e.stopPropagation()
      commit()
      if (opts.onAction) opts.onAction('below')
      else text.blur()
      return
    }
    if (e.key === 'Escape') {
      // 已逐键落库，Esc 只是离开（不拿建行时的旧值回滚——那会把刚写的标题吃掉）
      e.preventDefault()
      e.stopPropagation()
      text.blur()
    }
  }
  /**
   * 粘贴只取纯文本并压成一行：原生粘贴会把富文本节点塞进标题，读回时还可能带
   * 换行；这里自己插一段文本，input 事件再走同一条 commit。
   */
  const onPaste = (e: ClipboardEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const clean = singleLine(e.clipboardData?.getData('text/plain') ?? '')
    if (clean === '') return
    const sel = document.getSelection()
    if (!sel || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    if (!text.contains(range.commonAncestorContainer)) return
    range.deleteContents()
    const node = document.createTextNode(clean)
    range.insertNode(node)
    range.setStart(node, node.nodeValue?.length ?? 0)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
    commit()
  }

  /**
   * **右键题注 ＝ 右键这一块的菜单**（与查询块的标题同一件事）。
   *
   * 外层编辑器的 `contextmenu` 委托按「岛内事件不归我」整支跳过（题注住在编辑岛里），
   * 所以这里必须自己收下再交给同一条桥；CM6 正文那边也是这么做的（`onContextMenu`）。
   */
  row.addEventListener('contextmenu', (e) => {
    if (!opts.onContextMenu) return
    e.preventDefault()
    e.stopPropagation()
    opts.onContextMenu(new DOMRect(e.clientX, e.clientY, 0, 0), row)
  })
  text.addEventListener('input', onInput)
  text.addEventListener('compositionstart', onCompositionStart)
  text.addEventListener('compositionend', onCompositionEnd)
  text.addEventListener('keydown', onKeyDown)
  text.addEventListener('paste', onPaste)
  text.addEventListener('blur', commit)

  row.appendChild(text)
  if (opts.actions) {
    row.appendChild(opts.actions)
    /**
     * 动作组的点击**在本行里收**：题注住在块的编辑岛里，外层编辑器的委托会按
     * 「岛内事件不归我」直接跳过（`inForeignIsland`）——挂到容器上等于点了没反应。
     * 岛自己持有这些事件，是同一个契约的另一面。
     */
    row.addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-block-act]') : null
      const act = target?.dataset.blockAct
      if (act !== 'above' && act !== 'below' && act !== 'delete') return
      e.preventDefault()
      e.stopPropagation()
      opts.onAction?.(act)
    })
  }
  return row
}
