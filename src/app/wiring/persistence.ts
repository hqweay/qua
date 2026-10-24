/**
 * 持久化装配：库与设备两个写队列、防抖、事务收尾，都收在这一节。
 *
 * store／deviceStore 的实例由装配入口创建并注入；这里不认识 `ws` 的当前值
 * （换库会整体替换），一律经 getter 现取。
 */
import { t } from '../../core/msg.ts'
import type { FoldState } from '../../core/index.ts'
import type { Op, Tx, Change } from '../../core/kb/types.ts'
import type { BlockStore } from '../../core/store.ts'
import type { MemoryKb } from '../../core/kb/memory.ts'
import type { DeviceState, DeviceStore, Workspace, WorkspaceStore } from '../../core/workspace.ts'
import type { Layers } from '../../ui/layers.ts'
import type { Chrome } from '../../ui/chrome.ts'
import type { BlockEditor } from '../../view/editor.ts'

export type PersistenceDeps = {
  store: WorkspaceStore
  deviceStore: DeviceStore
  device: DeviceState
  blocks: BlockStore
  kb: MemoryKb
  readOnly: boolean
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
  const { store, deviceStore, device, blocks, kb, readOnly, errText, layers } = deps

  /**
   * 把编辑器里的模型写回森林（**N 个真实 section**）。
   *
   * 现在块是 **block store 里的活引用**（`rootsFor` 不再拷贝）：正文/子树的编辑直接发生在
   * store 上，多个视图共享同一份。这里只把库级的 marks/atoms 引用对齐（它们也是共享数组）。
   *
   * ⚠️ 真实实现里这里是 Tx/Changes 的提交点；当前本地适配器提交的是整份库（见 `WHOLE_LIBRARY_CHANGES`）。
   */
  function syncSections(): void {
    const mainEd = deps.getMainEd()
    const ws = deps.getWs()
    ws.marks = blocks.marks
    ws.atoms = blocks.atoms
    /**
     * 折叠态是**设备状态**（`qua.device`），所以它不再写回库：编辑器持的是 `doc.folded`
     * （视图那份），落盘要的是 `device.folded`（这台设备那份）。
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
      if (!sameFold(device.folded, next)) {
        device.folded = next
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
   * 传进来的 op 为空 ⇒ 这批**不是**由事务产生的（编辑器的正文/结构直写仍是直改内存），
   * 只能按整类提交；这是迁移期的真相，不是兜底。op → changes 的推导归门面（`changesOf`）。
   */
  function persist(ops: readonly Op[]) {
    if (readOnly) return Promise.resolve({ ok: true as const })
    syncSections()
    const ws = deps.getWs()
    ws.savedAt = Date.now()
    return store.commit(ws, ops)
  }

  /** 编辑期落盘的防抖窗口：连打时只提交最后一批（批次语义见 `StoragePort`） */
  const SAVE_DEBOUNCE_MS = 250

  /**
   * **还没落盘的 op**（`tx` 攒出来的，`saveNow` 消费一次就清空）。
   *
   * 为什么在装配层攒而不是让 `tx` 自己提交：防抖窗口里一次打字会开好几个事务，
   * 每事务各提交一次就把「批次」变回「逐条写」；攒到这里，落盘的那一下才是**一批**。
   * ⚠️ 非空 ⇒ 库与盘上不再一致，所以**换库前必须清空**（旧库的 op 落到新库就是脏写）。
   */
  let pendingOps: Op[] = []
  /**
   * **最近一次事务的 op**（诊断用，只给 dev 面看）。
   *
   * 为什么要单独留一份：「一次用户动作 = 一个 tx」这条口径，唯一能当场证伪的方式是
   * 「按一下键，数一数 op」。`pendingOps` 在落盘时被清空，代不了这件事。
   */
  let lastOps: Op[] = []
  let saveTimer: number | null = null

  function saveNow(): void {
    if (readOnly) return
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer)
      saveTimer = null
    }
    // 取出并清空：这批 op 只该落一次。提前清空是**对的**——提交失败时盘上是旧的，
    // 而那份旧的本来就是「上一次成功提交」；留着它们等下次重提，只会浮在一份已经改过的
    // 模型上（那时的 op 已经说不清自己相对哪份盘上数据）。
    const ops = pendingOps
    pendingOps = []
    void persist(ops).then((saved) => {
      if (!saved.ok) warnSaveFailed(saved.error)
    })
  }

  function scheduleSave(): void {
    if (readOnly) return
    syncSections()
    if (saveTimer !== null) window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(saveNow, SAVE_DEBOUNCE_MS)
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
  function txRun<R>(fn: (tx: Tx) => R, source?: unknown): { ops: Op[]; changes: Change[]; result: R } {
    const n = pendingOps.length
    try {
      const r = kb.tx(fn, { source })
      pendingOps.push(...r.ops)
      lastOps = r.ops
      return r
    } catch (e) {
      pendingOps.length = n
      throw e
    }
  }

  /** 命令与编辑器共用的入口形状（`Run`）：只要结果 */
  function run<R>(fn: (tx: Tx) => R, source?: unknown): R {
    return txRun(fn, source).result
  }

  return {
    syncSections,
    saveNow,
    scheduleSave,
    saveDeviceNow,
    scheduleDeviceSave,
    txRun,
    run,
    /** 只读副本：调用方改数组不该影响这里记着的那一份 */
    getLastOps: () => lastOps.slice(),
    /** 换库前清空：旧库的 op 带过河就是脏写 */
    clearPendingOps: () => {
      pendingOps = []
    },
  }
}
