/**
 * 档位轴：常规 → 宽屏 →（回到常规），**一根轴两档、进档循环**。
 *
 * 它是**叠在设备偏好上的一层**（与「聚焦即展开」「单卡展开」同一条 overlay 判据）：
 * 进入不写 prefs；退出清释放表、可见性交回 prefs——档内手动改过的那一侧保留他的选择，
 * 没碰过的恢复原样，所以不需要快照。档位只住窗口（任务态，不是偏好），不跨会话恢复。
 *
 * 宽屏＝双槽默认收起＋正文容器吃满可用宽度；槽的可见性仍可被用户手动操作覆盖。
 * 纯判据住 core：装配层的重画与「确保槽开着」的入口共用这一份，不各答一遍。
 */

export type AxisMode = 'normal' | 'wide'

export const AXIS_MODES: readonly AxisMode[] = ['normal', 'wide']

export function isAxisMode(v: unknown): v is AxisMode {
  return typeof v === 'string' && (AXIS_MODES as readonly string[]).includes(v)
}

/** 是否在宽屏（Esc 绑定的上下文键用它） */
export function isAxisActive(mode: AxisMode): boolean {
  return mode !== 'normal'
}

/**
 * 沿轴走一步：**进一档（dir=1）两档循环**（宽屏再进 ⇒ 常规）；**退一档（dir=-1）到底不动**。
 * 返回 null ＝ 这次没有效果。
 *
 * 为什么不对称：「进一档」是命令面板里显式的「换下一档」——到宽屏就没反应等于死键，
 * 循环让这一条命令覆盖两档；退档是 Esc 语义栈的最后一层，常规档没有更低的档可退，
 * 返回 null 才轮得到「关浮层／清块选区」（`bindings.ts` 的 `axisActive` 守卫同理）。
 * 若退档也循环，常规档按一下 Esc 会把人反手扔进宽屏。
 */
export function axisStep(mode: AxisMode, dir: 1 | -1): AxisMode | null {
  const at = AXIS_MODES.indexOf(mode)
  if (dir === 1) return AXIS_MODES[(at + 1) % AXIS_MODES.length]!
  const next = at - 1
  return next >= 0 ? AXIS_MODES[next]! : null
}

/**
 * 档位期间这一侧槽**此刻看得见吗** —— 唯一判据（chrome 重画、开关槽、开槽入口都问它）。
 *
 * 宽屏把两槽默认收起；用户在档位期间手动动过的那一侧**以他为准**
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
