/**
 * 假数据 —— 一份**像真实笔记的库**：中文为主、中英混排、嵌套 3–4 层，含标签 / 引用 chip /
 * 图片占位 / 一段长文 / 一个悬空引用的 `dangling`）/ 一个缺失资产。
 *
 * 正文用迷你 DSL 写（见 `inline.ts`），由它解析成 run 序列（文本段带格式、引用与图片是 run）。
 * 三个演示状态（空 / 稀疏 / 降级）在 `states.ts`，冷启动首屏在 `core/bootstrap.ts`：
 * 它们与「满态种子」是**不同的用途**，混在一个文件里会让「改首屏」和「改满态」互相牵连。
 */
import {
  declareField,
  mkJournalMountsBlock,
  mkPropDef,
  mkTagBlock,
  shiftISO,
  TASK_STATUS_PROP_ID,
  todayISO,
  UI_POSITION_PROP,
  type Block,
} from '../index.ts'
import { t } from '../msg.ts'
import type { Workspace } from '../workspace.ts'
import { forest, longParagraph, LONG_EN, mkJournal, mkPage, resolveRefs, resolveSeedTags, SEED_AT } from './build.ts'
import type { SeedBlock } from './inline.ts'

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
                { text: '用户永远能盖过插件与核心', tags: ['纪律'] },
                { text: '`mod+shift+t` 就是一条 user 层键位' },
              ],
            },
            { text: '上下文键开放可扩展：`composing` 也是一个键，不是一个 if' },
          ],
        },
      ],
    },
    {
      text: '输入面：正文用块级 DOM ＋ 自研行内内容',
      children: [
        { text: '与 [[输入面笔记]] 同源；多行块（代码 / SQL）留给独立的编辑器实例' },
        { text: '行内原子在这里：**图片** ![[编辑器分层草图.png]] 就是一个原子 ＋ 资产引用' },
        { text: '悬空的引用也要看得见：见 [[这份页面还没写]] —— 状态是 `dangling`，不是静默错指' },
        { text: '标签写法', tags: ['设计', '输入面'] },
      ],
    },
    { text: '把「引用某段」的 UI 补上', tags: ['任务'], task: false },
    { text: '行内内容边界断言复跑通过', tags: ['任务', '证据'], task: true },
    /**
     * **查询块**的演示样本：条件＝「本页之下、还没做完的待办」。
     *
     * ⚠️ 只是**数据侧**（A）：条件写在 `_query` 里，块的正文是它的名字。
     * 结果集是**外源渲染**，刷新时只改这个块的 `_queryResult`（不 re-parent，A/A）。
     * ⚠️ `_queryResult` 刻意**不预置**：第一次装载时求值（与「点刷新」走同一个函数），
     *   否则 seed 里写死一份结果，就永远测不出「冻结是求值产生的」这件事。
     */
    {
      text: '本页的待办',
      // 条件只用「待办状态」：三态（做完／是任务但没填／不是任务）只有这一条条件分得开，
      // 属性条件会漏掉「有槽未填」的那种。这张页里没有同时带某个标签的块，加标签条件会得到 0 条
      props: { _icon: 'lucide:list-filter', _query: { where: { todo: 'todo' } } },
    },
  ])

  const p2 = mkPage('输入面笔记', 'lucide:flask-conical', [
    {
      text: '三条判据：块树 / **模型持有选区** / 自研行内内容',
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
    { text: '缺失样本（**字节不在库里是状态，不是错误**）：![[丢失的截图.png]] 它右边的文字照样能编辑。' },
    { text: '一段带四种行内格式的句子：**加粗的结论**、*斜体的限定*、==高亮的关键词==、`inline code`。' },
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
    { text: '踩过的坑', children: [{ text: 'rollup 原生模块在 node v24 下 dlopen 失败 ⇒ 固定用系统 node v26.7.0' }] },
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
    { text: '把「最近日记」列表接进左槽', tags: ['任务'], task: false },
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
    { text: '刷新按钮的行为对齐（冻结结果集 + 手动刷新）', tags: ['任务'], task: true },
    ...filler([
      '结果集什么时候变，是查询这条路唯一要定的事。',
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
  // 核心词汇（定义块 ＋ 标签块）先在森林顶层就位：`ensureTag` 要能找到 `任务` 并复用，
  // 否则种子会建出第二个同名标签；`[[ ]]` 的解析也要在这之后（标签同样占地址）。
  blocks.push(...coreVocabulary())
  /**
   * 日记的挂载区共享配置：一个**没有列表露面**的内部块（只按 id 找）。
   *
   * 种子里给它挂一栏演示查询，是为了让首次装载真的走一次「用户 tab」那条分支——
   * 一份只在内置三栏上测过的实现，会在「有用户栏」时才暴露排序、空态、摘除的问题。
   * 条件带 `$self`：它在今天求值时指今天，所以这一栏的名字与内容不必写死日期。
   */
  const todayTodos = t('ui.mount.demo.todayTodos')
  const mountsBlock = mkJournalMountsBlock([
    { label: todayTodos, spec: { where: { all: [{ journal: '$self' }, { todo: 'todo' }] } } },
  ])
  // 它也是**种子内容**（会进库、会导出）⇒ 与其它种子同一个固定时刻，理由同 `coreVocabulary`
  mountsBlock.created = SEED_AT
  mountsBlock.modified = SEED_AT
  blocks.push(mountsBlock)
  // 标签归属先落成 id（新标签块会在这时进森林），再解析 `[[ ]]`
  resolveSeedTags(blocks, built.flatMap((b) => b.pendingTags))
  resolveRefs(blocks, built)

  return forest(blocks, built)
}

/**
 * **核心词汇**：种子库里必须存在的字段定义与标签。
 *
 * 它们住在**森林顶层** —— 身份不参与组织（`schema` 与 `tag` 的位置不承载任何信息，
 * 所有读路径都按 id 找它们）。所以这里不挂在任何页的子树下：挂在谁下面，
 * 谁被删掉就会带走它们。
 *
 * 顺序：定义块在前、标签块在后 —— 标签要声明那个字段，读一遍就知道它声明的是谁。
 *
 * 「任务」不是一个新概念，是两样东西的组合：**值**（做完了没有）＝ 一个全局属性，
 * **分类**（这块属于任务）＝ 一个标签。值走属性是因为它的语义是用户词汇、
 * 要能进查询/导出/属性面板；而「这块是不是任务」是分类，分类是标签的事。
 *
 * ⚠️ 这两个名字是**数据**（定义块/标签块的正文），不是界面文案：它们会进库、
 *    会跟着导出、用户也能改。所以它们与其它种子内容住在一起，而不是进 `msg.ts`。
 */
export const TASK_STATUS_LABEL = '任务状态'
export const TASK_TAG_LABEL = '任务'

function coreVocabulary(): Block[] {
  const taskStatus = mkPropDef(TASK_STATUS_LABEL, 'checkbox', { [UI_POSITION_PROP]: 'block-left' }, TASK_STATUS_PROP_ID)
  const task = mkTagBlock(TASK_TAG_LABEL)
  task.props = { ...(task.props ?? {}), _icon: 'lucide:check-square' }
  declareField(task, TASK_STATUS_PROP_ID)
  // 它们也是**种子内容**（会进库、会导出）⇒ 与其它种子同一个固定时刻：
  // 留 `Date.now()` 会让这两块每次 seed 都跟别的内容差一年，而它们本该是同一份快照。
  for (const b of [taskStatus, task]) {
    b.created = SEED_AT
    b.modified = SEED_AT
  }
  return [taskStatus, task]
}
