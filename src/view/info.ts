import { renderIcon } from './icons.ts'

/**
 * 段头／行上的 ⓘ 共用原语：**解释不占正文**——图标在带里，话在 tip 里
 * （悬停／键盘聚焦出，tip 委托在 overlay；读屏走 `aria-label`）。
 *
 * 约束与后果不许走这里：tip 不接「阻止动作」的那类话——那类必须直接可见。
 */
export function sectionInfo(text: string): HTMLElement {
  const info = document.createElement('span')
  info.className = 'ui-info'
  info.dataset.tip = text
  info.setAttribute('aria-label', text)
  info.tabIndex = 0
  renderIcon(info, 'lucide:info', 'info', 'sm')
  return info
}
