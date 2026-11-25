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
   * 标题是单行文本：Enter/Esc 收尾，其余键全部留在这里。
   *
   * `stopPropagation` 是为了不让外层编辑器的文本键位（Enter 拆块、Backspace 并块、
   * ⌘A 全选块…）作用到这一行；文档 capture 上的撤销仍先于此运行，所以 ⌘Z 还是
   * 应用撤销栈（与代码岛同一条「只有一套撤销」）。
   */
  const onKeyDown = (e: KeyboardEvent): void => {
    e.stopPropagation()
    // 嵌套 contenteditable 里原生 ⌘A 会落到外层编辑区（实测选区为空）；这里显式只选标题
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      selectContents(text)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      text.blur()
      return
    }
    if (e.key === 'Escape') {
      // 已逐键落库，Esc 只是离开（不拿建行时的旧值回滚——那会把刚写的标题吃掉）
      e.preventDefault()
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
