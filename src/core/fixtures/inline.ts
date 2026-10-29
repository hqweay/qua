/**
 * 迷你 DSL：种子正文里直接写 `**粗**` / `==高亮==` / `` `代码` `` / `[[页面]]` / `![[图.png]]` /
 * `[名字](https://…)`，由 `parseInline` 解析成** run 序列**——这正是模型里的行内内容形状
 * （文本段带 marks、原子是 run），而不是把富文本塞进 DOM。
 *
 * 单独一层是为了让「种子内容长什么样」与「内容怎么变成块」分开：
 * 换一批假数据不需要碰到解析器，改 DSL 也不需要碰任何一页的内容。
 */
import { uuidv7Hex } from '../ids.ts'
import { checkExternalUrl } from '../link.ts'
import { normalizeRuns, textRuns, type AssetRun, type LinkRun, type MarkType, type RefRun, type Run } from '../runs.ts'
import { MISSING_ASSET_HASH, SEED_ASSET_HASH } from './assets.ts'

export interface SeedBlock {
  text: string
  /**
   * 任务状态（**值是属性**，落进 `props[TASK_STATUS_PROP_ID]`）：
   * `true` ＝ 做完了，`false` ＝ 是任务、还没做完。
   *
   * 与正文里的 `#任务` 是两件事（值 ＋ 分类），本字段只管值；
   * 它们必须成对出现才有 entry：gutter 上那个方框由**标签声明**的字段决定。
   */
  task?: boolean
  /**
   * 打哪些标签（按名字）。
   *
   * 标签标的是**整个块**，所以它不占正文的一格：解析成标签块 id 后写进 `props._tags`。
   * 名字到 id 的解析与「敲 `#名字`」共用 `ensureTag` ⇒ 同名块不会被建出两份。
   */
  tags?: string[]
  /** 系统属性：查询块的 `_query` 条件就落在这里 */
  props?: Record<string, unknown>
  children?: SeedBlock[]
}

/** 还没解析目标的引用（森林凑齐、页/标签块建好之后再回填 `to`） */
export interface PendingRef {
  runId: string
  label: string
}

interface AtomToken {
  kind: 'page' | 'image' | 'link'
  start: number
  label: string
  /** 只有 `kind: 'link'` 有：规范化之后的地址（显示名与地址是两个键，同 `LinkRun`） */
  url?: string
  missing?: boolean
}

interface MarkSpan {
  type: MarkType
  start: number
  end: number
}

/**
 * ① 先把 `[[..]]` / `![[..]]` 换成占位字符（解析期坐标用，**不进产物**），
 * ② 再解析成对格式标记，③ 最后把（去掉了占位字符的）文本流与标记区间
 * 一起翻译成 run 序列：标记内 ⇒ 文本带 marks／原子整枚带 marks。
 */
export function parseInline(src: string): { runs: Run[]; refs: PendingRef[] } {
  let text = ''
  const atoms: AtomToken[] = []
  let i = 0
  while (i < src.length) {
    const rest = src.slice(i)
    const img = /^!\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/.exec(rest)
    if (img) {
      text += '\uFFF9'
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
      text += '\uFFF9'
      atoms.push({ kind: 'page', start: text.length - 1, label: page[1]!.trim() })
      i += page[0].length
      continue
    }
    /**
     * `[名字](地址)` ⇒ 一枚外链。名字可以为空（`[](地址)`）⇒ 显示地址本身，
     * 与编辑器里 `text` 留空是同一条口径：`LinkRun.v` 是内容，不许是空。
     *
     * 放在 `[[…]]` 之后是安全的：引用要求两个方括号，这里要求 `](`，互相吃不掉。
     *
     * ⚠️ 地址过 **同一份白名单**（`core/link.ts`），不过就**原样留成纯文本**——
     *    种子写错一个地址时，宁可首屏显示一段点不动的字，也不要造一枚打不开的 link：
     *    那会让人以为是链接功能坏了，而不是数据写错了。
     */
    const link = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest)
    if (link) {
      const chk = checkExternalUrl(link[2]!.trim())
      if (!chk.ok) {
        text += link[0]
        i += link[0].length
        continue
      }
      text += '\uFFF9'
      atoms.push({ kind: 'link', start: text.length - 1, label: link[1]!.trim(), url: chk.url })
      i += link[0].length
      continue
    }
    text += src[i]
    i++
  }

  const marks: MarkSpan[] = []
  /**
   * 删掉一对标记字符 ⇒ 它右边的**所有位置**左移。
   * ⚠️ 这里必须把**前面几趟已经找到的端点**一起挪，否则「先 ==高亮== 后 **加粗**」
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

  // ③ 翻译成 runs：区间端点 ∪ 原子位置都当切点，文本段按覆盖它的标记集带 marks
  const cuts = new Set<number>([0, text.length])
  for (const m of marks) {
    cuts.add(Math.max(0, Math.min(m.start, text.length)))
    cuts.add(Math.max(0, Math.min(m.end, text.length)))
  }
  for (const a of atoms) {
    cuts.add(Math.max(0, Math.min(a.start, text.length)))
    cuts.add(Math.max(0, Math.min(a.start + 1, text.length)))
  }
  const pts = [...cuts].sort((x, y) => x - y)
  const marksAt = (s: number, e: number): MarkType[] => marks.filter((m) => m.start <= s && m.end >= e).map((m) => m.type)

  const runs: Run[] = []
  const refs: PendingRef[] = []
  for (let k = 0; k < pts.length - 1; k++) {
    const s = pts[k]!
    const e = pts[k + 1]!
    if (s === e) continue
    const seg = text.slice(s, e)
    const atom = atoms.find((a) => a.start === s)
    if (seg === '\uFFF9' && atom) {
      const mk = marksAt(s, e)
      if (atom.kind === 'image') {
        /**
         * 资产不带格式（模型红线）；DSL 里的格式标记盖到它也只当没盖。
         *
         * 地址只有两种：**真的样本字节**（`SEED_ASSET_HASH`，启动时会被写进资产库）
         * 或**刻意缺失的地址**（`MISSING_ASSET_HASH`，库里没有它）。
         * 不再造「随手一个 uuid 前 32 位」——那种地址永远不存在，演示看起来像资产库坏了，
         * 而且它连合法 hash 形状都不是。
         */
        // 尺寸不在 run 上：它是那份**字节**的属性，由资产索引回答（`AssetView`）
        const run: AssetRun = {
          id: uuidv7Hex(),
          t: 'asset',
          asset: atom.missing ? MISSING_ASSET_HASH : SEED_ASSET_HASH,
          label: atom.label,
        }
        runs.push(run)
      } else if (atom.kind === 'link') {
        // 显示名与地址各在自己的键上：名字空着 ＝ 显示地址本身（`v` 是内容，不许是空串）。
        // 外链没有目标块，所以不进 `refs`（那份留给 `[[…]]` 之后回填 `to`）。
        const run: LinkRun = {
          id: uuidv7Hex(),
          t: 'link',
          v: atom.label === '' ? atom.url! : atom.label,
          url: atom.url!,
          ...(mk.length ? { marks: mk } : {}),
        }
        runs.push(run)
      } else {
        const run: RefRun = { id: uuidv7Hex(), t: 'ref', label: atom.label, ...(mk.length ? { marks: mk } : {}) }
        refs.push({ runId: run.id, label: atom.label })
        runs.push(run)
      }
      continue
    }
    runs.push(...textRuns(seg, marksAt(s, e)))
  }
  return { runs: normalizeRuns(runs), refs }
}
