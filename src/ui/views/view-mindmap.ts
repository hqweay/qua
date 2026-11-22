/**
 * **思维导图**：把一棵**子树**摊成「根在中间、分支向两侧铺开」的节点图。
 *
 * 四条判据：
 *   · **只接 children 源**：查询命中是一批平的行、收藏是一批引用 ——
 *     它们没有「根」可言，画成导图等于凭空指定谁是根。这件事由
 *     `STORED_KINDS_BY_SOURCE` 在**写入前**拦掉，不靠渲染器再判一次。
 *   · **HTML 画节点、SVG 画边**：节点里要能放文字与图标（并在窄宽下省略），
 *     那是 HTML 的事；连线只是一段三次贝塞尔，用 SVG 一次画完。
 *     ⚠️ 两者**必须同一坐标系**：节点按 px 定位，边也按同一份 px 画。
 *     旧版给 SVG 一个更小的 viewBox 靠 `preserveAspectRatio` 撑满 —— 线被缩放了、
 *     节点没有，于是每条线都落不到节点边上（实测截图的扇形乱线就是这个）。
 *   · **父居中于子**：纵向位置由「叶子按序占槽、父取首末孩子的中点」推出，
 *     不是按「第几层第几个」平铺 —— 平铺会把不同父的兄弟挤成一列，父子连线横穿别家。
 *   · **节点上限是软的**：超过就只画前 N 个并**说出来**。
 *     静默截断会让用户以为「这棵树就这么大」，而那是最容易搞错的一件事。
 */
import { walkForest } from '../../core/model/walk.ts'
import { t } from '../../core/infra/msg.ts'
import { viewNote } from './view-note.ts'
import { openActionOf, type Block, type OpenAction } from '../../core/index.ts'
import type { BlockStore, ViewConfig } from '../../core/index.ts'

export interface ViewMindmapDeps {
  store: BlockStore
  /** 根（children 源的容器） */
  root: () => Block | undefined
  view: () => ViewConfig | null
  projectTitle: (block: Block, into: HTMLElement) => void
  openBlock: (blockId: string, place?: OpenAction) => void
}

/** 节点上限：超过就只画这些（并说出来） */
export const MINDMAP_CAP = 500

/** 节点几何（px）：列宽、列间距、行距。CSS 的宽高都从这里来，只此一份。 */
const NODE_W = 176
/** 卡片最小高（单行）；实际高度量出来——三行的卡片本就该更高 */
const NODE_H_MIN = 32
const COL_GAP = 40
const ROW_GAP = 10
const PAD = 24
const STEP = NODE_W + COL_GAP

interface Node {
  block: Block
  depth: number
  /** 实测高度：一行与三行的卡片不该一样高（空卡片读起来像一格占位） */
  h: number
  /** 分支方向：根的孩子分到两侧时，左边那侧的边要镜像 */
  dir: 1 | -1
  parent: Node | undefined
  children: Node[]
  /** 自己所属的一级分支（根的孩子之一）；根自己指向根。分侧布局按它归类 */
  side: Node | undefined
  /** 画布坐标：左上角 x、纵向中心 y */
  x: number
  y: number
}

export class ViewMindmap {
  readonly root: HTMLElement
  private readonly deps: ViewMindmapDeps
  /** 画布宽度变了才把横滚重新对中（否则用户拖到右边读分支，一次外来编辑就把他拽回原点） */
  private lastW = -1

  constructor(deps: ViewMindmapDeps) {
    this.deps = deps
    this.root = document.createElement('section')
    this.root.className = 'vm'
  }

  dispose(): void {}

  /**
   * 逐块修补：**碰得到这棵树才重画**。
   *
   * 视图宿主的逐块通知是每种 kind 一行（漏接＝配置写进去了、屏幕不动）。
   * 导图比表格粗糙一档：节点文字变了没有「那一格」可局部改，整张图重铺一遍最省心；
   * 但**别的块打字不该让这张图重排**（每次按键重铺几百个节点），所以先问一句撞没撞上。
   */
  sync(ids: readonly string[]): void {
    const base = this.deps.root()
    if (!base) return
    const hit = new Set(ids)
    if (hit.has(base.id)) {
      this.render()
      return
    }
    let touched = false
    walkForest([base], (b) => {
      if (hit.has(b.id)) {
        touched = true
        return false
      }
    })
    if (touched) this.render()
  }

  render(): void {
    const base = this.deps.root()
    this.root.replaceChildren()
    if (!base) return

    // 走树只经 `walkForest`（`arch-check [22]`）：自己写一份递归＝多一份「哪些块算活着」
    // 先序 ⇒ 父一定排在子之前，下面按 id 挂孩子不需要两遍。
    const flat: { block: Block; depth: number; parentId: string | undefined }[] = []
    walkForest([base], (b, ctx) => {
      if (flat.length >= MINDMAP_CAP * 2) return false
      flat.push({ block: b, depth: ctx.path.length - 1, parentId: ctx.parent?.id })
    })
    if (flat.length <= 1) {
      this.root.appendChild(viewNote(t('ui.mindmap.empty')))
      return
    }

    const capped = flat.slice(0, MINDMAP_CAP)
    if (flat.length > MINDMAP_CAP) {
      const note = document.createElement('p')
      note.className = 'vm-note'
      note.textContent = t('ui.mindmap.tooBig', { n: String(flat.length), cap: String(MINDMAP_CAP) })
      this.root.appendChild(note)
    }

    const made = new Map<string, Node>()
    for (const f of capped) {
      made.set(f.block.id, {
        block: f.block,
        depth: f.depth,
        dir: 1,
        parent: undefined,
        children: [],
        side: undefined,
        h: NODE_H_MIN,
        x: 0,
        y: 0,
      })
    }
    const rootNode = made.get(base.id)
    if (!rootNode) return
    rootNode.side = rootNode
    for (const f of capped) {
      const node = made.get(f.block.id)!
      const parent = f.parentId ? made.get(f.parentId) : undefined
      if (!parent) continue
      node.parent = parent
      parent.children.push(node)
      // 先序 ⇒ 父的 side 已经定好；根的一级孩子各自成一侧
      node.side = parent === rootNode ? node : parent.side
    }

    // 根的孩子分到两侧（`direction: 'both'`，默认），按叶子数平分成两半：
    // 单侧会长成一条很宽的链，两侧铺开才像一张导图。`'right'` 时全部向右。
    const order = [...made.values()] // 先序：父在子前
    // 叶子数用逆序累加（children 一定排在父之后）——不走递归，遍历入口只有 walkForest
    const weight = new Map<Node, number>()
    for (let i = order.length - 1; i >= 0; i--) {
      const n = order[i]!
      weight.set(n, n.children.length ? n.children.reduce((s, c) => s + (weight.get(c) ?? 1), 0) : 1)
    }
    const rightSide = new Set<Node>()
    const leftSide = new Set<Node>()
    if (this.deps.view()?.mindmap?.direction === 'right') {
      for (const c of rootNode.children) rightSide.add(c)
    } else {
      const total = rootNode.children.reduce((s, c) => s + (weight.get(c) ?? 1), 0)
      let acc = 0
      for (const c of rootNode.children) {
        if (acc * 2 < total) {
          rightSide.add(c)
          acc += weight.get(c) ?? 1
        } else {
          leftSide.add(c)
        }
      }
    }

    // 先造卡片再排版：卡片高由**文字折成几行**决定（一行与三行不该一样高），
    // 只有挂上去量一次 `offsetHeight` 才知道。绝对定位 ＋ 定宽 ⇒ 量高不受彼此位置影响。
    const canvas = document.createElement('div')
    canvas.className = 'vm-canvas'
    const cards = new Map<string, HTMLButtonElement>()
    for (const n of order) {
      const card = document.createElement('button')
      card.type = 'button'
      card.className = 'vm-node'
      card.dataset.blockId = n.block.id
      card.dataset.depth = String(n.depth)
      card.dataset.dir = n.dir === 1 ? 'right' : 'left'
      // 层级只影响文字轻重：根与一层是正文色，二层起退成次级
      card.dataset.tier = String(Math.min(n.depth, 2))
      card.style.width = CSS.px(NODE_W).toString()

      const text = document.createElement('span')
      text.className = 'vm-node-text'
      this.deps.projectTitle(n.block, text)
      const full = text.textContent?.trim() ?? ''
      if (!full) {
        // 空标题也画出来：它是树里的一格（可能还带着子块），消失会让父子的层级断掉
        text.textContent = '—'
        text.classList.add('vm-node-text--empty')
      } else if (full.length > 28) {
        // 省略号之外再给一条完整的：导图节点是截断的，正文入口在点击之后
        card.dataset.tip = full
      }
      card.appendChild(text)
      card.addEventListener('click', (e) => this.deps.openBlock(n.block.id, openActionOf(e)))
      canvas.appendChild(card)
      cards.set(n.block.id, card)
      n.h = Math.max(NODE_H_MIN, card.offsetHeight)
    }

    /** 一侧的布局：叶子按先序占纵向槽，父取首末孩子中点（逆序保证孩子已有 y）；整侧再对中到根（y=0） */
    const layoutSide = (side: Set<Node>, dir: 1 | -1): void => {
      if (!side.size) return
      const nodes = order.filter((n) => n.side !== undefined && side.has(n.side))
      let cursor = 0
      for (const n of nodes) {
        n.dir = dir
        // 左侧按**右缘**贴住父的左缘往回退一个列距：左移多算一整个节点宽会让
        // 左右两边的缝不对称（实测左支离根比右支远一个卡片宽）
        n.x = dir === 1 ? n.depth * STEP : -n.depth * STEP
        if (!n.children.length) {
          n.y = cursor + n.h / 2
          cursor += n.h + ROW_GAP
        }
      }
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i]!
        if (n.children.length) n.y = (n.children[0]!.y + n.children[n.children.length - 1]!.y) / 2
      }
      let min = Infinity
      let max = -Infinity
      for (const n of nodes) {
        min = Math.min(min, n.y - n.h / 2)
        max = Math.max(max, n.y + n.h / 2)
      }
      const shift = -(min + max) / 2
      for (const n of nodes) n.y += shift
    }
    layoutSide(rightSide, 1)
    layoutSide(leftSide, -1)

    // 画布尺寸＝全部节点的包围盒 ＋ 内边距；两边的负坐标统一平移进正区间
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const n of made.values()) {
      minX = Math.min(minX, n.x)
      maxX = Math.max(maxX, n.x + NODE_W)
      minY = Math.min(minY, n.y - n.h / 2)
      maxY = Math.max(maxY, n.y + n.h / 2)
    }
    const width = maxX - minX + PAD * 2
    const height = maxY - minY + PAD * 2
    const dx = PAD - minX
    const dy = PAD - minY

    // 边要在画布坐标里画；节点位置也在这时落下去（此前只用来量高）
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('class', 'vm-edges')
    svg.setAttribute('width', String(width))
    svg.setAttribute('height', String(height))
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
    for (const n of made.values()) {
      const parent = n.parent
      if (!parent) continue
      // 从父的**朝向那一侧**的边出发，落到孩子朝向根的那条边；控制点各退半步
      const x1 = parent.x + (n.dir === 1 ? NODE_W : 0) + dx
      const y1 = parent.y + dy
      const x2 = n.x + (n.dir === 1 ? 0 : NODE_W) + dx
      const y2 = n.y + dy
      const bend = Math.max(24, Math.abs(x2 - x1) * 0.45)
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', `M ${x1} ${y1} C ${x1 + n.dir * bend} ${y1}, ${x2 - n.dir * bend} ${y2}, ${x2} ${y2}`)
      path.setAttribute('class', 'vm-edge')
      svg.appendChild(path)
    }
    canvas.insertBefore(svg, canvas.firstChild)

    for (const n of made.values()) {
      const card = cards.get(n.block.id)
      if (!card) continue
      card.style.left = CSS.px(n.x + dx).toString()
      card.style.top = CSS.px(n.y - n.h / 2 + dy).toString()
    }
    canvas.style.width = CSS.px(width).toString()
    canvas.style.height = CSS.px(height).toString()
    this.root.appendChild(canvas)
    // 两侧铺开的图比面板宽时，初始横滚要落在**根**上（默认停在最左＝用户先看到一条支线，
    // 根在屏幕外）。宽度变了才重对中；同一个宽度下的重绘保留用户自己拖到的位置。
    // ⚠️ 必须等一拍：这里刚 `replaceChildren`，父面板可能还没按新内容定宽，
    //    当场量到的 `clientWidth` 是旧的（实测 fallback 到 0 ⇒ `scrollLeft` 被钳成 0）。
    if (width !== this.lastW) {
      this.lastW = width
      requestAnimationFrame(() => {
        if (this.lastW !== width) return // 这一拍之间又重画过，交给那次
        const vm = this.root
        const rootCenter = dx + rootNode.x + NODE_W / 2
        vm.scrollLeft = Math.max(0, rootCenter - vm.clientWidth / 2)
      })
    }
  }
}
