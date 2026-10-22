/**
 * 把**模型**画成 DOM：一个块的内容 = 文本 ＋ 区间锚点 ＋ 行内原子。
 *
 * 这是从 `view.ts` 抽出来的纯渲染层。为什么它值得单独存在：
 *   · 它**不持有状态**（只吃 `Block` + `marks` + `atoms`，吐 `HTMLElement`），
 *     所以能脱离编辑器单独成型——将来「同一个块在槽里、在正文里、在引用预览里」
 * 用的是同一个函数（29 一源多视的前提）；
 *   · 它是**编辑器 DOM 契约的产地**（`.blk`／`.tx`／`.atom`／`data-depth`，承 66），
 *     契约集中在一处才守得住。
 *
 * ⚠️ 三条实测得来的纪律（不许破坏）：
 *   1. 缩进**不用 DOM 层级**，用扁平 ＋ `data-depth` ＋ padding（DOM 层级与虚拟化互斥）；
 *   2. 行内原子 = `contenteditable=false` 的 inline 元素，**在模型里占 1 格占位符**；
 *   3. gutter（块标/箭头/导轨）**不混进 `.tx`**：读回模型时会把它当成字。
 */
import {
  ATOM_PLACEHOLDER,
  identityTags,
  isJournal,
  journalDate,
  journalDateLabel,
  mkAtom,
  type Atom,
  type Block,
  type FindBlock,
  type Mark,
  type MarkType,
  type RefView,
  type VisibleRow,
} from '../core/index.ts'
import { t } from '../core/msg.ts'
import { danglingView, resolveRefs } from '../core/ref.ts'
import { createIcon } from './icons.ts'

/** 行高：与 CSS 的 `--ui-line-h` 必须一致（虚拟化算占位高度要用） */
export const LINE_H = 30

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

/** 区间锚点 → 语义标签：粗体用 `strong` 之类，让复制出去也是对的 */
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
 * 行内原子 → inline 元素（**占 1 格**，不可编辑，可点开）。
 *
 * `view` 是**解析结果**（`core/ref.ts`），不是 `atom.label`：
 * 目标改名后 `label` 是过期的字，显示的必须是 `view.label`。
 * ⚠️ 图片原子不走解析（它的显示名是资产名，不指向块）⇒ `view` 可选。
 */
export function makeAtomEl(a: Atom, view?: RefView): HTMLElement {
  const label = view?.label ?? a.label
  const el = document.createElement('span')
  el.className = `atom atom-${a.kind}`
  if (view?.state === 'dangling') el.classList.add('dangling')
  if (a.asset?.state === 'missing') el.classList.add('missing')
  el.contentEditable = 'false'
  el.dataset.atomId = a.id
  // ⚠️ 解析后的显示名**另存一份到 `data-ref-label`**：`.atom-label` 里带 `[[ ]]` / `#` 装饰，
  //    而落盘值 `atom.label` 是过期的快照 —— 给探针一个「此刻真的在显示什么」的读点。
  if (a.kind === 'page' || a.kind === 'tag') el.dataset.refLabel = label
  el.title =
    a.kind === 'page'
      ? t(view?.state === 'dangling' ? 'ui.atom.pageDanglingTitle' : 'ui.atom.pageTitle', { label })
      : a.kind === 'tag'
        ? t(view?.state === 'dangling' ? 'ui.atom.tagDanglingTitle' : 'ui.atom.tagTitle', { label })
        : t('ui.atom.imageTitle', { label })
  if (a.kind === 'image') {
    const img = document.createElement('img')
    img.className = 'asset-thumb'
    img.alt = ''
    img.src = thumbUri(a.asset?.hash ?? a.id)
    const name = document.createElement('span')
    name.className = 'asset-name'
    name.textContent = label
    el.append(img, name)
  } else {
    /**
     * 引用与标签**只有装饰不同**（`[[名]]` vs `#名`）—— 两者是同一种指向边。
     * ⚠️ `#` 与 `[[ ]]` 都不进正文：正文里那一格只有 U+FFFC，
     *    否则「标签块的正文本身」与「它在引用处显示的字」会变成两个要同步的东西。
     */
    const ico = document.createElement('span')
    ico.className = 'atom-ico'
    ico.appendChild(createIcon(a.kind === 'tag' ? 'hash' : 'arrow-up-right', 'sm'))
    const text = document.createElement('span')
    text.className = 'atom-label'
    text.textContent = a.kind === 'tag' ? `#${label}` : `[[${label}]]`
    el.append(ico, text)
  }
  return el
}

/**
 * **这一行是不是只读的**：journal 的行是 `_date` 的只读投影，
 * 不是块的正文 ⇒ 不给编辑、不给落光标。
 *
 * ⚠️ 这条判据有**三个**消费者，必须只有一处定义：
 *   ① `makeBlockEl`（`contenteditable=false` ＋ `data-readonly`）；
 *   ② `view/editor-events` 的 mousedown（点它不落光标）；
 *   ③ `view/editor.selectAll` 与装配层的 `firstEditableRoot`（起选/落点要跳过它）。
 *   分开写会立刻分叉（2026-10-20 实际踩过：只读行让 ⌘A 的原生全选退化成空选区）。
 */
export function isReadonlyBlock(b: Block): boolean {
  return isJournal(b)
}

/**
 * 把一个块的文本装进 `.tx`：按「锚点端点 ∪ 原子端点 ∪ 占位符位置」切段，
 * 每段套上覆盖它的区间标签。
 *
 * ⚠️ 空块必须留一个可落光标的锚点（`<br>`）：Chrome 里空的 inline span 不接受插入，
 *   会把输入落到上一个文本节点（实测：Enter 拆出空块后紧接着打字会跑进前一块）。
 *   与 ProseMirror 的 trailing `<br>` 同一招——只在空块出现，一有文本就被重渲染掉。
 */
export function fillBlockText(
  tx: HTMLElement,
  b: Block,
  marks: Mark[],
  atoms: Atom[],
  /**
   * **引用解析**（可选）：传了 ⇒ 行内引用显示**目标当前的名字**。
   * 不传 ⇒ 退回 `atom.label` 快照（那是过期的字，只在拿不到森林的场合容忍）。
   */
  find?: FindBlock,
): void {
  tx.textContent = ''
  const text = b.text
  const myMarks = marks.filter((m) => m.blockId === b.id)
  const myAtoms = atoms.filter((a) => a.blockId === b.id)
  const views = find ? resolveRefs(find, myAtoms) : undefined

  const cuts = new Set<number>([0, text.length])
  const clamp = (n: number): number => Math.max(0, Math.min(n, text.length))
  for (const m of myMarks) {
    cuts.add(clamp(m.start))
    cuts.add(clamp(m.end))
  }
  for (const a of myAtoms) {
    cuts.add(clamp(a.start))
    cuts.add(clamp(a.end))
  }
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ATOM_PLACEHOLDER) {
      cuts.add(i)
      cuts.add(i + 1)
    }
  }

  const pts = [...cuts].filter((p) => p >= 0 && p <= text.length).sort((a, z) => a - z)
  for (let k = 0; k < pts.length - 1; k++) {
    const s = pts[k]!
    const e = pts[k + 1]!
    if (s === e) continue
    const seg = text.slice(s, e)

    // 占位符 ⇒ 原子元素（找不到对应原子就画成 dangling，**不静默吞掉**，承 64 ）
    if (seg === ATOM_PLACEHOLDER) {
      const a = myAtoms.find((x) => x.start === s)
      if (a) tx.appendChild(makeAtomEl(a, views?.get(a.id)))
      else tx.appendChild(makeAtomEl(mkAtom('page', b.id, s, t('ui.atom.unknown')), danglingView(t('ui.atom.unknown'))))
      continue
    }

    /**
     * ⚠️ 这里**不再认 `#标签`**：那曾是「第二套正则解析」（71.4 承认的债）——
     *    `insert-tag` 写文本、`hasTag` 正则扫文本、渲染再正则包一层 span，三处各认一次，
     *    于是「看起来是标签」与「真的是一条边」是两件事。
     *    现在标签＝一条指向边（`tag` 原子），由上面的占位符分支统一渲染。
     *    ⇒ 正文里的 `#设计` 现在就是普通文本（原型阶段，存量 seed 不再假装是标签）。
     */
    const covering = myMarks.filter((m) => m.start <= s && m.end >= e)
    let node: Node = document.createTextNode(seg)
    for (const m of covering) {
      const wrap = document.createElement(tagForMark(m.type))
      wrap.className = `mk mk-${m.type}`
      wrap.appendChild(node)
      node = wrap
    }
    tx.appendChild(node)
  }

  if (tx.childNodes.length === 0) tx.appendChild(document.createElement('br'))
}

/**
 * 一个可见行 → `.blk` 元素。
 *
 * **DOM 契约就在这里**（承 66）：`data-block-id`／`data-depth`／`data-has-children`／
 * `data-collapsed`／`data-todo`／`--depth`，以及 `.left` 里的 `.marker`／`.fold`／`.todo-box`。
 * 主题与插件都按这些选择器选，**改名等于破坏契约**。
 *
 * gutter 的形状：
 *   · **一个主件**：`.marker` 同时是**块标与拖拽把手**（D4）。旧契约
 *     `class="bullet handle"` 两个选择器**都保留在同一个元素上**，主题与插件不会失效；
 *   · **两个临时件**：`.fold`（悬停才现）与 `.marker` 上的 grip（悬停才现）；
 *   · `.fold` **无子块不生成**（不是 `visibility:hidden`，DOM 里就没有这个节点）；
 *   · 折叠态**不靠箭头表达**：块标自己变成环（D2），箭头只表示方向。
 *
 * ⚠️ gutter（块标 / 折叠箭头 / 导轨）放在 `.blk` 里，**不占行内文本**：
 * 一旦混进 `.tx`，读回模型时会被当成字的「锚点粘性」）。
 */
export function makeBlockEl(
  r: VisibleRow,
  fill: (tx: HTMLElement) => void,
  opts: { single: boolean; ancestors?: readonly string[] },
): HTMLElement {
  const b = r.block
  const el = document.createElement('div')
  el.className = 'blk'
  el.dataset.blockId = b.id
  el.dataset.depth = String(r.depth)
  if (b.collapsed) el.dataset.collapsed = '1'
  if (b.todo) el.dataset.todo = b.todo
  if (r.hasChildren) el.dataset.hasChildren = '1'
  // 角色进 DOM：页 / 日记作为**正文第一行**时靠它取样式。
  // 兼位块把**全部角色**写进同一个属性（空格分隔，选择器用 `~=`）——
  // 只写一个会等于按数组顺序裁决，而角色的顺序不承载语义。
  // ⚠️ 这只是**外观**差异，语义上它仍是一块（2026-10-20 去掉「标题」概念后的口径）
  const roles = identityTags(b)
  if (roles.length) el.dataset.role = roles.join(' ')
  el.style.setProperty('--depth', String(r.depth))

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
    fold.title = b.collapsed ? t('ui.block.foldExpand') : t('ui.block.foldCollapse')
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
   */
  const marker = document.createElement('span')
  if (b.todo) {
    // 待办行的主件是方框：它**也是**把手（同一元素两个契约 class）
    marker.className = 'marker todo-box handle'
    marker.dataset.todoFor = b.id
    marker.appendChild(createIcon(b.todo === 'done' ? 'square-check' : 'square', 'sm'))
    marker.title = t('ui.todo.toggle')
  } else {
    marker.className = 'marker bullet handle'
    marker.dataset.focusFor = b.id
    // 抓手图标：**悬停才现**（块标 hover 时把点换成 grip）
    const grip = document.createElement('span')
    grip.className = 'grip'
    grip.appendChild(createIcon('grip-vertical', 'sm'))
    marker.appendChild(grip)
    marker.title = t('ui.block.focusHint')
  }
  marker.draggable = true
  marker.dataset.dragFor = b.id
  left.appendChild(marker)
  const tx = document.createElement('span')
  tx.className = 'tx'
  if (b.todo === 'done') tx.classList.add('done')
  fill(tx)
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
    if (b.text === '') {
      tx.dataset.ph = journalDateLabel(journalDate(b))
      tx.dataset.phReadonly = '1'
    } else {
      // 兜底：万一旧数据里 journal 有正文（不该发生），仍要能看见它
      tx.dataset.ph = b.text
      tx.dataset.phReadonly = '1'
    }
  } else if (b.text === '') {
    // 空块的幽灵占位：CSS 生成内容，**不进 DOM 文本**
    tx.dataset.ph = opts.single ? t('ui.block.placeholderFirst') : t('ui.block.placeholderEmpty')
  }

  el.append(left, tx)
  return el
}
