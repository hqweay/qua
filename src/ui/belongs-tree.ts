/**
 * **归属树面板**（左槽）：一条归属边摊平成一行行导航。
 *
 * 两种露面、同一个摊平函数，只差根集合与图标：**页的归属树**与**标签的归属树**。
 * 主判据：**每个节点至少要在它自己那棵树里可见** —— 所以根不是「模型里没有父」的块，
 * 而是「**本树内**没有可见父」的块（父被露面筛掉 ⇒ 子升级为根）。
 *
 * ⚠️ 这里的行**不是可编辑的块**：`renderBlock` 出来的一行是导航（图标＋名字），
 *    没有 `contenteditable`、不参与选区、不接受正文编辑 —— 与侧槽的窗口卡片
 *    （里面是真编辑器）是两种东西。这也是它便宜的原因。
 * ⚠️ 跨类的边（页挂在标签下）在两棵树里都不画，由属性区的「属于」那一行回答：
 *    树只回答「同类里谁在谁下面」。
 * ⚠️ 拖入＝**加边**（`_belongsTo`），不是把块搬到这棵树里：树是位置，边是关系。
 *    同一个手势落到正文行是「移动」、落到侧槽是「打开窗口」—— 含义由落点说，悬停时就贴出来。
 */
import type { BelongsRow } from '../core/hierarchy.ts'
import { displayNameOf, type Block, type BlockList } from '../core/index.ts'
import { t } from '../core/msg.ts'
import { renderBlock, type BlockRenderCtx } from './block-renderers.ts'
import type { DockCard } from './dock.ts'
import { bindDropTarget, setDragBlock } from '../view/dnd.ts'

export interface BelongsTreeDeps {
  /**
   * 摊平后的归属树（装配层现算：纯函数 ＋ 当次邻接表）。
   *
   * ⚠️ 每次重画都现算，不缓存：根集合随「父的露面」变，缓存一处就会出现
   *    「给 A 加了页露面，A 在树里的位置还是原来的」。
   */
  rows: (face: BlockList) => readonly BelongsRow[]
  activeId: () => string
  /** 点一行：打开它（页/标签都是块，走同一个入口） */
  open: (id: string) => void
  /** Shift+点一行：在右槽打开它 */
  openInDock: (id: string) => void
  /** 换面之后重画这一槽（槽内容由装配层排，组件自己不动别人的 DOM） */
  refresh: () => void
  /** 把一个块归到另一个块下面（拖入的落点含义；由装配层转成命令） */
  link: (childId: string, parentId: string) => void
  untitled: string
}

export class BelongsTree {
  /** 当前看哪一面（**视图状态**：只在这一屏里，不落库、不落设备偏好） */
  private face: BlockList = 'page'
  private readonly deps: BelongsTreeDeps

  constructor(deps: BelongsTreeDeps) {
    this.deps = deps
  }

  /** 每次整槽重画都从这里取一张卡：面（页/标签）由实例记住，不随 DOM 重建丢失 */
  card(): DockCard {
    const body = document.createElement('div')
    body.className = 'belongs-tree'

    const tabs = document.createElement('div')
    tabs.className = 'belongs-tabs'
    for (const [face, label] of [
      ['page', t('ui.belongs.pages')],
      ['tag', t('ui.belongs.tags')],
    ] as const) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'belongs-tab'
      btn.dataset.face = face
      btn.textContent = label
      if (face === this.face) btn.dataset.active = '1'
      btn.setAttribute('aria-pressed', face === this.face ? 'true' : 'false')
      btn.addEventListener('click', () => {
        if (this.face === face) return
        this.face = face
        // 面变了 ⇒ 行与根集合都跟着变；重画交给装配层（槽是它排的）
        this.deps.refresh()
      })
      tabs.appendChild(btn)
    }
    body.appendChild(tabs)

    const ctx: BlockRenderCtx = {
      isActive: (id) => id === this.deps.activeId(),
      onActivate: (b) => this.deps.open(b.id),
      onOpenInDock: (b) => this.deps.openInDock(b.id),
      untitledLabel: this.deps.untitled,
    }

    const rows = this.deps.rows(this.face)
    if (rows.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'dock-empty'
      empty.textContent = this.face === 'page' ? t('ui.belongs.emptyPages') : t('ui.belongs.emptyTags')
      body.appendChild(empty)
    }
    const list = document.createElement('div')
    list.className = 'block-list'
    for (const row of rows) {
      const wrap = document.createElement('div')
      wrap.className = 'belongs-row'
      wrap.dataset.depth = String(row.depth)
      wrap.dataset.belongsId = row.block.id
      wrap.style.setProperty('--depth', String(row.depth))
      wrap.appendChild(renderRow(row.block, ctx))
      // 这一行也是**拖源**：能拿到块 id 就能拖（拖到正文＝移动、拖到另一行＝加边、拖到槽＝打开窗口）
      wrap.draggable = true
      wrap.addEventListener('dragstart', (e) => setDragBlock(e.dataTransfer, row.block.id))
      // 拖一个块到这个 item 上 ⇒ **加边**（不是重排兄弟：兄弟顺序不落盘）
      const name = displayNameOf(row.block).trim() || this.deps.untitled
      bindDropTarget(wrap, {
        effect: 'link',
        targetId: () => row.block.id,
        // 自己落自己没意思（命令层也会拒，但悬停就不该亮）
        accept: (id) => id !== row.block.id,
        hint: () => t('ui.dnd.linkTo', { name }),
        onDrop: (childId, parentId) => {
          if (parentId) this.deps.link(childId, parentId)
        },
      })
      list.appendChild(wrap)
    }
    body.appendChild(list)

    return { id: 'belongs', title: t('ui.belongs.treeTitle'), body }
  }
}

/** 一行导航（与槽里其它块走同一个渲染器；这里只包一个缩进壳） */
function renderRow(b: Block, ctx: BlockRenderCtx): HTMLElement {
  return renderBlock(b, ctx)
}
