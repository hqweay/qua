/**
 * 演示种子的英文文案表 —— `seed.ts` 里每个用户可见的中文整句都在这里有一条对应。
 *
 * 只做**整句映射**：`[[引用]]`、`![[图片.png]]`、`[](url)`、`#标签`、`**粗**` 等
 * 行内语法原样保留（名字按同一条规则翻译，保证引用与页名对得上）；资产文件名、
 * 网址、id、图标名不翻译。中文是默认语言，取不到映射时 `s()` 原样返回中文。
 */
export const SEED_EN: Record<string, string> = {
  /* ------------------------------------------------------------ 今日：欢迎与上手 */
  '欢迎来到相 —— 这一屏就是真的编辑面：下面每一行都能改、能拖、能撤销。':
    'Welcome to Qua — this screen is the real editor: every line below can be edited, dragged, and undone.',
  '行尾按 Enter 建下一块，Tab / ⇧Tab 缩进与反缩进；拖行左侧的把手，整段跟着走。':
    'Press Enter at the end of a line to create the next block; Tab / ⇧Tab indent and outdent. Drag the handle to the left of a row and the whole subtree comes along.',
  '选中一段字试试 ⌘B 加粗、⌘I 斜体、⌘E 高亮、⌘＋反引号行内代码；划选气泡里还能写备注。':
    'Select some text and try ⌘B for bold, ⌘I for italic, ⌘E for highlight, ⌘ + backtick for inline code; the selection bubble can also add a note.',
  '行首敲 / 呼出插入菜单；⌘P 搜全部命令，⌘K 按关键词找块，记不住快捷键也没关系。':
    'Type / at the start of a line to open the insert menu; ⌘P searches all commands and ⌘K finds blocks by keyword — no need to memorize shortcuts.',
  '想把常去的块钉在手边：Shift+点击在侧槽开一扇窗，⌘⌥2 收放右槽。':
    'Keep the blocks you visit often close by: Shift-click to open one in a side panel, ⌘⌥2 to toggle the right panel.',
  '感兴趣、有疑问，或想找人聊聊？欢迎加入 QQ 群「qua 双链笔记」（群号 1044063116），用 QQ 搜群号就能找到。':
    'Curious, stuck, or just want to chat? Join the QQ group "Qua Linked Notes" (group ID 1044063116) — search the ID in QQ to find it.',
  '几个值得先存下的地址：': 'A few links worth bookmarking:',
  '下载安装包　[](https://github.com/hqweay/qua/releases) （Windows 与 macOS）':
    'Download the installer: [](https://github.com/hqweay/qua/releases) (Windows and macOS)',
  '仓库　[](https://github.com/hqweay/qua)': 'Repository: [](https://github.com/hqweay/qua)',
  '在线演示　[](https://qua.leay.net/) （数据只落在你自己的浏览器里）':
    'Live demo: [](https://qua.leay.net/) (your data stays in your own browser)',
  '架构与数据结构　[](https://qua.leay.net/arch.html) （写给想深入了解的人）':
    'Architecture and data model: [](https://qua.leay.net/arch.html) (for the curious)',
  '正文里可以直接放图：![[欢迎-示例图.png]] 点图看大图，⌥ 点看图片详情。':
    'You can put images right in the text: ![[欢迎-示例图.png]] click to enlarge, ⌥-click for image details.',
  '同一张图贴两次也只存一份（内容寻址）：正文里只记图片的指纹，字节放在图库里。':
    'Paste the same image twice and it is stored once (content addressing): the text keeps only a fingerprint; the bytes live in the asset library.',
  '图丢了也不炸：![[丢失的截图.png]] 显示成占位，是状态，不是错误。':
    'A missing image is not a crash: ![[丢失的截图.png]] shows a placeholder — a state, not an error.',
  '正文里的几件东西，形状就是关系：': 'In the text, shape carries meaning:',
  '页引用写成 [[写作示范]]：粗体＋双方括号，点开就过去，不看正文也知道它指向别处。':
    'A page reference looks like [[Writing Samples]]: bold with double brackets; click to go there, and you can tell it points elsewhere without reading the text.',
  '正文里打 #功能 是一次提及：占正文一格，但**不会**替你打上标签。':
    'Typing #Feature in the text is a mention: it takes a slot in the line but **will not** tag the block for you.',
  '行尾那枚 chip 才是归属：删掉正文里的提及，chip 还在；要摘标签得在检视卡里显式摘。':
    'The chip at the end of the line is the real membership: delete the mention in the text and the chip stays; remove the tag explicitly in the inspector.',
  '带字段的标签，chip 左侧有一枚三角——点开就地填值，不用绕去属性面板。':
    'A tag with fields has a little triangle on the left of its chip — open it to fill in values right there, no detour to the properties panel.',
  '还没写的页面也能先引用：[[以后再写的页面]]——它只是悬着，不是坏数据。':
    'You can reference a page before writing it: [[A Page to Write Later]] — it is just dangling, not broken data.',
  '普通块也能取名字：右键一块选「块配置…」加一个别名——之后敲 @ 打这个名字，首行就是它。':
    'Any block can have a name: right-click and choose "Block config…" to add an alias — then type @ and that name, and the first line matches it.',
  '把这份欢迎页改成自己的笔记': 'Turn this welcome page into your own note',
  '把斜杠菜单和命令面板各试一遍': 'Try the slash menu and the command palette once each',
  '任务': 'Task',
  '发布': 'Publish',
  '证据': 'Evidence',
  '这一屏全是演示内容，但**真的能改**：关掉重开，改动还在。':
    'This whole screen is demo content, but **you can really edit it**: close and reopen, and your changes are still there.',
  '屏幕底部那条「今天的待办」是一条查询：自动收集今天还没做完的事。':
    'The "Today\'s To-dos" strip at the bottom is a query: it automatically collects what is still open today.',
  '右槽是检视与反链：选中一块，就能看到谁在引用它、它身上有哪些属性。':
    'The right panel is the inspector and backlinks: select a block to see who references it and which properties it carries.',
  '左槽「常用」那格是一张收纳盘：小卡收进一张卡，卡头就是把手；拖出来就还原。':
    'The "Favorites" slot in the left panel is a tray: shortcuts grouped into one card, with the header as its handle; drag one out to restore it.',
  '⌘Z 一步回：拆块、合并、格式、拖动都能撤销。':
    '⌘Z steps back: splitting, merging, formatting, and dragging are all undoable.',
  '⌘T 回到今日日记；编辑器失焦时 ⌘⌥← / ⌘⌥→ 翻日。':
    '⌘T returns to today\'s journal; when the editor is unfocused, ⌘⌥← / ⌘⌥→ flip through days.',
  '⌘⇧? 查看全部键位——每条命令的键位与生效条件都列在里面。':
    '⌘⇧? shows all keybindings — every command lists its shortcut and when it applies.',

  /* ---------------------------------------------------- 过去几天：像一份真实的日记 */
  '读《卡片盒笔记法》摘了两段：': 'Two passages from How to Take Smart Notes:',
  '「笔记的价值在连接，不在收藏。」': '"The value of a note lies in its connections, not in collecting it."',
  '先写下来，再想怎么归档——归档是写完之后的事。':
    'Write it down first, then think about filing — filing comes after writing.',
  '把第二段划出来写了条批注：划选一段字，从气泡里选「备注」就行。':
    'Highlighted the second passage and added a note: select some text and choose "Note" from the bubble.',
  '顺手把两条摘录都挂了标签，找的时候从标签点进去就是。':
    'Tagged both quotes while I was here — just click a tag to find them later.',
  '下午把待读清单整理成了表格：一列状态、一列日期，看着清楚多了。':
    'In the afternoon I turned the reading list into a table: one column for status, one for date — much easier to scan.',
  '表格的列名就是属性：拖一列换位置，数据一行没动。':
    'Table column names are properties: drag a column to reorder it, and not a single row of data moves.',
  '把「想做的事」从日记里挑出来，排成一块看板：':
    'Pulled the "things I want to do" out of the journal and arranged them on a board:',
  '拖一张卡到别的列，它的状态就跟着变了——卡片上改的就是数据本身。':
    'Drag a card to another column and its status changes — the card edits the data itself.',
  '同一批内容还能切成表格、画廊、日历，换个角度读，不用重新整理一遍。':
    'The same content can also be viewed as a table, gallery, or calendar — a new angle without reorganizing anything.',
  '看板上的分组是按「状态」这个属性排的：列不是手工拖出来的顺序，是值。':
    'Board groups come from the "Status" property: the columns are values, not a hand-dragged order.',
  '看法能自定义：表格挑要显示的栏，排序选「随机」——点刷新换一批顺序，重开这一屏还是原来那份。':
    'Views are configurable: pick which columns a table shows, or set sorting to "Random" — refresh to reshuffle, and reopening this screen restores the same view.',
  '没填日期的卡在日历里会去「未填」那一格，不会丢。':
    'Cards without a date land in the "Undated" bucket on the calendar — nothing gets lost.',
  '今天试着把一条没做完的事留在日记里——左槽「今天的待办」真的把它捞出来了。':
    'I left one unfinished task in today\'s journal — and "Today\'s To-dos" in the left panel actually picked it up.',
  '把最近的读书笔记整成一页：[[写作示范]]。': 'Pulled my recent reading notes into a page: [[Writing Samples]].',
  '引用是活的：那一页改了，这里看到的也是改后的。':
    'References are live: edit that page and what you see here updates too.',
  '发现删除是可以反悔的：误删的一块在回收站里原样躺着，一键回来。':
    'Discovered that deletion is reversible: an accidentally deleted block sits in the trash exactly as it was, one click to restore.',
  '于是开始放心大胆地整理了。': 'So I started organizing without hesitation.',
  '开始用相记日记：默认落点就是今天，不用先找页面。':
    'Started journaling in Qua: it opens on today by default, no page hunting required.',
  '往下滚就是更早的日子，日记流是完整的。': 'Scroll down for earlier days — the journal stream is continuous.',

  /* -------------------------------------------------------------- 页：欢迎 / 写作 / 复盘 */
  '欢迎使用相': 'Welcome to Qua',
  '相把每一段内容都当**块**：一行字可以打标签、加属性、被引用到任何地方。':
    'Qua treats every piece of content as a **block**: a line can be tagged, given properties, and referenced anywhere.',
  '页、日记、标签、视图都不是独立的实体，只是块在不同位置的呈现。':
    'Pages, journals, tags, and views are not separate entities — just blocks presented in different places.',
  '页名和正文是两件事：名字住在地址里（首个别名），下面这些行是它的描述——改正文不改名字。':
    'The page title and its body are two different things: the name lives in the address (the first alias), while the lines below are its description — editing the body does not rename it.',
  '层级可以一直往深里写。': 'You can nest as deep as you like.',
  '面包屑、引用、反链都认得路。': 'Breadcrumbs, references, and backlinks all know the way.',
  '删除是可恢复的：删掉的块进回收站，随时原样找回来。':
    'Deletion is recoverable: deleted blocks go to the trash and can be restored intact whenever you like.',
  '同一块内容可以出现在多处：': 'The same content can appear in multiple places:',
  '[[写作示范]] 里有两行引用着这一页——在右槽的「反链」里能看到谁引用了你。':
    '[[Writing Samples]] has two lines referencing this page — the "Backlinks" panel on the right shows who linked here.',
  '还没写的页面也能先引用：[[这份页面还没写]]——它只是悬着，不是坏数据。':
    'You can reference a page that does not exist yet: [[This Page Isn\'t Written Yet]] — it is just dangling, not broken data.',
  '引用不是拷贝：源头变了，引用处看到的就是新的。':
    'A reference is not a copy: change the source and every reference shows the new text.',
  '关于这份演示内容：处处都可以改；新建一个库时，拿到的也是这样一份内容。':
    'About this demo content: you can edit anything here; a newly created library starts with just this kind of content.',
  '把这份欢迎页改成自己的样子': 'Make this welcome page your own',
  '今天记满一页日记': 'Fill a page of journal entries today',
  '本页的待办': 'To-dos on This Page',
  '最后一行是镜像示例：内容源头在 [[每周复盘]] 的「下一步」——在这里改，源头跟着变。':
    'The last line is a mirror: its source is "Next Steps" on [[Weekly Review]] — edit it here and the source follows.',

  '写作示范': 'Writing Samples',
  '行内的一切都是完整的单元：引用、提及、图片、外链，增删不会伤到旁边的字。':
    'Everything inline is a complete unit: references, mentions, images, and links — adding or removing one never damages the text beside it.',
  '粘贴一个纯网址会自动变成链接：https://github.com/hqweay/qua':
    'Paste a bare URL and it becomes a link automatically: https://github.com/hqweay/qua',
  '一张行内图片：![[写作-示例图.png]] 行高不变，点图放大，⌥ 点看详情。':
    'An inline image: ![[写作-示例图.png]] keeps the line height; click to enlarge, ⌥-click for details.',
  '缺字节的图是「占位」不是错误：![[丢失的截图.png]] 它后面的字照样能编辑。':
    'An image with missing bytes is a "placeholder", not an error: ![[丢失的截图.png]] — the text after it is still editable.',
  '一段带四种格式的句子：**加粗的结论**、*斜体的限定*、==高亮的关键词==、`行内代码`。':
    'A sentence with four formats: **a bold conclusion**, *an italic qualifier*, ==a highlighted keyword==, and `inline code`.',
  '标记顺序不能错：==先高亮== 再 **后加粗**，两个区间都得落在自己那几个字上。':
    'Mark order matters: ==highlight first== then **bold second** — each range must land on exactly its own words.',
  '这一页引用了 [[欢迎使用相]]——那一页右槽的「反链」里，来源就是这一页。':
    'This page references [[Welcome to Qua]] — in that page\'s "Backlinks" panel, this is the source.',
  '一行里混着引用与图片也能继续打字：[[欢迎使用相]] ![[写作-第二张.png]]':
    'You can keep typing in a line that mixes a reference and an image: [[Welcome to Qua]] ![[写作-第二张.png]]',
  '降级样本 · 超长块：': 'Fallback sample · very long block:',
  '降级样本 · 全英文长行（不该溢出容器）：':
    'Fallback sample · long all-English line (should not overflow its container):',
  '标签写在正文之外：这一页打了个标签，归属落在行尾 chip 上，正文一个字没动。':
    'Tags live outside the text: this page has a tag, shown as the chip at the end of the line; the text itself is untouched.',
  '备注是写在字上的批注：下面这句话带了一枚示例备注——选中一段字，从划选气泡里选「备注」就能做到。':
    'A note is a comment on the words: the sentence below carries a sample note — select some text and choose "Note" from the bubble to make one.',
  '写作': 'Writing',
  '第一次见面就能在字上写批注。': 'Right from the start, you can annotate the words themselves.',
  '同一块、两处算作：下面这行笔记同时算作 [[每周复盘]]「下一步」的一员——只多一条归属边，内容没有搬。':
    'One block, two homes: the note below also counts as a member of "Next Steps" on [[Weekly Review]] — just one extra membership edge; the content never moved.',
  '把内容搬去别的库之前：先备份原始字节，再动结构。':
    'Before moving content to another library: back up the raw bytes first, then change the structure.',

  '每周复盘': 'Weekly Review',
  '每周一页：这周做了什么、卡在哪、下周做什么。':
    'One page a week: what I shipped, where I got stuck, what is next.',
  '日记是流水，复盘是挑选：值得继续推进的事，进「下一步」。':
    'A journal is a stream; a review is a selection: anything worth pushing forward goes into "Next Steps".',
  '「下一步」的行头带着状态值（在行头直接改）——这是挂在行头上的属性。':
    '"Next Steps" shows a status value in each row header (edit it right there) — a property attached to the header.',
  '下一步': 'Next Steps',
  '邀请几位朋友试用 beta，收集第一轮反馈。':
    'Invite a few friends to try the beta and gather the first round of feedback.',
  '安装包签名与自动更新。': 'Sign the installer and enable auto-updates.',
  '图库管理：图片多起来之后再想。': 'Asset library management: revisit once the image collection grows.',
  '把这一页拖进左槽就能开一扇常驻的窗——常去的页面都值得这样放。':
    'Drag this page into the left panel to keep a permanent window — every page you visit often deserves that.',
  '复盘只写「变了什么、为什么」，不抄流水账。':
    'A review only records "what changed and why" — it is not a copy of the daily log.',
  '复盘': 'Review',
  '超长标题的降级：面包屑、左槽、引用选择器三处都要能截断而不破版':
    'Fallback for a very long title: breadcrumbs, the left panel, and the reference picker must all truncate without breaking the layout',
  '无标题页：左槽、面包屑、引用 chip 都要有兜底文案':
    'Untitled page: the left panel, breadcrumbs, and reference chips all need a fallback label',
  '引用一个无标题页：[[ ]]': 'Reference an untitled page: [[ ]]',

  /* ---------------------------------------------- 查询块 / 装配时要拿到 id 的样本 */
  '全部页面': 'All Pages',
  '功能看板': 'Feature Board',
  '功能': 'Feature',
  '看板': 'Board',
  '表格': 'Table',
  '画廊': 'Gallery',
  '日历': 'Calendar',
  '「下一步」的镜像': 'Mirror of "Next Steps"',
  '把内容搬去别的库之前': 'Before moving content to another library',
  '第一次见面': 'Right from the start',
  '就能在字上写批注。': ', you can annotate the words themselves.',
  '示例备注：批注跟着字走——字改了，它还认得自己标的是哪段。':
    'Sample note: the annotation follows the words — edit the text and it still knows what it marked.',

  /* ------------------------------------------------- 「功能」词汇：属性 ＋ 标签 ＋ 实例 */
  '功能状态': 'Feature Status',
  '落地日期': 'Shipped On',
  '探索中': 'Exploring',
  '已落地': 'Shipped',
  '搁置': 'Shelved',
  '命令面板': 'Command Palette',
  '行内图片': 'Inline Images',
  '多库与库根': 'Multiple Libraries and Roots',
  '快速筛选': 'Quick Filter',
  '回收站': 'Trash',
  '备注': 'Notes',
  '查询镜头': 'Query Lenses',
  '多值与附件': 'Multi-value and Attachments',
  '块取名': 'Naming Blocks',
  '视图显示与排序': 'View Display and Sorting',
  '大文档秒开': 'Large Documents Open Instantly',
  '行内形状语言': 'Inline Shape Language',
  '字段入口三面共用': 'One Field Entry, Three Surfaces',
  '引用某一段': 'Reference a Passage',
  '自动化': 'Automation',
  '图库管理': 'Asset Library Management',
  /* ------------------------------------------- 任务状态词汇：种子里那份定义块与选项 */
  '任务状态': 'Task Status',
  '待办': 'To Do',
  '进行中': 'In Progress',
  '完成': 'Done',
  '放弃': 'Abandoned',
}

/**
 * 英文的「超长块」样本：与 build.ts 的 longParagraph() 同用途，给排版 / 虚拟化量长度。
 * 中文默认仍用 longParagraph()，两种语言各自测自己的长行。
 */
export const SEED_EN_LONG_PARAGRAPH =
  'A block-based document model looks, at first glance, like nothing more than cutting a paragraph into pieces — but the real cost lives at the **boundaries**: every keystroke, deletion, paste, or cross-block replacement has to decide again which piece is which, and the tiniest ambiguity about an insertion that lands exactly between two pieces will, after a few edits, leave you with bold text that swallows one word too many or a reference box wrapped around something unrelated. We settled on one rule: **formatting follows the text, and atoms are their own piece**, each with an unambiguous position in the sequence, so inserting in the middle of a format and inserting against its edge stay different, explicitly distinguished facts. Structural changes are harder still: splitting a block moves the right half into a new block, merging appends one block’s content to the previous one, and copying a subtree must give every atom a fresh id. Finally there is the question of who owns the selection: a DOM Range only describes the two endpoints currently mounted in the viewport, so a selection spanning an unmounted block cannot be expressed there; the selection therefore lives in the model, as a block id plus an offset, and the DOM is only one projection of it. That makes cross-block selection, selection inside collapsed blocks, and selection outside the viewport all expressible — at the price of projecting the model selection back onto the DOM on every render. Shapes like this look redundant right up to the moment they save you, and they are the parts most likely to be deleted by a later reader who never saw the failure they prevent.'
