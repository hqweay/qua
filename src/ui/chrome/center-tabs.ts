/**
 * 中心槽的 tab 条：一条横向可滚动的 tab strip ＋ 一颗「新建」。
 *
 * 它是**纯 UI**：tab 的状态（哪个活跃、叫什么、背后是哪份 Doc）全在装配层；
 * 这里只把一份只读列表画出来，把点击交给 handler。
 * 一个视图只开一张 tab（按视图键去重）由状态层保证，不在这里猜。
 */
import { t } from '../../core/infra/msg.ts'
import { renderIcon } from '../../view/icons.ts'

export interface CenterTabInfo {
  id: string
  title: string
  active: boolean
}

export interface CenterTabsHandlers {
  activate: (id: string) => void
  close: (id: string) => void
  create: () => void
}

export function renderCenterTabs(
  root: HTMLElement,
  tabs: readonly CenterTabInfo[],
  handlers: CenterTabsHandlers,
): void {
  root.replaceChildren()
  for (const tab of tabs) {
    const el = document.createElement('div')
    el.className = 'center-tab'
    el.dataset.tabId = tab.id
    el.dataset.active = tab.active ? '1' : '0'
    el.setAttribute('role', 'tab')
    el.setAttribute('aria-selected', String(tab.active))
    el.tabIndex = tab.active ? 0 : -1
    el.title = tab.title
    el.addEventListener('click', () => handlers.activate(tab.id))

    const label = document.createElement('span')
    label.className = 'center-tab-title ui-ellipsis'
    label.textContent = tab.title

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'center-tab-close'
    close.title = t('ui.tabs.close')
    close.setAttribute('aria-label', t('ui.tabs.close'))
    renderIcon(close, 'lucide:x', 'x')
    close.addEventListener('click', (e) => {
      e.stopPropagation()
      handlers.close(tab.id)
    })

    el.append(label, close)
    root.appendChild(el)
  }

  const add = document.createElement('button')
  add.type = 'button'
  add.className = 'center-tab-add'
  add.title = t('ui.tabs.new')
  add.setAttribute('aria-label', t('ui.tabs.new'))
  renderIcon(add, 'lucide:plus', 'plus')
  add.addEventListener('click', () => handlers.create())
  root.appendChild(add)
}
