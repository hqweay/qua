/**
 * 挂载区 handler：加一栏 / 摘一栏。
 *
 * 命令面只做两件事：把 `label` 与 `spec` 收成形、把「写哪一格」交给门面
 * （日记写共享配置块这一条属于模型知识，不属于命令面）。
 */
import type { Handler } from '../../core/ports.ts'
import type { QuerySpec } from '../../core/query.ts'
import { S } from './shared.ts'

export const MOUNT_HANDLERS: Record<string, Handler> = {
  'core.mount/add': (a, app) => {
    const hostId = S(a.hostId)
    const label = S(a.label).trim()
    const spec = a.spec as QuerySpec | undefined
    if (!hostId || !label || !spec || typeof spec !== 'object' || !spec.where) return false
    return app.addMountTab(hostId, label, spec)
  },
  'core.mount/remove': (a, app) => {
    const hostId = S(a.hostId)
    const index = typeof a.index === 'number' ? a.index : Number(a.index)
    if (!hostId || !Number.isInteger(index)) return false
    return app.removeMountTab(hostId, index)
  },
}
