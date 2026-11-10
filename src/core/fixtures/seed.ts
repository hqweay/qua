/**
 * 假数据 —— 一份**像真实笔记的库**，同时是**首屏的产品导览**。
 *
 * 默认落点是今日 journal，所以「第一次打开看到什么」由这一屏承担：
 * 一句主张、三个地址（仓库 / 演示站 / 架构图）、行内图片与缺失资产、引用与悬空引用、
 * 行内标签与块标签（同一份归属的两种露面）、待办两种状态、嵌套、以及「这一屏可以随便改」的提醒。
 * 顶层另有**属性 / 实例 / 看法**的完整样本：`功能` 标签声明两个属性、几条实例填着值、
 * 一条「功能看板」查询在四张看法（看板 / 表格 / 画廊 / 日历）之间切换——
 * 每个已落地的能力都有一份**能摸到的数据**，而不是一句文档。
 * 槽的样本在**设备侧**（`seedDock()`）：左槽一只演示收纳盘，两颗快捷卡指到功能看板与输入面笔记。
 *
 * 为什么不是一张「欢迎页」：页 / 日记 / 标签都只是块的露面，**开场落点就是真实的
 * 编辑面**——用户看到的第一块不是只读介绍，而是可以拆、可以改、可以撤销的内容。
 *
 * 正文用迷你 DSL 写（见 `inline.ts`），由它解析成 run 序列（文本段带格式、引用与图片是 run）。
 * 三个演示状态（空 / 稀疏 / 降级）在 `states.ts`，冷启动首屏在 `core/infra/bootstrap.ts`：
 * 它们与「满态种子」是**不同的用途**，混在一个文件里会让「改首屏」和「改满态」互相牵连。
 *
 * ⚠️ 内容里的几个名字是**判据**，不是文案：`产品设计 · 决策日志` 必须是第一页
 *    （首行＝页块正文、页底查询与反链都挂在它上面），`输入面笔记` 背着行内内容的样本，
 *    六天的 journal 保证日记流能滚、能向后加载。改它们要连带跑门禁。
 *    `seedDock()` 的快捷卡按确定性 id 指到 `功能看板` 与 `输入面笔记`——这几块改名可以，
 *    换 id 就要连带 `seedDock()` 与它的断言。
 */
import {
  appendEdge,
  CHILD_PROPS_PROP,
  declareField,
  DEFAULT_PROP,
  derivedId,
  mkBlock,
  mkObjRecord,
  mkPropDef,
  mkQueryBlock,
  mkTagBlock,
  plainText,
  shiftISO,
  TASK_STATUS_ABANDONED_ID,
  TASK_STATUS_DONE_ID,
  TASK_STATUS_PROP_ID,
  textRuns,
  todayISO,
  type Block,
  type MountEntry,
} from '../index.ts'
import { taskStatusVocabulary } from './task-vocabulary.ts'
import { t } from '../infra/msg.ts'
import type { Workspace } from '../infra/workspace.ts'
import { DEFAULT_DOCK, type DockPrefs } from '../storage/prefs.ts'
import type { DockEntry } from '../views/dock.ts'
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
        { text: '⌘K 全局搜索：按正文关键词找块，命中可就地预览与编辑。' },
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
        { text: '正文里的 #功能 是一次提及（占一格的原子）；块的标签 chip 不占正文——同一份归属，两种露面。' },
        { text: '顶层有一条「功能看板」值得点开：实例按状态分列的看板，还能切成表格、画廊与日历——同一批数据，四种读法。' },
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
      '左槽「常用」那格是一张收纳盘：小卡收进一张卡，卡头就是把手；拖出来就还原。',
      '⌘⇧V 开关虚拟化：窗口外的块不挂 DOM，滚动时再挂上。',
      '⌘⇧? 看全部键位；行首敲 / 是斜杠菜单。',
      '⌘Z 一步回：拆块、合并、格式、拖动都能撤销。',
      '翻日：编辑器失焦时 ⌘⌥← / ⌘⌥→；回今日 ⌘T。',
    ]),
  ])

  /* ------------------------------------------------------- 昨天 / 前天：这一周在做什么 */

  const yesterday = mkJournal(shiftISO(todayISO(), -1), [
    {
      text: '属性与实例收口的一天：标签可以**声明属性**，实例（⇧↵）是标签的一次出现——背后没有新实体。',
      children: [
        { text: '值走属性（能进查询、导出、属性面板），分类走标签；「任务」就是这两样的组合。' },
        { text: '实例落在森林顶层：位置对它不承载信息，读路径一律按 id 与归属找它。' },
      ],
    },
    { text: '给「功能」标签声明了状态与落地日期，顶层那几条实例就是用产品管理产品。' },
    ...filler([
      '声明与值分开：定义块回答「这一栏是什么」，块上的值回答「这块填了什么」。',
      'select 的值域是定义块的直接子块——角色由位置派生，不另存一份「这是选项」。',
      '缺省值住在定义上：实例没填这一栏时，面板读出来的就是它。',
      '属性键是定义块的 id：改显示名不影响查询语义。',
      '实例没有地址：身份由「哪条归属指着它」给出，要提名是另一个动词。',
      '顶层不是杂物抽屉：实例住在那里，是因为位置对它不承载信息。',
    ]),
  ])

  const dayBefore = mkJournal(shiftISO(todayISO(), -2), [
    {
      text: '看法收口的一天：同一批记录，卡片按值分列是**看板**、不分组是**画廊**、按日期铺开是**日历**。',
      children: [
        { text: '看法住在源块上，露面只存一次选择——同一批数据不会有第二份配置。' },
        { text: '按值分组时拖卡＝写那一格的值，不是换父子。' },
      ],
    },
    { text: '顶层那条「功能看板」就是样本：四张看法切换，数据一行不动。' },
    ...filler([
      '大纲是唯一可编辑的那种看法——其它看法先把数据读清楚。',
      'query 源不接导图：命中集合不是树，硬接只会画出错误的结构。',
      '日历的落点跟着日期属性走：没填日期的卡去「未填」那一格。',
      '表格的列也是属性：键是定义块 id，改名列还在。',
      '看板不是第二种看法：卡片分组之后的那副面孔。',
      '空结果要保留抬头，不能整块消失。',
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
    { text: '实例是标签的一次出现：顶层的几条「功能」实例背后没有新实体——归属与属性就是它的全部。' },
    // 待办样本：这一页恰好一条未完成，页底那条查询才稳定只有 1 行结果。
    { text: '把「引用某段」的 UI 补上', tags: ['任务'], task: false },
    { text: '行内内容边界断言复跑通过', tags: ['任务', '证据'], task: true },
    /**
     * **查询块**的演示样本：条件＝「本页之下、还没做完的待办」（`{up:{is:$self}}` ＋ 属性）。
     *
     * ⚠️ 只是**数据侧**（A）：条件写在 `_query` 里，块的正文是它的名字。
     * 结果是**每个表面实例**自己冻结的（内存里，重开重算），不预置 ——
     *   否则 seed 里写死一份结果，就永远测不出「冻结是求值产生的」这件事。
     */
    {
      text: '本页的待办',
      // 「未完成」＝ 有这一栏、值不是终态（`neq` 只对有这一栏的块成立）：
      // 靠标签声明拿到这一栏的块由读侧缺省读出「待办」，一样命中，不需要专用原子。
      // 「完成」与「放弃」都是关闭：前者做成了，后者明确不做了，都不算还欠着。
      // 「本页之下」显式写成方向条件：范围轴退场后，缺省就是整库。
      props: {
        _icon: 'lucide:list-filter',
        _query: {
          where: {
            all: [
              { prop: { id: TASK_STATUS_PROP_ID, neq: TASK_STATUS_DONE_ID } },
              { prop: { id: TASK_STATUS_PROP_ID, neq: TASK_STATUS_ABANDONED_ID } },
              { up: { is: '$self' } },
            ],
          },
        },
      },
    },
    { text: '关于「假数据」：这一页与别处一样可改；换库只换内容，不改形状。' },
    // 最后两行是**镜像样本**：宿主块在装配段构造（要指向 p3 的「下一步」，那时 id 才存在）。
    { text: '最后一行是镜像：源是开发日志的「下一步」，改源跟着变——露面只存一次看法的选择。' },
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
    // **算作**样本：下一行会被 appendEdge 到 p3 的「下一步」下（装配段做，那时父块 id 才存在）。
    { text: '同一块、两处算作：下面这行迁移笔记也算作开发日志「下一步」的一员——算作只加一条父边，树没有搬。' },
    { text: '多库迁移的注意点：先备份原始字节，再换内容。' },
    { text: '降级样本 · 超长块：' + longParagraph() },
    { text: '降级样本 · 全英文长行（不该溢出容器）：' + LONG_EN },
    { text: '归属放在正文之外：这一页打了标签，字一个都没被改。', tags: ['设计', '输入面', '资产'] },
    // 确定性 id：演示盘（`seedDock()`）的快捷卡按 id 指到这一页——建库与设备状态分开调用，id 必须两边一致
  ], SEED_INPUT_NOTES_ID)

  const p3 = mkPage('开发日志 · 2026-W44', 'lucide:newspaper', [
    {
      text: '本周：属性、实例与看法。',
      children: [
        { text: '标签声明属性、⇧↵ 建实例、属性面板就地改值——值能进查询与表格。' },
        { text: '卡片按值分列是看板、不分组是画廊、按日期铺开是日历：同一批数据，一份配置。' },
        { text: '顶层的「功能看板」就是这周的数据样本：用产品管理产品。' },
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
        { text: '11-09 回收站清空：对口径集合的一次清理，不进撤销。' },
        { text: '11-05 多库与库根：一个窗口一个库，数据从浏览器搬进文件。' },
        { text: '11-07 看法收口：卡片分列是看板，不分组是画廊。' },
        { text: '10-27 行内图片上线：粘贴、选文件、lightbox、缺失三态。' },
      ],
    },
    {
      text: '下一步',
      // **子块行头属性**的演示：父块声明 `_childProps`，直接子块行头显示这一栏的值。
      props: { [CHILD_PROPS_PROP]: [FEATURE_STATUS_PROP_ID] },
      children: [
        {
          text: '条件构造器：把查询的门槛降下来。',
          props: { [FEATURE_STATUS_PROP_ID]: FEATURE_STATUS_EXPLORING_ID },
        },
        {
          text: '发布与签名：把安装包送到别人手上。',
          props: { [FEATURE_STATUS_PROP_ID]: FEATURE_STATUS_EXPLORING_ID },
        },
        {
          text: '图库管理：图多了之后的入口。',
          props: { [FEATURE_STATUS_PROP_ID]: FEATURE_STATUS_SHELVED_ID },
        },
      ],
    },
    { text: '这一页也是块：把「下一步」整棵子树拖进左槽，就能开一张窗口。' },
    { text: '周记只写「变了什么、为什么」，不抄一遍提交记录。', tags: ['开发日志'] },
  ])

  const p4 = mkPage(
    'How I Learned to Stop Worrying and Love the Block-Based Document Model in Personal Knowledge Tools',
    'lucide:book-open',
    [
      { text: '超长标题的降级：面包屑、左槽、引用选择器三处都要能截断而不破版' },
      { text: 'English-only page. **Anchors** carry a `blockId`; a *quote snapshot* can relocate them later.' },
    ],
  )

  const p5 = mkPage('', 'lucide:file', [
    { text: '无标题页：左槽、面包屑、引用 chip 都要有兜底文案' },
    { text: '引用一个无标题页：[[ ]]' },
  ])

  const built = [journal, yesterday, dayBefore, day3, day4, day5, p1, p2, p3, p4, p5]
  const blocks = built.map((b) => b.page)

  /**
   * **全部页面**＝一个查询块。要「所有页在一处看」的工作台，造的是**条件**（`role:'page'`
   * 问的就是「页」这份身份判据），不是第二个目录实体——列表本身能排序能切片，因为它是查询。
   */
  const allPages = mkQueryBlock({ name: '全部页面', spec: { where: { role: 'page' } }, icon: 'lucide:list' })
  allPages.created = SEED_AT
  allPages.modified = SEED_AT
  blocks.push(allPages)

  /**
   * **功能看板**＝属性 / 实例 / 看法三件事共用的一条查询：条件按标签归属取成员，
   * 四张命名看法（看板 / 表格 / 画廊 / 日历）挂在源块上——切看法不换数据。
   *
   * ⚠️ 同「全部页面」：只造**条件与配置**，不预置结果——冻结是求值产生的。
   */
  const featureBoard = mkQueryBlock({
    name: '功能看板',
    spec: { where: { tag: FEATURE_TAG_LABEL } },
    views: [
      {
        id: 'seed-kanban',
        name: '看板',
        kind: 'cards',
        // 看板＝卡片按值分列：组按选项 id 实时导出，呈现顺序钉成声明序
        groupBy: FEATURE_STATUS_PROP_ID,
        groupOrder: [FEATURE_STATUS_EXPLORING_ID, FEATURE_STATUS_SHIPPED_ID, FEATURE_STATUS_SHELVED_ID],
      },
      {
        id: 'seed-table',
        name: '表格',
        kind: 'table',
        table: { columns: [{ key: FEATURE_STATUS_PROP_ID }, { key: FEATURE_DATE_PROP_ID }] },
      },
      { id: 'seed-gallery', name: '画廊', kind: 'cards' },
      {
        id: 'seed-calendar',
        name: '日历',
        kind: 'calendar',
        calendar: { dateBy: FEATURE_DATE_PROP_ID, showUndated: true },
      },
    ],
    activeView: 'seed-kanban',
  })
  featureBoard.created = SEED_AT
  featureBoard.modified = SEED_AT
  // 同「输入面笔记」：演示盘的快捷卡按 id 指到这块（确定性 id，见顶部常量）
  featureBoard.id = SEED_FEATURE_BOARD_ID

  // 核心词汇（定义块 ＋ 标签块）先在森林顶层就位：`ensureTag` 要能找到 `任务` 并复用，
  // 否则种子会建出第二个同名标签；`[[ ]]` 与 `#标签` 的解析也要在这之后（标签同样占地址）。
  const vocab = coreVocabulary()
  blocks.push(...vocab.blocks)

  // 标签归属先落成 id（新标签块会在这时进森林），再解析 `[[ ]]` 与 `#标签`
  resolveSeedTags(blocks, built.flatMap((b) => b.pendingTags))
  resolveRefs(blocks, built)

  // 实例样本：条数与值的分布开——看板每一列有卡、日历有落点、缺省值有一条没填的样本
  blocks.push(...featureInstances(vocab.featureTagId))
  blocks.push(featureBoard)

  /* ---------------------------------------------- 要拿到已建块 id 才能写的样本 */

  const nextStep = childByPlain(p3.page, '下一步')
  // 镜像：p1 的宿主块指向 p3 的「下一步」（`view:''` ＝ 跟随源块的默认看法）
  if (nextStep) {
    const mirror = mkBlock(textRuns('下一步 · 镜像'), {
      props: { _embed: { block: nextStep.id, view: '' } },
      created: SEED_AT,
      modified: SEED_AT,
    })
    p1.page.children.push(mirror)
    // 算作：p2 的迁移笔记同时算作「下一步」的一员——多一条父边，树没有搬
    const migrationNote = childByPlain(p2.page, '多库迁移的注意点')
    if (migrationNote) appendEdge(migrationNote, nextStep)
  }

  return forest(blocks, built)
}

/** 按正文前缀找页的直接子块（装配段用它拿到 DSL 造不出来的那几个 id） */
function childByPlain(page: Block, prefix: string): Block | undefined {
  return page.children.find((c) => plainText(c.content).startsWith(prefix))
}

/**
 * 每天补几行，保证首屏 3 天就能滚（「下滚加载更早」的验收需要能滚）。
 * 用「同一主题的短句」而不是空块：空块在截图与观感上像 bug。
 * 它住在造库这一层而不是某一天里：三天的节奏一样，改一天不该动到另外两天。
 */
function filler(lines: readonly string[]): SeedBlock[] {
  return lines.map((text) => ({ text }))
}

/* ------------------------------------------------- 「功能」词汇：属性 ＋ 标签 ＋ 实例 */

export const TASK_TAG_LABEL = '任务'
export const FEATURE_TAG_LABEL = '功能'
export const FEATURE_STATUS_LABEL = '功能状态'
export const FEATURE_DATE_LABEL = '落地日期'

/**
 * 「功能」词汇的**确定性 id**：查询条件、看板分组、日历落点认的都是 id——
 * 种子每次构建都重跑，id 必须跨重开稳定（与任务状态词汇同一条纪律）。
 */
export const FEATURE_STATUS_PROP_ID = derivedId('prop', 'seed/feature-status')
export const FEATURE_DATE_PROP_ID = derivedId('prop', 'seed/feature-date')
export const FEATURE_STATUS_EXPLORING_ID = derivedId('choice', 'seed/feature-status/exploring')
export const FEATURE_STATUS_SHIPPED_ID = derivedId('choice', 'seed/feature-status/shipped')
export const FEATURE_STATUS_SHELVED_ID = derivedId('choice', 'seed/feature-status/shelved')

/**
 * 收纳盘的快捷卡要**指向种子刚建出来的块**，而盘住在设备状态里、与建库分开调用 ——
 * 两边必须拿到同一个 id ⇒ 这几块用确定性 id（与属性定义同一条纪律）。
 * 指针按 id 存，id 稳定 ⇒ 盘里的快捷卡不会因重种而悬空。
 */
export const SEED_FEATURE_BOARD_ID = derivedId('block', 'seed/feature-board')
export const SEED_INPUT_NOTES_ID = derivedId('block', 'seed/input-notes')
export const SEED_TRAY_ID = derivedId('tray', 'seed/quick')

/**
 * 「功能」标签 ＋ 声明给它的两个属性定义。
 *
 * 它们住在**森林顶层**（身份不参与组织，位置不承载信息）；顺序：定义块在前、标签在后——
 * 标签声明字段，读一遍就知道它声明的是谁。这份词汇只有种子一个使用者：
 * 用户手敲 `#功能` 时按需物化出来的标签**不带**这些声明——那是一条普通标签，
 * 演示用的属性与实例是种子内容，不是核心词汇。
 */
function featureVocabulary(): { blocks: Block[]; tagId: string } {
  // 选项块（select 的值域＝定义块的直接子块）：角色由位置派生，每个值带一枚图标
  const statusDef = mkPropDef(
    FEATURE_STATUS_LABEL,
    'select',
    // 缺省值住在定义上：实例没填这一栏时，面板读出来的就是它
    { [DEFAULT_PROP]: FEATURE_STATUS_EXPLORING_ID },
    FEATURE_STATUS_PROP_ID,
  )
  const choice = (label: string, id: string, icon: string): Block => ({
    ...mkBlock(label, { props: { _icon: `lucide:${icon}` } }),
    id,
  })
  statusDef.children = [
    choice('探索中', FEATURE_STATUS_EXPLORING_ID, 'loader-circle'),
    choice('已落地', FEATURE_STATUS_SHIPPED_ID, 'circle-check'),
    choice('搁置', FEATURE_STATUS_SHELVED_ID, 'minus'),
  ]
  const dateDef = mkPropDef(FEATURE_DATE_LABEL, 'date', {}, FEATURE_DATE_PROP_ID)
  const tag = mkTagBlock(FEATURE_TAG_LABEL)
  tag.props = { ...(tag.props ?? {}), _icon: 'lucide:sliders-horizontal' }
  declareField(tag, FEATURE_STATUS_PROP_ID)
  declareField(tag, FEATURE_DATE_PROP_ID)
  // 子块也要同一个固定时刻：漏一层就会得到「定义是 2026-10-27、它的选项是现在」
  for (const b of [statusDef, dateDef, tag, ...statusDef.children]) {
    b.created = SEED_AT
    b.modified = SEED_AT
  }
  return { blocks: [statusDef, dateDef, tag], tagId: tag.id }
}

/**
 * 实例样本：**一条普通的内容块**，靠 `props._tags` 归属在「功能」下——没有新实体。
 *
 * 内容是自指的：这几条就是 Qua 自己的功能清单。值的分布是刻意的：
 * 已落地的带日期（日历有落点）、「快速筛选」不填状态（缺省读出「探索中」）、
 * 探索与搁置各有一条（看板每一列都有卡）。
 */
function featureInstances(tagId: string): Block[] {
  const record = (name: string, status?: string, shippedOn?: string): Block => {
    const r = mkObjRecord(name, tagId)
    if (status !== undefined) r.props = { ...(r.props ?? {}), [FEATURE_STATUS_PROP_ID]: status }
    if (shippedOn !== undefined) r.props = { ...(r.props ?? {}), [FEATURE_DATE_PROP_ID]: shippedOn }
    // 它们同样是种子内容 ⇒ 与其它种子同一个固定时刻
    r.created = SEED_AT
    r.modified = SEED_AT
    return r
  }
  return [
    record('命令面板', FEATURE_STATUS_SHIPPED_ID, '2026-09-30'),
    record('行内图片', FEATURE_STATUS_SHIPPED_ID, '2026-10-27'),
    record('多库与库根', FEATURE_STATUS_SHIPPED_ID, '2026-11-05'),
    record('回收站', FEATURE_STATUS_SHIPPED_ID, '2026-11-09'),
    record('快速筛选'),
    record('引用某一段', FEATURE_STATUS_EXPLORING_ID),
    record('图库管理', FEATURE_STATUS_SHELVED_ID),
  ]
}

/* --------------------------------------------------------------- 设备侧 */

/**
 * **日记面板的演示栏**（`Prefs.journalMounts` 的种子）。
 *
 * 为什么不是库里的一块：日记表面是**系统视图**，不是块 —— 它不可寻址、不进回收站、
 * 不参与复制。它的配置属于「这台设备怎么看」，与 `feedLayout` 同层。
 * 曾经这里造一个**没有列表露面的内部块**来装它，那是拿一个不可寻址的块当拥有者。
 *
 * 种子里挂一栏演示查询，是为了让首次装载真的走一次「local tab」那条分支 ——
 * 一份只在内置三栏上测过的实现，会在「有用户栏」时才暴露排序、空态、摘除的问题。
 * 条件里的日期用 `$self`：它在今天求值时指今天，所以这一栏的名字与内容不必写死日期。
 */
export function seedJournalMounts(): MountEntry[] {
  return [
    {
      id: 't-seed-today-todos',
      kind: 'local',
      label: t('ui.mount.demo.todayTodos'),
      spec: {
        where: {
          all: [
            // 「这一天下面」＝ 某个祖先既是日记块、日期又等于宿主那一天（`$self` 解析成宿主的 `_date`）
            { up: { all: [{ role: 'journal' }, { prop: { id: '_date', eq: '$self' } }] } },
            // 「还没关」＝ 不是「完成」也不是「放弃」（两者都是终态，见「本页的待办」）
            { prop: { id: TASK_STATUS_PROP_ID, neq: TASK_STATUS_DONE_ID } },
            { prop: { id: TASK_STATUS_PROP_ID, neq: TASK_STATUS_ABANDONED_ID } },
          ],
        },
      },
      views: [],
    },
  ]
}

/**
 * **演示库的槽布局**（`Prefs.dock` 的种子）＝ 默认布局 ＋ 一只**演示收纳盘**。
 *
 * 为什么是追加而不是把默认四颗快捷收进盘里：默认布局是所有新库的家当，演示不该扭曲它 ——
 * 「小卡攒多了才收进盘」，默认四颗快捷还没有「多」到要收。演示盘讲的是另一个故事：
 * **常去的块可以收进一张卡**，成员是两颗快捷卡，指到种子内容里最值得看的地方
 * （功能看板 ＝ 属性/实例/看法的样本，输入面笔记 ＝ 行内内容的样本）——
 * 访客点一颗就从槽里进了产品叙事。
 *
 * 与 `seedJournalMounts` 同层：槽布局是设备状态（`storage/device.ts`「跟库走」的四格之一），
 * 只在「这一份库是刚种出来的」时给（`main.ts` 启动段），已有库不自动改布局。
 * 成员按确定性 id 指块（见顶部常量）；id 立不住的后果与所有快捷卡相同——置灰，不炸。
 */
export function seedDock(): DockPrefs {
  const d = DEFAULT_DOCK
  // 小卡聚成一排（与 `insertShortcut` 的落点口径一致：新小卡插在最后一张顶层小卡之后），
  // 盘插在快捷排之后、第一张大卡之前——它是左槽最显眼的位置，但不挤掉快捷与日历。
  const found = d.left.cards.findIndex((e) => e.kind !== 'cmd')
  const at = found === -1 ? d.left.cards.length : found
  const tray: DockEntry = {
    kind: 'tray',
    id: SEED_TRAY_ID,
    title: t('ui.dock.demo.trayTitle'),
    cards: [
      { kind: 'shortcut', block: SEED_FEATURE_BOARD_ID },
      { kind: 'shortcut', block: SEED_INPUT_NOTES_ID },
    ],
  }
  return {
    left: { ...d.left, cards: [...d.left.cards.slice(0, at), tray, ...d.left.cards.slice(at)] },
    right: { ...d.right, cards: [...d.right.cards] },
    collapsedCards: {},
    pinnedCards: {},
    solo: { left: null, right: null },
  }
}

function coreVocabulary(): { blocks: Block[]; featureTagId: string } {
  // 定义块与选项从 core 的构造器来：种子与写路径的按需物化共用同一份形状，
  // 两边各造一份就会漂移（种子有的选项、按需物化的没有，查询就分叉）。
  // 选项 id 仍是核心词汇的**确定性 id**（`todoOf`／⌘↵／种子查询按 id 认「完成」）。
  const taskStatus = taskStatusVocabulary()
  const task = mkTagBlock(TASK_TAG_LABEL)
  task.props = { ...(task.props ?? {}), _icon: 'lucide:check-square' }
  declareField(task, TASK_STATUS_PROP_ID)
  // 「功能」词汇只有种子这一个使用者（见 `featureVocabulary` 的注释），时刻由它自己盖
  const feature = featureVocabulary()
  // 它们也是**种子内容**（会进库、会导出）⇒ 与其它种子同一个固定时刻：
  // 留 `Date.now()` 会让这些块每次 seed 都跟别的内容差一年，而它们本该是同一份快照。
  for (const b of [taskStatus, task, ...taskStatus.children]) {
    b.created = SEED_AT
    b.modified = SEED_AT
  }
  return { blocks: [taskStatus, task, ...feature.blocks], featureTagId: feature.tagId }
}
