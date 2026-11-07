/**
 * **投影上的任务完成态**：把「这块做完了没有」盖到投影盒子上（`data-todo`）。
 *
 * 为什么需要它：表格／大纲表格／卡片／日历里的正文是**投影**（一段 run 序列），
 * 而删除线原来只挂在编辑器那层整行 `.blk[data-todo='done']` 上 ——
 * 于是同一块「没聚焦时像普通块，点进去才有删除线」，两个状态各说一套。
 *
 * 三条口径：
 *   · **判据只有一份**：`core/props.ts` 的 `todoOf`（库级唯一的 status 定义 ＋ 标签声明）。
 *     在渲染器里各判一次会得到第二份答案，且都会漏掉「标签声明」那一半。
 *   · **一个注入点**：装配层的 `project` 是表格／卡片／日历／导图共用的投影入口，
 *     盖在这里，所有表面一起对齐（不是在每种视图里各补一次）。
 *   · **字段表随写作废、懒重建**：逐格现建要扫整片森林（`fieldTableOf` 两趟），
 *     一屏几十格就是 O(n²)。与编辑器同一口径：任何一次模型写之后作废，下一次问到再建。
 */
import { fieldTableOf, todoOf, type Block, type BlockStore, type FieldTable } from '../../core/index.ts'

/**
 * 造一个「把任务态盖到投影上」的函数。
 *
 * 写 `data-todo` 的两态（`todo`／`done`）而不是只写 done：CSS 现在只用 done，
 * 但「这块是任务、还没做完」本来就是一个可断言的读数（与大纲的 `data-todo` 同一套名字）。
 */
export function createTodoStamp(store: BlockStore): (block: Block, into: HTMLElement) => void {
  let table: FieldTable | null = null
  store.subscribe(() => {
    table = null
  })
  return (block, into) => {
    table ??= fieldTableOf(store.blocks)
    const todo = todoOf(block, table)
    if (todo === undefined) delete into.dataset.todo
    else into.dataset.todo = todo
  }
}
