/**
 * **覆盖层的焦点归还**。
 *
 * 为什么它是一个独立原语、而不是三处 `close()` 里各写一行：这条规矩的失效**不报错**。
 * 关掉浮层之后焦点掉到 `BODY`，用户接着打字 —— 一个字符都进不去，正文一字不变，
 * 屏幕上也没有任何提示。看起来像「输入法坏了」或「应用卡住了」。
 *
 * 实测（真按键，非合成事件）：`⌘P` 开命令面板 → `Esc` 关掉 → 打字 ⇒
 * `activeElement === BODY`、正文零变化；`⌥` 点原子 → 点浮层输入框 → `Esc` → 打字 ⇒ 同样。
 * 这两条都是桌面端的日常路径（「看一眼详情，关掉，继续写」）。
 *
 * 口径：
 *   1. **打开时记下**焦点在哪（哪个元素、它在哪个可编辑宿主里）；
 *   2. **关闭时归还**——按记下的那个元素还，还不上就退回它的编辑宿主；
 *   3. **只在焦点还留在覆盖层里（或已经丢了）时才归还**。
 *      用户点到别处（另一块正文、另一槽）关掉浮层时，焦点该跟着他的点击走，
 *      不能被「归还」抢回旧位置 —— 那会变成「点了没反应」的另一种形态。
 *
 * ⚠️ **焦点回来 ≠ 能打字。** 编辑器的「能打字」判据是**模型选区**，DOM 焦点只是它的宿主：
 *    焦点落回容器而原生 Range 已经没了（`rangeCount === 0`）时，按键仍然一个字符都进不去。
 *    ⇒ `restore()` 会返回它真正聚焦的那个元素，调用方据此决定要不要**把选区重新投影回 DOM**
 *      （`App` 门面有这一手；`ui/` 不认识编辑器，所以这件事只能由装配层接）。
 */

/** 一次覆盖层会话：记住「打开之前焦点在哪」 */
export interface FocusReturn {
  /**
   * 把焦点还回去；判据见文件头第 3 条。
   *
   * @returns 真正被聚焦的元素（没有归还时 `null`）。调用方据此判断「要不要顺带
   *          把选区投影回 DOM」——见下方 ⚠️。
   */
  restore: (overlay: HTMLElement | null) => HTMLElement | null
}

export function captureFocus(): FocusReturn {
  const active = document.activeElement
  // `body`／`null` ＝ 打开之前焦点就不在任何元素上（用户刚点过空白），别硬塞一个焦点
  if (!(active instanceof HTMLElement) || active === document.body) {
    return { restore: () => null }
  }
  const host = active.closest<HTMLElement>('[contenteditable="true"]') ?? null
  return {
    restore: (overlay) => {
      // 焦点已经被用户带到别处了（点了另一块正文）：那是他自己的落点，别抢回来
      const now = document.activeElement
      const focusLeftOverlay =
        now instanceof HTMLElement && now !== document.body && !(overlay?.contains(now) ?? false)
      if (focusLeftOverlay) return null

      if (active.isConnected) {
        active.focus()
        return active
      }
      // 那个元素已经不在了（被重渲染换掉）：退回它所在的编辑宿主，别让按键落空
      if (host && host.isConnected) {
        host.focus()
        return host
      }
      return null
    },
  }
}
