/**
 * **用途是开放命名空间，不是封闭枚举**：`_use` 收得下 `priority`、`closure:reading`
 * 这类新用途，而已经存在的关闭态判据（`closureOf`）、`⌘↵` 目标、投影划线一个字不改。
 *
 * 这条单测盯的是「隔离」而不是「功能」：新增一个用途只该改变它自己的读数，
 * 不该让别的用途的消费者看见它——那是用户看不见的优先级规则。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Block } from '../src/core/index.ts'
import {
  CHECK_PROP,
  CLOSURE_USE,
  DEFAULT_PROP,
  OWN_PROPS_PROP,
  UI_POSITION_PROP,
  USE_PROP,
  closureOf,
  closureTargetField,
  consumersOf,
  fieldTableOf,
  gutterFieldsOf,
  hasConsumer,
  isUseId,
  isUseValue,
  mkBlock,
  mkPropDef,
  registerConsumer,
  registerUse,
  useSpecOf,
  useTakenBy,
  useValue,
  setChoices,
  slotUseOf,
  TASK_STATUS_DONE_ID,
  TASK_STATUS_PROP_ID,
  TASK_STATUS_TODO_ID,
  useOf,
} from '../src/core/index.ts'
import { systemPropViolation } from '../src/core/props/system-props.ts'
import { taskStatusVocabulary } from '../src/core/fixtures/task-vocabulary.ts'

// 新用途的登记就是它参与语义的全部动作；不登记也存得下（见第一条）。
registerUse({ id: 'priority' })

/** 一条「优先级」定义：普通 select ＋ 用途 ＋ 勾选框映射，形状与关闭态一样 */
function priorityDef(id?: string): Block {
  const def = mkPropDef(
    '优先级',
    'select',
    {
      [UI_POSITION_PROP]: 'block-left',
      [USE_PROP]: 'priority',
      [CHECK_PROP]: { on: 'p-high', off: 'p-low' },
    },
    id,
  )
  setChoices(def, [
    { id: 'p-low', label: '低' },
    { id: 'p-high', label: '高' },
  ])
  return def
}

test('用途 id 是命名空间：合法语法收下，写/读都不要求先登记', () => {
  assert.equal(isUseId('closure'), true)
  assert.equal(isUseId('priority'), true)
  assert.equal(isUseId('closure:reading'), true, '命名空间分段是语法的一部分')
  assert.equal(isUseId(''), false)
  assert.equal(isUseId('Priority'), false, '不收大小写变体')
  assert.equal(isUseId('closure:'), false, '空段不算语法')
  assert.equal(isUseId('closure::reading'), false)

  // 未登记的用途照样是数据：形状闸放行、`useOf` 读得出。
  assert.equal(isUseValue('priority'), true)
  assert.equal(systemPropViolation(USE_PROP, 'priority'), null, '写入口认这个用途')
  assert.equal(systemPropViolation(USE_PROP, 'Priority'), 'invalid value for system prop "_use"')
  const unregistered = mkPropDef('评分', 'select', { [USE_PROP]: 'rating' })
  assert.equal(useOf(unregistered), 'rating', '读路径不为「谁登记过」分叉')
})

test('useValue 与 closureOf 走同一份 readField：值、缺省、没有这一栏三态不漂移', () => {
  const def = mkPropDef('优先级', 'select', {
    [USE_PROP]: 'priority',
    [DEFAULT_PROP]: 'p-low',
  })
  setChoices(def, [
    { id: 'p-low', label: '低' },
    { id: 'p-high', label: '高' },
  ])
  const filled = mkBlock('有值')
  filled.props = { [def.id]: 'p-high' }
  const fresh = mkBlock('声明了没填')
  fresh.props = { [OWN_PROPS_PROP]: [def.id] }
  const none = mkBlock('没有这一栏')
  const table = fieldTableOf([def, filled, fresh, none])

  assert.equal(useValue(filled, 'priority', table), 'p-high')
  assert.equal(useValue(fresh, 'priority', table), 'p-low', '未填读定义缺省（与 readField 同一答案）')
  assert.equal(useValue(none, 'priority', table), undefined)
  assert.equal(useValue(filled, 'rating', table), undefined, '没有这个用途的定义 ⇒ 缺席')
})

test('新增 priority 不碰 closure：判据、⌘↵、投影划线三个读法都只认关闭态', () => {
  const status = taskStatusVocabulary()
  const priority = priorityDef()
  const host = mkBlock('一条')
  host.props = { [priority.id]: 'p-high' }
  const forest = [status, priority, host]
  const table = fieldTableOf(forest)

  // 判据：这一行没有 closure 那一栏（priority 只是它自己的用途）
  assert.equal(closureOf(host, table), undefined)
  // 投影/划线读的是同一个 closureOf（见装配层的投影入口）⇒ 上面这条就是「不划线」
  // ⌘↵：priority 虽然带 `_check`，但不是 keymap 槽的用途
  const fields = gutterFieldsOf(host, forest)
  assert.equal(fields.find((f) => f.propId === priority.id)?.use, 'priority')
  assert.equal(closureTargetField(fields), undefined, '⌘↵ 不切非关闭态的用途')
})

test('closure 现有行为零变化：完成/待办/没有这一栏，⌘↵ 仍认任务状态', () => {
  const status = taskStatusVocabulary()
  const done = mkBlock('做完')
  done.props = { [status.id]: TASK_STATUS_DONE_ID }
  const todo = mkBlock('没做完')
  todo.props = { [status.id]: TASK_STATUS_TODO_ID }
  const none = mkBlock('不是任务')
  const table = fieldTableOf([status, done, todo, none])

  assert.equal(closureOf(done, table), 'closed')
  assert.equal(closureOf(todo, table), 'open')
  assert.equal(closureOf(none, table), undefined)
  assert.equal(closureTargetField(gutterFieldsOf(done, [status, done]))?.propId, TASK_STATUS_PROP_ID)
})

test('命名空间前缀不继承语义：closure:reading 是另一个用途，不是关闭态', () => {
  const def = mkPropDef('读完了', 'select', {
    [USE_PROP]: 'closure:reading',
    [CHECK_PROP]: { on: 'r-done', off: 'r-todo' },
  })
  setChoices(def, [
    { id: 'r-todo', label: '未读' },
    { id: 'r-done', label: '读完' },
  ])
  const host = mkBlock('一本书')
  host.props = { [def.id]: 'r-done' }
  const table = fieldTableOf([def, host])

  assert.equal(closureOf(host, table), undefined, '前缀只表达同族，不自动成为关闭态')
  assert.equal(useValue(host, 'closure:reading', table), 'r-done')
  assert.equal(useValue(host, CLOSURE_USE, table), undefined)
})

test('注册表：唯一性只对登记成 unique 的用途生效；后来的 keymap 消费者不抢 ⌘↵', () => {
  assert.equal(useSpecOf('priority')?.unique, undefined, '优先级不是库级唯一')
  assert.equal(useTakenBy([priorityDef()], 'priority', 'another-def'), undefined)

  const status = taskStatusVocabulary()
  assert.equal(useTakenBy([status], CLOSURE_USE, 'another-def')?.id, status.id)
  assert.equal(useTakenBy([status], CLOSURE_USE, status.id), undefined, '自己不算占用')

  // 关闭态先登记：后注册的 keymap 消费者只进名单，不改「⌘↵ 切哪个」
  assert.equal(hasConsumer(CLOSURE_USE, 'keymap'), true)
  const before = slotUseOf('keymap')
  registerConsumer({ useId: 'priority', slot: 'keymap' })
  assert.equal(slotUseOf('keymap'), before)
  assert.deepEqual(consumersOf('keymap').slice(0, 2), [CLOSURE_USE, 'priority'])
})
