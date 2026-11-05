/**
 * 菜单开着时，这一击归谁。
 *
 * 单独一格的理由：这条判断（含「组合期一律不管」那条）是**纯的**，值得被单测钉住；
 * 而 `Layers` 的按键处理器住在 `document` 捕获阶段、离不开 DOM。把判断抽出来后，
 * 处理器只负责「照判断做事」，判断本身在 node 里可跑。
 */
export type MenuKeyAction = 'ignore' | 'up' | 'down' | 'pick' | 'close' | 'tab-prev' | 'tab-next' | 'pass'

export interface MenuKeyEvent {
  key: string
  /** 输入法正在组词（`KeyboardEvent.isComposing`） */
  isComposing?: boolean
  shiftKey?: boolean
}

export function menuKeyAction(e: MenuKeyEvent): MenuKeyAction {
  /**
   * **组合期的键归输入法**，不管菜单开着没有。
   *
   * 现在最疼的一处：搜索框里用输入法打中文，按 `↵` 是在**确认候选**，
   * 但处理器挂在捕获阶段、比输入法/输入框都早——它会把 `↵` 当成「选中这一行」，
   * 于是选完候选顺手把命令执行了。组合期的 `↵` 不是用户的「确认」，是输入法的。
   */
  if (e.isComposing) return 'ignore'
  switch (e.key) {
    case 'ArrowDown':
      return 'down'
    case 'ArrowUp':
      return 'up'
    case 'Enter':
      return 'pick'
    case 'Escape':
      return 'close'
    case 'Tab':
      return e.shiftKey ? 'tab-prev' : 'tab-next'
    default:
      return 'pass'
  }
}
