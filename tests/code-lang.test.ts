/**
 * 代码语言表的判据：**一表就是全部**。
 *
 * 这张表同时喂三处——徽章上的字、块菜单里那一族行、按需加载点。三处分别手抄一份的
 * 后果都是「说不清是哪里漏了」：语言单里没有它／菜单里点不到／点了不高亮。
 * 所以这里钉三件事：清单本身没有自相矛盾、别名不打架、**每一门语言都真的有加载点**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CODE_LANG_DECLS,
  CODE_LANGS,
  canonicalLang,
  codeLangLabel,
  normalizeStoredLang,
} from '../src/core/index.ts'
import { codeLangHasLoader } from '../src/view/editor/code-island.ts'
import { BINDINGS } from '../src/core/infra/bindings.ts'

test('语言表：id 不重复、plain 在首位、显示名非空', () => {
  assert.equal(new Set(CODE_LANGS).size, CODE_LANGS.length, '同一个 id 出现了两次')
  assert.equal(CODE_LANGS[0], 'plain', 'plain 必须在首位（菜单第一行是「纯文本」）')
  for (const id of CODE_LANGS) {
    assert.ok(codeLangLabel(id).trim() !== '', `${id} 没有显示名`)
  }
})

test('语言表：每一门都有加载点（加语言不能只加一行字）', () => {
  for (const id of CODE_LANGS) {
    assert.ok(codeLangHasLoader(id), `${id} 在语言表里，但没有语法加载点`)
  }
})

test('菜单那一族行与语言表同源：一门语言恰好一行，参数就是它的 id', () => {
  const rows = BINDINGS.filter((b) => b.command === 'core.block/set-lang' && b.kind === 'menu')
  assert.deepEqual(
    rows.map((r) => (r.args as { lang: string }).lang),
    [...CODE_LANGS],
    '菜单行与语言表的顺序/内容必须逐项对齐',
  )
  for (const r of rows) assert.ok(r.actsOn === 'block', '语言行作用在块上，不是编辑器的光标')
})

test('别名收成规范名；不认识的写法原文照存、原文照显', () => {
  assert.equal(canonicalLang('js'), 'javascript')
  assert.equal(canonicalLang('TS'), 'typescript')
  assert.equal(canonicalLang('yml'), 'yaml')
  assert.equal(canonicalLang('c++'), 'cpp')
  assert.equal(canonicalLang('postgres'), 'sql')
  assert.equal(canonicalLang(''), 'plain')
  assert.equal(canonicalLang(undefined), 'plain')
  assert.equal(canonicalLang('zig'), 'plain', '不认识的语言按纯文本画（渲染口径）')

  assert.equal(normalizeStoredLang('js'), 'javascript')
  assert.equal(normalizeStoredLang('Zig'), 'Zig', '不认识的写法不许被静默吞掉')
  assert.equal(normalizeStoredLang('  '), undefined)

  assert.equal(codeLangLabel('zig'), 'zig', '徽章照实显示盘上的写法')
  assert.equal(codeLangLabel('ts'), 'TypeScript')
  assert.equal(codeLangLabel(''), codeLangLabel('plain'))
})

test('别名不打架：同一个写法不许指向两门语言', () => {
  const seen = new Map<string, string>()
  for (const d of CODE_LANG_DECLS) {
    for (const key of [d.id, ...(d.aliases ?? [])]) {
      const prev = seen.get(key)
      assert.equal(prev, undefined, `「${key}」同时挂在 ${prev} 和 ${d.id} 上`)
      seen.set(key, d.id)
    }
  }
  // 借 `canonicalLang` 验一遍：每门语言自己的 id 都只映射回自己
  for (const id of CODE_LANGS) {
    assert.equal(canonicalLang(id), id, `${id} 的 id 被别的别名抢走了`)
  }
})
