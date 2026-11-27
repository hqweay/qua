/**
 * **块标**：这一块的身份件，也是它的**打开入口**——左键＝聚焦/打开、右键＝块菜单、
 * 拖动＝移动（行为由事件表接 `data-focus-for`／`data-drag-for`，这里只出形状）。
 *
 * 单独成一个模块，是因为它不只住在编辑器行里：**非编辑态的投影**（卡片视图）也要画
 * 同一颗块标——否则阅读态里「点它打开」就没有入口，而另画一颗按钮就是第二套词表。
 * 一份画法，两处挂点。
 *
 * 「常驻还是按需」由宿主决定（`handle` 那一项），形状不因此变化：
 * 信号回答「这是哪类东西」（结构旗），脸回答「这是哪一个东西」（`_icon`／借标签的形），
 * 色是两者的涂料（`--identity-c`／`--identity-ring` 写在这个元素上，CSS 决定染点还是染脸）。
 */
import {
  colorOfByFind,
  faceOfByFind,
  iconOf,
  identityDotColor,
  identityRingGradient,
  isPropDefBlock,
  isQueryBlock,
  type Block,
  type FindBlock,
} from '../../core/index.ts'
import { createIcon, renderIcon } from '../icons.ts'
import { t } from '../../core/infra/msg.ts'

export interface MarkerOpts {
  /** 引用解析（脸与色都要顺着标签看）；不传＝只看块自己显式写的值 */
  find?: FindBlock
  /** `data-focus-for` 指到哪一块（普通行＝自己；投影行＝源） */
  targetId: string
  /**
   * **是不是把手**：真＝可拖动（编辑器行；拖动＝移动这一块）；
   * 假＝只读面（卡片：卡片的拖动另有手势——拖卡＝写值/搬组，两颗拖源语义不同会让人猜）。
   */
  handle?: boolean
  /**
   * **投影行要画源的脸**：露面宿主块自己没有身份（它只是一次露面），
   * 块标上那枚字回答的是「我露的是哪一块」——所以脸取源，不取宿主。
   *
   * 给出这个块 ⇒ 块标是**露面徽章**（虚线圆 ＋ 源的脸，见 CSS）：与镜像那枚同一档，
   * 环里的脸说「是哪一块」。不给 ⇒ 普通块标，脸取自己。
   */
  source?: Block
}

export function buildMarker(b: Block, o: MarkerOpts): HTMLElement {
  const marker = document.createElement('span')
  marker.className = 'marker bullet'
  marker.dataset.focusFor = o.targetId
  marker.dataset.tip = t('ui.block.focusHint')
  if (o.handle === true) {
    marker.classList.add('handle')
    // 抓手图标：**悬停才现**（块标 hover 时把点换成 grip）
    const grip = document.createElement('span')
    grip.className = 'grip'
    grip.appendChild(createIcon('grip-vertical', 'sm'))
    marker.appendChild(grip)
    marker.draggable = true
    marker.dataset.dragFor = o.targetId
  }
  /**
   * **块标＝脸位**：用户配的 `_icon`（脸）优先，缺省回落结构旗（标签=hash／查询=漏斗／
   * 定义=滑杆／代码=尖括号），再缺省借主标签的形（归属序第一个带显式 `_icon` 的标签——与借色同一资格）；
   * 都没有就是圆点（无脸默认）。
   *
   * ⚠️ 投影行取**源**的脸（`o.source`）：宿主块自己只是一次露面、没有身份；
   *    源的脸画在虚线徽章里，同一块在原位与露面处就认得出是同一块。
   *    源是页/日记这类自位不借角色图标的块时，补一指位档（file/calendar）——
   *    徽章那一格里没有内容形态可读，只剩这枚字能回答「露的是哪一块」。
   *
   * ⚠️ 行为与脸无关：块标上的脸**不挂任何事件**——点它还是聚焦/打开，拖动还是把手的事。
   * ⚠️ 图标与点互斥（CSS），悬停时都让位给抓手。
   */
  const faceBlock = o.source ?? b
  const face = faceOfByFind(faceBlock, o.find) ?? (o.source ? iconOf(o.source) : undefined)
  if (face !== undefined) {
    marker.classList.add(isPropDefBlock(faceBlock) ? 'marker-schema' : isQueryBlock(faceBlock) ? 'marker-query' : 'marker-face')
    const ico = document.createElement('span')
    ico.className = 'marker-ico'
    /**
     * 脸画 md（15px）：它是用户挑的数据，不吃发丝线的亏（24 网格 2px 描边缩到 sm 的 12px
     * 只剩 1px，抗锯齿后发灰）——与页/日记脸、查询标记菜单同档；铬件（抓手/折叠箭头）才用 sm。
     * **徽章例外**：16px 的虚线圆里 15px 会顶到环上，降一档到 sm，环内留一圈空。
     */
    if (o.source) renderIcon(ico, face, 'circle-help', 'sm')
    else renderIcon(ico, face, 'circle-help', 'md')
    marker.appendChild(ico)
    // 属性定义的正文是定义名，行内改不了；悬停块标时把「它是什么」说清
    if (isPropDefBlock(faceBlock)) marker.dataset.tip = t('ui.block.schemaHint')
  }
  /**
   * **自位色＝涂料，不是形状**：色只染「当前的形状」，不与形状竞争。
   * 自己的显式 `_color`／恰一个有色标签的借色 → 染点或染脸（`.marker-ico` 的描边
   * 吃 `--identity-c`，emoji 自带色免疫——它是字面文本）；
   * ≥2 个有色标签在**圆点形态**＝内点＋外环：内点取第一个有色标签
   * （`_tags` 序，主标签可读），外环是按序全色的 conic——环说「不止一个」。
   *
   * **环是圆点专属的**：槽里已经有脸时环撤销——脸已经在说「主标签是谁」，
   * 再叠环是两个声音抢一个槽；此时色降级为染脸。
   */
  const idc = colorOfByFind(b, o.find)
  const dot = identityDotColor(idc)
  if (dot !== undefined) marker.style.setProperty('--identity-c', dot)
  const ring = identityRingGradient(idc)
  if (ring !== undefined && face === undefined) {
    marker.style.setProperty('--identity-ring', ring)
    const ringEl = document.createElement('span')
    ringEl.className = 'marker-ring'
    marker.appendChild(ringEl)
  }
  return marker
}
