/**
 * 挂载区 handler：加/摘/改名/换视图/固定派生。
 *
 * 命令面只做参数归一 —— 「这一栏写哪一格」由 `MountHost` 判（块宿主写库、
 * 日记宿主写设备状态），那是模型层的事，不属于命令面。
 */
import type { Handler } from '../../core/infra/ports.ts'
import type { QuerySpec } from '../../core/query/query.ts'
import { hostArg, S } from './shared.ts'

/** 派生栏的三个来源（`derived` 栏没有配置，固定成 local 时才用到） */

export const MOUNT_HANDLERS: Record<string, Handler> = {
  'core.mount/add-local': (a, app) => {
    const host = hostArg(a.host)
    const label = S(a.label).trim()
    const spec = a.spec as QuerySpec | undefined
    if (!host || !label || !spec || typeof spec !== 'object' || !spec.where) return false
    const view = S(a.view)
    return app.addLocalTab(host, label, spec, [], view) !== ''
  },
  'core.mount/remove': (a, app) => {
    const host = hostArg(a.host)
    const tabId = S(a.tabId)
    if (!host || !tabId) return false
    return app.removeMountTab(host, tabId)
  },
  'core.mount/rename': (a, app) => {
    const host = hostArg(a.host)
    const tabId = S(a.tabId)
    if (!host || !tabId) return false
    return app.renameMountTab(host, tabId, S(a.label))
  },
  /** 挪一栏：`place` 只认 before／after，别的一律当 before（参数面不做枚举校验） */
  'core.mount/move': (a, app) => {
    const host = hostArg(a.host)
    const tabId = S(a.tabId)
    const targetId = S(a.targetId)
    if (!host || !tabId || !targetId) return false
    return app.moveMountTab(host, tabId, targetId, a.place === 'after' ? 'after' : 'before')
  },
  'core.mount/set-view': (a, app) => {
    const host = hostArg(a.host)
    const tabId = S(a.tabId)
    if (!host || !tabId) return false
    return app.setMountTabView(host, tabId, S(a.view))
  },
}
