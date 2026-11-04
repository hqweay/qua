/**
 * 分词 worker 的**主线程客户端**：请求/回复按 id 配对，失败如实拒绝。
 *
 * 两处延迟都必须有：
 *   · worker 懒建 —— web 宿主（没有库／没有 FTS）永远走不到这里，不该付 4MB WASM；
 *   · worker 地址懒加载 —— 地址模块本身会拉起 worker 的整份产物；单测注入假的
 *     `tokenize` 时不该因为「静态 import 了它」而去解析 WASM。
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
  let urlPromise: Promise<string> | null = null
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
    urlPromise ??= import('./fts-worker.ts?worker&url').then((m) => m.default)
    const url = await urlPromise
    if (dead) throw new Error(dead)
    if (worker) return worker
    worker = new Worker(url, { name: 'fts' })
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
