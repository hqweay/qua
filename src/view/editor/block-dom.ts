/**
 * 把**模型**画成 DOM：一个块的内容 = 一串 run（文本段 ＋ 不可分的行内节点）。
 *
 * 这是从 `view.ts` 抽出来的纯渲染层。为什么它值得单独存在：
 *   · 它**不持有状态**（只吃 `Block` ＋ 一块解析用的 `FindBlock`，吐 `HTMLElement`），
 *     所以能脱离编辑器单独成型——将来「同一个块在槽里、在正文里、在引用预览里」
 * 用的是同一个函数（一源多视的前提）；
 *   · 它是**编辑器 DOM 契约的产地**（`.blk`／`.tx`／`data-depth`；行内原子的
 *     `.atom`／`data-atom-id` 契约住 `./run-dom.ts`），契约集中在一处才守得住。
 *
 * ⚠️ 三条实测得来的纪律（不许破坏）：
 *   1. 缩进**不用 DOM 层级**，用扁平 ＋ `data-depth` ＋ padding（DOM 层级与虚拟化互斥）；
 *   2. 行内原子 = `contenteditable=false` 的 inline 元素，**在正文里占 1 格**（读数与光标都这么算）；
 *   3. gutter（块标/箭头/导轨）**不混进 `.tx`**：读回模型时会把它当成字。
 */
import {
  CODE_TYPE,
  CLOSURE_USE,
  CALLOUT_PROP,
  calloutTypeOf,
  calloutTypesOf,
  identityColorCss,
  QUOTE_TYPE,
  DEFAULT_BLOCK_TYPE,
  DIVIDER_TYPE,
  DISPLAY_PROP,
  LANG_PROP,
  aliasesOf,
  blockTypeOf,
  bodyKindOf,
  canonicalLang,
  codeLangLabel,
  displayNameOf,
  codeTextOf,
  embedBodyOf,
  identityTags,
  isJournal,
  isEmbedBlock,
  isPropDefBlock,
  propKindOf,
  journalDate,
  journalDateLabel,
  mergeTagOrder,
  primaryAliasOf,
  prop,
  resolveEmbed,
  tagIdsOf,
  typeDeclOf,
  type Block,
  type BelowFields,
  type BodyKind,
  type FindBlock,
  type FoldState,
  type GutterField,
  type NoteSourceCell,
  type RefView,
  type VisibleRow,
} from '../../core/index.ts'
import { MARK_KINDS, isEmptyContent, plainText, refRunsOf, type Marks } from '../../core/model/runs.ts'
import type { AssetView } from '../../core/infra/assets.ts'
import { t } from '../../core/infra/msg.ts'
import { blockLabel, danglingView, resolveRefs } from '../../core/relations/ref.ts'
import { createIcon, renderIcon } from '../icons.ts'
import { buildMarker } from './marker.ts'
import { EDIT_ISLAND_ATTR } from './edit-island.ts'
import { makeTaggedChip } from './field-affordance.ts'

/** 行高：与 CSS 的 `--ui-line-h` 必须一致（虚拟化算占位高度要用） */
export const LINE_H = 30

/**
 * 别名头额外占的高度（近似值，只给虚拟化的占位滚动条用）。
 *
 * 别名头是 `.tx` 之外的一行：`--ui-fs-xs` × `--ui-lh-tight` ＋ `.blk` 的 row-gap
 * （＝ `tokens.css` 的 `--ui-head-h` ＋ `--ui-gap-1`，实测 18.09）。
 * 这里不读 computed style，是因为占位是在**没有挂 DOM**的行上算的；数值略大一点
 * 比略小好（滚动条高估只会多留白，低估会让最后几行跳一下）。
 *
 * ⚠️ 它与 `--ui-head-h` 是**同一件事的两份数值**（一份给 DOM、一份给虚拟化）：
 *    改那头的高度就要两边一起改。真实的纵向几何（`.rail-self` 的起点）走的是 token，
 *    所以两处偏了不会让线画错，只会让滚动条估偏——`check:dock` 的 A23 量的是线，管不到这里。
 */
export const ALIAS_HEAD_H = 18

/**
 * **带身体行的占位估算值**（只给虚拟化档的窗口外行用）。
 *
 * 身体本身是**自然高度**（内容多高就多高——紧凑性归折叠，不归封顶）：
 * 没挂载的行量不到内容 ⇒ 占位只能估。这个数是「一份普通查询结果」的典型高度，
 * 估**不准是已知的**：结果特别多的查询在虚拟化档会让滚动条偏小（宁可低估也不假封顶
 * ——封顶是旧的视觉档，已经退场）。虚拟化是 opt-in（prefs），默认档全挂载、不经过这里。
 */
export const VIEW_BODY_H = 168

/**
 * 查询体与上一行之间的 `row-gap`（＝`--ui-gap-1`）。
 *
 * 视觉走 token，虚拟化走这个数：占位是在没有挂 DOM 的行上算的，读不到 computed style。
 * 和 `ALIAS_HEAD_H` 一样，两处是同一件事的两份数值；改 gap 时一起改。
 */
export const VIEW_BODY_GAP = 2

/**
 * 行下身体与**下一行**之间的底缝（＝`--ui-gap-2`，4px）。
 *
 * 身体是「面」，下一行的行尾 chip 也是「面」；两者之间没有缝时读作咬在一起
 * （见 `styles/blocks.css` 里那条共享规则的说明）。视觉走 token，虚拟化走这个数：
 * 占位在没有挂 DOM 的行上算，读不到 computed style。
 *
 * ⚠️ 与 `VIEW_BODY_GAP` 一样是**同一件事的两份数值**：CSS 改了这里也要改，
 *    否则长文档的占位会系统性地少 4px／行（带身体的行越多，偏得越多）。
 */
export const VIEW_BODY_INSET = 4

/**
 * **块下属性区每行**额外占的高度（近似值，只给虚拟化的占位滚动条用）。
 *
 * 一行小字（`--ui-fs-xs` × `--ui-lh-tight` ≈ 18）＋ `.blk` 的 `row-gap`
 * （＝ `--ui-gap-1`，2）＝ 20。与 `ALIAS_HEAD_H`／`VIEW_BODY_GAP` 同一条纪律：
 * 视觉走 token，虚拟化走这个数；改那行的高度就要两边一起改。
 *
 * ⚠️ **每行都是定高、行数由派生给出**（`belowFieldsRows`）：`summary` 档恒 1 行，
 *    `list` 档＝有值的栏数。所以「多高」是可算的，不依赖宽度与内容——
 *    让属性行自由换行会让占位估算彻底失效（滚动条系统性偏小）。
 */
export const PROP_LINE_H = 20

/**
 * 行下身体**内联在本行**的那三种：自动化块的三段式定义体／定义块与标签的属性投影／
 * 查询或 children 源的视图。
 *
 * 三种身体**共用一个壳**（`.blk-view-body`），所以「这一格归谁」必须由一份判据回答，
 * 新画的行与保留行接回都吃它——按壳判（看见 `.blk-view-body` 就挂视图）会让同一格
 * 叠两张卡：属性投影上面再冒一台只属于看法视图的「N 项 · 大纲 · 新建一行」抬头。
 */
export type InlineBodyKind = Extract<BodyKind, 'automation' | 'def' | 'view'>

/**
 * **这一块的行下身体归谁画**（内联三支；种类与分派顺序的唯一一份在 `bodyKindOf`）。
 *
 * 露面与代码的身体**不在这一支**：它们的宿主顶替 `.tx` 的位置、构造成另一步，
 * 所以这里只收「贴在本行下面那一格」的三种。
 *
 * 递归的**构造性截断**不在这条判据上：结果里的查询块由**里层编辑器**画，
 * 而那一层（挂载区／镜像／查询结果／单元格）在构造上没有身体回调。
 */
export function inlineBodyKind(b: Block): InlineBodyKind | null {
  const kind = bodyKindOf(b)
  return kind === 'automation' || kind === 'def' || kind === 'view' ? kind : null
}

/** 这一块在行下有没有身体（来源见 `inlineBodyKind`；「有」与「归谁画」同一份答案） */
export function hasInlineBody(b: Block): boolean {
  return inlineBodyKind(b) !== null
}

/** 同上，按行问（虚拟化占位与渲染共用这一份答案） */
export function rowHasInlineViewBody(r: VisibleRow): boolean {
  return hasInlineBody(r.block)
}

/**
 * 这一行在虚拟化里占多高：有别名头（且不是显示文本）或面包屑就是两行以上。
 *
 * ⚠️ **定义身体（查询体／露面体／自动化体／定义值配置／字段声明）要算进来**：
 *    它们不占正文，高度由声明给。
 *    按 `LINE_H` 算会让带这些行的文档滚动条系统性偏小。
 *    这里只读**静止档的封顶值**：身体多数时候比它矮（内容高），占位因此是**上限估计**
 *    （宁可高估留白，也别低估让滚动条偏小）；聚焦档只发生在窗口里的那一行上，
 *    而占位算的是窗口**之外**的行。
 */
export function visibleRowHeight(b: Block, extraHeads = 0, viewBody = false, propRows = 0): number {
  const aliasHead = aliasesOf(b).length > 0 && prop<string>(b, DISPLAY_PROP) !== 'text' ? 1 : 0
  const extra = viewBody ? VIEW_BODY_H + VIEW_BODY_GAP + VIEW_BODY_INSET : 0
  return LINE_H + extra + (aliasHead + extraHeads) * ALIAS_HEAD_H + propRows * PROP_LINE_H
}

/**
 * 这一行的露面身体是不是**投影**（源的结果视图）：高度由 `VIEW_BODY_H` 声明，
 * 与行内体读同一个数 —— 两处各算一遍，长文档的滚动条就会系统性偏小。
 *
 * ⚠️ 镜像（那棵子树）**不是**这里的一种：它的高度是内容高，没有「一档」可言。
 */
export function rowHasEmbedViewBody(b: Block, find: FindBlock): boolean {
  return isEmbedBlock(b) && embedBodyOf(b, find) === 'view'
}

/**
 * 行内原子族（run 原子／标签 chip／引用数徽标）住 `./run-dom.ts`；
 * 本文件从那里再导出，**对外的符号名不变**（消费方 import 不用动）。
 */
export {
  REF_BADGE_ATTR,
  applyMarkColor,
  liveRefBadgeOf,
  makeRefBadgeEl,
  makeRunEl,
  makeTagChipEl,
  tagForMark,
} from './run-dom.ts'
import { applyMarkColor, makeRunEl, tagForMark } from './run-dom.ts'

/**
 * **这一行是不是只读的**：不给编辑、不给落光标。
 *
 * 只读有**两个来源**，但出口只有一个：
 *   · journal 的行是 `_date` 的只读投影，日期不是块的正文；
 *   · 类型声明 `text: 'readonly'` 的块（分割线这类）**没有可编辑的正文**。
 * 两者的理由不同（一个是「正文在别处」，一个是「没有正文」），后果相同：
 * 这一行不接受输入。
 *
 * ⚠️ 这条判据有**三个**消费者，必须只有一处定义：
 *   ① `makeBlockEl`（`contenteditable=false` ＋ `data-readonly`）；
 *   ② `view/editor-events` 的 mousedown（点它不落光标）；
 *   ③ `view/editor.selectAll` 与装配层的 `firstEditableRoot`（起选/落点要跳过它）。
 *   分开写会立刻分叉（2026-10-20 实际踩过：只读行让 ⌘A 的原生全选退化成空选区）。
 */
export function isReadonlyBlock(b: Block): boolean {
  return isJournal(b) || typeDeclOf(b).text === 'readonly'
}

/**
 * 一份 marks → 一棵语义包装（按 MARK_KINDS 序固定嵌套：同一 run 每次渲染出同一棵 DOM，
 * 读回按 class 集合解析，不依赖顺序）。文本段与**原子**共用这一份——格式操作对原子是
 * 整枚改（不可分），只对文本段包装会让原子上的格式存得进、画不出。
 * 值轴：值住在 data-slot 上。板槽名的颜色由 CSS 按槽名给（token 链）；
 * hex（自由色）没有槽规则，由 applyMarkColor 落 inline style。
 */
function wrapMarks(node: Node, marks: Marks | undefined): Node {
  for (const k of MARK_KINDS) {
    const v = marks?.[k]
    if (v === undefined) continue
    const wrap = document.createElement(tagForMark(k))
    wrap.className = `mk mk-${k}`
    if (v !== true) {
      wrap.dataset.slot = v
      applyMarkColor(wrap, k, v)
    }
    wrap.appendChild(node)
    node = wrap
  }
  return node
}

/**
 * 把一个块的行内内容装进 `.tx`：run 依序画——文本段与原子都按自己的 marks 套语义标签，
 * 原子是不可分元素（包装整枚套在外面，读回按已知 run 原样带回）。
 *
 * ⚠️ 空块必须留一个可落光标的锚点（`<br>`）：Chrome 里空的 inline span 不接受插入，
 *   会把输入落到上一个文本节点（实测：Enter 拆出空块后紧接着打字会跑进前一块）。
 *   与 ProseMirror 的 trailing `<br>` 同一招——只在空块出现，一有文本就被重渲染掉。
 */
export function fillBlockText(
  tx: HTMLElement,
  b: Block,
  /**
   * **引用解析**（可选）：传了 ⇒ 行内引用显示**目标当前的名字**。
   * 不传 ⇒ 退回 run 上的名字快照（那是过期的字，只在拿不到森林的场合容忍）。
   */
  find?: FindBlock,
  /**
   * **资产此刻的样子**（可选）：传了 ⇒ 行内资产画成真图 / 文件 chip / 失败占位。
   * 不传 ⇒ 一律按 `unavailable` 画：那正是「这台宿主没接资产库」的真相，
   * 而不是「这张图不存在」——两者的文案与建议不同（见 `view/asset-views.ts`）。
   */
  assetView?: (hash: string) => AssetView,
  /**
   * **字节取不到时**的回落（可选）：`<img>` 报错 ⇒ 把这份 hash 判成缺失并重画。
   * 不传 ⇒ 图裂了就只是图裂了（索引里仍认为它有）。
   */
  onAssetError?: (hash: string) => void,
  /**
   * **原子的呈现元信息**（可选）：目标有没有字段、有没有 closure 状态。
   *
   * 由视图层注入：它手里有 `FieldTable`，而 `core/ref.ts` 只看块、不扫森林。
   * 不传 ⇒ 只画普通引用（旧行为）；传了 ⇒ 实例的图标槽可以变成状态标记 / 字段手柄。
   */
  refMeta?: (targetId: string) => Pick<RefView, 'fields' | 'closure'> | undefined,
): void {
  tx.textContent = ''
  const refRuns = refRunsOf(b.content)
  const views = find ? resolveRefs(find, refRuns) : undefined
  if (views && refMeta) {
    /**
     * 合并而不是重算：`resolveRefs` 已经解析了名字/身份/色/脸，元信息只补两格。
     * 按 run id 写回，同一目标被引用多次时各枚都拿到同一份派生（不走第二套缓存）。
     */
    for (const r of refRuns) {
      if (r.t !== 'ref' || !r.to) continue
      const meta = refMeta(r.to)
      if (!meta) continue
      const v = views.get(r.id)
      if (v) views.set(r.id, { ...v, ...meta })
    }
  }

  for (const r of b.content) {
    if (r.t === 'text') {
      tx.appendChild(wrapMarks(document.createTextNode(r.v), r.marks))
      continue
    }
    if (r.t === 'ref') {
      tx.appendChild(wrapMarks(makeRunEl(r, views?.get(r.id) ?? danglingView(r.anchor ?? r.label ?? t('ui.atom.unknown'))), r.marks))
      continue
    }
    if (r.t === 'asset') {
      // 资产 run 永不携带 marks（模型归一化的形状保证），包装只是走同一入口
      tx.appendChild(wrapMarks(makeRunEl(r, undefined, assetView?.(r.asset), onAssetError), undefined))
      continue
    }
    tx.appendChild(wrapMarks(makeRunEl(r), r.marks))
  }

  if (tx.childNodes.length === 0) tx.appendChild(document.createElement('br'))

  /**
   * **光标锚**：正文以原子**开头或收尾**时（引用/资产是行内唯一、最前或最后内容），
   * `.tx` 里那一侧没有文本节点——光标的唯一候选位是「原子与行缘之间的元素缝隙」，
   * Chrome 不认（竖线画歪/画到行框外沿、按键前把光标挪走，退格会把整行可编辑根
   * 摘掉，见 `posAt` 的注）。在那一侧补一个**带零宽空格的文本节点**给光标站位。
   *
   * 为什么不能是空文本节点：空节点没有行内盒，插入点落进去时 Chrome 借不到文字
   * 度量——行缘一侧退回整行行框（竖线比正文高半行），贴原子的一侧退回原子盒底缘
   * （整体下沉到基线以下），左右形状不一致。零宽空格让锚自己成为**真文本盒**：
   * 光标画在文字度量上，两侧同形同位（正文一致 ⇒ 行缘也一致）。
   *
   * 它对模型必须不存在：`nodeLen`／`offsetIn` 把它扣掉、`readRuns` 读段时剥掉
   * （`dom-text.ts` 三条一起做，同 isTagChip 的纪律）⇒ 模型一个字节不多。
   * 代价登记：零宽空格是 Chrome 的可遍历字符——向右穿过它多吃的那一步由事件层
   * 接管吃掉（`editor-events.ts` 的 keydown 接管，连走两步）；向左与 Shift 扩选
   * 保持原生节奏。换来的是行缘光标形状与正文一致，且行缘两侧可停留。
   * 两端各一个：只有行尾锚时，「一行只有一枚引用」的光标落行首仍然是缝隙。
   */
  const caretAnchor = (): HTMLElement => {
    const anchor = document.createElement('span')
    anchor.className = 'tx-caret-anchor'
    anchor.dataset.caretAnchor = '1'
    anchor.appendChild(document.createTextNode('\u200B'))
    return anchor
  }
  if (b.content.length > 0 && b.content[0]!.t !== 'text') tx.prepend(caretAnchor())
  if (b.content.length > 0 && b.content[b.content.length - 1]!.t !== 'text') tx.appendChild(caretAnchor())
}

/**
 * **标签槽**：块级标签的显示位置 —— `.blk` 下、`.tx` 外的一个不可编辑容器。
 *
 * 为什么是独立槽而不是「拼在正文末尾」：标签是**无位点的归属**（`props._tags`），
 * 正文槽里每个位置都是潜在插入点 —— chip 留在 `.tx` 里，光标就能落到它后面，
 * 打出来的字 DOM 上排在 chip 后、模型里是正文末尾，重画后就「标签跳到文本后面」。
 * 槽挂在行右端（flex 布局，不悬浮不遮挡），插入点物理上进不去，错位从根上不存在。
 *
 * ⚠️ chip 只由归属决定：正文里 `#名` 是一次提及，不写归属，也不影响 chip。
 *    两者指同一个标签时都画 —— 提及是句中的一个位置，归属是整块的一格字段；
 *    chip 是归属**唯一**的行级可见信号，藏掉它，「这块到底归没归属」就只剩
 *    打开属性面板才知道（两种露面靠底色／钉行尾区分，见下方视觉口径）。
 * ⚠️ 名字走 `blockLabel`（现算）：标签块改名后 chip 上的字要跟着变，
 *    所以这里不存名字、只认 id。目标块不在 ⇒ 这条归属没有可显示的名字，跳过。
 * ⚠️ **没有标签且没有额外 chip 就不生成这个节点**（同 `.fold` 的口径，不是隐藏）：空槽是纯噪声。
 * ⚠️ 分割线没有正文槽，也不画标签槽。
 *
 * `extra` 是同一条槽里的**第二族** chip（引用数徽标）：由调用方现算好再递进来，
 * 排在标签之后（最右端）。渲染层不认识「引用」是什么，只知道槽里多了一枚不可编辑的 chip。
 *
 * `onReorder` 给了且标签 ≥2 枚 ⇒ chips 可**拖拽重排**：拖动中实时搬 DOM 预览落点，
 * 落下按 DOM 序并回完整归属序（`mergeTagOrder`——找不到目标块的那几枚保位）整笔交回调。
 * 顺序喂着块标的借形/借色取「第一个」，是用户可编辑的数据，不是打标先打的偶然。
 *
 * @returns 标签槽元素；无标签且无额外 chip 时返回 null
 */
export function makeTagsEl(
  b: Block,
  find?: FindBlock,
  extra?: HTMLElement | null,
  onReorder?: (orderedFull: string[]) => void,
): HTMLElement | null {
  if (!find) return null
  const tags = [...tagIdsOf(b)].filter((tagId) => find(tagId))
  if (tags.length === 0 && !extra) return null
  const el = document.createElement('span')
  el.className = 'blk-tags'
  el.contentEditable = 'false'
  const draggable = tags.length >= 2 && onReorder !== undefined
  const draggingOf = (): HTMLElement | null => el.querySelector<HTMLElement>('.tag-chip[data-dragging]')
  for (const tagId of tags) {
    const tag = find(tagId)!
    const chip = makeTaggedChip(b.id, tag, blockLabel(tag, find))
    // 披露控件统一在**起点**：块折叠在块首，标签字段披露在 chip 首——
    // 位置跟「它披露的是谁的 body」走，不跟内容最终浮在卡里还是行下走。
    if (draggable) {
      chip.draggable = true
      chip.addEventListener('dragstart', (e) => {
        chip.dataset.dragging = '1'
        // Electron 要 dataTransfer 里有非空数据才起拖（内容无关，id 只是载体）
        e.dataTransfer?.setData('text/plain', tagId)
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
      })
      chip.addEventListener('dragend', () => {
        delete chip.dataset.dragging
      })
      // 悬停在另一枚 chip 上 ⇒ 按指针在前半/后半决定预览落点（挪的是正在拖的那枚）
      chip.addEventListener('dragover', (e) => {
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
        const dragging = draggingOf()
        if (!dragging || dragging === chip) return
        const mid = chip.getBoundingClientRect().left + chip.offsetWidth / 2
        chip.parentNode?.insertBefore(dragging, e.clientX < mid ? chip : chip.nextSibling)
      })
    }
    el.appendChild(chip)
  }
  // 落下＝按预览序并回全序整笔交回调；判负（集合不一致）由调用方不写，预览随重渲染复原
  if (draggable) {
    el.addEventListener('dragover', (e) => e.preventDefault())
    el.addEventListener('drop', (e) => {
      e.preventDefault()
      const order = [...el.querySelectorAll<HTMLElement>('.tag-chip[data-tag-id]')].map((c) => c.dataset.tagId!)
      const full = mergeTagOrder(tagIdsOf(b), order)
      if (full !== null) onReorder!(full)
    })
  }
  if (extra) el.appendChild(extra)
  return el
}

// 契约常量住在叶子模块（题注行也要用，留在这里会形成循环 import）；这里转出去，
// 既有 `import { EDIT_ISLAND_ATTR } from './block-dom.ts'` 的调用点不用改。
export { EDIT_ISLAND_ATTR } from './edit-island.ts'

/**
 * **这一次事件发生在别人的岛里吗**：委托到容器上的处理器用它让路。
 *
 * 判据用派发那一刻的 `composedPath()`（不是 `target.closest()`）：处理过程中里层
 * 可能同步重排、把目标换成一棵新子树，那时 `closest` 会得到 null，岛界就漏了。
 * `own` 是调用方的地盘：它自己若住在某个岛里，那颗岛根才算自己的；不在岛里（主编辑器）为 null。
 */
export function inForeignIsland(ev: Event, own: Element | null): boolean {
  const ownIsland = own?.closest(`[${EDIT_ISLAND_ATTR}]`) ?? null
  for (const node of ev.composedPath()) {
    if (node instanceof Element && node.hasAttribute(EDIT_ISLAND_ATTR)) return node !== ownIsland
  }
  return false
}

/**
 * **点在「标题与正文之间的气口」里吗**（页/日记根行下面那 16px）。
 *
 * 那段 padding 属于 root 行，但**不是标题的内容**：它是「在第一块之前建块」的
 * 命中面。事件层（`inBlock`）与编辑器（`clickEmptyArea` 的 `onRow`）都要把这条
 * 带子当空白 —— 判据只写这一份。
 *
 * 契约只有一条：渲染层给主编辑面的页/日记根行打 `data-title-gap="1"`
 * （`makeBlockEl` 的 `opts.titleGap`；查询结果/挂载区的 depth 0 行不打）。
 * 高度从 computed style 读，别在 JS 里再抄一个 16。
 */
export function inTitleGap(el: HTMLElement, clientY: number): boolean {
  if (el.dataset.titleGap !== '1') return false
  const pad = Number.parseFloat(getComputedStyle(el).paddingBottom) || 0
  if (pad <= 0) return false
  const box = el.getBoundingClientRect()
  return clientY > box.bottom - pad && clientY <= box.bottom
}

/**
 * **一个 `.blk` 允许有哪些直接子节点** —— 这是行的 DOM 契约清单，只有渲染层能增项。
 *
 * 为什么需要它：整片编辑区是**一个** contenteditable 容器，所以行容器 `.blk` 自己也可编辑。
 * 插入点一旦落到「正文之外」（行首按 `←`、点在 gutter 与正文之间的缝、只读日期行），
 * 浏览器就会把字直接塞进 `.blk` —— 那些裸节点不属于任何块的正文，`readRuns` 读不到，
 * 重渲染一过就消失（详见 `BlockEditor.reclaimCaret`）。
 *
 * ⇒ 判据：`.blk` 的子节点只能是**渲染层自己放进去的那几种**；其余一律当游离内容清掉。
 *   加新子节点时**必须**在这里登记，否则它会在第一次收光标时被当作脏东西删掉。
 *
 * ⚠️ `blk-embed-body` 是**正文槽的子节点**，不是 `.blk` 的直接子节点 —— 登记在这里
 *    是因为 `reclaimCaret` 沿 `.blk` 收节点时会走进 `.tx`（插入点常常落在 `.tx` 里），
 *    而它是 `contenteditable=false` 的：浏览器把「清理游离节点」看成从它内部开始，
 *    不登记就会在收光标时把整段身体删掉（表现为「点一下它，它消失了」）。
 */
export const ALLOWED_ROW_CHILDREN: ReadonlySet<string> = new Set([
  'blk-context',
  'blk-alias',
  'rails',
  'rail-self',
  'left',
  'tx',
  'blk-kind',
  'blk-callout-label',
  'blk-tags',
  'blk-embed-body',
  'blk-view-body',
  'blk-code-host',
  'blk-code-lang',
  'blk-props-line',
  'blk-acts',
])

/**
 * 身体块行头的动作：**只折身体**（`bodyFolded`，与「整片收起」是两张表）。
 *
 * 曾经这里有「上建块／下建块／删除」三颗：它们的理由是「代码块的正文在 CM6 岛里，
 * 上下建块与删除没有可落光标的正文行」。那三条现在都有更短的路径——
 * 标题行本身就是普通正文槽（Enter 建兄弟块、`⌘⇧↵` 上建、右键块标菜单），
 * 三颗常驻按钮只是把同一条命令抄了一遍，还把行头读成了工具条。
 */
export type BlockAction = 'body-fold'

/**
 * **身体块行头的那颗折叠按钮**：只折身体，不折子块。
 *
 * 为什么需要它（而不是复用左侧那颗三角）：有身体的块下面有**两层**东西——
 * 身体（这一块自己的内容：代码文档／查询结果）与子块（挂在它下面的别的块）。
 * 左侧三角折的是**整片**（`folded`），按下去子块跟着收，于是「留着子块只看代码」
 * 这条最常用的事没有入口。这颗按钮写的是另一张表（`bodyFolded`），只收身体那一格。
 *
 * 规则：
 *   · 只挂在**这一行真有身体**的块上（代码／查询／露面投影）——普通块没有可收的身体；
 *   · 透明度切换，不换布局（跟 `::before` 占位同一条纪律：chrome 不许推正文）；
 *   · 不进 tab 序（与块标／折叠同一档鼠标 chrome）；点击由组自己收下，
 *     这里只写 `data-block-act`，不认识命令。
 *   · 图标恒画 `chevron-down`，收起态由 CSS 旋转（与左侧三角同一套语言）。
 */
function makeBodyFoldToggle(blockId: string, bodyHidden: boolean, onAct: (act: BlockAction) => void): HTMLElement {
  const group = document.createElement('span')
  group.className = 'blk-acts'
  group.contentEditable = 'false'
  const el = document.createElement('span')
  el.className = 'blk-act'
  el.dataset.blockAct = 'body-fold'
  el.dataset.blockActFor = blockId
  el.setAttribute('role', 'button')
  const tip = bodyHidden ? t('ui.block.foldExpand') : t('ui.block.foldBody')
  el.dataset.tip = tip
  el.setAttribute('aria-label', tip)
  el.appendChild(createIcon('chevron-down', 'sm'))
  group.appendChild(el)
  /**
   * 点击在**组自己**身上收：行级 chrome（不是编辑岛），但外层编辑器的点击委托
   * 会把它当「点到了块里」继续往下分派——这里收口后交给同一个桥。
   */
  group.addEventListener('click', (e) => {
    const hit = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-block-act]') : null
    if (hit?.dataset.blockAct !== 'body-fold') return
    e.preventDefault()
    e.stopPropagation()
    onAct('body-fold')
  })
  return group
}

/**
 * **代码块的语言徽章**：这一行此刻是什么语言，点一下换。
 *
 * 为什么住在**标题行**而不是浮在代码面上（用户口径是「右上角」）：
 *   · 代码面是一台可横向滚动的编辑器，浮件要么盖住第一行尾部的字，要么随滚动跑位；
 *   · 标题行就是这一块的盒面（收起时它**就是**那个盒子）——徽章贴着它，
 *     展开／收起两种状态都在同一个位置，且一个像素的代码都不挡；
 *   · 与 `.blk-kind`／标签槽同一条「行级 chrome 不进 `.tx`」的纪律：
 *     正文读数与插入点只走 `.tx`，徽章不参与（否则它会变成正文里的字）。
 *
 * 点击由它自己收下（与行头折叠键同一套）：外层委托会把它当「点到了块里」，
 * 不 `stopPropagation` 就会顺手把光标/菜单一起做掉。
 */
function makeCodeLangChip(b: Block, onOpen: (blockId: string, anchor: DOMRect, trigger: HTMLElement) => void): HTMLElement {
  const raw = prop<string>(b, LANG_PROP)
  const label = codeLangLabel(raw)
  const el = document.createElement('span')
  el.className = 'blk-code-lang'
  el.contentEditable = 'false'
  el.dataset.lang = canonicalLang(raw)
  el.setAttribute('role', 'button')
  el.textContent = label
  const tip = t('ui.code.langTip', { label })
  el.dataset.tip = tip
  el.setAttribute('aria-label', tip)
  el.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    onOpen(b.id, el.getBoundingClientRect(), el)
  })
  return el
}

/**
 * **引述块的变体徽章**：图标＋「信息/警告…」，点开七选一切换 `_callout`。
 *
 * 住在 `.tx` **之外**、正文槽之前：变体名是 chrome，不是这一行说的话——
 * 落进 `.tx` 会被 `readRuns` 读回正文、也被光标落到它后面打字（与标签槽同一条病）。
 * 点击自己收下（同 `makeCodeLangChip` 的 stopPropagation），不把光标/菜单一起做掉。
 */
function makeCalloutChip(
  b: Block,
  onOpen: (blockId: string, anchor: DOMRect, trigger: HTMLElement) => void,
  find?: FindBlock,
): { icon: HTMLElement; label: HTMLElement } {
  const v = calloutTypeOf(prop<string>(b, CALLOUT_PROP), calloutTypesOf(find))
  const ico = document.createElement('span')
  ico.className = 'blk-callout-ico'
  ico.contentEditable = 'false'
  // 记录 id 进 DOM：主题/插件按它扩展（颜色由行上的 `--callout-c` 给，不按 id 写死）
  ico.dataset.callout = v.id
  ico.setAttribute('role', 'button')
  renderIcon(ico, v.icon, 'quote', 'md')
  if (v.color) ico.style.setProperty('--callout-c', identityColorCss(v.color))
  const label = document.createElement('span')
  label.className = 'blk-callout-label'
  label.contentEditable = 'false'
  label.dataset.callout = v.id
  label.setAttribute('role', 'button')
  label.textContent = v.label
  if (v.color) label.style.setProperty('--callout-c', identityColorCss(v.color))
  const tip = t('ui.callout.chipTip', { label: v.label })
  for (const el of [ico, label]) {
    el.dataset.tip = tip
    el.setAttribute('aria-label', tip)
    el.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      onOpen(b.id, el.getBoundingClientRect(), el)
    })
  }
  return { icon: ico, label }
}

/**
 * 一个可见行 → `.blk` 元素。
 *
 * **DOM 契约就在这里**：`data-block-id`／`data-depth`／`data-has-children`／
 * `data-collapsed`／`data-closure`／`--depth`，以及 `.left` 里的 `.marker`／`.fold`／`.identity`／`.closure-box`。
 * 主题与插件都按这些选择器选，**改名等于破坏契约**。
 *
 * gutter 的形状：
 *   · **一个主件**：`.marker` 同时是**块标与拖拽把手**（D4）。旧契约
 *     `class="bullet handle"` 两个选择器**都保留在同一个元素上**，主题与插件不会失效；
 *   · **两个临时件**：`.fold`（悬停才现）与 `.marker` 上的 grip（悬停才现）；
 *   · **后缀**：`.identity`（这块是任务 / 是标签），一块可以同时挂两枚；
 *   · `.fold` **无子块不生成**（不是 `visibility:hidden`，DOM 里就没有这个节点）；
 *   · 折叠态**不靠箭头表达**：块标自己变成环（D2），箭头只表示方向。
 *
 * ⚠️ gutter（块标 / 折叠箭头 / 导轨）放在 `.blk` 里，**不占行内文本**：
 * 一旦混进 `.tx`，读回模型时会被当成字的「锚点粘性」）。
 */
export function makeBlockEl(
  r: VisibleRow,
  fill: (tx: HTMLElement) => void,
  /**
   * `folded` 由调用方给：DOM 层**不持有折叠态**，它只画「这一行现在收没收起」。
   * 省略 ＝ 当作全展开（槽里的静态卡片不需要折叠）。
   *
   * `gutter` 同样是**已经算好的**（由调用方按森林 ＋ atoms 派生）：本文件是渲染层，
   * 不知道森林在哪；在这里现算就会变成「每画一行都扫一遍全库」。
   *
   * `find` 是引用解析用的查找函数（同 `fillBlockText`）：标签槽的名字也是现算的，
   * 不传 ⇒ 不画标签槽（静态卡片没有森林可查，容忍没有 chip）。
   */
  opts: {
    /** 这一屏只有这一块：空块的占位文案换成「第一句」的口径 */
    single: boolean
    /** 空块占位（给了就盖过默认那两句；见 `ViewOpts.placeholder`） */
    placeholder?: string
    ancestors?: readonly string[]
    /** 引述容器的变体与深度：抬头与其正文行共用一条竖线、同一档缩进 */
    quoteCtx?: { variant: string; depth: number; direct: boolean } | null
    folded?: FoldState
    gutter?: readonly GutterField[]
    find?: FindBlock
    /** 行尾引用数徽标（派生、0 次不画）：与标签 chip 同槽，排在最右 */
    refBadge?: HTMLElement | null
    /** 标签 chips 拖拽重排的落点（≥2 枚才可拖）：收并回内联位次后的完整归属序，由编辑器写回 */
    onReorderTags?: (blockId: string, orderedIds: string[]) => void
    context?: readonly Block[]
    /** 这一行为什么出现在这一屏里（`Doc.rootNotes`）；省略 ＝ 不画那一格 */
    note?: string
    /**
     * **备注根在评论谁**（`core/views/note-source.ts` 现算）：每个宿主一格。
     *
     * 备注住森林顶层，离开宿主页面就没有上下文 ⇒ 装载到哪儿都得自己说明来路。
     * 点击由装配层接（`data-note-host`）：`view` 不认识导航。
     * 省略 ＝ 不是备注，或这一屏已经说明了宿主（备注栏／浮窗）。
     */
    noteSource?: readonly NoteSourceCell[]
    /** 这是一个「展开出来的上下文根」：行首给「收起上下文」 */
    contextBack?: boolean
    /**
     * **露面块的身体**（镜像／投影）：由 UI 层画，`view` 只给位置。
     *
     * 身体是**另一个编辑宿主**（岛）：它可能是另一台编辑器（镜像）或一张表（投影）。
     * 由装配层接（`ViewEvents.embedBody`），这一层只负责「有这一格、归你画」。
     * 不传 ⇒ 只画抬头，身体留空——看得见地缺，不退化成一行普通文字。
     */
    embedBody?: (b: Block, into: HTMLElement) => void
    /**
     * **查询块自己的身体**（贴在这一行下面，而不是等「打开」）。
     *
     * 与 `embedBody` 同一条分工：`view` 只交代「这一行有身体、归你画」，
     * 画法（`ViewHost`）在装配层。行内体是另一个编辑宿主（岛），高度是自然高
     * （紧凑性归折叠）；只有虚拟化档的占位按 `VIEW_BODY_H` 估算。
     *
     * ⚠️ 只有 `rowHasInlineViewBody` 为真的行才调用（按源分派，段根同此）；
     *    结果行／里层编辑器在构造上没有这个回调，深度由此截断。
     */
    viewBody?: (b: Block, into: HTMLElement) => void
    /**
     * **代码块的编辑岛**：只给可编辑面；静态投影（卡片/表格/搜索结果）不接这个回调，
     * 就不会为每个单元格起一台编辑器。
     */
    codeBody?: (b: Block, into: HTMLElement) => void
    /**
     * **代码块语言徽章的落点**（点它换语言）。
     *
     * 与 `codeBody` 同一条分工：`view` 只画「这一行是什么语言」，
     * 「换语言」是一次命令（写 `_lang`），由装配层接。
     * 不接 ⇒ 不画徽章（静态投影没有可切换的东西，也不该多一颗死按钮）。
     */
    codeLangMenu?: (blockId: string, anchor: DOMRect, trigger: HTMLElement) => void
    /**
     * **引述块变体徽章的落点**（点它换引述/信息/警告…）。
     * 与 `codeLangMenu` 同一条分工：`view` 只画当前变体，「换变体」是命令（写 `_callout`）。
     * 不接 ⇒ 不画徽章（静态投影没有可切换的东西）。
     */
    calloutMenu?: (blockId: string, anchor: DOMRect, trigger: HTMLElement) => void
    /**
     * **身体块行头那颗折叠按钮的落点**（只折身体，不折子块）。
     * 不接 ⇒ 不画动作组（静态投影不多一颗点了没反应的按钮）。
     */
    bodyAction?: (act: BlockAction, blockId: string) => void
    /**
     * **「只收身体」那张表**（`Doc.bodyFolded`）：与 `folded` 分开的第二层。
     *
     * 不传 ⇒ 当作全展开（静态投影没有折叠态，也不该假装有）。
     */
    bodyFolded?: FoldState
    /**
     * **正文里自动化块的身体**（三段式：当／如果／就）。与 `viewBody` 同一条分工
     * （`view` 不 import `ui`、装配层给画法、行内体是另一个编辑宿主）；
     * 「哪一行画」同走 `rowHasInlineViewBody`（自动化块是身体的一种源）。
     */
    automationBody?: (b: Block, into: HTMLElement) => void
    /**
     * **正文里属性定义块／标签的身体**（定义值配置／字段声明的就地投影）。
     * 与 `automationBody` 同一条分工；「哪一行画」同走 `rowHasInlineViewBody`
     * （属性定义块／有声明的标签是身体的源）。不接 ⇒ 定义块只剩名字一行。
     */
    defBody?: (b: Block, into: HTMLElement) => void
    /**
     * **页/日记根行下面要不要留「标题-正文气口」**（主编辑面给 `true`）。
     *
     * 它是一条 16px 的 padding，也是「在第一块之前建块」的命中面（见 `inTitleGap`
     * 与 `blocks.css`）。用参数而不是 `#editor` 选择器：离屏预量用的是文档外的临时
     * 容器，选择器匹配不到就会把行高量短 16px，虚拟化的总高跟着漂。
     */
    titleGap?: boolean
    /**
     * **块下属性行**：有值、且没画在块标后的属性（派生见 `belowFieldsFor`）。
     *
     * `view` 只交代「这一行有这一格」并把它算进高度；值文本与点击（开属性面板）
     * 由装配层给——和 `viewBody`／`embedBody` 同一条分工。
     */
    below?: BelowFields
    propsLine?: (b: Block, data: BelowFields, into: HTMLElement) => void
  },
): HTMLElement {
  const b = r.block
  const folded = opts.folded?.[b.id] === true
  /**
   * **身体自己收起来了没有**（第二张表 `bodyFolded`）。
   *
   * 与 `folded` 分开：`folded` 是「这一行下面整片收起」（身体 ＋ 子块），
   * 这一位只收身体那一格。身体可见 ⟺ 两位都为假。
   */
  const bodyFolded = opts.bodyFolded?.[b.id] === true
  const bodyHidden = folded || bodyFolded
  /**
   * 露面行的**归属**先算（foldable／导轨／块标绑定都要用它）：
   *   · 普通行（含查询行）＝`own`：块标绑行自己；
   *   · 投影行＝`sourceMarker`：宿主行画一颗**绑源**的块标——身体是表，
   *     里面没有「源的那一行」可以顶上来，chrome 只能由宿主行出；
   *   · 镜像行＝`island`：宿主行**不画** gutter——岛首行（源自己那一行）的块标、
   *     折叠三角、导轨就是这一行的 chrome，身体左移一个 gutter 对齐块标列（CSS）。
   */
  const embedRes = isEmbedBlock(b) ? resolveEmbed(b, opts.find ?? (() => undefined)) : null
  const embedKind = embedRes ? embedBodyOf(b, opts.find ?? (() => undefined)) : null
  const embedChrome: 'own' | 'sourceMarker' | 'island' =
    !embedRes ? 'own' : embedKind === 'view' ? 'sourceMarker' : 'island'
  const markerTargetId = embedChrome === 'sourceMarker' && embedRes?.status === 'ok' ? embedRes.target.id : b.id
  /**
   * 这一行能不能折：有子块，或**有身体**（查询块的结果视图／露面投影）。
   *
   * 身体只在「这个表面真的会画它」时可折（`opts.viewBody`／`opts.embedBody` 是否接上）：
   * 查询结果列表里的命中行也是查询块，但那一层画的是**结果行**，不是它自己的位置；
   * 给它一个折叠三角就是死控件。
   */
  /**
   * **行身体**（查询结果／children 视图／自动化定义／定义值配置／字段声明）：
   * 源清单唯一一份（`hasInlineBody`），折叠三角与身体挂载吃同一个答案——
   * 有身体的行可折（折的是身体这一格），没有回调的表面构造上不画。
   */
  const inlineBody = Boolean(opts.viewBody || opts.automationBody || opts.defBody) && rowHasInlineViewBody(r)
  const embedBodyFoldable = Boolean(opts.embedBody) && embedKind === 'view'
  /** 代码块的身体（CM6）只在真的接了这个表面时可折；收起态由题注行顶替 */
  const codeBodyFoldable = Boolean(opts.codeBody) && blockTypeOf(b) === CODE_TYPE
  const foldable = r.hasChildren || inlineBody || embedBodyFoldable || codeBodyFoldable
  /**
   * gutter 上那个**关闭态开关**：只认 `_use: 'closure'` 的字段（＋合法 `_check`）。
   *
   * ⚠️ 判据是**用途**，不是固定 propId、也不是「叫任务的那个属性」：自定义的关闭态属性
   *    与内置的那条走同一套。这个用途库级唯一，没有「多个完成型字段取第一条」的裁决。
   * ⚠️ **布尔开关（`checkbox` kind）不参与**：它是「值没有名字」的两态，谁也不知道
   *    `true` 是不是「关闭」；让它借关闭态方框（`data-closure`／划线）＝ 同一枚方框两种意思。
   *    它自己在 gutter 上画自己的方框，只由那一下点击切（与 `⌘↵` 无关）。
   */
  const closureField = opts.gutter?.find((f) => f.use === CLOSURE_USE && f.check !== undefined)
  /**
   * 关闭态（开／关）：该字段的值＝`_check.on` ⇒ 关闭；其余已声明形态（未填、进行中…）
   * ⇒ 未关闭；没有这个字段 ⇒ 这一行没有关闭态（不是「未关闭」）。
   *
   * ⚠️ **未填要算「未关闭」，不能算「没有关闭态」**：这个槽的准入判据是「这块有这条属性」
   *    而不是「这条属性有值」（见 `gutterFieldsOf`）—— 刚给它加上、还没点过的那一下，
   *    正是这个入口存在的理由。若未填落进「没有关闭态」，块左边会画出一个空心方框，
   *    却同时被当成普通块（没有 `data-closure`）⇒ 方框与状态各说一套。
   *
   * ⚠️ `data-closure` 是 **CSS 与冒烟的契约**（删除线按它选），值只有 `open`／`closed`。
   */
  const closure: 'open' | 'closed' | undefined =
    closureField === undefined || closureField.check === undefined
      ? undefined
      : closureField.value === closureField.check.on
        ? 'closed'
        : 'open'
  const el = document.createElement('div')
  el.className = 'blk'
  el.dataset.blockId = b.id
  el.dataset.depth = String(r.depth)
  /**
   * **类型进 DOM**（不是角色）：主题与插件要按「这一行是什么类型的块」改外观时，
   * 需要看得到它 —— 分割线要把块标藏起来，靠的就是这一格。
   * 只写非默认类型：默认类型是绝大多数，写上去只是给每个块多一个属性。
   */
  const typeId = blockTypeOf(b)
  if (typeId !== DEFAULT_BLOCK_TYPE) el.dataset.type = typeId
  if (folded && foldable) el.dataset.collapsed = '1'
  /**
   * **只收身体**（第二层折叠）：与 `data-collapsed` 分开一位。
   *
   * 不复用 `data-collapsed`：那一格会连带收起导轨段（「这一行的子树没了」）、
   * 让块标浮底盘、让左侧三角常驻——而「只收身体」时子块还在，那些信号全会撒谎。
   */
  if (bodyFolded && !folded) el.dataset.bodyCollapsed = '1'
  if (closure) el.dataset.closure = closure
  if (r.hasChildren) el.dataset.hasChildren = '1'
  if (opts.quoteCtx || blockTypeOf(b) === QUOTE_TYPE) {
    /**
     * 引述组的视觉身份**只有一个来源**：类型记录里的颜色。
     * 行内写 `--callout-c`（记录色 → `identityColorCss`），按 id 的 CSS 规则一个不留——
     * 否则「表是取色唯一来源」只在记录改之前成立，改完之后屏幕与表各说一套。
     *
     * `data-quote` 仍是**类型 id**（既有契约：主题/插件按它选中整组）；
     * 追加的 `data-callout` 是同一个值得扩展面，名字直白。
     */
    const raw = opts.quoteCtx ? opts.quoteCtx.variant : prop<string>(b, CALLOUT_PROP)
    const type = calloutTypeOf(raw, calloutTypesOf(opts.find))
    el.dataset.quote = type.id
    el.dataset.callout = type.id
    const depth = opts.quoteCtx ? opts.quoteCtx.depth : r.depth
    el.style.setProperty('--quote-depth', String(depth))
    if (type.color) el.style.setProperty('--callout-c', identityColorCss(type.color))
    // 只有直接子块是「引述的一行」：平铺、无块标；孙块按普通块展示
    if (opts.quoteCtx?.direct) el.dataset.quoteLine = '1'
  }
  // 角色进 DOM：页 / 日记作为**正文第一行**时靠它取样式。
  // 兼位块把**全部角色**写进同一个属性（空格分隔，选择器用 `~=`）——
  // 只写一个会等于按数组顺序裁决，而角色的顺序不承载语义。
  // ⚠️ 这只是**外观**差异，语义上它仍是一块（2026-10-20 去掉「标题」概念后的口径）
  const roles = identityTags(b)
  if (roles.length) el.dataset.role = roles.join(' ')
  /**
   * **标题-正文气口**：只给主编辑面的页/日记根行（`opts.titleGap` 由那台编辑器给）。
   * 用属性而不是 `#editor` 选择器：离屏预量的临时容器不是 `#editor`，选择器匹配不到
   * 就会把行高量短 16px（虚拟化的总高跟着漂）。判据的另一半在 `inTitleGap`。
   */
  if (opts.titleGap === true && r.depth === 0 && (roles.includes('page') || roles.includes('journal'))) {
    el.dataset.titleGap = '1'
  }
  el.style.setProperty('--depth', String(r.depth))

  /**
   * **面包屑**：这一行来自库的哪一条路径（只有 `roots` 里那些行会带）。
   *
   * 为什么在 `.blk` 里、`.tx` 外：它描述**位置**，不是这一块的正文；落进 `.tx`
   * 就会被 `readRuns` 当字读回去。与别名头同一条布局（`flex: 0 0 100%` 独占一行）。
   * ⚠️ 必须登记进 `ALLOWED_ROW_CHILDREN`：漏了它，第一次收光标就会被当游离节点删掉。
   */
  const trail = opts.context ?? []
  /**
   * **来源说明**：这一行为什么出现在这一屏里（`Doc.rootNotes`）。
   *
   * 与面包屑同一条布局（`.blk-context` 那一行、`.tx` 外）：它描述**来路**而不是内容，
   * 落进 `.tx` 就会被 `readRuns` 当字读回去。
   * 只在**有**说明时才多挂这一格：绝大多数装载没有它，不该为此多一个空节点。
   *
   * ⚠️ 这一行现在住三类东西，顺序＝**先在哪，再是什么，最后为什么**：
   *    面包屑（位置）→ 备注来源（身份）→ `rootNotes`（为什么这次装载选它）。
   */
  const note = opts.note ?? ''
  const noteSrc = opts.noteSource ?? []
  if (trail.length > 0 || opts.contextBack || note !== '' || noteSrc.length > 0) {
    el.dataset.context = '1'
    const ctx = document.createElement('span')
    ctx.className = 'blk-context'
    ctx.contentEditable = 'false'
    const sep = (): HTMLSpanElement => {
      const s = document.createElement('span')
      s.className = 'blk-context-sep'
      s.setAttribute('aria-hidden', 'true')
      s.textContent = '›'
      return s
    }
    for (const [i, a] of trail.entries()) {
      if (i > 0) ctx.appendChild(sep())
      /**
       * 一格 ＝ **就地展开上下文**：点一级把那个祖先装成这一栏的根，命中行落进真实子树；
       * ⌘/Ctrl 点仍是跳转，Shift 点仍是右槽。只是标记，动作由装配层的事件委托处理 ——
       * `view` 不认识导航，也不认识「这一栏的 root 怎么换」。
       */
      const cell = document.createElement('button')
      cell.type = 'button'
      cell.className = 'blk-context-cell ui-ellipsis'
      cell.dataset.crumbFor = a.id
      cell.dataset.tip = t('ui.crumb.hint')
      cell.textContent = blockLabel(a, opts.find)
      ctx.appendChild(cell)
    }
    if (opts.contextBack) {
      /**
       * 展开出来的根可以**逐层退回**：点一次收掉这一层，露出下面一层；
       * 退完所有层就是原来那条命中行。这是视图动作，由装配层接（`data-context-back-for`）。
       */
      const back = document.createElement('button')
      back.type = 'button'
      back.className = 'blk-context-back'
      back.dataset.contextBackFor = b.id
      back.textContent = `↩ ${t('ui.context.collapse')}`
      ctx.appendChild(back)
    }
    if (noteSrc.length > 0) {
      /**
       * **备注在评论谁**：这是它的身份，不是「这次为什么被选中」——
       * 所以排在面包屑之后、`rootNotes` 之前。
       * 宿主被删时留一句「原文已删除」而不是隐去：备注在库里还在，
       * 它「评过谁」的事实也还在，只是去处没了。
       */
      const prefix = document.createElement('span')
      prefix.className = 'blk-context-note'
      prefix.textContent = t('ui.note.sourcePrefix')
      ctx.appendChild(prefix)
      for (const cell of noteSrc) {
        if (cell.dangling) continue
        const src = document.createElement('button')
        src.type = 'button'
        src.className = 'blk-context-cell ui-ellipsis'
        src.dataset.noteHost = cell.hostId
        src.dataset.tip = t('ui.note.sourceTip', { label: cell.label })
        src.textContent = cell.quote === '' ? cell.label : `「${cell.quote}」· ${cell.label}`
        ctx.appendChild(src)
      }
      if (noteSrc.some((c) => c.dangling)) {
        const gone = document.createElement('span')
        gone.className = 'blk-context-note ui-ellipsis'
        gone.textContent = t('ui.note.sourceGone')
        ctx.appendChild(gone)
      }
    }
    if (note !== '') {
      // 只读的说明，不是可点的面包屑格：它回答「为什么」，不提供去处
      const src = document.createElement('span')
      src.className = 'blk-context-note ui-ellipsis'
      src.textContent = note
      ctx.appendChild(src)
    }
    el.appendChild(ctx)
  }

  /**
   * **别名头**：这一行显示的名字（主别名叶子），以及两个入口（别名与露面 / 属性）。
   *
   * ⚠️ 它住在 `.blk` 里、**`.tx` 外**：编辑器把 `.tx` 的文字读回模型（`readText`），
   *    名字一旦进了 `.tx`，改描述就会变成改名 —— 地址与描述必须各在自己的槽里。
   * ⚠️ `_display === 'text'` 时**完全不生成这个节点**（不是隐藏）：用户选了「显示文本」，
   *    这一行就不该多出一块不可编辑的头。
   * ⚠️ 按钮只是**标记**（`data-alias-action`），点击由装配层的事件委托处理：
   *    view 层不认识浮层，也不该向上调用 app。
   */
  const aliasNames = aliasesOf(b)
  if (aliasNames.length > 0 && prop<string>(b, DISPLAY_PROP) !== 'text') {
    el.dataset.alias = '1'
    const head = document.createElement('div')
    head.className = 'blk-alias'
    head.contentEditable = 'false'
    head.dataset.aliasFor = b.id

    const name = document.createElement('span')
    name.className = 'blk-alias-name ui-ellipsis'
    name.dataset.aliasAction = 'config'
    // 显示叶子（`A/B` ⇒ `B`）；全名放进 title，路径语义不挤占行宽
    name.textContent = displayNameOf(b)
    name.dataset.tip = t('ui.alias.fullName', { name: primaryAliasOf(b) })
    head.appendChild(name)

    const config = document.createElement('button')
    config.type = 'button'
    config.className = 'blk-alias-btn'
    config.dataset.aliasAction = 'config'
    config.dataset.tip = t('ui.blockConfig.title')
    config.appendChild(createIcon('sliders-horizontal', 'sm'))
    head.appendChild(config)

    const props = document.createElement('button')
    props.type = 'button'
    props.className = 'blk-alias-btn'
    props.dataset.aliasAction = 'props'
    props.dataset.tip = t('ui.block.properties')
    props.appendChild(createIcon('panel-right', 'sm'))
    head.appendChild(props)
    el.appendChild(head)
  }

  /**
   * **行首头占了几行**（`--head-rows`）：别名头与面包屑各自 `flex: 0 0 100%`，
   * 一个头就是**一整行**，块标与正文被挤到它们下面。
   *
   * 为什么要在 DOM 里报这个数：`.rail-self`（这一行自己的延续段）的起点是
   * 「块标中心」，而块标**不一定在行顶**。`top: 1lh/2` 是按行顶算的 —— 聚焦一个页
   * 时那条线就从页名里面冒出来，往上多出一整段（`.blk-alias` 高 16px 左右）。
   * ⇒ 纵向几何必须先跨过这几个头。
   *
   * 报**行数**而不是像素：行高与行距是 token，渲染层不该知道它们的数值
   * （`blocks.css` 拿这个数乘 token 得到偏移）。行数则是**结构**，只有这里知道。
   * 判据取 `data-alias`／`data-context` 这两个已经落下的标记，不重写一遍条件 ——
   * 重写就会在「哪天头换了触发条件」时与它们分叉。
   */
  const headRows = Number(el.dataset.context === '1') + Number(el.dataset.alias === '1')
  if (headRows > 0) el.style.setProperty('--head-rows', String(headRows))

  /**
   * **可点导轨**：每个活着的祖先画 1 段。
   *
   * 深度 d 的行有 d 段，`--rail-depth` 是**层级 k**（0 = 最外层祖先）。
   * 段天然拼成整条线；点击哪一段就折叠哪一层祖先。
   *
   * ⚠️ `.rails` 绝对定位、`pointer-events:none`，只有 `.rail` 自己是 `auto`——
   *    否则这一层会把整行的文本选择全部挡住。
   * ⚠️ 折叠后子行不挂载 ⇒ 段自然消失，不需要额外清理。
   */
  const ancestors = opts.ancestors ?? []
  if (ancestors.length > 0) {
    const rails = document.createElement('span')
    rails.className = 'rails'
    rails.setAttribute('aria-hidden', 'true')
    rails.contentEditable = 'false'
    for (let k = 0; k < ancestors.length; k++) {
      // 引述容器那一列由变体竖线（::before）承担，不再叠一条灰导轨；
      // 其它祖先列照画 ⇒ 外侧的页/父导轨在引述区不断（实测：只藏直系行会让它断）。
      if (opts.quoteCtx && k === opts.quoteCtx.depth) continue
      const rail = document.createElement('span')
      rail.className = 'rail'
      rail.dataset.foldLineFor = ancestors[k]!
      rail.style.setProperty('--rail-depth', String(k))
      rail.dataset.tip = t('ui.block.foldLine')
      rails.appendChild(rail)
    }
    el.appendChild(rails)
  }

  /**
   * **这一行自己的线**（`.rail-self`）：**只画块标下方那一段**（CSS 的 `::after`），
   * 从块标下方 `--ui-rail-gap` 起、一路到行底，接上子行那批段。
   *
   * 为什么需要它：上面那批段是「**为了祖先**而画」的——一条线活在**子行**上。
   * 于是父块**自己那一行**没有属于它的线：块标底下到行底之间是空的，
   * 而紧接着的第一条子行才开始画。父块只有一行时这段空隙不到 10px，看不出来；
   * 一旦正文换行成三行，那 100px 的正文左侧就**整片没有线**，看起来像线「断了」。
   * ⇒ 父块的线要**两处拼起来**：自己这一行（本节点）＋ 所有子行（上面那批段）。
   *
   * **只在有子块且未折叠的行生成**：线的语义是**子树的范围**，叶子块没有子树
   * ⇒ 它不该碰线，圆点上下都不画。
   *
   * ⚠️ **身体行（查询内联体／投影）是唯一的例外：折叠态也画**。普通块折叠后子行
   *    不挂载，线没有去处 ⇒ 不画；身体行的「子树」是**身体那一格**（`display:none`
   *    只藏不卸），行自己还看得见——而可点件的判据是「**点完之后仍然存在**」：
   *    折了之后短段锚在行上（CSS 的 `bottom: 0` 随行高自动缩短），再点一次展开。
   *    若折叠后把线摘掉，折查询块就只能靠悬停才出现的三角，竖线成了单向的。
   *
   * ⚠️ **没有「上段」**（2026-10-30 改：线**挂在父块标下面**，不穿过块标 ——
   *    导轨 x 与父块标 x 对齐）。
   *    带上段时两个后果用户都看见了：段首行（日记流的第二个日期）块标上方悬着一小截；
   *    以及「线离上面那颗块标近、离下面那颗远」。去掉之后线的两端各自离块标 ≈ 半行。
   *
   * ⚠️ **不带 `.rail` 这个 class**：`.rail` 的口径是「深度 d 的行有 d 个**祖先**段」，
   *    而这个节点是「这一行**自己**的」。挂同一个 class 会让那条「数段数」的契约
   *    多算一段（`check` 里有一条按 `.rail` 计数，一挂就红）——名字不同是因为语义不同。
   * ⚠️ 它是 `.rails` 的**兄弟**、不是它的子节点：`.rails` 的 `overflow:hidden` 与
   *    `pointer-events:none` 是为「祖先段」定的，这个段要贴着自己的块标、且有自己的命中区。
   * ⚠️ 纵向范围由 CSS 定（`top: 块标中心 ＋ gap`、`bottom: 0`），不在这里算像素：
   *    `1lh` 与 `--ui-bullet-size` 是 token，DOM 层不该知道它们的数值。
   */
  const bodyRow = !r.hasChildren && (inlineBody || embedBodyFoldable || codeBodyFoldable)
  if ((r.hasChildren || bodyRow) && (!folded || bodyRow)) {
    const self = document.createElement('span')
    self.className = 'rail-self'
    self.setAttribute('aria-hidden', 'true')
    self.contentEditable = 'false'
    // 这一段是「自己的子树」（子块层，或身体那一层），可点折/展
    self.dataset.foldLineFor = b.id
    self.dataset.tip = t('ui.block.foldLine')
    el.appendChild(self)
  }

  /**
   * **露面行的 chrome 归属**：块标回左边，且绑定到它正在呈现的那一块。
   *
   * 为什么块标绑源：露面就是「这一块又出现一次」，行上 chrome 说「聚焦／拖动」
   * 指的是它正在呈现的那一块；宿主块自己从不当整屏的视图根，它的块标没有独立语义。
   * （三种归属的判据在上方 foldable 之前——foldable／导轨／块标绑定共用同一份。）
   */

  const left = embedChrome === 'island' ? null : document.createElement('span')
  if (left) {
    left.className = 'left'
    left.contentEditable = 'false'
  }

  /**
   * 折叠箭头（D2）：**悬停才现**，且**绝对定位不占位**。
   * 静止态**完全看不到**，行悬停才淡入——常驻的折叠箭头会与块标抢空间，也让人分心。
   * 折叠态的可发现性由**块标自身的环**承担（D2 的明文口径），不靠常驻箭头。
   *
   * ⚠️ 既无子块也**无身体**时**不生成这个节点**（R2）——空行的三角是纯噪声。
   *
   * ⚠️ **有子块才画这颗三角**（2026-11-26 修订）：它的语义是「折这一行下面**整片**」。
   *    身体块的行头另有一颗「只折身体」的按钮（`.blk-acts` 里的 `body-fold`），
   *    两颗同时在同一个行上、折的又是同一件事时，左侧这颗就只是重复的入口。
   *    没有子块的块（查询／代码／露面投影）本来就只折身体 ⇒ 交给行头那颗。
   *    有子块的身体块两层都要 ⇒ 左侧折整片、行头折身体，各说一件事。
   */
  if (left && r.hasChildren) {
    const fold = document.createElement('span')
    fold.className = 'fold'
    fold.dataset.foldFor = b.id
    // 始终画 `chevron-down`：收起态由 CSS 旋转（`.blk[data-collapsed] .fold .ico`）
    fold.appendChild(createIcon('chevron-down', 'sm'))
    fold.dataset.tip = folded ? t('ui.block.foldExpand') : t('ui.block.foldCollapse')
    left.appendChild(fold)
  }

  /**
   * **块标 ＝ 把手**：画法住在 `marker.ts`（卡片这类非编辑态的投影也要挂同一颗），
   * 这一层只回答「这一行有没有 gutter、块标绑哪一块」。
   *
   * 行为：**左键 ＝ 聚焦/zoom**、右键 ＝ 块菜单、拖动 ＝ 移动。
   *
   * ⚠️ 这三条行为**不随身份变化**。让待办方框顶替块标，等于让「这块是任务」
   *    这一条属性吃掉「点它聚焦」这件事：同样是块标，点下去的结果却取决于块的属性，
   *    而这区别不写在任何地方。身份因此只作为**后缀**出现，见下面 `.identity`。
   *
   * ⚠️ 绑定与形状分离：`data-focus-for`／`data-drag-for` 指到 `markerTargetId`
   *    （普通行＝自己，投影行＝源）——行为对「这一块」不变，只是「这一块」是谁由行决定。
   */
  if (left) {
    left.appendChild(
      buildMarker(b, {
        find: opts.find,
        targetId: markerTargetId,
        handle: true,
        // 投影行：脸取源（宿主块只是「谁的又一次露面」），见 `marker.ts` 的 `source`
        ...(embedChrome === 'sourceMarker' && embedRes?.status === 'ok' ? { source: embedRes.target } : {}),
      }),
    )
  }

  /**
   * **gutter 上的快捷入口＝一列图标**，一条归 gutter 的属性一枚（顺序沿用
   * `gutterFieldsOf`：标签声明在前、自有属性在后）。
   *
   * 三种画法，区别在**点下去做什么**：
   *   · `_use: 'closure'`：关闭态开关（点一下翻开/关）——`.closure-box` ＋ `data-closure-for`，
   *     这两个名字是 CSS 与冒烟的契约；
   *   · `_check`（无 role）：普通勾选框（翻 on/off，不划线）——`.check-box` ＋ `data-check-for`；
   *   · 其余 select：普通值（点开选项菜单）——`.prop-mark` ＋ `data-prop-for`；
   *   · `checkbox`（布尔开关）：翻它自己的布尔值（`.check-box` ＋ `data-closure-for`）；
   *     **没有关闭态**（没有 `data-closure`／划线，`⌘↵` 也不切它）。带 `data-prop-id`，
   *     所以一行多个开关不会互相串台。
   *
   * **右键任何 select 类图标都开取值菜单**（状态标记也如此）：换到哪个值是显式意图，
   * 不该逼用户记住 ⌥ 才够得着（入口判据在 editor-events 的 contextmenu 支）。
   *
   * 图标取选项自己的 `_icon`，缺省用定义块的 `_icon`；再缺省 select 画虚线框
   * （「这一栏在，但还没填」），checkbox 按勾选状态画方框/勾。
   */
  for (const field of opts.gutter ?? []) {
    /**
     * **多值 select**：一个字段贡献一串图标（每个选中值一枚），顺序＝选项兄弟序。
     * 整串是**一个**命中区：点任意一枚都打开同一个多选菜单——
     * 单枚图标不是「删掉这个值」的按钮（图标读作状态，误触代价不对称）。
     * 超过 3 枚收成 `+N`（不静默截断）。
     */
    if (field.kind === 'select' && field.cardinality === 'many') {
      const mark = document.createElement('span')
      mark.className = 'identity prop-mark prop-multi'
      mark.dataset.propFor = b.id
      mark.dataset.propId = field.propId
      const picked = field.picked ?? []
      const cap = 3
      if (picked.length === 0) {
        renderIcon(mark, prop<string>(field.def, '_icon'), 'square-dashed', 'md')
      } else {
        for (const c of picked.slice(0, cap)) {
          const ico = document.createElement('span')
          ico.className = 'prop-multi-ico'
          renderIcon(ico, c.icon ?? prop<string>(field.def, '_icon'), 'square-dashed', 'md')
          mark.appendChild(ico)
        }
        if (picked.length > cap) {
          const more = document.createElement('span')
          more.className = 'prop-multi-more'
          more.textContent = `+${picked.length - cap}`
          mark.appendChild(more)
        }
      }
      const labels = picked.map((c) => c.label.trim()).filter((x) => x !== '')
      mark.dataset.tip = t('ui.props.gutterTitle', {
        prop: blockLabel(field.def),
        value: labels.length === 0 ? t('ui.props.pending') : labels.join('、'),
      })
      left?.appendChild(mark)
      continue
    }
    if (field.kind === 'select') {
      // 关闭态：勾选框 + 划线/⌘↵（`_use: CLOSURE_USE` + `_check`）
      if (field.use === CLOSURE_USE && field.check) {
        const mark = document.createElement('span')
        mark.className = 'identity closure-box closure-mark'
        mark.dataset.propId = field.propId
        // 关闭态标记：**一个命中区两件事**。左键＝翻转（`data-closure-for`），
        // 右键／⌥+点＝取值菜单（`data-prop-for`）——两个属性同一处，事件按顺序分派。
        mark.dataset.closureFor = b.id
        mark.dataset.propFor = b.id
        renderIcon(mark, field.icon, closure === 'closed' ? 'circle-check' : 'circle', 'md')
        mark.dataset.tip = t('ui.closure.toggle')
        left?.appendChild(mark)
        continue
      }
      // 普通勾选框：只翻 on/off，不影响 closureOf/划线
      if (field.check) {
        const mark = document.createElement('span')
        mark.className = 'identity check-box'
        mark.dataset.propId = field.propId
        mark.dataset.checkFor = b.id
        renderIcon(mark, field.icon, field.value === field.check.on ? 'square-check' : 'square', 'md')
        const value = field.choice ? field.choice.label.trim() : ''
        mark.dataset.tip = t('ui.props.gutterTitle', {
          prop: blockLabel(field.def),
          value: value === '' ? t('ui.props.pending') : value,
        })
        left?.appendChild(mark)
        continue
      }
      const mark = document.createElement('span')
      mark.className = 'identity prop-mark'
      mark.dataset.propId = field.propId
      mark.dataset.propFor = b.id
      renderIcon(mark, field.icon, 'square-dashed', 'md')
      const value = field.choice ? field.choice.label.trim() : ''
      mark.dataset.tip = t('ui.props.gutterTitle', {
        prop: blockLabel(field.def),
        value: value === '' ? t('ui.props.pending') : value,
      })
      left?.appendChild(mark)
      continue
    }
    if (field.kind === 'checkbox') {
      const mark = document.createElement('span')
      // **开关**：值是布尔、没有名字 ⇒ 不是关闭态（不拿 `data-closure`、不划线）。
      // 走 `data-closure-for` 只是复用「点一下切自己那一格」的既有通道（带 propId 不串台），
      // 视觉用普通勾选框那一档：同一个方框图形，但没有「关闭」的含义。
      mark.className = 'identity check-box check-mark'
      mark.dataset.closureFor = b.id
      mark.dataset.propId = field.propId
      mark.appendChild(createIcon(field.value === true ? 'square-check' : 'square', 'md'))
      mark.dataset.tip = t('ui.props.gutterToggle', { prop: blockLabel(field.def) })
      left?.appendChild(mark)
    }
    // 其余 kind 暂不画：`_uiPosition` 的编辑入口只在 select 上给（见选项编辑器），
    // 但手写数据里出现也不该画一枚点了没反应的图标。
  }
  const tx = document.createElement('span')
  tx.className = 'tx'
  if (closure === 'closed') tx.classList.add('closed')
  /**
   * **没有正文的块**（分割线）：线放在 `.tx` **里面**，不另换一个元素替代 `.tx`。
   * 编辑器里有一批路径按 `.tx` 认块（取文本、落光标、标 caret），换掉 `.tx`
   * 等于让这一行在那些路径里「不存在」——静默失效，不报错。
   */
  /** 露面行的身体（构建后不立即挂：它的落位要排在自己的 chrome 之后，见末尾） */
  let embedBodyEl: HTMLElement | null = null
  /** 身体接进文档之后才执行的挂载（岛编辑器／ViewHost 的构造会量 DOM） */
  let embedMount: (() => void) | null = null
  /** 代码块的语言徽章（行尾，标题行右侧）：装配层接了「换语言」才画 */
  let codeLangChip: HTMLElement | null = null
  /** 引述变体：图标进 gutter 的属性图标格、标签进正文列（装配层接了「换变体」才画） */
  let calloutIcon: HTMLElement | null = null
  let calloutLabel: HTMLElement | null = null
  if (isEmbedBlock(b)) {
    /**
     * **露面块**：正文槽空着（它没有用户写的字），身体是另一个编辑宿主。
     *
     * 为什么身体**自成一格**（`.blk-embed-body`，`flex: 1 1 auto` 顶替 `.tx`）：
     * 镜像要看起来就像那一块在这里，而不是「一块里塞了另一块」——把 `.blk` 套进 `.tx`
     * 会同时踩中缩进（`--depth` 按 `.blk` 算）、块标位置与 `⌘A` 的三条既有判据。
     * 身体是岛（`data-edit-island`）：里层焦点归里层，外层重排不打断正在打的字。
     */
    el.dataset.embed = '1'
    el.dataset.embedState = embedRes!.status
    const body = document.createElement('div')
    body.className = 'blk-embed-body'
    body.contentEditable = 'false'
    body.setAttribute(EDIT_ISLAND_ATTR, '1')
    body.dataset.embedBodyFor = b.id
    /**
     * 身体是**投影**（源的结果视图）⇒ 可折（折/展都走这一行的折叠表）；
     * 镜像（那棵子树）是内容高，但岛首行要**顶到 gutter 列**
     * （CSS 按 `data-embed-body='mirror'` 左移一个 gutter）。
     */
    if (embedKind === 'view') {
      body.dataset.embedBody = 'view'
      /**
       * 折叠只藏不卸（ViewHost 的冻结结果与滚动位置还在），与查询内联体同一条口径。
       * ⚠️ 投影的身体里有两格（名字那一行 ＋ 结果面板）：`data-folded` 只藏**面板**
       *    （见 CSS），名字那一行折起来也看得见 —— 折的是「下一层」，不是这一块自己。
       */
      if (folded) body.dataset.folded = '1'
    } else {
      body.dataset.embedBody = 'mirror'
      /**
       * **镜像也认得折叠态**：宿主行没有自己的 gutter，但「折这一面镜子」＝
       * **源那一行留着、它的子块收起**（与投影「只藏下一层」同一条口径）。
       *
       * 折叠态由**成组折叠**写进外层的折叠表（`hasFoldable` 把露面块算作可折成员），
       * 落地的两处是这里（把态带到身体上）＋ `mountMirror` 的装载（把它带进岛里的源行）。
       *
       * ⚠️ 曾经只给投影写 `data-folded`：折叠表里明明有这一行，屏幕上什么都不动
       *    （用户报「镜像块是个父子块，点前面的线不折叠」）。
       */
      if (folded) body.dataset.folded = '1'
    }
    /**
     * **露面行没有自己的标题行**：这一行就是「那一块的又一次露面」。
     * 它的名字由**身体自己的首行**承担（投影里就是 Query 行、镜像里就是源那一行）——
     * 再往上叠一条宿主标题，同一个名字会读两遍。`.tx` 因此恒空（位留着，光标与 ⌘A
     * 的既有判据都按 `.tx` 认块）。
     */
    tx.dataset.embedSlot = '1'
    tx.setAttribute('aria-hidden', 'true')
    embedBodyEl = body
    embedMount = () => opts.embedBody?.(b, body)
  } else if (blockTypeOf(b) === CODE_TYPE) {
    /**
     * **行＝标题，身体＝代码文档**（`_code`）：与查询块「行＝名字，身体＝结果」同一条规则。
     * 标题就是普通正文槽，编辑、选区、`⌘X/⌘C`、富文本全走同一条管线。
     */
    el.dataset.code = '1'
    const firstLine = codeTextOf(b).split('\n')[0]?.trim() ?? ''
    if (isEmptyContent(b.content)) tx.dataset.ph = firstLine || t('ui.block.captionAdd')
    fill(tx)
    const body = document.createElement('div')
    body.className = 'blk-code-host'
    body.contentEditable = 'false'
    body.setAttribute(EDIT_ISLAND_ATTR, '1')
    body.dataset.codeBodyFor = b.id
    /**
     * 收起态**不挂 CM6**：折叠是阅读态，长代码不该为一行标题付一台编辑器。
     * 展开由 `toggleBodyCollapse`／`toggleCollapse` 重画这一行（`renderBlock`），
     * 这才会重新走 `codeBody`。
     *
     * ⚠️ 身体看得见 ⟺ `folded` 与 `bodyFolded` **都为假**：整片收起（`folded`）
     *    当然也收起身体，只折身体（`bodyFolded`）不动子块。两层各有一个位。
     */
    if (bodyHidden) body.dataset.folded = '1'
    embedBodyEl = body
    embedMount = bodyHidden ? null : () => opts.codeBody?.(b, body)
    // 语言徽章：**收起态也画**（那时标题行就是整块的脸，更需要知道它是什么语言）
    if (opts.codeLangMenu) codeLangChip = makeCodeLangChip(b, opts.codeLangMenu)
  } else if (blockTypeOf(b) === DIVIDER_TYPE) {
    const rule = document.createElement('span')
    rule.className = 'divider-rule'
    rule.setAttribute('aria-hidden', 'true')
    tx.appendChild(rule)
  } else if (blockTypeOf(b) === QUOTE_TYPE) {
    // 行容器抬头：只画变体徽章，正文槽恒空（正文在子块里，每行一个可引用的块）
    el.dataset.quoteHead = '1'
    tx.dataset.quoteHead = '1'
    tx.setAttribute('aria-hidden', 'true')
    if (opts.calloutMenu) {
      const chip = makeCalloutChip(b, opts.calloutMenu, opts.find)
      calloutIcon = chip.icon
      calloutLabel = chip.label
    }
  } else {
    fill(tx)
  }
  /*
   * journal 的**日期**：它是 `_date` 的只读投影，不是块的正文。
   * 2026-10-20 去掉「标题」之后，日期失去了落点（原来显示在文档头的页名位）
   * ⇒ 悬挂在第一行的**空块占位**上：仍不进 DOM 文本（读回模型不会被当成字），
   *   一旦用户开始写，`text` 非空，占位自然消失。
   *
   * ⚠️ **journal 行不可编辑**（2026-10-20 用户：日期不能编辑，但能光标聚焦不合适）：
   *    `contenteditable=false` ＋ `data-readonly` ⇒ 点它不落光标（见 editor-events 的 mousedown 分支）。
   *    写入该行的模型路径本来就不该存在（`_date` 是只读的，正文留空是它的常态）；
   *    以前能聚焦 ⇒ 光标停在日期后面、一打字就把日期挤掉，像在编辑一个不该存在的字段。
   *    左键点它另有去处：日期是那一天的**标题**，点击＝聚焦到那一天（editor-events 的
   *    click 分支按 `data-ph-readonly` 认它）——只读与可点不矛盾，落点不同而已。
   * ⚠️ **journal 与属性定义**都这样：前者正文是日期投影，后者正文是定义名。
   *    两者都没有「行内改字」这条路径，让 DOM 接受输入只会出现
   *    「字进 DOM、模型不变、控制台抛 protected」——重画一过字又消失。
   * ⚠️ `page` 行不在此列：页的正文就是描述，**必须可编辑**。
   */
  if (isReadonlyBlock(b) || isPropDefBlock(b)) {
    tx.contentEditable = 'false'
    tx.dataset.readonly = '1'
    /**
     * **定义名读作字段名，不读作正文**（次要色）：定义块的行是它的**签名**——
     * 名字是 label（这里降档），kind 是身份的另一半（尾上的徽章）。没有这一档，
     * 树里的定义块与内容块读成同一种东西，扫视时要靠滑杆图标逐个认。
     */
    if (isPropDefBlock(b)) tx.dataset.propDef = '1'
    /**
     * 占位文案只属于 **journal**：它的「正文」是 `_date` 的投影，投影要看得见。
     * 类型不可写的块没有可显示的内容（分割线的线本身就是全部），不挂占位——
     * 否则会在一条线旁边多出一行日期。属性定义的正文是定义名，已经画在行里了，也不挂。
     */
    if (isReadonlyBlock(b)) {
      if (!isEmptyContent(b.content)) {
        // 兜底：万一旧数据里 journal 有正文（不该发生），仍要能看见它
        tx.dataset.ph = plainText(b.content)
        tx.dataset.phReadonly = '1'
      } else if (isJournal(b)) {
        tx.dataset.ph = journalDateLabel(journalDate(b))
        tx.dataset.phReadonly = '1'
      }
    }
  } else if (isEmptyContent(b.content) && (opts.placeholder || opts.single)) {
    // 空块的幽灵占位：CSS 生成内容，**不进 DOM 文本**。
    // 普通空块不再给文案——空行本身已读作「可以写」，占位字反而要处理打字后的隐藏；
    // 占位只留给单块屏（空页第一句）与调用方显式给的（抬头等名字格子）。
    tx.dataset.ph = opts.placeholder ?? t('ui.block.placeholderFirst')
  }

  /**
   * **kind 徽章**（属性定义独有）：定义块＝（名字，kind，格式…），树里这一行是它在
   * 正文世界的唯一身体，只画名字＝只显示对象的一半——kind 决定成员块的值长什么、
   * 怎么编辑，却只能进检视卡才知道。徽章与标签槽同一个理由住在 `.tx` **之外**：
   * 正文读数与插入点只走 `.tx`，徽章不参与。
   */
  let kindBadge: HTMLElement | null = null
  if (isPropDefBlock(b) && !embedBodyEl) {
    kindBadge = document.createElement('span')
    kindBadge.className = 'blk-kind'
    kindBadge.contentEditable = 'false'
    kindBadge.textContent = t(`ui.props.kind.${propKindOf(b)}`)
  }

  /**
   * **行头的身体折叠按钮**：`.tx` 之后（靠它 `flex:1` 推到行右端），只在真有身体的
   * 普通行上画（代码文档／查询结果／自动化定义体／定义值投影）。
   *
   * ⚠️ **露面投影行也要**（`embedBodyFoldable`）：它的身体是一整块结果面板，
   *    折它是「这一块自己怎么显示」。而它没有子块 ⇒ 左侧那颗三角不存在
   *    （三角只给有子块的行）⇒ **行头这颗是它唯一的折叠入口**。
   *    ⚠️ 它挂在 `.blk-acts` 上、排在 `.tx` 之后；露面行的 `.tx` 是 `display:none`，
   *    没有东西把这一组推到行尾 ⇒ CSS 里给 `[data-embed='1'] > .blk-acts` 单独
   *    一条绝对定位（贴行的右上角），见 `blocks.css`。
   * ⚠️ **代码块走 `embedBodyEl` 那一支**（它的身体也是 `.blk-code-host`），
   *    但它的 `.tx` 是**可见的标题行**，所以按钮照画。
   */
  const wantBodyFold = Boolean(opts.bodyAction) && (inlineBody || codeBodyFoldable || embedBodyFoldable)
  /**
   * 这一行的 `.tx` 撑不撑得住靠右的按钮：露面行的 `.tx` 是 `display:none`，
   * 其余（含代码块）都是可见的正文／标题行。判据按「`.tx` 可见」，
   * 不按「走哪个身体分支」——代码块与露面块共用 `embedBodyEl`，但两者的 `.tx` 不同。
   *
   * ⚠️ **镜像行不画**（`embedChrome === 'island'`）：它的 chrome 全在岛首行那颗块标上，
   *    宿主行连 `.left` 都没有；宿主行再挂一组按钮会与岛内的折叠三角重复，
   *    而且没有块标列可依。镜像的折叠由**岛内那一行**承担（与「折源的那一层」同一条）。
   */
  const canCarryActs = embedChrome !== 'island'

  /**
   * **标签槽**：挂在正文槽**之后**（行右端），是 `.blk` 的直接子节点。
   *
   * ⚠️ 必须在 `.tx` 之外 —— 见 `makeTagsEl` 的说明：chip 在正文槽里，
   *    插入点就能落到它后面，那是「标签跳到文本后面」的全部来源。
   * ⚠️ 无标签不生成节点（`makeTagsEl` 返回 null ⇒ 不留空槽）。
   * ⚠️ `ALLOWED_ROW_CHILDREN` 已登记 `blk-tags`：漏了它，第一次收光标
   *    （`reclaimCaret`）就会把这枚槽当游离节点删掉。
   *
   * ⚠️ **必须在任何行下身体之前 append**（2026-11-26 修订）：这一格也装着引用数
   *    徽标，而它属于**名字那一行**。此前它排在身体之后 ⇒ 代码块（身体 `flex-basis:
   *    100%` 折行）的引用数掉到代码面**下面**；查询块的正文体是同一个坑的下一格。
   *    判据一句话：**名字那一行里的东西，都排在身体之前**。
   */
  const tags = makeTagsEl(
    b,
    opts.find,
    opts.refBadge,
    opts.onReorderTags ? (full) => opts.onReorderTags!(b.id, full) : undefined,
  )
  /**
   * **活的露面行不画宿主自己的标签/引用数**：这一行展示的是**源**（块标、名字、折叠
   * 都绑源），源自己的标签与引用数由身体里的源行/名字行承担。宿主块的身份仍住在
   * 它的配置面板里——在这行并排画两份，读者会读成「源有两个引用数」。
   *
   * 源不在（悬空／坏指针／自指）时没有身体里的源行可承担 ⇒ 宿主身份照常画。
   */
  const hostChrome = embedRes !== null && embedRes.status === 'ok' ? null : tags

  if (embedBodyEl) {
    /**
     * 露面行的 DOM 序＝视觉序：**名字那一行在前，身体在后**。
     *
     * · 代码块：标题行（块标＋标题＋语言＋标签/引用）在前，代码面折到下一行；
     * · 投影：名字在身体里的 `embed-title-row`，身体就是那一行 ⇒ 身体在前，
     *   折叠键排在身体之后（同一行的最右端，不压源自己的标签/引用数）；
     * · 镜像：宿主没有 chrome（岛首行就是这一行，块标列由 CSS 对齐）。
     */
    if (left) el.append(left, tx)
    else el.append(tx)
    // 语言徽章在标题行尾、折叠键之前（信息件靠内，鼠标 chrome 靠外）
    if (codeLangChip) el.appendChild(codeLangChip)
    if (embedKind === 'view') {
      /**
       * 投影没有宿主标题行：身体里的源名字行才是这一行的第一行 ⇒ 身体先占位，
       * 折叠键跟在其后。此前这颗键是绝对定位在行右上角，正好压在源自己的
       * 引用数徽标上（用户实测「折叠图标和引用数目重叠」）。
       */
      el.appendChild(embedBodyEl)
      embedMount?.()
      if (wantBodyFold && canCarryActs) {
        el.appendChild(makeBodyFoldToggle(b.id, bodyHidden, (act) => opts.bodyAction!(act, b.id)))
      }
    } else {
      if (wantBodyFold && canCarryActs) {
        el.appendChild(makeBodyFoldToggle(b.id, bodyHidden, (act) => opts.bodyAction!(act, b.id)))
      }
      if (hostChrome) el.appendChild(hostChrome)
      el.appendChild(embedBodyEl)
      // 身体接进文档之后再画：岛编辑器／ViewHost 的构造会量 DOM
      embedMount?.()
    }
  } else {
    // 变体图标进 gutter 的属性图标格（与正文行的属性图标同一列）
    if (calloutIcon) left!.appendChild(calloutIcon)
    el.appendChild(left!)
    // 变体标签进正文列（与正文行的块文本同一列）
    if (calloutLabel) el.appendChild(calloutLabel)
    el.appendChild(tx)
    if (kindBadge) el.appendChild(kindBadge)
    if (wantBodyFold) {
      el.appendChild(makeBodyFoldToggle(b.id, bodyHidden, (act) => opts.bodyAction!(act, b.id)))
    }
    if (hostChrome) el.appendChild(hostChrome)
  }

  /**
   * **块下属性行**：有值、且没画在块标后的属性（`select`/`checkbox` 有图标就不重复）。
   *
   * 位置在正文行之下、查询体之前（属性说的是这一块自己，结果说的是它的下一层）。
   * `flex-wrap` 让它独占一行，`margin-inline-start` 对齐 `.tx` 的起点——与别名头、
   * 查询体同一条几何口径。
   *
   * ⚠️ 它是**编辑岛**：里面是一排按钮，点下去焦点在按钮上。不标岛的话
   *    `ownFocus()` 会判成「本视图在编辑」，`restoreSel()` 会把光标抢回正文
   *    （与挂载区抬头那颗按钮同一个坑）。标了岛，外层连事件都不接，点击归按钮自己。
   * ⚠️ 必须登记进 `ALLOWED_ROW_CHILDREN`：漏了它，第一次收光标就会当游离节点删掉。
   */
  if (opts.below && opts.below.rows.length > 0 && opts.propsLine) {
    el.dataset.propsLine = '1'
    const line = document.createElement('div')
    line.className = 'blk-props-line'
    line.contentEditable = 'false'
    line.setAttribute(EDIT_ISLAND_ATTR, '1')
    line.dataset.propsLineFor = b.id
    el.appendChild(line)
    opts.propsLine(b, opts.below, line)
  }

  /**
   * **正文里的查询体**：贴在 `.tx` 下面的一整格（不是塞进 `.tx`）。
   *
   * 为什么不塞进 `.tx`：查询块的 `.tx` 是它的**名字**；身体是另一个编辑宿主，
   * 塞进去会让读数契约把表格当成正文。 `.blk` 用 `flex-wrap` 让这一格独占下一行，
   * `margin-inline-start` 对齐 `.tx` 的起点（gutter ＋ gap）。
   *
   * ⚠️ 必须登记进 `ALLOWED_ROW_CHILDREN`：漏了它，第一次收光标就会当游离节点删掉。
   */
  if (inlineBody) {
    el.dataset.viewBody = '1'
    const body = document.createElement('div')
    body.className = 'blk-view-body'
    body.contentEditable = 'false'
    body.setAttribute(EDIT_ISLAND_ATTR, '1')
    body.dataset.viewBodyFor = b.id
    /**
     * 折叠时**只藏身体、不卸载**：ViewHost 的冻结结果与滚动位置还在，
     * 展开是瞬间的；卸载会在每次折一下的时候重查一遍。
     * 所有位置（正文子行／聚焦单根／窗口根行）折的都是这一格 `data-folded`；
     * 整片收起与只折身体两层的答案在这里合成一格（`bodyHidden`）。
     */
    if (bodyHidden) body.dataset.folded = '1'
    el.appendChild(body)
    // 按源分派（`inlineBodyKind`：与保留行接回共用一份答案）：自动化块画三段式定义体；
    // 定义块/标签画属性定义投影；其余（查询／children 源）画视图宿主
    const bodyKind = inlineBodyKind(b)
    if (bodyKind === 'automation') opts.automationBody?.(b, body)
    else if (bodyKind === 'def') opts.defBody?.(b, body)
    else if (bodyKind === 'view') opts.viewBody?.(b, body)
  }
  return el
}
