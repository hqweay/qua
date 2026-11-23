/**
 * **命令调用面的运行时闸**：声明为 `required` 的参数缺了，必须响。
 *
 * 背景（真事故）：handler 一律 `S(a.x, '')` 后 `if (!x) return false`，于是
 * 「调用方键名传错」与「没有目标」读起来一模一样——零写入、零 toast。两次人肉发现
 * （属性定义把名字按 `propId` 传、归属把子块按 `blockId` 传）之后，把契约收进
 * `Registry.invoke`：静态那一半在 `arch-check [40]`，动态载荷（自动化步骤等）归这里。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Registry } from '../src/core/commands/registry.ts'
import { COMMANDS } from '../src/core/commands/decls.ts'
import type { App, CommandDecl } from '../src/core/infra/ports.ts'

const DECL: CommandDecl = {
  name: 'core.test/needs-child',
  title: 'test',
  capability: 'write',
  undoable: true,
  version: '1.0',
  category: 'test',
  args: { required: ['childId'], childId: { type: 'string' }, note: { type: 'string' } },
}

function makeRegistry(onRun: () => void): { reg: Registry; toasts: string[] } {
  const toasts: string[] = []
  const app = {
    toast: (text: string) => toasts.push(text),
    ed: { probe: { compositionSeq: [], lastCommand: null } },
  } as unknown as App
  return {
    reg: new Registry(app, { [DECL.name]: () => (onRun(), true) }, [DECL]),
    toasts,
  }
}

test('缺声明为必需的参数：handler 不执行、返回 error、给一句 toast', () => {
  let ran = 0
  const { reg, toasts } = makeRegistry(() => ran++)
  const r = reg.invoke(DECL.name, { note: 'x' })
  assert.equal(r.ok, false)
  assert.equal(r.handled, false)
  assert.equal(ran, 0, '参数不全时不许进 handler——早退正是 bug 的藏身处')
  assert.ok(r.error?.includes('childId'), `报错要点名缺哪个参数：${r.error}`)
  assert.equal(toasts.length, 1, '必须响：静默就是这次要消灭的失败形态')
})

test('空串与缺键同义：handler 的 `S(x, "")` + `if (!x)` 读法就这么判', () => {
  let ran = 0
  const { reg } = makeRegistry(() => ran++)
  assert.equal(reg.invoke(DECL.name, { childId: '' }).ok, false)
  assert.equal(ran, 0)
})

test('参数给全：照常执行并记进诊断面', () => {
  let ran = 0
  const { reg, toasts } = makeRegistry(() => ran++)
  const r = reg.invoke(DECL.name, { childId: 'b1' })
  assert.equal(r.ok, true)
  assert.equal(ran, 1)
  assert.equal(toasts.length, 0)
  assert.equal(reg.last?.handled, true)
})

test('没声明 required 的命令不受影响：缺参仍可走光标兜底', () => {
  const decl: CommandDecl = { ...DECL, name: 'core.test/optional', args: { childId: { type: 'string' } } }
  let ran = 0
  const app = {
    toast: () => {},
    ed: { probe: { compositionSeq: [], lastCommand: null } },
  } as unknown as App
  const reg = new Registry(app, { [decl.name]: () => (ran++, true) }, [decl])
  assert.equal(reg.invoke(decl.name, {}).ok, true)
  assert.equal(ran, 1)
})

test('归属三条命令声明了必需参数：面板入口靠它从静默变吵', () => {
  const requiredOf = (name: string): string[] => {
    const spec = COMMANDS.find((c) => c.name === name)?.args as { required?: string[] } | undefined
    return spec?.required ?? []
  }
  assert.deepEqual(requiredOf('core.belongs-to/add'), ['childId', 'parentId'])
  assert.deepEqual(requiredOf('core.belongs-to/remove'), ['childId', 'parentId'])
  assert.deepEqual(requiredOf('core.belongs-to/prune'), ['childId'])
  assert.deepEqual(requiredOf('core.props/create-def'), ['label'])
})
