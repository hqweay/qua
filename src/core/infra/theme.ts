/**
 * 主题档位—— **纯逻辑，零 DOM**。
 *
 * 三档：跟随系统 / 亮 / 暗。颜色**不由 JS 决定**：由 `styles.css` 的
 * `color-scheme` ＋ `light-dark()` 取，`data-theme` 只记档位，不切类（避免首屏闪烁）。
 * 这里只提供「档位怎么循环」和「解析成什么」，供 chrome 的按钮文案与诊断使用。
 */
import { t, type MsgId } from './msg.ts'

export type ThemeMode = 'system' | 'light' | 'dark'

/** 三档循环：跟随系统 → 亮 → 暗 → 跟随系统 */
const ORDER: ThemeMode[] = ['system', 'light', 'dark']

export const THEME_MODE_LABEL: Record<ThemeMode, MsgId> = {
  system: 'ui.theme.mode.system',
  light: 'ui.theme.mode.light',
  dark: 'ui.theme.mode.dark',
}

export function nextTheme(cur: ThemeMode): ThemeMode {
  return ORDER[(ORDER.indexOf(cur) + 1) % ORDER.length]!
}

/** 解析后的亮暗（**只用于诊断与文案**；配色仍由 CSS 决定） */
export function resolveTheme(mode: ThemeMode, prefersDark: boolean): 'light' | 'dark' {
  return mode === 'system' ? (prefersDark ? 'dark' : 'light') : mode
}

/** 系统外观查询（一次创建，多处订阅） */
export const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')

/** 主题按钮的 tooltip 文案 */
export function themeButtonTitle(mode: ThemeMode): string {
  return t('ui.theme.title', { toggle: t('ui.theme.toggle'), mode: t(THEME_MODE_LABEL[mode]) })
}
