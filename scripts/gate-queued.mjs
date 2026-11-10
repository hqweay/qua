#!/usr/bin/env node
/**
 * **排队的收工门禁**：多人或多个任务共用一台机器时的 `pnpm gate`。
 *
 * 为什么要有它：全量 gate 是几分钟的 CPU 排他活，两份并发跑会互相拖慢，
 * 而且并发还有两种**比慢更糟**的病（实测）——
 *   · **共享 `dist`**：一方的 `vite build` 在清空重写 dist 时，另一方的冒烟分片正在读它
 *     ⇒「这份构建没有带测试面」这类假红；
 *   · **共享工作树**：gate 构建的是「当下的树」，别的任务改到一半的文件被打进产物
 *     ⇒ 红了不知道算谁的。
 *
 * 三条机制各治一种：
 *   1. **文件锁串行**：一次只跑一份（mkdir 原子性当锁；带 pid 与时限，崩溃残留能自愈）；
 *   2. **隔离 worktree**：在临时 worktree 里 `checkout` 锁内拿到的 HEAD 再构建——
 *      构建面只含已提交的内容，别的任务的半成品进不来；
 *   3. **要求干树**：本仓有未提交改动就拒绝——gate 的对象是 commit，不是「大概是这个状态」。
 *
 * 绿了不自动 push：push 仍由调用方决定（锁内绿的那个 HEAD 就是可发布的凭证）。
 *
 * 用法：`pnpm gate:queued`（等价全量 gate，串行）／`pnpm gate:queued -- --no-electron`。
 * node_modules 用主检出那份的**符号链接**（pnpm 的链接是相对路径，整目录搬走仍成立）；
 * 环境变量 `QUA_GATE_INSTALL=1` 可改成在 worktree 里真装一遍（隔离最彻底，慢）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(new URL('..', import.meta.url).pathname)
const LOCK = join(tmpdir(), 'qua-gate.lock')
const LOCK_STALE_MS = 30 * 60 * 1000
const C = { green: (s) => `\x1b[32m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m` }

const sh = (args, opts = {}) =>
  spawnSync(args[0], args.slice(1), { cwd: ROOT, encoding: 'utf8', ...opts })
const git = (args, opts = {}) => {
  const r = sh(['git', ...args], opts)
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr?.trim() || r.stdout?.trim()}`)
  return r.stdout.trim()
}

const passthrough = process.argv.slice(2).filter((a) => a === '--no-electron' || a.startsWith('--shards='))
const gateArgs = ['gate', ...passthrough]

/* ------------------------------------------------------------------ 干树检查 */

const dirty = git(['status', '--porcelain'])
if (dirty) {
  console.error(`\n${C.red('拒绝：qua 工作树有未提交改动')}——gate 验的是 commit，不是「大概是这个状态」。`)
  console.error('先提交（一个逻辑单元一笔），再来排队：')
  for (const line of dirty.split('\n').slice(0, 10)) console.error(`  ${line}`)
  process.exit(2)
}

/* ------------------------------------------------------------------ 文件锁 */

/**
 * mkdir 当锁：`mkdir` 是原子的，两个进程只有一个成功。锁目录里写 pid 与时刻，
 * 拿不到锁就等（每 2s 一试），锁主进程不在了或锁太老 ⇒ 判为崩溃残留，清掉重拿。
 */
function tryLock() {
  try {
    mkdirSync(LOCK)
    writeFileSync(join(LOCK, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }))
    return 'held'
  } catch {
    return null
  }
}
function staleLock() {
  try {
    const { pid, at } = JSON.parse(readFileSync(join(LOCK, 'owner.json'), 'utf8'))
    try {
      process.kill(pid, 0)
      return Date.now() - at > LOCK_STALE_MS
    } catch {
      return true
    }
  } catch {
    return Date.now() - (existsSync(LOCK) ? 1 : 0) > LOCK_STALE_MS
  }
}
const t0 = Date.now()
for (;;) {
  if (tryLock()) break
  if (staleLock()) {
    console.log(`  ${C.yellow('清掉残留的锁')}（锁主已不在或超时）`)
    rmSync(LOCK, { recursive: true, force: true })
    continue
  }
  if (Date.now() - t0 > 2000 && (Date.now() - t0) % 10000 < 2000) {
    const owner = (() => {
      try {
        return JSON.parse(readFileSync(join(LOCK, 'owner.json'), 'utf8')).pid
      } catch {
        return '?'
      }
    })()
    console.log(`  ${C.dim(`等锁中（${Math.round((Date.now() - t0) / 1000)}s，持有者 pid ${owner}）——可以先继续写代码`)}`)
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000)
}

/* ------------------------------------------------------------------ 锁内：worktree + gate */

let wt = null
let exitCode = 1
try {
  const sha = git(['rev-parse', 'HEAD'])
  console.log(`\n${C.bold('门禁 · 排队拿到锁')}${C.dim(`（HEAD ${sha.slice(0, 9)}，${Math.round((Date.now() - t0) / 1000)}s 等到）`)}`)

  wt = join(tmpdir(), `qua-gate-wt-${Date.now()}`)
  git(['worktree', 'add', '--detach', wt, sha])

  const nm = join(wt, 'node_modules')
  if (process.env.QUA_GATE_INSTALL === '1') {
    const r = spawnSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], { cwd: wt, stdio: 'inherit' })
    if (r.status !== 0) throw new Error('worktree 里安装依赖失败')
  } else {
    symlinkSync(join(ROOT, 'node_modules'), nm, 'dir')
  }

  exitCode = await new Promise((done) => {
    // `verify-deps-before-run=false`：pnpm 11.8 起在跑脚本前隐式校验依赖，软链来的 node_modules
    // 会被判为「不匹配」并试图清掉重装——清的是主检出的依赖，且无 TTY 时直接 SIGTERM（exit 137）。
    // 软链本身是成立的（pnpm 的链接是相对路径，整目录搬走仍成立），要关的只是这个前置校验。
    const child = spawn('pnpm', ['--config.verify-deps-before-run=false', '-s', 'run', ...gateArgs], { cwd: wt, stdio: 'inherit' })
    child.on('error', (e) => {
      console.error(e.message)
      done(127)
    })
    child.on('close', (code) => done(code ?? 1))
  })
  console.log(exitCode === 0 ? `\n${C.green('门禁全绿')}（HEAD ${sha.slice(0, 9)}）—— 这个 commit 可发布` : `\n${C.red(`门禁没过（退出码 ${exitCode}）`)}——锁内 HEAD 只含已提交内容，红就归这批 commit`)
} catch (e) {
  console.error(e.message)
  exitCode = 1
} finally {
  if (wt) rmSync(wt, { recursive: true, force: true })
  try {
    git(['worktree', 'prune'])
  } catch {}
  rmSync(LOCK, { recursive: true, force: true })
}
process.exit(exitCode)
