/**
 * 挂载区 handler：加/摘/改名/换视图/提升/转本地/固定派生。
 *
 * 命令面只做参数归一 —— 「这一栏写哪一格」由 `MountHost` 判（块宿主写库、
 * 日记宿主写设备状态），那是模型层的事，不属于命令面。
 */
import type { Handler } from '../../core/ports.ts'
import type { QuerySpec } from '../../core/query.ts'
import { hostArg, S } from './shared.ts'

/** 派生栏的三个来源（`derived` 栏没有配置，固定成 local 时才用到） */
const SOURCES = ['refs', 'same', 'mentions'] as const

export const MOUNT_HANDLERS: Record<string, Handler> = {
  'core.mount/add-local': (a, app) => {
    const host = hostArg(a.host)
    const label = S(a.label).trim()
    const spec = a.spec as QuerySpec | undefined
    if (!host || !label || !spec || typeof spec !== 'object' || !spec.where) return false
    const view = S(a.view)
    return app.addLocalTab(host, label, spec, [], view) !== ''
  },
  'core.mount/add-linked': (a, app) => {
    const host = hostArg(a.host)
    const blockId = S(a.block)
    if (!host || !blockId) return false
    const label = S(a.label).trim()
    return app.addLinkedTab(host, blockId, S(a.view), label === '' ? undefined : label) !== ''
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
  'core.mount/set-view': (a, app) => {
    const host = hostArg(a.host)
    const tabId = S(a.tabId)
    if (!host || !tabId) return false
    return app.setMountTabView(host, tabId, S(a.view))
  },
  'core.mount/promote': (a, app) => {
    const host = hostArg(a.host)
    const tabId = S(a.tabId)
    const target = S(a.target, 'page')
    if (!host || !tabId || (target !== 'page' && target !== 'block')) return false
    const link = a.link === undefined ? true : a.link !== false
    return app.promoteMountTab(host, tabId, target, S(a.parentId) || undefined, link) !== ''
  },
  'core.mount/detach': (a, app) => {
    const host = hostArg(a.host)
    const tabId = S(a.tabId)
    if (!host || !tabId) return false
    return app.detachMountTab(host, tabId)
  },
  'core.mount/fix-derived': (a, app) => {
    const host = hostArg(a.host)
    const source = S(a.source)
    if (!host || !(SOURCES as readonly string[]).includes(source)) return false
    const view = S(a.view)
    return app.fixDerivedTab(host, source as (typeof SOURCES)[number], view === 'list' || view === 'table' ? view : 'outline') !== ''
  },
}
