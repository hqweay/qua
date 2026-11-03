/**
 * 装配层拼 `Run` 的那一句：**事务入口 ＋ source 兜底**。
 *
 * 编辑器、挂载区、侧槽窗口、反链卡各写了一份 `(fn, source) => run(fn, source ?? X)`，
 * 其中只有 `X` 不同。「source 缺省就别写」这一半是同一件事；兜底各不相同
 * （`ed`／`mainEd`／`edOfMount(hostId)`／惰性 getter），那是调用方的知识。
 *
 * ⚠️ `source` 不是「谁在焦点上」：它必须由**发起这次写**的那台编辑器注入，
 *    否则跨表面的一笔写会被记到活动编辑器头上，那台就跳过重画，界面停在操作前。
 *    兜底只在「编辑器之外发起的写」上生效。
 */
import type { BlockEditor, Run } from './editor.ts'

export function editorRun(run: Run, fallback: () => BlockEditor | null | undefined): Run {
  return (fn, source) => run(fn, source ?? fallback())
}
