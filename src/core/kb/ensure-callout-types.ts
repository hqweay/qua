/**
 * 引述类型表的**事务内**读写口：隐藏单例块的按需物化 ＋ 记录数组的一次替换。
 *
 * 为什么要有这一层：类型表挂在固定 id 的块上，而「块不存在」在旧库里是常态。
 * 第一次改类型时要把它建出来；建与写必须**同一笔事务**，否则会留下
 * 「表建了、改动没落」或「值指向一个没有定义的 id」的半批。
 *
 * 三条纪律：
 *   · **判存在要含软删**：确定性 id 意味着同一 id 只能有一个身份；
 *     软删的那份还在树上，再插一份就是两块同 id —— 宁可不写，也不造第二个身份。
 *   · **新块在 insert 时一次成型**：事务内的 `patch` 对同一笔新插入的块会拒绝
 *     （它没有改前状态），所以「首建 ＋ 本笔改动」要合并成一次 `insert`。
 *   · **本文件不判业务**：重名／空名／缺省类型不可删这些规则在命令层；
 *     这里只回答「表在哪、现在的记录是什么」。
 *
 * ⚠️ 每一笔写都经 `tx`：直接改活块不进 op，落盘会得到「值落了、表没建」的半批。
 */
import { walkForest } from '../model/walk.ts'
import { isDeleted, type Block } from '../model/model.ts'
import { CALLOUT_TYPES_BLOCK_ID, builtinCalloutTypes, toCalloutRecords, type CalloutType } from '../infra/callout.ts'
import { CALLOUT_TYPES_PROP } from '../model/model.ts'
import { parseChoices } from '../props/choices.ts'
import type { Tx } from './types.ts'

/** 按 id 找一块，**含软删**（确定性 id 的存在性只能这样判） */
export function findCalloutTypesBlock(forest: readonly Block[]): Block | undefined {
  let found: Block | undefined
  walkForest(
    forest,
    (b) => {
      if (b.id !== CALLOUT_TYPES_BLOCK_ID) return
      found = b
      return false
    },
    { includeDeleted: true },
  )
  return found
}

/** 注册表块上的记录（形状坏了 / 还没物化 ⇒ 内置表：写侧也从这一份起手） */
export function calloutTypesIn(block: Block | undefined): CalloutType[] {
  if (!block) return builtinCalloutTypes()
  const parsed = parseChoices(block.props?.[CALLOUT_TYPES_PROP])
  if (!parsed || parsed.length === 0) return builtinCalloutTypes()
  return parsed.map((c) => ({
    id: c.id,
    label: c.label,
    icon: c.icon ?? '',
    ...(c.color !== undefined ? { color: c.color } : {}),
    ...(c.deleted ? { deleted: true as const } : {}),
  }))
}

/** 首建的那一块（无正文／别名／露面：它不参与组织，只承载记录） */
export function mkCalloutTypesBlock(records: readonly CalloutType[]): Block {
  const now = Date.now()
  return {
    id: CALLOUT_TYPES_BLOCK_ID,
    content: [],
    children: [],
    created: now,
    modified: now,
    props: { [CALLOUT_TYPES_PROP]: toCalloutRecords(records) },
  }
}

/** 一笔改写的结局：`deleted` ⇒ 表被软删（不写、也不复活：恢复是回收站的事） */
export type CalloutTypesWriteOutcome = 'ok' | 'deleted'

/**
 * 在一次事务里把类型表改成 `mutate(现在)` 的结果。
 *
 * 表不在 ⇒ 首建（把本笔的改动一起长进去）；表在 ⇒ 一次属性写。
 * 返回 `deleted` 时**一条 op 都不发**。
 */
export function writeCalloutTypesInTx(
  forest: readonly Block[],
  tx: Tx,
  mutate: (records: CalloutType[]) => CalloutType[],
): CalloutTypesWriteOutcome {
  const block = findCalloutTypesBlock(forest)
  if (block && isDeleted(block)) return 'deleted'
  if (!block) {
    tx.insert(mkCalloutTypesBlock(mutate(builtinCalloutTypes())), null, forest.length)
    return 'ok'
  }
  const next = mutate(calloutTypesIn(block))
  tx.setProp(block.id, CALLOUT_TYPES_PROP, toCalloutRecords(next))
  return 'ok'
}
