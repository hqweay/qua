/**
 * 中心槽的 chrome：**页名 ＋ 空态提示**（2026-10-20 撤顶栏后的全部内容）。
 *
 * **组件自持 DOM**：组件在构造时把自己要用的元素取一次并收起来，装配层只拿这个对象，
 * 不再出现 `document.getElementById('...')`。两个好处：
 *   1. `main.ts` 里不再有裸 DOM 引用（那是它一直降不下来的原因之一）；
 *   2. 「这块 UI 用哪些 DOM」变成**局部知识**，改组件不用翻装配层。
 *
 * ⚠️ 与 `ui/dock.ts` 的分工：dock 管**槽**（排一列块），这里管**槽里的 chrome**（页名）。
 * ⚠️ 与 `ui/block-renderers.ts` 的分工：那两者画**块**，这里画块的**外壳**。
 *
 * **两样东西都不在这里了**（都是被明确撤掉的）：
 *   · **工具栏**（2026-10-19）：作用于选区的命令改由**划选气泡**承载
 *     （`Layers.openSelectionBar`，见 `bindings.ts` 的 `selection` 段）；
 *   · **顶栏的皮肤/明暗开关**（2026-10-20）：调试开关，挪进调试菜单（`main.ts`）。
 * ⇒ 于是这个组件**不再需要任何宿主能力**（没有按钮要 invoke、没有档位要读），
 *   构造参数也随之为空。
 */
import { blockLabel, type Block } from '../core/index.ts'
import { plainText } from '../core/runs.ts'
import { t } from '../core/msg.ts'

export interface Chrome {
  /**
   * 画面包屑（文档头**唯一**的内容）。
   *
   * ⚠️ 2026-10-20 起**不再有「标题」**：当前对象（页／日记／被 zoom 的块）是**正文第一行**，
   *   由 `rootsFor()` 装进编辑器；所以这里只收祖先链。
   * @param page 当前对象（仅为兼容签名保留；面包屑的文案不需要它）
   * @param trail 祖先链（不含当前对象自己）；空 ⇒ 整条隐藏
   */
  renderTitle: (page: Block, trail?: Block[]) => void
  /**
   * 皮肤/主题**变了**之后要重画的东西。
   *
   * ⚠️ 顶栏开关撤掉后（2026-10-20），这里**没有任何 chrome 可画**了 ——
   * 它现在的实际作用是让调试菜单的「✓」跟着当前档位走。
   * 名字保留为「重画外观相关」，不再隐含「有一排按钮」。
   */
  renderDebugState: () => void
  /** 编辑器挂载点与它的滚动容器（装配层切页时要复位滚动） */
  editorEl: HTMLElement
  scrollEl: HTMLElement
  /**
   * **「点空白建块」的监听面**＝ `#scroll`。
   *
   * 为什么不是 `editorEl`／`#doc`：两者高度都只包住内容，**最后一块之下那段空白属于
   * `#scroll`** ⇒ 点那里时事件目标根本不是它们，监听器不触发
   * （2026-10-20 探针实测：`#editor` 高 149px、`#doc` 高 173px，点 y=300..700 全命中
   * `#scroll`，一个块都没建）。监听面放 `#scroll` ⇒ 不必为「可点」改布局高度
   * （试过给 `#editor` 加 `min-height: 100vh…`，空态会多出一条滚动条：757 > 720）。
   * ⚠️ 真正的「空白」判据在 `BlockEditor.clickEmptyArea(clientY)`：只在最后一行
   *    底边之下才算，否则左右留白也会误触。
   */
  blankAreaEl: HTMLElement
  /**
   * 右槽里的**检视卡**：属性面板挂在它上面，标题显示当前对象的名字。
   *
   * 它是常驻节点（`renderDockStack` 的 `persistent`），不是每次重画现造的卡片：
   * 里面是表单，重建会丢焦点与光标。
   */
  inspectCardEl: HTMLElement
  inspectCardTitleEl: HTMLElement
  propertiesBodyEl: HTMLElement
  propertiesAddEl: HTMLButtonElement
  /** 右槽的堆叠容器：检视卡在装配时挂进去（它必须先在文档里，重画才认得它） */
  dockRightStackEl: HTMLElement
  /**
   * ⚠️ **块底的三段（标签页 footer／查询视图／反链 footer）不在这里了**：
   *    它们收成了「每段末尾一个挂载区」，DOM 由组件按段自建（`ui/mount-area.ts`、
   *    `ui/query-view.ts` 的 `createQueryViewEls`）。静态模板里没有它们的节点，
   *    这一层也就取不到 —— 那是「一个位置只能属于一段」的直接后果。
   */
  /** 空态提示（编辑器为空时的引导文案） */
  renderEmptyHint: (roots: Block[]) => void
  /** 启动级持久告警（数据只读 / 保存失败）；传 null 收起 */
  showNotice: (text: string | null) => void
}

function must<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`chrome: missing #${id}`)
  return el as T
}

export function createChrome(onCrumb?: (blockId: string, shiftKey: boolean) => void): Chrome {
  // —— 自持的 DOM（装配层不再看得到它们）——
  /** 面包屑（2026-10-20）：**只有这一条**，不再兼任「页名／标题」 */
  const trailEl = must('crumbs-trail')
  const scrollEl = must('scroll')
  const editorEl = must('editor')
  const emptyHintEl = must('empty-hint')
  const noticeEl = must('boot-notice')
  const inspectCardEl = must('inspect-card')
  const inspectCardTitleEl = must('inspect-card-title')
  const propertiesBodyEl = must('properties-body')
  const propertiesAddEl = must<HTMLButtonElement>('properties-add')
  const dockRightStackEl = must('dock-right-stack')

  function showNotice(text: string | null): void {
    noticeEl.textContent = text ?? ''
    noticeEl.hidden = text === null || text === ''
  }

  /**
   * 画面包屑（**唯一**的文档头内容）。
   *
   * ⚠️ **本仓不存在「标题」这个概念**——
   *   页 / 日记 / 被 zoom 的块一律是**正文第一行**（由 `rootsFor()` 装进编辑器），
   *   所以这里不再有 `#crumbs`（页图标＋页名），只留祖先链。
   * ⚠️ 面包屑是**派生**的（`findPath`），不入库、不物化、没有返回栈。
   * @param trail 祖先链（不含当前对象自己）；空 ⇒ 整条隐藏
   */
  function renderTrail(trail: Block[]): void {
    trailEl.textContent = ''
    if (trail.length === 0) {
      trailEl.hidden = true
      return
    }
    trailEl.hidden = false
    for (const [i, b] of trail.entries()) {
      if (i > 0) trailEl.appendChild(mkSep())
      trailEl.appendChild(mkCrumb(b))
    }
    trailEl.appendChild(mkSep())
  }

  function mkSep(): HTMLElement {
    const s = document.createElement('span')
    s.className = 'crumb-sep'
    s.setAttribute('aria-hidden', 'true')
    s.textContent = '›'
    return s
  }

  /** 面包屑一格：**可点**（点它＝聚焦到那个祖先 ⇒ 退回） */
  function mkCrumb(b: Block): HTMLElement {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'crumb ui-ellipsis'
    el.dataset.blockId = b.id
    // journal 的「名字」是日期的只读投影；其余走显示名（主名叶子 > 正文，空则兜底）
    el.textContent = blockLabel(b)
    el.addEventListener('click', (e) => onCrumb?.(b.id, e.shiftKey))
    return el
  }

  function renderEmptyHint(roots: Block[]): void {
    const first = roots[0]
    const empty = roots.length <= 1 && plainText(first?.content ?? []) === '' && (first?.children.length ?? 0) === 0
    emptyHintEl.hidden = !empty
    if (empty) emptyHintEl.innerHTML = t('ui.emptyHint')
  }

  /**
   * 顶栏已撤 ⇒ 没有按钮可画。皮肤/主题变了以后，唯一需要跟着变的是**调试菜单里的勾选**，
   * 而菜单是**每次点开时重建**的（见 `main.ts` 的调试菜单）⇒ 这里没有要重画的东西。
   *
   * ⚠️ 保留这个方法而不是删掉调用点：它是一个**语义接缝**（"外观变了要通知一下"），
   *   将来如果皮肤改成能影响某处 chrome，这里就是那个落点。
   */
  function renderDebugState(): void {
    // 无 chrome 可画（顶栏已撤）；皮肤与主题只影响 CSS 变量与调试菜单的勾选
  }

  return {
    renderTitle: (_block: Block, trail: Block[] = []) => renderTrail(trail),
    renderDebugState,
    renderEmptyHint,
    showNotice,
    editorEl,
    scrollEl,
    blankAreaEl: scrollEl,
    inspectCardEl,
    inspectCardTitleEl,
    propertiesBodyEl,
    propertiesAddEl,
    dockRightStackEl,
  }
}
