/**
 * 侧槽里的一张卡——**存的意图**（`DockEntry`），不是画出来的元素
 * （那个是 `ui/dock.ts` 的 `DockCardEntry`：id ＋ 元素 ＋ 尺寸）。
 *
 * 三种来源语义不同：块露面（窗口卡／组件卡）、宿主现算的派生卡、一条命令的小卡。
 *
 * ## 为什么不是 `string[]`
 *
 * 早先三者混在一个字符串列表里，靠**字符串形状**分辨（`cmd:` 前缀／32 位 hex／其余）。
 * 这有两个不会报错的后果：
 *   1. **形状判错 ⇒ 静默不画**。块 id 一旦不合 hex（生成端写坏、或将来换 id 方案），
 *      整张窗口卡直接消失，不抛、不提示；
 *   2. **加第四种来源没有提醒**。三个 `if` 各写一遍，漏掉一处只是那一种卡不出现。
 *
 * ⇒ 改成显式联合：写入口按 `kind` 构造，读出口按 `kind` 分派。加一种来源＝编译期全红。
 *
 * ## 落盘的是联合，DOM／状态键仍是扁平 key
 *
 * `data-card-id`、`collapsedCards`、`solo`、拖拽载荷都用 `dockKey()`：
 * 那是「这张卡此刻的身份」，换一串会让用户已折叠／已单卡的卡静默复位，也会改掉拖拽契约。
 *
 * ⚠️ key 只用来**认身份**，不再用来**认种类**。它的唯一性来自各自的身份契约
 *    （块 id 恒为 32 位 hex、派生卡 id 是闭集、命令带 `cmd:` 前缀），不是靠形状猜测。
 */

import type { MsgId } from './msg.ts'

/** 命令小卡的 key 前缀；只有「扁平 key」这一层用它，`DockEntry` 自己不存前缀 */
export const DOCK_CMD_PREFIX = 'cmd:'

/**
 * 一个块窗口进槽的**动作**。
 *
 * pin 的缺省跟着动作走，不跟着槽走：**拖进来（钉）＝常驻，打开来看（Shift+点／命令）＝只留本会话**。
 * 为什么不在读取路径上按槽推缺省：那会让每次重画都要查一遍槽规则；
 * 在写入口（两个动作）各写一次初值，读路径只看卡上自己的 pin 位，零分支。
 * 左槽只有拖入一个入口 ⇒ 「左槽窗口默认常驻」是这条规则的推论，不是另一条规则。
 */
export type WindowEntryAction = 'drop' | 'view'

export function pinDefaultFor(action: WindowEntryAction): boolean {
  return action === 'drop'
}

/**
 * 重启清理：**非 pin 的块窗口卡不留到下一次启动**（窗口是「打开来看」的临时上下文，
 * 重启还全在，攒几轮就是一列没人看的旧窗口）；pin 了的是用户明说要留的，保留。
 *
 * 组件块（类型声明了 widget）、派生卡、命令小卡是**槽的家具**——布局的一部分，
 * 不属于「打开的东西」，一律不受影响。组件块由调用方传判据（这里不依赖块模型）。
 */
export function pruneEphemeralWindows(
  cards: readonly DockEntry[],
  pinned: Readonly<Record<string, true>>,
  isWidget: (blockId: string) => boolean,
): DockEntry[] {
  return cards.filter((e) => {
    if (e.kind !== 'block') return true
    if (isWidget(e.block)) return true
    return pinned[dockKey(e)] === true
  })
}

/** 宿主现算的派生卡（闭集；画廊、渲染、旧字节解析共用这一份） */
export type DerivedCardId = 'inspect' | 'belongs' | 'backrefs' | 'trash' | 'calendar'

export type DockEntry =
  | { kind: 'block'; block: string }
  | { kind: 'derived'; card: DerivedCardId }
  | { kind: 'cmd'; command: string }

/** 一张卡的扁平身份（DOM 属性／收起表／单卡表／拖拽载荷共用） */
export function dockKey(entry: DockEntry): string {
  switch (entry.kind) {
    case 'block':
      return entry.block
    case 'derived':
      return entry.card
    case 'cmd':
      return `${DOCK_CMD_PREFIX}${entry.command}`
  }
}

export interface DerivedCardDecl {
  id: DerivedCardId
  /** 画廊里的图标（`lucide:<name>`，与命令声明的 `tile.icon` 同一套解析） */
  icon: string
  /** 画廊里的标题（字典 id；UI 调 `t()` 取字） */
  label: MsgId
}

/**
 * 派生卡目录：**画廊列什么、`addDerived` 收什么、渲染分支穷举什么**都从这一份来。
 *
 * 早先画廊自己列一张表、渲染器自己写一串 `id === '…' ? …`，两边各答一遍「有哪些派生卡」；
 * 加一张卡时漏掉一边的表现是「画廊里有、点了没反应」。
 */
export const DERIVED_CARDS: readonly DerivedCardDecl[] = [
  { id: 'calendar', icon: 'lucide:calendar', label: 'ui.cal.title' },
  { id: 'belongs', icon: 'lucide:list-tree', label: 'ui.belongs.treeTitle' },
  { id: 'inspect', icon: 'lucide:sliders-horizontal', label: 'ui.dock.inspect' },
  { id: 'backrefs', icon: 'lucide:corner-up-left', label: 'ui.dock.backRefs' },
  { id: 'trash', icon: 'lucide:trash-2', label: 'ui.dock.trash' },
]

export function isDerivedCardId(v: unknown): v is DerivedCardId {
  return typeof v === 'string' && DERIVED_CARDS.some((d) => d.id === v)
}

/**
 * 把落盘的 `cards` 归一成一串 `DockEntry`（逐项丢弃坏项，不连累整槽）。
 *
 * 同时认两种字节：
 *   · 新形状：`{kind, …}` 对象；
 *   · 旧形状：扁平字符串（老设备状态里存的就是它）。
 */
export function canonicalDockEntries(raw: unknown): DockEntry[] {
  if (!Array.isArray(raw)) return []
  const out: DockEntry[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const entry = dockEntryOf(item)
    if (!entry) continue
    const key = dockKey(entry)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out
}

function dockEntryOf(raw: unknown): DockEntry | null {
  if (typeof raw === 'string') return legacyEntry(raw)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.kind === 'block') {
    return typeof o.block === 'string' && o.block !== '' ? { kind: 'block', block: o.block } : null
  }
  if (o.kind === 'derived') {
    // 未知派生卡 id ⇒ 丢掉：它没有渲染器，留着只会是一张看不见、也关不掉的卡
    return isDerivedCardId(o.card) ? { kind: 'derived', card: o.card } : null
  }
  if (o.kind === 'cmd') {
    return typeof o.command === 'string' && o.command !== '' ? { kind: 'cmd', command: o.command } : null
  }
  return null
}

/**
 * 旧设备状态里的扁平 id。
 *
 * 只对**旧字节**做这一层判断：`cmd:` 与派生卡 id 都是**名字**（前缀／闭集），
 * 其余一律当块——**不验 hex 形状**。畸形 id 也要留住：它可能只是生成端写坏，
 * 而按形状丢掉的后果是用户的一张窗口卡静默消失（这正是旧实现踩过的坑）。
 */
function legacyEntry(id: string): DockEntry | null {
  if (id === '') return null
  if (id.startsWith(DOCK_CMD_PREFIX)) {
    const command = id.slice(DOCK_CMD_PREFIX.length)
    return command === '' ? null : { kind: 'cmd', command }
  }
  if (isDerivedCardId(id)) return { kind: 'derived', card: id }
  return { kind: 'block', block: id }
}
