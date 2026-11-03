import type { Block } from '../../core/index.ts'

/** 一个行身体实例：`root` 是它的 DOM（搬家时整棵挪走），`dispose` 是真拆 */
export interface RowBody {
  root: HTMLElement
  dispose(): void
}

/**
 * **行身体的实例缓存**：同一块的行身体要跨「行重画」活下来。
 *
 * 为什么需要：任何外来编辑（右槽敲字、命令层的属性写入…）都会让编辑器
 * `reloadFromStore` → `renderAll` —— 整屏行重建，而行身体（查询体）的容器是
 * 行 DOM 的一部分 ⇒ 裸挂载会在每次外来编辑时把 ViewHost 销毁重建：
 * 冻结成员被静默重算（违反「成员只在刷新/条件变时重算」）、stale 提示清零、
 * 滚动位置丢失，而且每次敲字都是一整轮重建。
 *
 * 判据与段尾宿主时代同一条：**实例属于块，DOM 容器随表面换** —— 装配层当年
 * 靠「搬家不重建」幸免；身体搬进里之后，同一条判据搬到这里。
 *
 * 生命周期：编辑器在换 DOM 前调返回的 disposer —— 那可能是「真卸载」，也可能是
 * 「马上就要重新挂上」的前半步（行重建就是后者：先 disposeAll，再同一任务里
 * 逐行重新 open）。区分办法只有时间：**延后一拍**（microtask）再拆；同一任务里
 * 重新 `open` 的会取消这次拆卸。真卸载（块离开屏幕／换库）没有下一次 open，
 * 下一拍就拆 —— 订阅与编辑器不会泄漏。
 *
 * 契约：**首挂的落容器由 `mount` 工厂负责**（它自己把 root 放进 `into`）；
 * 缓存只管**搬家**（重画时把 root 挪进新容器）。
 */
export function createRowBodyCache(
  mount: (block: Block, into: HTMLElement) => RowBody,
  /** 缓存键（默认＝块 id）：身体的「形状」会变时把形状编进键里（如露面的镜像 ⇄ 投影） */
  keyOf: (block: Block) => string = (b) => b.id,
): (block: Block, into: HTMLElement) => () => void {
  interface Entry {
    body: RowBody
    pending: boolean
  }
  const live = new Map<string, Entry>()
  return (block, into) => {
    const key = keyOf(block)
    let e = live.get(key)
    if (!e) {
      e = { body: mount(block, into), pending: false }
      live.set(key, e)
    } else {
      e.pending = false
      // 整棵搬（连同滚动位置／冻结结果／焦点子树），不重建
      into.appendChild(e.body.root)
    }
    const entry = e
    return () => {
      if (entry.pending) return
      entry.pending = true
      queueMicrotask(() => {
        if (!entry.pending) return // 这一轮行重建已经把它接回屏幕
        live.delete(key)
        entry.body.dispose()
      })
    }
  }
}
