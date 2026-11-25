/**
 * 代码块的第二编辑宿主：CM6 岛。
 *
 * 只挂在主编辑面的可编辑行里；表格/卡片/搜索结果等静态面走纯投影，不起第二台编辑器。
 * 岛外层的 `data-edit-island` 把焦点、事件与外层 contenteditable 隔开；文档仍是块的内容，
 * 每次事务经编辑器写通道落模型，撤销只有应用栈一套。
 */
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { search, searchKeymap } from '@codemirror/search'
import { tags } from '@lezer/highlight'
import {
  CODE_ISLAND_ATTR,
  CODE_MAX_HEIGHT_TOKEN,
  canonicalLang,
  codeNeedsWriteBack,
  plainText,
  prop,
  textRuns,
  writeBlockContent,
  type CodeLang,
} from '../../core/index.ts'
import type { BlockEditor } from './editor.ts'

const languageSlot = new Compartment()

/**
 * 语言包按块上的语言运行时选择并异步取：全集静态引入会把十几种语言塞进首屏包。
 * 这里不是运行时拼出来的模块名，而是按已登记语言分派的按需加载点。
 */
async function loadLanguage(lang: CodeLang): Promise<Extension> {
  switch (lang) {
    case 'javascript':
    case 'typescript':
    case 'jsx':
    case 'tsx': {
      const { javascript } = await import('@codemirror/lang-javascript')
      return javascript({ typescript: lang === 'typescript' || lang === 'tsx', jsx: lang === 'jsx' || lang === 'tsx' })
    }
    case 'python': return (await import('@codemirror/lang-python')).python()
    case 'json': return (await import('@codemirror/lang-json')).json()
    case 'html': return (await import('@codemirror/lang-html')).html()
    case 'css': return (await import('@codemirror/lang-css')).css()
    case 'sql': return (await import('@codemirror/lang-sql')).sql()
    case 'markdown': return (await import('@codemirror/lang-markdown')).markdown()
    case 'bash': {
      const { shell } = await import('@codemirror/legacy-modes/mode/shell')
      return StreamLanguage.define(shell)
    }
    case 'yaml': {
      const { yaml } = await import('@codemirror/legacy-modes/mode/yaml')
      return StreamLanguage.define(yaml)
    }
    default: return []
  }
}

/** 语法色只引语义 token；色值在 token 段定义，主题切换不用改这里 */
const syntaxColors = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: 'var(--ui-code-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--ui-code-string)' },
  { tag: [tags.lineComment, tags.blockComment, tags.docComment], color: 'var(--ui-code-comment)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--ui-code-number)' },
  { tag: [tags.definition(tags.variableName), tags.function(tags.variableName)], color: 'var(--ui-code-function)' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--ui-code-type)' },
])

const islandTheme = EditorView.theme({
  '&': {
    fontSize: 'var(--ui-fs-sm)',
    backgroundColor: 'var(--ui-code-bg)',
    color: 'var(--ui-text)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--ui-font-mono)',
    lineHeight: 'var(--ui-lh-tight)',
    maxHeight: `var(${CODE_MAX_HEIGHT_TOKEN})`,
    overflow: 'auto',
  },
  '.cm-content': { padding: 'var(--ui-gap-4) 0' },
  '.cm-gutters': {
    backgroundColor: 'var(--ui-code-bg)',
    color: 'var(--ui-text-tertiary)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--ui-code-bg)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--ui-code-bg)' },
  '.cm-cursor': { borderLeftColor: 'var(--ui-accent)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--ui-accent-soft)',
  },
  '.cm-panels': { backgroundColor: 'var(--ui-surface)', color: 'var(--ui-text)' },
  '.cm-searchMatch': { backgroundColor: 'var(--ui-yellow-soft)' },
})

export interface CodeIslandMount {
  /** 顶层编辑器由装配层现取：焦点切表面之后，写入仍落在当前那台 */
  getEd: () => BlockEditor
  blockId: string
  into: HTMLElement
  /** 右键菜单：岛里没有外层编辑器的菜单委托，得由装配层接回来 */
  onContextMenu?: (anchor: DOMRect) => void
  /** 在代码块下方新建一块（⌘↵）：代码里换行归 CM6，离开要一条显式出口 */
  onExitBelow?: () => void
}

export interface CodeIslandHandle {
  root: HTMLElement
  dispose(): void
}

export function mountCodeIsland({ getEd, blockId, into, onContextMenu, onExitBelow }: CodeIslandMount): CodeIslandHandle {
  const ed = getEd()
  const initial = ed.store.find(blockId)
  const lang = canonicalLang(initial ? prop<string>(initial, '_lang') : undefined)
  const root = document.createElement('div')
  root.className = 'blk-code-body'
  root.setAttribute(CODE_ISLAND_ATTR, '1')
  root.contentEditable = 'false'
  root.dataset.codeLang = lang
  into.appendChild(root)

  let applyingExternal = false
  let disposed = false

  const markCaret = () => {
    const off = view.state.selection.main.head
    ed.bsel.clearBlockSelection()
    // 只写模型光标：DOM 光标留在 CM6，调用 placeCaret 会把焦点抢回外层
    ed.sel = { aBlock: blockId, hBlock: blockId, aOff: off, hOff: off }
  }

  const view = new EditorView({
    parent: root,
    state: EditorState.create({
      doc: initial ? plainText(initial.content) : '',
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        drawSelection(),
        foldGutter(),
        bracketMatching(),
        indentOnInput(),
        closeBrackets(),
        syntaxHighlighting(syntaxColors),
        search({ top: true }),
        keymap.of([
          { key: 'Mod-Enter', run: () => { onExitBelow?.(); return true } },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...foldKeymap,
          indentWithTab,
        ]),
        languageSlot.of([]),
        islandTheme,
        EditorView.updateListener.of((u) => {
          if (disposed || applyingExternal) return
          if (!u.docChanged) {
            if (u.selectionSet && view.hasFocus) markCaret()
            return
          }
          const text = u.state.doc.toString()
          /**
           * 一次事务＝一次 begin/finish，连续输入由撤销栈的 1200ms 合并窗口收成一步
           * （`UndoStack.record` 的 `insert` 规则）。不在岛里另开长条目：那样 ⌘Z 之前
           * 还没收口的一笔看不见，而漏收口会把 `entryDepth` 永久留在 1。
           */
          ed.beginUndoEntry()
          const ok = ed.write((tx) => {
            tx.patch(blockId, (b) => writeBlockContent(b, textRuns(text)))
            return true
          })
          if (ok) ed.finishUndoEntry('insert', Date.now())
          else ed.abortUndoEntry()
          markCaret()
        }),
      ],
    }),
  })
  void loadLanguage(lang).then((ext) => {
    if (!disposed) view.dispatch({ effects: languageSlot.reconfigure(ext) })
  })

  /** 外部写入（撤销、别的表面改同一块）才回灌；自己的写文本已一致，不回灌 */
  const unsubscribe = ed.store.subscribe((_source, ids) => {
    if (disposed || applyingExternal) return
    if (ids && !ids.includes(blockId)) return
    const b = ed.store.find(blockId)
    if (!b) return
    const model = plainText(b.content)
    if (!codeNeedsWriteBack(model, view.state.doc.toString())) return
    applyingExternal = true
    try {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: model } })
    } finally {
      applyingExternal = false
    }
  })

  const openMenu = (e: MouseEvent) => {
    if (!onContextMenu) return
    e.preventDefault()
    markCaret()
    onContextMenu(new DOMRect(e.clientX, e.clientY, 0, 0))
  }
  /**
   * CM6 只在自己的文本行里落光标；点空白区/行号槽时 DOM 焦点在岛内、选区却不在
   * `.cm-content` 里 ⇒ 打字没有落点。这里把「焦点在岛内但选区不在正文」的点击
   * 补一次显式光标（不改写正常的文本点击与拖选）。
   */
  const ensureCaret = (e: MouseEvent) => {
    if (e.button !== 0 || disposed) return
    const sel = document.getSelection()
    if (sel?.anchorNode && view.contentDOM.contains(sel.anchorNode)) return
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.doc.length
    view.focus()
    view.dispatch({ selection: { anchor: pos } })
  }
  root.addEventListener('contextmenu', openMenu)
  root.addEventListener('mouseup', ensureCaret)
  view.dom.addEventListener('focusin', markCaret)

  return {
    root,
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
      root.removeEventListener('contextmenu', openMenu)
      root.removeEventListener('mouseup', ensureCaret)
      view.dom.removeEventListener('focusin', markCaret)
      view.destroy()
      root.remove()
    },
  }
}
