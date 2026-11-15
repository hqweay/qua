/**
 * **`⌘↵` 切哪一格**：只有库级唯一的任务状态（`_use: 'status'` ＋ `_check`）。
 *
 * 这条判据单块与批量共用。真踩过的两难：一行上可能同时有「任务状态」和一个长得
 * 一样的布尔开关（或一个 `_check` 的两态选项）——按「第一个方框」取，就是一条
 * 用户看不见的优先级规则；`⌘↵` 到底切了哪个，没人能解释。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Block } from '../src/core/index.ts'
import {
  CHECK_PROP,
  UI_POSITION_PROP,
  declareField,
  gutterFieldsOf,
  mkBlock,
  mkPropDef,
  mkTagBlock,
  setChoices,
  closureTargetField,
} from '../src/core/index.ts'
import { TASK_STATUS_PROP_ID, TASK_STATUS_DONE_ID, TASK_STATUS_TODO_ID } from '../src/core/index.ts'
import { taskStatusVocabulary } from '../src/core/fixtures/task-vocabulary.ts'

const gutter = (host: Block, forest: readonly Block[]) => gutterFieldsOf(host, forest)

test('任务状态在 ⇒ ⌘↵ 只认它（同一行还有布尔开关也不抢）', () => {
  const status = taskStatusVocabulary()
  const switchDef = mkPropDef('已读', 'checkbox', { [UI_POSITION_PROP]: 'block-left' })
  const host = mkBlock('一条')
  host.props = { [status.id]: TASK_STATUS_TODO_ID, [switchDef.id]: true }
  const fields = gutter(host, [status, switchDef, host])
  assert.equal(fields.length, 2, '前置：两枚都画在块标后')
  assert.equal(closureTargetField(fields)?.propId, TASK_STATUS_PROP_ID, '有任务状态时 ⌘↵ 必须切它，而不是那个布尔开关')
})

test('没有任务状态 ⇒ ⌘↵ 不切任何普通两态字段（调用方会先把它变成任务）', () => {
  const switchDef = mkPropDef('已读', 'checkbox', { [UI_POSITION_PROP]: 'block-left' })
  const twoState = mkPropDef('状态', 'select', { [UI_POSITION_PROP]: 'block-left' })
  setChoices(twoState, [
    { id: 'c-todo', label: '未读' },
    { id: 'c-done', label: '已读' },
  ])
  const def = { ...twoState, props: { ...(twoState.props ?? {}), [CHECK_PROP]: { on: 'c-done', off: 'c-todo' } } }
  const host = mkBlock('一条')
  host.props = { [switchDef.id]: true, [def.id]: 'c-todo' }
  const fields = gutter(host, [switchDef, def, host])
  assert.equal(fields.length, 2, '前置：开关与两态选项都在 gutter 上')
  assert.equal(closureTargetField(fields), undefined, '普通两态（布尔开关／无 use 的 _check）都不是 ⌘↵ 的目标')
})

test('status 少了 `_check` ⇒ 不认（坏形状不猜，宁可按「还不是任务」处理）', () => {
  const broken = taskStatusVocabulary()
  const props = { ...(broken.props ?? {}) }
  delete props[CHECK_PROP]
  broken.props = props
  const host = mkBlock('一条')
  host.props = { [TASK_STATUS_PROP_ID]: TASK_STATUS_DONE_ID }
  assert.equal(closureTargetField(gutter(host, [broken, host])), undefined)
})

test('标签声明来的任务字段同样可被 ⌘↵ 命中（判据是定义，不是「本块拥有」）', () => {
  const status = taskStatusVocabulary()
  const tag = mkTagBlock('任务')
  declareField(tag, status.id)
  const host = mkBlock('一条')
  host.props = { _tags: [tag.id] }
  const fields = gutter(host, [status, tag, host])
  assert.equal(fields.length, 1, '前置：标签声明让这一行长出任务状态')
  assert.equal(closureTargetField(fields)?.propId, TASK_STATUS_PROP_ID)
})
