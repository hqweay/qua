/**
 * 反链计算 —— **纯逻辑，零 DOM**。
 *
 * 判据：右槽默认显示「谁指向了当前对象」。这是对**指向边**的一次查询（承 17 / 29 ），
 * 不是某个组件的事。所以算法住在这里、可脱离 DOM 单测；渲染在 `ui/`。
 *
 * ⚠️ 第 1 期数据源：demo 里指向边被压平成了行内 `page` 原子（`atoms[].target.id`）。
 *   接内核后换成指向边索引（G1 的入向边），**本文件的函数签名不变**（`BackrefSource` 是稳定形状）。
 * ⚠️ 承 64 ：指向不存在的目标（`dangling`）**不算**入向边，但也**不许静默**——
 *   由调用方在界面上呈现（这里只返回能解析的）。
 */
import type { Atom, Block } from './index.ts'

/** 一条反链：谁指向了我。`pageId` 是来源所在的页（点开它）*/
export interface BackrefSource {
  /** 来源页的 id */
  pageId: string
  /** 引用**发生处的那个块**的正文（比页名更有信息量） */
  text: string
  /** 该页里共有几处指向我 */
  count: number
}

export interface BackrefInput {
  /** 块森林（找来源页与命中块） */
  blocks: Block[]
  /** 库级行内原子 */
  atoms: Atom[]
  /** 被指向的对象（当前页） */
  targetId: string
}

/**
 * 扫出所有指向 `targetId` 的入向边，按「来源页」聚合成一条。
 *
 * 聚合判据：同一页里的多处引用**合成一条**（一个窗口对应一个来源，
 * 而不是一处引用一个窗口）。条数用 `count` 表达，不重复占列表位。
 */
export function backrefsOf(input: BackrefInput): BackrefSource[] {
  const { blocks, atoms, targetId } = input

  // 1) 哪些块里出现了指向目标的边
  // ⚠️ 引用与标签**都是指向边**（AK6 的呈现模式表：一个显示 `[[名]]`、一个显示 `#名`）。
  //    以前这里只认 `kind === 'page'` ⇒ 标签块的反链永远是空的，那是个静默的洞。
  const hits = new Map<string, number>()
  for (const a of atoms) {
    if ((a.kind !== 'page' && a.kind !== 'tag') || a.target?.id !== targetId) continue
    hits.set(a.blockId, (hits.get(a.blockId) ?? 0) + 1)
  }
  if (hits.size === 0) return []

  // 2) 归到「来源页」，并取命中块自己的文字做摘要
  const out: BackrefSource[] = []
  for (const page of blocks) {
    if (page.id === targetId) continue
    let first: string | null = null
    let count = 0
    const walk = (nodes: Block[]): void => {
      for (const n of nodes) {
        const c = hits.get(n.id)
        if (c) {
          count += c
          if (first === null) first = n.text.trim()
        }
        walk(n.children)
      }
    }
    walk(page.children)
    if (count === 0) continue
    out.push({
      pageId: page.id,
      // 命中块为空时退回页名（那也比空字符串好）
      text: first !== null && first !== '' ? first : page.text,
      count,
    })
  }
  return out
}

/**
 * **块级反链**（下一层／反链 view block）：返回「引用发生处的那个块」，
 * 而不是按来源页聚合。视图要原地编辑源块，所以必须拿到 block id。
 *
 * 与 `backrefsOf` 的分工：那个给右槽的「页级摘要」；这个给可编辑的反链视图。
 * 同一块多次引用 ⇒ 一行 + count；不同块各自一行。
 */
export interface BackrefBlock {
  blockId: string
  /** 所在顶层页（上下文/跳转用） */
  pageId: string
  text: string
  count: number
}

export function backrefBlocks(input: BackrefInput): BackrefBlock[] {
  const hits = new Map<string, number>()
  for (const a of input.atoms) {
    // 同 `backrefsOf`：引用与标签都是指向边 ⇒ 「标签的成员」就是标签块的反链
    if ((a.kind !== 'page' && a.kind !== 'tag') || a.target?.id !== input.targetId) continue
    hits.set(a.blockId, (hits.get(a.blockId) ?? 0) + 1)
  }
  if (hits.size === 0) return []

  const out: BackrefBlock[] = []
  const walk = (list: readonly Block[], pageId: string): void => {
    for (const b of list) {
      const c = hits.get(b.id)
      if (c) out.push({ blockId: b.id, pageId, text: b.text, count: c })
      walk(b.children, pageId)
    }
  }
  for (const root of input.blocks) walk([root], root.id)
  return out
}
