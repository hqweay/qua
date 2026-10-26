/**
 * **挂载区**的用户栏：加一栏／摘一栏。
 *
 * 两件事都只是写宿主上的**一格** `_mounts`——不建块、不删块（摘一栏不会带走任何块，
 * 因为压根没有块）。这也是「tab 不是块」这条口径唯一需要写路径配合的地方。
 *
 * 写在哪一格随宿主而定，判据只有一条：
 *   · 普通块 ⇒ 它自己；
 *   · 日记 ⇒ **共享配置块**（`journalMountsId`）。没有就当场物化一个——
 *     这是那个内部块唯一的诞生入口（它不占地址、不进任何列表，所以没有第二个入口）。
 *
 * ⚠️ 过去的日记天**拒绝**：那一栏没有落点（「只挂今日」）。判据与读路径共用
 *    `canEditMounts`，否则会出现「能加、但永远看不到」。
 * ⚠️ 名字必须两两不同：同一个块下两栏同名，点哪一栏都一样——那是写坏了，
 *    而落盘校验会把整库判 corrupt。所以冲突在这里就拒（给一句提示，不静默改名）。
 */
import {
  canonicalSpec,
  canEditMounts,
  isJournal,
  journalMountsBlock,
  mkJournalMountsBlock,
  MOUNTS_PROP,
  readMounts,
  type Block,
  type MountTabWrite,
} from '../../core/index.ts'
import { t } from '../../core/msg.ts'
import type { App } from '../../core/ports.ts'
import type { MountsDeps } from './types.ts'

/** 读出来的一格 → 落盘形状（`kind` 是派生的，不存） */
const storedOf = (b: Block | undefined): MountTabWrite[] =>
  readMounts(b).map((m) => ({ label: m.label ?? '', spec: m.spec }))

/** 写一格 `_mounts`（原地改；属性袋不留空壳） */
function setMounts(b: Block, next: readonly MountTabWrite[]): void {
  const props = { ...(b.props ?? {}) }
  if (next.length === 0) delete props[MOUNTS_PROP]
  else props[MOUNTS_PROP] = next
  if (Object.keys(props).length === 0) delete b.props
  else b.props = props
}

export function mountCommands(d: MountsDeps): Pick<App, 'addMountTab' | 'removeMountTab'> {
  /** 这一块的用户栏住在哪一格（日记没有配置块时返回 `undefined`） */
  const targetOf = (host: Block): Block | undefined => (isJournal(host) ? journalMountsBlock(d.kb.roots()) : host)

  return {
    addMountTab: (hostId, label, spec) => {
      const host = d.kb.get(hostId)
      const name = label.trim()
      if (!host || name === '') return false
      if (!canEditMounts(host)) return false
      const target = targetOf(host)
      const current = storedOf(target)
      if (current.some((m) => m.label.trim() === name)) {
        d.toast(t('ui.mount.duplicate', { label: name }), 'info')
        return false
      }
      const next: MountTabWrite[] = [...current, { label: name, spec: canonicalSpec(spec) }]
      if (target) {
        d.write(target.id, () => setMounts(target, next))
        return true
      }
      // 共享配置块还不存在：物化它 ＋ 同一笔里挂上这一栏（两笔会留下一次「空配置」的撤销步）
      d.run((tx) => {
        const existing = journalMountsBlock(d.kb.roots())
        if (existing) {
          tx.setProp(existing.id, MOUNTS_PROP, next)
          return
        }
        const created = mkJournalMountsBlock()
        tx.insert(created, null, d.kb.roots().length)
        tx.setProp(created.id, MOUNTS_PROP, next)
      })
      return true
    },

    removeMountTab: (hostId, index) => {
      const host = d.kb.get(hostId)
      if (!host || !canEditMounts(host)) return false
      const target = targetOf(host)
      if (!target) return false
      const current = storedOf(target)
      if (index < 0 || index >= current.length) return false
      d.write(target.id, () => setMounts(target, current.filter((_, i) => i !== index)))
      return true
    },
  }
}
