/**
 * **露面**：一个块在另一个位置再出现一次（镜像），以及它带的那条看法。
 *
 * 为什么不是复制、也不是新实体：用户要的是「同一批块，在别处再看一次」。
 * 复制子树之后源一改就说谎；造一个「镜像实体」则多出一种身份。所以这里只有**指针**：
 * 块上一个系统属性，指向被露面的那一块；数据永远读活的。
 *
 * ## 一条判据：看法住在**源块**上，露面只存一个选择
 *
 * `_embed = { block, view }`：`view` 是 `''`（跟随源块的默认看法）／`'outline'`（强制大纲）／
 * 源块 `_views` 里的一张命名视图的 id。**露面块自己没有 `_views`／`_activeView`**。
 *
 * 为什么改了（曾经露面块自己存一份配置）：同一批块在正文、面板、中心各露一次，
 * 就得到三份各自演化的列与排序——「这里改了列宽，那里没跟着变」既不是共享也不是独立，
 * 只是三份互相看不见的副本。要共享就都指向源块；要独立就在源块上**建一张命名视图**，
 * 让这一次露面指向它。两种需求都有出口，且都只有一份配置。
 *
 * ## 语言
 *
 * 「源」＝ 指针指向的那一块；「宿主」＝ 这一次露面的那一块（它有自己的位置）。
 */
import type { Block } from './model.ts'

/** 类型 id（`TYPE_DECLS` 里一行；`core/*` 保留给系统类型） */
export const EMBED_TYPE = 'core/view-embed'

/** 指针所在的系统属性：`{ block: <源块 id>, view: <'' | 'outline' | 视图 id> }` */
export const EMBED_PROP = '_embed'

/**
 * 一次露面的指针。
 *
 * `view` 的三个取值各有各的意思，不能合并：
 *   · `''` —— 跟随源块自己的默认看法（源块换默认，这里跟着换）；
 *   · `'outline'` —— 强制大纲（**不落盘在源块上**：它是这次露面的选择）；
 *   · 其它 —— 源块 `_views` 里那张命名视图的 id。
 */
export interface ViewRef {
  block: string
  view: string
}

/** 「跟随源块的默认看法」 */
export const FOLLOW_VIEW = ''
/** 「强制大纲」（不是一张视图，是这次露面的一个选择） */
export const OUTLINE_VIEW = 'outline'

/**
 * 读出指针；形状不对 ⇒ `null`（**不猜、不修**：坏形状交给渲染层说「这次露面坏了」，
 * 而不是静默变成一块普通空块——那会让用户以为数据还在，只是没显示）。
 */
export function readEmbed(b: Block | undefined): ViewRef | null {
  return canonicalViewRef(b?.props?.[EMBED_PROP])
}

/**
 * 逐字段重建指针（与 `canonicalSpec`／`canonicalViews` 同一条纪律）。
 *
 * `view` 缺席按 `''`（跟随）：它是「没选」而不是「坏了」——
 * 老老实实退回最原始的那一种看法，而不是把用户塞进某一张视图。
 */
export function canonicalViewRef(raw: unknown): ViewRef | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const x = raw as Partial<ViewRef>
  if (typeof x.block !== 'string' || x.block.trim() === '') return null
  return { block: x.block, view: typeof x.view === 'string' ? x.view : FOLLOW_VIEW }
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
  | { status: 'ok'; target: Block; view: string }
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
  return { status: 'ok', target, view: ref.view }
}
