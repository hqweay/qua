/**
 * **复制子树：哪些格随副本走、哪些不走**（`core/tree.ts` 的 `contentProps`）。
 *
 * 判据一句话：**复制的是内容，不是身份**。
 *
 * | 格 | 走吗 | 为什么 |
 * |---|---|---|
 * | `_mounts` | **走**（local 深拷、linked 只拷指针） | 它是「这块配了哪几栏」，属于内容 |
 * | `_items` | **走** | 收藏里那一批引用是这一块的内容 |
 * | `_embed` | **走**（指针原样） | 副本仍是一次「指向那一块」的露面 |
 * | `_query` | **不走** | 它是身份（「这是一个查询」），两个同源查询块会互相打架 |
 * | `_views`／`_activeView` | **查询块不走**／普通块走 | 没有源的视图配置没有意义 |
 *
 * 走错的后果都不报错：多带一格＝副本变成一个「看起来像、但不是」的东西；
 * 少带一格＝副本丢了用户配好的东西。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIVE_VIEW_PROP,
  COLLECTION_PROP,
  EMBED_PROP,
  MOUNTS_PROP,
  VIEWS_PROP,
  cloneSubtree,
  type Block,
  type MountEntry,
} from '../src/core/index.ts'
import { plainText, textRuns } from '../src/core/runs.ts'

const mk = (id: string, text: string, props?: Record<string, unknown>): Block => ({
  id,
  content: textRuns(text),
  children: [],
  created: 1,
  modified: 1,
  ...(props ? { props } : {}),
})

const copyOf = (b: Block): Block => cloneSubtree(b).block

test('`_mounts` 随块走：local 的 spec 深拷（改副本不动原件），linked 只拷指针', () => {
  const spec = { where: { todo: 'todo' as const } }
  const entries: MountEntry[] = [
    { id: 't-1', kind: 'local', label: '我的', spec, views: [] },
    { id: 't-2', kind: 'linked', block: 'q-1', view: 'v-1' },
  ]
  const host = mk('h', '宿主', { [MOUNTS_PROP]: entries })
  const copy = copyOf(host)
  const got = copy.props?.[MOUNTS_PROP] as MountEntry[]
  assert.equal(got.length, 2, '两栏都跟着走')
  const local = got[0] as Extract<MountEntry, { kind: 'local' }>
  const linked = got[1] as Extract<MountEntry, { kind: 'linked' }>
  assert.deepEqual(local.spec, spec, '内容一样')
  assert.notEqual(local.spec, spec, '但是两份：改副本的条件不该动到原件')
  assert.equal(local.id, 't-1', 'id 是「这一栏」的身份，复制内容不换它')
  assert.deepEqual(linked, { id: 't-2', kind: 'linked', block: 'q-1', view: 'v-1' }, 'linked 只有指针，没有可深拷的')
})

test('`_items` 随块走（收藏里那一批引用是内容）', () => {
  const fav = mk('f', '收藏', { _type: 'core/collection-widget', [COLLECTION_PROP]: ['a', 'b'] })
  assert.deepEqual(copyOf(fav).props?.[COLLECTION_PROP], ['a', 'b'])
})

test('`_embed` 指针原样保留（副本仍是一次「指向那一块」的露面）', () => {
  const embed = mk('e', '', { _embed: { block: 'a', view: 'v-1' } })
  assert.deepEqual(copyOf(embed).props?.[EMBED_PROP], { block: 'a', view: 'v-1' })
})

test('`_query` 不走（身份不可复制：两个同源查询块会互相打架）', () => {
  const q = mk('q', '本页的待办', { _query: { where: { todo: 'todo' } } })
  const copy = copyOf(q)
  assert.equal(copy.props?._query, undefined)
  assert.equal(plainText(copy.content), '本页的待办', '正文（名字）照抄')
})

test('视图配置：查询块副本**一起剥**（没有源的视图没有意义）；普通块副本**留着**', () => {
  const q = mk('q', '查询', {
    _query: { where: { todo: 'todo' } },
    [VIEWS_PROP]: [{ id: 'v-1', kind: 'table' }],
    [ACTIVE_VIEW_PROP]: 'v-1',
  })
  const qCopy = copyOf(q)
  assert.equal(qCopy.props?.[VIEWS_PROP], undefined)
  assert.equal(qCopy.props?.[ACTIVE_VIEW_PROP], undefined)

  const plain = mk('p', '容器', {
    [VIEWS_PROP]: [{ id: 'v-1', kind: 'table' }],
    [ACTIVE_VIEW_PROP]: 'v-1',
  })
  const pCopy = copyOf(plain)
  assert.equal((pCopy.props?.[VIEWS_PROP] as unknown[]).length, 1, '普通块的子块跟着复制 ⇒ 视图仍然成立')
  assert.equal(pCopy.props?.[ACTIVE_VIEW_PROP], 'v-1')
})

test('副本不留空属性袋：一格都没剩 ⇒ `props` 直接没有', () => {
  // 只有 `_date`（身份）：剥掉之后什么都不剩
  const day = mk('j', '', { _date: '2026-10-26' })
  assert.equal(copyOf(day).props, undefined)
})
