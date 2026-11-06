/**
 * 档位轴的装配：把「现在哪一档」画到 body 上（CSS 按它放开阅读宽度／藏抬头与 tab 条），
 * 并持有「用户在档位期间手动动过哪侧槽」的释放表。
 *
 * 为什么住装配层：档位是**窗口任务态**——不进 prefs（不落盘、不跨会话）、不进 tab，
 * 只有这里同时够得着设备偏好、chrome 重画与 DOM。纯判据（走得动吗／槽看得见吗）在 core，
 * 重画与「确保槽开着」的入口共用那一份。
 */
import { axisStep, axisSlotOpen, isAxisMode, type AxisMode } from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import { renderIcon } from '../../view/icons.ts'
import type { Prefs } from '../../core/infra/workspace.ts'

export interface AxisDeps {
  prefs: () => Prefs
  applyChrome: () => void
  scheduleBadge: () => void
}

export function setupAxis(deps: AxisDeps) {
  let mode: AxisMode = 'normal'
  /** 档位期间用户手动动过的槽（以他为准的那几侧）；退回常规即整体作废 */
  const released = { left: false, right: false }

  /** 这一侧槽**此刻**看得见吗（chrome 重画与开槽入口的唯一问法） */
  const slotOpen = (side: 'left' | 'right'): boolean => axisSlotOpen(deps.prefs().dock, mode, released, side)

  /**
   * 退出口：宽屏收起了双槽、全屏再藏抬头与 tab 条——Esc 之外的鼠标回路只有这一颗。
   * 点它＝沿轴退一档（宽屏→常规；全屏→宽屏）。
   */
  const exitEl = document.createElement('button')
  exitEl.type = 'button'
  exitEl.className = 'axis-exit'
  exitEl.hidden = true
  renderIcon(exitEl, 'lucide:minimize-2', 'minimize-2')
  exitEl.addEventListener('click', () => {
    step(-1)
  })
  document.body.appendChild(exitEl)

  function apply(): void {
    if (mode === 'normal') delete document.body.dataset.axis
    else document.body.dataset.axis = mode
    exitEl.hidden = mode === 'normal'
    if (mode !== 'normal') {
      const label = t(mode === 'full' ? 'ui.axis.exitFull' : 'ui.axis.exitWide')
      exitEl.title = label
      exitEl.setAttribute('aria-label', label)
    }
    deps.applyChrome()
  }

  function setMode(next: AxisMode): void {
    if (next === mode) return
    if (!isAxisMode(next)) return
    mode = next
    if (mode === 'normal') {
      released.left = false
      released.right = false
    }
    apply()
    deps.scheduleBadge()
  }

  /** 沿轴进/退一档；已在端点 ⇒ false（这次按键没有效果，不报错也不 toast） */
  function step(dir: 1 | -1): boolean {
    const next = axisStep(mode, dir)
    if (!next) return false
    setMode(next)
    return true
  }

  /** 直接落到某一档（「全屏打开」这类一步到位的入口用它，不必逐档走） */
  function to(next: AxisMode): boolean {
    if (!isAxisMode(next) || next === mode) return false
    setMode(next)
    return true
  }

  /**
   * 用户在档位期间手动动了某一侧槽 ⇒ 以他为准：这一侧脱离强制收起。
   * 调用方先把他的意图写进 prefs（开关/开槽入口各自的职责），这里只记
   * 「这一侧他动过」——可见值就是 prefs 里那一份，不另存第二种答案。
   */
  function noteSlotChanged(side: 'left' | 'right'): void {
    if (mode === 'normal') return
    released[side] = deps.prefs().dock[side].open
  }

  return {
    mode: () => mode,
    slotOpen,
    step,
    to,
    noteSlotChanged,
  }
}
