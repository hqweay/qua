/**
 * 假数据 —— 一份**像真实笔记的库**，同时是**首屏的产品导览**。
 *
 * 默认落点是今日 journal，所以「第一次打开看到什么」由这一屏承担：
 * 一句主张、三个地址（仓库 / 演示站 / 架构图）、行内图片与缺失资产、引用与悬空引用、
 * 标签、待办两种状态、嵌套、以及「这一屏可以随便改」的提醒。
 *
 * 为什么不是一张「欢迎页」：页 / 日记 / 标签都只是块的露面，**开场落点就是真实的
 * 编辑面**——用户看到的第一块不是只读介绍，而是可以拆、可以改、可以撤销的内容。
 *
 * 正文用迷你 DSL 写（见 `inline.ts`），由它解析成 run 序列（文本段带格式、引用与图片是 run）。
 * 三个演示状态（空 / 稀疏 / 降级）在 `states.ts`，冷启动首屏在 `core/bootstrap.ts`：
 * 它们与「满态种子」是**不同的用途**，混在一个文件里会让「改首屏」和「改满态」互相牵连。
 *
 * ⚠️ 内容里的几个名字是**判据**，不是文案：`产品设计 · 决策日志` 必须是第一页
 *    （首行＝页块正文、页底查询与反链都挂在它上面），`输入面笔记` 背着行内内容的样本，
 *    六天的 journal 保证日记流能滚、能向后加载。改它们要连带跑门禁。
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
  /* ------------------------------------------------------------ 今日：产品导览 */

  const journal = mkJournal(todayISO(), [
    {
      text: '相 / Qua 是一个块级大纲笔记：页、日记、标签、视图都不是实体，而是**块**在不同位置的不同露面。',
      children: [
        { text: '正文是一串 run：文字段带格式，引用与图片是**不可分的行内原子**。' },
        { text: '左键点块标＝聚焦这一块；右键＝块菜单；拖动＝重排（子树跟着走）。' },
        { text: '⌘P 命令面板：全部命令都能搜，没有键位也能执行。' },
      ],
    },
    {
      text: '三个地址先存下：',
      children: [
        // 这三行是**首屏唯一的外链样本**：点一下交给系统浏览器、⌥ 看详情（地址与「打开」）。
        // 显示名留空 ⇒ 显示地址本身，读者一眼看见要去哪；换成「仓库」这种名字就只剩一处可点的字。
        { text: '仓库　[](https://github.com/hqweay/qua)' },
        { text: '在线演示　[](https://qua.leay.net/) （数据只落在你自己的浏览器里）' },
        { text: '架构与数据结构　[](https://qua.leay.net/arch.html) （一张图：分层、块字段、读写路径）' },
      ],
    },
    {
      text: '**今天刚接上行内图片**：正文里直接显示真图，行高不变。点图看大图，⌥ 点看详情。 ![[相-首屏行内图片.png]]',
      children: [
        { text: '图是内容寻址的：正文只存 hash，字节住在资产库——同一张图粘两次也只有一份。' },
        { text: '缺字节也照样看得见：![[丢失的截图.png]] 是**状态**，不是错误。' },
      ],
    },
    {
      text: '几条能马上上手的：',
      children: [
        { text: '选中一段按 ⌘B 加粗、⌘I 斜体、⌘E 高亮，⌘＋反引号是行内代码——格式是那段文字自己的属性。' },
        { text: '引用一枚页：[[输入面笔记]]（左键打开，Shift+左键在右槽开一张窗）。' },
        { text: '悬空引用也读得出来：[[还没写的页面]] 只是没有目标，不是坏数据。' },
        { text: '这一屏之外还有两页值得翻：[[输入面笔记]] 与 [[开发日志 · 2026-W44]]。' },
        { text: '标签是归属，不是正文里的几个字：', tags: ['设计', '发布'] },
      ],
    },
    // 值（做没做完）与分类（这块属于任务）分开：值走属性，分类走标签。
    // 今日这一页留一条未完成，左槽那条「今天的待办」查询才不是空结果。
    { text: '给图片补一个「复制 / 另存」入口', tags: ['任务', '发布'], task: false },
    { text: '行内图片接进首屏：粘贴、选文件、lightbox、缺失三态', tags: ['任务', '证据'], task: true },
    ...filler([
      '这一屏是假数据，但**真的能改**：关掉重开，改动还在。',
      '这一屏底部那条「今天的待办」是一条查询：只取今天这一页里没做完的任务。',
      '右槽是检视卡与反链：同一个块可以从好几处看。',
      '⌘⇧V 开关虚拟化：窗口外的块不挂 DOM，滚动时再挂上。',
      '⌘⇧? 看全部键位；行首敲 / 是斜杠菜单。',
      '⌘Z 是模型快照栈：拆块、合并、格式、拖动都能一步回。',
      '翻日：编辑器失焦时 ⌘⌥← / ⌘⌥→；回今日 ⌘⇧D。',
    ]),
  ])

  /* ------------------------------------------------------- 昨天 / 前天：开发日志 */

  const yesterday = mkJournal(shiftISO(todayISO(), -1), [
    {
      text: '行内图片真正落地的一天：先嗅探 magic bytes，再入库（内容寻址），最后按**捕获的落点**插 run。',
      children: [
        { text: '粘贴、选文件、拒绝拖入走同一条收口——拖进来的裸 <img> 只活在 DOM 里，刷新就没了。' },
        { text: '行高固定 1.35em：虚拟化的占位不需要跟着图变。' },
      ],
    },
    {
      text: '这几天的地址也记一下：',
      children: [
        { text: '[](https://github.com/hqweay/qua)' },
        { text: '[](https://qua.leay.net/)' },
      ],
    },
    { text: '昨天的判断：先做「看得见」，再做「管理」——lightbox 与详情够用，图库放到以后。' },
    ...filler([
      '缺失与不可用分成两态：一个是「库里没有这份字节」，一个是「资产库根本没打开」。',
      'CSP 的 img-src 少了 blob: 会静默变 0×0——图不报错，就是不显示。',
      '同一份字节第二次入库是空操作，只是多一枚 run。',
      '删除图不删字节：内容寻址的代价是「删了还在」，管它的是另一件事。',
      '详情里的字段全现算：hash 落盘，mime 与状态归资产库。',
      '图不许带格式：位图没有加粗这回事。',
      '图片是一枚原子，占正文 1 格——和引用、外链同一种东西。',
    ]),
  ])

  const dayBefore = mkJournal(shiftISO(todayISO(), -2), [
    {
      text: '查询的口径又过了一遍：**冻结成员与顺序，内容按块 id 现读**。',
      children: [
        { text: '刷新是显式动作，所以打字的时候行不会跳。' },
        { text: '不匹配了不整块消失，只标「可能已过期」。' },
      ],
    },
    { text: '反链走同一条查询：它只是「谁指向我」。' },
    ...filler([
      '空结果要保留抬头，不能整块消失。',
      '刷新失败保留旧结果，只弹一条提示。',
      '结果行首给面包屑：同一句话在别的页里也有时，读者得知道这一行住哪。',
      '条件先只管一种：待办状态。',
      '表格与看板留到字段级编辑之后。',
      '真正难的是索引，不是渲染。',
    ]),
  ])

  const day3 = mkJournal(shiftISO(todayISO(), -3), [
    { text: '把日记流的「今日在顶、向下更早」画成一张图。' },
    { text: '时间轴一旦被打散，回看就变成了检索。' },
  ])
  const day4 = mkJournal(shiftISO(todayISO(), -4), [
    { text: '确认瀑布流不适合大纲式日记。' },
    { text: '默认落点就该是今天，不需要先选一个页面。' },
  ])
  const day5 = mkJournal(shiftISO(todayISO(), -5), [
    { text: '第一次把「一块是一棵树」写进代码：页、天、查询记录，全是装载单位。' },
    { text: '没有 Page 实体之后，导航就只剩「打开某个块」这一件事。' },
  ])

  /* -------------------------------------------------------------- 页：设计 / 输入面 */

  const p1 = mkPage('产品设计 · 决策日志', 'lucide:compass', [
    {
      text: '产品主张：**库的内核只有一块**——页 / 日记 / 标签 / 视图都是块的不同露面。',
      children: [
        { text: '没有 Page 实体，也没有 pages 数组：整库是一片森林。' },
        {
          text: '身份由数据推出：有日期的是日记、有字段定义的是属性、有条件的块是查询视图。',
          // 这两层是**给降级验收用的**：缩进、折叠、虚拟化都要有「更深一层」可量。
          children: [
            { text: '每种身份只有一份判据，读路径不各写一遍。', children: [{ text: '路由、面包屑、反链都走同一条父链。' }] },
          ],
        },
        { text: '地址（别名）与露面（列表位）是两套语义：有名字 ≠ 是页。' },
      ],
    },
    {
      text: '三张表：命令 / 绑定 / 上下文键。',
      children: [
        { text: '命令不知道 UI：没有键位、没有焦点判断。' },
        { text: '一张绑定表同时喂键盘、菜单、斜杠、工具栏与命令面板。' },
        { text: '上下文键是开放的：输入法组合期也是一个键，不是一个 if。' },
      ],
    },
    {
      text: '输入面：正文是 run 序列，选区住在模型里。',
      children: [
        { text: '与 [[输入面笔记]] 同源：同一套行内内容形状。' },
        { text: '跨块选中、折叠块里选中、窗口外选中都能表达——DOM 只是它的投影。' },
        { text: '悬空的引用也看得见：[[这份页面还没写]] 状态是 dangling，不是静默错指。' },
        { text: '行内图片也走这一层：![[决策日志-排版草图.png]]' },
      ],
    },
    {
      text: '交付层：槽里只有块。',
      children: [
        { text: '外观按类型、chrome 按身份；一个块一张窗口。' },
        { text: '组件第二处就抽出来：正文 / 挂载区 / 查询结果 / 侧槽共用同一个编辑器配方。' },
      ],
    },
    // 待办样本：这一页恰好一条未完成，页底那条查询才稳定只有 1 行结果。
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
      // 属性条件会漏掉「有槽未填」的那种。
      props: { _icon: 'lucide:list-filter', _query: { where: { todo: 'todo' } } },
    },
    { text: '关于「假数据」：这一页与别处一样可改；换库只换内容，不改形状。' },
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
    {
      text: '行内图片：真图按内容地址画出来，行高不变 ![[输入面-草图.png]]',
      children: [
        { text: '点图开 lightbox；⌥ 点开资产详情（hash / 尺寸 / 状态）。' },
        { text: '同一张图可以出现多次，字节只有一份。' },
      ],
    },
    // 这一行直接挂在页块下面：p1 看反链时，来源行的面包屑只有一层（页名）。
    { text: '这一页引用了 [[产品设计 · 决策日志]]——所以那一页底部的「引用」栏里，来源是这一页。' },
    { text: '缺失样本（**字节不在库里是状态，不是错误**）：![[丢失的截图.png]] 它右边的文字照样能编辑。' },
    { text: '一行里塞满行内原子：[[产品设计 · 决策日志]] ![[输入面-第二张.png]] 后面还要能继续打字。' },
    { text: '一段带四种行内格式的句子：**加粗的结论**、*斜体的限定*、==高亮的关键词==、`inline code`。' },
    { text: '标记顺序不能错：==先高亮== 再 **后加粗**，两个区间都得落在自己那几个字上。' },
    { text: '降级样本 · 超长块：' + longParagraph() },
    { text: '降级样本 · 全英文长行（不该溢出容器）：' + LONG_EN },
    { text: '归属放在正文之外：这一页打了标签，字一个都没被改。', tags: ['设计', '输入面', '资产'] },
  ])

  const p3 = mkPage('开发日志 · 2026-W44', 'lucide:newspaper', [
    {
      text: '本周：行内图片接进正文。',
      children: [
        { text: '粘贴 / 选文件 → 嗅探 → 入库（去重）→ 按捕获的落点插 run。' },
        { text: '真图缩略、lightbox、⌥ 详情；missing 与 unavailable 是两种不同的失败。' },
        { text: '行高不变，虚拟化的占位不用跟着图变。' },
      ],
    },
    {
      text: '地址',
      children: [
        { text: '仓库　[](https://github.com/hqweay/qua)' },
        { text: '在线演示　[](https://qua.leay.net/)' },
        { text: '架构与数据结构　[](https://qua.leay.net/arch.html)' },
      ],
    },
    {
      text: '最近几天',
      children: [
        { text: '10-27 行内图片上线：粘贴、选文件、lightbox、缺失三态；全量门禁绿。' },
        { text: '10-26 三张表收口：命令、绑定、上下文键各只有一份事实源。' },
        { text: '10-25 侧槽：一个块一张卡，可收起、只看这一张、拖序。' },
        { text: '10-24 拖拽收成一条缝：载荷只带块 id，落点决定含义。' },
      ],
    },
    {
      text: '下一步',
      children: [
        { text: '多库与库根：一个窗口一个库，数据从浏览器搬进文件。' },
        { text: '引用某一段：锚点带 blockId，改名与重排之后还能找回。' },
        { text: '表格与看板：先把条件构造器做出来。' },
      ],
    },
    { text: '这一页也是块：把「下一步」整棵子树拖进左槽，就能开一张窗口。' },
    { text: '周记只写「变了什么、为什么」，不抄一遍提交记录。', tags: ['开发日志'] },
  ])

  const p4 = mkPage(
    'How I Learned to Stop Worrying and Love the Block-Based Document Model in Personal Knowledge Tools',
    'lucide:book-open',
    [
      { text: '超长标题的降级：面包屑、左栏、引用选择器三处都要能截断而不破版' },
      { text: 'English-only page. **Anchors** carry a `blockId`; a *quote snapshot* can relocate them later.' },
    ],
  )

  const p5 = mkPage('', 'lucide:file', [
    { text: '无标题页：左栏、面包屑、引用 chip 都要有兜底文案' },
    { text: '引用一个无标题页：[[ ]]' },
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
 * 每天补几行，保证首屏 3 天就能滚（「下滚加载更早」的验收需要能滚）。
 * 用「同一主题的短句」而不是空块：空块在截图与观感上像 bug。
 * 它住在造库这一层而不是某一天里：三天的节奏一样，改一天不该动到另外两天。
 */
function filler(lines: readonly string[]): SeedBlock[] {
  return lines.map((text) => ({ text }))
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
