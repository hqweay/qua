/**
 * **`ViewOwnerStore` 的实现**：视图配置唯一的读写入口。
 *
 * 三处落点，一个判据（`MountHost`）：
 *
 * | 拥有者 | 读 | 写 |
 * |---|---|---|
 * | block | `props._query`／`_views`／`_activeView` | 一笔事务（`tx.patch`） |
 * | tab（块宿主） | `props._mounts` 里那条 local | 一笔事务 |
 * | tab（日记宿主） | `Prefs.journalMounts` 里那条 local | 一次设备保存 |
 *
 * 为什么这一层必须在装配层而不是 `core`：
 *   · 写要进**事务**（否则不产 op ⇒ 落盘时这一笔被静默跳过）；
 *   · 日记那一半是**设备状态**，它在 `core` 里根本没有写入口。
 *
 * ⚠️ 除本文件外，`props._views`／`_activeView`／`_mounts` 的直接读写由 `arch-check` 拦住
 *    （白名单只有 `core/view-owner.ts` 与 `core/mount.ts` 的读路径）。
 */
import {
  canonicalMountEntries,
  MOUNTS_PROP,
  readMounts,
  type MountEntry,
  type MountHost,
} from '../../core/mount.ts'
import {
  applyOwnerPatch,
  bindingOfEmbed,
  bindingOfLinked,
  ownerDataOfBlock,
  ownerDataOfTab,
  withBlockOwnerData,
  withLinkedView,
  withTabOwnerData,
  type BindingTarget,
  type ViewBindingRef,
  type ViewOwnerData,
  type ViewOwnerRef,
  type ViewOwnerStore,
} from '../../core/view-owner.ts'
import { EMBED_PROP, canonicalViewRef } from '../../core/embed.ts'
import type { Block } from '../../core/model.ts'
import type { Prefs } from '../../core/storage/prefs.ts'
import type { MemoryKb } from '../../core/kb/memory.ts'
import type { Tx } from '../../core/kb/types.ts'

export type OwnersDeps = {
  kb: MemoryKb
  /** 事务入口（一次动作一笔；`source` 让发起的视图跳过自己的重画） */
  run: <R>(fn: (tx: Tx) => R, source?: unknown) => R
  /** 设备状态（**活引用**：写完调 `scheduleDeviceSave`） */
  prefs: () => Prefs
  scheduleDeviceSave: () => void
  /** 库落盘（事务提交后由装配层调；这里只在写设备状态时自己补一次） */
  scheduleSave: () => void
  /** 屏幕跟上（重画段、角标） */
  onChange: () => void
}

/**
 * 命令层拿到的那一半：除了读写视图配置，还要能**整组写回那几栏**
 * （加/摘/提升/转本地都要动这一组，而不是只动一格配置）。
 */
export type OwnerStore = ViewOwnerStore & {
  /** 这一宿主持有的那几栏（**存下来的**；内置栏由 `core/mount.ts` 现算） */
  entriesOf: (host: MountHost) => MountEntry[]
  /** 整组写回（加/摘/改序用） */
  writeEntries: (host: MountHost, next: readonly MountEntry[]) => void
  /** 按稳定 id 找一栏 */
  entryOf: (host: MountHost, tabId: string) => MountEntry | undefined
}

export function setupOwners(deps: OwnersDeps): OwnerStore {
  /** 块宿主：它自己；日记宿主：设备状态。判据只有 `MountHost` 一个 */
  const entriesOf = (host: MountHost): MountEntry[] =>
    host.kind === 'journal' ? canonicalMountEntries(deps.prefs().journalMounts) : readMounts(deps.kb.get(host.blockId))

  const entryOf = (host: MountHost, tabId: string): MountEntry | undefined =>
    entriesOf(host).find((e) => e.id === tabId)

  /**
   * 整组写回。
   *
   * ⚠️ 空集合一律**删掉那一格**：留一个空数组会让「这一块有没有配过面板」有两份答案。
   */
  const writeEntries = (host: MountHost, next: readonly MountEntry[]): void => {
    if (host.kind === 'journal') {
      deps.prefs().journalMounts = canonicalMountEntries(next)
      deps.scheduleDeviceSave()
      deps.onChange()
      return
    }
    deps.run((tx) => {
      tx.patch(host.blockId, (b) => {
        const props = { ...(b.props ?? {}) }
        if (next.length === 0) delete props[MOUNTS_PROP]
        else props[MOUNTS_PROP] = canonicalMountEntries(next)
        b.props = Object.keys(props).length === 0 ? undefined : props
      })
    })
    deps.onChange()
  }

  /** 一处写：把第 i 条换成新的（找不到就什么都不做 —— 那不是静默失败，是「这一栏已经不在了」） */
  const replaceEntry = (host: MountHost, tabId: string, next: MountEntry): boolean => {
    const list = entriesOf(host)
    const at = list.findIndex((e) => e.id === tabId)
    if (at < 0) return false
    const out = [...list]
    out[at] = next
    writeEntries(host, out)
    return true
  }

  const read = (owner: ViewOwnerRef): ViewOwnerData | null => {
    if (owner.kind === 'block') {
      const b = deps.kb.get(owner.blockId)
      return b ? ownerDataOfBlock(b) : null
    }
    return ownerDataOfTab(entryOf(owner.host, owner.tabId))
  }

  const write = (owner: ViewOwnerRef, patch: Partial<ViewOwnerData>): void => {
    if (owner.kind === 'block') {
      const b = deps.kb.get(owner.blockId)
      if (!b) return
      const next = applyOwnerPatch(ownerDataOfBlock(b), patch)
      deps.run((tx) => {
        tx.patch(owner.blockId, (x) => {
          x.props = withBlockOwnerData(x.props, next)
        })
      })
      deps.onChange()
      return
    }
    const entry = entryOf(owner.host, owner.tabId)
    if (!entry || entry.kind !== 'local') return
    const next = applyOwnerPatch(ownerDataOfTab(entry)!, patch)
    replaceEntry(owner.host, owner.tabId, withTabOwnerData(entry, next))
  }

  const readBinding = (binding: ViewBindingRef): BindingTarget | null => {
    if (binding.kind === 'linked-tab') return bindingOfLinked(entryOf(binding.host, binding.tabId))
    if (binding.kind === 'embed') return bindingOfEmbed(deps.kb.get(binding.blockId))
    // dock 卡的「选哪张视图」本轮还没有落点（语义已对，形状后置）⇒ 诚实地没有绑定
    return null
  }

  const setBindingView = (binding: ViewBindingRef, view: string): void => {
    if (binding.kind === 'linked-tab') {
      const entry = entryOf(binding.host, binding.tabId)
      if (!entry || entry.kind !== 'linked') return
      replaceEntry(binding.host, binding.tabId, withLinkedView(entry, view))
      return
    }
    if (binding.kind === 'embed') {
      const b: Block | undefined = deps.kb.get(binding.blockId)
      const ref = canonicalViewRef(b?.props?.[EMBED_PROP])
      if (!b || !ref) return
      deps.run((tx) => {
        tx.patch(binding.blockId, (x) => {
          x.props = { ...(x.props ?? {}), [EMBED_PROP]: { block: ref.block, view } }
        })
      })
      deps.onChange()
    }
  }

  return { read, write, readBinding, setBindingView, entriesOf, writeEntries, entryOf }
}
