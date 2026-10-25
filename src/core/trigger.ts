/**
 * **触发字符检测**：从「光标前的正文」判断此刻是不是在敲一个引导符号的查询词。
 *
 * 为什么是纯字符串函数、住在 core：三个触发字符的**边界规则是语法**，不是界面。
 * 放在这里才能被单测逐条钉住（真浏览器只能验「敲进去弹没弹」，而挡掉 `C#`／email
 * 这类判据恰恰是「不该弹」的那一半，界面测试很难逐个覆盖）。
 *
 * 三个字符各有自己的判据（这张表就是**唯一**的分派点，不在调用方写 `if`）：
 *   · `/` —— 行首或空白之后，查询词里不能再有空白或 `/`（斜杠菜单一直以来的规则）；
 *   · `#` —— 复用 `trailingHashTag` 的判断（前面是字不算、URL fragment 不算）；
 *   · `@` —— 前面不能是字母/数字（挡掉 email 地址里的 `@`）。
 *
 * ⚠️ **最近的触发字符说了算**：`@a` 之后又敲 `#`，该判的是 `#` 那一段，
 *    而不是把 `#` 也算进 `@` 的查询词里。若最近那个字符自己判不成立（如 `a#b`），
 *    结论是「这里没有触发」——**不回头**启用更早的那个，否则 `#` 已经敲完的语法会诈尸。
 *
 * ⚠️ 组合期（输入法中间态）在**参数**里挡：纯函数看不见输入法，只有事件层知道
 *    `compositionstart` 发生过。把判据收在这里，调用方就不会各自忘一次。
 */
import { hashStartAt, trailingHashTag } from './tags.ts'

export type TriggerChar = '/' | '#' | '@'

/** 查询词上限（沿用斜杠菜单一直以来的 20 字，超了就当作「这段语法已经结束」） */
export const TRIGGER_QUERY_MAX = 20

export interface TriggerHit {
  ch: TriggerChar
  /** 触发字符在「光标前的投影文本」里的下标 */
  from: number
  /** 触发字符与光标之间的那段字 */
  query: string
}

/**
 * 一个触发字符的判据。
 *
 * `match(text, at)` 里的 `text` 是**光标前的整段投影文本**（不是从触发字符起切的）：
 * 「前面是不是字」「是不是 URL」这类判据要看得到上下文。
 */
export interface TriggerRule {
  ch: TriggerChar
  match: (text: string, at: number) => string | null
}

export const TRIGGER_RULES: readonly TriggerRule[] = [
  {
    ch: '/',
    match: (text, at) => {
      // 行首或空白之后才算：`a/b`、`https://x` 里的斜杠是正文/链接，不是命令
      if (at > 0 && !/\s/.test(text[at - 1]!)) return null
      const rest = text.slice(at + 1)
      if (rest.length > TRIGGER_QUERY_MAX || /[\s/]/.test(rest)) return null
      return rest
    },
  },
  {
    ch: '#',
    match: (text, at) => {
      // 边界判据与「`#名字` 挨着什么才算敲完」是同一份（`hashStartAt`）：
      // 前面是字 ⇒ `C#`；是链接 ⇒ URL fragment —— 两种都不该弹
      if (!hashStartAt(text, at)) return null
      const rest = text.slice(at + 1)
      // 光一个 `#`：名字还没开始敲。浮层这时就该出现（`#` 之后先空一格就不算语法了）
      if (rest.length === 0) {
        // `##`：后一个 `#` 不是新的语法开头（`#` 之后又一个 `#` 不算）
        if (at > 0 && text[at - 1] === '#') return null
        return ''
      }
      const hit = trailingHashTag(text, { allowEnd: true })
      if (!hit || hit.from !== at) return null
      // 分隔符已经落进正文 ⇒ `#名` 敲完了，这一段不再是「正在输入的查询词」
      if (hit.to !== text.length) return null
      if (hit.name.length > TRIGGER_QUERY_MAX) return null
      return hit.name
    },
  },
  {
    ch: '@',
    match: (text, at) => {
      // 前面是字母/数字 ⇒ 这是 email 里的 @（`a@b.c`），不是「提及」
      if (at > 0 && /[A-Za-z0-9]/.test(text[at - 1]!)) return null
      const rest = text.slice(at + 1)
      if (rest.length > TRIGGER_QUERY_MAX || /\s/.test(rest)) return null
      return rest
    },
  },
]

/**
 * 光标前这段文本里有没有一个**正在输入**的触发词。
 *
 * @param text 光标之前的投影文本（`plainText` 切片；偏移换算由调用方做）
 * @param opts.composing 组合期 ⇒ 一律不触发（输入法中间态里的符号不是语法）
 */
export function detectTrigger(text: string, opts: { composing?: boolean } = {}): TriggerHit | null {
  if (opts.composing) return null
  let at = -1
  let rule: TriggerRule | null = null
  for (const r of TRIGGER_RULES) {
    const i = text.lastIndexOf(r.ch)
    if (i > at) {
      at = i
      rule = r
    }
  }
  if (!rule || at < 0) return null
  const query = rule.match(text, at)
  if (query === null) return null
  return { ch: rule.ch, from: at, query }
}
