/**
 * **行身体实例缓存**（`app/wiring/row-bodies.ts`）的纯逻辑单测。
 *
 * 它守的是「行重画不重建 ViewHost」这条判据：外来编辑（右槽敲字…）会让整屏行
 * 重建，行内查询体若随之销毁重建，冻结成员被静默重算、stale 清零、滚动丢失。
 * 用假对象驱动（不需要 DOM）：缓存只调 `into.appendChild(root)` 与 `dispose()`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkBlock, type Block } from '../src/core/index.ts'
import { createRowBodyCache } from '../src/app/wiring/row-bodies.ts'

/** 假容器：只记 appendChild 收到过哪些 root */
const fakeInto = (): { appendChild: (r: unknown) => void; got: unknown[] } => {
  const got: unknown[] = []
  return { appendChild: (r) => void got.push(r), got }
}

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve))

test('行重画（先 dispose、同一任务里重新 open）不重建实例：DOM 搬进新容器，实例不拆', async () => {
  const calls = { mounts: 0, disposals: 0 }
  const root = { tag: 'root' }
  // 首挂的落容器由 mount 工厂负责（`mountBlockView` 自己 appendChild）；缓存只管搬家
  const cache = createRowBodyCache((_b, into) => {
    calls.mounts++
    ;(into as unknown as { appendChild: (r: unknown) => void }).appendChild(root)
    return { root: root as HTMLElement, dispose: () => void calls.disposals++ }
  })
  const b = mkBlock('查询')
  const into1 = fakeInto()
  const dispose1 = cache(b, into1 as HTMLElement)
  assert.equal(calls.mounts, 1)
  assert.deepEqual(into1.got, [root], '首挂：工厂把 root 放进容器')

  // 行重建就是这个顺序：disposeAll → 同一任务里逐行重新 open
  dispose1()
  const into2 = fakeInto()
  const dispose2 = cache(b, into2 as HTMLElement)
  await tick()
  assert.equal(calls.mounts, 1, '同一块的行身体不重建（冻结/stale/滚动都还在）')
  assert.equal(calls.disposals, 0, '被接回屏幕的实例不拆（订阅不泄漏）')
  assert.deepEqual(into2.got, [root], '实例的 DOM 被搬进新容器')

  // 真卸载：dispose 之后不再回来 ⇒ 下一拍就拆
  dispose2()
  await tick()
  assert.equal(calls.disposals, 1, '块离开屏幕要真拆（不能泄漏订阅）')
})

test('同一块、两份缓存（两台编辑器）各建各的实例；重复 dispose 幂等', async () => {
  const calls = { mounts: 0, disposals: 0 }
  const cache = () =>
    createRowBodyCache(() => {
      calls.mounts++
      return { root: { tag: 'root' } as HTMLElement, dispose: () => void calls.disposals++ }
    })
  const b = mkBlock('查询')
  const a = cache()
  const c = cache()
  const disposeA = a(b, fakeInto() as HTMLElement)
  const disposeC = c(b, fakeInto() as HTMLElement)
  assert.equal(calls.mounts, 2, '同屏两处（正文＋右槽窗口）是两台实例，不是共享一台')
  disposeA()
  disposeA() // 幂等：编辑器可能对同一行调两次
  disposeC()
  await tick()
  assert.equal(calls.disposals, 2, '各拆各的；重复 dispose 不多拆')
})
