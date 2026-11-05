/**
 * 「最近更新」的有界取数：**必须与「全量投影后排序再 slice」逐条相等**（含平局）。
 *
 * 参照实现在测试里保留一份旧口径：它是判据，不是实现。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DELETED_AT_PROP,
  flatten,
  isDeleted,
  mkBlock,
  type Block,
  type Doc,
} from '../../src/core/index.ts'
import { recentBlocks } from '../../src/app/search/recents.ts'

/** 旧口径：全森林 → 滤掉软删 → 稳定排序（`modified` 倒序）→ 取前 N */
function before(doc: Doc, limit: number): string[] {
  return flatten(doc)
    .filter((b) => !isDeleted(b))
    .sort((a, b) => b.modified - a.modified)
    .slice(0, limit)
    .map((b) => b.id)
}

/**
 * 固定夹具：
 *
 * ```
 * A(100) ── a1(250)
 * B(300) ── b1(300), b2(300)      ← 平局，文档序＝b1 在 b2 前
 * C(200) ── c1(300)
 * D(400) ── d1(50)
 * dead(999，软删)
 * ```
 */
function fixture(): Doc {
  const rootA = mkBlock('A', { modified: 100 })
  rootA.children.push(mkBlock('a1', { modified: 250 }))

  const rootB = mkBlock('B', { modified: 300 })
  rootB.children.push(mkBlock('b1', { modified: 300 }), mkBlock('b2', { modified: 300 }))

  const rootC = mkBlock('C', { modified: 200 })
  rootC.children.push(mkBlock('c1', { modified: 300 }))

  const rootD = mkBlock('D', { modified: 400 })
  rootD.children.push(mkBlock('d1', { modified: 50 }))

  const dead = mkBlock('dead', { modified: 999 })
  dead.props = { [DELETED_AT_PROP]: 1 }

  return { roots: [rootA, rootB, rootC, rootD, dead] }
}

test('前 N 条与「全排序后 slice」逐条相同（含平局）', () => {
  const doc = fixture()
  for (const limit of [0, 1, 2, 3, 5, 8, 9, 20]) {
    const got = recentBlocks(doc, limit).map((b) => b.id)
    assert.deepEqual(got, before(doc, limit), `limit=${limit}`)
  }
})

test('平局时保持文档序（稳定序），不因有界缓冲而换序', () => {
  const doc = fixture()
  const [, b, c, d] = doc.roots
  assert.deepEqual(
    recentBlocks(doc, 5).map((x) => x.id),
    [
      d!.id, // 400
      b!.id, // 300（文档序第一）
      b!.children[0]!.id, // b1 300
      b!.children[1]!.id, // b2 300
      c!.children[0]!.id, // c1 300
    ],
  )
})

test('软删块不进入结果；limit 非正数返回空', () => {
  const doc = fixture()
  assert.equal(recentBlocks(doc, 20).some((b) => isDeleted(b)), false)
  assert.deepEqual(recentBlocks(doc, 0), [])
  assert.deepEqual(recentBlocks(doc, -3), [])
})
