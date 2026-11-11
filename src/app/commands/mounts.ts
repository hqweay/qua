/**
 * **挂载区**命令：加一栏／摘一栏／改名／换视图。
 *
 * 两条纪律：
 *   · **local tab 不建块、也不指向块**：加一栏＝给宿主持有的那组 `MountEntry` 追加一条；
 *     删一栏＝摘掉一条。块数一个都不变，`⌘Z` 可撤。
 *   · **写哪一格由 `MountHost` 判**（块宿主写 `props._mounts`、日记宿主写设备状态），
 *     命令层不自己判「是不是日记」—— 两处各判一次，「这一栏写哪」就有两个答案。
 */
import {
  canonicalSpec,
  canonicalViews,
  journalDate,
  mkTabId,
  mountEntriesOf,
  moveMountEntry,
  todayISO,
  type MountEntry,
  type MountHost,
  type Source,
} from '../../core/index.ts'
import type { App } from '../../core/infra/ports.ts'
import type { MountsDeps } from './types.ts'

export function mountCommands(
  d: MountsDeps,
): Pick<
  App,
  | 'addLocalTab'
  | 'removeMountTab'
  | 'renameMountTab'
  | 'moveMountTab'
  | 'setMountTabView'
> {
  const entriesOf = (host: MountHost): MountEntry[] => d.owners.entriesOf(host)
  const entryOf = (host: MountHost, tabId: string): MountEntry | undefined =>
    entriesOf(host).find((e) => e.id === tabId)
  const write = (host: MountHost, next: readonly MountEntry[]): void => d.owners.writeEntries(host, next)

  /**
   * 这一格**显示出来的**整条 tab 条（含内置栏）。与 UI 同一份合并规则：`mountEntriesOf`。
   *
   * 块宿主的 `_mounts` 从块上读；日记宿主把设备状态里那一组传进去（读路径不自己摸偏好）。
   */
  const fullEntriesOf = (host: MountHost): MountEntry[] => {
    if (host.kind === 'journal') {
      const day = d.kb.journalDay(todayISO())
      return day ? mountEntriesOf(day, { journalMounts: entriesOf(host) }) : []
    }
    const b = d.kb.get(host.blockId)
    return b ? mountEntriesOf(b) : []
  }

  /** 这一栏能配吗（过去的日记天不给：那一栏没有落点） */
  const editable = (host: MountHost, now = new Date()): boolean => {
    if (host.kind !== 'journal') return true
    const day = d.kb.journalDay(todayISO(now))
    return day !== undefined && journalDate(day) === todayISO(now)
  }

  /** 供本文件内部复用（「固定派生栏」就是「加一栏 local」） */
  const api: Pick<App, 'addLocalTab' | 'removeMountTab' | 'renameMountTab' | 'moveMountTab' | 'setMountTabView'> = {
    /**
     * 加一栏 **local**：这一栏自己拥有条件与视图。**不建块。**
     *
     * 没给视图时**不补命名视图** ⇒ 缺省落在大纲（源的默认看法）。条件与范围芯片
     * 住在查询抬头里、按基础条件与拥有者画，不依赖有没有命名视图；要看表格／卡片
     * 由用户显式加一张，那时列才第一次算出来。
     *
     * 「固定派生栏」是另一条路径：物化时已带着现算好的条件与本源的派生列，
     * 模板显式给一张表格（见 `core/views/mount.ts`）。
     */
    addLocalTab: (host, label, spec, views, activeView, id) => {
      if (!editable(host)) return ''
      const name = label.trim()
      if (name === '' || !spec || typeof spec !== 'object' || !spec.where) return ''
      const canon = canonicalSpec(spec)
      const source: Source = { kind: 'query', spec: canon }
      const list = canonicalViews(views ?? [], source)
      // 指定 id 只在**没被占用**时生效：撞了（重复物化／手工数据）回退随机 id，
      // 绝不产生两条同 id 的栏——id 是激活态与冻结缓存的键
      const existing = new Set(entriesOf(host).map((e) => e.id))
      const tabId = id !== undefined && id !== '' && !existing.has(id) ? id : mkTabId()
      const entry: MountEntry = { id: tabId, kind: 'local', label: name, spec: canon, views: list }
      const active = activeView !== undefined && activeView !== '' ? activeView : ''
      if (active !== '') entry.activeView = active
      write(host, [...entriesOf(host), entry])
      return entry.id
    },

    /**
     * 摘一栏：**不删任何块**（local 压根没有块）。
     *
     * 只认 local：派生栏在那一格里如果有位置标记，摘掉它就是「隐藏内置栏」——
     * 那是另一条能力，不在本轮偷偷实现。
     */
    removeMountTab: (host, tabId) => {
      if (!editable(host)) return false
      const entry = entryOf(host, tabId)
      if (!entry || entry.kind !== 'local') return false
      write(host, entriesOf(host).filter((e) => e.id !== tabId))
      return true
    },

    /** 改名（只 local 有名字；derived 的名字由来源字典给） */
    renameMountTab: (host, tabId, label) => {
      if (!editable(host)) return false
      const entry = entryOf(host, tabId)
      const name = label.trim()
      if (!entry || entry.kind !== 'local' || name === '') return false
      write(host, entriesOf(host).map((e) => (e.id === tabId ? { ...e, label: name } : e)))
      return true
    },

    /**
     * 挪一栏（拖拽排序）：顺序＝**那一格数组的位次**，所以这只是一次「换位」，不是新字段。
     *
     * 派生栏与用户栏可以互相越位：派生栏落进那一格的只是一条位置标记。只动 local、
     * 且这一格还没有标记时，仍只重排原来那几栏（不为了拖一栏 local 就把内置栏物化）；
     * 一旦涉及派生栏，整条列表写回（首次换序＝物化）。
     *
     * 没变化 ⇒ `false`（不产生可撤销的空动作）。
     */
    moveMountTab: (host, tabId, targetId, place) => {
      if (!editable(host)) return false
      const stored = entriesOf(host)
      const full = fullEntriesOf(host)
      const touched = (e: MountEntry): boolean => e.id === tabId || e.id === targetId
      const involvesDerived = full.some((e) => e.kind === 'derived' && touched(e))
      const hasMarkers = stored.some((e) => e.kind === 'derived')
      const next = moveMountEntry(hasMarkers || involvesDerived ? full : stored, tabId, targetId, place)
      if (!next) return false
      write(host, next)
      return true
    },

    /** 换这一栏选的视图（配置在 local tab 自己身上） */
    setMountTabView: (host, tabId, view) => {
      if (!editable(host)) return false
      const entry = entryOf(host, tabId)
      if (!entry || entry.kind !== 'local') return false
      const next: MountEntry = { ...entry }
      if (view === '') delete next.activeView
      else next.activeView = view
      write(host, entriesOf(host).map((e) => (e.id === tabId ? next : e)))
      return true
    },

  }
  return api
}
