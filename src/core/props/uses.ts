/**
 * **属性用途的命名空间**（属性定义上的 `_use`）。
 *
 * 用途是**数据**：它落在定义的属性袋里，进撤销、导出与查询。所以这里是一张**开放**
 * 的用途表，不是封闭枚举——给一条属性增加「拿来干什么」的用途，不需要改模型层。
 *
 * 语法是命名空间式的：`closure`、`closure:reading`、`priority`。前缀只表达「同族」，
 * **不自动继承语义**：读方按完整 id 精确匹配；要让 `closure:reading` 也算关闭态，
 * 得显式登记消费者或让解析器按上下文取——不靠字符串前缀猜。
 *
 * 注册**不是写入前提**。没登记的用途照样存得下、读得出（别的构建带来的库不能因为
 * 一个不认识的用途就判坏）；注册声明的是**语义**：这个用途是否库级唯一、有哪些消费者。
 * 语义代码一律按用途 id 精确匹配，所以新增一个用途不需要动别的用途的判据。
 *
 * ⚠️ 不叫「角色」：块那边已经有一个「角色」（页/标签/日记的露面与派生身份），
 *    那条轴由 `_aliases` ＋ `_lists` ＋ `_date` 回答。这里是**属性定义**的用途，
 *    和「块担任什么机制位」不是同一件事；共用一个词会让两套判据看起来是同一套。
 */

/**
 * 用途 id 的语法：`head(:segment)*`。
 *
 * 小写字母起头（系统键值不放大小写变体），段内允许数字与连字符；`:` 分段表达
 * 「同族」。不收下划线/大写：它们在该命名空间里没有约定，混进来只会让读方
 * 多一份归一逻辑。
 */
const USE_ID_RE = /^[a-z][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)*$/

/**
 * 用途 id（`_use` 的值）。
 *
 * 用别名而不是模板字面量类型：值来自用户数据与注册调用，编译期不该假定一个封闭集合；
 * 运行期判据只有 `isUseId` 一份。
 */
export type UseId = string

export function isUseId(v: unknown): v is UseId {
  return typeof v === 'string' && USE_ID_RE.test(v)
}

/** 一个用途的语义声明 */
export interface UseSpec {
  id: UseId
  /**
   * 库级唯一：最多一条定义带这个用途。
   *
   * 为什么是用途自己的属性而不是写入口的硬编码：唯一性回答的是「这个用途有没有
   * 第二个答案」——关闭态需要，优先级不需要。写入口在读用途声明时问这一格，
   * 而不是各自记一份例外名单。
   */
  unique?: boolean
}

/** 消费者槽：本体里会「按用途做事」的位置。 */
export type ConsumerSlot = 'gutter-mark' | 'keymap' | 'query-predicate' | 'projection'

const CONSUMER_SLOTS: readonly ConsumerSlot[] = ['gutter-mark', 'keymap', 'query-predicate', 'projection']

export function isConsumerSlot(v: unknown): v is ConsumerSlot {
  return typeof v === 'string' && (CONSUMER_SLOTS as readonly string[]).includes(v)
}

/** 「这个用途在这个槽里有一个消费者」——只登记，槽自己决定怎么消费。 */
export interface UseConsumer {
  useId: UseId
  slot: ConsumerSlot
}

const useSpecs = new Map<UseId, UseSpec>()
const slotUses = new Map<ConsumerSlot, UseId[]>()
const seenConsumers = new Set<string>()

/**
 * 登记一个用途的语义。同一个 id 重复登记是幂等的；**改语义**会抛错——运行期换掉
 * `unique` 会让已经写下去的数据与写入口的判据对不上，这种错必须在装载时就炸。
 */
export function registerUse(spec: UseSpec): void {
  if (!isUseId(spec.id)) throw new Error(`invalid use id "${String(spec.id)}"`)
  const prev = useSpecs.get(spec.id)
  if (prev && (prev.unique === true) !== (spec.unique === true)) {
    throw new Error(`use "${spec.id}" already registered with a different spec`)
  }
  if (prev) return
  useSpecs.set(spec.id, { id: spec.id, ...(spec.unique === true ? { unique: true } : {}) })
}

export function useSpecOf(id: UseId): UseSpec | undefined {
  return useSpecs.get(id)
}

export function registeredUses(): readonly UseSpec[] {
  return [...useSpecs.values()]
}

/** 这个用途是不是库级唯一（未登记的用途没有任何唯一性约束） */
export function useIsUnique(id: UseId): boolean {
  return useSpecs.get(id)?.unique === true
}

/**
 * 登记「这个用途在这个槽里要被消费」。
 *
 * 只登记，不执行：消费者是可卸载的代码，槽是本体里的**唯一**执行点。同一个
 * `(slot, use)` 重复登记幂等；用途不必先注册——登记顺序不承载语义。
 */
export function registerConsumer(c: UseConsumer): void {
  if (!isConsumerSlot(c.slot)) throw new Error(`invalid consumer slot "${String(c.slot)}"`)
  if (!isUseId(c.useId)) throw new Error(`invalid use id "${String(c.useId)}"`)
  const key = `${c.slot}\u0000${c.useId}`
  if (seenConsumers.has(key)) return
  seenConsumers.add(key)
  const list = slotUses.get(c.slot)
  if (list) list.push(c.useId)
  else slotUses.set(c.slot, [c.useId])
}

export function consumersOf(slot: ConsumerSlot): readonly UseId[] {
  return slotUses.get(slot) ?? []
}

export function hasConsumer(use: UseId, slot: ConsumerSlot): boolean {
  return slotUses.get(slot)?.includes(use) === true
}

/**
 * 一格里**取哪个用途**：按登记顺序取第一个。
 *
 * 「同一时刻只该有一个答案」的槽（全局键位）用它：内建用途在模块装载时先登记，
 * 后来者不会抢占既有手势——「谁优先」不能由后注册者决定，那样就是一个用户
 * 看不见的规则。
 */
export function slotUseOf(slot: ConsumerSlot): UseId | undefined {
  return slotUses.get(slot)?.[0]
}

/**
 * 关闭态的用途 id。
 *
 * 它是**本体**的一条用途（不是任务词汇）：`closureOf`、`⌘↵`、删除线都按这个 id
 * 精确匹配。任务那套约定（`#任务`、待办/完成、选项 id）住在种子与文案里。
 */
export const CLOSURE_USE: UseId = 'closure'

registerUse({ id: CLOSURE_USE, unique: true })
// `⌘↵` 的裁决在本体：关闭态是内建的第一个 keymap 消费者，后注册的用途不抢占。
registerConsumer({ useId: CLOSURE_USE, slot: 'keymap' })
