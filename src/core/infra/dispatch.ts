/**
 * 键位派发。
 *
 * 这里**没有任何手写的键位分支**：一次按键做的事永远是
 *   `resolveKey(事件, 上下文键)` → `registry.invoke(命令, 参数, 'keymap')`
 * 键位表在 `bindings.ts`，命令表在 `commands.ts`，本文件只是**把两者接起来的那一根线**。
 *
 * 单独成文件的原因（2026-10-19 拆分）：它原先长在 `main.ts` 里，与状态持有、DOM 渲染、
 * 持久化时序混在一起；而它的输入输出其实非常窄 —— 需要「当前上下文键」和「派发一个命令」。
 * 把这两个做成参数，本文件就能在没有装配层的情况下被单独理解。
 */

import { eventKeyId, resolveKey, type Binding } from './bindings.ts'
import type { CtxKeys } from '../index.ts'
/** 派发所需的最小环境（由装配层注入） */
export interface DispatchEnv {
  /** 求值 `when` 用的上下文键 */
  ctx: () => CtxKeys
  isMac: () => boolean
  /** 执行一条命令，返回「是否真的处理了」（false ⇒ 不 preventDefault，让浏览器自己来） */
  invoke: (name: string, args: Record<string, unknown>, ctx: CtxKeys) => boolean
  /** 按键命中追踪（诊断）：命中与未命中都记，最多 40 条 */
  trace?: (t: KeyTrace) => void
  /** 覆盖层是否打开（打开时按键归覆盖层，不派发） */
  layerOpen: () => boolean
}

export interface KeyTrace {
  key: string
  hit: string
  when: string
  ok: boolean
}

/**
 * 系统级「撤销」快捷键：**一律归 app 的撤销栈**。
 * 原生 contenteditable 的撤销不懂块结构（拆块／缩进／原子会被打散），所以编辑器里要吞掉它；
 * 焦点在别处时**放行**（将来由页面级撤销承接，不该被这里静默吃掉）。
 */
const UNDO_KEYS = new Set(['mod+z', 'mod+shift+z', 'mod+y', 'ctrl+z', 'ctrl+shift+z', 'ctrl+y'])

export function isUndoKey(e: KeyboardEvent, isMac: boolean): boolean {
  return UNDO_KEYS.has(eventKeyId(e, isMac))
}

/**
 * 代码岛里有焦点时，键位归谁。
 *
 * 岛里的 Enter／Tab／⌘A 等文本键归岛（CM6 自己处理），编辑器作用域的绑定必须让路；
 * 应用级全局键（空 `when` 或导航上下文）照常生效；撤销/重做仍归应用栈
 * （CM6 的历史被关掉，两套历史并存会让一次 ⌘Z 只撤一半）。
 */
export function appKeyWhileCodeFocused(b: Pick<Binding, 'when' | 'command'>): boolean {
  // 撤销/重做归应用栈；任务切换由岛内 keymap 自己调（见 code-island），不在全局再走一遍
  if (b.command === 'core.history/undo' || b.command === 'core.history/redo') return true
  const when = b.when ?? ''
  return !when.includes('editorTextFocus') && !when.includes('blockSelection')
}
/**
 * 一次按键 → 一条命令。
 * @returns 是否已处理（true ⇒ 调用方应 `preventDefault`）
 */
export function dispatchKey(e: KeyboardEvent, env: DispatchEnv): boolean {
  const ctx = env.ctx()
  const res = resolveKey(e, ctx, env.isMac())
  if (ctx.codeEditorFocus === true && res.hit && !appKeyWhileCodeFocused(res.hit)) return false
  if (env.trace) {
    env.trace({
      key: res.id,
      hit: res.hit ? `${res.hit.command ?? ''}${res.hit.key ? ` (${res.hit.key})` : ''}` : '',
      when: res.attempts.find((a) => !a.whenOk)?.binding.when ?? '',
      ok: Boolean(res.hit),
    })
  }
  if (!res.hit) return false
  const command = res.hit.command
  if (!command) return false
  return env.invoke(command, (res.hit.args as Record<string, unknown>) ?? {}, ctx)
}

/**
 * 全局按键入口：装一次 `document` 的 keydown。
 *
 * 两段处理：
 * 1. **`⌘Z` 族**：capture 阶段先判；编辑区里交给绑定表、并吞掉原生撤销；
 *    表单字段（input／textarea）里的文本不属于模型，撤销归原生；焦点在别处则放行。
 * 2. **其余按键**：bubble 阶段走绑定表；覆盖层打开时不碰（覆盖层有自己的一份 capture）。
 */
export function installKeydown(env: DispatchEnv, opts: { editorEl: HTMLElement }): void {
  // ① 撤销键：capture，抢在 contenteditable 默认行为之前
  document.addEventListener(
    'keydown',
    (e) => {
      if (env.layerOpen()) return
      if (!isUndoKey(e, env.isMac())) return
      const target = e.target as HTMLElement | null
      const inTextInput = Boolean(target && (target.closest('input, textarea') || target.isContentEditable))
      const inEditor = opts.editorEl.contains(target)
      if (!inTextInput && !inEditor) return // 焦点在别处：不拦
      if (!inEditor) {
        /**
         * **表单字段里的文本不属于模型**（别名、筛选、查询草稿都在字段里）：撤销该归输入框自己。
         * 只有**真的派发到一条命令**时才吞掉这个键 —— 否则「模型没接、原生也被拦」= 死键
         * （实测：别名输入框里粘贴后按 ⌘Z，一个字都不退）。
         */
        if (dispatchKey(e, env)) e.preventDefault()
        return
      }
      e.preventDefault() // 编辑器里：绑定表已派发过，原生撤销永不上场
    },
    true,
  )

  // ② 其余按键：bubble
  document.addEventListener('keydown', (e) => {
    if (env.layerOpen()) return // 菜单的 capture 监听器已经处理（↑↓/Enter/Esc）
    if (dispatchKey(e, env)) e.preventDefault()
  })
}
