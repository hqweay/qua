/**
 * `when` 表达式求值器的形状）。
 *
 * 语法（借 VS Code 的语法与优先级）：`!` ／ `&&` ／ `||` ／ `==` ／ `!=` ／ `>` ／ `<` ／
 * `>=` ／ `<=` ／ `=~`（正则匹配）／ `in` ／ `not in`，支持括号。
 * 优先级：`!` > 比较 > `&&` > `||`。
 *
 * 求值是**纯函数**：只读上下文键（`CtxKeys`），不碰 DOM ⇒ 可在 Node 里断言。
 */

// 语法错误的提示也走字典（`err.*`）：v1 只有 zh，但错误提示同样是用户可见文案
import { t } from './msg.ts'

export type WhenValue = unknown
export type WhenCtx = Record<string, WhenValue>

/* ------------------------------------------------------------- 词法 */

type Tok =
  | { t: 'ident'; v: string }
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 're'; v: string }
  | { t: 'op'; v: string }
  | { t: 'eof' }

const OPS = ['&&', '||', '==', '!=', '>=', '<=', '=~', '!', '(', ')', '[', ']', ',']

export function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]!
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      const end = src.indexOf(ch, i + 1)
      if (end < 0) throw new Error(t('err.when.unclosedString', { i }))
      out.push({ t: 'str', v: src.slice(i + 1, end) })
      i = end + 1
      continue
    }
    if (ch === '/') {
      const end = src.indexOf('/', i + 1)
      if (end < 0) throw new Error(t('err.when.unclosedRegex', { i }))
      out.push({ t: 're', v: src.slice(i + 1, end) })
      i = end + 1
      continue
    }
    if (/[0-9]/.test(ch)) {
      let j = i
      while (j < src.length && /[0-9.]/.test(src[j]!)) j++
      out.push({ t: 'num', v: Number(src.slice(i, j)) })
      i = j
      continue
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i
      while (j < src.length && /[A-Za-z0-9_$.]/.test(src[j]!)) j++
      out.push({ t: 'ident', v: src.slice(i, j) })
      i = j
      continue
    }
    const two = src.slice(i, i + 2)
    if (OPS.includes(two)) {
      out.push({ t: 'op', v: two })
      i += 2
      continue
    }
    if (OPS.includes(ch)) {
      out.push({ t: 'op', v: ch })
      i++
      continue
    }
    throw new Error(t('err.when.badChar', { ch: JSON.stringify(ch), i }))
  }
  out.push({ t: 'eof' })
  return out
}

/* ------------------------------------------------------------- 语法 */

type Node =
  | { k: 'lit'; v: WhenValue }
  | { k: 'key'; name: string }
  | { k: 'not'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'arr'; items: Node[] }

class Parser {
  private p = 0
  constructor(private toks: Tok[]) {}

  private peek(): Tok {
    return this.toks[this.p]!
  }
  private eat(): Tok {
    return this.toks[this.p++]!
  }
  private isOp(v: string): boolean {
    const t = this.peek()
    return t.t === 'op' && t.v === v
  }
  private isIdent(v: string): boolean {
    const t = this.peek()
    return t.t === 'ident' && t.v === v
  }

  parse(): Node {
    const n = this.or()
    if (this.peek().t !== 'eof') throw new Error(t('err.when.trailing'))
    return n
  }

  private or(): Node {
    let a = this.and()
    while (this.isOp('||')) {
      this.eat()
      a = { k: 'bin', op: '||', a, b: this.and() }
    }
    return a
  }
  private and(): Node {
    let a = this.cmp()
    while (this.isOp('&&')) {
      this.eat()
      a = { k: 'bin', op: '&&', a, b: this.cmp() }
    }
    return a
  }
  private cmp(): Node {
    const a = this.unary()
    const t = this.peek()
    if (t.t === 'op' && ['==', '!=', '>', '<', '>=', '<=', '=~'].includes(t.v)) {
      this.eat()
      return { k: 'bin', op: t.v, a, b: this.unary() }
    }
    if (this.isIdent('in')) {
      this.eat()
      return { k: 'bin', op: 'in', a, b: this.unary() }
    }
    if (this.isIdent('not') && this.toks[this.p + 1]?.t === 'ident' && (this.toks[this.p + 1] as { v: string }).v === 'in') {
      this.eat()
      this.eat()
      return { k: 'bin', op: 'not in', a, b: this.unary() }
    }
    return a
  }
  private unary(): Node {
    if (this.isOp('!')) {
      this.eat()
      return { k: 'not', a: this.unary() }
    }
    return this.primary()
  }
  private primary(): Node {
    // ⚠️ 这里的局部变量叫 `tok` 而不是 `t`：`t` 是文案函数（上面的 import），不要被遮蔽
    const tok = this.eat()
    if (tok.t === 'op' && tok.v === '(') {
      const n = this.or()
      if (!this.isOp(')')) throw new Error(t('err.when.missingParen'))
      this.eat()
      return n
    }
    if (tok.t === 'op' && tok.v === '[') {
      const items: Node[] = []
      if (!this.isOp(']')) {
        items.push(this.or())
        while (this.isOp(',')) {
          this.eat()
          items.push(this.or())
        }
      }
      if (!this.isOp(']')) throw new Error(t('err.when.missingBracket'))
      this.eat()
      return { k: 'arr', items }
    }
    if (tok.t === 'str') return { k: 'lit', v: tok.v }
    if (tok.t === 're') return { k: 'lit', v: new RegExp(tok.v) }
    if (tok.t === 'num') return { k: 'lit', v: tok.v }
    if (tok.t === 'ident') {
      if (tok.v === 'true') return { k: 'lit', v: true }
      if (tok.v === 'false') return { k: 'lit', v: false }
      if (tok.v === 'null' || tok.v === 'undefined') return { k: 'lit', v: null }
      return { k: 'key', name: tok.v }
    }
    throw new Error(t('err.when.unexpectedToken', { token: JSON.stringify(tok) }))
  }
}

const cache = new Map<string, Node>()

export function parseWhen(expr: string): Node {
  const hit = cache.get(expr)
  if (hit) return hit
  const n = new Parser(tokenize(expr)).parse()
  cache.set(expr, n)
  return n
}

function truthy(v: WhenValue): boolean {
  return Boolean(v)
}

function evalNode(n: Node, ctx: WhenCtx): WhenValue {
  switch (n.k) {
    case 'lit':
      return n.v
    case 'key':
      return ctx[n.name]
    case 'arr':
      return n.items.map((x) => evalNode(x, ctx))
    case 'not':
      return !truthy(evalNode(n.a, ctx))
    case 'bin': {
      if (n.op === '&&') return truthy(evalNode(n.a, ctx)) && truthy(evalNode(n.b, ctx))
      if (n.op === '||') return truthy(evalNode(n.a, ctx)) || truthy(evalNode(n.b, ctx))
      const a = evalNode(n.a, ctx)
      const b = evalNode(n.b, ctx)
      switch (n.op) {
        case '==':
          return a === b
        case '!=':
          return a !== b
        case '>':
          return Number(a) > Number(b)
        case '<':
          return Number(a) < Number(b)
        case '>=':
          return Number(a) >= Number(b)
        case '<=':
          return Number(a) <= Number(b)
        case '=~':
          return typeof a === 'string' && b instanceof RegExp ? b.test(a) : false
        case 'in':
          return Array.isArray(b) ? b.includes(a) : false
        case 'not in':
          return Array.isArray(b) ? !b.includes(a) : true
        default:
          return false
      }
    }
  }
}

/** 求值；表达式语法错误 ⇒ **抛**（开发期就该炸，别静默放行） */
export function evalWhen(expr: string, ctx: WhenCtx): boolean {
  return truthy(evalNode(parseWhen(expr), ctx))
}

/** 容错版：给诊断面板用（语法错也返回 false，并给出原因） */
export function evalWhenSafe(expr: string, ctx: WhenCtx): { ok: boolean; error?: string } {
  try {
    return { ok: evalWhen(expr, ctx) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 表达式里引用到的上下文键名（诊断面板用来高亮未定义的键） */
export function keysIn(expr: string): string[] {
  try {
    const out = new Set<string>()
    const walk = (n: Node): void => {
      if (n.k === 'key') out.add(n.name)
      else if (n.k === 'not') walk(n.a)
      else if (n.k === 'arr') n.items.forEach(walk)
      else if (n.k === 'bin') {
        walk(n.a)
        walk(n.b)
      }
    }
    walk(parseWhen(expr))
    return [...out].sort()
  } catch {
    return []
  }
}
