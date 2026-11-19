/**
 * **同步创建入口的「先核定再重放」闸**。
 *
 * 事务与命令面都是同步的，而「这个名字在库里归谁」在部分装载下是**异步**答案
 * （`BlockStore.aliasState` 的 `unchecked`）。闸把两件事分开：
 *
 * - 名字的归属已经确定（`owned`／`absent`，或整库模式）⇒ 返回 `false`，调用方照常往下走；
 * - 还没核定 ⇒ 去问一次库，回来**重放这次动作**，返回 `true`（这次已被接住）。
 *
 * 为什么不能在事务里等：`Tx` 是同步的；把 await 留在入口这一层，判据（不许建第二个
 * 同名身份）就仍然住在 `ensureTagInTx`／`ensurePageInTx` 里，一处都不用改。
 * 「问不到」（库读失败）不重放：留成 `unchecked`，动作这次不做，下次再按还能再问。
 *
 * 每次打开过程中，每个名字只会走这一趟（问到的答案在 store 里成为定论）。
 */
import type { AliasState } from './types.ts'

/**
 * 闸只需要两格能力；`BlockStore` 与 `KbClient` 都天然满足（编辑器持前者、命令持后者）。
 */
export interface AliasGateWorld {
  aliasState(name: string): AliasState
  prepareAlias?(names: readonly string[]): Promise<void>
}

export function deferAliasGate(world: AliasGateWorld, name: string, replay: () => void): boolean {
  if (name.trim() === '') return false
  if (world.aliasState(name).kind !== 'unchecked') return false
  if (!world.prepareAlias) return false
  // 方法调用保留接收者：两边的实现都靠 `this`（store 的事实表）
  void world.prepareAlias([name]).then(() => {
    if (world.aliasState(name).kind === 'unchecked') return
    replay()
  })
  return true
}
