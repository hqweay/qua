/**
 * 槽里的**搜索卡**：⌘P 浮层与中心 tab 之外的第三种挂载，还是同一份 `SearchFace`
 * （同一引擎、同一套行说法、同一台预览——这里不造第二种搜索）。
 *
 * 与反链卡同型的三个决定：
 *   · **卡壳是持久的**：`sync()` 每次重画只刷卡壳状态；搜索面是一台带输入框的组件，
 *     每次重画换掉它 ＝ 每敲一个字丢一次焦点；
 *   · **懒挂载**：实例在卡第一次出现时才建；面自身的编辑器更是懒到「第一次选中」
 *     才建（`PreviewPane.ensureEditor`）。但**挂载必须等根进文档**——`BlockEditor`
 *     构造时会量 DOM，游离容器上量出来的尺寸是错的；而 `renderSlot` 调 `sync()` 时
 *     卡还没被 append。所以第一次 `sync()` 先记欠账，append 完的微任务里补上；
 *   · **摘卡就收**：面 dispose（退订、拆预览编辑器、还活动编辑器），不留后台订阅。
 *
 * 形态用**tab 那套**（`compact:false`）：晋升/展开这类「建内容」的动作属于常驻面，
 * 槽卡正是常驻面；窄容器下的堆叠是宿主 CSS 的事（`.dock-search-body`），不新开形态。
 */
import { t } from '../../core/infra/msg.ts'
import { buildDockCard, applyDockCardState, type DockCardState } from '../dock/dock.ts'
import { SearchFace, type SearchFaceDeps } from '../search/search-face.ts'

export interface SearchCardDeps {
  /** 搜索面的依赖（引擎/打开/晋升/复制——全在装配层，面自己不认识 app）。每张卡一份 */
  faceDeps: () => SearchFaceDeps
  /** 扁平身份（`dockKey`，`utility:search`）：DOM 属性／收起表／关闭目标都用它 */
  id: string
  /** 卡头固定名（与中心 tab 同一个字典 id） */
  title: string
  /** 卡壳状态（收起／单卡／拖拽／关闭；装配层按 prefs 现算） */
  state: () => DockCardState
  onClose: () => void
}

export class SearchCard {
  /** 持久卡壳：`renderDockStack` 按节点身份排位，原位不动 ⇒ 不换 DOM、不丢焦点 */
  readonly el: HTMLElement
  private readonly deps: SearchCardDeps
  private readonly face: SearchFace
  private readonly body: HTMLElement
  /** 面挂过没有（挂载要等卡根进文档，见类注释） */
  private mounted = false

  constructor(deps: SearchCardDeps) {
    this.deps = deps
    this.body = document.createElement('div')
    this.body.className = 'dock-search-body'
    this.face = new SearchFace(deps.faceDeps())
    this.el = buildDockCard(
      {
        id: deps.id,
        title: deps.title,
        body: this.body,
        close: { title: t('ui.dock.closeCard'), onClick: deps.onClose },
      },
      deps.state(),
    )
  }

  /**
   * 每次排槽调一次：刷新卡壳状态；还没挂的等根进文档再挂（一次）。
   * 面**不**随重画重跑查询——它跟中心 tab 是同一条口径（冻结结果 ＋ 显式刷新）。
   */
  sync(): HTMLElement {
    applyDockCardState(this.el, this.deps.state())
    if (this.mounted) return this.el
    if (this.el.isConnected) {
      this.face.mount(this.body)
      this.mounted = true
      return this.el
    }
    // `renderSlot` 是「先 sync、后 append」：这一拍卡还不在文档里，append 完补挂
    queueMicrotask(() => {
      if (this.mounted || !this.el.isConnected) return
      this.face.mount(this.body)
      this.mounted = true
    })
    return this.el
  }

  /** 从槽里摘掉：拆面（退订、拆预览编辑器、活动编辑器回落），卡壳一起走 */
  dispose(): void {
    this.face.dispose()
    this.el.remove()
  }
}
