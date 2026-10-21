/**
 * 假数据 —— 一份**像真实笔记的库**：中文为主、中英混排、嵌套 3–4 层，含标签 / 引用 chip /
 * 图片占位 / 一段长文 / 一个悬空引用的 `dangling`）/ 一个缺失资产。
 *
 * 另附三个演示状态：**空态** / **稀疏态**（只有 1 个块）/ **降级态**（超长块・全英文・超长标题・无标题）。
 *
 * 写法上刻意用一个「迷你 DSL」：正文里直接写 `**粗**` / `==高亮==` / `` `代码` `` / `[[页面]]` /
 * `![[图.png]]`，由 `parseInline` 解析成**区间锚点与行内原子**——这正是 demo 要展示的模型形状
 * （锚点带 blockId、原子占 1 格），而不是把富文本塞进 DOM。
 */
import { ATOM_PLACEHOLDER, findByAlias, journalId, mkBlock, shiftISO, todayISO, uuidv7Hex, type Atom, type Block, type BlockProps, type Mark, type MarkType, type Role } from './index.ts'
import { DEFAULT_PREFS, WORKSPACE_VERSION, type PageBlock, type Workspace } from './workspace.ts'

/* ------------------------------------------------------------- 迷你 DSL */

interface SeedBlock {
  text: string
  todo?: 'todo' | 'done'
  collapsed?: boolean
  /** 角色：demo 里只用于造一个 `query` 块，其余块不带角色 */
  roles?: Role[]
  /** 系统属性：查询块的 `_query` 条件就落在这里 */
  props?: BlockProps
  children?: SeedBlock[]
}

interface RawAtom {
  kind: 'page' | 'image'
  start: number
  label: string
  missing?: boolean
  dangling?: boolean
}

type InlineMark = { type: MarkType; start: number; end: number }

/** ① 先把 `[[..]]` / `![[..]]` 换成占位符（**恒占 1 格**），② 再解析成对格式标记 */
export function parseInline(src: string): { text: string; marks: InlineMark[]; atoms: RawAtom[] } {
  let text = ''
  const atoms: RawAtom[] = []
  let i = 0
  while (i < src.length) {
    const rest = src.slice(i)
    const img = /^!\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/.exec(rest)
    if (img) {
      text += ATOM_PLACEHOLDER
      atoms.push({
        kind: 'image',
        start: text.length - 1,
        label: img[1]!.trim(),
        missing: /\.missing$|丢失/.test(img[1]!.trim()),
      })
      i += img[0].length
      continue
    }
    const page = /^\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/.exec(rest)
    if (page) {
      text += ATOM_PLACEHOLDER
      atoms.push({ kind: 'page', start: text.length - 1, label: page[1]!.trim() })
      i += page[0].length
      continue
    }
    text += src[i]
    i++
  }

  const marks: InlineMark[] = []
  /**
   * 删掉一对标记字符 ⇒ 它右边的**所有位置**左移。
   * ⚠️ 这里必须把**前面几趟已经找到的 mark 端点**一起挪，否则「先 ==高亮== 后 **加粗**」
   * 这类句子里，加粗的区间会整体偏掉（这一趟删的字符在它左边）。
   */
  const shiftFrom = (from: number, delta: number) => {
    for (const a of atoms) if (a.start >= from) a.start += delta
    for (const m of marks) {
      if (m.start >= from) m.start += delta
      if (m.end >= from) m.end += delta
    }
  }
  // 顺序要紧：先 `**` 再 `*`（否则 `**` 会被单星吃掉）
  for (const [open, close, type] of [
    ['**', '**', 'bold'],
    ['==', '==', 'highlight'],
    ['`', '`', 'code'],
    ['*', '*', 'italic'],
  ] as [string, string, MarkType][]) {
    let out = ''
    let idx = 0
    while (idx < text.length) {
      const a = text.indexOf(open, idx)
      if (a < 0) {
        out += text.slice(idx)
        break
      }
      const b = text.indexOf(close, a + open.length)
      if (b < 0) {
        out += text.slice(idx)
        break
      }
      out += text.slice(idx, a)
      const start = out.length
      const inner = text.slice(a + open.length, b)
      shiftFrom(a + open.length, -open.length)
      shiftFrom(b, -close.length)
      out += inner
      marks.push({ type, start, end: start + inner.length })
      idx = b + close.length
    }
    text = out
  }
  return { text, marks, atoms }
}

/* --------------------------------------------------------------- 构建 */

interface BuiltPage {
  /** 页 ＝ 一个带 `page` 角色的块；页名就是它的正文（journal 也复用这个形状） */
  page: Block
  /** 页面标题 → id 的解析表（延后处理引用目标） */
  refs: { atomId: string; label: string }[]
  /** 这一页自己的锚点与原子（最后上提到库级，demo 平铺存放） */
  marks: Mark[]
  atoms: Atom[]
}

function buildTree(seeds: SeedBlock[], out: { marks: Mark[]; atoms: Atom[]; refs: BuiltPage['refs'] }): Block[] {
  return seeds.map((s) => {
    const { text, marks, atoms } = parseInline(s.text)
    const b = mkBlock(text, s.todo ? { todo: s.todo } : {})
    if (s.collapsed) b.collapsed = true
    if (s.roles) b.roles = [...s.roles]
    if (s.props) b.props = { ...s.props }
    for (const m of marks) out.marks.push({ id: uuidv7Hex(), type: m.type, blockId: b.id, start: m.start, end: m.end })
    for (const a of atoms) {
      const id = uuidv7Hex()
      const atom: Atom = {
        id,
        kind: a.kind,
        blockId: b.id,
        start: a.start,
        end: a.start + 1,
        label: a.label,
      }
      if (a.kind === 'page') out.refs.push({ atomId: id, label: a.label })
      else {
        atom.asset = {
          hash: uuidv7Hex().slice(0, 32),
          name: a.label,
          bytes: a.missing ? 0 : 210_944,
          mime: 'image/png',
          state: a.missing ? 'missing' : 'ready',
          w: 1440,
          h: 900,
        }
      }
      out.atoms.push(atom)
    }
    b.children = buildTree(s.children ?? [], out)
    return b
  })
}

/**
 * 造一个页：**页块 ＋ 它的子树**。
 *
 * 判据：页名就是页块自己的正文；图标是系统属性 `_icon`；
 * 原来的「页的 roots」就是页块的 `children` —— 一个页恰好是一个块。
 */
function mkPage(title: string, icon: string, seeds: SeedBlock[], id = uuidv7Hex()): BuiltPage {
  const acc = { marks: [] as Mark[], atoms: [] as Atom[], refs: [] as BuiltPage['refs'] }
  const children = buildTree(seeds, acc)
  const page: PageBlock = {
    id,
    text: title,
    children,
    roles: ['page'],
    props: { _icon: icon },
  }
  return { page, refs: acc.refs, marks: acc.marks, atoms: acc.atoms }
}

/**
 * 造一个日记块：**角色 `journal` ＋ `_date`**，日期不进 `text`。
 * 它和页复用同一个 `BuiltPage` 形状（子树 / 锚点 / 原子），只是换一个角色。
 */
function mkJournal(date: string, seeds: SeedBlock[]): BuiltPage {
  const acc = { marks: [] as Mark[], atoms: [] as Atom[], refs: [] as BuiltPage['refs'] }
  const children = buildTree(seeds, acc)
  const block: Block = {
    id: journalId(date),
    text: '',
    children,
    roles: ['journal'],
    props: { _date: date, _icon: 'lucide:calendar' },
  }
  return { page: block, refs: acc.refs, marks: acc.marks, atoms: acc.atoms }
}

/**
 * 把 `[[..]]` 解析到真实地址（页与标签共用同一个名字空间）。
 *
 * ⚠️ 解析不到 ⇒ **不写 `target`**：「指不到东西」就是**没有目标**，
 *    不是「指向一个叫 `missing:xxx` 的实体」（那会让 `dangling` 变成一个能被引用的假目标）。
 *    显示名仍走 `atom.label`（fallback），`dangling` 由渲染层**现算**（`core/ref.ts`）。
 * ⚠️ 只有**能当地址**的块才被解析到（页 / 标签）：journal 的 text 是空的（日期在 `_date` 里），
 *    混进来会把 `[[ ]]` 解析到日记块上；schema 的正文是字段名（允许重名），也不进地址空间。
 * ⚠️ 比较走 `core/alias.ts` 的规范化（`[[ 设计 ]]` 与 `#设计` 是同一个块）。
 */
function resolveRefs(pages: Block[], built: BuiltPage[]): void {
  for (const bp of built) {
    for (const r of bp.refs) {
      const target = findByAlias(pages, r.label)
      const atom = bp.atoms.find((a) => a.id === r.atomId)!
      if (target) atom.target = { kind: 'page', id: target.id }
    }
  }
}

/* --------------------------------------------------------------- 长文 */

function longParagraph(): string {
  const parts = [
    '自研区间锚点这件事，一开始看起来只是「把 mark 的 start/end 存下来」这么简单，',
    '真正的成本全部藏在**变更映射**里：任何一次键入、删除、粘贴、跨块替换，都会让已经存在的区间端点发生位移；',
    '而位移的口径只要有一点点含糊（比如「恰好落在端点的插入算不算撑大」），',
    '几轮编辑之后就会出现「加粗比预期多吞一个字」或者「引用框住了一段不相干的文字」。',
    '我们定下的口径是：**起点的插入右移、终点的插入不动**，两端各有自己的粘性偏好，',
    '这样「插在区间内部」与「贴着边界插入」被明确区分开——边界断言里有一半是在钉这条。',
    '更麻烦的是结构性变更：拆块时右半的锚点要跟着搬到新块、合并时被并入块的锚点要整体右移、',
    '复制子树时所有锚点必须换到新块的 id 上——**锚点带 blockId** 让这些迁移有唯一正确的落点，',
    '也让「mark 绝不跨块」成为结构性事实，而不是一句写在文档里的纪律。',
    '还有一层是「谁持有选区」：DOM Range 只描述当前视窗里的那两个端点，一旦中间某块没有挂载，',
    '选区就无从表达；所以选区也放进模型（锚点块 ＋ 块内偏移），DOM 只是它的一个投影。',
    '这样一来，跨块选中、折叠块里的选中、窗口外的选中都能被表达，代价是每次渲染都要把模型选区贴回 DOM。',
    '这类「看起来多余、事后救命」的形状，是整个输入面里最容易被后来者删掉、也最不该删的部分。',
  ]
  return parts.join('')
}

const LONG_EN = [
  'The quick brown fox jumps over the lazy dog.',
  'Supercalifragilisticexpialidocious pneumonoultramicroscopicsilicovolcanoconiosis',
  'antidisestablishmentarianism floccinaucinihilipilification.',
  'A block-based document model keeps identity stable across edits, which is exactly why the anchors must carry a block id instead of a bare offset pair.',
].join(' ')

/* --------------------------------------------------------------- 假数据 */

export function seedWorkspace(): Workspace {
  const p1 = mkPage('产品设计 · 决策日志', 'lucide:compass', [
    {
      text: '口径已定：**命令表 / 绑定表 / 上下文键**——三张表，一张事实源',
      children: [
        {
          text: '命令不知道 UI：没有 key、没有 context',
          children: [
            { text: '所以「菜单项」不是命令的属性，而是绑定表的渲染结果' },
            { text: '命令面板列的是**全部命令**，与有没有键位无关' },
          ],
        },
        {
          text: '一张绑定表 ==服务五处==：keymap / menu / slash / toolbar / palette',
          children: [
            {
              text: '层次序 user > plugin > core',
              children: [
                { text: '用户永远能盖过插件与核心 #纪律' },
                { text: '`mod+shift+t` 就是一条 user 层键位' },
              ],
            },
            { text: '上下文键开放可扩展：`composing` 也是一个键，不是一个 if' },
          ],
        },
      ],
    },
    {
      text: '输入面：正文用块级 DOM ＋ 自研锚点',
      collapsed: false,
      children: [
        { text: '与 [[输入面笔记]] 同源；多行块（代码 / SQL）留给独立的编辑器实例' },
        { text: '行内原子在这里：**图片** ![[编辑器分层草图.png]] 就是一个原子 ＋ 资产引用' },
        { text: '悬空的引用也要看得见：见 [[这份页面还没写]] —— 状态是 `dangling`，不是静默错指' },
        { text: '标签写法 #设计 #输入面' },
      ],
    },
    { text: '把「引用某段」的 UI 补上', todo: 'todo' },
    { text: '锚点边界断言复跑通过 #证据', todo: 'done' },
    /**
     * **查询块**（–D6）的演示样本：条件＝「本页之下、带 #todo 的块」。
     *
     * ⚠️ 只是**数据侧**（A）：条件写在 `_query` 里，块的正文是它的名字。
     * 结果集是**外源渲染**，刷新时只改这个块的 `_queryResult`（不 re-parent，A/A）。
     * ⚠️ `_queryResult` 刻意**不预置**：第一次装载时求值（与「点刷新」走同一个函数），
     *   否则 seed 里写死一份结果，就永远测不出「冻结是求值产生的」这件事。
     */
    {
      text: '本页的待办',
      roles: ['query'],
      // 条件只用「待办状态」：这张页里没有同时带 `#todo` 标签的块，加标签条件会得到 0 条
      props: { _icon: 'lucide:list-filter', _query: { where: { todo: 'todo' } } },
    },
  ])

  const p2 = mkPage('输入面笔记', 'lucide:flask-conical', [
    {
      text: '三条判据：块树 / **模型持有选区** / 自研区间锚点',
      children: [
        { text: '扁平整棵树 ＋ `data-depth` 是虚拟化的前提' },
        {
          text: '缩进若用 DOM 层级，会与窗口化虚拟化互斥',
          children: [{ text: '这条只在「每一块都单独虚拟化」时成立，别推广成普适结论' }],
        },
        { text: '组合期不重渲染某块：`composing` 是真上下文键，不是打补丁' },
      ],
    },
    { text: '降级样本 · 超长块：' + longParagraph() },
    { text: '降级样本 · 全英文长行（不该溢出容器）：' + LONG_EN },
    { text: '一行里塞满行内原子：[[产品设计 · 决策日志]] ![[截图 2026-10-18 22.31.07.png]] 后面还要能继续打字。' },
    { text: '一段带四种区间锚点的句子：**加粗的结论**、*斜体的限定*、==高亮的关键词==、`inline code`。' },
    { text: '标记顺序不能错：==先高亮== 再 **后加粗**，两个区间都得落在自己那几个字上。' },
  ])

  const p3 = mkPage('周报 2026-W42', 'lucide:newspaper', [
    {
      text: '本周',
      children: [
        { text: '骨架复用进正式工程，**零编辑器框架依赖**' },
        { text: '命令面板 ⌘P：一切命令可搜、**可无绑定执行**' },
      ],
    },
    {
      text: '下周',
      children: [
        { text: '接真实存储（现在还是整库序列化）' },
        { text: '见 [[下季度规划]]（还没写）' },
      ],
    },
    { text: '踩过的坑', collapsed: true, children: [{ text: 'rollup 原生模块在 node v24 下 dlopen 失败 ⇒ 固定用系统 node v26.7.0' }] },
  ])

  const p4 = mkPage(
    'How I Learned to Stop Worrying and Love the Block-Based Document Model in Personal Knowledge Tools',
    'lucide:book-open',
    [
      { text: '超长标题的降级：面包屑、左栏、页面标题三处都要能截断而不破版' },
      { text: 'English-only page. **Anchors** carry a `blockId`; a *quote snapshot* can relocate them later.' },
    ],
  )

  const p5 = mkPage('', 'lucide:file', [
    { text: '无标题页：左栏、面包屑、引用 chip 都要有兜底文案' },
    { text: '引用一个无标题页：[[ ]]' },
  ])

  // 每天补几行，保证首屏 3 天就能滚（「下滚加载更早」的验收需要能滚）。
  // 用「同一主题的短句」而不是空块：空块在截图与观感上像 bug。
  const filler = (lines: readonly string[]): SeedBlock[] => lines.map((text) => ({ text }))

  // 冷启动的默认内容＝**今日 journal**：不是特例代码路径，
  // 只是森林里排在第一块的那个 journal 块（`forest()` 把 `blocks[0]` 设成 activeId）。
  const journal = mkJournal(todayISO(), [
    { text: '打开就在今天：这个日期是**只读**的，一天只有一个。' },
    { text: '把想法先丢进 journal，别卡在「这条该存哪」——这是收件箱，不是终点。' },
    { text: '前后翻日：`⌘⌥←` / `⌘⌥→`（编辑器失焦时），回今日：`⌘⇧D`。' },
    ...filler([
      '今天先只做一件事：把「冻结 + 刷新」这条路走通。',
      '查询结果不自动消失——不匹配了只是标记「可能已过期」。',
      '刷新是显式动作，所以打字的时候行不会跳。',
      '成员冻结、顺序冻结，只有内容按块 id 现读。',
      '空结果要保留抬头，不能整块消失。',
      '刷新失败保留旧结果，只弹一条提示。',
      '这套行为照的是「时间冻结」的直觉，不是「实时同步」。',
      '先跑通这一版，条件构造器放到后面。',
    ]),
  ])

  // 的日记流：再给几天「存在的」历史，冷启动就能看到「今日在顶、向下更早」。
  // ⚠️ 流只取**存在的** journal 块，不按日历生造空天。
  const yesterday = mkJournal(shiftISO(todayISO(), -1), [
    { text: '把查询视图的结论试了一遍——**冻结结果集 ＋ 手动刷新**比实时刷新稳。' },
    { text: 'TODO：把「最近日记」列表接进左槽', todo: 'todo' },
    { text: '灵感', children: [{ text: '日记流是单列时间流，不是瀑布流' }] },
    ...filler([
      '试了实时刷新：打字时整行会往下跳，体验很糟。',
      '结论：刷新交给用户按，不交给定时器。',
      '冻结结果集之后，「可能已过期」这个状态要能看见。',
      '不是自动消失，是标记。这两个差别很大。',
      '结果按块 id 现读，所以改正文能立刻看到新字。',
      '查询块自己也是一块——它的正文就是它的名字。',
      '条件先只管一种：待办状态。',
      '表格与看板留到字段级编辑那一步。',
    ]),
  ])
  const dayBefore = mkJournal(shiftISO(todayISO(), -2), [
    { text: '读了两种查询实现：实时刷新会让行在打字时跳走。' },
    { text: '完成：刷新按钮的行为对齐（冻结结果集 + 手动刷新）', todo: 'done' },
    ...filler([
      '对照了两种查询实现，差别主要在「结果集什么时候变」。',
      '冻结成员与顺序，内容按块 id 现读——这条路更稳。',
      '实时刷新的代价是「打字时行会跳」，收益却很小。',
      '反向链接也走同一条查询：它就是一条「谁指向我」。',
      '把反链做进页底之后，右槽那条反而显得重复。',
      '先两边都在，看实际用起来哪个更顺手。',
      '查询与反链共用一个渲染器，块只读一份。',
      '真正难的是索引，不是渲染。',
    ]),
  ])
  const day3 = mkJournal(shiftISO(todayISO(), -3), [
    { text: '把日记流的「今日在顶、向下更早」画成图。' },
    ...filler(['把顺序这件事画出来，才发现它比想象中轻。']),
  ])
  const day4 = mkJournal(shiftISO(todayISO(), -4), [
    { text: '确认瀑布流不适合大纲式日记。' },
    ...filler(['时间轴一旦被打散，回看就变成了检索。']),
  ])
  const day5 = mkJournal(shiftISO(todayISO(), -5), [
    { text: '日常笔记的默认形态就应该是一列时间。' },
    ...filler(['默认落点就该是今天，不需要用户先选一个页面。']),
  ])

  const built = [journal, yesterday, dayBefore, day3, day4, day5, p1, p2, p3, p4, p5]
  const blocks = built.map((b) => b.page)
  // 默认的收藏容器块：**命名容器块 + 一列有序块引用**，左槽据此渲染「收藏」
  // ⚠️ core 层不能 import app 层 ⇒ 这里就地建（`makeFavoriteContainer` 在 app 层是同一形状的工厂）
  const favorites: Block = { id: uuidv7Hex(), text: '常用', children: [], roles: ['favorites'], props: { _icon: 'lucide:star', _favorites: [p1.page.id, p2.page.id] } }
  blocks.push(favorites)
  resolveRefs(blocks, built)

  return forest(blocks, built)
}

/* --------------------------------------------------------- 三个演示状态 */

/** 一片块森林 + 库级锚点/原子（承 1／5：没有「页实体」这一层） */
function forest(blocks: Block[], built: BuiltPage[]): Workspace {
  return {
    version: WORKSPACE_VERSION,
    blocks,
    activeId: blocks[0]?.id ?? '',
    prefs: { ...DEFAULT_PREFS },
    savedAt: Date.now(),
    marks: built.flatMap((b) => b.marks),
    atoms: built.flatMap((b) => b.atoms),
  }
}

/**
 * 空态：一个页块、**零子块**（「只能写第一行＝页名」，不做插画）。
 *
 * ⚠️ 2026-10-20 修：原来是 `mkPage('', …, [{ text: '' }])` ⇒ 页块 ＋ 一个空子块 ＝ **两行空白**。
 *   旧代码之所以只显示一行，是因为它错把 `children` 当 roots 装；修好装载口径之后这里就露出来了。
 */
export function emptyWorkspace(): Workspace {
  return forest([mkPage('', 'lucide:file', []).page], [])
}

/** 稀疏态：只有 1 个块、1 个页面（**比满态更容易做砸**） */
export function sparseWorkspace(): Workspace {
  const b = mkPage('唯一一页', 'lucide:file', [{ text: '这一页只有一个块。' }])
  return forest([b.page], [b])
}

/** 降级态：超长块 / 全英文 / 超长标题 / 无标题 / 缺失资产，一屏看完 */
export function degradedWorkspace(): Workspace {
  const long = mkPage('超长标题 · A Very Long Page Title That Keeps Going And Going Until Both The Rail And The Breadcrumb Have To Truncate It', 'lucide:triangle-alert', [
    { text: '超长块（' + longParagraph().length + ' 字，单块）：' + longParagraph() },
    { text: '全英文无空格断点：' + LONG_EN },
    { text: '超长标题的页面在左栏里也要能活：' + 'A Very Long Page Title That Keeps Going And Going '.repeat(3) },
    { text: '缺失资产（**资产不可用是状态不是错误**）：![[丢失的截图.png]]' },
    { text: '空块（既无文字也无子块）——上面这行下面还有一个：' },
    { text: '' },
    { text: '只有标点的一行：？？？！！！……' },
  ])
  const noTitle = mkPage('', 'lucide:file', [{ text: '无标题页里的内容' }])
  const built = [long, noTitle]
  const blocks = built.map((b) => b.page)
  resolveRefs(blocks, built)
  return forest(blocks, built)
}

export function demoState(name: 'seed' | 'empty' | 'sparse' | 'degraded'): Workspace {
  const ws =
    name === 'empty'
      ? emptyWorkspace()
      : name === 'sparse'
        ? sparseWorkspace()
        : name === 'degraded'
          ? degradedWorkspace()
          : seedWorkspace()
  return ws
}

