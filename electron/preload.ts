/**
 * preload：**最小面**——壳不暴露业务。
 *
 * 暴露给页面的只有两样：
 *   - `kb.shellInfo()`      —— 壳的版本/平台/数据目录（**不是业务**）
 *   - `kb.kernel.attach()`  —— 拿一条通向内核的通道（port 中转形状）
 *
 * ⚠️ **不暴露 `ipcRenderer` 本体**，也不暴露任何 `require`：页面拿不到 Node。
 * `contextIsolation:true` + `nodeIntegration:false` + `sandbox:true` ⇒ 这个文件里能用的
 * 只有 `contextBridge` / `ipcRenderer` 两个 import，`node:fs` 之类连 import 都会失败。
 *
 * ── 一个实测出来的坑（详见 docs/ELECTRON-备忘.md）────────────────────────────
 * **`MessagePort` 本体过不了 `contextBridge`**：`exposeInMainWorld` 只搬运**自有属性**，
 * 原型上的 `postMessage/close` 不会被带过去 ⇒ 页面拿到的对象上 `postMessage` 是 `undefined`
 * （实测报错：`port.postMessage is not a function`）。
 * 所以这里**不把 port 交给页面**，而是用一层**闭包**把方法包成普通函数再暴露——
 * 顺带还更安全：页面拿不到 transferable 通道本体，只能通过这两个函数说话。
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

contextBridge.exposeInMainWorld('kb', {
  shellInfo: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('kb:shell/info'),
  kernel,
})
