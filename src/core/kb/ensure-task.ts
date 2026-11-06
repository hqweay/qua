/**
 * 「任务状态」词汇的**事务内**按需物化：定义块 ＋ 选项（与 `ensureTagInTx` 同一条纪律）。
 *
 * 为什么需要它：任务状态值认的是**选项块 id**，而属性面板按 propId 找定义块才能
 * 画出一行。定义块只在满态种子里物化——库被清空过（恢复空库只留日记）、或定义块
 * 本身被清掉的库里没有它；这时往块上落一个待办值，面板只剩「未知属性」，
 * 方框、看板、种子查询也都认不出这个值。
 *
 * 选项**补齐不重排**：定义块在但值域缺某个选项（老库只有三个选项）⇒ 把缺的
 * 追加到末尾，已有的一个字节不动——用户可能改过选项名或顺序，补齐只负责
 * 「值域里得有这一格」，不负责「长成什么样」。
 *
 * 与标签同一条判据：**身份块在第一次被用到时物化在森林顶层**——位置对定义不承载
 * 信息，树操作会把住在子树里的定义当货物搬走。
 *
 * ⚠️ 每一笔写都经 `tx`：直接改活块不进 op，落盘会得到「值落了、定义没建」的半批。
 * ⚠️ 判存在要**含软删**：定义块与选项都按确定性 id 取身份，软删的那份还在树上，
 *    再插一份同 id 的就是两块同 id——宁可不插不补（那一行退回「未知属性」的旧样子），
 *    不造出第二个身份。恢复进回收站里的定义块是回收站路径的事。
 */
import { walkForest } from '../model/walk.ts'
import { isDeleted, type Block } from '../model/model.ts'
import {
  CHECK_PROP,
  TASK_STATUS_CHOICE_IDS,
  TASK_STATUS_DONE_ID,
  TASK_STATUS_PROP_ID,
  TASK_STATUS_TODO_ID,
  USE_PROP,
  checkOf,
  useOf,
} from '../props/props.ts'
import { taskStatusChoices, taskStatusVocabulary } from '../fixtures/task-vocabulary.ts'
import type { Tx } from './types.ts'

/** 按 id 找一块，**含软删**。确定性 id 意味着存在性可以按 id 判 */
function findByIdInclDeleted(forest: readonly Block[], id: string): Block | undefined {
  let found: Block | undefined
  walkForest(
    forest,
    (b) => {
      if (b.id !== id) return
      found = b
      return false
    },
    { includeDeleted: true },
  )
  return found
}

/**
 * 保证「任务状态」定义块（连选项）在森林顶层、值域里每个选项都在，
 * **写路径全部走 `tx`**。已在 ⇒ 只补缺的选项；全在 ⇒ 一条 op 都不发。幂等。
 */
export function ensureTaskStatusInTx(forest: readonly Block[], tx: Tx): void {
  const def = findByIdInclDeleted(forest, TASK_STATUS_PROP_ID)
  if (!def) {
    tx.insert(taskStatusVocabulary(), null, forest.length)
    return
  }
  // 软删的定义块占着 id：不往回收站里的块补选项，也不插第二份
  if (isDeleted(def)) return
  /**
   * 定义块在、但语义/显示映射缺了（旧版本物化的那一份）：同一笔事务补上。
   * 这不是迁移数据——只补两个系统键，值一个字节不动。
   */
  if (useOf(def) !== 'status' || checkOf(def) === undefined) {
    tx.patch(def.id, (b) => {
      b.props = {
        ...(b.props ?? {}),
        [USE_PROP]: 'status',
        [CHECK_PROP]: { on: TASK_STATUS_DONE_ID, off: TASK_STATUS_TODO_ID },
      }
    })
  }
  const have = new Set(def.children.map((c) => c.id))
  const wanted = new Map(taskStatusChoices().map((c) => [c.id, c]))
  for (const id of TASK_STATUS_CHOICE_IDS) {
    if (have.has(id)) continue
    const choice = wanted.get(id)
    if (choice) tx.insert(choice, def.id, def.children.length)
  }
}
