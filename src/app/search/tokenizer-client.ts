/**
 * 分词 worker 的**主线程客户端**：请求/回复按 id 配对，失败如实拒绝。
 *
 * 两处延迟都必须有：
 *   · worker 懒建 —— web 宿主（没有库／没有 FTS）永远走不到这里，不该付 4MB WASM；
 *   · worker 构造器懒加载 —— 单测注入假的 `tokenize` 时不该因为「静态 import 了它」
 *     而去解析 WASM；动态 import 的 `?worker` 模块只带构造器与地址，不带 worker 的代码。
 */
import type { TokenizedText } from '../../core/search/tokenizer.ts'

export interface TokenizerClient {
  tokenize(items: readonly { id: string; text: string }[]): Promise<Map<string, TokenizedText>>
  dispose(): void
}

interface Reply {
  id: number
  rows?: { id: string; seg: string; chars: string; pinyin: string }[]
  error?: string
}

export function createTokenizerClient(): TokenizerClient {
  let worker: Worker | null = null
  /**
   * worker 构造器（Vite 生成的包装，不是地址）。
   *
   * 为什么必须由 Vite 生成：dev 下 worker 一定以 `type: 'module'` 起（Vite 把源码按
   * ESM 提供），构建产物却按 `worker.format`（本仓是 iife）落成经典脚本。手写
   * `new Worker(url)` 只能在构建里对，dev 下浏览器按经典脚本解析 ⇒ 第一行 import
   * 就抛 `Cannot use import statement outside a module`。`?worker` 的包装两态都对。
   *
   * 仍然是懒的：这个模块只含构造器与地址，worker 的整份产物（含内联 WASM）在
   * 真正 `new` 之前不会被求值——单测注入假 tokenize 时不该为它解析 WASM。
   */
  let ctorPromise: Promise<new (options?: { name?: string }) => Worker> | null = null
  let seq = 0
  let dead: string | null = null
  const waiting = new Map<number, { resolve: (m: Map<string, TokenizedText>) => void; reject: (e: Error) => void }>()

  const failAll = (message: string): void => {
    dead = message
    for (const w of waiting.values()) w.reject(new Error(message))
    waiting.clear()
  }

  const ensure = async (): Promise<Worker> => {
    if (dead) throw new Error(dead)
    if (worker) return worker
    ctorPromise ??= import('./fts-worker.ts?worker').then((m) => m.default)
    const Ctor = await ctorPromise
    if (dead) throw new Error(dead)
    if (worker) return worker
    worker = new Ctor({ name: 'fts' })
    worker.onmessage = (e: MessageEvent<Reply>) => {
      const msg = e.data
      const slot = waiting.get(msg.id)
      if (!slot) return
      waiting.delete(msg.id)
      if (msg.error) {
        slot.reject(new Error(msg.error))
        return
      }
      const out = new Map<string, TokenizedText>()
      for (const r of msg.rows ?? []) out.set(r.id, { seg: r.seg, chars: r.chars, pinyin: r.pinyin })
      slot.resolve(out)
    }
    worker.onerror = (e) => failAll(e.message || 'fts worker failed')
    worker.onmessageerror = () => failAll('fts worker message error')
    return worker
  }

  return {
    tokenize(items) {
      if (items.length === 0) return Promise.resolve(new Map())
      return new Promise<Map<string, TokenizedText>>((resolve, reject) => {
        waiting.set(++seq, { resolve, reject })
        const id = seq
        void ensure().then(
          (w) => w.postMessage({ id, items: items.map((x) => ({ id: x.id, text: x.text })) }),
          (e) => {
            waiting.delete(id)
            reject(e instanceof Error ? e : new Error(String(e)))
          },
        )
      })
    },
    dispose() {
      worker?.terminate()
      worker = null
      failAll('fts worker disposed')
    },
  }
}
