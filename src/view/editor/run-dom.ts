/**
 * 行内原子的 DOM 构建器：run 原子、标签 chip、引用数徽标——一族**零状态**的纯构建器
 * （吃 run ＋ 解析结果，吐元素），`block-dom.ts` 从这里再导出，对外的符号名不变。
 *
 * 为什么单独一个文件：`block-dom.ts` 守的是**行**的契约（`.blk`／`.tx`／`data-depth`），
 * 这一族守的是**格内**的原子形状（`.atom`／`data-atom-id`／`data-ref-to`／`tag-chip`）。
 * 两份契约各自集中一处才守得住；值控件的表格/卡片/选择器也直接吃这一族
 * （`view-table`／`view-cards`／`mark-picker`），不必先造一行。
 */
import { identityColorCss, type RefView } from '../../core/index.ts'
import { isHexColor, type AssetRun, type MarkKind, type RunWithId } from '../../core/model/runs.ts'
import type { AssetView } from '../../core/infra/assets.ts'
import { t } from '../../core/infra/msg.ts'
import { createIcon, renderIcon } from '../icons.ts'
import type { RefSummary } from '../../core/views/ref-sources.ts'
/**
 * 格式键 → 语义标签：core 五种用语义标签（复制出去也是对的），带值两种用 `span`。
 * 描述表替代 switch：加一种格式＝加一行，不是加一支分支。
 */
const MARK_TAG: Record<MarkKind, string> = {
  bold: 'strong',
  italic: 'em',
  underline: 'u',
  strike: 's',
  code: 'code',
  ink: 'span',
  bg: 'span',
}

export function tagForMark(k: MarkKind): string {
  return MARK_TAG[k]
}

/**
 * 值轴值的**样式落点**（渲染与查询预览共用这一份）：槽名由 CSS 按 `data-slot` 给（token 链）；
 * hex（自由色）没有槽规则，走身份色同一套程序化机制——solid（暗色提亮）／soft（15% 洗底，
 * 与槽位底同构：正文背景色不是色块，是高亮）。显式动作的可读性代价由用户担。
 */
export function applyMarkColor(el: HTMLElement, kind: MarkKind, v: string): void {
  if (!isHexColor(v)) return
  el.style[kind === 'ink' ? 'color' : 'background'] = identityColorCss(v, kind === 'ink' ? 'solid' : 'soft')
}

/**
 * 行内原子 run → inline 元素（**占 1 格**，不可编辑，可点开）。
 *
 * `view` 是**解析结果**（`core/ref.ts`），不是 run 上的名字快照：
 * 目标改名后快照是过期的字，显示的必须是 `view.label`。
 * `asset` 是资产**此刻**的样子（`view/asset-views.ts` 现算，不落盘）：
 * 图片不指向块，所以它没有 `RefView`，只有「字节在不在、URL 有没有」。
 */
export function makeRunEl(r: RunWithId, view?: RefView, asset?: AssetView, onAssetError?: (hash: string) => void): HTMLElement {
  const label =
    r.t === 'link'
      ? r.v
      : (view?.label ?? (r.t === 'ref' ? r.label : undefined) ?? (r.t === 'asset' ? (r.label ?? '') : ''))
  /**
   * 三种「标签样」的露面必须能一眼分清：
   *   · `tag`  —— 行内标签（指向标签类，`#名`，无底色）；
   *   · `obj`  —— 实例（指向一条记录，空心胶囊）；
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
  const assetState = r.t === 'asset' ? (asset?.state ?? 'unavailable') : undefined
  /**
   * 资产的**呈现类**（`.atom-image` / `.atom-file`）与种类类（`.atom-asset`）分开：
   * 种类回答「这是什么 run」（读数、点击分流按它），呈现回答「现在画成图还是文件 chip」
   * （样式与探针按它）。两者会随字节到没到而变化，所以不能合成一个类名。
   */
  const assetPresentsAsImage =
    r.t === 'asset' && assetState === 'ready' && (asset?.mime ?? '').startsWith('image/')
  if (r.t === 'asset') el.classList.add(assetPresentsAsImage ? 'atom-image' : 'atom-file')
  if (assetState && assetState !== 'ready') el.classList.add(assetState === 'missing' ? 'missing' : 'unavailable')
  el.contentEditable = 'false'
  /**
   * **原子必须自己声明「不可拖」**：contenteditable 里拖一枚原子会把它的 DOM 搬到
   * 别的位置（甚至别的块），而模型里那一格没动 —— 重渲染后图会「消失」或「跑到别处」。
   * 拖拽重排是块级的（`.blk` 的把手），原子不参与。
   */
  el.draggable = false
  el.dataset.atomId = r.id
  /**
   * **种类进 DOM**（读数契约的一部分，不只是样式）：DOM 里有这一格、模型里却找不到
   * 对应 run 时，`readRuns` 要按它还原出同种的原子。缺了这一格，一张图会被兜底成
   * 「指向不存在页面的引用」—— 静默变成另一种东西。
   */
  el.dataset.atomKind = kind
  if (r.t === 'asset') el.dataset.assetHash = r.asset
  /**
   * **导航契约**（与读数契约分开）：`data-ref-to` ＝「这枚元素指向哪一块」。
   *
   * 它和 `data-atom-id` 是两个不同的事实，所以不能共用一个属性：
   *   · `data-atom-id` 是**这枚 run 的身份**（读数要按它把 run 原样带回，删引用也按它）；
   *   · `data-ref-to` 是**它的目标**（点了该去哪）。
   * 只有引用有目标：图片／外链是行内原子但不是块引用，没有这一格。
   *
   * ⚠️ 为什么值得单开一格而不是让事件层去认 `.atom`：块级标签 chip 与属性区的标签
   *    也是「指向某块的露面」，但它们没有 run、也不住在编辑器里。共用同一个属性之后，
   *    「点了一个指向 X 的露面」在每一处都是同一句话，不用为每种形状再写一条分支。
   */
  if (r.t === 'ref' && r.to) el.dataset.refTo = r.to
  /**
   * **替身染目标的身份色**（solid，字）：chip 染目标色是同一信号在块级替身上的发言，
   * 行内替身同一资格——色跟着块走，不跟着露面位置走。染字不染底／边框：三种行内
   * 露面靠形状分清（无框／空心／`[[ ]]`），色是叠加维度不抢形状。
   * **用户对这一格的显式 ink 让位**（显式 > 派生）：run 带 ink mark 时不染，
   * 字色归 marks 的包装层。dangling 目标没有色，自然回落中性。
   */
  if (r.t === 'ref' && view?.state === 'resolved' && view.color && !r.marks?.ink) {
    el.style.color = identityColorCss(view.color)
  }
  // ⚠️ 解析后的显示名**另存一份到 `data-ref-label`**：`.atom-label` 里带 `[[ ]]`／`#` 装饰，
  //    而 run 上的名字快照是过期的 —— 给探针一个「此刻真的在显示什么」的读点。
  if (r.t === 'ref' || r.t === 'link' || r.t === 'asset') el.dataset.refLabel = label
  el.dataset.tip =
    r.t === 'asset'
      ? t(
          assetState === 'missing'
            ? 'ui.atom.assetMissingTitle'
            : assetState === 'unavailable'
              ? 'ui.atom.assetUnavailableTitle'
              : 'ui.atom.imageTitle',
          { label },
        )
      : kind === 'obj'
        ? t(view?.state === 'dangling' ? 'ui.atom.objDanglingTitle' : 'ui.atom.objTitle', { label })
        : kind === 'tag'
          ? t(view?.state === 'dangling' ? 'ui.atom.tagDanglingTitle' : 'ui.atom.tagTitle', { label })
          : t(view?.state === 'dangling' ? 'ui.atom.pageDanglingTitle' : 'ui.atom.pageTitle', { label })
  if (kind === 'tag' || kind === 'obj') {
    /**
     * 实例与标签类都用 `#名字` 停在正文里；区分靠**外观**（实例是一枚空心胶囊，标签类是纯文字），
     * 不靠改显示文字 —— 文字是用户的正文，不能为了区分身份改它。
     * ⚠️ 不要给实例加前置小方块：那是待办勾选框的形状，用户会以为点它能打勾。
     *
     * ⚠️ 它占正文 1 格（`data-atom-id`），但**不是** chip（不设 `data-tag-id`）：
     *    chip 的读数规则是「跳过、长度为 0」，而这一枚必须被读成 1 格，
     *    否则正文、光标会整体错位。
     */
    const text = document.createElement('span')
    text.className = 'atom-label'
    text.textContent = `#${label}`
    /**
     * **实例的两个专属入口**（都只占那个已有的图标槽，不另加宽度）：
     *   · 有 closure 字段 ⇒ 状态标记：图标＝当前选项，点击翻转/⌥ 选状态；
     *   · 有普通字段 ⇒ 脸槽 hover 换手：静止是目标的脸，指上去变 chevron，点击开字段卡。
     * 两者互斥（一个胶囊只留一个控件）；没有字段 ⇒ 只剩脸，不假装有 body。
     * 标签类（`tag`）不加：它没有被归类到宿主，没有「这一格的值」可编辑。
     */
    if (kind === 'obj' && r.t === 'ref' && r.to && view?.state === 'resolved' && view.closure) {
      el.append(makeClosureMarker(r.to, view.closure), text)
    } else if (kind === 'obj' && view?.state === 'resolved' && view.fields && view.icon) {
      el.append(makeFieldsHandle(r.id, view.icon), text)
    } else {
      el.append(...prependIcon(view), text)
    }
  } else if (r.t === 'asset') {
    el.append(...assetAtomContent(r, asset, label, onAssetError))
  } else if (r.t === 'link') {
    /**
     * 外链：`v` 是**显示文本**（内容），`url` 是目标——两键分家，改名字不动地址。
     * 仍按**不可分原子**渲染（占 1 格）：链接是一枚行内原子，不是一串字。
     *
     * ⚠️ 但 `v` **不进 `plainText` 投影**（原子都不是文本流的一部分，见 `core/runs.ts`）：
     *    搜索／引文／导出里看不见这枚链接的显示文本。把它显示出来是**呈现**，
     *    不是「这几个字在正文里能被搜到」——两件事，别混。
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
    const text = document.createElement('span')
    text.className = 'atom-label'
    text.textContent = `[[${label}]]`
    el.append(...prependIcon(view), text)
  }
  return el
}

/**
 * 目标块标的**前置图标**（脸的形半，与替身染色的色半同一资格）：
 * 解析不到（dangling）或目标无脸 ⇒ 不占位——图标是加分项，不是必需件。
 * 三种行内引用共用一份：`#名`／实例／`[[ ]]` 哪里都一样，不按形状再分叉。
 * ⚠️ 必须走 `renderIcon`（前缀分发：`lucide:` ⇒ SVG，**字面值（emoji 等）⇒ 字就是脸**，
 * 未知名 ⇒ help 占位）。直接调 `createIcon` 会把字面值喂进 path 表查不到，
 * 造出一枚塞着 "undefined" 的隐形 SVG——不显示但占位，把整个名字顶歪（真机实测）。
 */
function prependIcon(view: RefView | undefined): Node[] {
  if (view?.state !== 'resolved' || !view.icon) return []
  const ico = document.createElement('span')
  ico.className = 'atom-ico'
  renderIcon(ico, view.icon, 'circle-help', 'sm')
  return [ico]
}

/**
 * **实例的状态标记**：复用块标后状态标记的命中契约（`data-closure-for` /
 * `data-prop-for` / `data-prop-id`），只是住在行内原子自己的图标槽里。
 *
 * 为什么用图标槽而不是另加一格：行内原子占正文 1 格，多一枚图标就是多一份宽度；
 * 这块地方本来就要画目标的脸。状态比脸更该占这一格——它是会变的那半。
 * ⚠️ 不能把 `data-closure-for` 挂到整个原子上：那样点名字也会翻转，导航语义被
 *    状态控制吃掉。只挂在这枚 span 上，label 仍是导航。
 */
function makeClosureMarker(targetId: string, closure: NonNullable<RefView['closure']>): HTMLElement {
  const el = document.createElement('span')
  el.className = 'atom-ico atom-closure'
  el.contentEditable = 'false'
  el.draggable = false
  el.dataset.closureFor = targetId
  el.dataset.propFor = targetId
  el.dataset.propId = closure.propId
  el.dataset.closureState = closure.state
  el.dataset.tip = t('ui.closure.toggle')
  // 当前选项的图标就是「此刻是什么状态」；没有值时退回定义图标（与 gutter 同一档）
  renderIcon(
    el,
    closure.icon ?? (closure.state === 'closed' ? 'lucide:circle-check' : 'lucide:circle'),
    closure.state === 'closed' ? 'circle-check' : 'circle',
    'sm',
  )
  // 按下不挪光标；动作交给容器的 mousedown/click 分支（gutter 同一条路径）
  el.addEventListener('mousedown', (e) => e.preventDefault())
  return el
}

/**
 * **实例的字段手柄**：同一个图标槽，静止显示目标的脸，hover/focus 换成 chevron。
 *
 * 为什么不是「脸 + 三角」两枚图标：一行里每多一枚实例就多 10px，正文会被读成
 * 一串工具条；这个槽本来就有，换手不增加宽度，也不改变行的排版。
 * 点击开的是实例的字段卡，不是新面板；label 仍是打开目标。
 */
function makeFieldsHandle(runId: string, icon: string): HTMLElement {
  const el = document.createElement('span')
  el.className = 'atom-ico atom-handle'
  el.contentEditable = 'false'
  el.draggable = false
  el.dataset.refFields = runId
  el.dataset.tip = t('ui.atom.fieldsTitle')
  const face = document.createElement('span')
  face.className = 'atom-handle-face'
  renderIcon(face, icon, 'circle-help', 'sm')
  const caret = document.createElement('span')
  caret.className = 'atom-handle-caret'
  renderIcon(caret, 'lucide:chevron-right', 'chevron-right', 'sm')
  el.append(face, caret)
  el.addEventListener('mousedown', (e) => e.preventDefault())
  return el
}

/**
 * 资产原子的内容：真图 / 文件 chip / 两种失败占位。
 *
 * 为什么是三种形状而不是一种加滤镜：`missing`（库里没有这份字节）与
 * `unavailable`（库本身打不开）给用户的动作不同 —— 前者去找文件，后者去修存储。
 * 同一个「灰掉」表达不出这个区别。
 */
function assetAtomContent(
  r: AssetRun,
  asset: AssetView | undefined,
  label: string,
  onAssetError?: (hash: string) => void,
): Node[] {
  const state = asset?.state ?? 'unavailable'
  if (state === 'ready' && asset?.url && (asset.mime ?? '').startsWith('image/')) {
    const img = document.createElement('img')
    img.className = 'asset-thumb'
    img.src = asset.url
    // 名字快照当 alt：图裂开/读屏时用户还能知道这是哪一张
    img.alt = label
    /**
     * **字节到底在不在，由浏览器告诉我们** —— 索引里有这一行，不代表文件还在
     * （人手删了、同步删掉了）。`<img>` 报错一次就把这份 hash 上锁成 `missing`，
     * 之后按缺失态画，不再反复重试。
     */
    if (onAssetError) img.addEventListener('error', () => onAssetError(r.asset), { once: true })
    /**
     * ⚠️ `draggable=false` 是**防原生注入**的一半（另一半是 `paste`/`drop` 的拦截）：
     *    浏览器把 `<img>` 拖进 contenteditable 会塞一个没有 `data-atom-id` 的裸 `<img>`，
     *    `readRuns` 读不到它，重渲染就消失。
     */
    img.draggable = false
    /**
     * **宽高比先占住**：尺寸来自索引（字节自身的像素尺寸），不是 run 上的第二份拷贝。
     * 有了它，图还没解码完时行高不会先塌下去再弹回来。
     */
    if (asset.w && asset.h) {
      img.width = asset.w
      img.height = asset.h
    }
    return [img]
  }
  const box = document.createElement('span')
  box.className = `asset-chip asset-${state}`
  const ico = document.createElement('span')
  ico.className = 'asset-chip-ico'
  ico.appendChild(createIcon(state === 'ready' ? 'file' : 'image-off', 'sm'))
  const text = document.createElement('span')
  text.className = 'asset-chip-label'
  text.textContent =
    state === 'ready'
      ? label
      : state === 'missing'
        ? t('ui.atom.assetMissingLabel', { label })
        : t('ui.atom.assetUnavailableLabel', { label })
  box.append(ico, text)
  return [box]
}

/**
 * 标签 chip：**标签的归属在块上，这枚 chip 只是把它显示出来**。
 *
 * 形状（`tag-chip` ＋ `data-tag-id` ＋ `data-ref-to`）是渲染契约：主题按它上色，探针按它找标签。
 *
 * ⚠️ 它住在 `.blk` 的**标签槽**（`.blk-tags`）里、**`.tx` 之外**：标签没有位点，
 *    而正文槽里每个 DOM 位置都是潜在的插入点 —— chip 一旦在 `.tx` 里，
 *    光标就能落到它后面，打出来的字在 DOM 里排在 chip 后、模型里却是正文末尾，
 *    重画一次就表现为「标签跳到文本后面」。挪出正文槽后，插入点**物理上**进不去。
 *    读数路径（`view/dom-text.ts`）遇 `data-tag-id` 跳过 —— 这层防御保留。
 *
 * ⚠️ `data-tag-id`（读数：占 0 格）与 `data-ref-to`（导航：指向标签块）**两格都要有**：
 *    它们是两个事实（「这枚不占正文」与「它指向谁」），合成一格就会让读数或点击其一失效。
 */
export function makeTagChipEl(tagId: string, name: string, color?: string): HTMLElement {
  const el = document.createElement('span')
  el.className = 'tag-chip'
  el.dataset.tagId = tagId
  el.dataset.refTo = tagId
  el.contentEditable = 'false'
  // chip 只显 `#名`，不画标签的脸：chip 是**归属的标记**，不是块的卡片——
  // 这个尺寸只放得下两个信号（这是什么类＝`#` 形状、哪一个＝名）。脸的舞台
  // 是它能区分对象的地方（块标借形、选择器、标签页）；同一视野里 chip 重复的
  // 是同一张脸（同一标签出现 N 次），重复而不区分＝噪音，且成员行的块标已经
  // 借了这张脸，再上 chip 是同屏两处重复计数
  el.appendChild(document.createTextNode(`#${name}`))
  // **chip 染各染各的标签色**（soft 底＋solid 字）：标签显式配了 `_color` 才染；
  // 未配色的维持 accent 现状——色是叠加的身份通道，永远不是唯一载体
  if (color !== undefined && color !== '') {
    el.style.setProperty('--chip-c', identityColorCss(color))
    el.style.setProperty('--chip-bg', identityColorCss(color, 'soft'))
  }
  el.dataset.tip = t('ui.chip.tagTitle', { label: name })
  return el
}

/**
 * **引用数徽标**：与标签 chip 同一条行尾槽，是「这一块被引用了」的唯一常显入口。
 *
 * 数字取 `RefSummary.total`（引用次数，不是来源块数），0 次不生成节点 —— 同 `.fold`
 * 的口径，不是 hidden：绝大多数块没有引用，留空槽是纯噪声。
 *
 * ⚠️ 只带 `data-ref-count-for`：
 *   · 不带 `data-ref-to` —— 那是「点了一个指向 X 的露面」的判据，带上会被事件层
 *     抢先接走、直接导航到目标块，而这枚 chip 要做的是就地展开列表；
 *   · 不带 `data-tag-id` —— 那会让右键命中标签 chip 的菜单分支。
 * ⚠️ 住在 `.blk-tags` 里：`ALLOWED_ROW_CHILDREN` 与冒烟 T99 的镜像数组都不用动，
 *    插入点也物理上进不去（正文读数只走 `.tx`）。
 */
export const REF_BADGE_ATTR = 'refCountFor'

export function makeRefBadgeEl(hostId: string, summary: RefSummary): HTMLElement | null {
  if (summary.total === 0) return null
  const el = document.createElement('span')
  el.className = 'tag-chip ref-badge'
  el.dataset[REF_BADGE_ATTR] = hostId
  el.contentEditable = 'false'

  const ico = document.createElement('span')
  ico.className = 'ref-badge-ico'
  renderIcon(ico, 'lucide:corner-up-left', 'corner-up-left', 'sm')
  el.append(ico, document.createTextNode(String(summary.total)))

  // 说明走 aria-label 而不是 data-tip：hover 已经会弹浮层了，再叠一条 tip 是两层说明。
  // 那句话搬到浮层脚注里给眼睛看（ui.refs.peekFoot），这里只留读屏用的一份。
  el.setAttribute('aria-label', t('ui.refs.badgeTip', { count: summary.total }))
  return el
}

/** 锚点元素被重画摘掉后，按宿主 id 找回**当前那一枚**徽标 */
export function liveRefBadgeOf(el: HTMLElement, hostId: string): HTMLElement | null {
  if (el.isConnected) return el
  for (const node of document.querySelectorAll<HTMLElement>('[data-ref-count-for]')) {
    if (node.dataset[REF_BADGE_ATTR] === hostId) return node
  }
  return null
}
