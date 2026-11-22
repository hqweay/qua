/**
 * **目录卡**（左槽）：库里四类「结构块」各占一面。
 *
 * 页/标签两面走**归属边**：`belongsToTree` 把 `_belongsTo` 摊成导航行，根按本树重算
 * （父被露面筛掉 ⇒ 子升级为根，否则那块会从树里消失）。
 * 属性/自动化两面走**派生身份**：它们不参与归属组织，只按 `_kind`／`_automation`
 * 从索引列表平铺出来——没有边可摊，所以缩进恒为 0。
 *
 * ⚠️ 两种判据共用一行导航的形状，但只有前两面接拖拽：给身份块「归到它下面」写不进
 *    任何读路径（身份按 id 找、不看位置），亮起来的落点会是半个件。
 * ⚠️ 这里的行不是可编辑的块：`renderBlock` 只出图标＋名字，没有 `contenteditable`。
 */
import type { BelongsRow } from '../../core/relations/hierarchy.ts'
import { blockLabel, type Block, type FindBlock } from '../../core/index.ts'
import type { IdentityKind } from '../../core/model/model.ts'
import { t } from '../../core/infra/msg.ts'
import { renderBlock, type BlockRenderCtx } from '../block-ui/block-renderers.ts'
import { cardList, cardNote } from '../chrome/card-parts.ts'
import type { DockCard } from '../dock/dock.ts'
import { bindDropTarget, setDragBlock } from '../../view/dnd.ts'

/** 面顺序只在这里；新增身份要显式进来，不会从 `IDENTITY_KINDS` 自动漏入。 */
export type DirectoryFace = Extract<IdentityKind, 'page' | 'tag' | 'schema' | 'automation'>
export const DIRECTORY_FACES: readonly DirectoryFace[] = ['page', 'tag', 'schema', 'automation']

export interface BelongsTreeDeps {
  /**
   * 当前面的行（装配层现算）。页/标签走 `belongsToTree`，属性/自动化读索引列表平铺。
   * ⚠️ 每次重画都现算，不缓存：根集合随露面变，缓存会出现「补了露面位置还是旧的」。
   */
  rows: (face: DirectoryFace) => readonly BelongsRow[]
  activeId: () => string
  /** 点一行：打开它（页/标签都是块，落点由 `place` 说） */
  open: (id: string, place?: import('../../core/index.ts').OpenAction) => void
  /** 换面之后重画这一槽（槽内容由装配层排，组件自己不动别人的 DOM） */
  refresh: () => void
  /** 把一个块归到另一个块下面（拖入的落点含义；由装配层转成命令） */
  link: (childId: string, parentId: string) => void
  /** 引用解析用（行名现算引用目标的名字）；不给 ⇒ 引用退回快照名 */
  find?: FindBlock
}

export class BelongsTree {
  /** 当前看哪一面（**视图状态**：只在这一屏里，不落库、不落设备偏好） */
  private face: DirectoryFace = 'page'
  private readonly deps: BelongsTreeDeps

  constructor(deps: BelongsTreeDeps) {
    this.deps = deps
  }

  /** 每次整槽重画都从这里取一张卡：面由实例记住，不随 DOM 重建丢失 */
  card(): DockCard {
    const body = document.createElement('div')
    body.className = 'belongs-tree'

    const labels: Record<DirectoryFace, string> = {
      page: t('ui.belongs.pages'),
      tag: t('ui.belongs.tags'),
      schema: t('ui.belongs.defs'),
      automation: t('ui.belongs.automations'),
    }
    const empties: Record<DirectoryFace, string> = {
      page: t('ui.belongs.emptyPages'),
      tag: t('ui.belongs.emptyTags'),
      schema: t('ui.belongs.emptyDefs'),
      automation: t('ui.belongs.emptyAutomations'),
    }
    const tabs = document.createElement('div')
    tabs.className = 'belongs-tabs'
    for (const face of DIRECTORY_FACES) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'belongs-tab'
      btn.dataset.face = face
      btn.textContent = labels[face]
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
      onOpen: (b, place) => this.deps.open(b.id, place),
      find: this.deps.find,
    }

    const rows = this.deps.rows(this.face)
    if (rows.length === 0) body.appendChild(cardNote(empties[this.face]))
    const list = cardList()
    // 身份块不参与归属组织：给它亮一个「归到它下面」的落点，写了也不改变任何读路径
    const linkable = this.face === 'page' || this.face === 'tag'
    for (const row of rows) {
      const wrap = document.createElement('div')
      wrap.className = 'belongs-row'
      wrap.dataset.depth = String(row.depth)
      wrap.dataset.belongsId = row.block.id
      wrap.style.setProperty('--depth', String(row.depth))
      wrap.appendChild(renderRow(row.block, ctx))
      if (linkable) {
        wrap.draggable = true
        wrap.addEventListener('dragstart', (e) => setDragBlock(e.dataTransfer, row.block.id))
        const name = blockLabel(row.block, this.deps.find)
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
      }
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
