/**
 * 视图命令：主题三档与槽开关。
 */
import { nextTheme } from '../../core/infra/theme.ts'
import type { SecLayout } from '../../core/index.ts'
import type { ThemeMode } from '../../core/infra/workspace.ts'
import type { PropsLineDensity } from '../../core/props/props.ts'
import type { App } from '../../core/infra/ports.ts'
import type { ViewDeps } from './types.ts'

export function viewCommands(
  d: ViewDeps,
): Pick<
  App,
  'setTheme' | 'toggleTheme' | 'setLocale' | 'toggleDock' | 'journalFeedLayout' | 'setPropsDensity' | 'setPropsLineMode'
> {
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

    /**
     * 界面语言：写设备偏好、落盘、整页重载。
     *
     * 为什么不就地换：命令表、绑定表在 import 时就把 title／label 取成字符串存下来了，
     * 就地 `setLocale` 只会让「现取现翻」的那部分变语言，菜单和命令面板仍是旧语言。
     * 重载让所有 import 重跑——这次 `boot/locale.ts` 先读到新档位，整份界面一致。
     */
    setLocale: (locale) => {
      const next = locale === 'en' || locale === 'zh' ? locale : null
      if (next === null) return
      if (d.prefs().locale === next) return
      d.prefs().locale = next
      d.flushDevice()
      d.reloadWindow()
    },

    /** 槽的开关归槽自己：`⌘⌥1/2` 与抬头按钮走同一条 */
    toggleDock: (side) => {
      /**
       * 取反的是**屏幕上这一侧现在的样子**，不是落盘那一位——
       * 两者在档位期间会分叉（档位强制收起的槽，prefs 里仍是开着的）。
       * 按落盘值取反 ⇒ 用户按「开」，档位却把它按回去（一次点了没反应）。
       * 档位在场时顺带让这一侧脱离强制收起：用户显式动了，以他这次为准。
       */
      d.prefs().dock[side].open = !d.axisSlotOpen(side)
      d.noteSlotChanged(side)
      d.applyChrome()
      d.scheduleDeviceSave()
      d.scheduleBadge()
    },

    /**
     * 日记流的段排列（设备偏好）：只写偏好与落盘，不重装当前视图——
     * 下次「回今日」按它装载；当前屏要换排列走复盘那条带参路径。
     * 排列切换的 UI 入口（picker 家族）接这里。
     */
    journalFeedLayout: (layout) => {
      const m: SecLayout = layout === 'row' ? 'row' : 'column'
      if (d.prefs().feedLayout === m) return
      d.prefs().feedLayout = m
      d.scheduleDeviceSave()
      d.scheduleBadge()
    },

    /**
     * **块下属性的默认密度**（设备态）：`summary` 一行摘要／`list` 一栏一行。
     *
     * 它只是**默认值**：`propsLineMode` 里那些单块覆盖照旧生效，改默认**不清**它们
     * （每一条都是用户对某一块的显式决定，默认值不该替他撤销）。
     *
     * 与主题那种「只换 token」的偏好不同，它**改行高** ⇒ 必须重排这一屏：
     * 虚拟化的占位是按行高累加的，不重排就只是「可见区对了、滚动条不对」。
     */
    setPropsDensity: (density) => {
      const m: PropsLineDensity = density === 'list' ? 'list' : 'summary'
      if (d.prefs().propsDensity === m) return
      d.prefs().propsDensity = m
      d.scheduleDeviceSave()
      d.refreshLayout()
      d.scheduleBadge()
    },

    /**
     * **单块显式覆盖**（设备态，与块折叠 `folded` 同族：按块 id、不写库、不进撤销）。
     *
     * `mode === ''` ⇒ **清除覆盖**，这一块回到跟随默认。三种状态各有入口：
     *   · `+N` / 「展开」⇒ `'list'`
     *   · 「收起」⇒ `'summary'`（默认档是 list 时也收得回去）
     *   · 「跟随默认」⇒ `''`
     *
     * 双向是硬要求：只有「展开」没有「收起」时，把默认档切到 list 就等于把每一块
     * 永久锁死在全显——那不叫默认值，叫一刀切。
     */
    setPropsLineMode: (blockId, mode) => {
      if (blockId === '') return
      const next = { ...d.prefs().propsLineMode }
      if (mode === 'summary' || mode === 'list') next[blockId] = mode
      else delete next[blockId]
      d.prefs().propsLineMode = next
      d.scheduleDeviceSave()
      d.refreshLayout()
      d.scheduleBadge()
    },
  }
}
