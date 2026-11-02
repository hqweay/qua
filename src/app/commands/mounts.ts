/**
 * **挂载区**命令：加一栏／摘一栏／改名／换视图／固定派生。
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
  derivedColumns,
  derivedListFields,
  derivedSpecOf,
  journalDate,
  mkTabId,
  mkViewId,
  todayISO,
  type MountEntry,
  type MountHost,
  type QuerySpec,
  type Source,
  type ViewConfig,
} from '../../core/index.ts'
import { t } from '../../core/msg.ts'
import type { App } from '../../core/ports.ts'
import type { MountsDeps } from './types.ts'

export function mountCommands(
  d: MountsDeps,
): Pick<
  App,
  | 'addLocalTab'
  | 'removeMountTab'
  | 'renameMountTab'
  | 'setMountTabView'
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
  const api: Pick<App, 'addLocalTab' | 'removeMountTab' | 'renameMountTab' | 'setMountTabView' | 'fixDerivedTab'> = {
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

    /** 摘一栏：**不删任何块**（local 压根没有块） */
    removeMountTab: (host, tabId) => {
      const list = entriesOf(host)
      const next = list.filter((e) => e.id !== tabId)
      if (next.length === list.length) return false
      write(host, next)
      return true
    },

    /** 改名（只 local 有名字；derived 的名字由来源字典给） */
    renameMountTab: (host, tabId, label) => {
      const entry = entryOf(host, tabId)
      const name = label.trim()
      if (!entry || entry.kind !== 'local' || name === '') return false
      write(host, entriesOf(host).map((e) => (e.id === tabId ? { ...e, label: name } : e)))
      return true
    },

    /** 换这一栏选的视图（配置在 local tab 自己身上） */
    setMountTabView: (host, tabId, view) => {
      const entry = entryOf(host, tabId)
      if (!entry || entry.kind !== 'local') return false
      const next: MountEntry = { ...entry }
      if (view === '') delete next.activeView
      else next.activeView = view
      write(host, entriesOf(host).map((e) => (e.id === tabId ? next : e)))
      return true
    },

    /**
     * **固定派生栏**（derived → local）：把「引用／同类／提及」那一栏的现算条件
     * 变成一栏可编辑的 local tab（内置栏保留）。
     *
     * 三条口径：
     *   · 名字**不能和内置栏重名**（两个「引用」在 tab 条上分不出谁是谁）；
     *   · 把**这一次的看法**一起带过去（列也跟着给：切过去看到的还是同一张表）；
     *   · 大纲就真的是大纲 —— 不替用户补一张默认表格。
     */
    fixDerivedTab: (host, source, view) => {
      if (!editable(host)) return ''
      const hostBlock = host.kind === 'journal' ? d.kb.journalDay(todayISO()) : d.kb.get(host.blockId)
      if (!hostBlock) return ''
      const spec = derivedSpecOf(hostBlock, d.kb.roots(), source)
      if (!spec) return ''
      /**
       * 派生栏问的是「谁跟我有关」——那些块**不在宿主子树里**（所以派生栏不设子树锚点）。
       * 固定成 local tab 后，这一栏的上下文会按宿主给 `scope:'subtree'` ⇒ 结果会变成 0。
       * 所以把这一条**写明**成「全库」：跟着条件一起走，换个表面也是同一批成员。
       */
      const fixedSpec: QuerySpec = canonicalSpec({ ...spec, scope: 'all' })
      const name =
        source === 'refs'
          ? t('ui.mount.refs')
          : source === 'members'
            ? t('ui.mount.members')
            : source === 'same'
              ? t('ui.mount.same')
              : t('ui.mount.mentions')
      const label = t('ui.mount.fixedLabel', { name })
      if (view === 'list') {
        const fixed: ViewConfig = { id: mkViewId(), kind: 'list', list: { fields: derivedListFields(source) } }
        return api.addLocalTab(host, label, fixedSpec, [fixed], fixed.id)
      }
      if (view === 'table') {
        const fixed: ViewConfig = { id: mkViewId(), kind: 'table', table: { columns: derivedColumns(source) } }
        return api.addLocalTab(host, label, fixedSpec, [fixed], fixed.id)
      }
      // 大纲：不补默认表格（那会把用户选的看法换掉）
      return api.addLocalTab(host, label, fixedSpec, [], '', 'none')
    },
  }
  return api
}
