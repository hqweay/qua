/**
 * **投影上的关闭态**：把「这块关闭了没有」盖到投影盒子上（`data-closure`）。
 *
 * 为什么需要它：表格／大纲表格／卡片／日历里的正文是**投影**（一段 run 序列），
 * 而删除线原来只挂在编辑器那层整行 `.blk[data-closure='closed']` 上 ——
 * 于是同一块「没聚焦时像普通块，点进去才有删除线」，两个状态各说一套。
 *
 * 三条口径：
 *   · **判据只有一份**：`core/props.ts` 的 `closureOf`（库级唯一的 status 定义 ＋ 标签声明）。
 *     在渲染器里各判一次会得到第二份答案，且都会漏掉「标签声明」那一半。
 *   · **一个注入点**：装配层的 `project` 是表格／卡片／日历／导图共用的投影入口，
 *     盖在这里，所有表面一起对齐（不是在每种视图里各补一次）。
 *   · **字段表随写作废、懒重建**：逐格现建要扫整片森林（`fieldTableOf` 两趟），
 *     一屏几十格就是 O(n²)。与编辑器同一口径：任何一次模型写之后作废，下一次问到再建。
 */
import {
  closureMarkOf,
  closureOf,
  fieldTableOf,
  hasAnyFieldOf,
  type Block,
  type BlockStore,
  type FieldTable,
  type RefView,
} from '../../core/index.ts'

/**
 * 造一个「把关闭态盖到投影上」的函数。
 *
 * 写 `data-closure` 的两态（`open`／`closed`）而不是只写 closed：CSS 现在只用 closed，
 * 但「这一行有关闭态、还没关闭」本来就是一个可断言的读数（与大纲的 `data-closure` 同一套名字）。
 */
export function createClosureStamp(store: BlockStore): (block: Block, into: HTMLElement) => void {
  let table: FieldTable | null = null
  store.subscribe(() => {
    table = null
  })
  return (block, into) => {
    table ??= fieldTableOf(store.blocks)
    const closure = closureOf(block, table)
    if (closure === undefined) delete into.dataset.closure
    else into.dataset.closure = closure
  }
}

/**
 * 投影用的**行内元信息**：目标有没有字段、有没有 closure 状态。
 *
 * 与编辑器 `render-ops.ts` 的 `refMetaOf` 同一份判据、同一条失效轴（写一次作废、下次现建）。
 * 差别只是它住在装配层：投影入口 `main.ts` 的 `project` 是卡片／表格／列表／导图共用的那一处，
 * 在这里补上 refMeta，投影里的实例才长得与正文行一样（有字段手柄／状态标记），
 * 而不是「点进编辑才有、读的时候没有」。
 */
export function createProjectionRefMeta(store: BlockStore): (id: string) => Pick<RefView, 'fields' | 'closure'> | undefined {
  let table: FieldTable | null = null
  store.subscribe(() => {
    table = null
  })
  const find = (id: string) => store.find(id)
  return (id) => {
    const target = find(id)
    if (!target) return undefined
    table ??= fieldTableOf(store.blocks)
    const fields = hasAnyFieldOf(target, find)
    if (!fields) return { fields: false }
    const closure = closureMarkOf(target, table, find)
    return { fields: true, ...(closure ? { closure } : {}) }
  }
}
