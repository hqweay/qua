/**
 * 代码块的纯判据：语言别名、撤销合并、外部写回守卫、高度上限的 token。
 *
 * 这里不 import CodeMirror —— 编辑器实现可以换，数据口径不能跟着换。
 */
export const CODE_LANGS = [
  'plain',
  'javascript',
  'typescript',
  'jsx',
  'tsx',
  'python',
  'json',
  'html',
  'css',
  'sql',
  'bash',
  'yaml',
  'markdown',
] as const
export type CodeLang = (typeof CODE_LANGS)[number]

const ALIASES: Readonly<Record<string, CodeLang>> = {
  js: 'javascript', javascript: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', typescript: 'typescript',
  jsx: 'jsx', tsx: 'tsx',
  py: 'python', python: 'python',
  json: 'json', jsonc: 'json',
  html: 'html', htm: 'html', xml: 'html',
  css: 'css', scss: 'css', less: 'css',
  sql: 'sql',
  sh: 'bash', shell: 'bash', bash: 'bash', zsh: 'bash',
  yml: 'yaml', yaml: 'yaml',
  md: 'markdown', markdown: 'markdown',
}

/** 未认识的语言按纯文本画；这是渲染口径，不改盘上的 `_lang` */
export function canonicalLang(raw?: string): CodeLang {
  const key = (raw ?? '').trim().toLowerCase()
  return key === '' ? 'plain' : ALIASES[key] ?? 'plain'
}

/** 存语言：认识的收成规范名，不认识的**原文照存**（不静默吞掉用户/插件写的名字） */
export function normalizeStoredLang(raw?: string): string | undefined {
  const key = (raw ?? '').trim()
  if (key === '') return undefined
  return ALIASES[key.toLowerCase()] ?? key
}

/** 代码岛的 DOM 标记：外层 dispatch 与内层焦点靠它分家 */
export const CODE_ISLAND_ATTR = 'data-code-island'
/** 高度上限住在 token 段（约 60vh），组件只引 token 不写长度字面量 */
export const CODE_MAX_HEIGHT_TOKEN = '--ui-code-max-h'

export interface CodeEditStamp {
  at: number
  /** 这次改动在文档里的起点（plain 偏移） */
  from: number
  inserted: number
  deleted: number
}

/**
 * 连续输入合并成一步撤销：时间窗内、位置相接、只有插入、且前后两笔都没删字。
 * 搜索替换、粘贴、删除都单独成步 —— 一次操作在撤销栈里就该是一次。
 */
export function shouldMergeCodeUndo(prev: CodeEditStamp | null, next: CodeEditStamp): boolean {
  if (!prev || next.deleted > 0 || prev.deleted > 0 || next.inserted === 0) return false
  return next.at - prev.at <= 400 && next.from === prev.from + prev.inserted
}

/** 外部写回守卫：模型文本与岛内文本已经一致时不再 dispatch（自己的写不要回灌） */
export function codeNeedsWriteBack(modelText: string, viewText: string): boolean {
  return modelText !== viewText
}
