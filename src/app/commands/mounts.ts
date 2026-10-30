/**
 * **挂载区**命令：加一栏／摘一栏／改名／换视图／提升／转本地／固定派生。
 *
 * 三条纪律：
 *   · **local tab 不建块**：加一栏＝给宿主持有的那组 `MountEntry` 追加一条；
 *     删一栏＝摘掉一条。块数一个都不变，`⌘Z` 可撤。
 *   · **写哪一格由 `MountHost` 判**（块宿主写 `props._mounts`、日记宿主写设备状态），
 *     命令层不自己判「是不是日记」—— 两处各判一次，「这一栏写哪」就有两个答案。
 *   · **linked tab 只有一根指针**：改它选的视图写指针；改条件/列写**目标块**
 *     （一份条件、一份视图配置）。
 *
 * `promote`／`detach` 是**显式复制**：复制之后是两个独立对象，没有隐藏同步。
 */
import {
  ALIASES_PROP,
  canonicalSpec,
  canonicalViews,
  derivedSpecOf,
  displayNameOf,
  journalDate,
  LISTS_PROP,
  mkQueryBlock,
  mkTabId,
  todayISO,
  type MountEntry,
  type MountHost,
} from '../../core/index.ts'
import { t } from '../../core/msg.ts'
import type { App } from '../../core/ports.ts'
import type { MountsDeps } from './types.ts'

export function mountCommands(
  d: MountsDeps,
): Pick<
  App,
  | 'addLocalTab'
  | 'addLinkedTab'
  | 'removeMountTab'
  | 'renameMountTab'
  | 'setMountTabView'
  | 'promoteMountTab'
  | 'detachMountTab'
  | 'fixDerivedTab'
> {
  const entriesOf = (host: MountHost): MountEntry[] => d.owners.entriesOf(host)
  const entryOf = (host: MountHost, tabId: string): MountEntry | undefined =>
    entriesOf(host).find((e) => e.id === tabId)
  const write = (host: MountHost, next: readonly MountEntry[]): void => d.owners.writeEntries(host, next)

  /** 这一栏能配吗（过去的日记天不给：那一栏没有落点） */
  const editable = (host: MountHost, now = new Date()): boolean => {
    if (host.kind !== 'journal') return true
    const day = d.kb.journalDay(todayISO(now))
    return day !== undefined && journalDate(day) === todayISO(now)
  }

  /** 供本文件内部复用（「固定派生栏」就是「加一栏 local」） */
  const api: Pick<App, 'addLocalTab' | 'addLinkedTab' | 'removeMountTab' | 'renameMountTab' | 'setMountTabView' | 'promoteMountTab' | 'detachMountTab' | 'fixDerivedTab'> = {
    /**
     * 加一栏 **local**：这一栏自己拥有条件与视图。**不建块。**
     *
     * 默认给一张**表格**视图并设为激活 —— 那是「新建一栏」时的选择，
     * 不是「所有查询缺省都是表格」（块查询的缺省仍是大纲）。
     */
    addLocalTab: (host, label, spec, views, activeView) => {
      if (!editable(host)) return ''
      const name = label.trim()
      if (name === '' || !spec || typeof spec !== 'object' || !spec.where) return ''
      const canon = canonicalSpec(spec)
      const entry: MountEntry = {
        id: mkTabId(),
        kind: 'local',
        label: name,
        spec: canon,
        views: canonicalViews(views ?? [], { kind: 'query', spec: canon }),
      }
      if (activeView !== undefined && activeView !== '') entry.activeView = activeView
      write(host, [...entriesOf(host), entry])
      return entry.id
    },

    /** 加一栏 **linked**：只存「指向哪一块 ＋ 哪张视图」 */
    addLinkedTab: (host, blockId, view, label) => {
      if (!editable(host)) return ''
      const target = d.kb.get(blockId)
      if (!target) return ''
      const entry: MountEntry = { id: mkTabId(), kind: 'linked', block: blockId, view: view ?? '' }
      const name = label?.trim()
      if (name !== undefined && name !== '') entry.label = name
      write(host, [...entriesOf(host), entry])
      return entry.id
    },

    /** 摘一栏：**不删任何块**（local 压根没有块；linked 只摘指针，目标块不动） */
    removeMountTab: (host, tabId) => {
      const list = entriesOf(host)
      const next = list.filter((e) => e.id !== tabId)
      if (next.length === list.length) return false
      write(host, next)
      return true
    },

    /** 改名（只 local 有名字；linked 的名字是覆盖文案） */
    renameMountTab: (host, tabId, label) => {
      const entry = entryOf(host, tabId)
      if (!entry) return false
      const name = label.trim()
      if (entry.kind === 'local') {
        if (name === '') return false
        write(host, entriesOf(host).map((e) => (e.id === tabId ? { ...e, label: name } : e)))
        return true
      }
      if (entry.kind !== 'linked') return false
      const next: MountEntry = { ...entry }
      if (name === '') delete next.label
      else next.label = name
      write(host, entriesOf(host).map((e) => (e.id === tabId ? next : e)))
      return true
    },

    /**
     * 换这一栏选的视图。
     *
     * · `local` ⇒ 改它自己的 `_activeView`（配置在它身上）；
     * · `linked` ⇒ 改**指针**（`owners.setBindingView`），目标块的视图列表一个字节不动。
     */
    setMountTabView: (host, tabId, view) => {
      const entry = entryOf(host, tabId)
      if (!entry) return false
      if (entry.kind === 'local') {
        const next: MountEntry = { ...entry }
        if (view === '') delete next.activeView
        else next.activeView = view
        write(host, entriesOf(host).map((e) => (e.id === tabId ? next : e)))
        return true
      }
      if (entry.kind !== 'linked') return false
      d.owners.setBindingView({ kind: 'linked-tab', host, tabId }, view)
      return true
    },

    /**
     * **提升**（local → 块）：复制 `spec + views + activeView` 到一个新块，
     * 默认把这一栏改成指向它的 linked。
     *
     * 为什么是复制而不是「把配置搬走」：搬走之后 local tab 就空了，
     * 而用户要的是「这一栏现在有个可引用、可共享的身份」—— 两个对象各自独立，
     * 之后改谁都不动另一个。
     *
     * ⚠️ 条件是**相对**的（`scope:'subtree'` 的锚点由表面给）：提升为**查询页**
     *    会失去宿主上下文，UI 要先提示一句（见 `ui.mount.selfRel`）。
     */
    promoteMountTab: (host, tabId, target, parentId, link) => {
      const entry = entryOf(host, tabId)
      if (!entry || entry.kind !== 'local') return ''
      const name = entry.label.trim() === '' ? t('ui.query.untitled') : entry.label.trim()
      const block = mkQueryBlock({
        name,
        spec: entry.spec,
        views: entry.views,
        ...(entry.activeView ? { activeView: entry.activeView } : {}),
        icon: 'lucide:list-filter',
      })
      if (target === 'page') {
        /**
         * **查询页**：进页列表（有地址与 `page` 露面），顶层 ⇒ 它的上下文是全库。
         */
        block.props = {
          ...(block.props ?? {}),
          [ALIASES_PROP]: [name],
          [LISTS_PROP]: ['page'],
        }
      }
      d.run((tx) => {
        if (target === 'page') tx.insert(block, null, d.kb.roots().length)
        else tx.insert(block, parentId ?? d.activeId(), Number.MAX_SAFE_INTEGER)
      })
      if (link !== false) {
        const linked: MountEntry = { id: entry.id, kind: 'linked', block: block.id, view: entry.activeView ?? '' }
        write(host, entriesOf(host).map((e) => (e.id === tabId ? linked : e)))
      }
      d.toast(t('ui.mount.promoted'), 'ok')
      return block.id
    },

    /**
     * **转本地副本**（linked → local）：把目标的**条件 ＋ 整个视图集**复制进这一栏。
     *
     * ⚠️ 只有目标源是 **query** 时才成立：local tab 是「面板局部的一次查询」，
     *    而 children／items 的视图挂在某个块上，没有「面板局部查询」这个对应物 ——
     *    那种栏只能保持 linked 或移除。
     */
    detachMountTab: (host, tabId) => {
      const entry = entryOf(host, tabId)
      if (!entry || entry.kind !== 'linked') return false
      const binding = d.owners.readBinding({ kind: 'linked-tab', host, tabId })
      if (!binding) return false
      const data = d.owners.read(binding.owner)
      if (!data?.query) {
        d.toast(t('ui.mount.nonQuery'), 'warn')
        return false
      }
      const target = d.kb.get(entry.block)
      const local: MountEntry = {
        id: entry.id,
        kind: 'local',
        label: entry.label ?? (target ? displayNameOf(target).trim() || t('ui.query.untitled') : t('ui.query.untitled')),
        spec: data.query,
        views: canonicalViews(data.views, { kind: 'query', spec: data.query }),
      }
      if (data.activeView) local.activeView = data.activeView
      write(host, entriesOf(host).map((e) => (e.id === tabId ? local : e)))
      d.toast(t('ui.mount.detached'), 'ok')
      return true
    },

    /**
     * **固定派生栏**（derived → local）：把「引用／同类／提及」那一栏的现算条件
     * 变成一栏可编辑的 local tab（内置栏保留）。
     */
    fixDerivedTab: (host, source) => {
      if (!editable(host)) return ''
      const hostBlock = host.kind === 'journal' ? d.kb.journalDay(todayISO()) : d.kb.get(host.blockId)
      if (!hostBlock) return ''
      const spec = derivedSpecOf(hostBlock, d.kb.roots(), source)
      if (!spec) return ''
      const label = source === 'refs' ? t('ui.mount.refs') : source === 'same' ? t('ui.mount.same') : t('ui.mount.mentions')
      return api.addLocalTab(host, label, spec, [], '')
    },
  }
  return api
}
