/**
 * 代码岛的纯判据：语言归一、撤销合并、外部写回、键位归属。
 * 真正的 CM6 实例靠真机验收；这里只钉那些「错了也不会报错」的口径。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CODE_ISLAND_ATTR,
  CODE_MAX_HEIGHT_TOKEN,
  canonicalLang,
  codeNeedsWriteBack,
  normalizeStoredLang,
  shouldMergeCodeUndo,
} from '../src/core/infra/code-lang.ts'
import { appKeyWhileCodeFocused } from '../src/core/infra/dispatch.ts'

test('语言别名收成规范名，不认识的语言按纯文本画但仍原文照存', () => {
  assert.equal(canonicalLang('js'), 'javascript')
  assert.equal(canonicalLang('TS'), 'typescript')
  assert.equal(canonicalLang('py'), 'python')
  assert.equal(canonicalLang('yml'), 'yaml')
  assert.equal(canonicalLang('sh'), 'bash')
  assert.equal(canonicalLang('md'), 'markdown')
  assert.equal(canonicalLang(''), 'plain')
  assert.equal(canonicalLang('brainfuck'), 'plain')
  assert.equal(normalizeStoredLang(' js '), 'javascript')
  assert.equal(normalizeStoredLang('brainfuck'), 'brainfuck', '未知名字不静默吞掉')
  assert.equal(normalizeStoredLang('  '), undefined)
})

test('连续输入才合并撤销：删除、搜索替换与久隔都单独成步', () => {
  const first = { at: 1000, from: 2, inserted: 1, deleted: 0 }
  assert.equal(shouldMergeCodeUndo(null, first), false)
  assert.equal(shouldMergeCodeUndo(first, { at: 1200, from: 3, inserted: 1, deleted: 0 }), true)
  assert.equal(shouldMergeCodeUndo(first, { at: 1500, from: 3, inserted: 1, deleted: 0 }), false, '超过时间窗')
  assert.equal(shouldMergeCodeUndo(first, { at: 1100, from: 5, inserted: 1, deleted: 0 }), false, '位置不相接')
  assert.equal(shouldMergeCodeUndo(first, { at: 1100, from: 3, inserted: 4, deleted: 1 }), false, '有删除')
  assert.equal(shouldMergeCodeUndo(first, { at: 1100, from: 3, inserted: 0, deleted: 0 }), false)
})

test('外部写回只在文本真的不同时发生，自己的写不回灌', () => {
  assert.equal(codeNeedsWriteBack('const a = 1', 'const a = 1'), false)
  assert.equal(codeNeedsWriteBack('const a = 1', ''), true)
})

test('岛内焦点：文本键归岛，全局键与应用撤销照常', () => {
  assert.equal(appKeyWhileCodeFocused({ when: 'editorTextFocus', command: 'core.editor/split-block' }), false)
  assert.equal(appKeyWhileCodeFocused({ when: 'blockSelection', command: 'core.editor/delete-selected-blocks' }), false)
  assert.equal(appKeyWhileCodeFocused({ when: '', command: 'core.command-palette/show' }), true)
  assert.equal(appKeyWhileCodeFocused({ when: '', command: 'core.history/back' }), true)
  assert.equal(appKeyWhileCodeFocused({ when: 'editorTextFocus', command: 'core.history/undo' }), true)
  assert.equal(appKeyWhileCodeFocused({ when: 'editorTextFocus', command: 'core.history/redo' }), true)
})

test('DOM 标记与高度上限都走常量，不在组件里写第二份', () => {
  assert.equal(CODE_ISLAND_ATTR, 'data-code-island')
  assert.equal(CODE_MAX_HEIGHT_TOKEN, '--ui-code-max-h')
})
