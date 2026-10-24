/**
 * 造树器：把迷你 DSL 写成的一段 `SeedBlock[]` 装成模型里的块（＋锚点 / 原子 / 折叠表 / 待落标签）。
 *
 * 这里**不放任何一页的具体内容**：数据住在 `seed.ts` / `states.ts`，冷启动态住在
 * `core/bootstrap.ts`。三处共用同一套造块路径，是因为「页 / 日记 / 标签归属 / `[[ ]]` 解析」
 * 的先后顺序本身就是模型约束（标签块必须先于引用解析存在），多一份实现就会多一个顺序答案。
 */
import {
  addTagId,
  ALIASES_PROP,
  DISPLAY_PROP,
  ensureTag,
  findByAlias,
  journalId,
  LISTS_PROP,
  mkBlock,
  TASK_STATUS_PROP_ID,
  uuidv7Hex,
  type Atom,
  type Block,
  type FoldState,
  type Mark,
} from '../index.ts'
import { WORKSPACE_VERSION, type PageBlock, type Workspace } from '../workspace.ts'
import { parseInline, type SeedBlock } from './inline.ts'

/* --------------------------------------------------------------- 构建 */

export interface BuiltPage {
  /** 页 ＝ `_lists` 里有 `page` 的块；名字在 `_aliases`（journal 也复用这个形状） */
  page: Block
  /** 页面标题 → id 的解析表（延后处理引用目标） */
  refs: { atomId: string; label: string }[]
  /** 这一页自己的锚点与原子（最后上提到库级，demo 平铺存放） */
  marks: Mark[]
  atoms: Atom[]
  /** 还没解析成 id 的标签归属（森林凑齐、标签块建好之后再落进 `_tags`） */
  pendingTags: { block: Block; name: string }[]
  /** 这一页里初始被收起的块 id（最后合并成库级折叠表） */
  folded: FoldState
}

export function buildTree(
  seeds: SeedBlock[],
  out: { marks: Mark[]; atoms: Atom[]; refs: BuiltPage['refs']; folded: FoldState; pendingTags: BuiltPage['pendingTags'] },
): Block[] {
  return seeds.map((s) => {
    const parsed = parseInline(s.text)
    const text = parsed.text
    /**
     * **标签不往正文里插任何东西**：归属是块级字段，正文保持作者写下的那几个字。
     * ⚠️ 名字到 id 的解析推迟到森林凑齐之后 —— 标签块住在森林顶层、比内容块晚建，
     *    这里拿不到它，写一个假 id 只会得到「指向不存在的东西」。
     */
    const b = mkBlock(text)
    for (const name of s.tags ?? []) out.pendingTags.push({ block: b, name })
    if (s.folded) out.folded[b.id] = true
    // 任务状态是**真实属性**：它的键是定义块的 id，值与标签声明无关（声明只提供入口）
    if (s.task !== undefined) b.props = { ...(b.props ?? {}), [TASK_STATUS_PROP_ID]: s.task }
    if (s.props) b.props = { ...(b.props ?? {}), ...s.props }
    for (const m of parsed.marks) out.marks.push({ id: uuidv7Hex(), type: m.type, blockId: b.id, start: m.start, end: m.end })
    for (const a of parsed.atoms) {
      const id = uuidv7Hex()
      const atom: Atom = {
        id,
        kind: a.kind,
        blockId: b.id,
        start: a.start,
        end: a.start + 1,
        label: a.label,
      }
      // 引用要解析目标块；图片不走这条路（它指资产）
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
 * 判据：页名 ＝ 主别名（`_aliases[0]`），正文是**描述**（初值可以等于名字）；
 * 页的身份是 `_lists: ['page']`；图标是系统属性 `_icon`；
 * 原来的「页的 roots」就是页块的 `children` —— 一个页恰好是一个块。
 *
 * ⚠️ 空标题也要有一个地址：不变量是「在页列表里 ⇒ 至少有一个名字」。
 *    给它 `未命名-<短 id>`，正文仍留空 ⇒ 呈现层的兜底文案照样生效
 *    （引用/反链走主名，列表标题仍可回落到正文，见 `displayNameOf` 的优先级）。
 */
export function mkPage(title: string, icon: string, seeds: SeedBlock[], id = uuidv7Hex()): BuiltPage {
  const acc = { marks: [] as Mark[], atoms: [] as Atom[], refs: [] as BuiltPage['refs'], folded: {} as FoldState, pendingTags: [] as BuiltPage['pendingTags'] }
  const children = buildTree(seeds, acc)
  const name = title.trim() !== '' ? title.trim() : `未命名-${id.slice(-6)}`
  const page: PageBlock = {
    id,
    text: title,
    children,
    props: { [ALIASES_PROP]: [name], [LISTS_PROP]: ['page'], [DISPLAY_PROP]: 'alias', _icon: icon },
  }
  return { page, refs: acc.refs, marks: acc.marks, atoms: acc.atoms, folded: acc.folded, pendingTags: acc.pendingTags }
}

/**
 * 造一个日记块：**身份 ＝ `_date`**，日期不进 `text`。
 * 它和页复用同一个 `BuiltPage` 形状（子树 / 锚点 / 原子），只是身份来源不同。
 */
export function mkJournal(date: string, seeds: SeedBlock[]): BuiltPage {
  const acc = { marks: [] as Mark[], atoms: [] as Atom[], refs: [] as BuiltPage['refs'], folded: {} as FoldState, pendingTags: [] as BuiltPage['pendingTags'] }
  const children = buildTree(seeds, acc)
  const block: Block = {
    id: journalId(date),
    text: '',
    children,
    props: { _date: date, _icon: 'lucide:calendar' },
  }
  return { page: block, refs: acc.refs, marks: acc.marks, atoms: acc.atoms, folded: acc.folded, pendingTags: acc.pendingTags }
}

/**
 * 把种子里写的标签名落成**块级归属**（`props._tags`）。
 *
 * ⚠️ 必须在**引用解析之前**跑：`ensureTag` 会把新标签块 append 到森林顶层，
 *    而 `resolveRefs` 要在这片森林里按名字找目标 —— 晚一步，指向标签的引用就会变成悬空。
 * ⚠️ 用 `ensureTag` 而不是自己建块：页与标签共用同一个名字空间，
 *    「同名必同一块」这条口径与命令路径是同一个函数，种子不该另写一份。
 */
export function resolveSeedTags(forest: Block[], pending: readonly { block: Block; name: string }[]): void {
  for (const { block, name } of pending) {
    const tag = ensureTag(forest, name).block
    if (tag) addTagId(block, tag.id)
  }
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
export function resolveRefs(pages: Block[], built: BuiltPage[]): void {
  for (const bp of built) {
    for (const r of bp.refs) {
      const target = findByAlias(pages, r.label)
      const atom = bp.atoms.find((a) => a.id === r.atomId)!
      if (target) atom.target = { kind: 'page', id: target.id }
    }
  }
}

/* --------------------------------------------------------------- 长文 */

/**
 * 两处长文样本同时被满态种子与降级态用到。住在这里而不是各自复制一份：
 * 调排版 / 断行 / 虚拟化时，「超长块」与「整页种子」必须量的是同一段文字，
 * 否则只测到其中一处，另一处坏掉也没人发现。
 */
export function longParagraph(): string {
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

export const LONG_EN = [
  'The quick brown fox jumps over the lazy dog.',
  'Supercalifragilisticexpialidocious pneumonoultramicroscopicsilicovolcanoconiosis',
  'antidisestablishmentarianism floccinaucinihilipilification.',
  'A block-based document model keeps identity stable across edits, which is exactly why the anchors must carry a block id instead of a bare offset pair.',
].join(' ')

/* --------------------------------------------------------------- 库壳 */

/**
 * 一片块森林 + 库级锚点/原子（承 1／5：没有「页实体」这一层）。
 *
 * 满态 / 稀疏 / 降级 / 冷启动四处都要装同一个壳。壳里的字段（版本、空回收站、`activeId`
 * 落在第一块）是**库的形状**，不是某一态的特征：
 * 各写一份就会让某个态悄悄缺一格，落盘后由别的读路径发现。
 *
 * ⚠️ **设备偏好不在壳里**（v15 起）：主题／槽宽／钉住是「这台设备怎么显示」，
 *    换库（演示状态切换）不该把它带走 ⇒ 它们住在 `qua.device`（`storage/device.ts`）。
 */
export function forest(blocks: Block[], built: BuiltPage[]): Workspace {
  return {
    version: WORKSPACE_VERSION,
    blocks,
    folded: Object.assign({}, ...built.map((b) => b.folded)),
    activeId: blocks[0]?.id ?? '',
    savedAt: Date.now(),
    marks: built.flatMap((b) => b.marks),
    atoms: built.flatMap((b) => b.atoms),
    // 种子库没有删过东西；回收站是**新增的库级一格**，缺席会让落盘形状少一块
    trash: [],
  }
}
