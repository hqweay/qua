/**
 * **`ref` 的候选域**：`_refTags`（候选按标签成员过滤，含下级标签闭包）。
 *
 * 值层一个字节都不动：`props[propId]` 仍是「任意块 id」。
 * 这里只回答**候选从哪儿来**——属性行上那个「选一个块」的浮层列哪些行。
 *
 * ## 为什么是软约束
 *
 * `_refTags` 过滤**候选**，不校验**存量值**（口径同 Logseq 的 `:logseq.property/classes`）：
 *   · 约束改了、标签删了、块改了标签 ⇒ 已经引用的块**照常显示**，值不清、不报错；
 *   · 只有「下一次挑目标」时候选面跟着变。
 *
 * 判据：一旦出现「写值路径按 `_refTags` 拒写」「显示时把不在约束里的值藏起来」，
 * 这条约束就从软变硬了 —— 那是退回旧形状（值层的存亡被显示层决定）。
 *
 * ## 闭包
 *
 * 「`#演员` 也算 `#人物`」这件事只有一份实现（`identity/tag-tree.ts` 的 `membersOf`），
 * 这里不另写一遍：标签森林里一级级的父子关系不是本模块的知识。
 */
import { hasList, prop, type Block } from '../model/model.ts'
import { buildAdjacency, type Adjacency } from '../relations/hierarchy.ts'
import { membersOf } from '../identity/tag-tree.ts'

/** 定义块上的**候选标签**槽（有序 ref 列表；pos ＝ 无意义，只是一组） */
export const REF_TAGS_PROP = '_refTags'

/**
 * `_refTags` 的形状判据（读路径与落盘校验共用同一份）：非空字符串数组。
 *
 * 悬空标签 id **合法**：标签删了是状态，不是坏形状（约束失效时读侧退回无约束）。
 */
export function isRefTagIds(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x !== '')
}

/** 约束的标签 id（**没有归一化、没有去重**：写路径负责，读路径只认形状） */
export function refTagIds(def: Block | undefined): readonly string[] {
  if (!def) return []
  const raw = prop<unknown>(def, REF_TAGS_PROP)
  return isRefTagIds(raw) ? (raw as string[]) : []
}

/**
 * **候选的允许集**：这些标签的成员（含下级标签闭包）并集。
 *
 * 三种答案必须分开（否则一个可用的值控件会变成死按钮）：
 *   · `null` —— **没有约束**（没写 `_refTags`，或写的标签一个都不在世了）；
 *   · 非空集合 —— 有约束，候选就这些；
 *   · 空集合 —— 有在世标签、但它们（含下级）一个成员都没有 ⇒ 诚实的「没有候选」。
 *
 * 「标签全没了退回无约束」是**软约束**的落点：约束失效不该让人选不了值，
 * 那会让一个旧定义把整条属性变成只读。反过来也不假装「没有候选」——
 * 用户看到空清单却不知道是自己删了标签，只会以为功能坏了。
 *
 * ⚠️ 每个标签各扫一遍森林（`tagMemberIds` 是 O(n)）⇒ 只在**打开选择器**时调用，
 *    不要放进逐行渲染。
 */
export function refTargetScope(
  def: Block | undefined,
  forest: readonly Block[],
  adj?: Adjacency,
): Set<string> | null {
  const ids = refTagIds(def)
  if (ids.length === 0) return null
  const byId = adj ?? buildAdjacency(forest)
  const live = ids.filter((id) => {
    const b = byId.byId.get(id)
    return b !== undefined && hasList(b, 'tag')
  })
  if (live.length === 0) return null
  const out = new Set<string>()
  for (const tagId of live) {
    for (const member of membersOf(tagId, forest, byId)) out.add(member)
  }
  return out
}

/**
 * 候选集的**标签名**（选择器标题用：用户要知道「为什么只有这几行」）。
 *
 * 返回的是**名字**不是 id：这唯一用途是把约束念给用户听。
 * 悬空标签跳过——它的名字已经不存在，念出来只会让人去找一个查不到的东西。
 */
export function refTagNames(def: Block | undefined, name: (id: string) => string): string[] {
  return refTagIds(def)
    .map((id) => name(id))
    .filter((n) => n !== '')
}
