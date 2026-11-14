/**
 * **块下属性行**：一条只读投影 ＋ 一次点击进编辑面。
 *
 * 为什么是投影而不是第二个编辑器：值住在 `props`，这一行每次渲染从 `fieldRows`
 * 现算；写入仍然只有一条路（属性面板里的值控件 → `core.props/set-value`）。
 * 这就是它与「把属性写成正文」（`key:: value`）的分界 —— 位置变了，真相没变。
 *
 * 为什么点一下是开面板而不是就地出输入框：行在正文里、只有一行高（虚拟化按定高估），
 * 常驻输入框会把「一行字」变成一排控件，还要处理焦点、IME、重排换掉正在输入的节点。
 * 面板里的值控件是现成的，点过去就落在那一栏上（`focusPropId`）。
 *
 * ⚠️ **值是引用时，值那一段不是「标签」而是「露面」**：它带 `data-ref-to`，
 *    于是「左键打开／⇧ 右槽／⌘ 新 tab／⌥ 详情」由事件层那一条分支接管
 *    （判据与正文引用、行尾 chip 同一份）。本文件**不实现跳转**：第二份实现＝第二套语义。
 *    整对按钮只兜住「点名字／点空白」那条老路（开面板）。
 * ⚠️ 值文本**只在这里格式化**：gutter 图标、表格列、面板各自有自己的画法，
 *    但「这一行写什么」只有这一份，免得同一块在四个面上给出四种说法。
 * ⚠️ **不画来源徽章**（检视卡有「色点＋#名」）：这里是读值的投影面，来源在
 *    这一面没有动作可承接——一枚点用户什么也做不了，还得猜它是什么意思；
 *    归属要编辑时才用得上，点行进面板再看。装饰点还会与块标的身份点撞形。
 */
import { t } from '../../core/infra/msg.ts'
import { assetRefsOf, enginePropText, isEngineProp } from '../../core/index.ts'
import type { BelowFields, FieldRow, PropsLineDensity } from '../../core/index.ts'
import { makeAssetThumb } from './asset-value.ts'

export interface PropsLineDeps {
  /** 点一项（或 `+N`）⇒ 打开属性面板；给了 `propId` 就聚焦那一栏 */
  inspect: (blockId: string, propId?: string) => void
  /** `ref` 值的显示名（目标可能已删，交给调用方兜底） */
  refLabel: (targetId: string) => string
  /**
   * **这一块此刻用哪一档**（`summary` 一行／`list` 一栏一行）。
   * 由调用方按「默认档 ＋ 这一块的显式覆盖」算好——渲染不认识偏好。
   */
  density?: PropsLineDensity
  /**
   * **改这一块的档**：`'list'` 展开／`'summary'` 收起／`''` 清除覆盖回默认。
   *
   * 三个动作走同一条回调：它们是同一件事（这一块怎么排）的三个取值，
   * 分成三个回调就会有一条忘了接（症状：某个入口点了没反应）。
   */
  onSetMode?: (blockId: string, mode: PropsLineDensity | '') => void
  /** 打开「这一块怎么排」的菜单（三态；`⋯` 与右键共用，浮层归装配层） */
  onMenu?: (blockId: string, anchor: DOMRect) => void
  /** 最多画几对（其余收成 `+N`）；缺省 3，与多值图标的 `cap` 同一档 */
  cap?: number
}

/**
 * 一行属性画成什么字（**这一行的唯一格式化点**）。
 *
 * 空值不进来（`belowFieldsFor` 只给有值的行），所以这里不做「待填」分支；
 * 选项已删/作用域隐藏时保留旧名并标注 —— 与面板同一条兜底。
 */
export function fieldRowText(row: FieldRow, refLabel: (id: string) => string): string {
  // 引擎行先于 kind 分支：合成定义的 kind 只是兜底，走到 date 分支会把毫秒数画成日期串
  if (isEngineProp(row.propId)) return enginePropText(row.propId, Number(row.value))
  if (row.kind === 'select') {
    if (row.cardinality === 'many') return (row.currentChoiceLabels ?? []).join('、')
    return row.currentChoiceLabel ?? t('ui.props.choice.deleted')
  }
  if (row.kind === 'checkbox') {
    return row.value === true ? t('ui.props.checkboxOn') : t('ui.props.checkboxOff')
  }
  if (row.kind === 'ref') {
    return row.value === undefined || row.value === null || row.value === ''
      ? ''
      : refLabel(String(row.value))
  }
  return row.value === undefined || row.value === null ? '' : String(row.value)
}

export function renderPropsLine(
  blockId: string,
  data: BelowFields,
  into: HTMLElement,
  deps: PropsLineDeps,
): void {
  const cap = deps.cap ?? 3
  const list = (deps.density ?? 'summary') === 'list'
  /**
   * **画几行与「画什么」是同一件事**：行数由 `belowFieldsRows` 给（与虚拟化估高
   * 同一个函数），`list` 时每栏占一行、`summary` 时全部挤在一行里。
   */
  const rows = list ? data.rows : data.rows.slice(0, cap)
  into.replaceChildren()
  into.dataset.propsDensity = list ? 'list' : 'summary'

  if (list) {
    /**
     * **一栏一行**：名字与值各占一段，值靠右（`ui-ellipsis` 截断）。
     * 这一档存在的理由是「读全」——所以不设 cap，也不再有 `+N`；
     * 唯一的多余入口是「收起」（只在这个 list 来自单块展开时出现）。
     */
    for (const row of rows) {
      const pair = pairOf(blockId, row, deps)
      pair.classList.add('blk-prop--row')
      into.appendChild(pair)
    }
    /**
     * **待填的栏也画出来**：`list` 是「让我读完这块」，藏着没填的栏等于没读全
     * （用户切过去会看到栏反而变少）。值位写「待填」，点它开面板去填。
     */
    for (const row of data.pendingRows) {
      const pair = pairOf(blockId, row, deps, t('ui.props.pending'))
      pair.classList.add('blk-prop--row', 'blk-prop--pending')
      pair.dataset.propPending = '1'
      into.appendChild(pair)
    }
    /*
     * **不摆「收起」按钮**：它会独占一行，而估高是按「行数 × 行高」算的——
     * 多出来的那一行没人算，滚动条就会偏小。三个动作（跟随默认／一行／一栏一行）
     * 统一由行尾那颗 `⋯` 的菜单承担；`+N` 保留成「一栏一行」的快捷入口。
     */
    appendModeButton(blockId, into, deps)
    return
  }

  into.dataset.tip = t('ui.props.lineHint')
  rows.forEach((row, i) => {
    if (i > 0) {
      const sep = document.createElement('span')
      sep.className = 'blk-prop-sep'
      sep.textContent = '·'
      sep.setAttribute('aria-hidden', 'true')
      into.appendChild(sep)
    }
    into.appendChild(pairOf(blockId, row, deps))
  })

  /**
   * `+N` ＝ **没画出来的项**（超出上限的有值行 ＋ 声明了但没填的行）。
   *
   * 点它**就地展开**（不再跳面板）：摘要是「帮我认出这块」，展开是「让我读完它」——
   * 后者是同一块上的第二个意图，用动作表达，不要求用户先去设置里改档。
   */
  const more = data.rows.length - rows.length + data.pending
  if (more > 0) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'blk-prop-more'
    btn.dataset.propExpand = blockId
    btn.textContent = t('ui.props.lineMore', { n: more })
    btn.dataset.tip = t('ui.props.lineMoreHint')
    btn.addEventListener('click', () => {
      if (deps.onSetMode) deps.onSetMode(blockId, 'list')
      else deps.inspect(blockId)
    })
    into.appendChild(btn)
  }
  appendModeButton(blockId, into, deps)
}

/**
 * 行尾那颗「这一块怎么排」（三态菜单的入口）。
 *
 * 为什么每块都给、且不依赖有没有被截断：**覆盖必须双向**——只有 `+N` 时，
 * 一个只有两栏的块在 `list` 默认下永远收不回去，而一个满栏的块在 `summary`
 * 下也没有「回到默认」的路。这颗按钮只在悬停/聚焦时显形，不占阅读时的视觉。
 */
function appendModeButton(blockId: string, into: HTMLElement, deps: PropsLineDeps): void {
  if (!deps.onMenu) return
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'blk-prop-mode'
  btn.dataset.propMode = blockId
  btn.dataset.tip = t('ui.props.lineMode')
  btn.setAttribute('aria-haspopup', 'menu')
  btn.textContent = '⋯'
  btn.addEventListener('click', () => deps.onMenu?.(blockId, btn.getBoundingClientRect()))
  into.appendChild(btn)
}

/**
 * 一对「名字 值」（摘要与清单共用，只有排布不同）。
 *
 * 抽出来的原因是命中区：值那一段可能是引用（`data-ref-to`），整对按钮让位给它——
 * 两条画法各写一遍，迟早有一条忘了让位，症状是「点值开面板了」。
 */
function pairOf(blockId: string, row: FieldRow, deps: PropsLineDeps, pendingText?: string): HTMLElement {
  const pair = document.createElement('button')
  pair.type = 'button'
  pair.className = 'blk-prop'
  pair.dataset.propId = row.propId
  const name = document.createElement('span')
  name.className = 'blk-prop-name'
  name.textContent = row.label
  const value = document.createElement('span')
  value.className = 'blk-prop-value ui-ellipsis'
  if (row.kind === 'asset' && pendingText === undefined) {
    /**
     * **asset 值画成露面，不画裸 hash／裸链接**：这一行是「读值」的投影面，
     * 一枚 1em 高的行内缩略图不改变行高（估高按行数 × 定高，多一行就漏算）。
     * 多值最多画三枚；原值留在 `data-tip` 里，hover 仍看得出指向哪一份。
     */
    const refs = assetRefsOf(row.value)
    if (refs.length > 0) {
      value.classList.add('blk-prop-assets')
      for (const ref of refs.slice(0, 3)) value.appendChild(makeAssetThumb(ref, { size: 'line' }))
      value.dataset.tip = refs.join('、')
    } else value.textContent = fieldRowText(row, deps.refLabel)
  } else {
    value.textContent = pendingText ?? fieldRowText(row, deps.refLabel)
  }
  /**
   * **值是引用 ⇒ 值本身是一枚「指向某块的露面」**（`data-ref-to` 是应用里唯一的判据）。
   *
   * 这一行画在 `.blk` 里，也就在编辑器宿主内 ⇒ 事件层那一条分支把左键／⇧／⌘／⌥
   * 全套接上，这里一个事件都不挂。此前它是一段纯文本：点了只会冒泡到整对按钮去开面板，
   * 所以「引用打不开」。
   */
  if (row.kind === 'ref' && row.value !== undefined && row.value !== null && row.value !== '') {
    value.dataset.refTo = String(row.value)
    value.classList.add('blk-prop-ref')
  }
  pair.append(name, value)
  pair.addEventListener('click', (e) => {
    // 值那一段是引用：点击归事件层（去目标块），整对按钮不抢这一下
    if ((e.target as HTMLElement | null)?.closest('[data-ref-to]')) return
    deps.inspect(blockId, row.propId)
  })
  return pair
}
