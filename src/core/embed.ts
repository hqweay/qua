/**
 * **露面**：一个块在另一个位置再出现一次（镜像）以及它带的那条看法。
 *
 * 为什么不是复制、也不是新实体：用户要的是「同一批块，在别处再看一次」。
 * 复制子树之后源一改就说谎；造一个「镜像实体」则多出一种身份。所以这里只有**指针**：
 * 块上一个系统属性，指向被露面的那一块；数据永远读活的。
 *
 * ## 一条判据：配置跟着**宿主**走
 *
 * 面貌（大纲／表格／看板…）住在**露面块自己**的 `_views`／`_activeView` 上，
 * 不指向源块上的某张视图。这与普通块同一条规则——普通块的宿主就是它自己，
 * 所以「主页怎么看」仍存在源块上；露面块的宿主是它自己，所以「这里怎么看」
 * 存在露面块上。⇒ 在别处把它转成表格，**源块一个字节都不动**。
 *
 * 代价（登记）：同一个源在两处想看**同一张表、改一处两处一起变**做不到。
 * 那是「命名视图」——另一个功能，需要时再给看法引入 id 与生命周期。
 *
 * ## 语言
 *
 * 「源」＝ 指针指向的那一块；「宿主」＝ 这一次露面的那一块（它有自己的位置与看法）。
 */
import type { Block } from './model.ts'

/** 类型 id（`TYPE_DECLS` 里一行；`core/*` 保留给系统类型） */
export const EMBED_TYPE = 'core/view-embed'

/** 指针所在的系统属性：`{ block: <源块 id> }` */
export const EMBED_PROP = '_embed'

export interface EmbedRef {
  block: string
}

/**
 * 读出指针；形状不对 ⇒ `null`（**不猜、不修**：坏形状交给渲染层说「这次露面坏了」，
 * 而不是静默变成一块普通空块——那会让用户以为数据还在，只是没显示）。
 */
export function readEmbed(b: Block | undefined): EmbedRef | null {
  const raw = b?.props?.[EMBED_PROP]
  if (!raw || typeof raw !== 'object') return null
  const x = raw as Partial<EmbedRef>
  if (typeof x.block !== 'string' || x.block.trim() === '') return null
  return { block: x.block }
}

export function isEmbedBlock(b: Block | undefined): boolean {
  return readEmbed(b) !== null
}

export function embedTargetId(b: Block | undefined): string | null {
  return readEmbed(b)?.block ?? null
}

/**
 * 这次露面指向谁、以及它现在是什么状态。
 *
 * `self` 与 `dangling` 必须与 `ok` 分开：前者是「指向自己」（写入口发的是新块 id，
 * 正常路径造不出来 ⇒ 只可能是坏数据），后者是「源被删了」。两种都要画一句实话，
 * 而不是退化成空块——空块看起来像「这里本来就空」。
 */
export type EmbedResolution =
  | { status: 'ok'; target: Block }
  | { status: 'self' }
  | { status: 'dangling' }
  | { status: 'broken' }

export function resolveEmbed(
  host: Block,
  find: (id: string) => Block | undefined,
): EmbedResolution {
  const ref = readEmbed(host)
  if (!ref) return { status: 'broken' }
  if (ref.block === host.id) return { status: 'self' }
  const target = find(ref.block)
  if (!target) return { status: 'dangling' }
  return { status: 'ok', target }
}
