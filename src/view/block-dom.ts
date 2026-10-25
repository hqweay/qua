/**
 * 把**模型**画成 DOM：一个块的内容 = 一串 run（文本段 ＋ 不可分的行内节点）。
 *
 * 这是从 `view.ts` 抽出来的纯渲染层。为什么它值得单独存在：
 *   · 它**不持有状态**（只吃 `Block` ＋ 一块解析用的 `FindBlock`，吐 `HTMLElement`），
 *     所以能脱离编辑器单独成型——将来「同一个块在槽里、在正文里、在引用预览里」
 * 用的是同一个函数（一源多视的前提）；
 *   · 它是**编辑器 DOM 契约的产地**（`.blk`／`.tx`／`.atom`／`data-depth`），
 *     契约集中在一处才守得住。
 *
 * ⚠️ 三条实测得来的纪律（不许破坏）：
 *   1. 缩进**不用 DOM 层级**，用扁平 ＋ `data-depth` ＋ padding（DOM 层级与虚拟化互斥）；
 *   2. 行内原子 = `contenteditable=false` 的 inline 元素，**在正文里占 1 格**（读数与光标都这么算）；
 *   3. gutter（块标/箭头/导轨）**不混进 `.tx`**：读回模型时会把它当成字。
 */
import {
  DEFAULT_BLOCK_TYPE,
  DIVIDER_TYPE,
  DISPLAY_PROP,
  aliasesOf,
  blockTypeOf,
  displayNameOf,
  identityTags,
  inlineTagIdsOf,
  isJournal,
  journalDate,
  journalDateLabel,
  primaryAliasOf,
  prop,
  tagIdsOf,
  typeDeclOf,
  type Block,
  type FindBlock,
  type FoldState,
  type GutterField,
  type RefView,
  type VisibleRow,
} from '../core/index.ts'
import { MARK_TYPES, isEmptyContent, plainText, refRunsOf, type MarkType, type RunWithId } from '../core/runs.ts'
import { t } from '../core/msg.ts'
import { danglingView, refTitle, resolveRefs } from '../core/ref.ts'
import { createIcon } from './icons.ts'

/** 行高：与 CSS 的 `--ui-line-h` 必须一致（虚拟化算占位高度要用） */
export const LINE_H = 30

/**
 * 别名头额外占的高度（近似值，只给虚拟化的占位滚动条用）。
 *
 * 别名头是 `.tx` 之外的一行：`--ui-fs-xs` × `--ui-lh-tight` ＋ `.blk` 的 row-gap。
 * 这里不读 computed style，是因为占位是在**没有挂 DOM**的行上算的；数值略大一点
 * 比略小好（滚动条高估只会多留白，低估会让最后几行跳一下）。
 */
export const ALIAS_HEAD_H = 18

/** 这一行在虚拟化里占多高：有别名头（且不是显示文本）就是两行 */
export function visibleRowHeight(b: Block): number {
  return aliasesOf(b).length > 0 && prop<string>(b, DISPLAY_PROP) !== 'text' ? LINE_H + ALIAS_HEAD_H : LINE_H
}

/**
 * 图片占位的缩略图：**内联 SVG，零网络**。
 * 真资产在里是独立对象；这里只是让占位能看出「这是一张图」。
 * 注意色值是按内容 hash **算**出来的（不是设计 token），所以本文件在 `[12]` 有白名单豁免。
 */
export function thumbUri(seed: string): string {
  let h = 0
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) % 360
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="40">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${h} 62% 62%)"/><stop offset="1" stop-color="hsl(${(h + 48) % 360} 58% 44%)"/>` +
    `</linearGradient></defs><rect width="64" height="40" fill="url(#g)"/>` +
    `<circle cx="46" cy="12" r="5" fill="rgba(255,255,255,.75)"/>` +
    `<path d="M4 36 L22 20 L34 30 L44 24 L60 36 Z" fill="rgba(255,255,255,.55)"/></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

/** 格式 → 语义标签：粗体用 `strong` 之类，让复制出去也是对的 */
export function tagForMark(t: MarkType): string {
  switch (t) {
    case 'bold':
      return 'strong'
    case 'italic':
      return 'em'
    case 'code':
      return 'code'
    default:
      return 'mark'
  }
}

/**
 * 行内原子 run → inline 元素（**占 1 格**，不可编辑，可点开）。
 *
 * `view` 是**解析结果**（`core/ref.ts`），不是 run 上的名字快照：
 * 目标改名后快照是过期的字，显示的必须是 `view.label`。
 * ⚠️ 图片不走解析（它的显示名是资产名，不指向块）⇒ `view` 可选。
 */
export function makeRunEl(r: RunWithId, view?: RefView): HTMLElement {
  const label = r.t === 'link' ? r.v : (view?.label ?? (r.t === 'ref' ? r.label : undefined) ?? (r.t === 'image' ? (r.asset.name ?? '') : ''))
  /**
   * 三种「标签样」的露面必须能一眼分清：
   *   · `tag`  —— 行内标签（指向标签类，`#名`，无底色）；
   *   · `obj`  —— 实例（指向一条记录，带小方块图标与细边框）；
   *   · `page` —— 普通引用（`[[名]]`）。
   * 判据来自**目标的当前身份**（`RefView.kind`），不在 run 上存第二份。
   */
  const kind =
    r.t === 'ref'
      ? r.flavor === '#'
        ? view?.kind === 'obj'
          ? 'obj'
          : 'tag'
        : 'page'
      : r.t
  const el = document.createElement('span')
  el.className = `atom atom-${kind}`
  if (view?.state === 'dangling') el.classList.add('dangling')
  if (r.t === 'image' && r.asset.state === 'missing') el.classList.add('missing')
  el.contentEditable = 'false'
  el.dataset.atomId = r.id
  // ⚠️ 解析后的显示名**另存一份到 `data-ref-label`**：`.atom-label` 里带 `[[ ]]`／`#` 装饰，
  //    而 run 上的名字快照是过期的 —— 给探针一个「此刻真的在显示什么」的读点。
  if (r.t === 'ref' || r.t === 'link') el.dataset.refLabel = label
  el.title =
    r.t === 'image'
      ? t('ui.atom.imageTitle', { label })
      : kind === 'obj'
        ? t(view?.state === 'dangling' ? 'ui.atom.objDanglingTitle' : 'ui.atom.objTitle', { label })
        : kind === 'tag'
          ? t(view?.state === 'dangling' ? 'ui.atom.tagDanglingTitle' : 'ui.atom.tagTitle', { label })
          : t(view?.state === 'dangling' ? 'ui.atom.pageDanglingTitle' : 'ui.atom.pageTitle', { label })
  if (kind === 'tag' || kind === 'obj') {
    /**
     * 实例与标签类都用 `#名字` 停在正文里；区分靠**外观**（实例多一枚小方块＋细边框），
     * 不靠改显示文字 —— 文字是用户的正文，不能为了区分身份改它。
     *
     * ⚠️ 它占正文 1 格（`data-atom-id`），但**不是** chip（不设 `data-tag-id`）：
     *    chip 的读数规则是「跳过、长度为 0」，而这一枚必须被读成 1 格，
     *    否则正文、光标会整体错位。
     */
    if (kind === 'obj') {
      const ico = document.createElement('span')
      ico.className = 'atom-ico'
      ico.appendChild(createIcon('square', 'sm'))
      el.appendChild(ico)
    }
    const text = document.createElement('span')
    text.className = 'atom-label'
    text.textContent = `#${label}`
    el.append(text)
  } else if (r.t === 'image') {
    const img = document.createElement('img')
    img.className = 'asset-thumb'
    img.alt = ''
    img.src = thumbUri(r.asset.hash)
    const name = document.createElement('span')
    name.className = 'asset-name'
    name.textContent = label
    el.append(img, name)
  } else if (r.t === 'link') {
    /**
     * 外链：显示文本是内容的一部分（`v` 进投影），`url` 只是目标。
     * 仍按**不可分原子**渲染（占 1 格）——链接是一枚行内对象，不是一串字。
     */
    const text = document.createElement('span')
    text.className = 'atom-label'
    text.textContent = label
    el.append(text)
  } else {
    /**
     * ⚠️ `[[ ]]` 是**显示装饰**，不进模型：run 上存的是目标 id ＋ 名字快照，
     *    否则「引用目标的正文」与「它在引用处显示的字」会变成两个要同步的东西。
     */
    const ico = document.createElement('span')
    ico.className = 'atom-ico'
    ico.appendChild(createIcon('arrow-up-right', 'sm'))
    const text = document.createElement('span')
    text.className = 'atom-label'
    text.textContent = `[[${label}]]`
    el.append(ico, text)
  }
  return el
}

/**
 * 标签 chip：**标签的归属在块上，这枚 chip 只是把它显示出来**。
 *
 * 形状（`tag-chip` ＋ `data-tag-id`）是渲染契约：主题按它上色，探针按它找标签。
 *
 * ⚠️ 它住在 `.blk` 的**标签槽**（`.blk-tags`）里、**`.tx` 之外**：标签没有位点，
 *    而正文槽里每个 DOM 位置都是潜在的插入点 —— chip 一旦在 `.tx` 里，
 *    光标就能落到它后面，打出来的字在 DOM 里排在 chip 后、模型里却是正文末尾，
 *    重画一次就表现为「标签跳到文本后面」。挪出正文槽后，插入点**物理上**进不去。
 *    读数路径（`view/dom-text.ts`）遇 `data-tag-id` 跳过 —— 这层防御保留。
 */
export function makeTagChipEl(tagId: string, name: string): HTMLElement {
  const el = document.createElement('span')
  el.className = 'tag-chip'
  el.dataset.tagId = tagId
  el.contentEditable = 'false'
  el.textContent = `#${name}`
  return el
}

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
 * 把一个块的行内内容装进 `.tx`：run 依序画——文本段按自己的 marks 套语义标签，
 * 原子画成不可分元素。
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
): void {
  tx.textContent = ''
  const refRuns = refRunsOf(b.content)
  const views = find ? resolveRefs(find, refRuns) : undefined

  for (const r of b.content) {
    if (r.t === 'text') {
      // 格式的嵌套顺序固定（按注册表序）：同一 run 每次渲染出同一棵 DOM，
      // 读回时按 class 集合解析，不依赖顺序
      let node: Node = document.createTextNode(r.v)
      for (const m of MARK_TYPES) {
        if (!r.marks?.includes(m)) continue
        const wrap = document.createElement(tagForMark(m))
        wrap.className = `mk mk-${m}`
        wrap.appendChild(node)
        node = wrap
      }
      tx.appendChild(node)
      continue
    }
    if (r.t === 'ref') {
      tx.appendChild(makeRunEl(r, views?.get(r.id) ?? danglingView(r.label ?? t('ui.atom.unknown'))))
      continue
    }
    tx.appendChild(makeRunEl(r))
  }

  if (tx.childNodes.length === 0) tx.appendChild(document.createElement('br'))
}

/**
 * **标签槽**：块级标签的显示位置 —— `.blk` 下、`.tx` 外的一个不可编辑容器。
 *
 * 为什么是独立槽而不是「拼在正文末尾」：标签是**无位点的归属**（`props._tags`），
 * 正文槽里每个位置都是潜在插入点 —— chip 留在 `.tx` 里，光标就能落到它后面，
 * 打出来的字 DOM 上排在 chip 后、模型里是正文末尾，重画后就「标签跳到文本后面」。
 * 槽挂在行右端（flex 布局，不悬浮不遮挡），插入点物理上进不去，错位从根上不存在。
 *
 * ⚠️ **已经在正文里露面的标签不再出 chip**：同一格归属只占一个显示位置。
 *    行内那枚是 1 格引用 run（在正文里），chip 是槽里的 0 格装饰 —— 两个都画，
 *    用户会看到两个 `#名`，而且删掉正文里那个，chip 还留着一个「幽灵」。
 * ⚠️ 名字走 `refTitle`（现算）：标签块改名后 chip 上的字要跟着变，
 *    所以这里不存名字、只认 id。目标块不在 ⇒ 这条归属没有可显示的名字，跳过。
 * ⚠️ **没有标签就不生成这个节点**（同 `.fold` 的口径，不是隐藏）：空槽是纯噪声。
 * ⚠️ 分割线没有正文槽，也不画标签槽。
 *
 * @returns 标签槽元素；无标签可显示时返回 null
 */
export function makeTagsEl(
  b: Block,
  find?: FindBlock,
): HTMLElement | null {
  if (!find) return null
  const inline = new Set(inlineTagIdsOf(b))
  const tags = [...tagIdsOf(b)].filter((tagId) => !inline.has(tagId) && find(tagId))
  if (tags.length === 0) return null
  const el = document.createElement('span')
  el.className = 'blk-tags'
  el.contentEditable = 'false'
  for (const tagId of tags) el.appendChild(makeTagChipEl(tagId, refTitle(find(tagId)!)))
  return el
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
 */
export const ALLOWED_ROW_CHILDREN: ReadonlySet<string> = new Set(['blk-alias', 'rails', 'rail-self', 'left', 'tx', 'blk-tags'])

/**
 * 一个可见行 → `.blk` 元素。
 *
 * **DOM 契约就在这里**：`data-block-id`／`data-depth`／`data-has-children`／
 * `data-collapsed`／`data-todo`／`--depth`，以及 `.left` 里的 `.marker`／`.fold`／`.identity`／`.todo-box`。
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
  opts: { single: boolean; ancestors?: readonly string[]; folded?: FoldState; gutter?: readonly GutterField[]; find?: FindBlock },
): HTMLElement {
  const b = r.block
  const folded = opts.folded?.[b.id] === true
  /** gutter 上那个**二元开关**（本轮只认 checkbox；别的 kind 还没定怎么画） */
  const box = opts.gutter?.find((f) => f.kind === 'checkbox')
  /**
   * 待办三态：`true` ⇒ 做完了、`false`／未填 ⇒ 是任务但没做完、没有这一槽 ⇒ 不是任务。
   *
   * ⚠️ **未填要算「未完成」，不能算「不是任务」**：这个槽的准入判据是「这块有这条属性」
   *    而不是「这条属性有值」（见 `gutterFieldsOf`）—— 刚给它加上、还没点过的那一下，
   *    正是这个入口存在的理由。若未填落进「不是任务」，块左边会画出一个空心方框
   *    （`box` 为真），却同时被当成普通块（没有 `data-todo`）⇒ 方框与状态各说一套。
   *
   * ⚠️ `data-todo` 是 **CSS 与冒烟的契约**（删除线按它选），所以这里不换成属性名。
   */
  const todo: 'todo' | 'done' | undefined = box ? (box.value === true ? 'done' : 'todo') : undefined
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
  if (folded) el.dataset.collapsed = '1'
  if (todo) el.dataset.todo = todo
  if (r.hasChildren) el.dataset.hasChildren = '1'
  // 角色进 DOM：页 / 日记作为**正文第一行**时靠它取样式。
  // 兼位块把**全部角色**写进同一个属性（空格分隔，选择器用 `~=`）——
  // 只写一个会等于按数组顺序裁决，而角色的顺序不承载语义。
  // ⚠️ 这只是**外观**差异，语义上它仍是一块（2026-10-20 去掉「标题」概念后的口径）
  const roles = identityTags(b)
  if (roles.length) el.dataset.role = roles.join(' ')
  el.style.setProperty('--depth', String(r.depth))

  /**
   * **别名头**：这一行显示的名字（主别名叶子），以及两个入口（别名与露面 / 字段声明）。
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
    name.className = 'blk-alias-name'
    name.dataset.aliasAction = 'config'
    // 显示叶子（`A/B` ⇒ `B`）；全名放进 title，路径语义不挤占行宽
    name.textContent = displayNameOf(b)
    name.title = t('ui.alias.fullName', { name: primaryAliasOf(b) })
    head.appendChild(name)

    const config = document.createElement('button')
    config.type = 'button'
    config.className = 'blk-alias-btn'
    config.dataset.aliasAction = 'config'
    config.title = t('ui.alias.configTitle')
    config.appendChild(createIcon('sliders-horizontal', 'sm'))
    head.appendChild(config)

    const fields = document.createElement('button')
    fields.type = 'button'
    fields.className = 'blk-alias-btn'
    fields.dataset.aliasAction = 'fields'
    fields.title = t('ui.alias.fields')
    fields.appendChild(createIcon('list-tree', 'sm'))
    head.appendChild(fields)
    el.appendChild(head)
  }

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
      const rail = document.createElement('span')
      rail.className = 'rail'
      rail.dataset.foldLineFor = ancestors[k]!
      rail.style.setProperty('--rail-depth', String(k))
      rail.title = t('ui.block.foldLine')
      rails.appendChild(rail)
    }
    el.appendChild(rails)
  }

  /**
   * **这一行自己的延续段**（`.rail-self`）：从自己的块标底下垂，贯穿这一行的剩余高度。
   *
   * 为什么需要它：上面那批段是「**为了祖先**而画」的——一条线活在**子行**上。
   * 于是父块**自己那一行**没有属于它的线：块标底下到行底之间是空的，
   * 而紧接着的第一条子行才开始画。父块只有一行时这段空隙不到 10px，看不出来；
   * 一旦正文换行成三行，那 100px 的正文左侧就**整片没有线**，看起来像线「断了」。
   *
   * ⇒ 父块的线要**两处拼起来**：自己这一行（本节点）＋ 所有子行（上面那批段）。
   *
   * ⚠️ **不带 `.rail` 这个 class**：`.rail` 的口径是「深度 d 的行有 d 个**祖先**段」，
   *    而这个节点是「这一行**自己**的」。挂同一个 class 会让那条「数段数」的契约
   *    多算一段（`check` 里有一条按 `.rail` 计数，一挂就红）——名字不同是因为语义不同。
   *
   * ⚠️ 只在**有子块且未折叠**时画：折叠后子行不挂载，留一段悬空的线没有去处；
   *    无子块的行本来就没有「往下延续」的东西。
   * ⚠️ 它是 `.rails` 的**兄弟**、不是它的子节点：`.rails` 的 `overflow:hidden` 与
   *    `pointer-events:none` 是为「祖先段」定的，这个段要贴着自己的块标、且有自己的命中区。
   * ⚠️ 纵向范围由 CSS 定（`top: 块标中心`、`bottom: 0`），不在这里算像素：
   *    `1lh` 与 `--ui-bullet-size` 是 token，DOM 层不该知道它们的数值。
   */
  if (r.hasChildren && !folded) {
    const self = document.createElement('span')
    self.className = 'rail-self'
    self.dataset.foldLineFor = b.id
    self.title = t('ui.block.foldLine')
    self.setAttribute('aria-hidden', 'true')
    self.contentEditable = 'false'
    el.appendChild(self)
  }

  const left = document.createElement('span')
  left.className = 'left'
  left.contentEditable = 'false'

  /**
   * 折叠箭头（D2）：**悬停才现**，且**绝对定位不占位**。
   * 静止态**完全看不到**，行悬停才淡入——常驻的折叠箭头会与块标抢空间，也让人分心。
   * 折叠态的可发现性由**块标自身的环**承担（D2 的明文口径），不靠常驻箭头。
   *
   * ⚠️ 无子块时**不生成这个节点**（R2）——空行的三角是纯噪声。
   */
  if (r.hasChildren) {
    const fold = document.createElement('span')
    fold.className = 'fold'
    fold.dataset.foldFor = b.id
    // 始终画 `chevron-down`：收起态由 CSS 旋转（`.blk[data-collapsed] .fold .ico`）
    fold.appendChild(createIcon('chevron-down', 'sm'))
    fold.title = folded ? t('ui.block.foldExpand') : t('ui.block.foldCollapse')
    left.appendChild(fold)
  }

  /**
   * **块标 ＝ 把手**（D4）。同一个元素挂两个契约 class：
   *   · `.marker` —— 新名字，样式与断言都认它；
   *   · `.bullet` ＋ `.handle` —— 旧契约选择器，主题/插件继续有效。
   * 于是块标槽从 40px（fold 12 + bullet 14 + handle 12 + gap）收到 **20px**，
   * 正文左缘的缩进问题一并解决。
   *
   * 行为：**左键 ＝ 聚焦/zoom**、右键 ＝ 块菜单、拖动 ＝ 移动。
   *
   * ⚠️ 这三条行为**不随身份变化**。让待办方框顶替块标，等于让「这块是任务」
   *    这一条属性吃掉「点它聚焦」这件事：同样是块标，点下去的结果却取决于块的属性，
   *    而这区别不写在任何地方。身份因此只作为**后缀**出现，见下面 `.identity`。
   */
  const marker = document.createElement('span')
  marker.className = 'marker bullet handle'
  marker.dataset.focusFor = b.id
  // 抓手图标：**悬停才现**（块标 hover 时把点换成 grip）
  const grip = document.createElement('span')
  grip.className = 'grip'
  grip.appendChild(createIcon('grip-vertical', 'sm'))
  marker.appendChild(grip)
  marker.title = t('ui.block.focusHint')
  marker.draggable = true
  marker.dataset.dragFor = b.id
  left.appendChild(marker)

  /**
   * **身份图标**：挂在块标**之后**的附加信息，不占用块标本身。
   *
   * 顺序是**先标签后待办**：标签说的是「这块是什么」，待办只是某个属性的取值；
   * 越本质、越少变的信息越靠左，读起来才稳。两者可以同时存在。
   *
   * ⚠️ 「方框」这个身份图标同时是待办的点击入口（`data-todo-for`）——
   *    它自己 `cursor:pointer`，与块标各占一块命中区，互不遮挡。
   */
  if (roles.includes('tag')) {
    const tagMark = document.createElement('span')
    tagMark.className = 'identity tag-mark'
    tagMark.appendChild(createIcon('hash', 'sm'))
    tagMark.title = t('ui.tag.mark')
    left.appendChild(tagMark)
  }
  if (box) {
    /**
     * 待办：`true` 画勾选、`false` 画空心 —— 差别只在图标与 `.blk` 上的 `data-todo`，
     * 身份元素本身不增删（「点一下填上」不该让 DOM 结构换掉）。
     * ⚠️ `.todo-box` 这个类名与 `data-todo` 都是样式/门禁的契约，留在原来的名字上，
     *    只是宿主从块标换成了这枚身份图标。
     */
    const todoMark = document.createElement('span')
    todoMark.className = 'identity todo-box todo-mark'
    todoMark.dataset.todoFor = b.id
    todoMark.dataset.propId = box.propId
    todoMark.appendChild(createIcon(todo === 'done' ? 'square-check' : 'square', 'sm'))
    todoMark.title = t('ui.todo.toggle')
    left.appendChild(todoMark)
  }
  const tx = document.createElement('span')
  tx.className = 'tx'
  if (todo === 'done') tx.classList.add('done')
  /**
   * **分割线**：线放在 `.tx` **里面**，不另换一个元素替代 `.tx`。
   * 编辑器里有一批路径按 `.tx` 认块（取文本、落光标、标 caret），换掉 `.tx`
   * 等于让这一行在那些路径里「不存在」——静默失效，不报错。
   */
  if (blockTypeOf(b) === DIVIDER_TYPE) {
    const rule = document.createElement('span')
    rule.className = 'divider-rule'
    rule.setAttribute('aria-hidden', 'true')
    tx.appendChild(rule)
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
   * ⚠️ 只对 **journal** 这样：`page` 行的正文就是页名，**必须可编辑**。
   */
  if (isReadonlyBlock(b)) {
    tx.contentEditable = 'false'
    tx.dataset.readonly = '1'
    /**
     * 占位文案只属于 **journal**：它的「正文」是 `_date` 的投影，投影要看得见。
     * 类型不可写的块没有可显示的内容（分割线的线本身就是全部），不挂占位——
     * 否则会在一条线旁边多出一行日期。
     */
    if (!isEmptyContent(b.content)) {
      // 兜底：万一旧数据里 journal 有正文（不该发生），仍要能看见它
      tx.dataset.ph = plainText(b.content)
      tx.dataset.phReadonly = '1'
    } else if (isJournal(b)) {
      tx.dataset.ph = journalDateLabel(journalDate(b))
      tx.dataset.phReadonly = '1'
    }
  } else if (isEmptyContent(b.content)) {
    // 空块的幽灵占位：CSS 生成内容，**不进 DOM 文本**
    tx.dataset.ph = opts.single ? t('ui.block.placeholderFirst') : t('ui.block.placeholderEmpty')
  }

  el.append(left, tx)

  /**
   * **标签槽**：挂在正文槽**之后**（行右端），是 `.blk` 的直接子节点。
   *
   * ⚠️ 必须在 `.tx` 之外 —— 见 `makeTagsEl` 的说明：chip 在正文槽里，
   *    插入点就能落到它后面，那是「标签跳到文本后面」的全部来源。
   * ⚠️ 无标签不生成节点（`makeTagsEl` 返回 null ⇒ 不留空槽）。
   * ⚠️ `ALLOWED_ROW_CHILDREN` 已登记 `blk-tags`：漏了它，第一次收光标
   *    （`reclaimCaret`）就会把这枚槽当游离节点删掉。
   */
  const tags = makeTagsEl(b, opts.find)
  if (tags) el.appendChild(tags)
  return el
}
