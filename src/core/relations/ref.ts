/**
 * **引用解析 ＋ 呈现标签**（`RefResolver` 接缝）：行内原子显示什么、整块读作什么，
 * 都由**目标当前的状态**决定。
 *
 * 为什么它必须存在：引用如果显示插入时的快照，目标一改名，链接上挂的就是过期的字——
 * 双链里「改名要能传播」这件事只能靠**渲染时解析**，不能靠「改名时批量回去改一遍原子」
 * （后者一有第二处写入路径就会漏，而且撤销时还要反向再改一遍）。
 *
 * ⇒ 显示名**一律现算**，上面再叠一层用户覆盖（`RefRun.anchor`）：
 *   有 anchor 就显示 anchor（用户明确指定这一处叫什么），否则才是现算出来的名字。
 * ⇒ `Atom.label` 降级为 **fallback**：只有「目标找不到、且没有 anchor」时才用它
 *   （那时它是插入时刻的字，是用户关于这一指唯一还可能记得的信息）。
 * ⇒ `state` 是**派生**、不落盘：能不能解析到由「此刻森林里有没有这块」决定，
 *    存一份下来只会得到一个可能与事实不符的第二份真相。
 *
 * 块级标签（`blockLabel`）是原子级解析的**顶层**：一行只有一枚引用时，
 * 「这块读作什么」的答案就是那枚引用解析出来的名字——它跟引用 chip 是同一个问题，
 * 所以住在这里，而不是各呈现面（面包屑／卡片头／回收站行）各自再答一遍。
 *
 * ⚠️ 「按 id 找块」由调用方注入（`find`）：本文件零 DOM，也**不持有森林**
 *    —— 编辑器、popover、测试各自把「怎么找块」递进来，解析逻辑只有一份。
 */
import { t } from '../infra/msg.ts'
import { aliasLeaf, primaryAliasOf } from '../identity/alias.ts'
import { isJournal, journalDate, journalDateLabel } from '../identity/journal.ts'
import { hasList, type Block } from '../model/model.ts'
import { tagIdsOf } from '../identity/tags.ts'
import type { Content } from '../model/runs.ts'

/** 解析结果：**显示名 ＋ 还能不能解析到**（`dangling` 不是错误，是状态） */
export interface RefView {
  label: string
  state: 'resolved' | 'dangling'
  /**
   * 目标的身份，只给**呈现**用（行内 `#` 的三种样式：类／实例／普通引用）。
   * 省略 ⇒ 按普通引用处理；它不是落盘字段，也不是判定「能不能点开」的依据。
   */
  kind?: 'tag' | 'obj' | 'page'
}

/** 按 id 找块（整片森林；zoom 后引用目标可能在任意深度） */
export type FindBlock = (id: string) => Block | undefined

// ⚠️ 注入方要能解析**所有引用目标的种类**，不只块：引用可以锚在一段文字上
//   （目标 id 在索引里归到宿主块）。只按块 id 走森林的注入形状会把活引用判成
//    悬空——`store.find` 就是完整形状，别另写窄的；新增目标种类时把**全部注入点**
//    一起宽（编辑器 / 浮层 / 诊断 / 测试各注入各的，宽一处漏几处）。

/* ------------------------------------------------------- 呈现摘要与标签 */

/**
 * dangling／预算耗尽共用的兜底名：`anchor` 压过快照（用户显式指定的显示名最高）。
 * 快照是**插入时刻**的字，不是「用户最后见过的名字」——见 `resolveRef` 的取舍。
 */
function refSnapshot(a: { anchor?: string; label?: string }): string {
  const anchor = a.anchor === '' ? undefined : a.anchor
  return anchor ?? a.label ?? ''
}

/**
 * **呈现摘要**：一列 run 读出来是什么（`plainText` 的呈现层兄弟）。
 *
 * 三个投影三分，别混：
 *   · `plainText`（model/runs）—— **文本流投影**，原子不进：查询、匹配、引文、
 *     光标坐标都按它算（引用/chip 显示的字是目标的名字，不算这一块自己的字）；
 *   · `displayTextOf`（identity/alias）—— 查询语义的可读文本（`{text}` 条件），
 *     同样不含原子，空就是空；
 *   · 本函数 —— **呈现摘要**：面包屑、卡片头、引用 chip、回收站行的读者是人，
 *     而引用／图片／链接本身就是内容——读不出来就只剩「无标题」。
 *
 * 逐 run 的读法：text/link → 文本；asset → 文件名快照（缺失 ⇒ 占位「图片」）；
 * ref → **现解析**（改名要传播，理由见文件头）。
 *
 * ⚠️ 解析带**预算**（`budget`）：每追一层引用扣一格，扣完退回快照。
 *    预算不是「追几层刚好」的精调值，是**环终止的安全阀**：互引（A 引 B、B 引 A）
 *    在有限格内必然落回快照。真实链追到预算尽头仍取快照，是可接受的退化。
 */
export function summaryText(content: Content, find?: FindBlock, budget = 2): string {
  let out = ''
  for (const r of content) {
    if (r.t === 'text' || r.t === 'link') out += r.v
    else if (r.t === 'asset') out += r.label ?? t('ui.atom.image')
    else if (r.t === 'ref')
      out += find && budget > 0 ? resolveRef(find, r, budget - 1).label : refSnapshot(r)
  }
  return out.trim()
}

/**
 * 这一块**呈现**时的可读摘要：日记日期 > 主名叶子 > 摘要投影。空 ⇒ `''`。
 *
 * 与 `displayTextOf` 的分工：那是「这一块自己的字」（查询拿它去匹配，空就是空），
 * 这是「这一块读起来是什么」（原子按 `summaryText` 的读法进）。链的形状刻意同构
 * （日记 > 名字 > 内容），只在最后一段分叉——日记的正文恒为空、日期是它的可读投影，
 * 这一段两个投影共享同一个答案。
 */
export function blockSummary(b: Block, find?: FindBlock, budget = 2): string {
  if (isJournal(b)) {
    const date = journalDate(b)
    if (date !== '') return journalDateLabel(date)
  }
  const leaf = aliasLeaf(primaryAliasOf(b))
  if (leaf !== '') return leaf
  return summaryText(b.content, find, budget)
}

/**
 * 呈现层「这一块叫什么」：`blockSummary` ＋ **无标题兜底**——全应用唯一的兜底定义点。
 *
 * 与 `blockSummary` 的分工：那个说「读起来是什么，空就是空」（回收站拿空串去画
 * 「（空块）」占位），这里说「界面上必须有个名字」。面包屑、行上下文格、卡片头、
 * 引用 chip、搜索行兜底都是同一个问题，只在这里回答一次；调用面不再各自发明兜底
 * （裸 id 尤其不许露——用户没有可以从 4 位 hex 里认出哪块是哪块的能力）。
 */
export function blockLabel(b: Block, find?: FindBlock, budget = 2): string {
  return blockSummary(b, find, budget) || t('ui.page.untitled')
}

/**
 * 解析一个行内引用。
 *
 * `a` 只取 `label`／`anchor`／`to`／`flavor` ⇒ popover 与测试可以不造完整 run。
 * `budget` 是**目标标签**的追层预算（详见 `summaryText`）——chip 呈现目标的标签，
 * 目标自己还是一行引用时，这一格的预算决定要不要继续往下读。
 *
 * ## 显示名的唯一一条链（改这里之前先看一眼）
 *
 * | 目标状态 | 显示什么 |
 * |---|---|
 * | resolved | `anchor ?? blockLabel(target, find, budget)` |
 * | dangling  | `anchor ?? label ?? ''` |
 *
 * anchor 是「用户想让这一处叫什么」，所以它**压过一切派生出来的名字**；
 * `label` 只在「目标没了、用户又没指定显示名」时才露面——它是插入时刻的快照。
 *
 * ⚠️ `anchor` **不是第二份身份答案**：它不参与 `_aliases`、不进 `plainText`
 *    投影、不改反链计数、也不被 `{text}` 条件读到（那些地方只认 target 与投影）。
 *    把这条看成「一处显示内容」，就不会诱惑任何人去同步它。
 *
 * ⚠️ 没有 `to` 的引用（seed 的悬空样本、落盘前就指不到东西的老数据）
 *    一律 `dangling` ＋ 沿用 `label`：指不到就是指不到，不假装解析成功。
 *
 * ⚠️ **fallback 是「插入时的快照」，不是「用户最后见过的名字」——这是刻意的取舍**：
 *    要让兜底名跟着改名走，就得在**渲染时回写 `atom.label`**，而那会让一次纯渲染产生副作用
 *    （弄脏快照、连带触发落盘）。「改名靠解析传播、不回头改原子」是本文件的前提，二者不可兼得。
 *    ⇒ dangling 是**少数派状态**（目标被删），给它一个稳定的旧名字，好过让渲染变得不纯。
 */
export function resolveRef(
  find: FindBlock,
  a: { label?: string; to?: string; flavor?: '#'; anchor?: string },
  budget = 2,
): RefView {
  const target = a.to
  // 空串 ＝ 没写（写入侧「写空即删键」⇒ 库里没有「有但是空的」这种形状），
  // 读侧把两者合成一个值，判据才不会在某一处漏成「显示一片空白」
  const anchor = a.anchor === '' ? undefined : a.anchor
  const fallback = a.flavor === '#' ? ('tag' as const) : ('page' as const)
  if (!target) return { label: refSnapshot(a), state: 'dangling', kind: fallback }
  const b = find(target)
  if (!b) return { label: refSnapshot(a), state: 'dangling', kind: fallback }
  // 标签的显示名＝**不带 `#` 的正文**；`#` 是呈现时加的装饰（`makeAtomEl`），不进正文，
  // 否则「标签块的正文」与「它在引用里显示的字」就成了两个需要同步的东西。
  return { label: anchor ?? blockLabel(b, find, budget), state: 'resolved', kind: refKindOf(b) }
}

/**
 * 引用目标的身份（**只给呈现用**）：标签类／带归属的实例／其它。
 *
 * 判据与「它是不是标签」「它有没有归属」是同一份模型读法——不在渲染层另认一遍。
 * `props._tags` 非空的块就是一条实例记录（记录不是新种类，见 `core/obj.ts`）。
 * ⚠️ 判据**只看归属**，不看露面、不看正文、不看身份：一个页只要打了块标签，
 *    它同时也是那个标签的一条实例，所以引用它时会画成实例。这是口径，不是漏判。
 */
function refKindOf(b: Block): 'tag' | 'obj' | 'page' {
  if (hasList(b, 'tag')) return 'tag'
  if (tagIdsOf(b).length > 0) return 'obj'
  return 'page'
}

/**
 * 一次解析多个（`fillBlockText` 用）：省掉「逐格调 `find`」的重复查找。
 *
 * 返回的是 `runId → RefView`，按 id 取而不是按位置取 —— run 与 DOM 元素的对应关系
 * 由 run id 钉死，不会因为顺序变化而张冠李戴。
 */
export function resolveRefs(
  find: FindBlock,
  runs: readonly { id: string; label?: string; to?: string; flavor?: '#'; anchor?: string }[],
  budget = 2,
): Map<string, RefView> {
  const out = new Map<string, RefView>()
  for (const a of runs) out.set(a.id, resolveRef(find, a, budget))
  return out
}

/** 找不到目标时的兜底视图（那一格还在、目标块没了 ⇒ 看得见的 dangling） */
export function danglingView(label: string, kind: 'tag' | 'obj' | 'page' = 'page'): RefView {
  return { label, state: 'dangling', kind }
}

/**
 * 文本里的块引用记号 `((block-id))`。
 *
 * 为什么用文本记号而不是自定义剪贴板 MIME：粘贴要跨窗、跨应用、跨浏览器，
 * 而 `text/plain` 是唯一到处都在的格式。自定义 MIME 只在同一个应用里活，
 * 一旦用户在别处中转一次就丢了；`((id))` 至少在文本里看得见、可手写。
 *
 * 只认「括号里没有空白」的形状：正文里的普通括号不会因此被误认成引用。
 */
const REF_TOKEN = /\(\(([^()\s]{1,128})\)\)/g

export function refTokensIn(text: string): { id: string; start: number; end: number }[] {
  const out: { id: string; start: number; end: number }[] = []
  for (const m of text.matchAll(REF_TOKEN)) {
    const start = m.index ?? 0
    out.push({ id: m[1]!, start, end: start + m[0].length })
  }
  return out
}

/**
 * 回收站条目是「空块」吗：**根的呈现摘要为空 ∧ 没有子块**。
 *
 * 这是清空口径的判据（回收站卡按它筛、也按它计「清空 N」）。两条都取**窄**的：
 *   · 摘要用 `blockSummary`（与回收站行的「（空块）」占位同一份投影）——
 *     引用原子读得出目标名、图片读得出文件名，都不算空；宁可少清。
 *     （住在解析接缝这边而不是 model：判据要吃「呈现摘要」，而那是本文件的投影。）
 *   · 无子块：正文空但带子树的条目，子树里可能有要保留的东西，不进「空块」口径。
 */
export function isBlankTrashEntry(b: Block, find?: FindBlock): boolean {
  return blockSummary(b, find) === '' && b.children.length === 0
}
