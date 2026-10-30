/**
 * **思维导图**：把一棵**子树**摊成「根居中、孩子向右排」的节点图。
 *
 * 三条判据：
 *   · **只接 children 源**：查询命中是一批平的行、收藏是一批引用 ——
 *     它们没有「根」可言，画成导图等于凭空指定谁是根。这件事由
 *     `STORED_KINDS_BY_SOURCE` 在**写入前**拦掉，不靠渲染器再判一次。
 *   · **HTML 画节点、SVG 画边**：节点里要能放文字与图标（并在窄宽下省略），
 *     那是 HTML 的事；连线只是一段二次贝塞尔，用 SVG 一次画完。
 *   · **节点上限是软的**：超过就只画前 N 个并**说出来**。
 *     静默截断会让用户以为「这棵树就这么大」，而那是最容易搞错的一件事。
 */
import { walkForest } from '../core/walk.ts'
import { t } from '../core/msg.ts'
import type { Block } from '../core/index.ts'
import type { BlockStore, ViewConfig } from '../core/index.ts'

export interface ViewMindmapDeps {
  store: BlockStore
  /** 根（children 源的容器） */
  root: () => Block | undefined
  view: () => ViewConfig | null
  projectTitle: (block: Block, into: HTMLElement) => void
  openBlock: (blockId: string) => void
}

/** 节点上限：超过就只画这些（并说出来） */
export const MINDMAP_CAP = 500

interface Node {
  block: Block
  depth: number
  /** 父块（画连线用；根没有） */
  parent: Block | undefined
}

export class ViewMindmap {
  readonly root: HTMLElement
  private readonly deps: ViewMindmapDeps

  constructor(deps: ViewMindmapDeps) {
    this.deps = deps
    this.root = document.createElement('section')
    this.root.className = 'vm'
  }

  dispose(): void {}

  render(): void {
    const base = this.deps.root()
    this.root.replaceChildren()
    if (!base) return
    // 走树只经 `walkForest`（`arch-check [22]`）：自己写一份递归＝多一份「哪些块算活着」
    const nodes: Node[] = []
    walkForest([base], (b, ctx) => {
      if (nodes.length >= MINDMAP_CAP * 2) return false
      nodes.push({ block: b, depth: ctx.path.length - 1, parent: ctx.parent ?? undefined })
    })
    if (nodes.length <= 1) {
      const empty = document.createElement('p')
      empty.className = 'tv-unsupported'
      empty.textContent = t('ui.mindmap.empty')
      this.root.appendChild(empty)
      return
    }

    const capped = nodes.slice(0, MINDMAP_CAP)
    if (nodes.length > MINDMAP_CAP) {
      const note = document.createElement('p')
      note.className = 'vm-note'
      note.textContent = t('ui.mindmap.tooBig', { n: String(nodes.length), cap: String(MINDMAP_CAP) })
      this.root.appendChild(note)
    }

    /** 布局：深度决定横向，行决定纵向 —— **根居中**（`translateY` 把它拉到一半） */
    const canvas = document.createElement('div')
    canvas.className = 'vm-canvas'
    const byDepth = new Map<number, number>()
    for (const n of capped) byDepth.set(n.depth, (byDepth.get(n.depth) ?? 0) + 1)

    const pos = new Map<string, { x: number; y: number }>()
    const leftOf: number[] = []
    let acc = 0
    const maxDepth = Math.max(...capped.map((n) => n.depth))
    for (let d = 0; d <= maxDepth; d++) {
      leftOf[d] = acc
      acc += 220
    }

    const seenAt = new Map<number, number>()
    for (const n of capped) {
      const i = seenAt.get(n.depth) ?? 0
      seenAt.set(n.depth, i + 1)
      const total = byDepth.get(n.depth) ?? 1
      // 纵向：这一层里居中排开（根那层只有它自己 ⇒ 落在中线上）
      pos.set(n.block.id, { x: leftOf[n.depth] ?? 0, y: (i - (total - 1) / 2) * 46 })
    }

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('class', 'vm-edges')
    const width = (leftOf[maxDepth] ?? 0) + 200
    const height = Math.max(...[...byDepth.values()]) * 46 + 120
    svg.setAttribute('viewBox', `${-40} ${-height / 2} ${width + 80} ${height}`)
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
    for (const n of capped) {
      const parent = n.parent
      if (!parent) continue
      const a = pos.get(parent.id)
      const b = pos.get(n.block.id)
      if (!a || !b) continue
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      const x1 = a.x + 150
      const y1 = a.y
      const x2 = b.x
      const y2 = b.y
      const mid = (x1 + x2) / 2
      path.setAttribute('d', `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`)
      path.setAttribute('class', 'vm-edge')
      svg.appendChild(path)
    }
    canvas.appendChild(svg)

    for (const n of capped) {
      const at = pos.get(n.block.id)!
      const card = document.createElement('button')
      card.type = 'button'
      card.className = 'vm-node'
      card.dataset.blockId = n.block.id
      card.dataset.depth = String(n.depth)
      card.style.transform = `translate(${at.x}px, ${at.y}px)`
      const text = document.createElement('span')
      text.className = 'vm-node-text ui-ellipsis'
      this.deps.projectTitle(n.block, text)
      card.appendChild(text)
      card.addEventListener('click', () => this.deps.openBlock(n.block.id))
      canvas.appendChild(card)
    }
    this.root.appendChild(canvas)
  }

}
