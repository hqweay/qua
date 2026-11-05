/**
 * 索引行的**来源维度**：一块的可搜文本不止正文——地址、标签归属、属性值、
 * 链接与引用各自成行，行与行独立维护。
 *
 * 判据（每条都可证伪）：
 *   ① 五个来源各有「写入 → 可搜 → 删除 → 不可搜」的完整生命周期（增量路径）；
 *   ② 名字住在别处的来源要**牵连重索引**：改地址 ⇒ 这个块；改标签名 ⇒ 成员块；
 *      改选项名 ⇒ 取值块；改目标名 ⇒ 引用块；
 *   ③ 目标软删／恢复 ⇒ 引用块的 link 行跟着失／得；
 *   ④ 全量重建覆盖所有来源，收尾 `fts_state` 恢复 `ready`（库里与内存一致）。
 *
 * 走**真 SQLite**：断言的是「搜得到／搜不到」，不是「写了哪几行」——
 * 行写入的形状正确性另有一组测试（`fts-rows.test.ts`）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cut } from 'jieba-wasm'
import { pinyin } from 'pinyin-pro'
import { mkBlock, ALIASES_PROP, type Block } from '../../src/core/model/model.ts'
import { uuidv7Hex } from '../../src/core/model/ids.ts'
import { BlockStore } from '../../src/core/model/store.ts'
import { MemoryKb } from '../../src/core/kb/memory.ts'
import { mkTagBlock } from '../../src/core/identity/tags.ts'
import { mkPropDef } from '../../src/core/props/props.ts'
import { META_KEYS } from '../../src/core/identity/library.ts'
import { ftsSourceTexts } from '../../src/core/search/rows.ts'
import type { StoredWorkspace } from '../../src/core/storage/db-rows.ts'
import type { Op } from '../../src/core/kb/types.ts'
import { applyRowWrites, openLibraryDb, readMeta, searchFts, type Db } from '../../electron/library/sqlite.ts'
import { compileMatch } from '../../src/core/search/query.ts'
import { tokenizeText, type TokenizedText } from '../../src/core/search/tokenizer.ts'
import { SearchIndexer, tokenizeManyWith } from '../../src/app/search/indexer.ts'
import { rebuildSearch } from '../../src/app/search/rebuild.ts'

const tokenize = (text: string): TokenizedText => tokenizeText(text, cut, pinyin as never)

const dirs: string[] = []
function db(): Db {
  const d = mkdtempSync(join(tmpdir(), 'qua-fts-src-'))
  dirs.push(d)
  const r = openLibraryDb(join(d, 'qua.db'))
  assert.equal(r.status, 'created')
  return r.db!
}
process.on('exit', () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/* ------------------------------------------------------------ 夹具 */

const refRun = (to: string, label: string, flavor?: '#') => ({
  id: uuidv7Hex(),
  t: 'ref' as const,
  to,
  label,
  ...(flavor ? { flavor } : {}),
})
const linkRun = (v: string, url: string) => ({ id: uuidv7Hex(), t: 'link' as const, v, url })

/** 定义块 ＋ 它的唯一选项（选项＝定义块的直接子块） */
function choiceFixture(name: string): { def: Block; choice: Block } {
  const def = mkBlock('', { props: { _kind: 'select' } })
  const choice = mkBlock(name)
  def.children = [choice]
  return { def, choice }
}

interface Harness {
  db: Db
  store: BlockStore
  kb: MemoryKb
  indexer: SearchIndexer
  /** 一批 op：按「索引与内容同一批」的口径先规划、后落盘、再推进映射 */
  commit(ops: readonly Op[]): Promise<void>
}

function harness(): Harness {
  const database = db()
  const store = new BlockStore([])
  const kb = new MemoryKb(store)
  // 就绪态起步：这组测试走**增量**路径（重建路径由最后一条测试单独覆盖）
  const indexer = new SearchIndexer({ map: new Map(), state: 'ready', rowidSeq: 0, tokenizer: 't' }, tokenizeManyWith(tokenize))
  const ws = (): StoredWorkspace => ({ blocks: store.blocks, activeId: '', savedAt: 1 })
  return {
    db: database,
    store,
    kb,
    indexer,
    async commit(ops) {
      const plan = await indexer.plan(ws(), ops)
      if (plan) applyRowWrites(database, plan.writes)
      plan?.apply()
    },
  }
}

/** 全文索引里命中「块|来源」的清单（比「块 id」严格：来路必须是预期的那一格） */
function hitsOf(database: Db, text: string): string[] {
  const match = compileMatch(text)
  assert.ok(match, `查询 ${text} 应当编译出表达式`)
  return searchFts(database, match, 100).map((h) => `${h.blockId}|${h.source}`)
}

/* ------------------------------------------------------------ ① 五来源生命周期 */

test('content：写入正文 ⇒ 可搜；清空 ⇒ 不可搜（别名行不被连坐）', async () => {
  const h = harness()
  const a = mkBlock('', { props: { [ALIASES_PROP]: ['有名字的块'] } })
  h.store.blocks.push(a)

  await h.commit(h.kb.tx((tx) => tx.patch(a.id, (b) => { b.content = [{ t: 'text', v: '人口密度很大的城市' }] })).ops)
  assert.ok(hitsOf(h.db, '人口').includes(`${a.id}|content`), '正文行可搜')

  await h.commit(h.kb.tx((tx) => tx.patch(a.id, (b) => { b.content = [] })).ops)
  assert.ok(!hitsOf(h.db, '人口').includes(`${a.id}|content`), '清空正文 ⇒ 正文行摘除')
})

test('alias：写地址 ⇒ 可搜；清地址 ⇒ 不可搜', async () => {
  const h = harness()
  const a = mkBlock('描述文字')
  h.store.blocks.push(a)

  await h.commit(h.kb.tx((tx) => tx.setAliases(a.id, ['红薯笔记'])).ops)
  assert.ok(hitsOf(h.db, '红薯').includes(`${a.id}|alias`), '地址行可搜')

  await h.commit(h.kb.tx((tx) => tx.clearProp(a.id, ALIASES_PROP)).ops)
  assert.ok(!hitsOf(h.db, '红薯').includes(`${a.id}|alias`), '清地址 ⇒ 地址行摘除')
})

test('tag：打标签 ⇒ 成员块可按标签名搜到；摘标签 ⇒ 不可搜', async () => {
  const h = harness()
  const tag = mkTagBlock('设计')
  const member = mkBlock('成员的一行')
  h.store.blocks.push(tag, member)

  await h.commit(h.kb.tx((tx) => tx.setTags(member.id, [tag.id])).ops)
  assert.ok(hitsOf(h.db, '设计').includes(`${member.id}|tag`), '成员块的标签行带标签名')

  await h.commit(h.kb.tx((tx) => tx.setTags(member.id, [])).ops)
  assert.ok(!hitsOf(h.db, '设计').includes(`${member.id}|tag`), '摘标签 ⇒ 标签行摘除')
})

test('tag：行内 #名 的提及也进 tag 行（不写 _tags）；改名跟着走', async () => {
  const h = harness()
  const tag = mkTagBlock('任务')
  const member = mkBlock('')
  h.store.blocks.push(tag, member)

  await h.commit(h.kb.tx((tx) => tx.patch(member.id, (b) => { b.content = [refRun(tag.id, '任务', '#')] })).ops)
  assert.ok(hitsOf(h.db, '任务').includes(`${member.id}|tag`), '行内标签按标签名可搜，来路是 tag')
  assert.ok(!hitsOf(h.db, '任务').includes(`${member.id}|link`), '同一枚标签不再有两种来路')

  await h.commit(h.kb.tx((tx) => tx.setAliases(tag.id, ['待办'])).ops)
  assert.ok(hitsOf(h.db, '待办').includes(`${member.id}|tag`), '改名后行内提及的标签行跟着新名')
  assert.ok(!hitsOf(h.db, '任务').includes(`${member.id}|tag`), '旧名不再经这一块命中')
})

test('prop：写字符串值与选项值 ⇒ 可搜；清值 ⇒ 不可搜（选项值索引选项名，不是 id）', async () => {
  const h = harness()
  const { def, choice } = choiceFixture('进行中')
  const textDef = mkPropDef('备注', 'text')
  const taker = mkBlock('带字段的一行')
  h.store.blocks.push(def, textDef, taker)

  // 文本值：索引存下来的字符串本身（用 text 定义；select 下这个串不是选项 id，不产文本）
  await h.commit(h.kb.tx((tx) => tx.setProp(taker.id, textDef.id, '红薯与咖啡')).ops)
  assert.ok(hitsOf(h.db, '红薯').includes(`${taker.id}|prop`), '文本值可搜')

  // 选项值：存的是选项块 id，可搜的是选项名
  await h.commit(h.kb.tx((tx) => tx.setProp(taker.id, def.id, choice.id)).ops)
  assert.ok(hitsOf(h.db, '进行').includes(`${taker.id}|prop`), '选项值按选项名可搜')
  assert.ok(!hitsOf(h.db, '进行').some((x) => x.startsWith(`${choice.id}|`)), '选项块自己的正文行不因此出现')

  await h.commit(h.kb.tx((tx) => tx.clearProp(taker.id, def.id)).ops)
  assert.ok(!hitsOf(h.db, '进行').includes(`${taker.id}|prop`), '清值 ⇒ 属性行摘除')
})

test('prop：按定义的 kind 投影（ref 取目标名、number 转串、date／text 原串、checkbox 不产词）', async () => {
  const h = harness()
  const target = mkBlock('', { props: { [ALIASES_PROP]: ['旧目标名'] } })
  const textDef = mkPropDef('备注', 'text')
  const numDef = mkPropDef('数量', 'number')
  const dateDef = mkPropDef('日期', 'date')
  const checkDef = mkPropDef('完成', 'checkbox')
  const refDef = mkPropDef('相关', 'ref')
  const taker = mkBlock('带字段的一行')
  h.store.blocks.push(target, textDef, numDef, dateDef, checkDef, refDef, taker)

  await h.commit(
    h.kb.tx((tx) => {
      tx.setProp(taker.id, textDef.id, '准备材料')
      tx.setProp(taker.id, numDef.id, 42)
      tx.setProp(taker.id, dateDef.id, '2026-11-05')
      tx.setProp(taker.id, checkDef.id, false)
      tx.setProp(taker.id, refDef.id, target.id)
    }).ops,
  )

  assert.ok(hitsOf(h.db, '准备').includes(`${taker.id}|prop`), 'text 原串可搜')
  assert.ok(hitsOf(h.db, '42').includes(`${taker.id}|prop`), 'number 转串后可搜')
  assert.ok(hitsOf(h.db, '2026').includes(`${taker.id}|prop`), 'date 原串可搜')
  assert.ok(hitsOf(h.db, '旧目标').includes(`${taker.id}|prop`), 'ref 值按目标现算名可搜')
  assert.ok(!hitsOf(h.db, 'false').includes(`${taker.id}|prop`), 'checkbox 的 false 不是可搜词')
  assert.ok(!hitsOf(h.db, target.id).includes(`${taker.id}|prop`), 'ref 的裸 id 不进索引')
  assert.ok(!hitsOf(h.db, '不相干').includes(`${taker.id}|prop`), '不相关词不命中')
  assert.ok(!hitsOf(h.db, '完成').includes(`${taker.id}|prop`), '属性名不是这一块的可搜文本')

  await h.commit(h.kb.tx((tx) => tx.setAliases(target.id, ['新目标名'])).ops)
  assert.ok(hitsOf(h.db, '新目标').includes(`${taker.id}|prop`), '目标改名后属性行跟着新名')
  assert.ok(!hitsOf(h.db, '旧目标').includes(`${taker.id}|prop`), '旧名不再经属性行命中')
})

test('prop：checkbox 值不产 prop 行（负例：没有可搜文本的来源行不存在）', async () => {
  const h = harness()
  const checkDef = mkPropDef('完成', 'checkbox')
  const only = mkBlock('只有复选框')
  h.store.blocks.push(checkDef, only)
  await h.commit(h.kb.tx((tx) => tx.setProp(only.id, checkDef.id, false)).ops)

  const texts = ftsSourceTexts({ blocks: h.store.blocks, activeId: '', savedAt: 1 }, new Set([only.id]))
  assert.ok(!texts.some((t) => t.key.endsWith('prop')), 'checkbox 不建 prop 行')
  assert.ok(!hitsOf(h.db, 'false').includes(`${only.id}|prop`), 'false 不是可搜词')
})

test('prop：数组值逐项投影（第二项也要进索引）', async () => {
  const h = harness()
  const t1 = mkBlock('', { props: { [ALIASES_PROP]: ['目标甲'] } })
  const t2 = mkBlock('', { props: { [ALIASES_PROP]: ['目标乙'] } })
  const refDef = mkPropDef('关联', 'ref')
  const taker = mkBlock('多值的一行')
  h.store.blocks.push(t1, t2, refDef, taker)
  await h.commit(h.kb.tx((tx) => tx.setProp(taker.id, refDef.id, [t1.id, t2.id])).ops)

  assert.ok(hitsOf(h.db, '目标甲').includes(`${taker.id}|prop`), '第一项可搜')
  assert.ok(hitsOf(h.db, '目标乙').includes(`${taker.id}|prop`), '第二项也进来（不是只取第一项）')
})

test('link：外链文本／地址与引用目标名 ⇒ 可搜；正文里的原子拿掉 ⇒ 不可搜', async () => {
  const h = harness()
  const target = mkBlock('', { props: { [ALIASES_PROP]: ['虎鲸'] } })
  const source = mkBlock('')
  h.store.blocks.push(target, source)

  await h.commit(
    h.kb.tx((tx) => tx.patch(source.id, (b) => { b.content = [linkRun('官网', 'https://qua.example/home'), refRun(target.id, '虎鲸')] })).ops,
  )
  assert.ok(hitsOf(h.db, '官网').includes(`${source.id}|link`), '外链显示文本可搜')
  assert.ok(hitsOf(h.db, 'example').includes(`${source.id}|link`), '外链地址可搜')
  assert.ok(hitsOf(h.db, '虎鲸').includes(`${source.id}|link`), '引用按目标的现算名可搜')

  await h.commit(h.kb.tx((tx) => tx.patch(source.id, (b) => { b.content = [] })).ops)
  assert.ok(!hitsOf(h.db, '官网').includes(`${source.id}|link`), '原子拿掉 ⇒ link 行摘除')
  assert.ok(!hitsOf(h.db, '虎鲸').includes(`${source.id}|link`), '引用拿掉 ⇒ 目标名不再经由这一块')
})

/* ------------------------------------------------------------ ② 四个改名扩散 */

test('扩散：改别名 ⇒ 这一块的别名行换成新名', async () => {
  const h = harness()
  const a = mkBlock('')
  h.store.blocks.push(a)
  await h.commit(h.kb.tx((tx) => tx.setAliases(a.id, ['旧名字'])).ops)
  assert.ok(hitsOf(h.db, '旧名字').includes(`${a.id}|alias`))

  await h.commit(h.kb.tx((tx) => tx.setAliases(a.id, ['新名字'])).ops)
  assert.ok(hitsOf(h.db, '新名字').includes(`${a.id}|alias`), '新名可搜')
  assert.ok(!hitsOf(h.db, '旧名字').includes(`${a.id}|alias`), '旧名这一行真的换掉了')
})

test('扩散：改标签名 ⇒ 全部成员块的标签行重铺（面大、低频）', async () => {
  const h = harness()
  const tag = mkTagBlock('旧标签名')
  const m1 = mkBlock('成员一')
  const m2 = mkBlock('成员二')
  h.store.blocks.push(tag, m1, m2)
  await h.commit(h.kb.tx((tx) => { tx.setTags(m1.id, [tag.id]); tx.setTags(m2.id, [tag.id]) }).ops)
  assert.ok(hitsOf(h.db, '旧标签名').includes(`${m1.id}|tag`))

  await h.commit(h.kb.tx((tx) => tx.setAliases(tag.id, ['新标签名'])).ops)
  assert.ok(hitsOf(h.db, '新标签名').includes(`${m1.id}|tag`), '成员一跟着新名')
  assert.ok(hitsOf(h.db, '新标签名').includes(`${m2.id}|tag`), '成员二跟着新名')
  assert.ok(!hitsOf(h.db, '旧标签名').includes(`${m1.id}|tag`), '旧名不再经成员块命中')
})

test('扩散：改选项名 ⇒ 所有取该值的块重铺属性行', async () => {
  const h = harness()
  const { def, choice } = choiceFixture('进行中')
  const t1 = mkBlock('任务一')
  const t2 = mkBlock('任务二')
  h.store.blocks.push(def, t1, t2)
  await h.commit(
    h.kb.tx((tx) => { tx.setProp(t1.id, def.id, choice.id); tx.setProp(t2.id, def.id, choice.id) }).ops,
  )
  assert.ok(hitsOf(h.db, '进行').includes(`${t1.id}|prop`))

  await h.commit(h.kb.tx((tx) => tx.patch(choice.id, (b) => { b.content = [{ t: 'text', v: '已完成' }] })).ops)
  assert.ok(hitsOf(h.db, '已完成').includes(`${t1.id}|prop`), '取值块一跟着新名')
  assert.ok(hitsOf(h.db, '已完成').includes(`${t2.id}|prop`), '取值块二跟着新名')
  assert.ok(!hitsOf(h.db, '进行').includes(`${t1.id}|prop`), '旧选项名不再经取值块命中')
})

test('扩散：改目标名 ⇒ 引用块的 link 行换成新名（引用显示名是现算的，索引同理）', async () => {
  const h = harness()
  const target = mkBlock('', { props: { [ALIASES_PROP]: ['旧目标名'] } })
  const refA = mkBlock('')
  const refB = mkBlock('')
  h.store.blocks.push(target, refA, refB)
  await h.commit(
    h.kb.tx((tx) => {
      tx.patch(refA.id, (b) => { b.content = [refRun(target.id, '旧目标名')] })
      tx.patch(refB.id, (b) => { b.content = [refRun(target.id, '旧目标名')] })
    }).ops,
  )
  assert.ok(hitsOf(h.db, '旧目标名').includes(`${refA.id}|link`))

  await h.commit(h.kb.tx((tx) => tx.setAliases(target.id, ['新目标名'])).ops)
  assert.ok(hitsOf(h.db, '新目标名').includes(`${refA.id}|link`), '引用块一跟着新名')
  assert.ok(hitsOf(h.db, '新目标名').includes(`${refB.id}|link`), '引用块二跟着新名')
  assert.ok(!hitsOf(h.db, '旧目标名').includes(`${refA.id}|link`), '旧名不再经引用块命中')
})

/* ------------------------------------------------------------ ③ 目标可解析性变化 */

test('扩散：目标软删 ⇒ 引用块不再按目标名命中；恢复 ⇒ 回来', async () => {
  const h = harness()
  const target = mkBlock('', { props: { [ALIASES_PROP]: ['会消失的目标'] } })
  const source = mkBlock('')
  h.store.blocks.push(target, source)
  await h.commit(h.kb.tx((tx) => tx.patch(source.id, (b) => { b.content = [refRun(target.id, '会消失的目标')] })).ops)
  assert.ok(hitsOf(h.db, '会消失的目标').includes(`${source.id}|link`))

  await h.commit(h.kb.tx((tx) => tx.remove(target.id)).ops)
  assert.ok(!hitsOf(h.db, '会消失的目标').includes(`${source.id}|link`), '解析不到的目标不产文本')

  await h.commit(h.kb.tx((tx) => tx.restore(target.id)).ops)
  assert.ok(hitsOf(h.db, '会消失的目标').includes(`${source.id}|link`), '恢复后目标名回到引用块的行里')
})

/* ------------------------------------------------------------ ④ 全量重建 */

test('重建：覆盖全部来源、收尾 ready（库里与内存一致）', async () => {
  const database = db()
  const tag = mkTagBlock('设计')
  const member = mkBlock('成员的一行')
  const target = mkBlock('', { props: { [ALIASES_PROP]: ['虎鲸'] } })
  const refBlock = mkBlock([refRun(target.id, '虎鲸'), linkRun('官网', 'https://qua.example/home')])
  const { def, choice } = choiceFixture('进行中')
  const taker = mkBlock('带字段的一行')
  member.props = { _tags: [tag.id] }
  taker.props = { [def.id]: choice.id }
  const store = new BlockStore([tag, member, target, refBlock, def, taker])

  const indexer = new SearchIndexer(undefined, tokenizeManyWith(tokenize))
  const r = await rebuildSearch({
    forest: () => store.blocks,
    indexer,
    save: async (w) => {
      applyRowWrites(database, w)
      return { ok: true }
    },
  })
  assert.equal(r.ok, true)
  assert.equal(r.clean, true)
  assert.equal(indexer.status, 'ready', '重建收尾必须 ready')
  assert.equal(readMeta(database, META_KEYS.ftsState), 'ready', '库里的状态也落到 ready')

  // 每个来源都有一条可搜的行
  assert.ok(hitsOf(database, '成员').some((x) => x.startsWith(`${member.id}|content`)), '正文行')
  assert.ok(hitsOf(database, '设计').includes(`${tag.id}|alias`), '标签块自己的地址行')
  assert.ok(hitsOf(database, '设计').includes(`${member.id}|tag`), '成员块的标签行')
  assert.ok(hitsOf(database, '进行').includes(`${taker.id}|prop`), '取值块的属性行')
  assert.ok(hitsOf(database, '官网').includes(`${refBlock.id}|link`), '引用块的链接行')
  assert.ok(hitsOf(database, '虎鲸').includes(`${refBlock.id}|link`), '引用块按目标名可搜')
})
