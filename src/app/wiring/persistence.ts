/**
 * 持久化装配：库与设备两个写队列、防抖、事务收尾，都收在这一节。
 *
 * store／deviceStore 的实例由装配入口创建并注入；这里不认识 `ws` 的当前值
 * （换库会整体替换），一律经 getter 现取。
 */
import { t } from '../../core/infra/msg.ts'
import type { FoldState } from '../../core/index.ts'
import type { Op, Tx, Change } from '../../core/kb/types.ts'
import type { UndoCapture } from '../../core/kb/scoped.ts'
import type { BlockStore } from '../../core/model/store.ts'
import type { MemoryKb } from '../../core/kb/memory.ts'
import { diff } from '../../core/kb/diff.ts'
import type { DeviceState, DeviceStore, Workspace, WorkspaceStore } from '../../core/infra/workspace.ts'
import type { Layers } from '../../ui/overlay/layers.ts'
import type { Chrome } from '../../ui/chrome/chrome.ts'
import type { BlockEditor } from '../../view/editor/editor.ts'

export type PersistenceDeps = {
  store: WorkspaceStore
  deviceStore: DeviceStore
  device: DeviceState
  blocks: BlockStore
  kb: MemoryKb
  /**
   * **启动是否只读**，外加要显示的启动告警。
   *
   * 传对象而不是两个值：用户在只读态点「备份并重建」之后，`readOnly` 要由这里
   * **当场翻回 false**，同时把告警收起。两个平铺的 `boolean` / `string` 改不了，
   * 上层就得再存一份 —— 两份状态能不一致，而不一致时没有任何一层会报错。
   */
  bootState: { readOnly: boolean; notice: string | null }
  /**
   * **内存里这份模型是从盘上读来的吗**。
   *
   * 判据只有一个用处：第一次落盘要不要**写 genesis**。从盘上读来的 ⇒ 盘上已经有它，
   * 第一次落盘照常增量（只写 meta）；否则（种子／旧库作废）⇒ 盘上是空的，
   * 第一次必须把整份模型写成 `diff([], seed)` 那一批 op。
   *
   * 为什么不是「整份写」：`diff([], seed)` 的每一块都带位置与所有格，
   * 行写入仍然走增量那条路 —— 种子不是特例，它就是**第一批 op**。
   */
  loadedFromDisk: boolean
  /**
   * **冷启动物化补出来的 op**（今日块、空天首子块）。
   *
   * 这一步现在走 `kb.tx`，所以有 op；`loadedFromDisk` 时把它们并进第一笔落盘。
   * 没有它们，日志里会缺「今天那块是什么时候、怎么出现的」。
   */
  bootOps: readonly Op[]
  errText: (e: unknown) => string
  layers: Layers
  /** chrome 在本节之后才装配；保存失败的常驻告警走 getter 现取 */
  getChrome: () => Chrome
  /** 换库会整体替换 `ws`，不能传值 */
  getWs: () => Workspace
  /** 编辑器装配晚于本节；折叠表在编辑器就绪前没有可写回的来源 */
  getMainEd: () => BlockEditor | undefined
  isQuiet: () => boolean
}

export function setupPersistence(deps: PersistenceDeps) {
  const { store, deviceStore, device, blocks, kb, errText, layers } = deps

  /**
   * 把编辑器里的模型写回森林（**N 个真实 section**）。
   *
   * 现在块是 **block store 里的活引用**（`rootsFor` 不再拷贝）：内容/子树的编辑直接发生在
   * store 上，多个视图共享同一份；行内内容住块上，没有第二份库级数组要对齐。
   *
   * ⚠️ 真实实现里这里是 Tx/Changes 的提交点；当前本地适配器提交的是整份库（见 `WHOLE_LIBRARY_CHANGES`）。
   */
  function syncSections(): void {
    const mainEd = deps.getMainEd()
    const ws = deps.getWs()
    ws.blocks = blocks.blocks
    /**
     * 折叠态跟**库**走（写进库的 settings；装配层的设备 store 负责分流）：编辑器持的是
     * `doc.folded`（视图那份），落盘要的是 `device.folded`（装配层持有的那一份）。
     * ⚠️ 编辑器还没装配时（读盘后的首次落盘）没有可写回的来源，保留 `device.folded` 原值。
     * ⚠️ 这里只**搬一次引用**（折叠表的每次改动都是新对象，见 `core/tree.ts` 的 `writeFold`），
     *    随后交给设备那条防抖队列（`saveDeviceNow`）：它与库那张写队列互不相干，
     *    一次折叠不会顺带重写两遍库字节，一次打字也不会顺带重写设备字节。
     */
    if (mainEd) {
      const next = mainEd.doc.folded ?? {}
      /**
       * ⚠️ **只在真的变了才排设备落盘**：`syncSections` 在每次打字后都会跑，
       *    无条件排一次就会让「敲一个字」顺便重写一遍设备字节（偏好与折叠表同一份 payload）。
       *    这里比内容而不是比引用：原地改写也不会让这份落盘悄悄失效。
       */
      const nextBody = mainEd.doc.bodyFolded ?? {}
      if (!sameFold(device.folded, next) || !sameFold(device.bodyFolded, nextBody)) {
        device.folded = next
        device.bodyFolded = nextBody
        scheduleDeviceSave()
      }
    }
  }

  /** 两张折叠表是否一致（只记收起的，所以比 key 集合就够） */
  function sameFold(a: FoldState, b: FoldState): boolean {
    const ak = Object.keys(a)
    return ak.length === Object.keys(b).length && ak.every((id) => b[id] === true)
  }

  let saveFailureShown = false

  /** 保存失败**必须让用户看见**（Electron 里 console 是隐形的）；同一次会话只提示一次，避免刷屏 */
  function warnSaveFailed(error: unknown): void {
    if (saveFailureShown) return
    saveFailureShown = true
    const text = t('ui.boot.saveFailed', { message: errText(error) })
    if (!deps.isQuiet()) layers.toast(text, 'warn')
    // 持久告警：toast 会消失，但「这次没写进去」必须一直可见
    deps.getChrome().showNotice(text)
  }

  /**
   * **提交一次**（异步、批次）：经过 `StoragePort`，失败如实返回。
   * 上层只认「这批改动落盘了没有」——不认「整份库写进去了没有」。
   *
   * `replace` 的判据是**森林有没有被整份换掉**（种子／换库），不是「这批 op 空不空」：
   * 换落点也是零 op，而它只需要写 `meta` 两格。混成一件事，每次翻页都要整库重写一遍。
   */
  function persist(ops: readonly Op[], replace = false, force = false) {
    if (deps.bootState.readOnly && !force) return Promise.resolve({ ok: true as const })
    syncSections()
    const ws = deps.getWs()
    ws.savedAt = Date.now()
    return store.commit(ws, ops, { replace })
  }

  /**
   * 上一次落盘时**森林被整片换掉的次数**（`BlockStore.swapCount`）。
   *
   * 为什么记它而不是记「上一次写的是哪一份」：换森林今天只有一条路（`reset`＝换库）。
   * 撤销/重做曾经也走那条路，现在改走 op ⇒ 它们不再需要整份写。
   */
  let savedSwap = blocks.swapCount
  /**
   * 盘上还没有这份模型 ⇒ 第一笔落盘要写 **genesis**（`diff([], 当前模型)`）。
   *
   * 为什么不靠「零 op」判：零 op 的提交太常见（换落点、只调偏好），
   * 把它当成 genesis 会让「翻一页」变成一次全库写。
   */
  let genesis = !deps.loadedFromDisk

  /** 编辑期落盘的防抖窗口：连打时只提交最后一批（批次语义见 `StoragePort`） */
  const SAVE_DEBOUNCE_MS = 250

  /**
   * **还没落盘的 op**（`tx` 攒出来的，`saveNow` 消费一次就清空）。
   *
   * 为什么在装配层攒而不是让 `tx` 自己提交：防抖窗口里一次打字会开好几个事务，
   * 每事务各提交一次就把「批次」变回「逐条写」；攒到这里，落盘的那一下才是**一批**。
   * ⚠️ 非空 ⇒ 库与盘上不再一致，所以**换库前必须清空**（旧库的 op 落到新库就是脏写）。
   */
  let pendingOps: Op[] = deps.loadedFromDisk ? [...deps.bootOps] : []
  /**
   * **最近一次事务的 op**（诊断用，只给 dev 面看）。
   *
   * 为什么要单独留一份：「一次用户动作 = 一个 tx」这条口径，唯一能当场证伪的方式是
   * 「按一下键，数一数 op」。`pendingOps` 在落盘时被清空，代不了这件事。
   */
  let lastOps: Op[] = []
  let saveTimer: number | null = null
  /**
   * **在途保存**。同一时刻只允许一批在途：两批并发会各自「拿走」同一份
   * `pendingOps` 的前缀，落盘顺序与 op 顺序不再一致。
   */
  let inFlight: Promise<void> | null = null
  /** 在途期间又来了 `saveNow()`：这批落完立刻再落下一批，不丢一次排期 */
  let saveQueued = false
  /**
   * **库的代数**：`clearPendingOps`（换库）时加一。
   *
   * 在途保存的成功回调若跨了换库，**不许**把旧库的 `genesis`/`savedSwap` 写进新库状态；
   * 旧库的批次也不许回填进新库的 `pendingOps`。代数是这条边界的唯一判据。
   */
  let epoch = 0
  /** 失败后的单次重试定时器（固定 5s，不做指数退避；失败提示本身只发一次） */
  let retryTimer: number | null = null
  const SAVE_RETRY_MS = 5000

  /**
   * **落一批**：仓库层只回答「这一批落盘了没有」，状态推进要等这个答案。
   *
   * 三个状态必须在 `ok` 之后才动：
   *   · `genesis`：失败时保持 true，下一笔重算 `diff([], 当前模型)`（它是可再生的）；
   *   · `savedSwap`：只有这一批真的落盘，盘上才算「已追到这次换森林」；
   *   · `pendingOps`：非 genesis 的批次失败要**放回队首**，且排在此期间新产生的 op 之前。
   * 之前的实现先关 genesis、先清 pendingOps、先推进 savedSwap，再 `void persist(...)`：
   * 一次失败就永久丢掉这批（以及「盘上还没这份模型」这个事实）。
   */
  function startSave(): Promise<void> {
    const first = genesis
    const swapAtStart = blocks.swapCount
    const epochAtStart = epoch
    /**
     * **第一笔是 genesis**：`diff([], 当前模型)` 覆盖全库，待落盘队列里已有的 op
     * （bootOps 与期间编辑）都被它包含，直接让位给这一份；失败时 genesis 仍为 true，
     * 下一笔会按**那时的**模型重算，不会漏掉期间的编辑。
     */
    const batch = first ? diff([], deps.getWs().blocks) : pendingOps
    if (!first) pendingOps = []
    /**
     * **整份替换的判据**只剩两条：第一笔 genesis，或者森林被整片换过（换库）。
     * 零 op 但森林没换（例如只换了落点）⇒ 照常增量，只写 meta 两格。
     */
    const replace = first || swapAtStart !== savedSwap
    /** 失败收口：只碰还在同一代、且这一批确实属于本库的状态 */
    const onFailure = (error: unknown): void => {
      if (epochAtStart !== epoch) return
      /**
       * 批次放回队首。期间新产生的 op 已经在 `pendingOps` 里，接在它后面——
       * 顺序仍是「先发生的先落」。genesis 批次不回填（它可由当前模型重算）。
       * 先回填再提示：提示链路（toast／notice）本身不该决定这一批还留不留。
       */
      if (!first) pendingOps = [...batch, ...pendingOps]
      if (retryTimer === null) {
        retryTimer = window.setTimeout(() => {
          retryTimer = null
          saveNow()
        }, SAVE_RETRY_MS)
      }
      warnSaveFailed(error)
    }
    const p = Promise.resolve()
      .then(() => persist(batch, replace))
      .then(
        (saved) => {
          // 跨了换库：这一批属于旧库，状态推进与回填都不许碰新库
          if (epochAtStart !== epoch) return
          if (!saved.ok) {
            onFailure(saved.error)
            return
          }
          if (retryTimer !== null) {
            window.clearTimeout(retryTimer)
            retryTimer = null
          }
          genesis = false
          savedSwap = swapAtStart
          // 落盘期间又攒了 op：再排一批（防抖窗口会把连续编辑并回去）
          if (pendingOps.length > 0) scheduleSave()
        },
        // 只接 `persist` 的拒绝（同步 throw 也被 `Promise.resolve().then` 转成拒绝）；
        // 成功分支里的异常不在这里被误判成「这批没落盘」
        (error: unknown) => onFailure(error),
      )
      .finally(() => {
        inFlight = null
        if (saveQueued) {
          saveQueued = false
          saveNow()
        }
      })
    inFlight = p
    return p
  }

  function saveNow(): void {
    if (deps.bootState.readOnly) return
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer)
      saveTimer = null
    }
    if (inFlight) {
      // 在途：只记「还要再落一次」。它不是丢排期——这一批的 finally 会接上。
      saveQueued = true
      return
    }
    void startSave()
  }

  function scheduleSave(): void {
    if (deps.bootState.readOnly) return
    syncSections()
    if (saveTimer !== null) window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(saveNow, SAVE_DEBOUNCE_MS)
  }

  /**
   * **只读态下唯一允许的一笔写入**：用户显式点了「备份并重建本地库」。
   *
   * 调用方已经把这批内容换进 `getWs()`（并清过 `pendingOps`）；这里只负责
   * 「整份替换落盘，并把启动态翻回可写」。成功之后 `readOnly` 永远不回滚 ——
   * 盘上已经不是那份读不出来的字节了。失败时**保持只读**：写不进去就继续装作能写，
   * 只会得到「用户以为存上了、下次打开又没了」。
   *
   * 不做幂等 `genesis` 判断：这条路径本身就是一次显式全量重建，
   * `diff([], 当前森林)` 与 `replace` 一起表达它，而后把 `genesis` 关掉。
   */
  async function forceReplaceNow(): Promise<{ ok: true } | { ok: false; error: unknown }> {
    // 先等在途的那批落完：它可能正拿着旧库的批次，和这次整份替换并发会打乱落盘顺序
    if (inFlight) await inFlight
    // 这次是显式整份替换：清掉失败重试，避免它和替换并发
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer)
      retryTimer = null
    }
    /**
     * 整份替换覆盖的是**调用这一刻**的模型；期间新产生的 op 不丢——替换成功后
     * 仍留在 `pendingOps`，由下一次保存接着写。
     */
    const covered = pendingOps
    pendingOps = []
    const swapAt = blocks.swapCount
    const r = await persist(diff([], deps.getWs().blocks), true, true)
    if (!r.ok) {
      // 失败：把被这次替换覆盖的 op 放回队首；genesis/savedSwap 一律不动
      pendingOps = [...covered, ...pendingOps]
      return { ok: false, error: r.error }
    }
    genesis = false
    savedSwap = swapAt
    deps.bootState.readOnly = false
    deps.bootState.notice = null
    // 上一次失败的告警不该跟着新库继续挂着
    saveFailureShown = false
    if (pendingOps.length > 0) scheduleSave()
    return { ok: true }
  }

  /* ------------------------------------------------------------ 设备状态落盘 */

  let deviceTimer: number | null = null

  /**
   * **设备偏好**的落盘，与库**各走各的**（两个键、两个写队列）。
   *
   * 为什么不并进 `saveNow`：调一下主题宽度不该触发一次整库提交，反过来打字也不该
   * 每 250ms 重写一遍偏好。两个防抖窗口互不干扰，代价是页面生命周期里要**各 flush 一次**
   * （见下面的 `visibilitychange` / `pagehide` / `beforeunload`）。
   *
   * ⚠️ 不受 `readOnly` 管：只读态保护的是**库的内容**（过新／损坏的字节不许覆盖），
   *    而偏好是这份构建自己的设备状态 —— 只读演示时用户调主题，仍应该记得住。
   */
  function saveDeviceNow(): void {
    if (deviceTimer !== null) {
      window.clearTimeout(deviceTimer)
      deviceTimer = null
    }
    void deviceStore.save(device).then((saved) => {
      if (!saved.ok) warnSaveFailed(saved.error)
    })
  }

  function scheduleDeviceSave(): void {
    if (deviceTimer !== null) window.clearTimeout(deviceTimer)
    deviceTimer = window.setTimeout(saveDeviceNow, SAVE_DEBOUNCE_MS)
  }

  /**
   * `beforeunload` 里**等不到 Promise**（等待点由调用方决定）。
   * 所以把仓库生命周期的两个真实等待点接上：页面隐藏时 `settle()`；
   * 卸载前把待提交的那批**立刻发出去**（适配器内部是同步 `setItem`，发出即落盘）。
   */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      saveNow()
      saveDeviceNow()
      void store.settle()
      void deviceStore.settle()
    }
  })
  window.addEventListener('pagehide', () => {
    saveNow()
    saveDeviceNow()
  })

  /**
   * **开一次事务**：跑完 `fn`，把产出的 op 攒进待落盘队列，并留一份给诊断面。
   *
   * 失败时把 `pendingOps` 截回进门时的长度：`kb.tx` 会把模型整批回滚，
   * 已经攒进去的 op 却不会自己消失 —— 不清掉就等于「内存退回去了、盘上却多了一批」。
   */
  function txRun<R>(
    fn: (tx: Tx) => R,
    source?: unknown,
    opts: { capture?: (undo: UndoCapture) => void } = {},
  ): { ops: Op[]; changes: Change[]; result: R; undo: UndoCapture } {
    const n = pendingOps.length
    try {
      const r = kb.tx(fn, { source })
      pendingOps.push(...r.ops)
      lastOps = r.ops
      /**
       * **捕获交给调用方的收集器**（不在这里记撤销）：一次动作可能拆成几笔写，
       * 什么时候算「一步」只有动作的发起者知道（编辑器的 `begin/finishUndoEntry`）。
       */
      opts.capture?.(r.undo)
      return r
    } catch (e) {
      pendingOps.length = n
      throw e
    }
  }

  /** 命令与编辑器共用的入口形状（`Run`）：只要结果 */
  function run<R>(
    fn: (tx: Tx) => R,
    source?: unknown,
    opts: { capture?: (undo: UndoCapture) => void } = {},
  ): R {
    return txRun(fn, source, opts).result
  }

  return {
    syncSections,
    /**
     * **撤销/重做产出的 op** 并进待落盘队列（与一次普通编辑同一条路）。
     *
     * 为什么不在这里 `scheduleSave()`：撤销紧接着还会重画、刷角标，排期由调用方统一做
     * （`main.ts` 的 `undoOps` 一处），免得同一批 op 被排两次。
     */
    addOps: (ops: readonly Op[]) => {
      pendingOps.push(...ops)
    },
    saveNow,
    scheduleSave,
    forceReplaceNow,
    saveDeviceNow,
    scheduleDeviceSave,
    txRun,
    run,
    /** 只读副本：调用方改数组不该影响这里记着的那一份 */
    getLastOps: () => lastOps.slice(),
    /** 换库前清空：旧库的 op 带过河就是脏写；代数加一让在途保存的状态推进失效 */
    clearPendingOps: () => {
      pendingOps = []
      epoch++
      saveQueued = false
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer)
        retryTimer = null
      }
    },
  }
}
