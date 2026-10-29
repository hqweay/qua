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
  /** 这个窗口订阅的是哪个库（没有库 ⇒ `status:'no-library'`，走欢迎页） */
  libraryInfo: (): Promise<unknown> => ipcRenderer.invoke('qua:library/info'),
  libraryList: (): Promise<unknown> => ipcRenderer.invoke('qua:library/list'),
  openLibrary: (id: string): Promise<unknown> => ipcRenderer.invoke('qua:library/open', id),
  createLibrary: (id: string, name: string): Promise<unknown> => ipcRenderer.invoke('qua:library/create', id, name),

  /** 内容（四张内容表的全部行；编码归渲染层） */
  load: (): Promise<unknown> => ipcRenderer.invoke('qua:storage/load'),
  save: (writes: unknown[], opts?: { replace?: boolean; oplog?: unknown[] }): Promise<unknown> =>
    ipcRenderer.invoke('qua:storage/save', writes, opts ?? {}),

  /** 每库设置（窗口 bounds／槽布局／折叠态） */
  getSetting: (key: string): Promise<unknown> => ipcRenderer.invoke('qua:settings/get', key),
  setSetting: (key: string, value: string): Promise<unknown> => ipcRenderer.invoke('qua:settings/set', key, value),

  /** 资产（内容寻址；字节走 ArrayBuffer，mime 从库目录的侧车来） */
  assetKeys: (): Promise<unknown> => ipcRenderer.invoke('qua:assets/keys'),
  assetGet: (hash: string): Promise<unknown> => ipcRenderer.invoke('qua:assets/get', hash),
  assetStat: (hash: string): Promise<unknown> => ipcRenderer.invoke('qua:assets/stat', hash),
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
