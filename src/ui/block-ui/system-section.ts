/**
 * **系统信息段**（只读）：创建时间／修改时间两行。
 *
 * 为什么单独成段而不是混进属性行：它们**不是属性**（不在属性袋里，也没有定义块），
 * 属性区其他每行都带「编辑控件 ＋ 清除按钮」，把只读事实塞进那种行里，用户会去点、
 * 点了没反应。判据是「可见但只读」由**通道**提供 —— 这一段就没有输入控件。
 * 系统段由引擎记账（创建／修改时刻是块上的必填墙钟字段，写入归写路径不归界面），段只读不写、也不提供任何写入口。
 */
import type { Block } from '../../core/index.ts'
import { clockLabel } from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import { sectionHead } from './props-chrome.ts'

export function systemSection(target: Block): HTMLElement {
  const box = document.createElement('section')
  box.className = 'props-section prop-system'
  box.dataset.systemSection = '1'
  box.appendChild(sectionHead('lucide:clock', t('ui.props.systemTitle')))

  const value = document.createElement('div')
  value.className = 'prop-system-value'
  for (const [key, at] of [
    ['created', target.created],
    ['modified', target.modified],
  ] as const) {
    const line = document.createElement('span')
    line.className = 'prop-system-line'
    line.dataset.systemField = key
    line.textContent = `${t(key === 'created' ? 'ui.props.createdAt' : 'ui.props.modifiedAt')} ${clockLabel(at) || t('ui.props.timeUnknown')}`
    value.appendChild(line)
  }
  box.appendChild(value)
  return box
}
