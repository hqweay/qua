/**
 * 检索的分词端口与**纯文本切列**（零 I/O，零原生模块）。
 *
 * 为什么要一个端口而不是直接 import `jieba-wasm`：
 *   · 分词器是唯一会随版本变的输入（换词典 ⇒ 旧索引作废），所以它的版本必须写进库；
 *   · `db-rows.ts` 是**行编码的唯一落点**，它不该知道 WASM／拼音库怎么加载；
 *   · 单测可以直接喂一个假的 `cut`／`pinyin`，不必在 Node 里初始化 WASM。
 *
 * 三列各回答一个问题：
 *   · `seg`    —— 词级匹配（jieba 预分词，空格分隔）；
 *   · `chars`  —— 单字／精确子串（CJK 逐字，拉丁词整段保留）；
 *   · `pinyin` —— 拼音音节前缀（每个汉字一个音节）。
 *
 * ⚠️ **`chars` 必须逐字空格分隔**：`unicode61` 会把「笔记」当成一个 token，
 *    而列里是「笔」「记」两个 token ⇒ `chars : 笔记` 静默 0 命中。
 *    查询端只能写 `chars : "笔 记"`（逐字 phrase），见 `query.ts`。
 */

/**
 * 索引版本：分词器或**行的投影口径**一变，旧索引就必须全量重建（写进 `meta.fts_tokenizer`）。
 *
 * 它是派生数据的版本，不是库版本：重建读的是当前森林，所以不需要动 `WORKSPACE_VERSION`
 * 或表结构，下次启动发现版本不一致会自己重铺。
 */
export const FTS_TOKENIZER_VERSION = 'jieba-wasm@2.4.0+pinyin-pro@3.29.5:v2'

export interface TokenizedText {
  /** 词级：空格分隔 */
  seg: string
  /** 单字／子串：CJK 逐字，拉丁／数字整段 */
  chars: string
  /** 拼音：空格分隔的音节 */
  pinyin: string
}

/** jieba 的 `cut(text, hmm)`；只依赖这一个函数，适配器可以在主线程或 worker 里 */
export type CutFn = (text: string, hmm?: boolean) => string[]

/** `pinyin-pro` 的 `pinyin(text, options)`，`type:'array'` 时返回音节数组 */
export type PinyinFn = (text: string, opts: Record<string, unknown>) => string[]

const HAN = /\p{Script=Han}/u
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const LATIN_RUN = /[A-Za-z0-9_]+/g

/**
 * 一段正文 → 三列。
 *
 * 纯函数：同样的 `cut`／`pinyin` 永远同样的输出。这样「重建」与「增量」两条路
 * 可以拿同一个函数对账（A4：`rebuild == 增量`）。
 */
export function tokenizeText(text: string, cut: CutFn, pinyin: PinyinFn): TokenizedText {
  if (text.trim() === '') return { seg: '', chars: '', pinyin: '' }

  const seg = cut(text, true)
    .map((x) => x.trim())
    .filter((x) => x !== '')
    .join(' ')

  const chars = charsOf(text)
  const py = pinyin(text, { toneType: 'none', type: 'array', nonZh: 'removed' })
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x !== '')
    .join(' ')

  return { seg, chars, pinyin: py }
}

/**
 * `chars` 列的拼法。
 *
 * 为什么 CJK 逐字、拉丁整段：中文的「两个字」在 `unicode61` 下是**一个** token，
 * 拆开才能用逐字 phrase 找回「词中字」；而 `CodeMirror` 这类拉丁串拆成单字母
 * 既查不动也没意义，整段反而能被前缀查询命中。
 */
export function charsOf(text: string): string {
  const out: string[] = []
  let latin = ''
  const flush = (): void => {
    if (latin !== '') {
      out.push(latin)
      latin = ''
    }
  }
  for (const ch of text) {
    if (CJK.test(ch)) {
      flush()
      out.push(ch)
      continue
    }
    if (/[A-Za-z0-9_]/.test(ch)) {
      latin += ch
      continue
    }
    flush()
  }
  flush()
  return out.join(' ')
}

/** 这一段文本里有没有汉字（决定查询要不要走 `chars` 逐字兜底） */
export function hasHan(text: string): boolean {
  return HAN.test(text)
}

/** 取文本里的汉字串（拼音列只对汉字有意义；拉丁串由 seg／chars 两列负责） */
export function hanRuns(text: string): string[] {
  return text.match(/\p{Script=Han}+/gu) ?? []
}

/** 断言用：这个文本里的拉丁串（与 `chars` 的整段保留同一口径） */
export function latinRuns(text: string): string[] {
  return text.match(LATIN_RUN) ?? []
}
