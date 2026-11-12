/**
 * **备注浮窗**：锚在被备注文本旁的浮层，里面是一台真的单块编辑器。
 *
 * 交互判据：**手势的落点必须离手势足够近**——写备注是轻手势，注意力还在
 * 那几个字上，落点（可编辑面）就必须原地，不能跳到段尾的收集清单。浮窗是「写」的面，
 * 侧栏备注栏是「收集」的面；两个面装的是**同一个块**（同一套 tx/撤销），不是两份答案。
 *
 * 三条口径：
 *   · **浮层里是真编辑器**（`EditableBlock`，title-editor 同款配置）：假预览框才是
 *     要避免的东西——同一份内容两个可写面里，假的那份必然漂。
 *   · **关闭即提交**（外点/Esc 都走 onClose）：空备注连块回收（不留空壳），
 *     有内容即完成。「取消」只对空备注有意义——有内容的 Esc 不丢字。
 *   · **「在侧栏打开」是显式跳板**：去收集清单是第二次手势，不是自动行为。
 */
import type { Block, BlockStore } from '../../core/index.ts'
import type { BlockEditor, Run } from '../../view/editor/editor.ts'
import { t } from '../../core/infra/msg.ts'
import { EditableBlock } from './editable-block.ts'

export interface NotePopoverDeps {
  /** 装进哪（openPopover 的 box） */
  into: HTMLElement
  store: BlockStore
  /** 写入事务入口（撤销条目与落盘归装配层） */
  write: Run
  /** 与正文**同一份**事件表 */
  wire: (ed: BlockEditor, change: (kind: string) => void) => void
  onFocus: (ed: BlockEditor) => void
  onChange: (kind: string) => void
  /** 这条备注（每次现取：撤销之后旧引用可能已经不在森林里） */
  block: () => Block | undefined
  /** 抬头引文快照：锚定段的原句，给「这条备注在说哪段」的上下文 */
  quote: string
  /** 「在侧栏打开」：显式跳板——备注栏聚焦这一行 */
  onOpenInSidebar: () => void
  placeholder: string
}

export interface NotePopoverHandle {
  editor: () => BlockEditor | null
  /** 关浮层前调用：同步推 DOM→模型（浮层被摘后 blur 的延迟 flush 等不到） */
  flush: () => void
  dispose: () => void
}

export function mountNotePopover(deps: NotePopoverDeps): NotePopoverHandle {
  const first = deps.block()
  const head = document.createElement('div')
  head.className = 'note-popover-head'
  const quote = document.createElement('span')
  quote.className = 'note-popover-quote'
  quote.textContent = deps.quote
  const open = document.createElement('button')
  open.type = 'button'
  open.className = 'note-popover-open'
  open.dataset.command = 'note-popover/open-in-sidebar'
  open.textContent = t('ui.note.openInSidebar')
  open.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    deps.onOpenInSidebar()
  })
  head.append(quote, open)

  const host = document.createElement('div')
  host.className = 'note-popover-body'

  const island = new EditableBlock({
    host,
    store: deps.store,
    write: deps.write,
    initialRoots: first ? [first] : [],
    // 构造时就要给：漏了首帧会把子树整棵画进来（title-editor 同一条坑）
    ...(first ? { viewRootId: first.id } : {}),
    // 备注块是森林顶层：结构动作别并进别人的行；根与浮窗绑定，删除走显式回收路径
    structuralScope: 'roots',
    allowRootRemove: false,
    embedBodies: false,
    emptyPlaceholder: deps.placeholder,
    load: (ed, ids) => {
      if (!ed) return
      const b = deps.block()
      // 与己无关的变化不重装：别处敲字不该换掉正在打的这一行
      if (b && ids && ids.length > 0 && !ids.includes(b.id)) return
      ed.loadPage({
        roots: b ? [b] : [],
        folded: ed.doc.folded,
        ...(b ? { viewRootId: b.id } : {}),
      })
    },
    wire: deps.wire,
    onFocus: deps.onFocus,
    onChange: deps.onChange,
    // 冻结范围＝浮窗本体：焦点在里面时不重装
    area: deps.into,
  })

  deps.into.append(head, host)
  // 先接进文档再建编辑器：编辑器构造时会量 DOM
  island.ensureEditor()

  return {
    editor: () => island.ed,
    flush: () => island.flush(),
    dispose: () => {
      island.dispose()
      island.root.remove()
    },
  }
}
