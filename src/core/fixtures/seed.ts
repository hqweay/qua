/**
 * 演示种子 —— 一份**像真实笔记的库**，同时是**新用户的第一屏**。
 *
 * 默认落点是今日 journal，所以「第一次打开看到什么」由这一屏承担：
 * 一段欢迎、几条马上能上手的操作、外链与行内图片、引用与悬空引用、
 * 提及与归属的分工（`#名` 只占正文一格，行尾 chip 才是归属）、待办两种状态、嵌套，
 * 以及「这一屏可以随便改」的提醒。
 * 顶层另有**属性 / 实例 / 看法**的完整样本：`功能` 标签声明两个属性、几条实例填着值、
 * 一条「功能看板」查询在四张看法（看板 / 表格 / 画廊 / 日历）之间切换；
 * 一条手动『自动化』（「收尾」）让「目录 · 自动化」那一面也有东西可点；
 * 另一条是**圈住父块的事件自动化**：「候选功能」下新建的每一行自动打上「功能」标签；
 * 而「候选功能」本身是一块**普通容器**，配了一张表格看法（`_views` 挂在谁身上都行）——
 * 每个已落地的能力都有一份**能摸到的数据**，而不是一句文档。
 * 一条示例备注（划选写批注）挂在「写作示范」页；槽的样本在**设备侧**（`seedDock()`）：
 * 左槽一只演示收纳盘，两颗快捷卡指到功能看板与写作示范。
 *
 * 为什么不是一张「欢迎页」：页 / 日记 / 标签都只是块的呈现方式，**开场落点就是真实的
 * 编辑面**——用户看到的第一块不是只读介绍，而是可以拆、可以改、可以撤销的内容。
 *
 * 正文用迷你 DSL 写（见 `inline.ts`），由它解析成 run 序列（文本段带格式、引用与图片是 run）。
 * 三个演示状态（空 / 稀疏 / 降级）在 `states.ts`，冷启动首屏在 `core/infra/bootstrap.ts`：
 * 它们与「满态种子」是**不同的用途**，混在一个文件里会让「改首屏」和「改满态」互相牵连。
 *
 * ⚠️ 内容里的几个名字是**判据**，不是文案：`欢迎使用相` 必须是第一页
 *    （首行＝页块正文、页底查询与反链都挂在它上面），`写作示范` 背着行内内容的样本，
 *    六天的 journal 保证日记流能滚、能向后加载。改它们要连带跑门禁。
 *    `seedDock()` 的快捷卡按确定性 id 指到 `功能看板` 与 `写作示范`——这几块改名可以，
 *    换 id 就要连带 `seedDock()` 与它的断言。
 */
import {
  ACTIVE_VIEW_PROP,
  appendEdge,
  ALIASES_PROP,
  CHILD_PROPS_PROP,
  CODE_TEXT_PROP,
  CODE_TYPE,
  CALLOUT_PROP,
  QUOTE_TYPE,
  declareField,
  DEFAULT_PROP,
  derivedId,
  mkAutomationBlock,
  mkBlock,
  mkObjRecord,
  mkPropDef,
  mkQueryBlock,
  mkTagBlock,
  plainText,
  setChoices,
  shiftISO,
  TASK_STATUS_ABANDONED_ID,
  TASK_STATUS_DONE_ID,
  TASK_STATUS_PROP_ID,
  textRuns,
  todayISO,
  VIEWS_PROP,
  type Anno,
  type Block,
  type MountEntry,
  type PropChoice,
} from '../index.ts'
import { writeBlockContent } from '../model/model.ts'
import { ANNOTATES_PROP } from '../relations/annotates.ts'
import { choicesOf } from '../props/choices.ts'
import { taskStatusVocabulary, TASK_STATUS_LABEL } from './task-vocabulary.ts'
import { getLocale, t } from '../infra/msg.ts'
import type { Workspace } from '../infra/workspace.ts'
import { DEFAULT_DOCK, type DockPrefs } from '../storage/prefs.ts'
import type { DockEntry } from '../views/dock.ts'
import { forest, longParagraph, LONG_EN, mkJournal, mkPage, resolveRefs, resolveSeedTags, SEED_AT } from './build.ts'
import type { SeedBlock } from './inline.ts'
import { SEED_EN, SEED_EN_LONG_PARAGRAPH } from './seed-en.ts'

/* ------------------------------------------------------- 种子文案的 locale 分派 */

/** 中文是默认；英文走整句映射，没翻到的整句原样留下（便于一眼看出漏项）。 */
const s = (zh: string): string => (getLocale() === 'en' ? (SEED_EN[zh] ?? zh) : zh)

/** 迷你 DSL 的正文与标签在种子层完成本地化，之后才交给 build.ts 解析成 run。 */
function localizeSeed(node: SeedBlock): SeedBlock {
  return {
    ...node,
    text: s(node.text),
    tags: node.tags?.map(s),
    children: node.children?.map(localizeSeed),
  }
}

function seedJournal(date: string, seeds: SeedBlock[]) {
  return mkJournal(date, seeds.map(localizeSeed))
}

function seedPage(title: string, icon: string | undefined, seeds: SeedBlock[], id?: string) {
  return id === undefined
    ? mkPage(s(title), icon, seeds.map(localizeSeed))
    : mkPage(s(title), icon, seeds.map(localizeSeed), id)
}

/* --------------------------------------------------------------- 演示种子 */

export function seedWorkspace(): Workspace {
  /* ------------------------------------------------------------ 今日：欢迎与上手 */

  const journal = seedJournal(todayISO(), [
    {
      text: '欢迎来到相 —— 这一屏就是真的编辑面：下面每一行都能改、能拖、能撤销。',
      children: [
        { text: '行尾按 Enter 建下一块，Tab / ⇧Tab 缩进与反缩进；拖行左侧的把手，整段跟着走。' },
        { text: '选中一段字试试 ⌘B 加粗、⌘I 斜体、⌘E 高亮、⌘＋反引号行内代码；划选气泡里还能写备注。' },
        { text: '行首敲 / 呼出插入菜单；⌘P 搜全部命令，⌘K 按关键词找块，记不住快捷键也没关系。' },
        { text: '想把常去的块钉在手边：Shift+点击在侧槽开一扇窗，⌘⌥2 收放右槽。' },
        { text: '界面有中文与英文：⌘, 打开设置就能切，命令、菜单和这份导览会跟着变。' },
      ],
    },
    {
      text: '感兴趣、有疑问，或想找人聊聊？欢迎加入 QQ 群「qua 双链笔记」（群号 1044063116），用 QQ 搜群号就能找到。',
    },
    {
      text: '几个值得先存下的地址：',
      children: [
        // 这几行是**首屏唯一的外链样本**：点一下交给系统浏览器、⌥ 看详情（地址与「打开」）。
        // 显示名留空 ⇒ 显示地址本身，读者一眼看见要去哪；换成「仓库」这种名字就只剩一处可点的字。
        { text: '下载安装包　[](https://github.com/hqweay/qua/releases) （Windows 与 macOS）' },
        { text: '仓库　[](https://github.com/hqweay/qua)' },
        { text: '在线演示　[](https://qua.leay.net/) （数据只落在你自己的浏览器里）' },
        { text: '架构与数据结构　[](https://qua.leay.net/arch.html) （写给想深入了解的人）' },
      ],
    },
    {
      text: '正文里可以直接放图：![[欢迎-示例图.png]] 点图看大图，⌥ 点看图片详情。',
      children: [
        { text: '同一张图贴两次也只存一份（内容寻址）：正文里只记图片的指纹，字节放在图库里。' },
        { text: '图丢了也不炸：![[丢失的截图.png]] 显示成占位，是状态，不是错误。' },
      ],
    },
    {
      text: '正文里的几件东西，形状就是关系：',
      children: [
        // 行内 `[[页]]`：粗体＋淡化的双方括号；Shift+点击在侧槽开窗
        { text: '页引用写成 [[写作示范]]：粗体＋双方括号，点开就过去，不看正文也知道它指向别处。' },
        // 行内 `#名` 是**提及**，不写归属 —— 这是形状语言里最容易被误会的一条
        { text: '正文里打 #功能 是一次提及：占正文一格，但**不会**替你打上标签。' },
        // 归属在行尾：chip 由 `_tags` 决定，删正文里的字不会摘掉它
        { text: '行尾那枚 chip 才是归属：删掉正文里的提及，chip 还在；要摘标签得在检视卡里显式摘。' },
        { text: '带字段的标签，chip 左侧有一枚三角——点开就地填值，不用绕去属性面板。' },
        { text: '还没写的页面也能先引用：[[以后再写的页面]]——它只是悬着，不是坏数据。' },
        { text: '普通块也能取名字：右键一块选「块配置…」加一个别名——之后敲 @ 打这个名字，首行就是它。' },
      ],
    },
    // 值（做没做完）与分类（这块属于任务）分开：值走属性，分类走标签。
    // 今日这一页留一条未完成，左槽那条「今天的待办」查询才不是空结果。
    { text: '把这份欢迎页改成自己的笔记', tags: ['任务', '发布'], task: false },
    { text: '把斜杠菜单和命令面板各试一遍', tags: ['任务', '证据'], task: true },
    ...filler([
      '这一版多了两种行：引述块有七种语气，代码块常显语言徽章——斜杠菜单里都能造。',
      '粘一段 Markdown（标题、列表、引述、代码围栏）会直接变成一组块，而不是一坨纯文本。',
      '块的身体能单独折起来：子块还在，只收住正文那一段。',
      '这一屏全是演示内容，但**真的能改**：关掉重开，改动还在。',
      '屏幕底部那条「今天的待办」是一条查询：自动收集今天还没做完的事。',
      '右槽是检视与反链：选中一块，就能看到谁在引用它、它身上有哪些属性。',
      '左槽「常用」那格是一张收纳盘：小卡收进一张卡，卡头就是把手；拖出来就还原。',
      '左槽「目录」把页、标签、属性、自动化摊成四面：前两面拖块进去就是加一条归属，后两面只读。',
      '反链栏和成员栏的抬头都有「改指向…」：引用指错了目标，选一次整片改过去，⌘Z 一步回。',
      '「自动化」是一块「如果…就…」，左槽「目录 · 自动化」里那条「收尾」就是样本。',
      '任何一块都能配看法：右键一块「视图…」，或点它身体抬头那颗「大纲」——「每周复盘」里的「候选功能」现在就读成表格。',
      '自动化也能圈范围：设成「在某块下面新建子块时」，自动打标签——「候选功能」就是这么把新行喂给功能看板的。',
      '⌘Z 一步回：拆块、合并、格式、拖动都能撤销。',
      '⌘T 回到今日日记；编辑器失焦时 ⌘⌥← / ⌘⌥→ 翻日。',
      '⌘⇧? 查看全部键位——每条命令的键位与生效条件都列在里面。',
    ]),
  ])

  /* ------------------------------------------------------- 过去几天：像一份真实的日记 */

  const yesterday = seedJournal(shiftISO(todayISO(), -1), [
    {
      text: '读《卡片盒笔记法》摘了两段：',
      children: [
        { text: '「笔记的价值在连接，不在收藏。」' },
        { text: '先写下来，再想怎么归档——归档是写完之后的事。' },
      ],
    },
    { text: '把第二段划出来写了条批注：划选一段字，从气泡里选「备注」就行。' },
    ...filler([
      '顺手把两条摘录都挂了标签，找的时候从标签点进去就是。',
      '下午把待读清单整理成了表格：一列状态、一列日期，看着清楚多了。',
      '表格的列名就是属性：拖一列换位置，数据一行没动。',
    ]),
  ])

  const dayBefore = seedJournal(shiftISO(todayISO(), -2), [
    {
      text: '把「想做的事」从日记里挑出来，排成一块看板：',
      children: [
        { text: '拖一张卡到别的列，它的状态就跟着变了——卡片上改的就是数据本身。' },
        { text: '同一批内容还能切成表格、画廊、日历，换个角度读，不用重新整理一遍。' },
      ],
    },
    ...filler([
      '看板上的分组是按「状态」这个属性排的：列不是手工拖出来的顺序，是值。'
      ,
      '看法能自定义：表格挑要显示的栏，排序选「随机」——点刷新换一批顺序，重开这一屏还是原来那份。',
      '没填日期的卡在日历里会去「未填」那一格，不会丢。',
      '今天试着把一条没做完的事留在日记里——左槽「今天的待办」真的把它捞出来了。',
    ]),
  ])

  const day3 = seedJournal(shiftISO(todayISO(), -3), [
    { text: '把最近的读书笔记整成一页：[[写作示范]]。' },
    { text: '引用是活的：那一页改了，这里看到的也是改后的。' },
  ])
  const day4 = seedJournal(shiftISO(todayISO(), -4), [
    { text: '发现删除是可以反悔的：误删的一块在回收站里原样躺着，一键回来。' },
    { text: '于是开始放心大胆地整理了。' },
  ])
  const day5 = seedJournal(shiftISO(todayISO(), -5), [
    { text: '开始用相记日记：默认落点就是今天，不用先找页面。' },
    { text: '往下滚就是更早的日子，日记流是完整的。' },
  ])

  /* -------------------------------------------------------------- 页：欢迎 / 写作 / 复盘 */

  const p1 = seedPage('欢迎使用相', 'lucide:hand-heart', [
    {
      text: '相把每一段内容都当**块**：一行字可以打标签、加属性、被引用到任何地方。',
      children: [
        { text: '页、日记、标签、视图都不是独立的实体，只是块在不同位置的呈现。' },
        {
          text: '页名和正文是两件事：名字住在地址里（首个别名），下面这些行是它的描述——改正文不改名字。',
          // 这两层是**给降级验收用的**：缩进、折叠、虚拟化都要有「更深一层」可量。
          children: [
            { text: '层级可以一直往深里写。', children: [{ text: '面包屑、引用、反链都认得路。' }] },
          ],
        },
        { text: '删除是可恢复的：删掉的块进回收站，随时原样找回来。' },
      ],
    },
    {
      text: '同一块内容可以出现在多处：',
      children: [
        { text: '[[写作示范]] 里有两行引用着这一页——在右槽的「反链」里能看到谁引用了你。' },
        { text: '还没写的页面也能先引用：[[这份页面还没写]]——它只是悬着，不是坏数据。' },
        { text: '引用不是拷贝：源头变了，引用处看到的就是新的。' },
      ],
    },
    { text: '关于这份演示内容：处处都可以改；新建一个库时，拿到的也是这样一份内容。' },
    // 待办样本：这一页恰好一条未完成，页底那条查询才稳定只有 1 行结果。
    { text: '把这份欢迎页改成自己的样子', tags: ['任务'], task: false },
    { text: '今天记满一页日记', tags: ['任务', '证据'], task: true },
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
    // 最后是**镜像样本**：宿主块在装配段构造（要指向 p3 的「下一步」，那时 id 才存在）。
    { text: '最后一行是镜像示例：内容源头在 [[每周复盘]] 的「下一步」——在这里改，源头跟着变。' },
  ])

  const p2 = seedPage('写作示范', 'lucide:pen-line', [
    {
      text: '行内的一切都是完整的单元：引用、提及、图片、外链，增删不会伤到旁边的字。',
      children: [
        // 粘贴纯网址自动成链的样本：一行里只有地址，读起来就是要去哪
        { text: '粘贴一个纯网址会自动变成链接：https://github.com/hqweay/qua' },
        { text: '一张行内图片：![[写作-示例图.png]] 行高不变，点图放大，⌥ 点看详情。' },
        { text: '缺字节的图是「占位」不是错误：![[丢失的截图.png]] 它后面的字照样能编辑。' },
      ],
    },
    // 这两行是**反链计数与面包屑的钉子**：引用行必须是页的直接子块（面包屑只有一层页名），
    // 嵌进子块里就会出现两层面包屑、T117 的定位器数到两枚。
    // ⚠️ 表格试金石（T152 换行编辑）按内容挑**纯文本**行：行里带原子时，点下去会开大图
    //    或导航走人（那是原子的正常行为），量到的就不再是「换行编辑」。
    { text: '一段带四种格式的句子：**加粗的结论**、*斜体的限定*、==高亮的关键词==、`行内代码`。' },
    { text: '标记顺序不能错：==先高亮== 再 **后加粗**，两个区间都得落在自己那几个字上。' },
    // **引述块**是行容器：抬头只画变体（正文只读），每一行是独立子块 ⇒ 可单独引用
    { text: '引述是行容器：抬头只画语气，每一行都是独立的块，能单独引用。' },
    {
      text: '',
      props: { _type: QUOTE_TYPE, [CALLOUT_PROP]: 'tip' },
      children: [
        { text: '这一行有自己的 id——行尾写引用，就能跳回这一行本身。' },
        { text: '点抬头换语气：引述／信息／警告／错误／提示／重要／注意。' },
      ],
    },
    {
      text: '',
      props: { _type: QUOTE_TYPE, [CALLOUT_PROP]: 'warning' },
      children: [{ text: '变体是值，不是另一个类型：查询可以按「引述类型」把警告筛出来。' }],
    },
    // **代码块**的正文住在 `_code`（身体），这一行是标题；标题行尾常显语言徽章
    { text: '代码块把语言写在徽章上，点它就能换；59 门有语法，可搜。' },
    {
      text: '一段代码',
      props: {
        _type: CODE_TYPE,
        _lang: 'ts',
        [CODE_TEXT_PROP]: 'const block = { id, content, children }\n// 行是块，代码是身体；标题行上的徽章说的就是这门语言\n',
      },
    },
    { text: '这一页引用了 [[欢迎使用相]]——那一页右槽的「反链」里，来源就是这一页。' },
    { text: '一行里混着引用与图片也能继续打字：[[欢迎使用相]] ![[写作-第二张.png]]' },
    { text: s('降级样本 · 超长块：') + (getLocale() === 'en' ? SEED_EN_LONG_PARAGRAPH : longParagraph()) },
    { text: s('降级样本 · 全英文长行（不该溢出容器）：') + LONG_EN },
    // 归属是**块级**的一格：正文里不出现 `#写作`，chip 仍在行尾——删字不摘标签
    { text: '标签写在正文之外：这一页打了个标签，归属落在行尾 chip 上，正文一个字没动。', tags: ['写作'] },
    { text: '备注是写在字上的批注：下面这句话带了一枚示例备注——选中一段字，从划选气泡里选「备注」就能做到。' },
    // 这一行是**备注宿主**：装配段给它挂上区间锚，顶层那枚示例备注块指向它
    { text: '第一次见面就能在字上写批注。' },
    // **算作**样本：下面这行会被 appendEdge 到 p3 的「下一步」下（装配段做，那时父块 id 才存在）。
    { text: '同一块、两处算作：下面这行笔记同时算作 [[每周复盘]]「下一步」的一员——只多一条归属边，内容没有搬。' },
    { text: '把内容搬去别的库之前：先备份原始字节，再动结构。' },
    // 确定性 id：演示盘（`seedDock()`）的快捷卡按 id 指到这一页——建库与设备状态分开调用，id 必须两边一致
  ], SEED_INPUT_NOTES_ID)

  const p3 = seedPage('每周复盘', 'lucide:notebook-pen', [
    {
      text: '每周一页：这周做了什么、卡在哪、下周做什么。',
      children: [
        { text: '日记是流水，复盘是挑选：值得继续推进的事，进「下一步」。' },
        { text: '「下一步」的行头带着状态值（在行头直接改）——这是挂在行头上的属性。' },
      ],
    },
    {
      text: '下一步',
      // **子块行头属性**的演示：父块声明 `_childProps`，直接子块行头显示这一栏的值。
      props: { [CHILD_PROPS_PROP]: [FEATURE_STATUS_PROP_ID] },
      children: [
        {
          text: '邀请几位朋友试用 beta，收集第一轮反馈。',
          props: { [FEATURE_STATUS_PROP_ID]: FEATURE_STATUS_EXPLORING_ID },
        },
        {
          text: '安装包签名与自动更新。',
          props: { [FEATURE_STATUS_PROP_ID]: FEATURE_STATUS_EXPLORING_ID },
        },
        {
          text: '图库管理：图片多起来之后再想。',
          props: { [FEATURE_STATUS_PROP_ID]: FEATURE_STATUS_SHELVED_ID },
        },
      ],
    },
    // **视图配置 ＋ 事件自动化**两份样本都挂在**普通容器块**上（不是查询块）：
    //   ① 一块怎么读是它的**配置**（`_views` 挂在谁身上都行），不是它的类型；
    //   ② 触发器可以圈**父块**（`{up:{is}}`）——在这块下新建的每一行，出生就被打上「功能」标签。
    // 两件事共用这一块，是因为它们在这一块上互相解释：新行进来即成为「功能」实例，表格与看板读的是同一批值。
    { text: '「候选功能」这一块读成表格：普通容器也能配看法——一块怎么读是它的配置，不是它的类型。' },
    {
      text: '候选功能',
      props: {
        [VIEWS_PROP]: [
          {
            id: SEED_BACKLOG_VIEW_ID,
            name: s('表格'),
            kind: 'table',
            // 露出哪一栏也是配置：挑「功能状态」，于是这些行与功能看板读同一批值
            displayProps: [FEATURE_STATUS_PROP_ID],
          },
        ],
        [ACTIVE_VIEW_PROP]: SEED_BACKLOG_VIEW_ID,
      },
      children: [
        {
          text: '导入 Markdown 笔记',
          tags: ['功能'],
          props: { [FEATURE_STATUS_PROP_ID]: FEATURE_STATUS_EXPLORING_ID },
        },
        // 不填状态：缺省从定义上读出「探索中」，表格里照样有这一栏
        { text: 'PDF 批注', tags: ['功能'] },
      ],
    },
    // **同一批子块，换个看法**：导图不另存一份内容，它就是「把子块摊成一张图」。
    // 四根分支（两根各带两个孩子）是故意留出的第二层：导图的价值在层级，不在单层的扇面。
    { text: '「功能地图」这一块读成思维导图：根在中间、子块是分支——换看法不重排内容。' },
    {
      text: '功能地图',
      props: {
        [VIEWS_PROP]: [{ id: SEED_MAP_VIEW_ID, name: s('思维导图'), kind: 'mindmap', mindmap: { direction: 'both' } }],
        [ACTIVE_VIEW_PROP]: SEED_MAP_VIEW_ID,
      },
      children: [
        { text: '写', children: [{ text: '块树与行内原子' }, { text: '备注与颜色' }] },
        { text: '组织', children: [{ text: '标签与属性' }, { text: '镜像与引用' }] },
        { text: '读', children: [{ text: '七种看法' }] },
        { text: '找', children: [{ text: '搜索与命令面板' }] },
      ],
    },
    { text: '在这块下面新建的每一行都会自动打上「功能」标签——左槽「目录 · 自动化」里那条规则就是干这个的。' },
    { text: '把这一页拖进左槽就能开一扇常驻的窗——常去的页面都值得这样放。' },
    { text: '复盘只写「变了什么、为什么」，不抄流水账。', tags: ['复盘'] },
  ])

  const p4 = seedPage(
    'How I Learned to Stop Worrying and Love the Block-Based Document Model in Personal Knowledge Tools',
    'lucide:book-open',
    [
      { text: '超长标题的降级：面包屑、左槽、引用选择器三处都要能截断而不破版' },
      { text: 'English-only page. **Anchors** carry a `blockId`; a *quote snapshot* can relocate them later.' },
    ],
  )

  const p5 = seedPage('', undefined, [
    { text: '无标题页：左槽、面包屑、引用 chip 都要有兜底文案' },
    { text: '引用一个无标题页：[[ ]]' },
  ])
  if (getLocale() === 'en') {
    const alias = (p5.page.props?.[ALIASES_PROP] as string[] | undefined)?.[0] ?? ''
    if (alias.startsWith('未命名-')) {
      p5.page.props = { ...p5.page.props, [ALIASES_PROP]: [`Untitled-${alias.slice(-6)}`] }
    }
  }

  const built = [journal, yesterday, dayBefore, day3, day4, day5, p1, p2, p3, p4, p5]
  const blocks = built.map((b) => b.page)

  /**
   * **全部页面**＝一个查询块。要「所有页在一处看」的工作台，造的是**条件**（`role:'page'`
   * 问的就是「页」这份身份判据），不是第二个目录实体——列表本身能排序能切片，因为它是查询。
   */
  const allPages = mkQueryBlock({ name: s('全部页面'), spec: { where: { role: 'page' } }, icon: 'lucide:list' })
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
    name: s('功能看板'),
    spec: { where: { tag: s(FEATURE_TAG_LABEL) } },
    views: [
      {
        id: 'seed-kanban',
        name: s('看板'),
        kind: 'cards',
        // 看板＝卡片按值分列：组按选项 id 实时导出，呈现顺序钉成声明序
        groupBy: FEATURE_STATUS_PROP_ID,
        groupOrder: [FEATURE_STATUS_EXPLORING_ID, FEATURE_STATUS_SHIPPED_ID, FEATURE_STATUS_SHELVED_ID],
      },
      {
        id: 'seed-table',
        name: s('表格'),
        kind: 'table',
        displayProps: [FEATURE_STATUS_PROP_ID, FEATURE_DATE_PROP_ID],
      },
      { id: 'seed-gallery', name: s('画廊'), kind: 'cards' },
      {
        id: 'seed-calendar',
        name: s('日历'),
        kind: 'calendar',
        calendar: { dateBy: FEATURE_DATE_PROP_ID, showUndated: true },
      },
    ],
    activeView: 'seed-kanban',
  })
  featureBoard.created = SEED_AT
  featureBoard.modified = SEED_AT
  // 同「写作示范」：演示盘的快捷卡按 id 指到这块（确定性 id，见顶部常量）
  featureBoard.id = SEED_FEATURE_BOARD_ID

  // 核心词汇（定义块 ＋ 标签块）先在森林顶层就位：`ensureTag` 要能找到 `任务` 并复用，
  // 否则种子会建出第二个同名标签；`[[ ]]` 与 `#标签` 的解析也要在这之后（标签同样占地址）。
  const vocab = coreVocabulary()
  blocks.push(...vocab.blocks)

  // 自动化样本：一块「如果…就…」——「目录 · 自动化」那一面不是空的，定义体也能直接摸。
  // 手动触发 ⇒ 只在人点「运行…」时跑；`when` 自己圈目标（这块得是「任务」）。
  const automation = mkAutomationBlock({
    name: s('收尾：把这块标成完成'),
    icon: 'lucide:zap',
    def: {
      enabled: true,
      triggers: ['manual'],
      when: { tag: vocab.taskTagId },
      steps: [
        { cmd: 'core.props/set-value', args: { propId: TASK_STATUS_PROP_ID, value: TASK_STATUS_DONE_ID } },
      ],
    },
  })
  automation.created = SEED_AT
  automation.modified = SEED_AT
  blocks.push(automation)

  // 标签归属先落成 id（新标签块会在这时进森林），再解析 `[[ ]]` 与 `#标签`
  resolveSeedTags(blocks, built.flatMap((b) => b.pendingTags))
  resolveRefs(blocks, built)

  // 实例样本：条数与值的分布开——看板每一列有卡、日历有落点、缺省值有一条没填的样本
  blocks.push(...featureInstances(vocab.featureTagId))
  blocks.push(featureBoard)

  /* ---------------------------------------------- 要拿到已建块 id 才能写的样本 */

  /**
   * **新子块自动打标签**：一条事件自动化，范围圈在「候选功能」这一块上——
   * 在它下面新建的每一行，诞生那一刻就被打上「功能」标签（于是当场进功能看板）。
   *
   * 为什么住在装配段：触发器要写**父块 id**，而那个 id 只有页建完才有（与镜像、备注同层）。
   * `birth: true` ＋ `{up:{is}}` 是「在某一块下面新建子块时」的唯一合法形状——
   * `up` 是诞生时刻对容纳链的一次性判定，白名单见 `automation/trigger-query.ts`。
   */
  const backlog = childByPlain(p3.page, s('候选功能'))
  if (backlog) {
    const auto = mkAutomationBlock({
      name: s('候选功能：新行自动带上「功能」'),
      icon: 'lucide:zap',
      def: {
        enabled: true,
        triggers: [{ on: 'entered', birth: true, query: { up: { is: backlog.id } } }],
        // 步骤里存**标签 id**（名字会漂，id 不漂）：与所有引用同一条纪律
        steps: [{ cmd: 'core.tags/add', args: { tagId: vocab.featureTagId } }],
      },
    })
    auto.created = SEED_AT
    auto.modified = SEED_AT
    blocks.push(auto)
  }

  const nextStep = childByPlain(p3.page, s('下一步'))
  // 镜像：p1 的宿主块指向 p3 的「下一步」（`view:''` ＝ 跟随源块的默认看法）
  if (nextStep) {
    const mirror = mkBlock(textRuns(s('「下一步」的镜像')), {
      props: { _embed: { block: nextStep.id, view: '' } },
      created: SEED_AT,
      modified: SEED_AT,
    })
    p1.page.children.push(mirror)
    // 算作：p2 的迁移笔记同时算作「下一步」的一员——多一条父边，树没有搬
    const migrationNote = childByPlain(p2.page, s('把内容搬去别的库之前'))
    if (migrationNote) appendEdge(migrationNote, nextStep)
  }

  // **备注样本**：宿主是 p2 里那句话，顶层一枚备注块指向它身上的区间锚。
  // 锚的 id 用确定性 id：装配段的指向槽要拿到同一个 id（建块与指向分两步写）。
  const annotated = childByPlain(p2.page, s('第一次见面'))
  if (annotated) {
    const quote = s('第一次见面')
    const anno: Anno = {
      id: SEED_NOTE_ANNO_ID,
      range: { start: 0, end: quote.length },
      quote: { exact: quote, prefix: '', suffix: s('就能在字上写批注。') },
    }
    annotated.annos = [anno]
    const note = mkBlock(textRuns(s('示例备注：批注跟着字走——字改了，它还认得自己标的是哪段。')), {
      props: { [ANNOTATES_PROP]: [{ block: annotated.id, anno: anno.id }] },
      created: SEED_AT,
      modified: SEED_AT,
    })
    blocks.push(note)
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

/** 示例备注的区间锚 id：宿主上的锚与备注块的指向槽必须拿到同一个（见装配段） */
export const SEED_NOTE_ANNO_ID = derivedId('anno', 'seed/welcome-note')

/**
 * 收纳盘的快捷卡要**指向种子刚建出来的块**，而盘住在设备状态里、与建库分开调用 ——
 * 两边必须拿到同一个 id ⇒ 这几块用确定性 id（与属性定义同一条纪律）。
 * 指针按 id 存，id 稳定 ⇒ 盘里的快捷卡不会因重种而悬空。
 */
export const SEED_FEATURE_BOARD_ID = derivedId('block', 'seed/feature-board')
export const SEED_INPUT_NOTES_ID = derivedId('block', 'seed/input-notes')
/** 「候选功能」那张表格看法的 id：块上的 `_activeView` 与 `_views[]` 要拿到同一个 */
export const SEED_BACKLOG_VIEW_ID = 'seed-backlog-table'
/** 「功能地图」那张思维导图看法的 id（同样要 `_views[]` 与 `_activeView` 对齐） */
export const SEED_MAP_VIEW_ID = 'seed-functional-map'
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
  // 选项是**定义块上的记录**（`_choices`）：不进森林，数组序＝选项序
  const statusDef = mkPropDef(
    s(FEATURE_STATUS_LABEL),
    'select',
    // 缺省值住在定义上：实例没填这一栏时，面板读出来的就是它
    { [DEFAULT_PROP]: FEATURE_STATUS_EXPLORING_ID },
    FEATURE_STATUS_PROP_ID,
  )
  const choice = (label: string, id: string, icon: string): PropChoice => ({
    id,
    label,
    icon: `lucide:${icon}`,
  })
  setChoices(statusDef, [
    choice(s('探索中'), FEATURE_STATUS_EXPLORING_ID, 'loader-circle'),
    choice(s('已落地'), FEATURE_STATUS_SHIPPED_ID, 'circle-check'),
    choice(s('搁置'), FEATURE_STATUS_SHELVED_ID, 'minus'),
  ])
  const dateDef = mkPropDef(s(FEATURE_DATE_LABEL), 'date', {}, FEATURE_DATE_PROP_ID)
  const tag = mkTagBlock(s(FEATURE_TAG_LABEL))
  tag.props = { ...(tag.props ?? {}), _icon: 'lucide:sliders-horizontal' }
  declareField(tag, FEATURE_STATUS_PROP_ID)
  declareField(tag, FEATURE_DATE_PROP_ID)
  // 同一个固定时刻：留 `Date.now()` 会让种子每次重开都跟别的内容差一年
  for (const b of [statusDef, dateDef, tag]) {
    b.created = SEED_AT
    b.modified = SEED_AT
  }
  return { blocks: [statusDef, dateDef, tag], tagId: tag.id }
}

/**
 * 实例样本：**一条普通的内容块**，靠 `props._tags` 归属在「功能」下——没有新实体。
 *
 * 内容是自指的：这几条就是相自己的功能清单，随阶段翻新。值的分布是刻意的：
 * 已落地的带日期（日历有落点）、「定时提醒」不填状态（缺省读出「探索中」，看板的
 * 「未设置」列也要有一条撑着）、探索与搁置各有一条（看板每一列都有卡）。
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
    record(s('命令面板'), FEATURE_STATUS_SHIPPED_ID, '2026-09-30'),
    record(s('行内图片'), FEATURE_STATUS_SHIPPED_ID, '2026-10-27'),
    record(s('多库与库根'), FEATURE_STATUS_SHIPPED_ID, '2026-11-05'),
    record(s('快速筛选'), FEATURE_STATUS_SHIPPED_ID, '2026-11-05'),
    record(s('回收站'), FEATURE_STATUS_SHIPPED_ID, '2026-11-09'),
    record(s('备注'), FEATURE_STATUS_SHIPPED_ID, '2026-11-13'),
    record(s('查询镜头'), FEATURE_STATUS_SHIPPED_ID, '2026-11-14'),
    record(s('多值与附件'), FEATURE_STATUS_SHIPPED_ID, '2026-11-15'),
    record(s('块取名'), FEATURE_STATUS_SHIPPED_ID, '2026-11-18'),
    record(s('视图显示与排序'), FEATURE_STATUS_SHIPPED_ID, '2026-11-19'),
    record(s('大文档秒开'), FEATURE_STATUS_SHIPPED_ID, '2026-11-20'),
    record(s('行内形状语言'), FEATURE_STATUS_SHIPPED_ID, '2026-11-22'),
    record(s('字段入口三面共用'), FEATURE_STATUS_SHIPPED_ID, '2026-11-22'),
    record(s('自动化'), FEATURE_STATUS_SHIPPED_ID, '2026-11-21'),
    record(s('目录四面'), FEATURE_STATUS_SHIPPED_ID, '2026-11-22'),
    record(s('改指向'), FEATURE_STATUS_SHIPPED_ID, '2026-11-22'),
    record(s('删除收口'), FEATURE_STATUS_SHIPPED_ID, '2026-11-22'),
    record(s('中英界面'), FEATURE_STATUS_SHIPPED_ID, '2026-11-22'),
    record(s('新版提示'), FEATURE_STATUS_SHIPPED_ID, '2026-11-22'),
    record(s('任何块都能配看法'), FEATURE_STATUS_SHIPPED_ID, '2026-11-22'),
    record(s('新子块自动打标签'), FEATURE_STATUS_SHIPPED_ID, '2026-11-22'),
    record(s('引述块'), FEATURE_STATUS_SHIPPED_ID, '2026-11-27'),
    record(s('代码块'), FEATURE_STATUS_SHIPPED_ID, '2026-11-26'),
    record(s('粘贴 Markdown'), FEATURE_STATUS_SHIPPED_ID, '2026-11-26'),
    record(s('正文折叠'), FEATURE_STATUS_SHIPPED_ID, '2026-11-26'),
    record(s('块窗口'), FEATURE_STATUS_SHIPPED_ID, '2026-11-25'),
    record(s('新建页先问名字'), FEATURE_STATUS_SHIPPED_ID, '2026-11-25'),
    record(s('引用某一段'), FEATURE_STATUS_EXPLORING_ID),
    record(s('定时提醒')),
    record(s('图库管理'), FEATURE_STATUS_SHELVED_ID),
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
 * （功能看板 ＝ 属性/实例/看法的样本，写作示范 ＝ 行内内容的样本）——
 * 访客点一颗就从槽里进了产品叙事。
 *
 * 与 `seedJournalMounts` 同层：槽布局是设备状态（`storage/device.ts`「跟库走」的四格之一），
 * 只在「这一份库是刚种出来的」时给（`main.ts` 启动段），已有库不自动改布局。
 * ⚠️ 盘一进初始状态，checks 里「左槽唯一一只盘」「首匹配 `^="tray:"`」的假设就多了一只 ——
 *    动这里（或默认槽布局）前先盘点 smoke/dock-smoke 的初始布局钉子，改写按捕获 key 精确认。
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

function coreVocabulary(): { blocks: Block[]; taskTagId: string; featureTagId: string } {
  // 定义块与选项从 core 的构造器来：种子与写路径的按需物化共用同一份形状，
  // 两边各造一份就会漂移（种子有的选项、按需物化的没有，查询就分叉）。
  // 选项 id 仍是核心词汇的**确定性 id**（`closureOf`／⌘↵／种子查询按 id 认「完成」）。
  const taskStatus = taskStatusVocabulary()
  if (getLocale() === 'en') {
    writeBlockContent(taskStatus, textRuns(s(TASK_STATUS_LABEL)))
    setChoices(taskStatus, choicesOf(taskStatus).map((c) => ({ ...c, label: s(c.label) })))
  }
  const task = mkTagBlock(s(TASK_TAG_LABEL))
  task.props = { ...(task.props ?? {}), _icon: 'lucide:check-square' }
  declareField(task, TASK_STATUS_PROP_ID)
  // 「功能」词汇只有种子这一个使用者（见 `featureVocabulary` 的注释），时刻由它自己盖
  const feature = featureVocabulary()
  // 它们也是**种子内容**（会进库、会导出）⇒ 与其它种子同一个固定时刻：
  // 留 `Date.now()` 会让这些块每次 seed 都跟别的内容差一年，而它们本该是同一份快照。
  for (const b of [taskStatus, task]) {
    b.created = SEED_AT
    b.modified = SEED_AT
  }
  return { blocks: [taskStatus, task, ...feature.blocks], taskTagId: task.id, featureTagId: feature.tagId }
}
