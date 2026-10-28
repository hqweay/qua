/**
 * 门禁**必须跑到所有测试文件**：`test:core` 的 glob 不许漏掉子目录。
 *
 * 为什么这条要单独钉：`node --test tests/*.test.ts` 只匹配**一层**。
 * 把测试放进 `tests/storage/` 之后它**再也不会被执行**——而门禁照旧报绿。
 * 实测踩到：`tests/storage/ipc-adapter.test.ts` 的 11 条断言在门禁里从来没跑过，
 * 报告里却写着「465 条通过」（那 11 条不在账上）。
 *
 * 判据：`package.json` 的 `test:core` 必须用**递归** glob；且这条断言自己
 * 也要在 `tests/` 顶层（否则它自己就被漏掉——一个自我豁免的检查等于没有）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

test('test:core 的 glob 必须是递归的（子目录里的测试也要跑）', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
  }
  const cmd = pkg.scripts['test:core'] ?? ''
  assert.ok(cmd.includes('--test'), `test:core 应当跑 node --test，实际：${cmd}`)
  /**
   * 接受两种写法：`'tests/**\/*.test.ts'`（递归）或显式列出目录。
   * 不接受 `tests/*.test.ts`——它只匹配一层。
   */
  const recursive = /tests\/\*\*\/\*\.test\.ts/.test(cmd) || /tests\/\*\*/.test(cmd)
  assert.ok(
    recursive,
    `test:core 的 glob 必须递归（否则 tests/ 子目录里的文件永远不会被执行，而门禁照旧报绿）：${cmd}`,
  )
})

test('仓里确实有子目录下的测试文件（这条断言才有意义）', () => {
  /**
   * 如果将来有人把 `tests/storage/` 合并回顶层，这条会红——那时可以删掉它，
   * 但**删之前先确认**没有子目录了，否则「glob 递归」这条就失去被检验的对象。
   */
  const nested: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p, depth + 1)
      else if (name.endsWith('.test.ts')) nested.push(p.slice(ROOT.length + 1))
    }
  }
  walk(join(ROOT, 'tests'), 0)
  const inSubdir = nested.filter((p) => p.split('/').length > 2)
  assert.ok(
    inSubdir.length > 0,
    `没有子目录下的测试文件了（${nested.length} 个都在顶层）⇒ 递归 glob 那条失去检验对象，可以一并删掉`,
  )
})
