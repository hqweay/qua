/**
 * **输入法「组合是否已结束」的唯一判据**（`core/ime.ts`）。
 *
 * 为什么值得单测：这条判据是**组合期守卫的解除条件**。守卫本身（组合期不换 DOM）挡的是
 * 「预编辑串被冻结成正文」那一类事故；判据错了，守卫要么永远不解除（正文停在旧形状），
 * 要么提前解除（等于没有守卫）。两种情况都不报错，只能靠断言钉住。
 *
 * 口径：
 *   · 只有 `isComposing === false` 且 `inputType` 是**文本提交**那三种，才算「组合结束」；
 *   · `insertCompositionText` **不算** —— 那是候选窗在更新（用户还在选词）；
 *   · 退格／换行／粘贴／拖放**不算** —— 它们不是「候选词落地」。
 */
import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { isCommittedTextInput } from '../src/core/ime.ts'

const ev = (inputType: string, isComposing: boolean) => ({ inputType, isComposing }) as InputEvent

test('文本提交的三种 inputType 都算「组合已结束」', () => {
  for (const inputType of ['insertText', 'insertReplacementText', 'insertFromComposition']) {
    assert.equal(isCommittedTextInput(ev(inputType, false)), true, `${inputType} 应算提交`)
  }
})

test('候选窗更新（insertCompositionText）不算提交，组合中间态也不算', () => {
  assert.equal(isCommittedTextInput(ev('insertCompositionText', true)), false, '候选更新期间不能结束组合')
  assert.equal(isCommittedTextInput(ev('insertCompositionText', false)), false, 'insertCompositionText 不是提交信号')
  for (const inputType of ['insertText', 'insertReplacementText', 'insertFromComposition']) {
    assert.equal(isCommittedTextInput(ev(inputType, true)), false, `${inputType} 在组合中不算提交`)
  }
})

test('非文本提交的输入类型不算（退格／换行／粘贴／拖放）', () => {
  for (const inputType of [
    'deleteContentBackward',
    'deleteContentForward',
    'insertLineBreak',
    'insertParagraph',
    'insertFromPaste',
    'insertFromDrop',
    'deleteByDrag',
    'historyUndo',
  ]) {
    assert.equal(isCommittedTextInput(ev(inputType, false)), false, `${inputType} 不该结束组合期`)
  }
})
