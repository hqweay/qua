/**
 * 诊断飞行记录器：**只记形状，不记内容**。
 *
 * ## 为什么这个文件的第一组断言是「不含什么」
 *
 * 记录器最容易破的一条纪律不是「记漏了」，而是**顺手多记了一个字段**：
 * 排障时想看 message，于是 `{ kind:'error', message: e.message }` —— 那一行就把
 * 用户笔记正文、页面标题、绝对路径一起写进了磁盘，而且写到的是**日志文件**，
 * 用户的备份工具、同步盘、发给别人的诊断包都会带上它。
 *
 * ⇒ 断言写成**负向**的：喂一个含可辨认内容的错误，断言落盘文件里**搜不到**它。
 * 这比「我读代码觉得没问题」硬，也比「类型上 message 是 string」硬
 * （类型允许它存在，只有断言不许它落地）。
 *
 * ## 事件词汇是封闭的
 *
 * 每个事件的值域都在本文件里枚举（`DiagEvent`）。没有 `Record<string, unknown>`
 * 这种口袋字段——一旦有，下一个加字段的人就有地方塞内容。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRecorder, DIAG_LIMIT_BYTES, type DiagEvent } from '../electron/diagnostics/recorder.ts'

const dirs: string[] = []
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'qua-diag-'))
  dirs.push(d)
  return d
}
process.on('exit', () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function lines(dir: string): string[] {
  const f = join(dir, 'history.jsonl')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').split('\n').filter((l) => l.length > 0)
}

/* ═══════════════════════════════════════════════════════
   ① 永不记内容（本文件最重要的一条）
   ═══════════════════════════════════════════════════════ */

test('记录器：**永不记内容**——喂含笔记正文的错误，落盘文件里搜不到它', () => {
  const dir = tmpDir()
  const r = createRecorder({ dir })
  const SECRET = '我的私密笔记-vault-口令'
  const fakeErr = new Error(SECRET)
  r.error('uncaught', fakeErr)
  r.flush()

  const raw = readFileSync(join(dir, 'history.jsonl'), 'utf8')
  assert.ok(!raw.includes('私密笔记'), `错误 message 不许进日志：${raw}`)
  assert.ok(!raw.includes('口令'), `中文内容也不许进日志：${raw}`)
})

test('记录器：**永不记路径**——喂含绝对路径的错误，落盘文件里搜不到路径', () => {
  const dir = tmpDir()
  const r = createRecorder({ dir })
  const PATHY = '/Users/someone/Documents/我的日记/2026-11-12.md'
  r.error('unhandled', new Error(`ENOENT: no such file or directory, open '${PATHY}'`))
  r.flush()

  const raw = readFileSync(join(dir, 'history.jsonl'), 'utf8')
  assert.ok(!raw.includes('/Users/someone'), `绝对路径不许进日志：${raw}`)
  assert.ok(!raw.includes('我的日记'), `页面名不许进日志：${raw}`)
})

test('记录器：错误只落**封闭的 family 词**，不落 message 的任何片段', () => {
  const dir = tmpDir()
  const r = createRecorder({ dir })
  r.error('uncaught', new Error('EACCES: permission denied, open /etc/shadow'))
  r.flush()

  const ev = JSON.parse(lines(dir)[0]!) as DiagEvent
  assert.equal(ev.kind, 'error')
  // family 必须落在登记过的枚举里；message 一个片段都不许出现
  assert.ok(['unknown', 'io', 'network', 'parse', 'assert', 'budget'].includes((ev as { family: string }).family))
  assert.equal(Object.keys(ev).includes('message'), false, `事件不许有 message 字段：${JSON.stringify(ev)}`)
})

/* ═══════════════════════════════════════════════════════
   ② 事件词汇封闭
   ═══════════════════════════════════════════════════════ */

test('记录器：只接受登记过的事件种类（未登记的 kind 被拒，不静默写进去）', () => {
  const dir = tmpDir()
  const r = createRecorder({ dir })
  // 故意绕过类型：模拟「有人加了个新 kind 但没登记」
  const bad = { kind: 'whatever-i-want', payload: 'secret' } as unknown as DiagEvent
  const ok = r.push(bad)
  assert.equal(ok, false, '未登记的 kind 必须被拒')
  r.flush()
  assert.equal(lines(dir).length, 0, '被拒的事件不许落盘')
})

test('记录器：每条事件都有 schemaVersion 与 elapsedMs（报告能对上版本）', () => {
  const dir = tmpDir()
  const r = createRecorder({ dir })
  r.launch({ version: '1.0.0', platform: 'darwin', isolated: true })
  r.flush()
  const ev = JSON.parse(lines(dir)[0]!) as Record<string, unknown>
  assert.equal(typeof ev.schemaVersion, 'number')
  assert.equal(typeof ev.elapsedMs, 'number')
  assert.ok((ev.elapsedMs as number) >= 0)
})

/* ═══════════════════════════════════════════════════════
   ③ 上一次运行是不是正常退出
   ═══════════════════════════════════════════════════════ */

test('记录器：`session-active` 标记 —— 启动时存在 ⇒ 上次非正常退出', () => {
  const dir = tmpDir()
  // 第一次运行：起来、没走 orderly exit（模拟崩溃/被 kill）
  const r1 = createRecorder({ dir })
  r1.launch({ version: '1.0.0', platform: 'darwin', isolated: false })
  r1.flush()
  assert.ok(existsSync(join(dir, 'session-active')), '运行中应有 session-active 标记')

  // 第二次运行：启动时看见标记 ⇒ 报告「上次非正常退出」
  const r2 = createRecorder({ dir })
  assert.equal(r2.previousExitUnclean, true, '上次没走 orderly exit')
})

test('记录器：正常退出会删掉 `session-active`（下次启动不再报非正常）', () => {
  const dir = tmpDir()
  const r1 = createRecorder({ dir })
  r1.launch({ version: '1.0.0', platform: 'darwin', isolated: false })
  r1.orderlyExit()
  assert.equal(existsSync(join(dir, 'session-active')), false)

  const r2 = createRecorder({ dir })
  assert.equal(r2.previousExitUnclean, false)
})

test('记录器：启动时读得到**上一次运行**的历史（这次崩了也能描述上一次）', () => {
  const dir = tmpDir()
  const r1 = createRecorder({ dir })
  r1.launch({ version: '1.0.0', platform: 'darwin', isolated: false })
  r1.push({ kind: 'count', what: 'blocks', n: 42 })
  r1.flush()

  const r2 = createRecorder({ dir })
  const prev = r2.previousEvents()
  assert.ok(prev.length >= 2, `应读到上次的事件：${JSON.stringify(prev)}`)
  assert.ok(prev.some((e) => e.kind === 'count' && (e as { n: number }).n === 42))
})

/* ═══════════════════════════════════════════════════════
   ④ 上限与轮转
   ═══════════════════════════════════════════════════════ */

test('记录器：写满上限之后**停止追加并诚实标记**（不静默丢、也不无限长）', () => {
  const dir = tmpDir()
  const r = createRecorder({ dir })
  // 灌到明显超过上限
  for (let i = 0; i < 20000; i++) r.push({ kind: 'count', what: 'blocks', n: i })
  r.flush()

  const size = statSync(join(dir, 'history.jsonl')).size
  assert.ok(size <= DIAG_LIMIT_BYTES * 1.2, `不许远超上限：${size} vs ${DIAG_LIMIT_BYTES}`)
  const all = lines(dir)
  assert.ok(all.length > 0)
  // 最后一条应是一个「我截断了」的诚实标记，而不是假装什么都没发生
  const last = JSON.parse(all[all.length - 1]!) as DiagEvent
  assert.equal(last.kind, 'truncated', `超上限要留一条诚实标记，实际最后一条：${JSON.stringify(last)}`)
})

/* ═══════════════════════════════════════════════════════
   ⑤ 崩溃事件（主进程 / 渲染进程）
   ═══════════════════════════════════════════════════════ */

test('记录器：崩溃只记 process ＋ 封闭 reason，不记崩溃堆栈', () => {
  const dir = tmpDir()
  const r = createRecorder({ dir })
  r.crash('renderer', 'crashed')
  r.flush()
  const ev = JSON.parse(lines(dir)[0]!) as Record<string, unknown>
  assert.equal(ev.kind, 'crash')
  assert.equal(ev.process, 'renderer')
  assert.equal(ev.reason, 'crashed')
  assert.equal(Object.keys(ev).includes('stack'), false, '不许记堆栈')
})

test('记录器：未知的崩溃原因降级成 `unknown`（不把外部字符串透传进日志）', () => {
  const dir = tmpDir()
  const r = createRecorder({ dir })
  // Electron 的 reason 是外部给的字符串，可能含任意内容
  r.crash('renderer', 'evil</script>/Users/me/secret' as never)
  r.flush()
  const raw = readFileSync(join(dir, 'history.jsonl'), 'utf8')
  assert.ok(!raw.includes('/Users/me'), `外部 reason 不许透传：${raw}`)
  const ev = JSON.parse(lines(dir)[0]!) as Record<string, unknown>
  assert.equal(ev.reason, 'unknown')
})
