/**
 * **拖拽的一条缝**：载荷与悬停记忆的形状（纯模型，不碰 DOM 事件）。
 *
 * 这一份钉住三条判据：
 *   · 拖源只报「我是谁」——载荷里只有块 id，不依赖「我认得刚才那次拖拽」；
 *   · 形状不对就当没这回事（外部拖来的文字、别处声明的自定义类型）；
 *   · `dragend` 之后记忆要清掉（拖出窗口松手时它会留脏，下一次悬停就会读到上一次的块）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BLOCK_MIME, clearDragBlock, currentDraggedId, draggedBlockId, hasBlockPayload, isBlockId, setDragBlock } from '../src/view/dnd.ts'

const ID = '0123456789abcdef0123456789abcdef'

/** 假的 `DataTransfer`（node 里没有）：只要 setData／getData／types 三样 */
function fakeDt(): DataTransfer {
  const bag = new Map<string, string>()
  return {
    setData: (k: string, v: string) => void bag.set(k, v),
    getData: (k: string) => bag.get(k) ?? '',
    get types() {
      return [...bag.keys()]
    },
    effectAllowed: 'none',
    dropEffect: 'none',
  } as unknown as DataTransfer
}

test('setDragBlock 之后「现在拖的是谁」是它，载荷里只有块 id（外加可读的 text/plain）', () => {
  const dt = fakeDt()
  setDragBlock(dt, ID)
  assert.equal(currentDraggedId(), ID)
  assert.equal(dt.getData(BLOCK_MIME), ID)
  assert.equal(dt.getData('text/plain'), ID, '拖到外部应用时至少要有一份可读内容')
  assert.ok(hasBlockPayload(dt))
  // 「同一个块可以移、可以建关系、可以钉住」⇒ 三种 effect 都允许
  assert.equal(dt.effectAllowed, 'all')
  clearDragBlock()
  assert.equal(currentDraggedId(), null)
})

test('draggedBlockId：只认块载荷，且形状不对一律 null（不猜、不兜底）', () => {
  const ok = fakeDt()
  ok.setData(BLOCK_MIME, ID)
  assert.equal(draggedBlockId(ok), ID)

  const text = fakeDt()
  text.setData('text/plain', ID)
  assert.equal(draggedBlockId(text), null, '普通文字不是块')

  const bad = fakeDt()
  bad.setData(BLOCK_MIME, 'not-a-block-id')
  assert.equal(draggedBlockId(bad), null, '形状不对就当没这回事')

  const other = fakeDt()
  other.setData('application/x-something', ID)
  assert.equal(draggedBlockId(other), null, '别的应用的自定义类型不是块')
  assert.equal(draggedBlockId(null), null)
})

test('isBlockId：32 位十六进制（块 id 的形状，不查库）', () => {
  assert.equal(isBlockId(ID), true)
  assert.equal(isBlockId(ID.toUpperCase()), false, '大写不是我们写出去的形状')
  assert.equal(isBlockId(ID.slice(0, 31)), false)
  assert.equal(isBlockId(`${ID}0`), false)
  assert.equal(isBlockId(''), false)
  assert.equal(isBlockId(null), false)
})
