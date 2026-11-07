/**
 * **分组包装**：表格按某一列分成「一组一段」时的宿主。
 *
 * 段头（组名 ＋ 条数）归这里，段身归各 kind 自己的渲染器——`makeBody` 由宿主
 * （ViewHost）给：它知道一台 ViewList／ViewTable 要接哪些依赖，这里不重复那份
 * 装配。子渲染器按组 id 建一次、跨 render 复用：组集没变时只换每段的记录
 * （闭包槽位），不整段重建——整表重建是「滚动一下全屏闪」的来源。
 *
 * 多值键（`isMultiValueKey`）的口径与看板一致：一块**出现在每个所属组**
 * （fan-out）；一个值都没有 ⇒ 只进「未设置」。这里不禁多值——表格没有
 * 「拖去某组写值」的动作，fan-out 展示没有歧义（看板禁多值是拖卡语义逼的）。
 */
import { type ViewConfig, type ViewRecord } from '../../core/index.ts'
import { bucketize, bucketLabel, orderBuckets, recordsForGrouping, type BucketizeOptions, type GroupBucket } from './grouping.ts'

export interface ViewGroupedDeps {
  view: () => ViewConfig | null
  records: () => ViewRecord[]
  choices: (propId: string) => readonly { id: string; label: string }[]
  /** 字段基数解析：多值字段 fan-out（一块进每个所属组） */
  cardinalityOf?: (propId: string) => 'one' | 'many'
  /** 造一个装某组记录的段身（宿主决定用哪台渲染器） */
  makeBody: (records: () => ViewRecord[]) => { root: HTMLElement; render(): void; dispose(): void }
}

interface Slot {
  records: ViewRecord[]
  body: { root: HTMLElement; render(): void; dispose(): void }
  wrap: HTMLElement
  count: HTMLElement
}

export class ViewGrouped {
  readonly root: HTMLElement
  private readonly deps: ViewGroupedDeps
  /** 组 id → 段（跨 render 复用；组消失才 dispose） */
  private readonly slots = new Map<string, Slot>()

  constructor(deps: ViewGroupedDeps) {
    this.deps = deps
    this.root = document.createElement('div')
    this.root.className = 'vgroup'
  }

  dispose(): void {
    for (const s of this.slots.values()) s.body.dispose()
    this.slots.clear()
  }

  render(): void {
    const view = this.deps.view()
    const key = view?.groupBy ?? ''
    const o: BucketizeOptions = {
      choices: this.deps.choices,
      groupOrder: view?.groupOrder,
      ...(this.deps.cardinalityOf ? { cardinalityOf: this.deps.cardinalityOf } : {}),
    }
    const { buckets, order } = bucketize(recordsForGrouping(this.deps.records(), view), key, o)
    const ordered = orderBuckets(buckets, order).filter((b) => b.records.length > 0 || b.unset)

    const keep = new Set(ordered.map((b) => b.id))
    for (const [id, s] of this.slots) {
      if (keep.has(id)) continue
      s.body.dispose()
      s.wrap.remove()
      this.slots.delete(id)
    }
    for (const b of ordered) {
      const slot = this.slots.get(b.id) ?? this.addSlot(b)
      slot.records = b.records
      slot.count.textContent = String(b.records.length)
      slot.body.render()
    }
    this.root.dataset.empty = ordered.length === 0 ? '1' : '0'
  }

  /** 段头文案：与看板列头同一份解析（块 id 值翻译成名字） */
  private addSlot(b: GroupBucket): Slot {
    const wrap = document.createElement('section')
    wrap.className = 'vgroup-sec'
    const head = document.createElement('div')
    head.className = 'vgroup-head'
    const name = document.createElement('span')
    name.className = 'vgroup-name ui-ellipsis'
    name.textContent = bucketLabel(b, this.deps.view()?.groupBy ?? '', { choices: this.deps.choices })
    const count = document.createElement('span')
    count.className = 'vgroup-count'
    head.append(name, count)
    wrap.appendChild(head)
    this.root.appendChild(wrap)

    const slot: Slot = { records: [], body: null as never, wrap, count }
    slot.body = this.deps.makeBody(() => slot.records)
    wrap.appendChild(slot.body.root)
    this.slots.set(b.id, slot)
    return slot
  }
}
