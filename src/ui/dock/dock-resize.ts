/**
 * 侧槽宽度手柄的拖拽接线。
 *
 * 只做一件事：把鼠标位移翻译成「这一槽的宽度」，并交给装配层落盘。
 * 范围钳制由装配层给（`min` / `max` 都是读 token 与视口算出来的），
 * 这里不写任何像素常量 —— 宽度是布局知识，不是手柄的知识。
 *
 * 交互口径：
 *   · 拖动实时生效（`onResize` 每次移动都调）；
 *   · **双击**恢复默认（`width = null`，交回 CSS token）；
 *   · 拖动期间给 `body` 打 `data-dock-resizing`，由 CSS 关掉文本选中与给 cursor；
 *   · 没发生位移的按下（普通单击）不写宽度，避免「点一下也落盘」。
 */
export interface DockResizeDeps {
  side: 'left' | 'right'
  handle: HTMLElement
  /** 起拖时的实际宽度（`width === null` 时取当前渲染宽度，不能让槽跳一下） */
  width: () => number
  min: () => number
  max: () => number
  /** 拖动中：只改宽度（实时） */
  onResize: (width: number) => void
  /** 双击：恢复默认宽度 */
  onReset: () => void
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), Math.max(lo, hi))

export function bindDockResize(deps: DockResizeDeps): void {
  const { handle, side } = deps

  handle.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()

    const startX = e.clientX
    const startW = deps.width()
    let moved = false

    const onMove = (ev: MouseEvent): void => {
      const delta = side === 'left' ? ev.clientX - startX : startX - ev.clientX
      if (Math.abs(delta) >= 1) moved = true
      if (!moved) return
      deps.onResize(clamp(Math.round(startW + delta), deps.min(), deps.max()))
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      delete document.body.dataset.dockResizing
    }

    document.body.dataset.dockResizing = '1'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  })

  handle.addEventListener('dblclick', (e: MouseEvent) => {
    e.preventDefault()
    deps.onReset()
  })
}
