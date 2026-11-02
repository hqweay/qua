/**
 * 行内小输入框的「Enter 提交／Esc 取退」守卫。
 *
 * 这是同一份判断的第 N 份拷贝收口：此前 properties／choices-editor 各写一遍 keydown
 * 分支，其中两份漏了 IME 守卫——组合期的 Enter 是输入法的「选词那一下」，
 * 不是提交；漏了它，中文输入法回车选词会当场把中间态提交出去。
 *
 * `cancel` 不传 ⇒ Esc 不接管（保持该输入框原有的 Esc 语义）；`stop` ⇒ 同时
 * `stopPropagation`（嵌在块编辑器里的输入框，Enter 会被外层当成「拆块」命令）。
 */
export function onCommitKeys(
  el: HTMLElement,
  opts: { commit: () => void; cancel?: () => void; stop?: boolean },
): void {
  el.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    if (e.key !== 'Enter' && e.key !== 'Escape') return
    if (e.key === 'Escape' && !opts.cancel) return
    e.preventDefault()
    if (opts.stop) e.stopPropagation()
    if (e.key === 'Escape') opts.cancel!()
    else opts.commit()
  })
}
