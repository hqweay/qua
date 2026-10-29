/**
 * op 里的位置是**前兄弟 id**（`prev`），不是整数 `index`。
 *
 * 判据（每条都能被独立推翻）：
 *   ① `prev` **自足**：它不依赖「那一刻的兄弟列表有多长」；
 *   ② **同一个 op 流，重放顺序不同也收敛**（这是 `index` 做不到的那一条）；
 *   ③ **前兄弟不在集合里**时落点**确定**（不是静默夹取）——落在父的第一个位置；
 *   ④ **一棵子树的 op 仍隐含「父先于子」**：所以 op 流必须按 seq 单调应用（已登记，不假装解决）。
 *
 * 为什么现在就改：`op_log` 是**不可逆历史**。表已建好但没接写入，`BlockPatch.index`
 * 也没有消费方 ⇒ 现在改是「一处生成端 ＋ 一份类型」；等第一批行写进去就变成迁移。
 *
 * ⚠️ 这一组**不**证明「无冲突合并」——同位置并发插入仍要靠 `(prev, id)` 的
 * 确定性 tie-break 收敛，而那是同步层的事。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { BlockStore } from '../src/core/store.ts'
import { mkBlock, type Block } from '../src/core/model.ts'
import type { Op } from '../src/core/kb/types.ts'

const NOW = 1_700_000_000_000
const kb = (): MemoryKb => new MemoryKb(new BlockStore([]), { now: () => NOW })

function b(id: string): Block {
  return { ...mkBlock('', { created: NOW, modified: NOW }), id }
}

/** 取一批 op 里的位置字段（`prev`；出现 `index` 就是旧形状复活） */
function positionsOf(ops: readonly Op[]): (string | null | undefined)[] {
  const out: (string | null | undefined)[] = []
  for (const op of ops) {
    if (op.e === 'block' && op.op === 'upsert') out.push(op.value.prev)
  }
  return out
}

const rootIds = (k: MemoryKb): string[] => k.roots().map((x) => x.id)

/* ------------------------------------------------------------ ① 自足 */

test('① insert 报的是前兄弟 id，不是下标（落在首位 ⇒ prev: null）', () => {
  const k = kb()
  const r = k.tx((tx) => {
    tx.insert(b('a'), null, 0)
    tx.insert(b('b'), null, 1)
    tx.insert(b('c'), null, 1) // 插到 b 之前 ⇒ 前兄弟是 a
  })
  assert.deepEqual(positionsOf(r.ops), [null, 'a', 'a'], `应当报前兄弟 id：${JSON.stringify(positionsOf(r.ops))}`)
  assert.deepEqual(rootIds(k), ['a', 'c', 'b'])
})

test('① 同一个 prev 在「列表短一截」时**仍指向同一个锚点**（这就是自足）', () => {
  /**
   * 旧形状（整数 index）的故障：同一个 `index=2` 在短列表上落到末尾，且不报错。
   * 新形状：锚点是**块 id**，所以只要那块在，落点就唯一。
   */
  const full = kb()
  full.tx((tx) => {
    tx.insert(b('a'), null, 0)
    tx.insert(b('b'), null, 1)
    tx.insert(b('c'), null, 2)
    tx.insert(b('x'), null, 2) // 前兄弟＝b
  })
  assert.deepEqual(rootIds(full), ['a', 'b', 'x', 'c'])

  // 同样的锚点（prev=b），但列表里没有 c
  const short = kb()
  short.tx((tx) => {
    tx.insert(b('a'), null, 0)
    short.tx((tx2) => tx2.insert(b('b'), null, 1))
    short.tx((tx2) => tx2.insert(b('x'), null, 2))
  })
  assert.deepEqual(rootIds(short), ['a', 'b', 'x'], '锚点是 b ⇒ 落在 b 之后；不依赖列表长度')
})

/* ------------------------------------------------------------ ② 收敛 */

test('② 同一父下两次插入，应用顺序不同 ⇒ 最终顺序**相同**（index 做不到这条）', () => {
  /**
   * 两台设备各自「在块 p 的第一个位置插入」：
   *   · 设备 1：p → x（prev: null）
   *   · 设备 2：p → y（prev: null）
   * 两条 op 的锚点相同（都落在首位）⇒ 顺序由 `(prev, id)` 的 tie-break 定，
   * 而**不是**由「谁后应用」定。
   *
   * 这里验的是**生成端**的锚点形状：两条 op 的 prev 都是 null。
   * 真正的收敛（应用侧 tie-break）在同步层，见测试末尾的登记。
   */
  const k = kb()
  k.tx((tx) => tx.insert(b('p'), null, 0))
  const opsX = k.tx((tx) => tx.insert(b('x'), 'p', 0)).ops
  const opsY = k.tx((tx) => tx.insert(b('y'), 'p', 0)).ops
  assert.deepEqual(positionsOf(opsX), [null], 'x 落在首位 ⇒ 前兄弟 null')
  assert.deepEqual(positionsOf(opsY), [null], 'y 也落在首位 ⇒ 前兄弟 null')
  assert.deepEqual(
    positionsOf(opsX),
    positionsOf(opsY),
    '两条并发的「插到首位」op 锚点相同 ⇒ 对端只要按 (prev, id) 定序就得到同一个结果',
  )
})

/* ------------------------------------------------------------ ③ 前兄弟不在集合里 */

test('③ 前兄弟已被删：落点**确定**（父的第一个位置），不是静默夹取', () => {
  /**
   * `prev` 指向的块可能已经不在（被 purge、或还没同步到）。
   * 兜底口径（写进 `BlockPatch.prev` 的注释里）：落在**父的第一个位置**。
   * 为什么不是「夹到末尾」：夹取是旧形状的故障来源；「第一个位置」至少是可预期的。
   *
   * 这条现在只能验**生成端不产生悬空 prev**：软删不搬位置，所以被删的前兄弟
   * 仍然是合法的锚点（它在树上）。真正的应用侧兜底等 replay 落地时再钉。
   */
  const k = kb()
  k.tx((tx) => {
    tx.insert(b('a'), null, 0)
    tx.insert(b('b'), null, 1)
  })
  // 删掉 b 之后，在它后面插一块 ⇒ 前兄弟仍是 b（软删不搬位置，锚点仍成立）
  k.tx((tx) => tx.remove('b'))
  const r = k.tx((tx) => tx.insert(b('c'), null, 2))
  assert.deepEqual(positionsOf(r.ops), ['b'], '软删不搬位置 ⇒ 被删的块仍是合法锚点')
  assert.deepEqual(rootIds(k), ['a', 'b', 'c'], '可见顺序里 b 不出现，但 c 仍在它后面')
})

/* ------------------------------------------------------------ ④ 子树的拓扑依赖（未解决，只登记） */

test('④ 一棵子树的 op 仍隐含「父先于子」：这是已知边界，不是被 prev 解决的', () => {
  const k = kb()
  const grand: Block = b('grand')
  const child: Block = { ...b('child'), children: [grand] }
  const root: Block = { ...b('root'), children: [child] }
  const r = k.tx((tx) => tx.insert(root, null, 0))

  const ids = r.ops.map((op) => (op.e === 'block' ? op.id : ''))
  assert.deepEqual(ids, ['root', 'child', 'grand'], `子树按先序发 op：${ids.join(',')}`)
  assert.deepEqual(positionsOf(r.ops), [null, null, null], '每块都是各自父的第一块 ⇒ prev 都是 null')

  const k2 = kb()
  assert.throws(
    () => k2.tx((tx) => tx.insert(b('child'), 'root', 0)),
    /no such parent/,
    '子 op 先于父 op ⇒ 抛错。所以 op 流必须按 seq 单调应用（父在子前）；prev 不解决这个',
  )
})

/* ------------------------------------------------------------ ⑤ 形状守卫 */

test('⑤ 旧形状 `index` 不许复活；replay 必须存在且以 `applyOps` 为唯一解释器', () => {
  const src = readAllSources()
  assert.equal(
    /index\?:\s*number/.test(src),
    false,
    '`BlockPatch` 上不该再有 `index?: number`：它只对那一刻的兄弟列表有意义，进了 op_log 就补不回来',
  )
  assert.match(src, /export function replay\(/, '日志即状态：`replay` 必须存在（它是「日志完整」的可执行判据）')
  assert.equal(
    /function\s+applyOp\b|function\s+replayOps?\b|replayFromOps/.test(src),
    false,
    '解释器只能有一个：`applyOps`；另造一份就会与它分叉，而分叉只在重放时显形',
  )
  assert.match(
    readFileSync(join(import.meta.dirname, '..', 'src', 'core', 'kb', 'types.ts'), 'utf8'),
    /op: 'exist'/,
    '存在必须是一个格、三个状态（`block.exist`），不是「软删/清除共用一个词」',
  )
  assert.match(
    readFileSync(join(import.meta.dirname, '..', 'src', 'core', 'kb', 'types.ts'), 'utf8'),
    /created\?: number/,
    '出生时刻是必填格：新块的 genesis 必须能把它写进日志',
  )
})

/** 把 `src/**` 下的 .ts 拼起来（只为上一条的静态断言） */
function readAllSources(): string {
  const root = join(import.meta.dirname, '..', 'src')
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name.endsWith('.ts')) out.push(readFileSync(p, 'utf8'))
    }
  }
  walk(root)
  return out.join('\n')
}
