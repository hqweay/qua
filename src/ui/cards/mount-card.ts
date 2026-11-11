/**
 * 右槽的**挂载区卡**：与正文块底那台挂载区是**同一台组件**（`MountArea`）。
 *
 * 为什么不再是一张「反链卡」：判据（`derivedRecordsOf`）、栏集合（`_mounts`）、
 * 编辑器装配（`EditableBlock`）早已是同一份——之前差的只有壳与落点，而壳层的
 * 第二份实现只会让能力分叉（条件树／看法切换／自定义查询这些先落在中心段尾，
 * 卡里要一样就得再抄一遍）。统一成一台之后，差异只剩**宿主从哪来**：
 * 中心段尾的宿主固定为段根，这里的宿主是**当前对象**（跟着导航换一次装载）。
 *
 * ⚠️ **卡壳是持久的**：`sync()` 每次重画只看「当前对象换了没有」；卡片元素本身
 *    不重建。卡里有一台 contenteditable，每次重画换掉它 ＝ 每敲一个字丢一次焦点。
 * ⚠️ 宿主换了 ⇒ `MountArea.render()` 里的换段判据自己清展开栈/筛选/视图宿主——
 *    这里不替它清第二遍（那会是第二条生命周期）。
 */
import { t } from '../../core/infra/msg.ts'
import type { BlockEditor } from '../../view/editor/editor.ts'
import { buildDockCard, applyDockCardState, type DockCardState } from '../dock/dock.ts'
import type { MountArea } from '../chrome/mount-area.ts'

export interface DockMountCardDeps {
  /** 当前对象：卡跟着它走（与其它派生卡同一条口径） */
  target: () => string
  /**
   * **挂载区的工厂**（装配层 panels 提供）：右槽卡与中心段尾共用同一份判据，
   * 这里只报「宿主是谁」，不自己造第二台。
   */
  createArea: (target: () => string) => MountArea
  /** 卡壳状态（收起／单卡／拖拽／关闭；装配层按 prefs 现算） */
  state: () => DockCardState
  onClose: () => void
  /** 卡被拆掉：装配层若正把活动编辑器指着它，要退回正文 */
  onDispose: (editor: BlockEditor) => void
}

export class DockMountCard {
  /** 持久卡壳：`renderDockStack` 按节点身份排位，原位不动 ⇒ 不换 DOM、不丢焦点 */
  readonly el: HTMLElement
  private readonly deps: DockMountCardDeps
  private readonly area: MountArea
  /** 上一次装载的对象：只在它变了时换一次装载 */
  private target = ''

  constructor(deps: DockMountCardDeps) {
    this.deps = deps
    this.area = deps.createArea(deps.target)
    this.target = deps.target()

    this.el = buildDockCard(
      {
        id: 'mount',
        title: t('ui.dock.mount'),
        body: this.area.root,
        close: { title: t('ui.dock.closeCard'), onClick: deps.onClose },
        // 栏的抬头（计数/看法/筛选）是 body 自己的扫视信息；卡头静置不报第二遍
        quietHead: true,
      },
      deps.state(),
    )
  }

  /**
   * 每次排槽调一次：刷新卡壳状态；只有**当前对象换了**才换一次装载。
   * 内容变了由 `MountArea` 自己按防抖/冻结处理，这里不叠第二条重载路径。
   */
  sync(): HTMLElement {
    applyDockCardState(this.el, this.deps.state())
    const target = this.deps.target()
    if (target !== this.target) {
      this.target = target
      this.area.render()
    }
    return this.el
  }

  /** 从槽里摘掉：卸事件、退订阅、（若活动编辑器是它）交回装配层 */
  dispose(): void {
    const ed = this.area.blockEditor
    if (ed) this.deps.onDispose(ed)
    this.area.dispose()
    this.el.remove()
  }
}
