/**
 * **`ref` 的旧候选域形状**：`_refTags`（一组标签 id）。
 *
 * 新写入走 `_refDomain`（`./ref-domain.ts` 的判别联合，标签只是其中一档）；
 * 这一格只留给已经存在的库：读侧把它当「标签档」认（`refDomainOf` 那一处唯一的翻译），
 * 写侧在第一次写候选域时把它清掉。
 *
 * ## 形状判据为什么还留着
 *
 * 系统键登记表要能收端旧库与旧 op_log：**坏形状判坏、悬空 id 合法**——标签删了是状态，
 * 不是形状错误。没有这一格登记，读盘校验会把整个库判 corrupt。
 */
import { prop, type Block } from '../model/model.ts'

/** 定义块上的**候选标签**槽（有序 ref 列表；pos ＝ 无意义，只是一组） */
export const REF_TAGS_PROP = '_refTags'

/**
 * `_refTags` 的形状判据（读路径与落盘校验共用同一份）：字符串数组。
 *
 * 空数组**合法**（旧写路径用它表达「摘掉约束」）；本轮之后新的候选域不允许空数组
 * （`[]` 与缺席是两件事，见 `isRefDomainValue`）。
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
 * **ref 定义上的「默认看法」槽**：值行画**引用**（名字，可跳）还是**正文岛**
 * （目标块的正文就地编辑，深度 1——只编辑正文、子树不展开）。
 *
 * 这是**看法**不是值：`props[propId]` 的块 id 一个字节不动，换看法零迁移。
 * 缺省 `chip`——「原地改正文」是少数场景，多数 ref 值要的只是一个可跳的名字；
 * 岛的账（编辑器、重载、重建守卫）要显式打开才付。坏值回落 `chip`：
 * 手写数据不该让值行整行失效。
 */
export const REF_VIEW_PROP = '_refView'

/** 看法全集；写路径限这两枚，读侧只认这两枚（其余按缺省）。与正文引用的看法（`relations/ref.ts` 的 `RefView`）不是一个东西，所以名字分开 */
export type RefDefView = 'chip' | 'inline'

/** 看法的形状判据（写路径发看点与系统键登记表共用这一份） */
export function isRefViewValue(v: unknown): v is RefDefView {
  return v === 'chip' || v === 'inline'
}

