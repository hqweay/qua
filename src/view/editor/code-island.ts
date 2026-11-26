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
  CODE_LANG_DECLS,
  CODE_MAX_HEIGHT_TOKEN,
  CODE_TEXT_PROP,
  canonicalLang,
  codeNeedsWriteBack,
  codeTextOf,
  prop,
  type CodeLang,
  type CodeLangDecl,
  type NativeLang,
} from '../../core/index.ts'
import type { BlockEditor } from './editor.ts'

const languageSlot = new Compartment()

/** 语言表按 id 索引：这一层的分派只看「有没有官方包／加载点」，清单本身在 core */
const DECL_OF: ReadonlyMap<CodeLang, CodeLangDecl> = new Map(CODE_LANG_DECLS.map((d) => [d.id, d]))

/** `StreamLanguage.define` 的入参类型（legacy 模式的形状；不直接依赖 `@codemirror/streamparser`） */
type StreamParserAny = Parameters<typeof StreamLanguage.define>[0]

/**
 * **官方语言包**（`@codemirror/lang-*`）的按需加载点，按语言表里的家族名分派。
 *
 * 语言包按块上的语言运行时选择并异步取：全集静态引入会把几十种语言塞进首屏包。
 * 这里不是运行时拼出来的模块名，而是静态可分析的 `import()` —— 每门语言一个独立 chunk。
 */
async function loadNative(family: NativeLang, lang: CodeLang): Promise<Extension> {
  switch (family) {
    case 'javascript': {
      const { javascript } = await import('@codemirror/lang-javascript')
      return javascript({ typescript: lang === 'typescript' || lang === 'tsx', jsx: lang === 'jsx' || lang === 'tsx' })
    }
    case 'python': return (await import('@codemirror/lang-python')).python()
    case 'json': return (await import('@codemirror/lang-json')).json()
    case 'html': return (await import('@codemirror/lang-html')).html()
    case 'css': return (await import('@codemirror/lang-css')).css()
    case 'sql': return (await import('@codemirror/lang-sql')).sql()
    case 'markdown': return (await import('@codemirror/lang-markdown')).markdown()
    case 'php': return (await import('@codemirror/lang-php')).php()
  }
}

/**
 * **legacy 模式的加载点**（键＝语言 id，不一定是模块名：`clike` 一个模块给出
 * c／cpp／java／kotlin／scala／csharp／dart／objc 八门）。
 *
 * 加一门语言＝core 的语言表加一行 ＋ 这里加一行 import；两边漏一边由单测打红
 * （`codeLangHasLoader`），不是「静默按纯文本画」。
 */
const LEGACY_LOADERS: Readonly<Partial<Record<CodeLang, () => Promise<StreamParserAny>>>> = {
  bash: async () => (await import('@codemirror/legacy-modes/mode/shell')).shell,
  yaml: async () => (await import('@codemirror/legacy-modes/mode/yaml')).yaml,
  scss: async () => (await import('@codemirror/legacy-modes/mode/sass')).sass,
  xml: async () => (await import('@codemirror/legacy-modes/mode/xml')).xml,
  toml: async () => (await import('@codemirror/legacy-modes/mode/toml')).toml,
  ini: async () => (await import('@codemirror/legacy-modes/mode/properties')).properties,
  diff: async () => (await import('@codemirror/legacy-modes/mode/diff')).diff,
  http: async () => (await import('@codemirror/legacy-modes/mode/http')).http,
  latex: async () => (await import('@codemirror/legacy-modes/mode/stex')).stex,
  protobuf: async () => (await import('@codemirror/legacy-modes/mode/protobuf')).protobuf,
  java: async () => (await import('@codemirror/legacy-modes/mode/clike')).java,
  kotlin: async () => (await import('@codemirror/legacy-modes/mode/clike')).kotlin,
  scala: async () => (await import('@codemirror/legacy-modes/mode/clike')).scala,
  c: async () => (await import('@codemirror/legacy-modes/mode/clike')).c,
  cpp: async () => (await import('@codemirror/legacy-modes/mode/clike')).cpp,
  csharp: async () => (await import('@codemirror/legacy-modes/mode/clike')).csharp,
  dart: async () => (await import('@codemirror/legacy-modes/mode/clike')).dart,
  objectivec: async () => (await import('@codemirror/legacy-modes/mode/clike')).objectiveC,
  go: async () => (await import('@codemirror/legacy-modes/mode/go')).go,
  rust: async () => (await import('@codemirror/legacy-modes/mode/rust')).rust,
  swift: async () => (await import('@codemirror/legacy-modes/mode/swift')).swift,
  ruby: async () => (await import('@codemirror/legacy-modes/mode/ruby')).ruby,
  perl: async () => (await import('@codemirror/legacy-modes/mode/perl')).perl,
  lua: async () => (await import('@codemirror/legacy-modes/mode/lua')).lua,
  r: async () => (await import('@codemirror/legacy-modes/mode/r')).r,
  julia: async () => (await import('@codemirror/legacy-modes/mode/julia')).julia,
  groovy: async () => (await import('@codemirror/legacy-modes/mode/groovy')).groovy,
  haskell: async () => (await import('@codemirror/legacy-modes/mode/haskell')).haskell,
  erlang: async () => (await import('@codemirror/legacy-modes/mode/erlang')).erlang,
  clojure: async () => (await import('@codemirror/legacy-modes/mode/clojure')).clojure,
  scheme: async () => (await import('@codemirror/legacy-modes/mode/scheme')).scheme,
  ocaml: async () => (await import('@codemirror/legacy-modes/mode/mllike')).oCaml,
  fsharp: async () => (await import('@codemirror/legacy-modes/mode/mllike')).fSharp,
  elm: async () => (await import('@codemirror/legacy-modes/mode/elm')).elm,
  crystal: async () => (await import('@codemirror/legacy-modes/mode/crystal')).crystal,
  coffeescript: async () => (await import('@codemirror/legacy-modes/mode/coffeescript')).coffeeScript,
  vb: async () => (await import('@codemirror/legacy-modes/mode/vb')).vb,
  pascal: async () => (await import('@codemirror/legacy-modes/mode/pascal')).pascal,
  fortran: async () => (await import('@codemirror/legacy-modes/mode/fortran')).fortran,
  matlab: async () => (await import('@codemirror/legacy-modes/mode/octave')).octave,
  powershell: async () => (await import('@codemirror/legacy-modes/mode/powershell')).powerShell,
  dockerfile: async () => (await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile,
  nginx: async () => (await import('@codemirror/legacy-modes/mode/nginx')).nginx,
  cmake: async () => (await import('@codemirror/legacy-modes/mode/cmake')).cmake,
  verilog: async () => (await import('@codemirror/legacy-modes/mode/verilog')).verilog,
  vhdl: async () => (await import('@codemirror/legacy-modes/mode/vhdl')).vhdl,
  wast: async () => (await import('@codemirror/legacy-modes/mode/wast')).wast,
}

/** 这一门语言此刻有没有语法：没有就按纯文本画（`plain` 本来就没有） */
export function codeLangHasLoader(lang: CodeLang): boolean {
  if (lang === 'plain') return true
  return DECL_OF.get(lang)?.native !== undefined || LEGACY_LOADERS[lang] !== undefined
}

/** 语言 → CM6 语言扩展；不认识或没有加载点 ⇒ 空扩展（纯文本） */
export async function loadCodeLanguage(lang: CodeLang): Promise<Extension> {
  const decl = DECL_OF.get(lang)
  if (!decl) return []
  if (decl.native) return loadNative(decl.native, lang)
  const load = LEGACY_LOADERS[lang]
  return load ? StreamLanguage.define(await load()) : []
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

/**
 * **块剪贴板手势**：单光标、塌缩。
 *
 * 有划选 ⇒ 归身体（CM6／原生文本语义）；无划选 ⇒ 归容器（整块）。
 * 多光标留给 CM6 的行语义——那种状态下 `⌘C`／`⌘X` 剪的是行，不是块。
 * 三个输入都是「事件那一刻」的事实，抽成纯谓词只为单测能钉住边界。
 */
export function isBlockClipboardGesture(rangeCount: number, empty: boolean, domCollapsed: boolean): boolean {
  return rangeCount === 1 && empty && domCollapsed
}

export interface CodeIslandMount {
  /** 顶层编辑器由装配层现取：焦点切表面之后，写入仍落在当前那台 */
  getEd: () => BlockEditor
  blockId: string
  into: HTMLElement
  /** 空选区 ⌘C：复制整块（正文味 ＋ 引用味），与块上的 ⌘C 同一动作 */
  onCopyBlock?: () => void
  /** 空选区 ⌘X：抓取整块移动（不当场删，粘贴那一刻才搬） */
  onCutBlock?: () => void
  /** 空选区 ⌘⇧C：复制整块纯文本（不带引用意图） */
  onCopyBlockText?: () => void
  /** 右键菜单：岛里没有外层编辑器的菜单委托，得由装配层接回来 */
  onContextMenu?: (anchor: DOMRect) => void
  /** ⌘↵：代码块也照常切换任务；岛内接管，避免 CM6 默认 insertBlankLine */
  onToggleTask?: () => void
}

export interface CodeIslandHandle {
  root: HTMLElement
  dispose(): void
}

export function mountCodeIsland({ getEd, blockId, into, onCopyBlock, onCutBlock, onCopyBlockText, onContextMenu, onToggleTask }: CodeIslandMount): CodeIslandHandle {
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
  /**
   * 块剪贴板手势要同时满足：CM6 里单光标塌缩，且 DOM 选区也是塌缩的。
   * DOM 那一半是防「CM6 状态已空、原生选区还停在别处」的半拍差。
   */
  const isBlockGesture = (v: EditorView): boolean => {
    const sel = v.state.selection
    const dom = document.getSelection()
    return isBlockClipboardGesture(sel.ranges.length, sel.main.empty, dom?.isCollapsed ?? true)
  }
  /** 空选区 ⌘C／⌘X 回块语义：capture 拦截，别让 CM6 的行级复制/删除先跑 */
  const claimBlockClipboard = (e: ClipboardEvent, run: (() => void) | undefined): void => {
    if (!run || !isBlockGesture(view)) return
    e.preventDefault()
    e.stopPropagation()
    markCaret()
    run()
  }

  const view = new EditorView({
    parent: root,
    state: EditorState.create({
      doc: initial ? codeTextOf(initial) : '',
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
          // ⌘⇧C：空选区复制整块纯文本。有划选不接管（那一档用 ⌘C 的文本复制）。
          {
            key: 'Mod-Shift-c',
            run: (v) => {
              if (!onCopyBlockText || !isBlockGesture(v)) return false
              markCaret()
              onCopyBlockText()
              return true
            },
          },
          // ⌘↵：切任务（代码块也能是任务）。岛内接管并 stopPropagation，
          // 否则 CM6 默认的 insertBlankLine 会同时插一行、应用层还会再切一次。
          { key: 'Mod-Enter', run: () => { onToggleTask?.(); return true }, stopPropagation: true },
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
            // 代码文档住 `_code`（身体），行文本（标题）不动：两者是两块不同的字
            tx.patch(blockId, (b) => {
              const props = { ...(b.props ?? {}) }
              if (text === '') delete props[CODE_TEXT_PROP]
              else props[CODE_TEXT_PROP] = text
              if (Object.keys(props).length === 0) delete b.props
              else b.props = props
            })
            return true
          })
          if (ok) ed.finishUndoEntry('insert', Date.now())
          else ed.abortUndoEntry()
          markCaret()
        }),
      ],
    }),
  })
  void loadCodeLanguage(lang).then((ext) => {
    if (!disposed) view.dispatch({ effects: languageSlot.reconfigure(ext) })
  })

  /** 外部写入（撤销、别的表面改同一块）才回灌；自己的写文本已一致，不回灌 */
  const unsubscribe = ed.store.subscribe((_source, ids) => {
    if (disposed || applyingExternal) return
    if (ids && !ids.includes(blockId)) return
    const b = ed.store.find(blockId)
    if (!b) return
    const model = codeTextOf(b)
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
  /**
   * **capture 是关键**：bubble 阶段太晚——CM6 的 `cut` 已经把当前行删掉了。
   * 空选区在这里被我们接走，有划选／多光标不拦，CM6 的原生文本语义照走。
   */
  const onCopyEvent = (e: ClipboardEvent) => claimBlockClipboard(e, onCopyBlock)
  const onCutEvent = (e: ClipboardEvent) => claimBlockClipboard(e, onCutBlock)
  root.addEventListener('copy', onCopyEvent, true)
  root.addEventListener('cut', onCutEvent, true)
  root.addEventListener('contextmenu', openMenu)
  root.addEventListener('mouseup', ensureCaret)
  view.dom.addEventListener('focusin', markCaret)
  /**
   * ⌘↵ 走应用层切任务，`structTail` 会重画这一行，焦点会掉出去。
   * 只在这种「命令引发的焦点丢失」后补回岛内，用户主动点别处不抢。
   *
   * ⚠️ 只认**恰好** ⌘↵：⌘⇧↵（在上一块插入）与 ⌥↵ 都是结构命令，光标该跟着
   *    **新块**走；一并补回岛内就会出现「新块建好了、竖线也画上了，打的字却进代码」。
   */
  let restoreAfterCommand = false
  const noteCommandKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.shiftKey && !e.altKey) restoreAfterCommand = true
  }
  const onFocusOut = () => {
    if (!restoreAfterCommand) return
    restoreAfterCommand = false
    queueMicrotask(() => {
      if (disposed) return
      view.focus()
      markCaret()
    })
  }
  root.addEventListener('keydown', noteCommandKey, true)
  view.dom.addEventListener('focusout', onFocusOut)

  return {
    root,
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
      root.removeEventListener('copy', onCopyEvent, true)
      root.removeEventListener('cut', onCutEvent, true)
      root.removeEventListener('contextmenu', openMenu)
      root.removeEventListener('mouseup', ensureCaret)
      root.removeEventListener('keydown', noteCommandKey, true)
      view.dom.removeEventListener('focusin', markCaret)
      view.dom.removeEventListener('focusout', onFocusOut)
      view.destroy()
      root.remove()
    },
  }
}
