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
  defaultColumnsForSource,
  journalDate,
  mkTabId,
  mkViewId,
  mountEntriesOf,
  moveMountEntry,
  todayISO,
  type MountEntry,
  type MountHost,
  type Source,
  type ViewConfig,
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
     * 一条视图都没给时默认配一张**表格**并设为激活 —— 那是「新建一栏」时的选择，
     * 不是「所有查询缺省都是表格」（块查询的缺省仍是大纲）。
     * 没有激活视图时这一栏只有大纲分支，条件与范围（这一块之下/全库）的
     * 芯片住在视图抬头里 —— 缺了这张表，「范围只到宿主这一块」在屏幕上无处可看。
     */
    addLocalTab: (host, label, spec, views, activeView, emptyView) => {
      if (!editable(host)) return ''
      const name = label.trim()
      if (name === '' || !spec || typeof spec !== 'object' || !spec.where) return ''
      const canon = canonicalSpec(spec)
      const source: Source = { kind: 'query', spec: canon }
      const list = canonicalViews(views ?? [], source)
      const entry: MountEntry = { id: mkTabId(), kind: 'local', label: name, spec: canon, views: list }
      let active = activeView !== undefined && activeView !== '' ? activeView : ''
      if (list.length === 0 && emptyView !== 'none') {
        // 列在第一次建表时算一次（与 `core.view/add` 同一条口径），之后不随结果漂移
        const view: ViewConfig = { id: mkViewId(), kind: 'table', table: { columns: defaultColumnsForSource(source, d.kb) } }
        entry.views = [view]
        active = view.id
      }
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
