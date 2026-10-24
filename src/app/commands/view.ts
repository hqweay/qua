/**
 * 视图命令：主题三档与槽开关。
 */
import { nextTheme } from '../../core/theme.ts'
import type { ThemeMode } from '../../core/workspace.ts'
import type { App } from '../../core/ports.ts'
import type { ViewDeps } from './types.ts'

export function viewCommands(d: ViewDeps): Pick<App, 'setTheme' | 'toggleTheme' | 'toggleDock'> {
  return {
    /**
     * 三档**直选**（不是循环切换）。
     * 原来只有 `toggle-theme`（循环），那是给一个常驻按钮用的；
     * 顶栏开关撤掉后改由菜单三选一 ⇒ 必须能直接落到某一档。
     */
    setTheme: (mode) => {
      const m = (['system', 'light', 'dark'] as ThemeMode[]).includes(mode as ThemeMode) ? (mode as ThemeMode) : 'system'
      d.prefs().theme = m
      d.applyChrome()
      d.renderDebugState()
      // 主题是**设备状态**：落 `qua.device`，不触库的落盘（调色不该改写内容）
      d.scheduleDeviceSave()
      d.scheduleBadge()
    },

    toggleTheme: () => {
      d.prefs().theme = nextTheme(d.prefs().theme)
      d.applyChrome()
      d.renderDebugState()
      d.scheduleDeviceSave()
      d.scheduleBadge()
    },

    /** 槽的开关归槽自己：`⌘⌥1/2` 与抬头按钮走同一条 */
    toggleDock: (side) => {
      const slot = d.prefs().dock[side]
      slot.open = !slot.open
      d.applyChrome()
      d.scheduleDeviceSave()
      d.scheduleBadge()
    },
  }
}
