/**
 * **「这一笔输入算不算组合已经结束」—— 输入法的唯一恢复判据。**
 *
 * 为什么需要它（而不是只看 `compositionend`）：
 * `compositionend` **不是可靠终点**。外接键盘、部分输入法在提交后根本不发它，
 * 于是「组合中」这个状态会永久为真。而组合期在编辑器里是**一条硬禁令**——
 * 不许换承载块的 DOM（换掉会把预编辑串冻结成正文）。状态卡住的代价因此很大：
 * 正文会一直停在旧形状，用户以为「改不生效」。
 *
 * 判据（纯函数，无 DOM）：
 *   · `isComposing === false` —— 这一笔不是组合中间态；
 *   · `inputType ∈ {insertText, insertReplacementText, insertFromComposition}` ——
 *     它是一次**文本提交**，而不是退格/换行/粘贴/拖放。
 *
 * ⚠️ **`insertCompositionText` 不算**：那是候选窗在更新（`isComposing` 通常为真），
 *    把它当提交信号会在用户还在选词时就结束组合期。
 * ⚠️ **`insertFromComposition` 算**：它是「组合已经结束、文本落地」的那一笔。
 */
const COMMITTED_INPUT_TYPES = new Set(['insertText', 'insertReplacementText', 'insertFromComposition'])

/** 这一笔 `input` 是不是「组合已结束、文本已提交」的信号 */
export function isCommittedTextInput(e: Pick<InputEvent, 'isComposing' | 'inputType'>): boolean {
  return e.isComposing === false && COMMITTED_INPUT_TYPES.has(e.inputType)
}
