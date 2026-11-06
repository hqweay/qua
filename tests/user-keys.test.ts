/**
 * **用户覆盖键位**（设备态注入绑定层）的纯逻辑测试。
 *
 * 这里钉的是三件界面上很难看清的事：
 *   ① 覆盖在读的时候生效：resolveKey 按新键命中、摘掉的按键不再命中；
 *   ② 身份＝命令＋参数：同一条命令因参数不同而有的多个动作各改各的；
 *   ③ 校验判据：裸键与保留键进不来（设置了也白设的键位不发给用户）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BINDINGS,
  bindingIdOf,
  canonKey,
  effectiveKey,
  keymapRows,
  keymapSettingsRows,
  resolveKey,
  setUserKeys,
  validateUserKey,
  type Binding,
} from '../src/core/infra/bindings.ts'
import type { CtxKeys } from '../src/core/index.ts'

const keyOf = (command: string, args?: unknown): Binding | undefined =>
  BINDINGS.find((b) => b.kind === 'keymap' && b.command === command && JSON.stringify(b.args ?? null) === JSON.stringify(args ?? null))

/** 键位解析的上下文：给一个「编辑器聚焦」的最小集（undo 的 when 只问这一件事） */
const ctx = (extra: Partial<CtxKeys> = {}): CtxKeys => ({ editorTextFocus: true, ...extra }) as CtxKeys

test('覆盖在读时生效：换键按新键命中，摘掉不再命中', () => {
  setUserKeys({})
  const undo = keyOf('core.history/undo')!
  assert.ok(undo)
  const ev = (key: string) => ({ key, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }) as KeyboardEvent

  // 换键：⌘Z 让给别人，undo 改到 ⌘U
  setUserKeys({ [bindingIdOf(undo)]: 'mod+u' })
  assert.equal(resolveKey(ev('u'), ctx(), true).hit?.command, 'core.history/undo')
  assert.equal(resolveKey(ev('z'), ctx(), true).hit, null, '旧键不再命中（覆盖是替换，不是追加）')

  // 摘掉：按键落空
  setUserKeys({ [bindingIdOf(undo)]: null })
  assert.equal(resolveKey(ev('u'), ctx(), true).hit, null)

  setUserKeys({})
  assert.equal(resolveKey(ev('z'), ctx(), true).hit?.command, 'core.history/undo', '清掉覆盖回到表里的键')
})

test('身份＝命令＋参数：同一条命令的多个动作各改各的', () => {
  setUserKeys({})
  // insert-block 有「待办」（args.type=todo）与「分割线」（args.type=divider）两条键位同族，
  // 但 keymap 里它们没绑键位——用 journal/review（3 天与 7 天两条、args 不同）当试金石
  const three = keyOf('core.journal/review', { days: 3 })!
  const seven = keyOf('core.journal/review', { days: 7 })!
  assert.ok(three && seven)
  assert.notEqual(bindingIdOf(three), bindingIdOf(seven))

  setUserKeys({ [bindingIdOf(three)]: 'mod+alt+3' })
  assert.equal(effectiveKey(three), 'mod+alt+3')
  assert.equal(effectiveKey(seven), seven.key, '另一档的键位不受牵连')

  setUserKeys({ [bindingIdOf(three)]: null })
  assert.equal(effectiveKey(three), null)
  assert.equal(effectiveKey(seven), seven.key)
  setUserKeys({})
})

test('键位速查与设置清单都按生效值报（同一身份覆盖后只念一行）', () => {
  setUserKeys({})
  const undo = keyOf('core.history/undo')!
  const redo = keyOf('core.history/redo')! // 表里两条：⌘⇧Z 与 ⌘Y，同一身份
  const rows0 = keymapRows().filter((r) => r.command === 'core.history/redo')
  assert.equal(rows0.length, 2, '前置：redo 在表里就是两条')

  setUserKeys({ [bindingIdOf(redo)]: 'mod+r' })
  const rows = keymapRows().filter((r) => r.command === 'core.history/redo')
  assert.deepEqual(rows, [{ key: 'mod+r', command: 'core.history/redo', when: redo.when, layer: redo.layer }], '覆盖后速查表一行一个键')
  const setting = keymapSettingsRows().find((r) => r.id === bindingIdOf(redo))!
  assert.deepEqual(setting.keys, ['mod+r'])
  assert.equal(setting.override, 'mod+r')

  setUserKeys({ [bindingIdOf(redo)]: null })
  const removed = keymapSettingsRows().find((r) => r.id === bindingIdOf(redo))!
  assert.deepEqual(removed.keys, [], '摘掉后清单给空数组（界面上标「已摘掉」）')
  assert.equal(keymapRows().some((r) => r.command === 'core.history/redo'), false, '速查表不再报这条键位')
  setUserKeys({})
})

test('校验：裸键与保留键进不来；带修饰键的归一化通过', () => {
  assert.equal(validateUserKey('u').ok, false, '裸键归打字')
  assert.equal(validateUserKey('shift+u').ok, false, '只有 shift 也不算修饰')
  assert.equal(validateUserKey('escape').ok, false)
  assert.equal(validateUserKey('mod+q').ok, false, '退出归窗口')
  assert.equal(validateUserKey('mod+w').ok, false, '关窗归窗口')
  assert.equal(validateUserKey('mod+n').ok, false, '新窗归窗口')
  const ok = validateUserKey('mod+alt+u')
  assert.equal(ok.ok, true)
  assert.equal(ok.ok && ok.key, canonKey('mod+alt+u'))
})
