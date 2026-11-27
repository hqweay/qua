/**
 * 代码块的纯判据：**语言表**、别名、外部写回守卫、高度上限的 token。
 *
 * **一表就是全部**：徽章上的字、块菜单里那一族语言行、按需加载点都从 `LANG_TABLE`
 * 派生 —— 加一门语言只改这张表（加载点的实现仍在 `code-island`，那张加载表按
 * 这里的 `native` 分派）。
 *
 * 这里不 import CodeMirror —— 编辑器实现可以换，数据口径不能跟着换。
 */
import { t } from './msg.ts'

/**
 * 官方语言包（`@codemirror/lang-*`）的**家族名**：一个包服务多门语言
 * （js 家族一门包同时给出 js／ts／jsx／tsx 四种语法）。
 *
 * 其余语言走 `@codemirror/legacy-modes`，它们的加载点按**语言 id** 登记在
 * `code-island` 里（那部分带动态 import，属于实现，不属于这张数据表）。
 */
export type NativeLang = 'javascript' | 'python' | 'json' | 'html' | 'css' | 'sql' | 'markdown' | 'php'

interface LangRow {
  /** 规范名＝落盘值（`_lang`） */
  readonly id: string
  /** 徽章与菜单上的字（语言名是专名，不进文案表；只有「纯文本」是解释性文案） */
  readonly label: string
  /** 其它写法（小写，不含规范名自己——规范名总是认的） */
  readonly aliases?: readonly string[]
  /** 官方包家族；没有它就必须在 `code-island` 的 legacy 加载表里有一行 */
  readonly native?: NativeLang
}

/**
 * 语言清单：**顺序就是菜单顺序**（常用的在前往后，既有菜单的相对次序保持不变）。
 *
 * 取舍：主流语言 ＋ 常见配置／标记格式 ＋ 笔记里真会贴的几种（diff／http／latex／
 * protobuf／wast）；不收玩具语言（brainfuck、asciiarmor 这类）——「尽量全」要覆盖
 * 真实的代码，不是收全目录。
 */
const LANG_TABLE = [
  { id: 'plain', label: t('ui.code.lang.plain') },
  { id: 'javascript', label: 'JavaScript', aliases: ['js', 'mjs', 'cjs'], native: 'javascript' },
  { id: 'typescript', label: 'TypeScript', aliases: ['ts', 'mts', 'cts'], native: 'javascript' },
  { id: 'jsx', label: 'JSX', native: 'javascript' },
  { id: 'tsx', label: 'TSX', native: 'javascript' },
  { id: 'python', label: 'Python', aliases: ['py'], native: 'python' },
  { id: 'json', label: 'JSON', aliases: ['jsonc'], native: 'json' },
  { id: 'html', label: 'HTML', aliases: ['htm'], native: 'html' },
  { id: 'css', label: 'CSS', aliases: ['less'], native: 'css' },
  { id: 'sql', label: 'SQL', aliases: ['mysql', 'postgres', 'postgresql', 'sqlite', 'plsql'], native: 'sql' },
  { id: 'bash', label: 'Bash', aliases: ['sh', 'shell', 'zsh', 'ksh'] },
  { id: 'yaml', label: 'YAML', aliases: ['yml'] },
  { id: 'markdown', label: 'Markdown', aliases: ['md', 'mdx'], native: 'markdown' },
  { id: 'scss', label: 'SCSS', aliases: ['sass'] },
  { id: 'xml', label: 'XML', aliases: ['svg'] },
  { id: 'toml', label: 'TOML' },
  { id: 'ini', label: 'INI', aliases: ['properties', 'conf', 'config'] },
  { id: 'diff', label: 'Diff', aliases: ['patch'] },
  { id: 'http', label: 'HTTP' },
  { id: 'latex', label: 'LaTeX', aliases: ['tex'] },
  { id: 'protobuf', label: 'Protobuf', aliases: ['proto'] },
  { id: 'java', label: 'Java' },
  { id: 'kotlin', label: 'Kotlin', aliases: ['kt', 'kts'] },
  { id: 'scala', label: 'Scala' },
  { id: 'c', label: 'C' },
  { id: 'cpp', label: 'C++', aliases: ['c++', 'cc', 'cxx'] },
  { id: 'csharp', label: 'C#', aliases: ['cs', 'c#'] },
  { id: 'go', label: 'Go', aliases: ['golang'] },
  { id: 'rust', label: 'Rust', aliases: ['rs'] },
  { id: 'swift', label: 'Swift' },
  { id: 'objectivec', label: 'Objective-C', aliases: ['objc', 'm'] },
  { id: 'ruby', label: 'Ruby', aliases: ['rb'] },
  { id: 'php', label: 'PHP', aliases: ['phtml'], native: 'php' },
  { id: 'perl', label: 'Perl', aliases: ['pl'] },
  { id: 'lua', label: 'Lua' },
  { id: 'r', label: 'R' },
  { id: 'julia', label: 'Julia', aliases: ['jl'] },
  { id: 'dart', label: 'Dart' },
  { id: 'groovy', label: 'Groovy' },
  { id: 'haskell', label: 'Haskell', aliases: ['hs'] },
  { id: 'erlang', label: 'Erlang', aliases: ['erl'] },
  { id: 'clojure', label: 'Clojure', aliases: ['clj', 'cljs', 'cljc'] },
  { id: 'scheme', label: 'Scheme', aliases: ['scm'] },
  { id: 'ocaml', label: 'OCaml', aliases: ['ml'] },
  { id: 'fsharp', label: 'F#', aliases: ['fs', 'f#'] },
  { id: 'elm', label: 'Elm' },
  { id: 'crystal', label: 'Crystal', aliases: ['cr'] },
  { id: 'coffeescript', label: 'CoffeeScript', aliases: ['coffee'] },
  { id: 'vb', label: 'Visual Basic', aliases: ['vbnet', 'vb.net', 'vbscript'] },
  { id: 'pascal', label: 'Pascal', aliases: ['delphi'] },
  { id: 'fortran', label: 'Fortran', aliases: ['f90', 'f95'] },
  { id: 'matlab', label: 'MATLAB / Octave', aliases: ['octave'] },
  { id: 'powershell', label: 'PowerShell', aliases: ['ps1', 'pwsh'] },
  { id: 'dockerfile', label: 'Dockerfile', aliases: ['docker'] },
  { id: 'nginx', label: 'Nginx' },
  { id: 'cmake', label: 'CMake' },
  { id: 'verilog', label: 'Verilog', aliases: ['sv'] },
  { id: 'vhdl', label: 'VHDL' },
  { id: 'wast', label: 'WebAssembly', aliases: ['wat', 'wasm'] },
] as const satisfies readonly LangRow[]

export type CodeLang = (typeof LANG_TABLE)[number]['id']
export type CodeLangDecl = LangRow & { readonly id: CodeLang }

/** 语言清单（菜单与徽章的**唯一来源**）；`plain` 恒在首位 */
export const CODE_LANG_DECLS: readonly CodeLangDecl[] = LANG_TABLE
export const CODE_LANGS: readonly CodeLang[] = LANG_TABLE.map((d) => d.id)

const ALIAS: Readonly<Record<string, CodeLang>> = (() => {
  const m: Record<string, CodeLang> = {}
  for (const d of LANG_TABLE) {
    m[d.id] = d.id
    for (const a of (d as LangRow).aliases ?? []) m[a] = d.id
  }
  return m
})()

const LABEL_OF: Readonly<Record<string, string>> = (() => {
  const m: Record<string, string> = {}
  for (const d of LANG_TABLE) m[d.id] = d.label
  return m
})()

/** 未认识的语言按纯文本画；这是渲染口径，不改盘上的 `_lang` */
export function canonicalLang(raw?: string): CodeLang {
  const key = (raw ?? '').trim().toLowerCase()
  return key === '' ? 'plain' : ALIAS[key] ?? 'plain'
}

/**
 * 徽章与菜单上的字（菜单行由语言表生成，走同一个答案）。
 *
 * **不认识的写法照原文显示**：盘上 `_lang: 'zig'` 就写 `zig` —— 用户读到的
 * 「没有高亮」与「这是 zig」同时成立；若收成「纯文本」，他看不出自己贴过什么。
 */
export function codeLangLabel(raw?: string): string {
  const key = (raw ?? '').trim()
  if (key === '') return LABEL_OF.plain!
  const canon = ALIAS[key.toLowerCase()]
  return canon ? LABEL_OF[canon] ?? key : key
}

/** 存语言：认识的收成规范名，不认识的**原文照存**（不静默吞掉用户/插件写的名字） */
export function normalizeStoredLang(raw?: string): string | undefined {
  const key = (raw ?? '').trim()
  if (key === '') return undefined
  return ALIAS[key.toLowerCase()] ?? key
}

/**
 * 条件树／分组面的选项域：语言表的 `{id,label}` 投影（`plain` 恒在首位）。
 *
 * 与 `codeLangLabel` 同一条语言表；未知语言不在这里（值域是开放的，由值控件按
 * `open` 照原文显示，不假装「已删除」）。
 *
 * ⚠️ 条件值存**规范 id**（`typescript`，不是 `ts`）：与 `_callout` 存记录 id 同一条。
 * 手写 JSON 用别名 `ts` 不保证命中——求值只归一**块上的值**，不改写条件。
 */
export function codeLangChoices(): { id: string; label: string }[] {
  return CODE_LANG_DECLS.map((d) => ({ id: d.id, label: d.label }))
}

/** 代码岛的 DOM 标记：外层 dispatch 与内层焦点靠它分家 */
export const CODE_ISLAND_ATTR = 'data-code-island'
/** 高度上限住在 token 段（约 60vh），组件只引 token 不写长度字面量 */
export const CODE_MAX_HEIGHT_TOKEN = '--ui-code-max-h'

/** 外部写回守卫：模型文本与岛内文本已经一致时不再 dispatch（自己的写不要回灌） */
export function codeNeedsWriteBack(modelText: string, viewText: string): boolean {
  return modelText !== viewText
}
