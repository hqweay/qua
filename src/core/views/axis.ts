/**
 * 档位轴：常规 → 宽屏 → 全屏，**一根轴三档**。
 *
 * 它是**叠在设备偏好上的一层**（与「聚焦即展开」「单卡展开」同一条 overlay 判据）：
 * 进入不写 prefs，退出自动回到进入前的样子——不需要记快照，两个状态轴也长不出复合态。
 * 档位本身只住窗口（任务态，不是偏好），不跨会话恢复。
 *
 * 宽屏＝双槽收起＋阅读/视图宽度上限放开；全屏＝再藏抬头与 tab 条。
 * 纯判据住 core：装配层的重画与「确保槽开着」的入口共用这一份，不各答一遍。
 */

export type AxisMode = 'normal' | 'wide' | 'full'

export const AXIS_MODES: readonly AxisMode[] = ['normal', 'wide', 'full']

export function isAxisMode(v: unknown): v is AxisMode {
  return typeof v === 'string' && (AXIS_MODES as readonly string[]).includes(v)
}

/** 是否在宽屏或全屏（Esc 绑定的上下文键用它） */
export function isAxisActive(mode: AxisMode): boolean {
  return mode !== 'normal'
}

/** 沿轴走一步；已在端点则原地不动（返回 null ＝ 这次没有效果） */
export function axisStep(mode: AxisMode, dir: 1 | -1): AxisMode | null {
  const at = AXIS_MODES.indexOf(mode)
  const next = at + dir
  return next >= 0 && next < AXIS_MODES.length ? AXIS_MODES[next]! : null
}

/**
 * 档位期间这一侧槽**此刻看得见吗** —— 唯一判据（chrome 重画、开关槽、开槽入口都问它）。
 *
 * 宽屏/全屏把两槽强制收起；用户在档位期间手动动过的那一侧**以他为准**
 * （`released` 只记「他动过哪侧」，可见值读他写下的 prefs——他收起就收起，他打开就亮）。
 * 退回常规后释放表整体作废，可见性完全交回 prefs。
 */
export function axisSlotOpen(
  dock: { left: { open: boolean }; right: { open: boolean } },
  mode: AxisMode,
  released: { left: boolean; right: boolean },
  side: 'left' | 'right',
): boolean {
  const open = dock[side].open
  if (mode === 'normal') return open
  return open && released[side]
}
