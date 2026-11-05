/**
 * **任务状态词汇的按需物化**。
 *
 * 验收口径：值认选项 id，面板按 propId 找定义块才画得出行 —— 定义块不在的库里
 * （恢复空库只留日记、定义块被清掉）落一个待办值，不能只剩「未知属性」。
 * 物化要幂等（重复触发不翻倍），且软删的定义块占着确定性 id，不许再插第二份。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blankWorkspace } from '../src/core/fixtures/states.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { ensureTaskStatusInTx } from '../src/core/kb/ensure-task.ts'
import { BlockStore } from '../src/core/model/store.ts'
import { walkForest } from '../src/core/model/walk.ts'
import { isDeleted, mkBlock } from '../src/core/index.ts'
import { plainText, textRuns } from '../src/core/model/runs.ts'
import { taskStatusVocabulary } from '../src/core/fixtures/task-vocabulary.ts'
import {
  choicesOf,
  clearKeepsField,
  clearValue,
  fieldRows,
  findPropDef,
  hasValue,
  mkPropDef,
  TASK_STATUS_ABANDONED_ID,
  TASK_STATUS_DONE_ID,
  TASK_STATUS_DOING_ID,
  TASK_STATUS_PROP_ID,
  TASK_STATUS_TODO_ID,
  todoOf,
  uiPositionOf,
  fieldTableOf,
} from '../src/core/index.ts'

/** 修好待办值的空库：一块打了待办值的可写行（`toggleTodo` 落值之后的样子） */
function blankWithTodo() {
  const ws = blankWorkspace()
  const line = ws.blocks[0]!.children[0]!
  line.props = { [TASK_STATUS_PROP_ID]: TASK_STATUS_TODO_ID }
  return { ws, line }
}

test('按需物化：空库里落了待办值 ⇒ 定义块补进顶层，行不再是未知属性', () => {
  const { ws, line } = blankWithTodo()
  const store = new BlockStore(ws.blocks)
  const kb = new MemoryKb(store)
  assert.equal(findPropDef(store.blocks, TASK_STATUS_PROP_ID), undefined, '空库本来没有定义块')

  kb.tx((tx) => ensureTaskStatusInTx(store.blocks, tx))

  const def = findPropDef(store.blocks, TASK_STATUS_PROP_ID)
  assert.ok(def, '落值之后定义块必须在')
  assert.equal(def!.children.length, 4, 'select 的值域＝四个选项子块（待办/进行中/完成/放弃）')
  assert.equal(uiPositionOf(def!), 'block-left', '快捷入口仍画在块左侧（gutter 方框要能出现）')

  const rows = fieldRows(line, store.blocks)
  assert.deepEqual(
    rows.map((r) => r.propId),
    [TASK_STATUS_PROP_ID],
    '正好一行，就是任务状态',
  )
  assert.ok(rows[0]!.def, '有定义 ⇒ 不显示「未知属性」')
  assert.equal(rows[0]!.kind, 'select')
  assert.deepEqual(rows[0]!.choices!.map((c) => c.id), [
    TASK_STATUS_TODO_ID,
    TASK_STATUS_DOING_ID,
    TASK_STATUS_DONE_ID,
    TASK_STATUS_ABANDONED_ID,
  ])
  assert.equal(todoOf(line, fieldTableOf(store.blocks)), 'todo', '值按选项 id 读出「待办」')
})

test('按需物化：幂等 —— 已在（含软删）就一条 op 都不发，不造第二个同 id', () => {
  const { ws } = blankWithTodo()
  const store = new BlockStore(ws.blocks)
  const kb = new MemoryKb(store)

  kb.tx((tx) => ensureTaskStatusInTx(store.blocks, tx))
  const countIds = (): number => {
    let n = 0
    walkForest(store.blocks, (b) => {
      if (b.id === TASK_STATUS_PROP_ID) n++
    }, { includeDeleted: true })
    return n
  }
  assert.equal(countIds(), 1)
  kb.tx((tx) => ensureTaskStatusInTx(store.blocks, tx))
  assert.equal(countIds(), 1, '第二次触发是空操作')

  // 软删的定义块还占着确定性 id：再插一份就是两块同 id，宁可不插
  kb.tx((tx) => tx.remove(TASK_STATUS_PROP_ID))
  assert.equal(countIds(), 1, '软删不是消失：同一份还在树上')
  let deleted = false
  walkForest(store.blocks, (b) => {
    if (b.id !== TASK_STATUS_PROP_ID) return
    deleted = isDeleted(b)
    return false
  }, { includeDeleted: true })
  assert.ok(deleted, 'remove 落的是软删')
  let extraOps = -1
  const r = kb.tx((tx) => {
    ensureTaskStatusInTx(store.blocks, tx)
    return true
  })
  extraOps = r.ops.length
  assert.equal(extraOps, 0, '软删的定义块占着 id ⇒ 不插第二份')
})

test('词汇构造器：种子与按需物化共用同一份形状（确定性 id ＋ 缺省待办）', () => {
  const def = taskStatusVocabulary()
  assert.equal(def.id, TASK_STATUS_PROP_ID)
  assert.deepEqual(
    choicesOf(def).map((c) => c.id),
    [TASK_STATUS_TODO_ID, TASK_STATUS_DOING_ID, TASK_STATUS_DONE_ID, TASK_STATUS_ABANDONED_ID],
  )
  assert.ok(hasValue(def, '_default'), '缺省槽在：声明了这一栏没填的块读侧就是「待办」')
  // 选项块从 mkBlock 来，随机 id 的正常块不受影响：确认这里造的都是词汇 id
  for (const c of choicesOf(def)) assert.equal(c.children.length, 0)
  assert.ok(mkBlock('普通块').id !== TASK_STATUS_TODO_ID)
})

test('按需物化：选项补齐不重排 —— 老库的三选项定义块长出「放弃」，已有选项一个字节不动', () => {
  const { ws } = blankWithTodo()
  // 造一个「老库」：定义块只有三个选项（补齐机制落地前的形状），名字也改过
  const old = taskStatusVocabulary()
  old.children = old.children.slice(0, 3)
  old.children[2]!.content = textRuns('改过的完成')
  ws.blocks.push(old)

  const store = new BlockStore(ws.blocks)
  const kb = new MemoryKb(store)
  const r = kb.tx((tx) => {
    ensureTaskStatusInTx(store.blocks, tx)
    return true
  })
  assert.equal(r.ops.length, 1, '只补缺的那一格')

  const def = findPropDef(store.blocks, TASK_STATUS_PROP_ID)!
  assert.deepEqual(
    choicesOf(def).map((c) => c.id),
    [TASK_STATUS_TODO_ID, TASK_STATUS_DOING_ID, TASK_STATUS_DONE_ID, TASK_STATUS_ABANDONED_ID],
    '「放弃」追加到末尾，顺序不变',
  )
  // 改过的显示名还在：补齐只负责值域里有这一格，不负责长成什么样
  assert.equal(plainText(choicesOf(def)[2]!.content), '改过的完成')
})

test('清空值停在「待填」：给了缺省的定义，清空留栏不摘栏；取消待办才真摘', () => {
  const { ws, line } = blankWithTodo()
  line.props = {
    [TASK_STATUS_PROP_ID]: TASK_STATUS_TODO_ID,
    _ownProps: [TASK_STATUS_PROP_ID],
  }
  ws.blocks.push(taskStatusVocabulary())
  const store = new BlockStore(ws.blocks)
  const kb = new MemoryKb(store)

  const rows = () => fieldRows(line, store.blocks)
  assert.equal(rows().length, 1)

  // 面板「清空」（keepField）：值没了、行还在（待填），读侧缺省「待办」
  kb.tx((tx) => tx.patch(line.id, (b) => clearValue(b, TASK_STATUS_PROP_ID, { keepField: true })))
  const row = rows()[0]!
  assert.ok(row.def, '行还在 ⇒ 不是「未知属性」')
  assert.equal(row.filled, false, '值空了 ⇒ 显示「待填」')
  assert.equal(todoOf(line, fieldTableOf(store.blocks)), 'todo', '读缺省：仍是没做完的任务')

  // 「取消待办」（默认清空）：值连自有槽一起走，整栏消失
  kb.tx((tx) => tx.patch(line.id, (b) => clearValue(b, TASK_STATUS_PROP_ID)))
  assert.deepEqual(rows(), [], '摘栏后不再有这一行')
  assert.equal(todoOf(line, fieldTableOf(store.blocks)), undefined, '块不再是一个任务')

  // 值先于槽写入的旧块（没有登记过槽）：清空（keepField）也把槽补上，行不消失
  const legacy = mkBlock('旧数据')
  legacy.props = { [TASK_STATUS_PROP_ID]: TASK_STATUS_DONE_ID }
  ws.blocks[0]!.children.push(legacy)
  kb.tx((tx) => tx.patch(legacy.id, (b) => clearValue(b, TASK_STATUS_PROP_ID, { keepField: true })))
  assert.equal(fieldRows(legacy, store.blocks).length, 1, '旧块的行同样留在「待填」')
})

test('clearKeepsField：判据在定义的缺省槽，不在 propId', () => {
  assert.equal(clearKeepsField(taskStatusVocabulary()), true, '任务状态给了缺省 ⇒ 清空留栏')
  assert.equal(clearKeepsField(mkPropDef('备注', 'text')), false, '没有缺省的定义 ⇒ 清空仍连槽一起走')
  assert.equal(clearKeepsField(undefined), false, '悬空定义 ⇒ 按普通自有栏处理')
})
