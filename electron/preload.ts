/**
 * preload：**最小面**——壳不暴露业务。
 *
 * 暴露给页面的只有三样：
 *   - `kb.shellInfo()`      —— 壳的版本/平台/数据目录（**不是业务**）
 *   - `kb.kernel.attach()`  —— 拿一条通向内核的通道（port 中转形状）
 *   - `qua.*`               —— 库／存储／设置／资产／关闭握手（多库面）
 *
 * ⚠️ **不暴露 `ipcRenderer` 本体**，也不暴露任何 `require`：页面拿不到 Node。
 * `contextIsolation:true` + `nodeIntegration:false` + `sandbox:true` ⇒ 这个文件里能用的
 * 只有 `contextBridge` / `ipcRenderer` 两个 import，`node:fs` 之类连 import 都会失败。
 *
 * ## 为什么 `qua.*` 的方法全是「普通函数」
 *
 * 同一个坑（见 `docs/ELECTRON-备忘.md`）：`contextBridge.exposeInMainWorld` 只搬运**自有属性**，
 * 原型上的方法不会被带过去。所以这里每一个方法都是箭头函数，返回值是可结构化克隆的普通对象。
 *
 * ## 为什么渲染层不告诉主进程「我是哪个库」
 *
 * 主进程按 `event.sender.id` 路由（`electron/library/windows.ts`）。渲染层手里的库 id
 * 可能是过期的（库被移除／窗口切库），而 `sender.id` 是 Electron 给的事实。
 * ⇒ 这里所有方法都**不带库 id 参数**。
 */
import { contextBridge, ipcRenderer } from 'electron'

/** 页面侧能看到的通道面（方法都是普通函数 ⇒ `contextBridge` 能搬） */
export interface KernelLink {
  post(message: unknown): void
  onMessage(cb: (data: unknown) => void): void
  close(): void
}

function wrap(port: MessagePort): KernelLink {
  const cbs: ((data: unknown) => void)[] = []
  port.onmessage = (ev) => {
    for (const cb of cbs) cb(ev.data)
  }
  return {
    post: (message: unknown) => port.postMessage(message),
    onMessage: (cb: (data: unknown) => void) => {
      cbs.push(cb)
    },
    close: () => port.close(),
  }
}

/** 一次 attach 一个等待者；先到先得。没人认领的端口当场关掉，不留悬空通道。 */
const waiters: ((link: KernelLink) => void)[] = []

ipcRenderer.on('kb:kernel/port', (event) => {
  const port = event.ports[0]
  if (!port) return
  port.start()
  const waiter = waiters.shift()
  if (waiter) waiter(wrap(port))
  else port.close()
})

const kernel = {
  /**
   * 请求一条内核通道。
   *
   * 现在主干**还没有内核进程** ⇒ 对面是一个明标 `stub:true` 的回声（见 `main.ts` 的 `attachKernel`）。
   * 接上内核后**这个函数一行都不用改**：变的只是 `main.ts` 里那条 `TODO(kernel)`。
   */
  attach(): Promise<KernelLink> {
    return new Promise<KernelLink>((resolve) => {
      waiters.push(resolve)
      ipcRenderer.send('kb:kernel/attach')
    })
  },
}

/* ------------------------------------------------------------ 库面 */

const qua = {
  /**
   * 壳的平台（**同步只读常量**）：网页顶栏要靠它决定给原生窗口控件让哪一侧、让多少。
   * 不用 `userAgent` 猜：那是渲染层能被改写的字符串，这里是壳给的事实。
   * 沙箱 preload 里 `process` 是受限的多面对象，取不到时退成 unknown（不让加载失败）。
   */
  platform: typeof process === 'undefined' ? 'unknown' : process.platform,
  /** 这个窗口订阅的是哪个库（没有库 ⇒ `status:'no-library'`，走欢迎页） */
  libraryInfo: (): Promise<unknown> => ipcRenderer.invoke('qua:library/info'),
  libraryList: (): Promise<unknown> => ipcRenderer.invoke('qua:library/list'),
  openLibrary: (id: string): Promise<unknown> => ipcRenderer.invoke('qua:library/open', id),
  /** 在指定目录建库（外部库；不传落默认 `repos/<id>`）。目录必须为空或不存在的子路径 */
  createLibrary: (id: string, name: string, dir?: string): Promise<unknown> =>
    ipcRenderer.invoke('qua:library/create', id, name, dir),
  /** 打开一个目录下的库（目录里必须有 `library.json`）；没登记过就登记为外部库 */
  openLibraryAt: (dir: string): Promise<unknown> => ipcRenderer.invoke('qua:library/open-at', dir),
  /** 整库快照到 `<库目录>/backups/`；渲染层的显式清库动作把它当回退面 */
  backupLibrary: (label?: string): Promise<unknown> => ipcRenderer.invoke('qua:library/backup', label ?? 'manual'),

  /** 落一批行写入（增量或整份替换；编码归渲染层） */
  save: (writes: unknown[], opts?: { replace?: boolean; oplog?: unknown[]; derived?: boolean }): Promise<unknown> =>
    ipcRenderer.invoke('qua:storage/save', writes, opts ?? {}),

  /**
   * **工作集读面**（具名查询：主进程只执行 SQL，不认块语义）。
   * `doc` 收「要装哪几个视图根」，`blocks` 收一批块自己的行（不带子树），
   * `catalog` 只回槽要显示的全局身份摘要。
   */
  doc: (roots: readonly string[]): Promise<unknown> => ipcRenderer.invoke('qua:library/doc', roots),
  blocks: (ids: readonly string[]): Promise<unknown> => ipcRenderer.invoke('qua:library/blocks', ids),
  /** 查询候选 id（计划 JSON 由 core 编译；主进程只执行） */
  candidates: (plan: unknown): Promise<unknown> => ipcRenderer.invoke('qua:library/candidates', plan),
  /** 候选装载：块＋祖先链（可选一层子级） */
  tree: (ids: readonly string[], withChildren: boolean): Promise<unknown> =>
    ipcRenderer.invoke('qua:library/tree', ids, withChildren),
  catalog: (): Promise<unknown> => ipcRenderer.invoke('qua:library/catalog'),
  /** 全局身份块（页/标签/定义/回收站根）：catalog 的块对象面 */
  identity: (): Promise<unknown> => ipcRenderer.invoke('qua:library/identity'),
  /** FTS 映射按块查（增量索引用） */
  ftsMap: (ids: readonly string[]): Promise<unknown> => ipcRenderer.invoke('qua:library/fts-map', ids),
  /** 依赖方查询（正文引用/标签成员/属性值三路分类） */
  dependents: (targetId: string): Promise<unknown> => ipcRenderer.invoke('qua:library/dependents', targetId),
  /** 顶层根清单（派生表流式重建用） */
  roots: (): Promise<unknown> => ipcRenderer.invoke('qua:library/roots'),
  /** 入向关系按目标批查（引用角标的全库计数；派生表未 ready 时 rows 空＋ready:false） */
  relations: (ids: readonly string[]): Promise<unknown> => ipcRenderer.invoke('qua:library/relations', ids),

  /** 全文检索（match 由渲染层编译；主进程只做参数绑定与 bm25 排序） */
  search: (match: string, limit: number, offset = 0): Promise<unknown> =>
    ipcRenderer.invoke('qua:search/query', match, limit, offset),

  /** 每库设置（窗口 bounds／槽布局／折叠态） */
  getSetting: (key: string): Promise<unknown> => ipcRenderer.invoke('qua:settings/get', key),
  setSetting: (key: string, value: string): Promise<unknown> => ipcRenderer.invoke('qua:settings/set', key, value),

  /** 资产（内容寻址；字节走 ArrayBuffer；地址由主进程的 `qua-asset://` 协议接住） */
  assetIndex: (): Promise<unknown> => ipcRenderer.invoke('qua:assets/index'),
  assetPut: (bytes: ArrayBuffer, mime: string, dims?: { w?: number; h?: number }): Promise<unknown> =>
    ipcRenderer.invoke('qua:assets/put', bytes, mime, dims ?? {}),

  /**
   * 关闭握手：主进程发 `qua:flush`，这里把待落盘的那批发出去再回 ack。
   *
   * 为什么要有这条：渲染层的落盘是 250ms 防抖，关窗那一刻可能还有一笔没发出去。
   * 不握手就是「关掉重开少最后一句」。
   */
  onFlush: (cb: () => void | Promise<void>): void => {
    ipcRenderer.on('qua:flush', () => {
      Promise.resolve(cb()).finally(() => ipcRenderer.send('qua:flush/ack'))
    })
  },
}

contextBridge.exposeInMainWorld('kb', {
  shellInfo: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('kb:shell/info'),
  kernel,
})

contextBridge.exposeInMainWorld('qua', qua)
